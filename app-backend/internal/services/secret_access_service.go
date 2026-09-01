// pam/internal/services/secret_access_service.go
//
// The vault's machine-facing READ path: given an authenticated
// ServicePrincipal and a canonical secret path, return the plaintext plus the
// metadata a client needs to cache it safely.
//
// What makes this the data plane rather than a second copy of
// VaultService.RevealCredential:
//
//   - Secrets are addressed by a stable path ("prod-db/postgres/pg-app"),
//     not by UUID and not by a bare name. A bare `WHERE name = ?` is
//     ambiguous, `name` is a non-unique index, so two safes can hold the
//     same credential name and the caller silently gets whichever row the
//     planner returned first. Path addressing also means a config file can
//     name its secrets without hardcoding UUIDs.
//
//   - Every read is authorized against a path-scoped grant and audited with
//     the resolved path, the grant, the token id and the caller's stated
//     purpose. Non-repudiation for machine access is the entire reason a PAM
//     vault exists rather than a Kubernetes Secret.
//
//   - The TTL handed back is min(grant cap, default, time-to-rotation - skew,
//     token lifetime). Handing a client a 15-minute TTL on a credential that
//     rotates in 4 minutes is how you manufacture a production outage: the
//     client keeps presenting a password the target has already changed.
package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/pkg/crypto"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	ErrSecretNotFound      = errors.New("secret not found")
	ErrSecretAmbiguous     = errors.New("secret path is ambiguous")
	ErrServiceUnauthorized = errors.New("service not authorized to access this secret")
)

const (
	// rotationSkew is how far ahead of a scheduled rotation we stop handing
	// out cacheable TTL, so no client is still holding the old value when the
	// rotation lands.
	rotationSkew = 2 * time.Minute

	// minTTLSeconds keeps a near-rotation read usable instead of returning a
	// zero/negative TTL that would make the client re-fetch on every call.
	minTTLSeconds = 30

	// batchDecryptConcurrency bounds the parallel envelope-decrypt fan-out on
	// the "give me every secret for this resource" path. Envelope decryption
	// is CPU-bound AES-GCM; unbounded fan-out on a 200-credential resource
	// would starve the rest of the process.
	batchDecryptConcurrency = 8
)

// SecretAccessService serves secrets to authenticated machine principals.
type SecretAccessService struct {
	db       *gorm.DB
	kms      crypto.KMSProvider
	identity *ServiceIdentityService
	audit    *AuditService
	logger   *zap.Logger

	// defaultTTL is the deployment-wide cache ceiling in seconds, before any
	// per-grant or rotation clamp. Configurable because it is the single knob
	// that trades revocation latency against vault load, and the right value
	// is a property of the deployment, not of this package.
	defaultTTL int
}

func NewSecretAccessService(
	db *gorm.DB,
	kms crypto.KMSProvider,
	identity *ServiceIdentityService,
	audit *AuditService,
	defaultTTLSeconds int,
	logger *zap.Logger,
) *SecretAccessService {
	if defaultTTLSeconds <= 0 {
		defaultTTLSeconds = DefaultSecretTTLSeconds
	}
	if defaultTTLSeconds < minTTLSeconds {
		defaultTTLSeconds = minTTLSeconds
	}
	return &SecretAccessService{
		db:         db,
		kms:        kms,
		identity:   identity,
		audit:      audit,
		logger:     logger,
		defaultTTL: defaultTTLSeconds,
	}
}

// SecretResponse is the data-plane wire shape.
type SecretResponse struct {
	Path         string            `json:"path"`
	SecretValue  string            `json:"secret_value"`
	CredentialID string            `json:"credential_id"`
	AccountName  string            `json:"account_name"`
	ResourceID   string            `json:"resource_id,omitempty"`
	Type         string            `json:"credential_type"`
	Metadata     map[string]string `json:"metadata,omitempty"`
	Version      int               `json:"version"`

	// CacheTTLSeconds is authoritative: a well-behaved client caches for
	// exactly this long and no longer.
	CacheTTLSeconds int `json:"cache_ttl_seconds"`

	// NotAfter is the wall-clock deadline matching CacheTTLSeconds. Clients
	// whose clocks drift should prefer the TTL; NotAfter exists for humans
	// reading an audit trail or debugging a stale-cache report.
	NotAfter time.Time `json:"not_after"`

	// RotatesAt lets a client schedule a proactive refresh instead of
	// discovering the rotation as an authentication failure against the target.
	RotatesAt *time.Time `json:"rotates_at,omitempty"`
}

// credentialRow is the flattened join result: the credential plus the safe and
// folder names needed to build its canonical path. Resolving the path in the
// same query as the credential is what keeps a read at one round trip.
type credentialRow struct {
	models.Credential
	SafeName   string `gorm:"column:safe_name"`
	FolderPath string `gorm:"column:folder_path"`
}

