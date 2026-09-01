// pam/internal/services/resource_service.go
package services

import (
	"encoding/json"
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	ErrResourceNotFound  = errors.New("resource not found")
	ErrVaultNotFound     = errors.New("vault entry not found")
	ErrAlreadyCheckedOut = errors.New("credential is already checked out")
)

// ResourceService manages the resource registry, vault, and connection sessions.
type ResourceService struct {
	db        *gorm.DB
	// vault is the single credential store. See WithVault.
	vault *VaultService
	logger    *zap.Logger

	// liveSessions maps an ACTIVE pam_connection_sessions.id to the cancel
	// function of the goroutine actually holding that connection open (see
	// internal/gateway — the in-browser terminal). This is what makes
	// KillSession/RequireActiveGrant revocation reach a LIVE socket instead
	// of only flipping a database row — previously KillSession's doc comment
	// explicitly flagged this as a gap ("cannot tear down a TCP connection
	// the client already established"); the gateway package closes it.
	//
	// Intentionally in-process, not Redis-backed: PAM runs as a single
	// instance today. If PAM is ever horizontally scaled, this map needs to
	// become a pub/sub-backed registry so a kill issued against instance A
	// can reach a socket held open by instance B — flagged here rather than
	// silently assumed away.
	liveMu       sync.Mutex
	liveSessions map[string]func()
}

// NewResourceService no longer takes the master key: credentials are the
// vault's business now, and this service was the only other thing holding a
// copy of it.
func NewResourceService(db *gorm.DB, logger *zap.Logger) *ResourceService {
	return &ResourceService{db: db, logger: logger, liveSessions: make(map[string]func())}
}

// WithVault hands this service the vault, and with it the ONE way credentials
// are stored in this product.
//
// WHY THIS EXISTS. There used to be two. A credential attached from the
// Resources screen was sealed with a single AES-GCM layer under the master key
// and written straight to pam_credentials: no per-secret data key, no AAD
// binding it to its row, no version history, no rotation metadata, and a log
// line where the vault path writes an audit record. A credential attached from
// the Vault screen was sealed as an envelope with all of that. Same table, two
// formats, decided by which screen an operator happened to use.
//
// It was not only inconsistent, it was broken across the seam. The connection
// path read rows with the single-layer reader, which cannot parse an envelope,
// so a credential attached to a resource through the Vault screen could not be
// used to connect to that resource. Rotating from the Resources screen wrote
// the single-layer format back over an envelope, quietly downgrading it.
//
// No PAM product of this class has two credential stores. In CyberArk,
// BeyondTrust and Delinea alike there is one privileged account object, in one
// safe, under one policy, and the target system is a property of the account
// rather than a second place to keep it. So the Resources screen now files its
// credential in the vault like everything else and keeps only the link.
func (s *ResourceService) WithVault(v *VaultService) *ResourceService {
	s.vault = v
	return s
}

// RegisterLiveSession records the cancel function for a just-opened
// in-browser terminal session, so a later KillSession/grant-revoke can
// force-close it. Call once, right after the session row is created.
func (s *ResourceService) RegisterLiveSession(sessionID string, cancel func()) {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	s.liveSessions[sessionID] = cancel
}

// UnregisterLiveSession removes the entry once the socket has closed on its
// own (client disconnected, protocol error, etc.) — safe to call even if the
// session was never registered or was already removed.
func (s *ResourceService) UnregisterLiveSession(sessionID string) {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	delete(s.liveSessions, sessionID)
}

// KillLiveSession force-closes a live terminal socket if one is registered
// for this session ID. Returns false (a no-op, not an error) when the
// session was never a web-terminal session in the first place — e.g. it was
// opened via the native agent, or the socket already closed on its own.
func (s *ResourceService) KillLiveSession(sessionID string) bool {
	s.liveMu.Lock()
	cancel, ok := s.liveSessions[sessionID]
	delete(s.liveSessions, sessionID)
	s.liveMu.Unlock()
	if ok && cancel != nil {
		cancel()
	}
	return ok
}

// DB exposes the underlying *gorm.DB for handlers that need raw queries.
func (s *ResourceService) DB() *gorm.DB {
	return s.db
}

