// pam/internal/services/agent_service.go
//
// AgentService implements the local-agent pairing and launch-token
// handshake that lets PAM open a real desktop CLI/GUI already authenticated
// — the same outcome the browser session gateway gives you, but for tools
// that only make sense running natively on the operator's own machine
// (psql, mongosh, redis-cli, or an installed GUI client).
//
// Trust model, spelled out because it's the part worth reviewing hardest:
//
//  1. Pairing (once per machine): the user requests a short, human-typed,
//     5-minute pairing code from an authenticated PAM session. The agent
//     generates an Ed25519 keypair locally, sends its PUBLIC key + the code
//     to PAM once. PAM never sees the private key. From here on, the agent
//     proves its identity by signing requests — nothing it holds locally is
//     a bearer secret an attacker could just copy and replay from elsewhere
//     (a signature is only useful with the private key it was made with).
//
//  2. Launch (every connect): the browser asks PAM for a one-time, 60-second
//     launch token scoped to exactly one resource + user — this call is
//     gated by the exact same pam:resource:Connect RBAC/PBAC check as the
//     browser session gateway, plus the identical RequireActiveGrant check
//     for JIT-gated resources. The browser hands that token to the OS via a
//     pam-agent:// URL; the OS launches the locally-installed agent with it.
//     The agent redeems the token directly against PAM, signing the
//     request with its enrolled key. PAM verifies the signature, verifies
//     the token belongs to THAT SAME user, consumes it exactly once, then
//     resolves the vaulted credential and hands it to the agent — never to
//     the browser, never twice.
package services

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/recorder"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	ErrPairingCodeInvalid = errors.New("pairing code is invalid, expired, or already used")
	ErrDeviceNotFound     = errors.New("agent device not found")
	ErrDeviceRevoked      = errors.New("agent device has been revoked")
	ErrLaunchTokenInvalid = errors.New("launch token is invalid, expired, or already used")
	ErrSignatureInvalid   = errors.New("agent signature verification failed")

	// ErrConnectMethodNotAllowed means the resource's policy closed the
	// native-agent path (see models.PAMResource.AllowedConnectMethods).
	//
	// This is the gate that makes every data-protection control credible.
	// PAM proxies the two brokered paths and can enforce on them, but the
	// agent receives the plaintext credential and connects DIRECT to the
	// target — so clipboard, download and egress controls on a resource that
	// still permits the agent are bypassed by choosing a different connect
	// button. Without this check those controls are decoration.
	ErrConnectMethodNotAllowed = errors.New("this resource does not permit the native agent connect method")
)

const (
	pairingCodeLength = 8
	pairingCodeTTL    = 5 * time.Minute
	// pairingCodeMaxTTL bounds how long-lived a caller can ask a pairing
	// code to be (see InitPairing's ttl parameter) — long enough to cover
	// an installer-embedded pairing code that might sit on a USB stick or
	// in a deployment pipeline for a while before the agent actually runs
	// pam-agent install && pam-agent pair on the target machine, but still
	// bounded so a leaked code can't be replayed indefinitely.
	pairingCodeMaxTTL = 24 * time.Hour
	launchTokenTTL    = 60 * time.Second
	signatureMaxSkew  = 30 * time.Second
)

type AgentService struct {
	db               *gorm.DB
	resourceSvc      *ResourceService
	recordingStorage recorder.Storage

	// audit records policy decisions taken here rather than leaving them to
	// callers. A refusal to release a credential is exactly the kind of event
	// that must not depend on every caller remembering to log it. Nil-safe:
	// writes are skipped when unset, so existing constructions (tests) keep
	// working without an audit backend.
	audit *AuditService

	logger *zap.Logger
}

func NewAgentService(db *gorm.DB, resourceSvc *ResourceService, recordingStorage recorder.Storage,
	audit *AuditService, logger *zap.Logger) *AgentService {
	return &AgentService{
		db: db, resourceSvc: resourceSvc, recordingStorage: recordingStorage,
		audit: audit, logger: logger,
	}
}

// ──────────────────────────────────────────────────────────────────────────
// PAIRING
// ──────────────────────────────────────────────────────────────────────────

// InitPairing issues a short, human-typed pairing code for the given
// authenticated PAM user. The raw code is returned exactly once and never
// stored — only its hash is persisted, the same treatment as vault
// credentials.
//
// ttl lets a caller ask for a longer-lived code than the 5-minute default —
// e.g. an installer that embeds a one-time setup token so `pam-agent
// install && pam-agent pair` can run unattended sometime after the browser
// session that requested it is long gone. A zero ttl means "use the
// default"; anything requested above pairingCodeMaxTTL is silently capped,
// never rejected outright, so a slightly-too-generous caller still gets a
// safe code instead of an error.
func (s *AgentService) InitPairing(userID string, ttl time.Duration) (code string, expiresAt time.Time, err error) {
	code, err = generateHumanCode(pairingCodeLength)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to generate pairing code: %w", err)
	}

	effectiveTTL := pairingCodeTTL
	if ttl > 0 {
		effectiveTTL = ttl
		if effectiveTTL > pairingCodeMaxTTL {
			effectiveTTL = pairingCodeMaxTTL
		}
	}

	expiresAt = time.Now().Add(effectiveTTL)
	rec := &models.AgentPairingCode{
		UserID:    userID,
		CodeHash:  hashSecret(code),
		Status:    "PENDING",
		ExpiresAt: expiresAt,
	}
	if err := s.db.Create(rec).Error; err != nil {
		return "", time.Time{}, fmt.Errorf("failed to store pairing code: %w", err)
	}

	s.logger.Info("agent.pairing.init", zap.String("user_id", userID))
	return code, expiresAt, nil
}

