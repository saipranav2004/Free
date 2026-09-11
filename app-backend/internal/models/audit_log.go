// pam/internal/models/audit_log.go
//
// AuditLog is the single, unified, hash-chained audit trail. Two branches
// each built a complete audit system independently:
//
//   - Audit/Compliance branch: HTTP-request-shaped rows (OrgID, Category
//     enum, generic Resource path/ARN, Justification, HMAC-SHA256 chain via
//     pkg/auditchain), plus search/reporting/periodic-verification services
//     built around it.
//   - JIT branch: lifecycle-event-shaped rows (ActorType, Severity,
//     structured ResourceType/ResourceID/ResourceName, GrantID, plain
//     SHA-256 chain computed inline in its own audit_service.go).
//
// Rather than run two audit tables (which would split the tamper-evident
// trail and let an attacker's actions land in whichever chain is weaker),
// this is the reconciled superset: every field either branch's code sets is
// a first-class column, and pkg/auditchain (the HMAC-keyed implementation —
// strictly stronger than a keyless SHA-256 concatenation, since a reader
// with DB access alone cannot forge a valid entry) is the one chain
// implementation both branches' call sites end up going through. See
// services/audit_service.go for how both call shapes (Append/AppendNoCtx for
// the compliance branch, WriteTx/Write for the JIT branch) are served off
// one core.
package models

