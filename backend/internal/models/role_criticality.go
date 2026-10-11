// pam/internal/models/role_criticality.go
//
// Role criticality classification: the stored half.
//
// The classification itself is DERIVED, not stored. A role's criticality is
// recomputed from what the role can actually reach (its allow policies, the
// resources those policies match, who holds it) every time it is asked for,
// so it can never drift out of date behind a policy edit. Persisting a score
// would mean every attach/detach/policy-edit anywhere in the system had to
// remember to invalidate it, and the one that forgot would quietly report a
// role as Low while it held wildcard access.
//
// What IS stored is the human override. Every governance product that ships
// this feature lets a reviewer say "I have looked at this and it is a Tier 0
// role regardless of what the engine computed", and treats that decision as
// authoritative until it is explicitly cleared. SailPoint's privilege
// classification behaves exactly this way: a manual assignment takes highest
// priority and stops the automatic classifier from reclassifying that
// entitlement. This table is that override, plus the reason and the reviewer,
// because an override with no recorded justification is indistinguishable from
// a mistake six months later.
package models

import (
	"time"

	"gorm.io/gorm"
)

// CriticalityBand is the published classification. Four bands rather than
// SailPoint's three, because a PAM install needs to separate "this role can
// end the company" (root, wildcard) from "this role administers one domain",
// and collapsing those two into a single High is what makes a criticality
// column useless: the moment half the rows are High, nobody reads it.
//
// The bands line up with the tier model Entra ID uses for privileged roles,
// where Tier 0 is the set that must be protected the hardest.
type CriticalityBand string

const (
	// BandCritical is Tier 0: unrestricted or self-escalating access. A
	// compromise here is a full control-plane compromise.
	BandCritical CriticalityBand = "CRITICAL"
	// BandHigh is Tier 1: broad administrative reach over production
	// secrets or sessions, but bounded.
	BandHigh CriticalityBand = "HIGH"
	// BandModerate is Tier 2: real write access, scoped to a domain.
	BandModerate CriticalityBand = "MODERATE"
	// BandLow is Tier 3: read-mostly, no standing path to a secret.
	BandLow CriticalityBand = "LOW"
)

// Tier returns the numeric tier for a band, 0 being the most privileged.
// Exposed because tier numbering is what security teams actually speak in,
// and because it sorts correctly where the band string does not.
func (b CriticalityBand) Tier() int {
	switch b {
	case BandCritical:
		return 0
	case BandHigh:
		return 1
	case BandModerate:
		return 2
	default:
		return 3
	}
}

// Valid reports whether b is one of the four published bands. Used to reject
// a hand-written override band before it reaches the database.
func (b CriticalityBand) Valid() bool {
	switch b {
	case BandCritical, BandHigh, BandModerate, BandLow:
		return true
	}
	return false
}

// RoleCriticalityOverride is a reviewer's explicit classification for a role,
// which wins over the computed one until it is cleared.
//
// Keyed by RoleID alone: a role has at most one standing override. The history
// of overrides is not kept here, it is kept where every other administrative
// decision in this system is kept, in the audit log, written by the service
// layer on set and on clear.
type RoleCriticalityOverride struct {
	RoleID string `gorm:"primaryKey;type:varchar(36)" json:"role_id"`

	// Band is the classification the reviewer is asserting.
	Band string `gorm:"type:varchar(16);not null" json:"band"`

	// Reason is required by the service layer. An override is a statement
	// that the automatic analysis is wrong, and the next reviewer needs to
	// know why before they trust or clear it.
	Reason string `gorm:"type:text;not null" json:"reason"`

	// SetBy is the acting administrator's user id. Username is denormalised
	// alongside it so the classification can be rendered without a join,
	// and so it still reads correctly if that account is later deleted.
	SetBy         string `gorm:"type:varchar(36);not null;index" json:"set_by"`
	SetByUsername string `gorm:"type:varchar(100)" json:"set_by_username,omitempty"`

	CreatedAt time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

func (RoleCriticalityOverride) TableName() string { return "pam_role_criticality_overrides" }