// ValidatePairingCode checks a code is real, still PENDING and unexpired,
// WITHOUT consuming it.
//
// Needed because one-click enrolment serves two unauthenticated things — the
// generated installer and the agent binary — gated by the pairing code carried
// in their URL. Those fetches must not spend the code: the agent itself
// redeems it moments later via CompletePairing, and a fetch that consumed it
// would leave the operator holding an installer that can no longer pair. The
// retry a browser or a proxy performs on either URL must also be harmless.
//
// Same acceptance rules as CompletePairing, deliberately no side effects.
// Returns the owning user so a caller can scope what it serves to that person.
func (s *AgentService) ValidatePairingCode(code string) (userID string, expiresAt time.Time, err error) {
	if code == "" {
		return "", time.Time{}, ErrPairingCodeInvalid
	}

	var rec models.AgentPairingCode
	if err := s.db.Where("code_hash = ?", hashSecret(code)).First(&rec).Error; err != nil {
		return "", time.Time{}, ErrPairingCodeInvalid
	}
	if rec.Status != "PENDING" || time.Now().After(rec.ExpiresAt) {
		return "", time.Time{}, ErrPairingCodeInvalid
	}
	return rec.UserID, rec.ExpiresAt, nil
}

// CompletePairing is called by the agent itself (not through a browser
// session — the agent has no PAM JWT yet at this point) with the code the
// user typed plus the public half of a freshly generated Ed25519 keypair.
func (s *AgentService) CompletePairing(code, deviceName, publicKeyB64 string) (*models.AgentDevice, error) {
	pubBytes, err := base64.StdEncoding.DecodeString(publicKeyB64)
	if err != nil || len(pubBytes) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid device public key")
	}

	var rec models.AgentPairingCode
	if err := s.db.Where("code_hash = ?", hashSecret(code)).First(&rec).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPairingCodeInvalid
		}
		return nil, err
	}
	if rec.Status != "PENDING" || time.Now().After(rec.ExpiresAt) {
		return nil, ErrPairingCodeInvalid
	}

	// RE-PAIRING A MACHINE UPDATES ITS ROW; IT DOES NOT ADD ANOTHER.
	//
	// This used to be an unconditional Create, and the Devices list in
	// Settings grew by one every time somebody re-ran the installer. Counted
	// on a real deployment's agent log: twenty-six rows for a single laptop,
	// all named "DESKTOP-ETQ5PKL (windows)", because `pam-agent install`
	// generates a FRESH keypair on every pair (keystore.Generate), so the
	// public key is never the same twice and could not be used to recognise
	// the machine. The device NAME is what is stable across re-installs.
	//
	// Every one of those rows was also a live credential, and the operator
	// had no way to tell which was their current machine, so revoking the
	// stale ones was guesswork. Collapsing them is a security improvement as
	// much as a tidiness one.
	//
	// A REVOKED row is deliberately never reused. An administrator revoked
	// that device on purpose, and silently reactivating it would erase the
	// decision; a re-pair after a revocation gets a new row, and the revoked
	// one stays as the record of what happened.
	var device *models.AgentDevice
	var existing models.AgentDevice
	found := s.db.Where("user_id = ? AND device_name = ? AND status <> ?",
		rec.UserID, deviceName, "REVOKED").
		Order("created_at DESC").First(&existing).Error

	switch {
	case found == nil:
		now := time.Now()
		// The new keypair replaces the old one: the private half of the
		// previous key is gone (the installer overwrote the keystore), so
		// keeping it would leave a credential that can never authenticate
		// again while looking like it could.
		if err := s.db.Model(&existing).Updates(map[string]interface{}{
			"public_key":   publicKeyB64,
			"status":       "ACTIVE",
			"last_seen_at": now,
		}).Error; err != nil {
			return nil, fmt.Errorf("failed to re-register agent device: %w", err)
		}
		existing.PublicKey = publicKeyB64
		existing.Status = "ACTIVE"
		existing.LastSeenAt = &now
		device = &existing

	case errors.Is(found, gorm.ErrRecordNotFound):
		device = &models.AgentDevice{
			UserID:     rec.UserID,
			DeviceName: deviceName,
			PublicKey:  publicKeyB64,
			Status:     "ACTIVE",
		}
		if err := s.db.Create(device).Error; err != nil {
			return nil, fmt.Errorf("failed to register agent device: %w", err)
		}

	default:
		return nil, found
	}
	// Whether the row is new decides what has to be undone if the pairing
	// code turns out to have been consumed by a concurrent request below.
	createdNewDevice := errors.Is(found, gorm.ErrRecordNotFound)

	now := time.Now()
	result := s.db.Model(&models.AgentPairingCode{}).
		Where("id = ? AND status = 'PENDING'", rec.ID).
		Updates(map[string]interface{}{"status": "CONSUMED", "consumed_at": now})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		// Lost a race against a concurrent redemption of the same code.
		// Only a row this call CREATED may be deleted: the other branch
		// updated a device the operator already had, and deleting that would
		// turn a lost race into an un-pairing of their working machine.
		// Its previous public key is unrecoverable either way, so the honest
		// repair is to leave the row and let them pair again.
		if createdNewDevice {
			s.db.Delete(&models.AgentDevice{}, "id = ?", device.ID)
		}
		return nil, ErrPairingCodeInvalid
	}

	s.logger.Info("agent.paired",
		zap.String("user_id", rec.UserID),
		zap.String("device_id", device.ID),
		zap.String("device_name", deviceName),
		zap.Bool("new_device", createdNewDevice),
	)
	return device, nil
}