import (
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// ── Categories (Audit/Compliance branch's classification) ──────────────────

type AuditCategory string

const (
	AuditAuth         AuditCategory = "AUTH"
	AuditAuthz        AuditCategory = "AUTHZ"
	VaultAccess       AuditCategory = "VAULT"
	SessionLifecycle  AuditCategory = "SESSION"
	ResourceLifecycle AuditCategory = "RESOURCE"
	BreakGlass        AuditCategory = "BREAK_GLASS"
	JITAccess         AuditCategory = "JIT"
	AdminAction       AuditCategory = "ADMIN"
	ReportExport      AuditCategory = "REPORT"
	AuditOther        AuditCategory = "OTHER"
)

// ── Outcomes ─────────────────────────────────────────────────────────────
//
// Both branches' constant names are kept as aliases of the same type/values
// so neither branch's call sites (middleware/audit.go on one side,
// jit_service.go/session_handler.go/admin_handler.go on the other) need to
// change.

type AuditOutcome string

const (
	OutcomeSuccess AuditOutcome = "SUCCESS"
	OutcomeDenied  AuditOutcome = "DENIED"
	OutcomeError   AuditOutcome = "ERROR"
	OutcomePending AuditOutcome = "PENDING"

	// JIT-branch naming, same type, same/compatible values.
	AuditOutcomeSuccess AuditOutcome = "SUCCESS"
	AuditOutcomeFailure AuditOutcome = "FAILURE"
	AuditOutcomeDenied  AuditOutcome = "DENIED"
)

// ── Severities (JIT branch) ─────────────────────────────────────────────
//
// Plain strings (not a named type) because that is the shape the JIT
// branch's AuditEntry/AuditLog already used throughout jit_service.go.

const (
	AuditSeverityInfo     = "INFO"
	AuditSeverityWarn     = "WARN"
	AuditSeverityCritical = "CRITICAL"
)

// ── Canonical JIT/break-glass/session action names ──────────────────────
//
// Kept as constants so the IAM console and audit search can filter on
// stable strings instead of free text.

const (
	AuditJITRequested          = "JIT_REQUEST_CREATED"
	AuditJITApproved           = "JIT_REQUEST_APPROVED"
	AuditJITDenied             = "JIT_REQUEST_DENIED"
	AuditJITCancelled          = "JIT_REQUEST_CANCELLED"
	AuditJITExpired            = "JIT_REQUEST_EXPIRED"
	AuditGrantCreated          = "ACCESS_GRANT_CREATED"
	AuditGrantExpired          = "ACCESS_GRANT_EXPIRED"
	AuditGrantRevoked          = "ACCESS_GRANT_REVOKED"
	AuditGrantIAMSync          = "ACCESS_GRANT_IAM_SYNC"
	AuditBreakglassRequested   = "BREAKGLASS_REQUESTED"
	AuditBreakglassActivated   = "BREAKGLASS_ACTIVATED"
	AuditBreakglassReportBuilt = "BREAKGLASS_REPORT_GENERATED"
	AuditSessionStarted        = "SESSION_STARTED"
	AuditSessionEnded          = "SESSION_ENDED"
	AuditSessionKilled         = "SESSION_KILLED"
	AuditAuthzDenied           = "AUTHZ_DENIED"

	// Session-recording lifecycle (DAM — see internal/gateway/recording.go
	// and internal/recorder). AuditRecordingSaved fires once the finished
	// cast has actually been persisted to storage (SessionRecording ==
	// COMPLETED); AuditRecordingFailed fires when encoding or persisting it
	// failed (SessionRecording == FAILED) — a compliance-visibility gap for
	// an admin to notice, never a reason the underlying session was blocked.
	AuditRecordingSaved  = "RECORDING_SAVED"
	AuditRecordingFailed = "RECORDING_FAILED"

	// Data-protection enforcement (see models/data_protection.go and
	// internal/webproxy/dlp.go). Split by control because they are very
	// different signals to an investigator:
	//
	//   DOWNLOAD_BLOCKED / EGRESS_BUDGET_EXCEEDED are PREVENTION — PAM
	//   refused, server-side, and the data did not leave. DENIED outcome.
	//
	//   CLIPBOARD_BLOCKED is an ATTEMPT report from the operator's own
	//   browser. It is evidence of intent, NOT proof the copy was stopped:
	//   the control it reports is client-side friction that devtools
	//   defeats, and a suppressed report looks like no attempt at all.
	//   Treated as a signal to correlate with the session recording rather
	//   than as an enforcement record.
	//
	//   CONNECT_METHOD_DENIED fires when a resource's egress policy closed
	//   the connect path an operator tried to use.
	AuditDownloadBlocked      = "DOWNLOAD_BLOCKED"
	AuditEgressBudgetExceeded = "EGRESS_BUDGET_EXCEEDED"
	AuditClipboardBlocked     = "CLIPBOARD_BLOCKED"
	AuditConnectMethodDenied  = "CONNECT_METHOD_DENIED"

	//   DEVTOOLS_DETECTED is the same class of evidence as
	//   CLIPBOARD_BLOCKED: a report from the operator's own browser that
	//   the injected deterrent fired. It is intent, never prevention.
	AuditDevToolsDetected = "DEVTOOLS_DETECTED"

	// ── Perimeter (internal/middleware/network_allowlist.go) ──
	//
	// These fire BEFORE authentication, so they carry a source address and a
	// path but no user: refusing an unapproved network is precisely a decision
	// made without knowing who is calling. Both keep the AUTHZ_ prefix so
	// CategoryForAction files them under AUTHZ with the other access
	// decisions, which is where an investigator looks for them.
	//
	// NETWORK_BREAK_GLASS is an ALLOW, not a denial, and it is the one row in
	// this group that means someone got in. It is recorded at CRITICAL and
	// never throttled.
	AuditNetworkDenied     = "AUTHZ_NETWORK_DENIED"
	AuditNetworkBreakGlass = "AUTHZ_NETWORK_BREAK_GLASS"
)

// AuditLog is one immutable, hash-chained audit record — the superset of
// both branches' rows. SequenceNumber (not Seq) is kept as the ordering
// primary key name from the compliance branch since audit_query_service.go,
// audit_report_service.go and audit_verification_job.go all query by it;
// jit_service.go's one reference to `seq` (in BuildBreakglassReport's
// `Order("seq ASC")`) is updated to match (see services/jit_service.go).
type AuditLog struct {
	SequenceNumber int64  `gorm:"primaryKey;autoIncrement" json:"sequence_number"`
	ID             string `gorm:"type:varchar(36);not null;uniqueIndex" json:"id"`

	OrgID string `gorm:"type:varchar(36);not null;index:idx_audit_org_seq,priority:1" json:"org_id"`

	// Actor — who/what performed the action.
	UserID      string  `gorm:"type:varchar(36);index" json:"user_id"`
	Username    string  `gorm:"type:varchar(150)" json:"username"`
	Email       string  `gorm:"type:varchar(255)" json:"email"`
	ServiceName *string `gorm:"type:varchar(100)" json:"service_name,omitempty"`
	// ActorType: USER | SYSTEM | ADMIN (sweeper/system-originated rows set
	// SYSTEM; an action taken from the Admin Center by a root/admin user
	// sets ADMIN).
	ActorType string `gorm:"type:varchar(20);not null;default:'USER';index" json:"actor_type"`

	Category AuditCategory `gorm:"type:varchar(30);not null;index" json:"category"`
	Action   string        `gorm:"type:varchar(100);not null;index" json:"action"`
	Outcome  AuditOutcome  `gorm:"type:varchar(20);not null;default:'SUCCESS';index" json:"outcome"`
	// Severity: INFO | WARN | CRITICAL. CRITICAL is reserved for break-glass
	// events, grant revocations, and admin session kills.
	Severity string `gorm:"type:varchar(20);not null;default:'INFO';index" json:"severity"`

	// Resource — the compliance branch's generic path/ARN form (used by the
	// HTTP audit middleware, which only ever sees a request path).
	Resource string `gorm:"type:varchar(255);index" json:"resource"`
	// ResourceType/ResourceID/ResourceName — the JIT branch's structured form
	// (used by JIT/grant/session lifecycle events, which always know exactly
	// which resource they're about).
	ResourceType string `gorm:"type:varchar(50);index" json:"resource_type,omitempty"`
	ResourceID   string `gorm:"type:varchar(36);index" json:"resource_id,omitempty"`
	ResourceName string `gorm:"type:varchar(255)" json:"resource_name,omitempty"`

	Details       string `gorm:"type:text" json:"details"`
	Justification string `gorm:"type:text" json:"justification,omitempty"`

	SourceIP  string `gorm:"type:varchar(45);index" json:"source_ip"`
	UserAgent string `gorm:"type:varchar(512)" json:"user_agent"`
	RequestID string `gorm:"type:varchar(64);index" json:"request_id"`
	SessionID string `gorm:"type:varchar(64);index" json:"session_id"`
	// GrantID correlates rows to a specific JIT access grant.
	GrantID string `gorm:"type:varchar(64);index" json:"grant_id,omitempty"`

	AuthzDecisionID string `gorm:"type:varchar(64);index" json:"authz_decision_id,omitempty"`

	PrevHash    string `gorm:"type:varchar(64);not null" json:"prev_hash"`
	EntryHash   string `gorm:"type:varchar(64);not null" json:"entry_hash"`
	HashVersion int    `gorm:"type:integer;not null;default:1" json:"hash_version"`

	OccurredAt time.Time `gorm:"not null;index:idx_audit_org_time,priority:2" json:"occurred_at"`
	CreatedAt  time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (AuditLog) TableName() string {
	schema := os.Getenv("PAM_DATABASE_SCHEMA")

	return schema + ".pam_audit_log"
}

func (a *AuditLog) BeforeCreate(tx *gorm.DB) error {
	if a.OrgID == "" {
		a.OrgID = "default"
	}
	if a.OccurredAt.IsZero() {
		a.OccurredAt = time.Now().UTC()
	}
	if a.ActorType == "" {
		a.ActorType = "USER"
	}
	if a.Severity == "" {
		a.Severity = AuditSeverityInfo
	}
	if a.Outcome == "" {
		a.Outcome = OutcomeSuccess
	}
	if a.Category == "" {
		a.Category = deriveCategory(a.Action)
	}
	if a.ID == "" {
		a.ID = uuid.NewString()
	}
	return nil
}

// deriveCategory infers a Category for rows that only set Action (i.e. every
// JIT/grant/session lifecycle write), so audit search/reporting can still
// filter meaningfully by category even though jit_service.go never sets it
// explicitly.
func deriveCategory(action string) AuditCategory {
	switch {
	case strings.HasPrefix(action, "BREAKGLASS_"):
		return BreakGlass
	case strings.HasPrefix(action, "JIT_") || strings.HasPrefix(action, "ACCESS_GRANT"):
		return JITAccess
	case strings.HasPrefix(action, "SESSION_"):
		return SessionLifecycle
	case strings.HasPrefix(action, "AUTHZ"):
		return AuditAuthz
	case action == AuditDownloadBlocked, action == AuditEgressBudgetExceeded,
		action == AuditClipboardBlocked, action == AuditConnectMethodDenied,
		action == AuditDevToolsDetected:
		// Data-protection enforcement is session-scoped evidence; without
		// this it would fall through to OTHER and drop out of every
		// session-filtered audit query an investigator actually runs.
		return SessionLifecycle
	default:
		return AuditOther
	}
}
