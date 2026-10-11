// pam/internal/models/network_allowlist.go
//
// Which source addresses may reach this console at all.
//
// This used to be a block of `allow`/`deny` lines edited by hand in the
// frontend's nginx.conf and baked into a container image, which meant every
// change to "who can reach us" was a code change, a rebuild and a deploy —
// and, because it was commented out in the shipped file, it was in practice
// not enforced at all. Moving it here makes it data the root operator owns,
// changeable from the console, auditable, and readable by both enforcement
// points (the API's own middleware and nginx) from one source of truth.
package models

import (
	"time"

	"github.com/google/uuid"
)

// NetworkAllowlistEntry is one permitted source range.
//
// CIDR is stored already normalised to its network address (see
// services.NormalizeCIDR), so "183.82.2.29/24" is written as "183.82.2.0/24".
// Storing what the operator typed would make two entries that mean the same
// thing look different in the list and compare unequal on de-duplication.
type NetworkAllowlistEntry struct {
	ID string `gorm:"primaryKey;type:varchar(36)" json:"id"`
	// column:cidr is not decoration. GORM's naming strategy reads the "ID"
	// inside "CIDR" as an initialism and derives the column "c_id_r",
	// which every hand-written query here would then miss. Caught by
	// running AutoMigrate and listing the columns rather than by reading
	// the struct.
	CIDR  string `gorm:"column:cidr;type:varchar(64);not null;uniqueIndex" json:"cidr"`
	Label string `gorm:"type:varchar(255)" json:"label"`

	// CreatedByUserID and CreatedByUsername are captured at write time
	// rather than joined at read time, so the list still says who added an
	// entry after that account is renamed or deleted. An allowlist is a
	// security control; "who opened this hole and when" has to survive.
	CreatedByUserID   string    `gorm:"type:varchar(36)" json:"created_by_user_id"`
	CreatedByUsername string    `gorm:"type:varchar(255)" json:"created_by_username"`
	CreatedAt         time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (NetworkAllowlistEntry) TableName() string { return "pam_network_allowlist" }

// NetworkAllowlistSettings is the single row holding the on/off switch.
//
// Separate from the entries so that turning enforcement off keeps the list
// intact: an operator who has to disable it during an incident should not
// have to retype every range to turn it back on.
type NetworkAllowlistSettings struct {
	ID                string    `gorm:"primaryKey;type:varchar(36)" json:"id"`
	Enabled           bool      `gorm:"default:false" json:"enabled"`
	UpdatedByUserID   string    `gorm:"type:varchar(36)" json:"updated_by_user_id"`
	UpdatedByUsername string    `gorm:"type:varchar(255)" json:"updated_by_username"`
	UpdatedAt         time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

func (NetworkAllowlistSettings) TableName() string { return "pam_network_allowlist_settings" }

// NetworkAllowlistSettingsID is a fixed primary key. The switch is a
// property of the deployment, not of a tenant, so there is exactly one row
// and it is addressed by a constant rather than "whichever row comes back
// first" — which would silently pick one of several after any accident that
// created a second.
const NetworkAllowlistSettingsID = "default"

func NewNetworkAllowlistEntry(cidr, label, userID, username string) NetworkAllowlistEntry {
	return NetworkAllowlistEntry{
		ID:                uuid.NewString(),
		CIDR:              cidr,
		Label:             label,
		CreatedByUserID:   userID,
		CreatedByUsername: username,
	}
}