func (s *AgentService) ListDevices(userID string) ([]models.AgentDevice, error) {
	var devices []models.AgentDevice
	err := s.db.Where("user_id = ?", userID).Order("created_at DESC").Find(&devices).Error
	return devices, err
}

// RevokeDevice immediately invalidates a paired device — e.g. a lost laptop.
// Scoped to userID so a user can only revoke their own devices.
func (s *AgentService) RevokeDevice(userID, deviceID string) error {
	result := s.db.Model(&models.AgentDevice{}).
		Where("id = ? AND user_id = ?", deviceID, userID).
		Update("status", "REVOKED")
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrDeviceNotFound
	}
	return nil
}

// HasActiveDevice tells the launch-token endpoint whether it's even worth
// issuing a token — if the user has no paired agent yet, fail fast with a
// clear "go install the agent" message instead of a token that can never be
// redeemed.
func (s *AgentService) HasActiveDevice(userID string) (bool, error) {
	var count int64
	err := s.db.Model(&models.AgentDevice{}).
		Where("user_id = ? AND status = 'ACTIVE'", userID).Count(&count).Error
	return count > 0, err
}

// ──────────────────────────────────────────────────────────────────────────
// LAUNCH TOKENS
// ──────────────────────────────────────────────────────────────────────────

// LaunchGrantContext is the subset of middleware.GrantContext the launch
// flow needs to carry from token issuance (inside the authenticated
// request, where RequireActiveGrant already resolved it) through to token
// redemption (the agent's bare signed POST, with no gin.Context at all).
// Defined here rather than importing middleware.GrantContext directly to
// avoid a services -> middleware import (middleware already imports
// services; that would be circular).
type LaunchGrantContext struct {
	GrantID           string
	JITRequestID      string
	IsBreakglass      bool
	RecordingRequired bool
}

// CreateLaunchToken issues a one-time, 60-second token for a resource the
// caller has already been authorized (via the embedded policy engine, and —
// for JIT-gated resources — RequireActiveGrant) to connect to. grant is the
// zero value for a resource that isn't JIT-gated.
// launchID is the launch token ROW id, which is safe to hand to the browser:
// it is not the secret in the pam-agent:// URL (that is rawToken, stored only
// as a hash) and it is scoped to its owner on every read. The browser needs
// some handle on the launch it just started, or it can never find out how the
// launch went — see models.LaunchToken's outcome columns.
func (s *AgentService) CreateLaunchToken(userID, resourceID, authzDecisionID string, grant LaunchGrantContext) (rawToken, launchID string, expiresAt time.Time, err error) {
	rawToken, err = generateOpaqueToken(32)
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("failed to generate launch token: %w", err)
	}

	expiresAt = time.Now().Add(launchTokenTTL)
	rec := &models.LaunchToken{
		TokenHash:         hashSecret(rawToken),
		ResourceID:        resourceID,
		UserID:            userID,
		Status:            "PENDING",
		ExpiresAt:         expiresAt,
		IsBreakglass:      grant.IsBreakglass,
		RecordingRequired: grant.RecordingRequired,
	}
	if authzDecisionID != "" {
		rec.AuthzDecisionID = &authzDecisionID
	}
	if grant.GrantID != "" {
		rec.GrantID = &grant.GrantID
	}
	if grant.JITRequestID != "" {
		rec.JITRequestID = &grant.JITRequestID
	}
	if err := s.db.Create(rec).Error; err != nil {
		return "", "", time.Time{}, fmt.Errorf("failed to store launch token: %w", err)
	}
	return rawToken, rec.ID, expiresAt, nil
}

// ResolvedLaunch is everything the agent needs to build a local command.
// The plaintext credential lives here only in memory, for the duration of
// one HTTP response to the agent — it is never logged and never sent
// anywhere else.
type ResolvedLaunch struct {
	SessionID         string
	RecordingRequired bool

	// DataProtection is the effective egress policy the agent enforces
	// locally, in the shape the agent's own guard expects. DeniedCommands is
	// resolved to a concrete list here (built-in defaults substituted for an
	// empty one) so the agent never has to know which defaults apply to which
	// tool — that decision stays server-side with the rest of the policy.
	DataProtection AgentDataProtection `json:"data_protection"`

	*ConnectionInfo
}

// AgentDataProtection is the wire shape sent to pam-agent. Deliberately a
// separate type from models.DataProtection: the agent enforces three of those
// controls and has no use for the two that are browser-only, and sending
// fields it cannot act on would imply it does.
type AgentDataProtection struct {
	BlockClipboard bool     `json:"block_clipboard"`
	MaxEgressBytes int64    `json:"max_egress_bytes"`
	DeniedCommands []string `json:"denied_commands"`
}

