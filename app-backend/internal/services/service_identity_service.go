// pam/internal/services/service_identity_service.go
//
// Authentication + authorization for the vault's machine data plane.
//
// The hot path here is "verify a token and decide whether it may read a
// path", and it runs on every single secret read. Three things keep it cheap
// without weakening it:
//
//   - Token verification is one primary-key lookup on pam_service_tokens
//     plus a constant-time HMAC compare. No scan, no per-request KDF.
//
//   - Successful principal resolutions are cached in memory for
//     principalCacheTTL (30s by default). That bounds the DB load to
//     ~2 queries/minute/token regardless of request rate, while keeping the
//     worst-case revocation lag to 30 seconds, the same
//     short-TTL-instead-of-invalidation-fanout trade every distributed
//     authorizer makes. Revoke() flushes the cache locally on top of that,
//     so single-instance deployments see revocation immediately.
//
//   - last_used_at is written asynchronously and only when it has actually
//     moved by more than a minute. Otherwise a busy service turns every
//     read into a write and the row becomes a hot-tuple bottleneck.
package services

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	ErrTokenMalformed    = errors.New("service token is malformed")
	ErrTokenInvalid      = errors.New("service token is invalid, expired or revoked")
	ErrServiceDisabled   = errors.New("service identity is disabled")
	ErrScopeNotGranted   = errors.New("service identity has no grant covering this secret path")
	ErrRateLimitExceeded = errors.New("service secret-read rate limit exceeded")
	ErrIdentityNotFound  = errors.New("service identity not found")
)

const (
	// tokenPrefix namespaces the wire format so a leaked token is greppable
	// in logs and recognisable by secret scanners (the same reason GitHub
	// switched to ghp_/gho_ prefixes).
	tokenPrefix = "pamsvc"

	principalCacheTTL   = 30 * time.Second
	negativeCacheTTL    = 5 * time.Second
	grantCacheTTL       = 30 * time.Second
	lastUsedWriteWindow = time.Minute

	// DefaultSecretTTLSeconds is how long a client may cache a secret when
	// neither the grant nor an imminent rotation says otherwise.
	DefaultSecretTTLSeconds = 300

	// DefaultReadsPerMinute is the per-identity read budget when the identity
	// does not set its own. Generous for real workloads, ruinous for anyone
	// trying to enumerate a vault.
	DefaultReadsPerMinute = 600
)

// ServicePrincipal is the resolved, authenticated machine caller. It is what
// the middleware puts on the request context and what the secret-access
// service authorizes against.
type ServicePrincipal struct {
	ServiceID   string
	ServiceName string
	TokenID     string
	Environment string

	// TokenExpiresAt bounds every cache TTL we hand out: it is pointless to
	// tell a client it may cache for 5 minutes when its token dies in 30
	// seconds, and actively harmful because the client will then serve a
	// secret it can no longer refresh.
	TokenExpiresAt *time.Time

	MaxReadsPerMinute int
}

type cachedPrincipal struct {
	principal *ServicePrincipal
	err       error
	expiresAt time.Time
}

type cachedGrants struct {
	grants    []models.ServiceGrant
	expiresAt time.Time
}

// ServiceIdentityService owns the machine-identity lifecycle and the hot-path
// authentication/authorization checks.
type ServiceIdentityService struct {
	db     *gorm.DB
	pepper []byte
	audit  *AuditService
	logger *zap.Logger

	mu         sync.RWMutex
	principals map[string]cachedPrincipal // keyed by full presented token
	grants     map[string]cachedGrants    // keyed by service id

	limiterMu sync.Mutex
	limiters  map[string]*tokenBucket

	lastUsedMu sync.Mutex
	lastUsed   map[string]time.Time
}

// NewServiceIdentityService wires the service. pepper must be at least 32
// bytes and must come from configuration, never from source: it is the only
// thing standing between a stolen pam_service_tokens table and a working set
// of vault credentials.
func NewServiceIdentityService(db *gorm.DB, pepper []byte, audit *AuditService, logger *zap.Logger) (*ServiceIdentityService, error) {
	if len(pepper) < 32 {
		return nil, fmt.Errorf("service token pepper must be >= 32 bytes, got %d", len(pepper))
	}
	return &ServiceIdentityService{
		db:         db,
		pepper:     pepper,
		audit:      audit,
		logger:     logger,
		principals: make(map[string]cachedPrincipal),
		grants:     make(map[string]cachedGrants),
		limiters:   make(map[string]*tokenBucket),
		lastUsed:   make(map[string]time.Time),
	}, nil
}