// ──────────────────────────────────────────────────────────────────────────
// RESOURCE CRUD
// ──────────────────────────────────────────────────────────────────────────

// CreateResource registers a new target system (database, service, app).
func (s *ResourceService) CreateResource(r *models.PAMResource) error {
	return s.db.Create(r).Error
}

// ValidateExtraConfigJSON rejects a malformed ExtraConfig payload before it
// is ever persisted — the resource-management handlers call this from both
// Create and Update. An empty string is valid (no extra config at all);
// anything non-empty must parse as a JSON object, since ResolveConnection
// unmarshals it straight into map[string]interface{} at connect time. This
// is what keeps a typo in, e.g., a MinIO resource's {"use_ssl": true}
// extra_config from being silently accepted here and only discovered later
// as a hard connect-time failure (see ResolveConnection's doc comment).
func ValidateExtraConfigJSON(raw string) error {
	if raw == "" {
		return nil
	}
	var v map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return fmt.Errorf("extra_config must be a valid JSON object: %w", err)
	}
	return nil
}

// GetResource fetches a single resource by ID.
func (s *ResourceService) GetResource(id string) (*models.PAMResource, error) {
	var r models.PAMResource
	if err := s.db.Where("id = ?", id).First(&r).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrResourceNotFound
		}
		return nil, err
	}
	return &r, nil
}

// ListResources returns all active resources, optionally filtered by type.
// ListResources returns at most MaxUnpagedRows resources, and reports whether
// it had to stop short. See unpaged_limit.go.
func (s *ResourceService) ListResources(resourceType string) ([]models.PAMResource, bool, error) {
	var resources []models.PAMResource
	query := s.db.Where("is_active = ?", true).
		Order("resource_type ASC, name ASC").
		Limit(MaxUnpagedRows + 1)
	if resourceType != "" {
		query = query.Where("resource_type = ?", resourceType)
	}
	if err := query.Find(&resources).Error; err != nil {
		return nil, false, err
	}
	resources, truncated := capUnpaged(resources)
	return resources, truncated, nil
}

// ListResourceGroups returns resources grouped by type (for UI display), and
// carries the catalogue's truncation flag through so the console can say the
// grouping describes a capped list rather than the whole estate.
func (s *ResourceService) ListResourceGroups() ([]models.ResourceGroup, bool, error) {
	resources, truncated, err := s.ListResources("")
	if err != nil {
		return nil, false, err
	}

	groupMap := make(map[string][]models.PAMResource)
	for _, r := range resources {
		groupMap[r.ResourceType] = append(groupMap[r.ResourceType], r)
	}

	typeInfo := map[string]struct{ Name, Icon string }{
		"postgresql": {"PostgreSQL Databases", "🐘"},
		"mongodb":    {"MongoDB Databases", "🍃"},
		"redis":      {"Redis Instances", "🔴"},
		"clickhouse": {"ClickHouse Databases", "⚡"},
		"minio":      {"MinIO Storage", "📦"},
		"qdrant":     {"Qdrant Vector DB", "🔍"},
		"metabase":   {"Metabase BI", "📊"},
		"langfuse":   {"Langfuse Observability", "🔬"},
		"web":        {"Web Applications", "🌐"},
	}

	var groups []models.ResourceGroup
	for rtype, items := range groupMap {
		info, ok := typeInfo[rtype]
		if !ok {
			info = struct{ Name, Icon string }{rtype, "🔗"}
		}
		groups = append(groups, models.ResourceGroup{
			Name:      info.Name,
			Icon:      info.Icon,
			Resources: items,
		})
	}
	return groups, truncated, nil
}

// UpdateResource updates a resource's mutable fields.
func (s *ResourceService) UpdateResource(id string, updates map[string]interface{}) error {
	result := s.db.Model(&models.PAMResource{}).Where("id = ?", id).Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrResourceNotFound
	}
	return nil
}

// DeleteResource soft-deletes a resource.
func (s *ResourceService) DeleteResource(id string) error {
	return s.db.Where("id = ?", id).Delete(&models.PAMResource{}).Error
}

// ──────────────────────────────────────────────────────────────────────────
// VAULT (encrypted credential management)
// ──────────────────────────────────────────────────────────────────────────