// ResolveLaunchToken verifies the agent's signature over the raw token,
// confirms the redeeming device is active and belongs to the same user the
// token was issued for, consumes the token exactly once, resolves the
// vaulted credential, and opens the same grant-aware tracked-session record
// (StartTrackedSession) the browser session gateway uses — including
// recording obligations for JIT-gated, always-record, or break-glass
// resources, using the grant context captured at issuance time (see
// models.LaunchToken's doc comment for why that capture is necessary).
func (s *AgentService) ResolveLaunchToken(rawToken, agentDeviceID, signatureB64 string,
	timestamp time.Time, sourceIP string) (*ResolvedLaunch, error) {

	var device models.AgentDevice
	if err := s.db.Where("id = ?", agentDeviceID).First(&device).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrDeviceNotFound
		}
		return nil, err
	}
	if device.Status != "ACTIVE" {
		return nil, ErrDeviceRevoked
	}

	if err := verifySignature(device.PublicKey, rawToken, timestamp, signatureB64); err != nil {
		s.logger.Warn("agent.launch.signature_invalid",
			zap.String("device_id", agentDeviceID), zap.Error(err))
		return nil, ErrSignatureInvalid
	}

	var tok models.LaunchToken
	if err := s.db.Where("token_hash = ?", hashSecret(rawToken)).First(&tok).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrLaunchTokenInvalid
		}
		return nil, err
	}
	if tok.Status != "PENDING" || time.Now().After(tok.ExpiresAt) {
		return nil, ErrLaunchTokenInvalid
	}
	if tok.UserID != device.UserID {
		// The token looks structurally valid but was issued to a different
		// user than the redeeming device belongs to — never honor it.
		s.logger.Warn("agent.launch.user_mismatch",
			zap.String("token_user", tok.UserID), zap.String("device_user", device.UserID))
		return nil, ErrLaunchTokenInvalid
	}

	now := time.Now()
	result := s.db.Model(&models.LaunchToken{}).
		Where("id = ? AND status = 'PENDING'", tok.ID).
		Updates(map[string]interface{}{
			"status": "CONSUMED", "consumed_at": now, "agent_device_id": device.ID,
		})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		// Lost a race against a concurrent redemption of the same token.
		return nil, ErrLaunchTokenInvalid
	}

	// Checked ahead of ResolveConnection, which decrypts the vaulted
	// credential: a path the policy has closed must not cause a secret to be
	// unwrapped, let alone handed to a device.
	//
	// This is the authoritative gate rather than CreateLaunchToken's, because
	// this is the call that actually releases the credential — a token issued
	// before an admin tightened the policy must still be refused here.
	resource, err := s.resourceSvc.GetResource(tok.ResourceID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve resource: %w", err)
	}
	if !resource.AllowsConnectMethod(models.ConnectMethodAgent) {
		s.auditWrite(AuditEntry{
			ActorUserID: tok.UserID,
			Action:      models.AuditConnectMethodDenied,
			Category:    models.SessionLifecycle,
			Outcome:     models.AuditOutcomeDenied,
			Severity:    models.AuditSeverityWarn,
			ResourceID:  tok.ResourceID,
			Details: map[string]interface{}{
				"connect_method":          models.ConnectMethodAgent,
				"allowed_connect_methods": resource.AllowedConnectMethods,
				"agent_device_id":         device.ID,
			},
		})
		return nil, ErrConnectMethodNotAllowed
	}

	connInfo, err := s.resourceSvc.ResolveConnection(tok.ResourceID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve resource connection: %w", err)
	}

	// The data-protection policy the agent will enforce locally.
	//
	// Composed here rather than captured on the launch token: the resource is
	// already loaded above for the connect-method gate, and the grant is one
	// lookup away, so there is no reason to duplicate four columns onto the
	// token and then have them drift from the resource they describe.
	//
	// Resolved server-side on principle. An agent that decided its own policy
	// would be asking the operator's machine how restricted the operator ought
	// to be.
	policy := resource.DataProtectionProfile()
	if tok.GrantID != nil && *tok.GrantID != "" {
		var grant models.AccessGrant
		if err := s.db.Where("id = ?", *tok.GrantID).First(&grant).Error; err == nil {
			policy = models.MostRestrictive(policy, grant.DataProtectionProfile())
		}
	}
	// An empty deny list with command blocking wanted means "use the built-in
	// patterns for this tool", so enabling it does not require an administrator
	// to know every dump verb for every client.
	denied := policy.DeniedCommandList()
	if len(denied) == 0 && policy.Any() {
		denied = models.DefaultDeniedCommands(resource.ResourceType)
	}

	authzDecisionID := ""
	if tok.AuthzDecisionID != nil {
		authzDecisionID = *tok.AuthzDecisionID
	}
	grantID := ""
	if tok.GrantID != nil {
		grantID = *tok.GrantID
	}
	jitRequestID := ""
	if tok.JITRequestID != nil {
		jitRequestID = *tok.JITRequestID
	}

	session, _, err := s.resourceSvc.StartTrackedSession(StartSessionInput{
		UserID:            device.UserID,
		Username:          s.lookupUsername(device.UserID),
		ResourceID:        tok.ResourceID,
		SourceIP:          sourceIP,
		Protocol:          connInfo.ResourceType,
		AuthzDecisionID:   authzDecisionID,
		GrantID:           grantID,
		JITRequestID:      jitRequestID,
		IsBreakglass:      tok.IsBreakglass,
		RecordingRequired: tok.RecordingRequired,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to start session record: %w", err)
	}

	s.db.Model(&models.AgentDevice{}).Where("id = ?", device.ID).Update("last_seen_at", now)

	// Bind the session to the launch the browser is still holding an id for.
	// Without this the end-of-launch report (which knows only the session)
	// could never be matched back to the launch, and the console would have
	// nothing to poll. Best-effort: the operator has a working session either
	// way, and failing the launch over a bookkeeping write would be a worse
	// trade than a console that cannot report the outcome.
	resolvedAt := now
	if err := s.db.Model(&models.LaunchToken{}).Where("id = ?", tok.ID).
		Updates(map[string]interface{}{
			"session_id":  session.ID,
			"outcome":     LaunchOutcomeOpened,
			"resolved_at": resolvedAt,
		}).Error; err != nil {
		s.logger.Warn("agent.launch.outcome_bind.fail",
			zap.String("launch_id", tok.ID), zap.String("session_id", session.ID), zap.Error(err))
	}

	s.logger.Info("agent.launch.resolved",
		zap.String("session_id", session.ID),
		zap.String("resource_id", tok.ResourceID),
		zap.String("user_id", device.UserID),
		zap.String("device_id", device.ID),
		zap.String("grant_id", grantID),
	)

	return &ResolvedLaunch{
		SessionID:         session.ID,
		RecordingRequired: session.RecordingRequired,
		DataProtection: AgentDataProtection{
			BlockClipboard: policy.BlockClipboard,
			MaxEgressBytes: policy.MaxEgressBytes,
			DeniedCommands: denied,
		},
		ConnectionInfo: connInfo,
	}, nil
}

