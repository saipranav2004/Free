// pam/internal/models/resource.go
//
// Merged: base PAMResource/ConnectionSession (Vault & Rotation branch) +
// authz-decision correlation fields (Audit/Compliance branch) + JIT
// gating/break-glass/grant-linkage fields (JIT branch).
//
// NOTE: the encrypted-credential model lives in vault.go as `Credential`
// (table pam_credentials), aliased as `VaultEntry` for backward
// compatibility. It is intentionally NOT redefined here — see vault.go.
package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// PAMResource is a target system that PAM can manage or connect to.
// Examples: PostgreSQL, MongoDB, Redis, MinIO, web application, etc.
type PAMResource struct {
	ID string `gorm:"primaryKey;type:varchar(36)" json:"id"`

	Name         string `gorm:"type:varchar(255);not null;index" json:"name"`
	Description  string `gorm:"type:text" json:"description"`
	ResourceType string `gorm:"type:varchar(50);not null;index" json:"resource_type"`

	Host         string `gorm:"type:varchar(255);not null" json:"host"`
	Port         int    `gorm:"not null" json:"port"`
	DatabaseName string `gorm:"type:varchar(255)" json:"database_name,omitempty"`

	// web_terminal or embed_redirect
	ConnectMode string `gorm:"type:varchar(50);default:'web_terminal'" json:"connect_mode"`

	// Optional external console URL, for example a MinIO or Metabase console.
	ConsoleURL string `gorm:"type:text" json:"console_url,omitempty"`

	// JSON stored as text, containing protocol-specific configuration.
	ExtraConfig string `gorm:"type:text" json:"extra_config,omitempty"`

	// Points to the currently active encrypted vault credential.
	VaultEntryID *string `gorm:"type:varchar(36);index" json:"vault_entry_id,omitempty"`

	// RequiresJIT gates the resource behind a Just-In-Time access grant.
	// When true, PAM's RequireActiveGrant PEP rejects any connect attempt that
	// is not covered by an ACTIVE, unexpired pam_access_grants row.
	// Default false keeps every pre-existing resource behaving exactly as before.
	RequiresJIT bool `gorm:"column:requires_jit;not null;default:false;index" json:"requires_jit"`

	// AlwaysRecord forces a recording obligation on every session for this
	// resource, independent of the grant (break-glass always forces it too).
	AlwaysRecord bool `gorm:"column:always_record;not null;default:false" json:"always_record"`

	// ── Data-protection policy (see data_protection.go) ──
	//
	// Egress controls, as opposed to access controls. Every one defaults to
	// off/unlimited so existing resources are unaffected by the migration
	// that adds them.

	// BlockClipboard / BlockDownload / Watermark / MaxEgressBytes are the
	// per-resource baseline; a grant may tighten but never loosen them.
	BlockClipboard bool   `gorm:"column:block_clipboard;not null;default:false" json:"block_clipboard"`
	BlockDevTools  bool   `gorm:"column:block_devtools;not null;default:false" json:"block_devtools"`
	BlockDownload  bool   `gorm:"column:block_download;not null;default:false" json:"block_download"`
	Watermark      bool   `gorm:"column:watermark;not null;default:false" json:"watermark"`
	MaxEgressBytes int64  `gorm:"column:max_egress_bytes;not null;default:0" json:"max_egress_bytes"`
	DeniedCommands string `gorm:"column:denied_commands;type:text" json:"denied_commands,omitempty"`

	// AllowedConnectMethods is a comma-separated allow-list drawn from
	// ConnectMethod* ("web_terminal,web_proxy,agent"). Empty permits all.
	//
	// This is the field that decides whether the controls above are real.
	// PAM proxies the two brokered paths and can enforce on them; the native
	// agent gets the credential and talks straight to the target, so nothing
	// server-side binds it. A resource that must be egress-controlled has to
	// exclude "agent" here — see models.EgressControlled.
	AllowedConnectMethods string `gorm:"column:allowed_connect_methods;type:varchar(255)" json:"allowed_connect_methods,omitempty"`

	IsActive  bool   `gorm:"default:true;index" json:"is_active"`
	CreatedBy string `gorm:"type:varchar(36);not null;index" json:"created_by"`

	CreatedAt time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

func (PAMResource) TableName() string {
	return "pam_resources"
}

func (r *PAMResource) BeforeCreate(tx *gorm.DB) error {
	if r.ID == "" {
		r.ID = uuid.NewString()
	}
	return nil
}

// ResourceGroup is a response-only structure used to group resources
// by their ResourceType in the PAM UI. It is not a database table.
type ResourceGroup struct {
	Name      string        `json:"name"`
	Icon      string        `json:"icon"`
	Resources []PAMResource `json:"resources"`
}

// ConnectionSession stores PAM connection-session metadata.
// It does not itself create SSH/RDP/database connections.
type ConnectionSession struct {
	ID string `gorm:"primaryKey;type:varchar(36)" json:"id"`

	UserID   string `gorm:"type:varchar(36);not null;index" json:"user_id"`
	Username string `gorm:"type:varchar(150);not null" json:"username"`

	ResourceID   string `gorm:"type:varchar(36);not null;index" json:"resource_id"`
	ResourceName string `gorm:"type:varchar(255);not null" json:"resource_name"`
	ResourceType string `gorm:"type:varchar(50);not null;index" json:"resource_type"`

	Protocol string `gorm:"type:varchar(50)" json:"protocol"`
	SourceIP string `gorm:"type:varchar(45)" json:"source_ip"`

	// ACTIVE | COMPLETED | KILLED | FAILED
	Status string `gorm:"type:varchar(20);not null;default:'ACTIVE';index" json:"status"`

	StartedAt       time.Time  `gorm:"autoCreateTime;index" json:"started_at"`
	EndedAt         *time.Time `json:"ended_at,omitempty"`
	DurationSeconds int        `gorm:"default:0" json:"duration_seconds"`

	// Grant linkage — set when the session was opened under a JIT grant.
	// The auto-revoke sweeper uses this to find and kill live sessions when the
	// grant expires or is revoked.
	GrantID      *string `gorm:"column:grant_id;type:varchar(36);index" json:"grant_id,omitempty"`
	JITRequestID *string `gorm:"column:jit_request_id;type:varchar(36);index" json:"jit_request_id,omitempty"`

	IsBreakglass      bool    `gorm:"column:is_breakglass;not null;default:false;index" json:"is_breakglass"`
	RecordingRequired bool    `gorm:"column:recording_required;not null;default:false" json:"recording_required"`
	RecordingID       *string `gorm:"column:recording_id;type:varchar(36);index" json:"recording_id,omitempty"`

	KillReason      string  `gorm:"type:text" json:"kill_reason,omitempty"`
	KilledBy        string  `gorm:"type:varchar(36)" json:"killed_by,omitempty"`
	AuthzDecisionID *string `gorm:"type:varchar(255);index" json:"authz_decision_id,omitempty"`
	AuthzAllowed    *bool   `json:"authz_allowed,omitempty"`

	CreatedAt time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

func (ConnectionSession) TableName() string {
	return "pam_connection_sessions"
}

func (s *ConnectionSession) BeforeCreate(tx *gorm.DB) error {
	if s.ID == "" {
		s.ID = uuid.NewString()
	}
	return nil
}

// DataProtectionProfile is the resource's egress baseline, before any
// grant-level tightening.
func (r PAMResource) DataProtectionProfile() DataProtection {
	return DataProtection{
		BlockClipboard: r.BlockClipboard,
		BlockDevTools:  r.BlockDevTools,
		BlockDownload:  r.BlockDownload,
		Watermark:      r.Watermark,
		MaxEgressBytes: r.MaxEgressBytes,
		DeniedCommands: r.DeniedCommands,
	}
}

// AllowsConnectMethod reports whether this resource may be opened by the
// given connect method.
func (r PAMResource) AllowsConnectMethod(method string) bool {
	return ConnectMethodAllowed(r.AllowedConnectMethods, method)
}