// StoreCredential files a resource's credential in the vault and links it.
//
// It is a thin wrapper on purpose: the encryption, the AAD binding, the first
// version row and the rotation schedule all come from VaultService, so a
// credential attached here is indistinguishable from one attached through the
// Vault screen. What this adds is the resource link, which is the only thing
// that is genuinely about resources.
func (s *ResourceService) StoreCredential(resourceID, accountName, credentialType, plaintext string) (*models.VaultEntry, error) {
	if s.vault == nil {
		return nil, errors.New("credential store unavailable: the vault was not attached to this service")
	}

	entry, err := s.vault.StoreCredential(context.Background(), StoreCredentialRequest{
		// Named rather than left to the column default, so the safe this
		// lands in is a decision in the code instead of a string Postgres
		// fills in. It is the same value either way; stating it is what keeps
		// the encryption binding and the row in agreement.
		SafeID:          models.DefaultSafeID,
		ResourceID:      resourceID,
		AccountName:     accountName,
		CredentialType:  models.CredentialType(credentialType),
		SecretPlaintext: plaintext,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to store credential: %w", err)
	}

	// The pointer is what every connection resolves through, so it is written
	// after the row exists and its failure is reported rather than swallowed:
	// a stored credential nothing points at is a credential the resource
	// cannot use, which looks identical to no credential at all.
	if err := s.db.Model(&models.PAMResource{}).Where("id = ?", resourceID).
		Update("vault_entry_id", entry.ID).Error; err != nil {
		return nil, fmt.Errorf("credential stored but could not be linked to the resource: %w", err)
	}

	s.logger.Info("vault.credential.stored",
		zap.String("resource_id", resourceID),
		zap.String("account", accountName),
		zap.String("credential_id", entry.ID),
	)
	return entry, nil
}

// GetDecryptedCredential retrieves and decrypts THE CURRENT credential for a
// resource. This is called ONLY at connection time — the plaintext is never
// stored or logged.
//
// BUGFIX: this used to do a bare `Where("resource_id = ?", resourceID).
// First(&entry)` with no ORDER BY at all — GORM's First() then falls back to
// ordering by primary key (a random UUID string), NOT insertion order. Store
// a credential more than once for the same resource (re-storing after a
// mistake, or StoreCredential being called again) and this would pick
// whichever row's UUID happened to sort first alphabetically — a coin flip
// between the current and a stale, possibly differently-encrypted-key
// credential, which would then make the in-browser terminal gateway (see
// internal/gateway) intermittently fail to authenticate against the real
// target with no obvious cause. Fixed by resolving through the resource's
// own VaultEntryID pointer (the field StoreCredential already sets and that
// was simply never consulted here), which is authoritative for "the current
// one." Legacy rows created before this fix (VaultEntryID somehow unset)
// fall back to the most recently created entry for that resource, which is
// the closest available approximation of "current."
func (s *ResourceService) GetDecryptedCredential(resourceID string) (accountName, plaintext string, err error) {
	resource, err := s.GetResource(resourceID)
	if err != nil {
		return "", "", err
	}

	var entry models.VaultEntry
	q := s.db.Where("resource_id = ?", resourceID)
	if resource.VaultEntryID != nil && *resource.VaultEntryID != "" {
		q = s.db.Where("id = ?", *resource.VaultEntryID)
	} else {
		q = q.Order("created_at DESC")
	}
	if err := q.First(&entry).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", "", ErrVaultNotFound
		}
		return "", "", err
	}

	// READ THROUGH THE VAULT, which is what makes both formats readable here.
	// This used to call crypto.Decrypt, the single-layer reader, so a
	// credential attached through the Vault screen (an envelope) could not be
	// decrypted and the connection failed with "no credential configured" on a
	// resource that plainly had one. EnvelopeDecryptor reads the envelope and
	// still reads rows written before this change, so nothing has to be
	// migrated for a connection to start working again.
	if s.vault == nil {
		return "", "", errors.New("credential store unavailable: the vault was not attached to this service")
	}
	decrypted, err := s.vault.GetDecryptedCredential(context.Background(), entry.ID)
	if err != nil {
		return "", "", fmt.Errorf("failed to decrypt credential: %w", err)
	}

	return entry.AccountName, decrypted, nil
}