// EndLaunchSession lets the agent report that the locally-launched process
// exited, closing the audit record — the native-launch equivalent of the
// browser session gateway's own EndSession call. agentDeviceID is who is
// reporting this (already signature-verified by the caller); status
// COMPLETED ends the session normally, anything else (e.g. FAILED) records
// it as killed with that reason instead of a clean completion.
func (s *AgentService) EndLaunchSession(sessionID, agentDeviceID, status string, failure *LaunchFailure) error {
	var device models.AgentDevice
	if err := s.db.Where("id = ?", agentDeviceID).First(&device).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrDeviceNotFound
		}
		return err
	}

	// Record the outcome against the launch before touching the session, so
	// the console can report a failure even if closing the session itself
	// goes wrong. The device is already signature-verified by the caller, and
	// the row is matched on BOTH the session and the device, so one operator's
	// agent cannot write an outcome onto another operator's launch.
	s.recordLaunchOutcome(sessionID, device.ID, status, failure)

	if status == "" || status == "COMPLETED" {
		_, err := s.resourceSvc.EndTrackedSession(sessionID, device.UserID, true)
		return err
	}
	// killed_by is a varchar(36) actor-id column everywhere else it's
	// written (see admin_handler.go/resource_handler.go) — it holds a
	// plain user ID, not a free-form label. Pass the device's owning
	// user ID there and put the "which device reported this" detail in
	// kill_reason instead, which is unbounded (models.ConnectionSession.
	// KillReason is `text`). An earlier version of this line passed
	// "agent-device:"+device.ID directly as killed_by, which overflows
	// the varchar(36) column for any device ID and made every non-clean
	// (status=FAILED) agent-reported session end fail with a Postgres
	// "value too long for type character varying(36)" error.
	// The agent's own explanation, where it gave one, is far more use in the
	// audit trail than a bare status. Bounded on the way in by
	// clampLaunchText: kill_reason is `text`, but it is read by people.
	reason := fmt.Sprintf("Local agent reported launch status=%s (agent_device_id=%s)", status, device.ID)
	if failure != nil && strings.TrimSpace(failure.Reason) != "" {
		reason = fmt.Sprintf("%s (agent_device_id=%s)", clampLaunchText(failure.Reason, launchReasonMax), device.ID)
	}
	return s.resourceSvc.KillSession(sessionID, device.UserID, reason)
}

// Launch outcomes. See models.LaunchToken.Outcome for why these are separate
// from the token's own Status.
const (
	LaunchOutcomeOpened    = "OPENED"
	LaunchOutcomeCompleted = "COMPLETED"
	LaunchOutcomeFailed    = "FAILED"
)

// Bounds on what an agent may write into the launch row. These are stored
// server-side and rendered to operators and administrators, so a runaway
// error string from someone's laptop must not become an unbounded row or an
// unreadable panel.
const (
	launchCodeMax   = 64
	launchReasonMax = 400
	launchHintMax   = 600
)

// LaunchFailure is the agent's explanation of why a launch did not work, in
// the shape the console renders it.
//
// This crosses a trust boundary: it is composed on the operator's own machine
// and arrives over the agent's signed channel. The signature proves WHICH
// paired device sent it, not that the contents are sensible, so every field
// is bounded and stored as data, never interpreted. The console renders these
// as text.
type LaunchFailure struct {
	Code   string `json:"code"`
	Reason string `json:"reason"`
	Hint   string `json:"hint"`
}

