// pam/internal/models/web_proxy_session.go
//
// WebProxySession is one brokered web-application session — the "open in
// browser, already logged in" path (see internal/webproxy).
//
// The security model in one sentence: the TARGET application's own session
// (its cookies, or an injected auth header) is established server-to-server
// by PAM and stored here encrypted, so it never reaches the browser — the
// browser only ever holds the opaque TokenHash below, which is worthless
// anywhere except against this PAM instance, expires on its own schedule,
// and can be revoked centrally.
//
// This is the property that distinguishes a real brokered session from
// "auto-fill the login form for the operator": an operator with devtools
// open can extract nothing reusable, and revoking their PAM grant cuts
// their access to the target immediately rather than whenever the target's
// own session happens to expire.
package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

const (
	WebProxySessionActive  = "ACTIVE"
	WebProxySessionExpired = "EXPIRED"
	WebProxySessionRevoked = "REVOKED"
	WebProxySessionEnded   = "ENDED"
)

type WebProxySession struct {
	ID string `gorm:"primaryKey;type:varchar(36)" json:"id"`

	// ConnectionSessionID ties this to the same pam_connection_sessions row
	// every other connection method creates (see
	// ResourceService.StartTrackedSession), so a brokered web session shows
	// up in the org-wide session list, counts toward "active sessions", and
	// is killable by the same admin action as a terminal or native-agent
	// session — one session model, not a second parallel one.
	ConnectionSessionID string `gorm:"type:varchar(36);not null;index" json:"connection_session_id"`

	ResourceID string `gorm:"type:varchar(36);not null;index" json:"resource_id"`
	UserID     string `gorm:"type:varchar(36);not null;index" json:"user_id"`
	Username   string `gorm:"type:varchar(150)" json:"username"`

	// Subdomain is the host label this session's app is served under
	// ("<Subdomain>.<webproxy.base_domain>"). Derived from the resource, so
	// it is stable and human-readable in logs/history.
	Subdomain string `gorm:"type:varchar(120);not null;index" json:"subdomain"`

	// TokenHash is the SHA-256 of the opaque proxy-session token held in the
	// browser's cookie. Hashed, not stored raw, for the same reason vault
	// credentials and agent launch tokens are: a database read must not yield
	// anything replayable. See internal/webproxy's hashToken.
	TokenHash string `gorm:"type:varchar(64);not null;uniqueIndex" json:"-"`

	// HandoffHash is the SHA-256 of the single-use token that converts an
	// authenticated PAM API call into a cookie on the app's own subdomain.
	// Cleared (set empty) the instant it is consumed, so a token captured
	// from a browser-history entry or a proxy log is useless afterward.
	HandoffHash    string     `gorm:"type:varchar(64);index" json:"-"`
	HandoffUsedAt  *time.Time `json:"handoff_used_at,omitempty"`
	HandoffExpires time.Time  `gorm:"not null" json:"handoff_expires"`

	// UpstreamStateEnc is the AES-256-GCM encrypted, JSON-encoded upstream
	// authentication state (captured cookie jar + any injected auth headers)
	// — see webproxy.UpstreamState. Encrypted with the same
	// PAM_VAULT_ENCRYPTION_KEY as vault credentials, because that is exactly
	// what it is: a live credential for the target system.
	UpstreamStateEnc string `gorm:"type:text" json:"-"`

	// AuthStrategy records which authenticator established the upstream
	// session (see webproxy/authenticator.go) — useful when diagnosing why a
	// particular app's brokered login behaves differently from another's.
	AuthStrategy string `gorm:"type:varchar(50)" json:"auth_strategy"`

	// ACTIVE | EXPIRED | REVOKED | ENDED
	Status string `gorm:"type:varchar(20);not null;default:'ACTIVE';index" json:"status"`

	// RevokeReason explains a non-ACTIVE status an admin or the sweeper set
	// (grant revoked, killed by admin, idle timeout, ...).
	RevokeReason string `gorm:"type:text" json:"revoke_reason,omitempty"`

	// Grant linkage, mirroring ConnectionSession's own fields — this is what
	// lets a JIT grant revoke/expiry cascade into killing live brokered web
	// sessions, not just terminal ones.
	GrantID      *string `gorm:"type:varchar(36);index" json:"grant_id,omitempty"`
	JITRequestID *string `gorm:"type:varchar(36);index" json:"jit_request_id,omitempty"`
	IsBreakglass bool    `gorm:"not null;default:false;index" json:"is_breakglass"`

	// RecordingID points at the SAME pam_session_recordings row a CLI or
	// native-agent session uses — brokered web sessions deliberately do not
	// get a parallel recording model. The artifact is an asciicast in the
	// same object store, listed by the same GET /admin/recordings, replayed
	// by the same player, and its command log lives in the same
	// pam_session_recording_commands table. Copied onto this row (rather
	// than only read through ConnectionSession) so the teardown path can
	// finalize the recording from the one row it already loaded.
	RecordingID *string `gorm:"type:varchar(36);index" json:"recording_id,omitempty"`

	SourceIP  string `gorm:"type:varchar(45)" json:"source_ip,omitempty"`
	UserAgent string `gorm:"type:text" json:"user_agent,omitempty"`

	// RequestCount/LastActivityAt drive the idle timeout and give an admin a
	// cheap "is anyone actually using this" signal without scanning the
	// per-request activity log.
	// ── Data-protection policy, snapshotted at session start ──
	//
	// Resolved once from resource ∪ grant (models.MostRestrictive) and stored
	// here rather than recomputed per request, for two reasons: a grant
	// expiring mid-session must not silently relax the controls the session
	// was opened under, and per-request enforcement must not repeat a grant
	// lookup thousands of times.
	BlockClipboard bool  `gorm:"column:block_clipboard;not null;default:false" json:"block_clipboard"`
	BlockDevTools  bool  `gorm:"column:block_devtools;not null;default:false" json:"block_devtools"`
	BlockDownload  bool  `gorm:"column:block_download;not null;default:false" json:"block_download"`
	Watermark      bool  `gorm:"column:watermark;not null;default:false" json:"watermark"`
	MaxEgressBytes int64 `gorm:"column:max_egress_bytes;not null;default:0" json:"max_egress_bytes"`

	// EgressBytes is the running total of proxied response bytes, the
	// quantity MaxEgressBytes bounds. Persisted rather than held in memory so
	// the budget survives a restart and cannot be reset by reconnecting.
	EgressBytes int64 `gorm:"column:egress_bytes;not null;default:0" json:"egress_bytes"`

	RequestCount   int64     `gorm:"not null;default:0" json:"request_count"`
	LastActivityAt time.Time `gorm:"not null;index" json:"last_activity_at"`

	// LastHeartbeatAt is what makes "the operator closed the tab" detectable
	// at all, despite HTTP having no persistent connection to watch for EOF
	// the way the WebSocket-based terminal or a native-agent process does. A
	// tiny script injected into every proxied HTML response (see
	// webproxy/proxy.go's injectHeartbeat) pings back on an interval for as
	// long as the tab is open; the sweeper (ReconcileExpired) treats a
	// session whose heartbeat has gone stale past the grace period as ended,
	// same as it already does for idle timeout and absolute expiry. Nil until
	// the first heartbeat arrives — a session whose target never served an
	// HTML page (a pure JSON API, say) never gets one, and correctly falls
	// back to idle-timeout/expiry-only teardown instead of being killed for
	// a heartbeat it was never going to send.
	LastHeartbeatAt *time.Time `json:"last_heartbeat_at,omitempty"`

	ExpiresAt time.Time  `gorm:"not null;index" json:"expires_at"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`

	CreatedAt time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

func (WebProxySession) TableName() string { return "pam_web_proxy_sessions" }

func (s *WebProxySession) BeforeCreate(tx *gorm.DB) error {
	if s.ID == "" {
		s.ID = uuid.NewString()
	}
	return nil
}

// IsUsable reports whether this session may still broker requests right now.
// Checked on every proxied request (never cached), so a revoke takes effect
// on the very next one — the same "read entitlement fresh every time"
// posture middleware.RequireActiveGrant takes for JIT grants.
func (s *WebProxySession) IsUsable(now time.Time, idleTimeout time.Duration) bool {
	if s.Status != WebProxySessionActive {
		return false
	}
	if now.After(s.ExpiresAt) {
		return false
	}
	if idleTimeout > 0 && now.Sub(s.LastActivityAt) > idleTimeout {
		return false
	}
	return true
}

// WebProxyActivity is one proxied HTTP request — the searchable audit trail
// for a brokered web session, and the web-app counterpart to
// SessionRecordingCommand (which serves the same role for terminal
// sessions). "Who did what inside the MinIO console last Tuesday" is a SQL
// query against this table.
//
// Deliberately NOT a body capture: request/response bodies through an admin
// console routinely carry secrets, bulk data, and multi-megabyte uploads.
// Method/path/status/size/duration answers the compliance question ("what
// did they touch, when, did it succeed") without creating a second, larger
// place for the data itself to leak.
type WebProxyActivity struct {
	ID string `gorm:"primaryKey;type:varchar(36)" json:"id"`

	WebProxySessionID   string `gorm:"type:varchar(36);not null;index" json:"web_proxy_session_id"`
	ConnectionSessionID string `gorm:"type:varchar(36);not null;index" json:"connection_session_id"`
	ResourceID          string `gorm:"type:varchar(36);not null;index" json:"resource_id"`
	UserID              string `gorm:"type:varchar(36);not null;index" json:"user_id"`

	Sequence int `gorm:"not null" json:"sequence"`

	Method string `gorm:"type:varchar(10);not null" json:"method"`
	// Path is the request path with its query string stripped — query
	// strings frequently carry tokens/filters that are either sensitive or
	// pure noise for an audit reader.
	Path string `gorm:"type:varchar(2048);not null" json:"path"`

	StatusCode        int   `gorm:"not null" json:"status_code"`
	RequestBodyBytes  int64 `gorm:"default:0" json:"request_body_bytes"`
	ResponseBodyBytes int64 `gorm:"default:0" json:"response_body_bytes"`
	DurationMs        int64 `gorm:"default:0" json:"duration_ms"`

	// IsMutation marks a request that can change target state (anything but
	// GET/HEAD/OPTIONS). Lets an auditor filter the interesting minority out
	// of the overwhelming majority of asset/polling GETs a modern SPA emits.
	IsMutation bool `gorm:"not null;default:false;index" json:"is_mutation"`

	SourceIP   string    `gorm:"type:varchar(45)" json:"source_ip,omitempty"`
	OccurredAt time.Time `gorm:"not null;index" json:"occurred_at"`
	CreatedAt  time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (WebProxyActivity) TableName() string { return "pam_web_proxy_activity" }

func (a *WebProxyActivity) BeforeCreate(tx *gorm.DB) error {
	if a.ID == "" {
		a.ID = uuid.NewString()
	}
	return nil
}

// DataProtection is the policy this session was opened under.
func (s WebProxySession) DataProtection() DataProtection {
	return DataProtection{
		BlockClipboard: s.BlockClipboard,
		BlockDevTools:  s.BlockDevTools,
		BlockDownload:  s.BlockDownload,
		Watermark:      s.Watermark,
		MaxEgressBytes: s.MaxEgressBytes,
	}
}

// EgressBudgetExhausted reports whether this session has already pulled as
// much as its policy allows.
//
// Checked BEFORE forwarding a request rather than mid-stream: cutting a
// response in half would hand the operator a corrupt file and tell the target
// application nothing useful, whereas refusing the next request is a clean,
// explainable stop. The cost is that the budget may be overshot by at most
// one response, which is why MaxEgressBytes is a bulk-egress bound and not an
// exact byte quota.
func (s WebProxySession) EgressBudgetExhausted() bool {
	return s.MaxEgressBytes > 0 && s.EgressBytes >= s.MaxEgressBytes
}
