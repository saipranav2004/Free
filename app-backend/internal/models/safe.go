// pam/internal/models/safe.go
package models

import (
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Safe represents a top-level security container in the PAM Vault hierarchy.
// Each safe maps directly to an IAM Policy resource ARN: pam:safe/{name}.
type Safe struct {
	ID            string         `gorm:"primaryKey;type:varchar(36)" json:"id"`
	Name          string         `gorm:"type:varchar(255);not null;uniqueIndex" json:"name"`
	Description   string         `gorm:"type:text" json:"description,omitempty"`
	OwnerID       string         `gorm:"type:varchar(36);not null;index" json:"owner_id"`
	IsDefault     bool           `gorm:"default:false" json:"is_default"`
	RetentionDays int            `gorm:"default:365" json:"retention_days"`
	CreatedAt     time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt     time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt     gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Safe) TableName() string { return "pam_safes" }

// DefaultSafeID is the safe a credential lands in when nothing else is chosen,
// and it is the literal string "default" rather than a generated UUID for one
// specific reason: Credential.SafeID already carries `default:'default'` as a
// column default, so rows have been written pointing at that string since the
// beginning, and those rows sealed it into their encryption AAD. The id
// therefore cannot be rewritten later without making every one of them
// undecryptable.
//
// Seeding a real safe under that exact id turns a sentinel that pointed at
// nothing into a row that exists. Credentials attached from the Resources
// screen stop being invisible in the Vault, and no data has to be migrated.
const DefaultSafeID = "default"

func (s *Safe) BeforeCreate(tx *gorm.DB) error {
	if s.ID == "" {
		s.ID = uuid.NewString()
	}
	if s.RetentionDays == 0 {
		s.RetentionDays = 365
	}
	return nil
}

// ResourceARN returns the canonical IAM resource string for OPA policy evaluations.
func (s *Safe) ResourceARN() string {
	return fmt.Sprintf("pam:safe/%s", s.Name)
}

// Folder represents a hierarchical folder inside a Safe for organizing credentials.
type Folder struct {
	ID             string         `gorm:"primaryKey;type:varchar(36)" json:"id"`
	SafeID         string         `gorm:"type:varchar(36);not null;index" json:"safe_id"`
	ParentFolderID *string        `gorm:"type:varchar(36);index" json:"parent_folder_id,omitempty"`
	Name           string         `gorm:"type:varchar(255);not null" json:"name"`
	Path           string         `gorm:"type:varchar(512);not null;index" json:"path"` // e.g. "/prod-databases/mysql"
	CreatedAt      time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt      time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt      gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Folder) TableName() string { return "pam_folders" }

func (f *Folder) BeforeCreate(tx *gorm.DB) error {
	if f.ID == "" {
		f.ID = uuid.NewString()
	}
	return nil
}

// SafeFolder is kept as a backward-compatible type alias for Folder.
type SafeFolder = Folder