// recordLaunchOutcome writes how a launch finished onto the launch row the
// browser is polling.
//
// Best-effort throughout: this is a reporting path, and an operator whose
// session ended correctly must not see an error because the reporting of it
// failed. Every failure is logged instead.
func (s *AgentService) recordLaunchOutcome(sessionID, agentDeviceID, status string, failure *LaunchFailure) {
	outcome := LaunchOutcomeCompleted
	if status != "" && status != "COMPLETED" {
		outcome = LaunchOutcomeFailed
	}

	updates := map[string]interface{}{
		"outcome":  outcome,
		"ended_at": time.Now(),
	}
	if failure != nil {
		updates["failure_code"] = clampLaunchText(failure.Code, launchCodeMax)
		updates["failure_reason"] = clampLaunchText(failure.Reason, launchReasonMax)
		updates["failure_hint"] = clampLaunchText(failure.Hint, launchHintMax)
	}

	// agent_device_id in the WHERE is the authorisation, not a filter: only
	// the device that redeemed this launch may say how it went.
	res := s.db.Model(&models.LaunchToken{}).
		Where("session_id = ? AND agent_device_id = ?", sessionID, agentDeviceID).
		Updates(updates)
	if res.Error != nil {
		s.logger.Warn("agent.launch.outcome_record.fail",
			zap.String("session_id", sessionID), zap.Error(res.Error))
		return
	}
	if res.RowsAffected == 0 {
		// A session ended by an agent that did not open it, or one opened
		// before this column existed. Not an error, but worth seeing.
		s.logger.Debug("agent.launch.outcome_record.no_row",
			zap.String("session_id", sessionID), zap.String("agent_device_id", agentDeviceID))
	}
}

// LaunchStatus is what the browser that started a launch is allowed to learn
// about it. Deliberately narrow: no token hash, no resource connection
// detail, nothing about the device beyond the fact that one took the handoff.
type LaunchStatus struct {
	LaunchID      string     `json:"launch_id"`
	ResourceID    string     `json:"resource_id"`
	State         string     `json:"state"`
	Outcome       string     `json:"outcome,omitempty"`
	SessionID     string     `json:"session_id,omitempty"`
	FailureCode   string     `json:"failure_code,omitempty"`
	FailureReason string     `json:"failure_reason,omitempty"`
	FailureHint   string     `json:"failure_hint,omitempty"`
	ExpiresAt     time.Time  `json:"expires_at"`
	ResolvedAt    *time.Time `json:"resolved_at,omitempty"`
	EndedAt       *time.Time `json:"ended_at,omitempty"`
}

// GetLaunchStatus reports how a launch is going, to the user who started it.
//
// userID is matched in the query rather than checked afterwards: this is the
// one place the browser can read anything an agent wrote, and "not yours"
// must be indistinguishable from "does not exist" so the endpoint cannot be
// used to probe for other people's launch ids.
func (s *AgentService) GetLaunchStatus(userID, launchID string) (*LaunchStatus, error) {
	var tok models.LaunchToken
	if err := s.db.Where("id = ? AND user_id = ?", launchID, userID).First(&tok).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrLaunchTokenInvalid
		}
		return nil, err
	}

	out := &LaunchStatus{
		LaunchID:      tok.ID,
		ResourceID:    tok.ResourceID,
		State:         launchState(&tok),
		Outcome:       tok.Outcome,
		FailureCode:   tok.FailureCode,
		FailureReason: tok.FailureReason,
		FailureHint:   tok.FailureHint,
		ExpiresAt:     tok.ExpiresAt,
		ResolvedAt:    tok.ResolvedAt,
		EndedAt:       tok.EndedAt,
	}
	if tok.SessionID != nil {
		out.SessionID = *tok.SessionID
	}
	return out, nil
}

// launchState collapses the token's status, its expiry and the agent's
// reported outcome into the one question the console is actually asking:
// what should I show the person who just clicked Connect?
//
//	waiting   handed off, no agent has redeemed it yet
//	expired   the handoff window closed with nothing redeeming it, which in
//	          practice means no agent is installed or running on this machine
//	opened    an agent took it and a session exists
//	completed the tool ran and exited
//	failed    the launch could not proceed
func launchState(tok *models.LaunchToken) string {
	switch tok.Outcome {
	case LaunchOutcomeFailed:
		return "failed"
	case LaunchOutcomeCompleted:
		return "completed"
	case LaunchOutcomeOpened:
		return "opened"
	}
	if tok.Status == "PENDING" && time.Now().After(tok.ExpiresAt) {
		return "expired"
	}
	if tok.Status != "PENDING" {
		// Consumed with no outcome recorded: an agent from before these
		// columns existed, or one that died between redeeming and reporting.
		return "opened"
	}
	return "waiting"
}

// clampLaunchText normalises whitespace and enforces a maximum length on text
// that arrived from an operator's machine.
func clampLaunchText(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= max {
		return s
	}
	// Cut on a rune boundary: the field is free text and may be non-ASCII.
	for max > 0 && !utf8.ValidString(s[:max]) {
		max--
	}
	return strings.TrimSpace(s[:max])
}

// CapturedCommand is one line pam-agent's ConPTY input relay reconstructed
// from raw keystrokes (see pam-agent's internal/launcher/keylog.go) — a
// best-effort approximation of "what did the operator type," not a real
// command/result pair the way the browser gateway's protocol runners
// produce. OffsetMs is milliseconds since the session started; there is no
// other per-line timestamp signal available from a raw keystroke stream, so
// OccurredAt gets reconstructed from it rather than measured directly.
type CapturedCommand struct {
	Input    string `json:"input"`
	OffsetMs int64  `json:"offset_ms"`
}

