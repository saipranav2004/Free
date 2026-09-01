// pam/internal/models/vault.go
//
// Credential is the enterprise envelope-encrypted vault entry (Safes/Folders
// hierarchy, Features 10/13/14). `VaultEntry` is kept as a backward-compatible
// alias since services/resource_service.go (the legacy per-resource
// credential path) and services/jit_service.go (break-glass eligibility)
// both refer to `models.VaultEntry`.
//
// IsBreakglass/BreakglassNote were added here (JIT branch) rather than on a
// second, separate "VaultEntry" struct: the JIT branch's own dump defined a
// simpler, parallel VaultEntry type pointed at a different table
// (pam_vault_entries). That would have split credential storage across two
// tables. Since VaultEntry is already a type alias for Credential in the
// base branch, the break-glass flag belongs here instead, so
// hasBreakglassCredential's `WHERE resource_id = ? AND is_breakglass = ?`
// query (services/jit_service.go) operates on the same table every other
// vault operation uses (pam_credentials).
package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type CredentialType string

const (
	CredentialTypePassword         CredentialType = "password"
	CredentialTypeSSHKey           CredentialType = "ssh_key"
	CredentialTypeX509Cert         CredentialType = "x509_cert"
	CredentialTypeAPIKey           CredentialType = "api_key"
	CredentialTypeToken            CredentialType = "token"
	CredentialTypeConnectionString CredentialType = "connection_string"
	CredentialTypeKeytab           CredentialType = "kerberos_keytab"
)

func IsValidCredentialType(ct string) bool {
	switch CredentialType(ct) {
	case CredentialTypePassword, CredentialTypeSSHKey, CredentialTypeX509Cert,
		CredentialTypeAPIKey, CredentialTypeToken, CredentialTypeConnectionString,
		CredentialTypeKeytab:
		return true
	default:
		return false
	}
}

// Credential represents an envelope-encrypted privileged credential in a Safe.
type Credential struct {
	ID             string  `gorm:"primaryKey;type:varchar(36)" json:"id"`
	SafeID         string  `gorm:"type:varchar(36);default:'default';index" json:"safe_id"`
	FolderID       *string `gorm:"type:varchar(36);index" json:"folder_id,omitempty"`
	ResourceID     string  `gorm:"type:varchar(36);index" json:"resource_id,omitempty"`
	Name           string  `gorm:"type:varchar(255);default:'Unnamed';index" json:"name"`
	Description    string  `gorm:"type:text" json:"description,omitempty"`
	AccountName    string  `gorm:"type:varchar(255);default:'Unnamed';index" json:"account_name"`
	CredentialType string  `gorm:"type:varchar(50);not null;default:'password'" json:"credential_type"`

	// AES-256-GCM envelope-encrypted secret. NEVER expose through JSON.
	CredentialEnc string `gorm:"type:text;not null" json:"-"`

	// IsBreakglass marks this credential as an emergency ("break-glass") account.
	// A resource is break-glass eligible only if it has such a credential.
	// Using it skips the human approver but incurs a mandatory waiting period,
	// a CRITICAL alert, forced session recording and an auto-generated report.
	IsBreakglass bool `gorm:"column:is_breakglass;not null;default:false;index" json:"is_breakglass"`

	// BreakglassNote is operator context shown in the emergency-access report.
	BreakglassNote string `gorm:"column:breakglass_note;type:text" json:"breakglass_note,omitempty"`

	MetadataJSON string `gorm:"type:text" json:"metadata_json,omitempty"`
	Status       string `gorm:"type:varchar(30);default:'active';index" json:"status"`
	Version      int    `gorm:"default:1" json:"version"`

	LastRotatedAt        *time.Time `json:"last_rotated_at,omitempty"`
	NextRotationAt       *time.Time `json:"next_rotation_at,omitempty"`
	RotationIntervalDays int        `gorm:"default:0" json:"rotation_interval_days"`

	CreatedBy string         `gorm:"type:varchar(36)" json:"created_by,omitempty"`
	UpdatedBy string         `gorm:"type:varchar(36)" json:"updated_by,omitempty"`
	CreatedAt time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Credential) TableName() string { return "pam_credentials" }

// EncryptionAAD returns the additional-authenticated-data binding for this
// credential's envelope.
//
// ONE METHOD, NOT FOUR COPIES, and that is the whole point. Encrypt and
// decrypt must derive the AAD from exactly the same trusted columns. When they
// are hand-built at each call site they drift, and the drift is invisible
// until somebody tries to read an old row: the GCM tag check fails and the
// credential is permanently undecryptable. The classic way in is SafeID, which
// carries a GORM column default: GORM omits an empty string from the INSERT
// and Postgres fills in 'default', so a caller that encrypted with no safe_id
// decrypts against one that has it.
//
// It is also the control that stops a ciphertext being moved between rows by
// anyone with database write access. A blob re-pointed at a different account,
// safe or resource fails the tag check instead of quietly decrypting for the
// wrong principal.
//
// Callers pass this explicitly. Passing nil to EnvelopeDecryptor makes it fall
// back to the AAD stored inside the envelope, which is attacker-controlled in
// exactly the scenario the binding exists to defend against.
func (v *Credential) EncryptionAAD() map[string]string {
	aad := map[string]string{"account": v.AccountName}
	if v.SafeID != "" {
		aad["safe_id"] = v.SafeID
	}
	if v.ResourceID != "" {
		aad["resource_id"] = v.ResourceID
	}
	return aad
}

func (v *Credential) BeforeCreate(tx *gorm.DB) error {
	if v.ID == "" {
		v.ID = uuid.NewString()
	}
	if v.Version == 0 {
		v.Version = 1
	}
	if v.Status == "" {
		v.Status = "active"
	}
	if v.Name == "" {
		v.Name = v.AccountName
	}
	return nil
}

// CredentialVersion stores an immutable history record of a credential's secret over time.
type CredentialVersion struct {
	ID            string    `gorm:"primaryKey;type:varchar(36)" json:"id"`
	CredentialID  string    `gorm:"type:varchar(36);not null;index" json:"credential_id"`
	Version       int       `gorm:"not null" json:"version"`
	CredentialEnc string    `gorm:"type:text;not null" json:"-"`
	Reason        string    `gorm:"type:text" json:"reason,omitempty"`
	CreatedBy     string    `gorm:"type:varchar(150)" json:"created_by"`
	CreatedAt     time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (CredentialVersion) TableName() string { return "pam_credential_versions" }

func (v *CredentialVersion) BeforeCreate(tx *gorm.DB) error {
	if v.ID == "" {
		v.ID = uuid.NewString()
	}
	return nil
}

// VaultEntry is a backward-compatible type alias for Credential.
type VaultEntry = Credential