// ── Token minting ────────────────────────────────────────────────────────────

// IssuedToken is returned once, at mint time. Secret is the only copy that
// will ever exist: it is not recoverable afterwards, by design.
type IssuedToken struct {
	TokenID     string     `json:"token_id"`
	Secret      string     `json:"token"` // full wire token: pamsvc.<id>.<secret>
	ServiceID   string     `json:"service_id"`
	ServiceName string     `json:"service_name"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
}

// CreateIdentity registers a new machine principal.
func (s *ServiceIdentityService) CreateIdentity(ctx context.Context, name, description, environment, ownerID, createdBy string, maxReadsPerMinute int) (*models.ServiceIdentity, error) {
	identity := &models.ServiceIdentity{
		Name:                strings.TrimSpace(name),
		Description:         description,
		Environment:         environment,
		OwnerID:             ownerID,
		Status:              "active",
		MaxSecretsPerMinute: maxReadsPerMinute,
		CreatedBy:           createdBy,
	}
	if identity.Name == "" {
		return nil, errors.New("service identity name is required")
	}
	if err := s.db.WithContext(ctx).Create(identity).Error; err != nil {
		return nil, fmt.Errorf("failed to create service identity: %w", err)
	}
	s.auditWrite(ctx, AuditEntry{
		UserID: createdBy, ActorType: "USER",
		Action: "pam.service_identity.created", Outcome: models.OutcomeSuccess,
		Resource: "pam:service/" + identity.Name,
		Details:  map[string]any{"service_id": identity.ID, "environment": environment, "owner_id": ownerID},
	})
	return identity, nil
}

// IssueToken mints a new token for an identity. Existing tokens keep working:
// that overlap is the whole point, it is what lets a fleet roll onto the new
// token before the old one is revoked.
func (s *ServiceIdentityService) IssueToken(ctx context.Context, serviceRef, description, createdBy string, ttl time.Duration) (*IssuedToken, error) {
	identity, err := s.lookupIdentity(ctx, serviceRef)
	if err != nil {
		return nil, err
	}
	if !identity.IsUsable() {
		return nil, ErrServiceDisabled
	}

	// 8 bytes of id (public, collision-resistant enough at any realistic
	// token count) + 32 bytes of secret (256 bits, no KDF needed).
	idBytes := make([]byte, 8)
	secretBytes := make([]byte, 32)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, fmt.Errorf("failed to generate token id: %w", err)
	}
	if _, err := rand.Read(secretBytes); err != nil {
		return nil, fmt.Errorf("failed to generate token secret: %w", err)
	}

	tokenID := hex.EncodeToString(idBytes)
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)

	var expiresAt *time.Time
	if ttl > 0 {
		t := time.Now().UTC().Add(ttl)
		expiresAt = &t
	}

	row := &models.ServiceToken{
		TokenID:     tokenID,
		ServiceID:   identity.ID,
		ServiceName: identity.Name,
		TokenHash:   s.hashSecret(secret),
		Description: description,
		CreatedBy:   createdBy,
		ExpiresAt:   expiresAt,
	}
	if err := s.db.WithContext(ctx).Create(row).Error; err != nil {
		return nil, fmt.Errorf("failed to persist service token: %w", err)
	}

	s.auditWrite(ctx, AuditEntry{
		UserID: createdBy, ActorType: "USER",
		Action: "pam.service_token.issued", Outcome: models.OutcomeSuccess, Severity: "WARN",
		Resource: "pam:service/" + identity.Name,
		Details: map[string]any{
			"service_id": identity.ID, "token_id": tokenID,
			"expires_at": expiresAt, "description": description,
		},
	})

	return &IssuedToken{
		TokenID:     tokenID,
		Secret:      fmt.Sprintf("%s.%s.%s", tokenPrefix, tokenID, secret),
		ServiceID:   identity.ID,
		ServiceName: identity.Name,
		ExpiresAt:   expiresAt,
	}, nil
}

// RevokeToken kills one token immediately and flushes it from the local cache.
func (s *ServiceIdentityService) RevokeToken(ctx context.Context, tokenID, revokedBy string) error {
	now := time.Now().UTC()
	res := s.db.WithContext(ctx).Model(&models.ServiceToken{}).
		Where("token_id = ? AND revoked_at IS NULL", tokenID).
		Updates(map[string]any{"revoked_at": now, "revoked_by": revokedBy})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrTokenInvalid
	}
	s.flushPrincipalCache()
	s.auditWrite(ctx, AuditEntry{
		UserID: revokedBy, ActorType: "USER",
		Action: "pam.service_token.revoked", Outcome: models.OutcomeSuccess, Severity: "WARN",
		Details: map[string]any{"token_id": tokenID},
	})
	return nil
}

// ── Grants ───────────────────────────────────────────────────────────────────

// GrantScope authorizes a service to read a path pattern. Idempotent on
// (service, scope): re-granting an existing scope revives and updates it
// rather than colliding on the unique index.
func (s *ServiceIdentityService) GrantScope(ctx context.Context, serviceRef, scope, reason, grantedBy string, maxTTLSeconds int, expiresAt *time.Time) (*models.ServiceGrant, error) {
	identity, err := s.lookupIdentity(ctx, serviceRef)
	if err != nil {
		return nil, err
	}
	scope = strings.Trim(strings.TrimSpace(scope), "/")
	if scope == "" {
		return nil, errors.New("grant scope is required")
	}

	grant := &models.ServiceGrant{
		ServiceID:     identity.ID,
		ServiceName:   identity.Name,
		Scope:         scope,
		MaxTTLSeconds: maxTTLSeconds,
		GrantedBy:     grantedBy,
		Reason:        reason,
		ExpiresAt:     expiresAt,
	}

	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing models.ServiceGrant
		err := tx.Where("service_id = ? AND scope = ?", identity.ID, scope).First(&existing).Error
		switch {
		case err == nil:
			existing.MaxTTLSeconds = maxTTLSeconds
			existing.GrantedBy = grantedBy
			existing.Reason = reason
			existing.ExpiresAt = expiresAt
			existing.RevokedAt = nil
			existing.RevokedBy = ""
			if err := tx.Save(&existing).Error; err != nil {
				return err
			}
			*grant = existing
			return nil
		case errors.Is(err, gorm.ErrRecordNotFound):
			return tx.Create(grant).Error
		default:
			return err
		}
	})
	if err != nil {
		return nil, fmt.Errorf("failed to persist service grant: %w", err)
	}

	s.flushGrantCache(identity.ID)
	s.auditWrite(ctx, AuditEntry{
		UserID: grantedBy, ActorType: "USER",
		Action: "pam.service_grant.created", Outcome: models.OutcomeSuccess, Severity: "WARN",
		Resource: "pam:secret/" + scope, Justification: reason,
		Details: map[string]any{
			"service_id": identity.ID, "service_name": identity.Name,
			"scope": scope, "max_ttl_seconds": maxTTLSeconds, "expires_at": expiresAt,
		},
	})
	return grant, nil
}

// RevokeGrant withdraws one scope from a service.
func (s *ServiceIdentityService) RevokeGrant(ctx context.Context, grantID, revokedBy string) error {
	now := time.Now().UTC()
	var grant models.ServiceGrant
	if err := s.db.WithContext(ctx).First(&grant, "id = ?", grantID).Error; err != nil {
		return err
	}
	if err := s.db.WithContext(ctx).Model(&grant).
		Updates(map[string]any{"revoked_at": now, "revoked_by": revokedBy}).Error; err != nil {
		return err
	}
	s.flushGrantCache(grant.ServiceID)
	s.auditWrite(ctx, AuditEntry{
		UserID: revokedBy, ActorType: "USER",
		Action: "pam.service_grant.revoked", Outcome: models.OutcomeSuccess, Severity: "WARN",
		Resource: "pam:secret/" + grant.Scope,
		Details:  map[string]any{"grant_id": grantID, "service_id": grant.ServiceID},
	})
	return nil
}

// ListGrants returns a service's live grants.
func (s *ServiceIdentityService) ListGrants(ctx context.Context, serviceRef string) ([]models.ServiceGrant, error) {
	identity, err := s.lookupIdentity(ctx, serviceRef)
	if err != nil {
		return nil, err
	}
	return s.activeGrants(ctx, identity.ID)
}

// ListIdentities returns every registered machine principal.
func (s *ServiceIdentityService) ListIdentities(ctx context.Context) ([]models.ServiceIdentity, error) {
	var out []models.ServiceIdentity
	err := s.db.WithContext(ctx).Order("name ASC").Find(&out).Error
	return out, err
}

// ListTokens returns a service's tokens (hashes are never exposed).
func (s *ServiceIdentityService) ListTokens(ctx context.Context, serviceRef string) ([]models.ServiceToken, error) {
	identity, err := s.lookupIdentity(ctx, serviceRef)
	if err != nil {
		return nil, err
	}
	var out []models.ServiceToken
	err = s.db.WithContext(ctx).Where("service_id = ?", identity.ID).
		Order("created_at DESC").Find(&out).Error
	return out, err
}

// DisableIdentity revokes every token of an identity in one statement. This is
// the incident-response switch: no enumeration, no partial state.
func (s *ServiceIdentityService) DisableIdentity(ctx context.Context, serviceRef, actor string) error {
	identity, err := s.lookupIdentity(ctx, serviceRef)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&models.ServiceIdentity{}).Where("id = ?", identity.ID).
			Update("status", "disabled").Error; err != nil {
			return err
		}
		return tx.Model(&models.ServiceToken{}).
			Where("service_id = ? AND revoked_at IS NULL", identity.ID).
			Updates(map[string]any{"revoked_at": now, "revoked_by": actor}).Error
	})
	if err != nil {
		return err
	}
	s.flushPrincipalCache()
	s.flushGrantCache(identity.ID)
	s.auditWrite(ctx, AuditEntry{
		UserID: actor, ActorType: "USER",
		Action: "pam.service_identity.disabled", Outcome: models.OutcomeSuccess, Severity: "CRITICAL",
		Resource: "pam:service/" + identity.Name,
		Details:  map[string]any{"service_id": identity.ID},
	})
	return nil
}

// ── Hot path: authenticate ───────────────────────────────────────────────────

// Authenticate verifies a presented wire token and returns the resolved
// principal. Failures are deliberately indistinguishable to the caller
// (ErrTokenInvalid for unknown, expired, revoked and bad-secret alike) so the
// endpoint cannot be used as a token-existence oracle.
func (s *ServiceIdentityService) Authenticate(ctx context.Context, presented string) (*ServicePrincipal, error) {
	presented = strings.TrimSpace(presented)
	if presented == "" {
		return nil, ErrTokenMalformed
	}

	if cached, ok := s.principalFromCache(presented); ok {
		return cached.principal, cached.err
	}

	principal, err := s.authenticateUncached(ctx, presented)
	s.cachePrincipal(presented, principal, err)
	return principal, err
}

func (s *ServiceIdentityService) authenticateUncached(ctx context.Context, presented string) (*ServicePrincipal, error) {
	tokenID, secret, err := parseWireToken(presented)
	if err != nil {
		return nil, err
	}

	var row models.ServiceToken
	if err := s.db.WithContext(ctx).First(&row, "token_id = ?", tokenID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrTokenInvalid
		}
		return nil, fmt.Errorf("service token lookup failed: %w", err)
	}

	// Constant-time compare so response latency does not leak how much of the
	// hash matched.
	if subtle.ConstantTimeCompare([]byte(row.TokenHash), []byte(s.hashSecret(secret))) != 1 {
		return nil, ErrTokenInvalid
	}
	if !row.IsUsable(time.Now().UTC()) {
		return nil, ErrTokenInvalid
	}

	var identity models.ServiceIdentity
	if err := s.db.WithContext(ctx).First(&identity, "id = ?", row.ServiceID).Error; err != nil {
		return nil, ErrTokenInvalid
	}
	if !identity.IsUsable() {
		return nil, ErrServiceDisabled
	}

	maxReads := identity.MaxSecretsPerMinute
	if maxReads <= 0 {
		maxReads = DefaultReadsPerMinute
	}

	return &ServicePrincipal{
		ServiceID:         identity.ID,
		ServiceName:       identity.Name,
		TokenID:           row.TokenID,
		Environment:       identity.Environment,
		TokenExpiresAt:    row.ExpiresAt,
		MaxReadsPerMinute: maxReads,
	}, nil
}

// ── Hot path: authorize ──────────────────────────────────────────────────────

// AuthorizePath resolves the tightest grant covering secretPath and returns
// it. "Tightest" means the most specific matching scope: an explicit
// per-secret grant with a 60s TTL cap must win over a broad `prod-db/**`
// grant with a loose cap, otherwise adding a wide grant would silently
// relax every narrow one underneath it.
func (s *ServiceIdentityService) AuthorizePath(ctx context.Context, principal *ServicePrincipal, secretPath string) (*models.ServiceGrant, error) {
	if principal == nil {
		return nil, ErrTokenInvalid
	}
	grants, err := s.activeGrants(ctx, principal.ServiceID)
	if err != nil {
		return nil, err
	}

	var best *models.ServiceGrant
	for i := range grants {
		g := &grants[i]
		if !g.Matches(secretPath) {
			continue
		}
		if best == nil || scopeSpecificity(g.Scope) > scopeSpecificity(best.Scope) {
			best = g
		}
	}
	if best == nil {
		return nil, ErrScopeNotGranted
	}
	return best, nil
}

// AllowRead consumes one unit of the principal's read budget.
func (s *ServiceIdentityService) AllowRead(principal *ServicePrincipal, cost int) bool {
	if principal == nil {
		return false
	}
	if cost < 1 {
		cost = 1
	}
	s.limiterMu.Lock()
	bucket, ok := s.limiters[principal.ServiceID]
	if !ok {
		bucket = newTokenBucket(float64(principal.MaxReadsPerMinute), float64(principal.MaxReadsPerMinute)/60.0)
		s.limiters[principal.ServiceID] = bucket
	}
	s.limiterMu.Unlock()
	return bucket.allow(float64(cost))
}

// TouchToken records token usage asynchronously, coalesced to at most one
// write per token per minute.
func (s *ServiceIdentityService) TouchToken(tokenID, sourceIP string) {
	if tokenID == "" {
		return
	}
	now := time.Now().UTC()

	s.lastUsedMu.Lock()
	if last, ok := s.lastUsed[tokenID]; ok && now.Sub(last) < lastUsedWriteWindow {
		s.lastUsedMu.Unlock()
		return
	}
	s.lastUsed[tokenID] = now
	s.lastUsedMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := s.db.WithContext(ctx).Model(&models.ServiceToken{}).
			Where("token_id = ?", tokenID).
			Updates(map[string]any{"last_used_at": now, "last_used_ip": sourceIP}).Error; err != nil {
			s.logger.Debug("service_token.touch.fail", zap.String("token_id", tokenID), zap.Error(err))
		}
	}()
}

// ── Internals ────────────────────────────────────────────────────────────────

func (s *ServiceIdentityService) hashSecret(secret string) string {
	mac := hmac.New(sha256.New, s.pepper)
	mac.Write([]byte(secret))
	return hex.EncodeToString(mac.Sum(nil))
}

func parseWireToken(presented string) (tokenID, secret string, err error) {
	parts := strings.Split(presented, ".")
	if len(parts) != 3 || parts[0] != tokenPrefix || parts[1] == "" || parts[2] == "" {
		return "", "", ErrTokenMalformed
	}
	return parts[1], parts[2], nil
}

func (s *ServiceIdentityService) lookupIdentity(ctx context.Context, ref string) (*models.ServiceIdentity, error) {
	var identity models.ServiceIdentity
	err := s.db.WithContext(ctx).Where("id = ? OR name = ?", ref, ref).First(&identity).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrIdentityNotFound
		}
		return nil, err
	}
	return &identity, nil
}

func (s *ServiceIdentityService) activeGrants(ctx context.Context, serviceID string) ([]models.ServiceGrant, error) {
	now := time.Now()

	s.mu.RLock()
	if entry, ok := s.grants[serviceID]; ok && now.Before(entry.expiresAt) {
		s.mu.RUnlock()
		return entry.grants, nil
	}
	s.mu.RUnlock()

	var rows []models.ServiceGrant
	err := s.db.WithContext(ctx).
		Where("service_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
			serviceID, now.UTC()).
		Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("failed to load service grants: %w", err)
	}

	s.mu.Lock()
	s.grants[serviceID] = cachedGrants{grants: rows, expiresAt: now.Add(grantCacheTTL)}
	s.mu.Unlock()
	return rows, nil
}

func (s *ServiceIdentityService) principalFromCache(presented string) (cachedPrincipal, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entry, ok := s.principals[presented]
	if !ok || !time.Now().Before(entry.expiresAt) {
		return cachedPrincipal{}, false
	}
	return entry, true
}

func (s *ServiceIdentityService) cachePrincipal(presented string, principal *ServicePrincipal, err error) {
	// Never cache infrastructure failures, only authoritative outcomes.
	if err != nil && !errors.Is(err, ErrTokenInvalid) &&
		!errors.Is(err, ErrTokenMalformed) && !errors.Is(err, ErrServiceDisabled) {
		return
	}
	ttl := principalCacheTTL
	if err != nil {
		ttl = negativeCacheTTL
	}
	// Never cache a principal past its own token expiry.
	if principal != nil && principal.TokenExpiresAt != nil {
		if until := time.Until(*principal.TokenExpiresAt); until < ttl {
			ttl = until
		}
	}
	if ttl <= 0 {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	// Bounded so a flood of junk tokens cannot grow the map without limit.
	if len(s.principals) > 8192 {
		s.principals = make(map[string]cachedPrincipal, 1024)
	}
	s.principals[presented] = cachedPrincipal{
		principal: principal, err: err, expiresAt: time.Now().Add(ttl),
	}
}

func (s *ServiceIdentityService) flushPrincipalCache() {
	s.mu.Lock()
	s.principals = make(map[string]cachedPrincipal)
	s.mu.Unlock()
}

func (s *ServiceIdentityService) flushGrantCache(serviceID string) {
	s.mu.Lock()
	delete(s.grants, serviceID)
	s.mu.Unlock()
}

func (s *ServiceIdentityService) auditWrite(ctx context.Context, e AuditEntry) {
	if s.audit == nil {
		return
	}
	if _, err := s.audit.Append(ctx, e); err != nil {
		s.logger.Error("service_identity.audit.fail", zap.String("action", e.Action), zap.Error(err))
	}
}

// scopeSpecificity scores how narrow a scope is, so the tightest matching
// grant wins. More literal segments beat fewer; wildcards are penalised, and
// the separator-crossing `**` is penalised hardest.
func scopeSpecificity(scope string) int {
	scope = strings.Trim(scope, "/")
	if scope == "*" || scope == "**" {
		return -1000
	}
	score := 0
	for _, seg := range strings.Split(scope, "/") {
		switch {
		case seg == "**":
			score -= 100
		case seg == "*":
			score -= 10
		case strings.ContainsAny(seg, "*?["):
			score += 1
		default:
			score += 10
		}
	}
	return score
}

// ── tokenBucket ──────────────────────────────────────────────────────────────

// tokenBucket is a plain lazy-refill bucket: no background goroutine, no
// timer per service, refill computed from elapsed time on access. That keeps
// per-identity limiting free when a service is idle.
type tokenBucket struct {
	mu         sync.Mutex
	capacity   float64
	refillRate float64 // units per second
	tokens     float64
	last       time.Time
}

func newTokenBucket(capacity, refillPerSecond float64) *tokenBucket {
	if capacity <= 0 {
		capacity = float64(DefaultReadsPerMinute)
	}
	if refillPerSecond <= 0 {
		refillPerSecond = capacity / 60.0
	}
	return &tokenBucket{
		capacity: capacity, refillRate: refillPerSecond,
		tokens: capacity, last: time.Now(),
	}
}

func (b *tokenBucket) allow(cost float64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	b.tokens += now.Sub(b.last).Seconds() * b.refillRate
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}
	b.last = now

	if b.tokens < cost {
		return false
	}
	b.tokens -= cost
	return true
}
