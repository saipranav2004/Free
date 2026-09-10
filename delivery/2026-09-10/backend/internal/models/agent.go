// pam/internal/models/agent.go
//
// The Local Agent feature — lets a paired desktop/CLI agent (`pam-agent`)
// pop open a real native client (psql/redis-cli/mongosh, or an installed
// GUI tool) already connected, instead of the in-browser tracked-session
// path. This was built and independently verified in an earlier round
// against a pre-Admin-Center snapshot of this backend, and was missed when
// this module was reconstructed for the Admin Center merge — restoring it
// here, unchanged in its trust model, adapted only where the surrounding
// session/grant model has since grown richer (see agent_service.go's
// comments on StartTrackedSession).
package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// AgentDevice is one installation of the local PAM agent, paired to exactly
// one PAM user. Pairing happens once per machine (see AgentPairingCode);
// after that, the agent authenticates every request with an Ed25519
// signature over its stored private key — PAM only ever holds the public
// half, so a compromised backend can never impersonate an agent.
type AgentDevice struct {
	ID         string `gorm:"primaryKey;type:varchar(36)" json:"id"`
	UserID     string `gorm:"type:varchar(36);not null;index" json:"user_id"`
	DeviceName string `gorm:"type:varchar(255);not null" json:"device_name"`

	// Base64-encoded raw 32-byte Ed25519 public key. The matching private
	// key never leaves the user's machine.
	PublicKey string `gorm:"type:varchar(255);not null" json:"-"`

	// ACTIVE | REVOKED
	Status     string     `gorm:"type:varchar(20);not null;default:'ACTIVE';index" json:"status"`
	LastSeenAt *time.Time `json:"last_seen_at,omitempty"`

	CreatedAt time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

func (AgentDevice) TableName() string { return "pam_agent_devices" }

func (d *AgentDevice) BeforeCreate(tx *gorm.DB) error {
	if d.ID == "" {
		d.ID = uuid.NewString()
	}
	return nil
}

// AgentPairingCode is the short, human-typed, single-use code that bootstraps
// trust between a fresh agent install and a PAM account — the ONLY secret
// exchanged out-of-band. It is stored hashed, exactly like vault credentials.
type AgentPairingCode struct {
	ID     string `gorm:"primaryKey;type:varchar(36)" json:"id"`
	UserID string `gorm:"type:varchar(36);not null;index" json:"user_id"`

	// SHA-256 hex digest of the code the user actually typed. Never store
	// the plaintext code.
	CodeHash string `gorm:"type:varchar(64);not null;index" json:"-"`

	// PENDING | CONSUMED | EXPIRED
	Status    string    `gorm:"type:varchar(20);not null;default:'PENDING'" json:"status"`
	ExpiresAt time.Time `gorm:"not null" json:"expires_at"`

	CreatedAt  time.Time  `gorm:"autoCreateTime" json:"created_at"`
	ConsumedAt *time.Time `json:"consumed_at,omitempty"`
}

func (AgentPairingCode) TableName() string { return "pam_agent_pairing_codes" }

func (c *AgentPairingCode) BeforeCreate(tx *gorm.DB) error {
	if c.ID == "" {
		c.ID = uuid.NewString()
	}
	return nil
}

// LaunchToken is a short-lived, single-use handoff between "user clicked
// Open in Desktop App in the browser" and "the local agent redeemed it for
// a real, decrypted credential." It never carries the credential itself —
// only a hash of an opaque random value is stored, exactly like vault
// credentials and pairing codes.
//
// GrantID/JITRequestID/IsBreakglass/RecordingRequired are new versus the
// original build of this feature: at the time this token is issued (inside
// the authenticated request, right after middleware.RequireActiveGrant has
// already resolved the grant for this resource+user), that grant context is
// available on the gin.Context. By the time the agent redeems the token
// (ResolveLaunchToken), there is no gin.Context or middleware chain at
// all — the agent is a bare signed POST. So the grant context has to be
// captured into the token row itself at issuance time, or the resulting
// tracked session would silently lose its grant binding (breaking
// cascading auto-revoke) and its recording obligation for any JIT-gated or
// always-record resource launched natively. See agent_handler.go's
// CreateLaunch and agent_service.go's CreateLaunchToken/ResolveLaunchToken.
type LaunchToken struct {
	ID string `gorm:"primaryKey;type:varchar(36)" json:"id"`

	// SHA-256 hex digest of the raw token embedded in the pam-agent:// URL.
	TokenHash string `gorm:"type:varchar(64);not null;uniqueIndex" json:"-"`

	ResourceID string `gorm:"type:varchar(36);not null;index" json:"resource_id"`
	UserID     string `gorm:"type:varchar(36);not null;index" json:"user_id"`

	// Set once an agent successfully redeems the token.
	AgentDeviceID *string `gorm:"type:varchar(36)" json:"agent_device_id,omitempty"`

	// PENDING | CONSUMED | EXPIRED | REVOKED
	Status    string    `gorm:"type:varchar(20);not null;default:'PENDING';index" json:"status"`
	ExpiresAt time.Time `gorm:"not null" json:"expires_at"`

	AuthzDecisionID *string `gorm:"type:varchar(255)" json:"authz_decision_id,omitempty"`

	// Grant context, captured at issuance — see doc comment above.
	GrantID           *string `gorm:"type:varchar(36)" json:"grant_id,omitempty"`
	JITRequestID      *string `gorm:"type:varchar(36)" json:"jit_request_id,omitempty"`
	IsBreakglass      bool    `gorm:"default:false" json:"is_breakglass"`
	RecordingRequired bool    `gorm:"default:false" json:"recording_required"`

	// ── What actually happened after the agent took the handoff ──────────
	//
	// The browser that starts a launch had no way to learn its outcome. It
	// navigates to a pam-agent:// URL and that was the end of its
	// involvement: whether the agent opened psql, could not find psql, or was
	// never installed at all, the console showed the same nothing. Every
	// failure the agent knew about went to the stderr of a process the OS
	// started with no terminal attached, so it went nowhere.
	//
	// These columns are that missing return path. The agent already reports
	// the session end over its signed channel; carrying the reason on the
	// same call, and recording it here against the launch the browser still
	// holds an id for, is what lets the console say "mongosh is not installed
	// on this machine" instead of staying silent.
	//
	// They are written by the agent and read by the operator who started the
	// launch, so nothing secret may go in them. The agent's LaunchFailure doc
	// comment states that rule at the point of authorship;
	// AgentService.EndLaunchSession bounds their length on arrival.

	// SessionID is the tracked session ResolveLaunchToken created, and is
	// what ties an end-of-session report back to the launch that started it.
	SessionID *string `gorm:"type:varchar(36);index" json:"session_id,omitempty"`

	// Outcome is the LAUNCH's lifecycle, deliberately separate from Status,
	// which tracks the TOKEN (PENDING, CONSUMED, EXPIRED, REVOKED). A token
	// can be CONSUMED while the launch it authorised went on to fail.
	//
	//	""        the agent has not redeemed this yet
	//	OPENED    the agent redeemed it and a session was created
	//	COMPLETED the tool ran and exited
	//	FAILED    the launch could not proceed, or the tool failed
	Outcome string `gorm:"type:varchar(20);index" json:"outcome,omitempty"`

	// FailureCode is a stable identifier the console branches on rather than
	// parsing English: tool_not_installed, no_launch_candidates,
	// recording_not_possible, tool_exited_nonzero, launch_failed.
	FailureCode string `gorm:"type:varchar(64)" json:"failure_code,omitempty"`

	// FailureReason states what went wrong, in one sentence, for the operator.
	FailureReason string `gorm:"type:text" json:"failure_reason,omitempty"`

	// FailureHint is the actionable half: which tool to install, and how.
	FailureHint string `gorm:"type:text" json:"failure_hint,omitempty"`

	CreatedAt  time.Time  `gorm:"autoCreateTime" json:"created_at"`
	ConsumedAt *time.Time `json:"consumed_at,omitempty"`
	ResolvedAt *time.Time `json:"resolved_at,omitempty"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
}

func (LaunchToken) TableName() string { return "pam_launch_tokens" }

func (t *LaunchToken) BeforeCreate(tx *gorm.DB) error {
	if t.ID == "" {
		t.ID = uuid.NewString()
	}
	return nil
}
