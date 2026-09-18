// pam/internal/models/notification.go
//
// The notification centre's record.
//
// ── Why this is a table and not a computed view ───────────────────────────
//
// The console's bell used to derive its contents on the client: it ran three
// JIT queries every 60 seconds and turned the results into a list. That has no
// read state, no history, and no memory. An approver could not tell a request
// they had already looked at from one that arrived a moment ago, dismissing
// something was impossible, and anything that stopped being pending simply
// vanished with no trace that it had ever been raised.
//
// Every enterprise console this was measured against — AWS Console
// Notifications, Okta's admin tasks, ServiceNow, GitHub's inbox — stores the
// notification, because the three things people actually want from a bell all
// require persistence:
//
//	"what is new SINCE I LAST LOOKED"   needs read state
//	"what did I miss last week"         needs history
//	"stop showing me this"              needs a place to write that down
//
// ── Delivery is per recipient ─────────────────────────────────────────────
//
// One row per person, not one row with a list of recipients. Read state is
// personal: an approval request going to four admins is read by one of them
// and still unread for the other three, and a shared row cannot express that
// without a second join table that does the same job less clearly.
package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Notification categories. Deliberately few: a filter with twenty options is a
// filter nobody uses.
const (
	NotifyCategoryApproval = "APPROVAL" // something is waiting on YOU to decide
	NotifyCategoryRequest  = "REQUEST"  // the state of something YOU asked for
	NotifyCategoryAccess   = "ACCESS"   // grants starting, expiring, revoked
	NotifyCategorySecurity = "SECURITY" // posture and enforcement events
	NotifyCategorySystem   = "SYSTEM"   // everything else
)

// The two names below were the original spelling of the last two categories.
// They are kept so an out-of-tree caller keeps compiling, but every call site
// in this repository uses the NotifyCategory* form: five constants naming one
// set should not be spelled two ways.
const (
	NotifySecurity = NotifyCategorySecurity
	NotifySystem   = NotifyCategorySystem
)

// NotifyCategories is the full set, in the order a filter should offer them.
// Exported so a handler can validate a category parameter against the real
// list instead of accepting any string and returning an empty page.
var NotifyCategories = []string{
	NotifyCategoryApproval,
	NotifyCategoryRequest,
	NotifyCategoryAccess,
	NotifyCategorySecurity,
	NotifyCategorySystem,
}

// Severity drives the colour and the ordering, nothing else.
const (
	NotifySeverityInfo     = "INFO"
	NotifySeverityWarning  = "WARNING"
	NotifySeverityCritical = "CRITICAL"
)

// Notification is one delivered item for one person.
type Notification struct {
	ID     string `gorm:"primaryKey;type:varchar(36)" json:"id"`
	OrgID  string `gorm:"type:varchar(36);index" json:"org_id,omitempty"`
	UserID string `gorm:"type:varchar(36);not null;index:idx_notif_user_created,priority:1" json:"user_id"`

	Category string `gorm:"type:varchar(24);not null;index" json:"category"`
	Severity string `gorm:"type:varchar(16);not null;default:INFO" json:"severity"`

	// Title is the line a person reads in the list. Body is the qualifying
	// sentence under it and may be empty.
	Title string `gorm:"type:varchar(255);not null" json:"title"`
	Body  string `gorm:"type:text" json:"body,omitempty"`

	// Link is where clicking the notification goes, as a console-relative path.
	// A notification that cannot be acted on is an alert, and an alert nobody
	// can act on is noise, so almost everything carries one.
	Link string `gorm:"type:varchar(255)" json:"link,omitempty"`

	// EntityType/EntityID name the object this is about, so the UI can group
	// and so a later state change can find and supersede an earlier item.
	EntityType string `gorm:"type:varchar(48);index:idx_notif_entity,priority:1" json:"entity_type,omitempty"`
	EntityID   string `gorm:"type:varchar(64);index:idx_notif_entity,priority:2" json:"entity_id,omitempty"`

	// DedupeKey stops the same fact being delivered twice to the same person.
	// A JIT request that is polled, retried or re-saved must not produce four
	// identical rows in somebody's bell.
	//
	// Unique per user, and NULLABLE rather than empty-string: Postgres treats
	// NULLs as distinct in a unique index, so notifications that genuinely have
	// no dedupe identity do not collide with each other.
	DedupeKey *string `gorm:"type:varchar(128);uniqueIndex:idx_notif_dedupe" json:"-"`

	// ReadAt is the whole point of the table. NULL means unread.
	ReadAt *time.Time `gorm:"index" json:"read_at,omitempty"`

	CreatedAt time.Time      `gorm:"autoCreateTime;index:idx_notif_user_created,priority:2,sort:desc" json:"created_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Notification) TableName() string { return "pam_notifications" }

func (n *Notification) BeforeCreate(tx *gorm.DB) error {
	if n.ID == "" {
		n.ID = uuid.NewString()
	}
	if n.Severity == "" {
		n.Severity = NotifySeverityInfo
	}
	if n.Category == "" {
		n.Category = NotifyCategorySystem
	}
	return nil
}

// IsRead is a convenience for callers that would otherwise compare against nil
// in three places and get it wrong in one of them.
func (n Notification) IsRead() bool { return n.ReadAt != nil }