// UploadLaunchRecording accepts the finished recording a native agent
// captured locally (see pam-agent's ConPTY-backed Windows launch path) and
// closes out the recording obligation StartTrackedSession created when this
// session was resolved — the native-launch equivalent of gateway.go's
// finalizeRecording. Signature verification is the caller's job (the agent
// signs sessionID the same way EndLaunch does); this just needs to know
// which device is asserting the upload for logging.
//
// gz is trusted for its bytes but not for its own claimed hash/size — sha256
// and length are always recomputed here from what was actually received,
// the same posture every other artifact-attach path in this codebase takes.
func (s *AgentService) UploadLaunchRecording(sessionID, agentDeviceID string, gz []byte, format, mediaType, status, failureReason string, commands []CapturedCommand) error {
	var device models.AgentDevice
	if err := s.db.Where("id = ?", agentDeviceID).First(&device).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrDeviceNotFound
		}
		return err
	}

	sess, err := s.resourceSvc.GetSession(sessionID)
	if err != nil {
		return err
	}
	if sess.RecordingID == nil || *sess.RecordingID == "" {
		return fmt.Errorf("session %s has no recording obligation to attach an artifact to", sessionID)
	}
	recordingID := *sess.RecordingID

	// Independent of whether the video artifact itself saves successfully
	// below — the structured command log is the searchable half of a
	// recording (see models.SessionRecordingCommand's doc comment) and
	// losing it isn't contingent on the cast blob's own fate.
	if len(commands) > 0 {
		s.storeCapturedCommands(recordingID, sessionID, sess.StartedAt, commands)
	}

	if status == "FAILED" {
		if failureReason == "" {
			failureReason = "local agent reported a recording capture failure"
		}
		s.logger.Warn("agent.recording.upload.client_failed",
			zap.String("session_id", sessionID), zap.String("recording_id", recordingID), zap.String("reason", failureReason))
		return s.resourceSvc.MarkRecordingFailed(recordingID, failureReason)
	}

	if s.recordingStorage == nil {
		return s.resourceSvc.MarkRecordingFailed(recordingID, "recording storage was not configured/available on the PAM server")
	}

	// The agent STATES the format; it is never sniffed from the bytes. An
	// asciicast mislabelled as video would replay as a blank rectangle, and a
	// video parsed as an asciicast would fail on its first line. Anything
	// unrecognised is treated as a terminal transcript, which is what every
	// agent built before desktop recording existed sends and does not label.
	format = NormalizeRecordingFormat(format)
	if format == RecordingFormatVideo {
		// Marked before the artifact is attached, because attaching is what
		// moves the row to COMPLETED and SetRecordingFormat only writes to a
		// row still PENDING or RECORDING.
		if err := s.resourceSvc.SetRecordingFormat(recordingID, format); err != nil {
			s.logger.Warn("agent.recording.upload.format_set_fail",
				zap.String("recording_id", recordingID), zap.Error(err))
		}
	}

	sum := sha256.Sum256(gz)
	sha256Hex := hex.EncodeToString(sum[:])
	key := fmt.Sprintf("recordings/%s/%s%s", time.Now().UTC().Format("2006/01/02"), recordingID, recordingArtifactSuffix(format, mediaType))

	if err := s.recordingStorage.Save(context.Background(), key, gz); err != nil {
		s.logger.Error("agent.recording.upload.save_fail",
			zap.String("session_id", sessionID), zap.String("recording_id", recordingID), zap.Error(err))
		return s.resourceSvc.MarkRecordingFailed(recordingID, "failed to persist agent-uploaded recording: "+err.Error())
	}

	if err := s.resourceSvc.AttachRecordingArtifact(recordingID, s.recordingStorage.Label(), key, int64(len(gz)), sha256Hex, false); err != nil {
		return err
	}
	s.logger.Info("agent.recording.upload.ok",
		zap.String("session_id", sessionID), zap.String("recording_id", recordingID), zap.Int("bytes", len(gz)))
	return nil
}

// Recording artifact formats the agent may upload.
//
// A DESKTOP application has no terminal for the relay to own, so the agent
// records it as video instead: a desktop client draws pixels, and pixels are
// the only honest recording of one. Terminal sessions stay asciicast.
const (
	RecordingFormatAsciicast = "asciicast"
	RecordingFormatVideo     = "video"
)

// NormalizeRecordingFormat maps what an agent claims onto what PAM stores.
//
// A WHITELIST, not a passthrough. This value is chosen on the operator's own
// machine and decides which player the console loads for an auditor, so an
// unrecognised value must fall back to the terminal renderer rather than
// reaching the database. Empty is included in that: every agent built before
// desktop recording existed sends no format field at all.
func NormalizeRecordingFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case RecordingFormatVideo:
		return RecordingFormatVideo
	default:
		return RecordingFormatAsciicast
	}
}

// recordingArtifactSuffix names the stored object for what it actually is.
//
// The extension is not decorative and it is not a second source of truth
// either: it is THE record of which container a video recording used, and
// GetRecordingVideo derives the Content-Type it serves straight back from it.
// That is why a new container needs no new column and no migration.
//
// The agent reports the media type because the encoder is chosen from what
// the operator's own ffmpeg build supports (see the agent's recorder), so the
// server cannot know it. An unrecognised value falls back to MP4 rather than
// reaching the key, for the same reason the format itself is whitelisted.
func recordingArtifactSuffix(format, mediaType string) string {
	if format != RecordingFormatVideo {
		return ".cast.gz"
	}
	switch strings.ToLower(strings.TrimSpace(mediaType)) {
	case "video/webm":
		return ".webm"
	default:
		return ".mp4"
	}
}