func (r credentialRow) path() string {
	safe := r.SafeName
	if safe == "" {
		safe = r.SafeID
	}
	return models.CanonicalSecretPath(safe, r.FolderPath, r.Name)
}

// baseQuery is the single join used by every read path.
//
// LEFT JOIN on safes rather than INNER: Credential.SafeID defaults to the
// literal string 'default', which is not necessarily a real pam_safes row. An
// INNER JOIN would make those credentials invisible on the data plane while
// still being visible on the control plane, a failure mode that is very hard
// to diagnose from the outside.
func (s *SecretAccessService) baseQuery(ctx context.Context) *gorm.DB {
	return s.db.WithContext(ctx).
		Model(&models.Credential{}).
		Select(`pam_credentials.*,
		        COALESCE(pam_safes.name, '')   AS safe_name,
		        COALESCE(pam_folders.path, '') AS folder_path`).
		Joins(`LEFT JOIN pam_safes   ON pam_safes.id   = pam_credentials.safe_id   AND pam_safes.deleted_at   IS NULL`).
		Joins(`LEFT JOIN pam_folders ON pam_folders.id = pam_credentials.folder_id AND pam_folders.deleted_at IS NULL`).
		Where("pam_credentials.status = ?", "active")
}

// GetSecret is the primary data-plane entry point.
//
// ref may be either a canonical path ("prod-db/postgres/pg-app") or a
// credential UUID. Paths are preferred; the UUID form exists so existing
// integrations keep working while they migrate.
func (s *SecretAccessService) GetSecret(
	ctx context.Context,
	principal *ServicePrincipal,
	ref string,
	purpose string,
	sourceIP string,
) (*SecretResponse, error) {
	if principal == nil {
		return nil, ErrServiceUnauthorized
	}
	ref = strings.Trim(strings.TrimSpace(ref), "/")
	if ref == "" {
		return nil, ErrSecretNotFound
	}

	row, err := s.resolve(ctx, ref)
	if err != nil {
		s.auditDeny(ctx, principal, ref, purpose, sourceIP, err)
		return nil, err
	}
	secretPath := row.path()

	grant, err := s.identity.AuthorizePath(ctx, principal, secretPath)
	if err != nil {
		s.auditDeny(ctx, principal, secretPath, purpose, sourceIP, ErrServiceUnauthorized)
		return nil, ErrServiceUnauthorized
	}

	plaintext, err := s.decrypt(ctx, row.Credential)
	if err != nil {
		s.logger.Error("vault.secret.decrypt.failed",
			zap.String("credential_id", row.ID),
			zap.String("path", secretPath),
			zap.Error(err),
		)
		s.auditDeny(ctx, principal, secretPath, purpose, sourceIP, err)
		return nil, fmt.Errorf("decryption failed: %w", err)
	}

	resp := s.buildResponse(row, secretPath, plaintext, principal, grant)

	s.auditAllow(ctx, principal, resp, grant, purpose, sourceIP)
	return resp, nil
}