// RotateCredential replaces the CURRENT credential (resolved the same way
// GetDecryptedCredential resolves it — via the resource's VaultEntryID
// pointer) with a new one.
//
// BUGFIX: this used to run `Where("resource_id = ?", resourceID).Updates(...)`
// with no row-scoping beyond resource_id — if more than one vault entry ever
// existed for a resource (see GetDecryptedCredential's fix above for how
// that happens), this would silently rewrite ALL of them, re-encrypting
// stale rows nothing was reading anyway and masking the fact that a
// duplicate existed at all.
func (s *ResourceService) RotateCredential(resourceID, newPlaintext string) error {
	resource, err := s.GetResource(resourceID)
	if err != nil {
		return err
	}
	// ROTATION GOES THROUGH THE VAULT TOO, so it writes a version row and the
	// new secret stays in the same format as the old one. The previous
	// implementation re-encrypted with the single-layer writer, which silently
	// downgraded an enveloped credential to a weaker format the first time
	// anyone rotated it from this screen, and left no version history behind
	// either.
	if s.vault == nil {
		return errors.New("credential store unavailable: the vault was not attached to this service")
	}

	credID := ""
	if resource.VaultEntryID != nil && *resource.VaultEntryID != "" {
		credID = *resource.VaultEntryID
	} else {
		var entry models.VaultEntry
		if err := s.db.Where("resource_id = ?", resourceID).
			Order("created_at DESC").First(&entry).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrVaultNotFound
			}
			return err
		}
		credID = entry.ID
	}

	_, err = s.vault.CreateVersion(context.Background(), credID, newPlaintext,
		"Rotated from the resource", "")
	return err
}

// ──────────────────────────────────────────────────────────────────────────
// CONNECTION SESSIONS
// ──────────────────────────────────────────────────────────────────────────

// StartSession creates a connection session record when a user connects to a resource.
func (s *ResourceService) StartSession(userID, username, resourceID, sourceIP,
	authzDecisionID string) (*models.ConnectionSession, error) {

	resource, err := s.GetResource(resourceID)
	if err != nil {
		return nil, err
	}

	allowed := true
	session := &models.ConnectionSession{
		UserID:          userID,
		Username:        username,
		ResourceID:      resourceID,
		ResourceName:    resource.Name,
		ResourceType:    resource.ResourceType,
		SourceIP:        sourceIP,
		Protocol:        resource.ResourceType,
		Status:          "ACTIVE",
		AuthzDecisionID: &authzDecisionID,
		AuthzAllowed:    &allowed,
	}

	if err := s.db.Create(session).Error; err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}

	s.logger.Info("session.started",
		zap.String("session_id", session.ID),
		zap.String("user", username),
		zap.String("resource", resource.Name),
		zap.String("type", resource.ResourceType),
	)
	return session, nil
}

// EndSession marks a session as completed.
//
// BUGFIX: duration_seconds was previously computed as
//
//	int(now.Sub(time.Time{}).Seconds())
//
// which measures from the Go zero time (year 1) and stores ~6.4e10 seconds
// on every row. It is now derived in SQL from started_at, which is also
// race-free (no read-modify-write round trip).
func (s *ResourceService) EndSession(sessionID string) error {
	now := time.Now().UTC()
	return s.db.Model(&models.ConnectionSession{}).
		Where("id = ? AND status = 'ACTIVE'", sessionID).
		Updates(map[string]interface{}{
			"status":           "COMPLETED",
			"ended_at":         now,
			"duration_seconds": gorm.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - started_at))::int)", now),
		}).Error
}

// ListActiveSessions returns all currently-active sessions (for admin monitoring).
func (s *ResourceService) ListActiveSessions() ([]models.ConnectionSession, error) {
	var sessions []models.ConnectionSession
	err := s.db.Where("status = 'ACTIVE'").Order("started_at DESC").Find(&sessions).Error
	return sessions, err
}