// RecordingMediaType maps a stored artifact's key back to the type it must be
// served with. A browser refuses a WebM labelled video/mp4, so getting this
// wrong makes a perfectly good recording unplayable.
func RecordingMediaType(storageKey string) string {
	if strings.HasSuffix(strings.ToLower(storageKey), ".webm") {
		return "video/webm"
	}
	return "video/mp4"
}

// storeCapturedCommands persists pam-agent's best-effort keystroke-derived
// command list — the native-launch counterpart to AppendRecordingCommand's
// callers in gateway.go's protocol runners (redis.go/postgres.go/mongo.go/
// ssh.go). Unlike those, a raw keystroke stream carries no real
// success/failure/output signal for what it captured, which OutputSummary
// says explicitly rather than fabricating one. Best-effort by design: one
// row failing to save is logged and skipped, not returned as an error — the
// caller's video-artifact upload (already committed by the time this runs)
// shouldn't be undone by a lesser compliance gap in this secondary log.
func (s *AgentService) storeCapturedCommands(recordingID, sessionID string, sessionStartedAt time.Time, commands []CapturedCommand) {
	for i, cmd := range commands {
		masked := recorder.MaskSecrets(cmd.Input)
		row := &models.SessionRecordingCommand{
			RecordingID:   recordingID,
			SessionID:     sessionID,
			Sequence:      i + 1,
			Input:         masked,
			InputMasked:   masked != cmd.Input,
			Outcome:       "SUCCESS",
			OutputSummary: "captured via native agent keystroke relay; command result not available",
			OccurredAt:    sessionStartedAt.Add(time.Duration(cmd.OffsetMs) * time.Millisecond),
		}
		if err := s.resourceSvc.AppendRecordingCommand(row); err != nil {
			s.logger.Warn("agent.recording.commands.append_fail",
				zap.String("session_id", sessionID), zap.String("recording_id", recordingID), zap.Error(err))
		}
	}
}

// VerifyDeviceSignature checks that agentDeviceID is ACTIVE and that
// signatureB64 is a valid Ed25519 signature — from that device's enrolled
// public key, within the allowed clock skew — over the given value. Used
// for lower-stakes agent-authenticated calls (like reporting a session
// ended) that don't need the full launch-token consumption dance.
func (s *AgentService) VerifyDeviceSignature(agentDeviceID, value, signatureB64 string, timestamp time.Time) error {
	var device models.AgentDevice
	if err := s.db.Where("id = ?", agentDeviceID).First(&device).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrDeviceNotFound
		}
		return err
	}
	if device.Status != "ACTIVE" {
		return ErrDeviceRevoked
	}
	return verifySignature(device.PublicKey, value, timestamp, signatureB64)
}

func (s *AgentService) lookupUsername(userID string) string {
	var user models.User
	if err := s.db.Where("user_id = ?", userID).First(&user).Error; err != nil {
		return ""
	}
	return user.Username
}

// ──────────────────────────────────────────────────────────────────────────
// CRYPTO / TOKEN HELPERS
// ──────────────────────────────────────────────────────────────────────────

func hashSecret(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}

func generateOpaqueToken(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// generateHumanCode returns an uppercase code drawn from an alphabet with
// visually ambiguous characters (0/O, 1/I/L) removed, so it's easy to read
// off one screen and type into another without transcription errors.
func generateHumanCode(n int) (string, error) {
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	code := make([]byte, n)
	for i, b := range raw {
		code[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(code), nil
}

// signingMessage is the exact canonical string an agent must sign — the
// same construction is documented and implemented independently in the
// agent module (pam-agent/internal/apiclient), since the two are separate
// Go modules. Keep this comment in sync if the format ever changes:
// "<value>|<unix-seconds-timestamp>". value is the launch token when
// redeeming a launch, or the session ID when reporting a session ended.
func signingMessage(value string, timestamp time.Time) string {
	return fmt.Sprintf("%s|%d", value, timestamp.Unix())
}

func verifySignature(publicKeyB64, value string, timestamp time.Time, signatureB64 string) error {
	if absDuration(time.Since(timestamp)) > signatureMaxSkew {
		return fmt.Errorf("timestamp outside allowed skew")
	}

	pubBytes, err := base64.StdEncoding.DecodeString(publicKeyB64)
	if err != nil || len(pubBytes) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid stored device public key")
	}

	sig, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return fmt.Errorf("invalid signature encoding")
	}

	message := []byte(signingMessage(value, timestamp))
	if !ed25519.Verify(ed25519.PublicKey(pubBytes), message, sig) {
		return fmt.Errorf("signature does not verify")
	}
	return nil
}

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

// auditWrite is a nil-safe audit write, so a service constructed without an
// audit backend (tests) degrades to the logger instead of panicking on a
// policy decision.
func (s *AgentService) auditWrite(e AuditEntry) {
	if s.audit == nil {
		s.logger.Warn("agent.audit.unavailable",
			zap.String("action", e.Action),
			zap.String("resource_id", e.ResourceID))
		return
	}
	s.audit.Write(e)
}