// GetSecretsByResource returns every active credential attached to a resource
// that the principal is actually allowed to read.
//
// Two deliberate differences from the naive version: one query instead of
// 1+N (the old shape re-looked-up each credential by id after already having
// the row), and credentials the principal cannot read are omitted rather than
// failing the whole call, a service with a grant on one account of a
// resource should still get that account.
func (s *SecretAccessService) GetSecretsByResource(
	ctx context.Context,
	principal *ServicePrincipal,
	resourceID string,
	purpose string,
	sourceIP string,
) (map[string]*SecretResponse, error) {
	if principal == nil {
		return nil, ErrServiceUnauthorized
	}

	var rows []credentialRow
	if err := s.baseQuery(ctx).
		Where("pam_credentials.resource_id = ?", resourceID).
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("failed to load resource credentials: %w", err)
	}
	if len(rows) == 0 {
		return nil, ErrSecretNotFound
	}

	// Filter by grant BEFORE decrypting: no point burning AES cycles on rows
	// the caller may not see, and it keeps the audit trail free of reads that
	// never happened.
	type job struct {
		row   credentialRow
		path  string
		grant *models.ServiceGrant
	}
	jobs := make([]job, 0, len(rows))
	for _, r := range rows {
		p := r.path()
		grant, err := s.identity.AuthorizePath(ctx, principal, p)
		if err != nil {
			continue
		}
		jobs = append(jobs, job{row: r, path: p, grant: grant})
	}
	if len(jobs) == 0 {
		s.auditDeny(ctx, principal, "resource:"+resourceID, purpose, sourceIP, ErrServiceUnauthorized)
		return nil, ErrServiceUnauthorized
	}

	results := make(map[string]*SecretResponse, len(jobs))
	var (
		mu  sync.Mutex
		wg  sync.WaitGroup
		sem = make(chan struct{}, batchDecryptConcurrency)
	)
	for _, j := range jobs {
		wg.Add(1)
		go func(j job) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			plaintext, err := s.decrypt(ctx, j.row.Credential)
			if err != nil {
				s.logger.Warn("vault.secret.batch.decrypt_failed",
					zap.String("credential_id", j.row.ID),
					zap.String("path", j.path),
					zap.Error(err),
				)
				return
			}
			// &j.row is safe: j is this goroutine's own parameter, not the
			// shared loop variable.
			resp := s.buildResponse(&j.row, j.path, plaintext, principal, j.grant)

			mu.Lock()
			results[j.row.AccountName] = resp
			mu.Unlock()
		}(j)
	}
	wg.Wait()

	if len(results) == 0 {
		return nil, ErrSecretNotFound
	}

	// One audit row for the batch, listing what was served. N rows for one
	// logical operation just makes the trail harder to read.
	served := make([]string, 0, len(results))
	for _, r := range results {
		served = append(served, r.Path)
	}
	s.auditWrite(ctx, AuditEntry{
		UserID: principal.ServiceID, Username: principal.ServiceName,
		ServiceName: principal.ServiceName, ActorType: "SYSTEM",
		Action: "pam.secret.batch_read", Outcome: models.OutcomeSuccess,
		Resource: "pam:resource/" + resourceID, ResourceType: "resource", ResourceID: resourceID,
		Justification: purpose, SourceIP: sourceIP,
		Details: map[string]any{
			"token_id": principal.TokenID, "purpose": purpose,
			"paths": served, "count": len(served), "requested": len(rows),
		},
	})

	return results, nil
}

// ── Resolution ───────────────────────────────────────────────────────────────

// resolve turns a path or UUID into exactly one credential row.
//
// The path case is resolved by querying on the LAST segment against the
// indexed `name` column and then matching the full canonical path in Go. That
// keeps the query an index seek returning a handful of rows, instead of the
// alternatives: a LIKE over a concatenation (unindexable) or a denormalised
// path column that silently goes stale whenever a credential is moved between
// safes or folders.
func (s *SecretAccessService) resolve(ctx context.Context, ref string) (*credentialRow, error) {
	segments := strings.Split(ref, "/")
	leaf := segments[len(segments)-1]

	var rows []credentialRow
	if err := s.baseQuery(ctx).
		Where("pam_credentials.id = ? OR pam_credentials.name = ? OR pam_credentials.account_name = ?",
			ref, leaf, leaf).
		Limit(64).
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("database error: %w", err)
	}
	if len(rows) == 0 {
		return nil, ErrSecretNotFound
	}

	// Exact id match wins outright.
	for i := range rows {
		if rows[i].ID == ref {
			return &rows[i], nil
		}
	}

	// Then exact canonical path.
	var matches []*credentialRow
	for i := range rows {
		if rows[i].path() == ref {
			matches = append(matches, &rows[i])
		}
	}
	// Then a bare leaf name, but ONLY if it is unambiguous across safes.
	// Returning an arbitrary row here is how a service ends up authenticating
	// to staging with production credentials.
	if len(matches) == 0 && len(segments) == 1 {
		for i := range rows {
			if rows[i].Name == leaf || rows[i].AccountName == leaf {
				matches = append(matches, &rows[i])
			}
		}
	}

	switch len(matches) {
	case 0:
		return nil, ErrSecretNotFound
	case 1:
		return matches[0], nil
	default:
		return nil, ErrSecretAmbiguous
	}
}

func (s *SecretAccessService) decrypt(ctx context.Context, cred models.Credential) (string, error) {
	// AAD comes from the one accessor StoreCredential also uses, and is passed
	// explicitly, EnvelopeDecryptor falls back to the AAD stored inside the
	// envelope when the caller passes nil, which would let anyone with a DB
	// write rewrite the binding they are supposedly bound by.
	return crypto.EnvelopeDecryptor(ctx, s.kms, cred.CredentialEnc, cred.EncryptionAAD())
}

func (s *SecretAccessService) buildResponse(
	row *credentialRow,
	secretPath string,
	plaintext string,
	principal *ServicePrincipal,
	grant *models.ServiceGrant,
) *SecretResponse {
	ttl := s.effectiveTTL(row.Credential, principal, grant)
	return &SecretResponse{
		Path:            secretPath,
		SecretValue:     plaintext,
		CredentialID:    row.ID,
		AccountName:     row.AccountName,
		ResourceID:      row.ResourceID,
		Type:            row.CredentialType,
		Version:         row.Version,
		CacheTTLSeconds: ttl,
		NotAfter:        time.Now().UTC().Add(time.Duration(ttl) * time.Second),
		RotatesAt:       row.NextRotationAt,
		Metadata: map[string]string{
			"safe_id":     row.SafeID,
			"safe":        row.SafeName,
			"folder":      row.FolderPath,
			"description": row.Description,
		},
	}
}