// KillSession terminates a session (admin action).
//
// For sessions opened through the in-browser terminal gateway
// (internal/gateway), this now ALSO force-closes the live socket via
// KillLiveSession — real, physical termination, not just a database status
// flip. For sessions opened through the native agent, termination is still
// best-effort only (see agent_service.go): PAM has no way to reach into a
// process running on the user's own machine.
func (s *ResourceService) KillSession(sessionID, killedBy, reason string) error {
	now := time.Now().UTC()
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&models.ConnectionSession{}).
			Where("id = ? AND status = 'ACTIVE'", sessionID).
			Updates(map[string]interface{}{
				"status":           "KILLED",
				"ended_at":         now,
				"kill_reason":      reason,
				"killed_by":        killedBy,
				"duration_seconds": gorm.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - started_at))::int)", now),
			}).Error; err != nil {
			return err
		}
		// Stamps the recording obligation's ended_at the same way
		// EndTrackedSession/KillSessionsByGrantTx do — without this, a
		// recording killed via this admin action would never get an
		// ended_at at all (see ReconcileOrphanedRecordings' doc comment for
		// why that matters beyond cosmetics). Status is deliberately left
		// alone here for the same reason closeRecordingTx never touches it:
		// gateway.go's finalizeRecording (still running, if this session was
		// opened via the browser terminal) is the only place that should
		// ever mark COMPLETED/FAILED, once the artifact's fate is known.
		return closeRecordingTx(tx, sessionID, now)
	})
	if err != nil {
		return err
	}
	s.KillLiveSession(sessionID)
	return nil
}

// ──────────────────────────────────────────────────────────────────────────
// CONNECTION BROKER — builds the connection details for a resource
// ──────────────────────────────────────────────────────────────────────────

// ConnectionInfo holds everything needed to connect to a resource.
// This is returned to the WebSocket handler which uses it to open the connection.
type ConnectionInfo struct {
	ResourceID   string                 `json:"resource_id"`
	ResourceName string                 `json:"resource_name"`
	ResourceType string                 `json:"resource_type"`
	Host         string                 `json:"host"`
	Port         int                    `json:"port"`
	DatabaseName string                 `json:"database_name,omitempty"`
	AccountName  string                 `json:"account"`
	Password     string                 `json:"-"` // NEVER serialized to JSON
	ExtraConfig  map[string]interface{} `json:"extra_config,omitempty"`
	ConsoleURL   string                 `json:"console_url,omitempty"`
	ConnectMode  string                 `json:"connect_mode"`
}

// ResolveConnection retrieves all info needed to connect to a resource,
// including the decrypted credential. Called by the WebSocket handler.
// The plaintext password is in-memory only — never logged or returned to the client.
func (s *ResourceService) ResolveConnection(resourceID string) (*ConnectionInfo, error) {
	resource, err := s.GetResource(resourceID)
	if err != nil {
		return nil, err
	}

	accountName, password, err := s.GetDecryptedCredential(resourceID)
	if err != nil {
		return nil, fmt.Errorf("no credential configured for resource '%s': %w", resource.Name, err)
	}

	// BUGFIX: this used to call json.Unmarshal and silently discard any
	// error, leaving extraConfig nil on a malformed stored value. For a
	// connector like MinIO/S3 that reads security-relevant fields out of
	// this map (use_ssl, region) with no independent signal of its own, a
	// silently-empty map reads as "use defaults" instead of "this resource's
	// config is broken" — which can downgrade a connection (e.g. an intended
	// TLS endpoint silently dialed over plaintext) instead of failing loud.
	// resource_handler.go's Create/Update already reject invalid JSON before
	// a row is ever saved, so a parse failure here means the stored value
	// was corrupted after the fact — surface it as a hard error rather than
	// connecting with an incomplete/wrong configuration.
	var extraConfig map[string]interface{}
	if resource.ExtraConfig != "" {
		if err := json.Unmarshal([]byte(resource.ExtraConfig), &extraConfig); err != nil {
			return nil, fmt.Errorf("resource '%s' has a corrupted extra_config: %w", resource.Name, err)
		}
	}

	return &ConnectionInfo{
		ResourceID:   resource.ID,
		ResourceName: resource.Name,
		ResourceType: resource.ResourceType,
		Host:         resource.Host,
		Port:         resource.Port,
		DatabaseName: resource.DatabaseName,
		AccountName:  accountName,
		Password:     password,
		ExtraConfig:  extraConfig,
		ConsoleURL:   resource.ConsoleURL,
		ConnectMode:  resource.ConnectMode,
	}, nil
}