// effectiveTTL is the whole rotation-safety story in one function: the
// shortest of every constraint that applies, floored so it stays usable.
func (s *SecretAccessService) effectiveTTL(
	cred models.Credential,
	principal *ServicePrincipal,
	grant *models.ServiceGrant,
) int {
	ttl := s.defaultTTL
	if ttl <= 0 {
		ttl = DefaultSecretTTLSeconds
	}
	if grant != nil && grant.MaxTTLSeconds > 0 && grant.MaxTTLSeconds < ttl {
		ttl = grant.MaxTTLSeconds
	}

	clamp := func(d time.Duration) {
		if secs := int(d.Seconds()); secs < ttl {
			ttl = secs
		}
	}

	// Never let a client hold a secret across its rotation. Note the guard on
	// "already overdue": subtracting the skew from a past rotation timestamp
	// yields a negative TTL, which the floor below would otherwise turn into
	// a permanent no-cache hot loop against the vault.
	if cred.NextRotationAt != nil {
		if until := time.Until(*cred.NextRotationAt) - rotationSkew; until > 0 {
			clamp(until)
		} else {
			ttl = minTTLSeconds
		}
	}

	// Never let a client hold a secret past the life of the token it used to
	// fetch it, it could not refresh it anyway.
	if principal != nil && principal.TokenExpiresAt != nil {
		if until := time.Until(*principal.TokenExpiresAt); until > 0 {
			clamp(until)
		} else {
			ttl = minTTLSeconds
		}
	}

	if ttl < minTTLSeconds {
		ttl = minTTLSeconds
	}
	return ttl
}

// ── Audit ────────────────────────────────────────────────────────────────────

func (s *SecretAccessService) auditAllow(
	ctx context.Context,
	principal *ServicePrincipal,
	resp *SecretResponse,
	grant *models.ServiceGrant,
	purpose, sourceIP string,
) {
	scope := ""
	grantID := ""
	if grant != nil {
		scope, grantID = grant.Scope, grant.ID
	}
	s.auditWrite(ctx, AuditEntry{
		UserID: principal.ServiceID, Username: principal.ServiceName,
		ServiceName: principal.ServiceName, ActorType: "SYSTEM",
		Action: "pam.secret.read", Outcome: models.OutcomeSuccess,
		Resource: "pam:secret/" + resp.Path, ResourceType: "credential",
		ResourceID: resp.CredentialID, ResourceName: resp.AccountName,
		Justification: purpose, SourceIP: sourceIP,
		Details: map[string]any{
			"token_id": principal.TokenID, "path": resp.Path, "purpose": purpose,
			"version": resp.Version, "grant_id": grantID, "grant_scope": scope,
			"cache_ttl_seconds": resp.CacheTTLSeconds,
		},
	})
}

func (s *SecretAccessService) auditDeny(
	ctx context.Context,
	principal *ServicePrincipal,
	ref, purpose, sourceIP string,
	cause error,
) {
	entry := AuditEntry{
		ActorType: "SYSTEM",
		Action:    "pam.secret.read", Outcome: models.OutcomeDenied, Severity: "WARN",
		Resource: "pam:secret/" + ref, Justification: purpose, SourceIP: sourceIP,
		Details: map[string]any{"path": ref, "purpose": purpose, "reason": cause.Error()},
	}
	if principal != nil {
		entry.UserID = principal.ServiceID
		entry.Username = principal.ServiceName
		entry.ServiceName = principal.ServiceName
		entry.Details.(map[string]any)["token_id"] = principal.TokenID
	}
	// An unauthorized read attempt is a security signal, not a 404.
	if errors.Is(cause, ErrServiceUnauthorized) {
		entry.Severity = "CRITICAL"
	}
	s.auditWrite(ctx, entry)
}

func (s *SecretAccessService) auditWrite(ctx context.Context, e AuditEntry) {
	if s.audit == nil {
		return
	}
	// Detached context: the audit row must survive the client hanging up
	// mid-response, otherwise a caller can suppress its own audit trail
	// simply by cancelling the request.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	go func() {
		defer cancel()
		if _, err := s.audit.Append(writeCtx, e); err != nil {
			s.logger.Error("vault.secret.audit.fail",
				zap.String("action", e.Action), zap.Error(err))
		}
	}()
}
