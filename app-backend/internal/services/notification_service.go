// pam/internal/services/notification_service.go
//
// The notification centre.
//
// Read models/notification.go first for why these are stored rather than
// derived. This file is the write and read paths around that table.
//
// ── What was taken from other consoles, and what was left ─────────────────
//
// AWS Console Notifications, Okta's admin Tasks, ServiceNow and GitHub's inbox
// converge on the same handful of decisions, and the ones worth copying are:
//
//	UNREAD IS THE DEFAULT VIEW.   People open a bell to see what is new, not to
//	                              browse. History is one click away, never the
//	                              landing state.
//	THE BADGE IS A COUNT OF WORK. It counts unread items, and it is capped in
//	                              the UI ("9+") because the difference between
//	                              40 and 60 changes nothing a person does.
//	EVERY ITEM IS ACTIONABLE.     A notification carries a link to the thing it
//	                              is about. One that does not is an alert, and
//	                              an alert nobody can act on trains people to
//	                              ignore the bell.
//	DEDUPE HARD.                  The fastest way to make a notification centre
//	                              worthless is to deliver the same fact twice.
//
// What was deliberately NOT copied: per-user notification preferences, digest
// scheduling, and channel fan-out to email or Slack. Each is a product in its
// own right, and none of them is what "the bell does not update" was asking
// for.
package services

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// NotificationService owns pam_notifications.
type NotificationService struct {
	db     *gorm.DB
	logger *zap.Logger
}

func NewNotificationService(db *gorm.DB, logger *zap.Logger) *NotificationService {
	s := &NotificationService{db: db, logger: logger}
	// THE SERVICE CREATES ITS OWN TABLE, the same way MFAPolicyService and the
	// admin-delegation store already do in this codebase.
	//
	// This is what a partial deployment looks like from a browser: the console
	// asks for notifications, pam_notifications does not exist, every read is a
	// 500 and every write is swallowed, so the bell reports a failure and the
	// approval queue is never told about anything. Depending on main.go's
	// AutoMigrate list alone means the table is only created when THAT file is
	// also updated, which is exactly the file most likely to be left behind
	// when a build is assembled by hand.
	//
	// AutoMigrate is idempotent, so this costs one cheap catalogue check at
	// boot on an install that already has the table.
	if err := db.AutoMigrate(&models.Notification{}); err != nil {
		logger.Error("notification.automigrate.fail",
			zap.String("hint", "notifications will fail to read and write until pam_notifications exists"),
			zap.Error(err))
	}
	return s
}

// NotifyInput is one notification, before it is fanned out to recipients.
type NotifyInput struct {
	OrgID      string
	Category   string
	Severity   string
	Title      string
	Body       string
	Link       string
	EntityType string
	EntityID   string

	// DedupeKey identifies the FACT, not the delivery. The recipient is added
	// automatically, so one key can safely be used for a fan-out to five
	// approvers without them colliding with each other.
	DedupeKey string
}

// Deliver writes one notification to each recipient.
//
// FIRE AND FORGET BY DESIGN. Every caller is in the middle of doing something
// that matters more than this: approving a JIT request, revoking a grant. A
// notification that fails to write must never roll back or fail the action it
// describes, so errors are logged and swallowed. The audit log is the record of
// what happened; this table is only how somebody finds out about it.
func (s *NotificationService) Deliver(in NotifyInput, userIDs ...string) {
	if strings.TrimSpace(in.Title) == "" || len(userIDs) == 0 {
		return
	}

	rows := make([]models.Notification, 0, len(userIDs))
	seen := make(map[string]struct{}, len(userIDs))
	for _, uid := range userIDs {
		uid = strings.TrimSpace(uid)
		if uid == "" {
			continue
		}
		// A caller that assembles its recipient list from two queries can
		// easily hand the same person in twice.
		if _, dup := seen[uid]; dup {
			continue
		}
		seen[uid] = struct{}{}

		row := models.Notification{
			OrgID:      in.OrgID,
			UserID:     uid,
			Category:   in.Category,
			Severity:   in.Severity,
			Title:      in.Title,
			Body:       in.Body,
			Link:       in.Link,
			EntityType: in.EntityType,
			EntityID:   in.EntityID,
		}
		if k := strings.TrimSpace(in.DedupeKey); k != "" {
			// Scoped to the recipient so a fan-out does not self-collide.
			key := k + "|" + uid
			row.DedupeKey = &key
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return
	}

	// DoNothing on conflict is the dedupe. Cheaper and more reliable than a
	// read-then-write, which races with itself under concurrent approvals.
	err := s.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "dedupe_key"}}, DoNothing: true}).
		Create(&rows).Error
	if err != nil {
		// ERROR, not WARN. This is swallowed by design (see above), so the log
		// line is the ONLY trace that an approver was never told about a
		// pending request. At WARN it sat below the default threshold on a
		// normal deployment and the failure was invisible from both ends.
		s.logger.Error("notification.deliver.fail",
			zap.String("category", in.Category),
			zap.Int("recipients", len(rows)),
			zap.String("impact", "these recipients will not see this event in their notification centre"),
			zap.Error(err))
	}
}

// NotificationFilter narrows a listing.
type NotificationFilter struct {
	UserID string
	// UnreadOnly is what the bell asks for; the page offers both.
	UnreadOnly bool
	Category   string
	Page       int
	PageSize   int
}

// NotificationPage is one page of results plus the counts the UI needs to
// render its header without a second round trip.
type NotificationPage struct {
	Items       []models.Notification `json:"items"`
	Total       int64                 `json:"total"`
	UnreadTotal int64                 `json:"unread_total"`
	Page        int                   `json:"page"`
	PageSize    int                   `json:"page_size"`
	TotalPages  int                   `json:"total_pages"`
}

// List returns one page, newest first.
func (s *NotificationService) List(f NotificationFilter) (*NotificationPage, error) {
	if strings.TrimSpace(f.UserID) == "" {
		return nil, errors.New("notification list: user id is required")
	}
	page, size := normalisePaging(f.Page, f.PageSize)

	base := func() *gorm.DB {
		q := s.db.Model(&models.Notification{}).Where("user_id = ?", f.UserID)
		if f.Category != "" {
			q = q.Where("category = ?", strings.ToUpper(f.Category))
		}
		return q
	}

	q := base()
	if f.UnreadOnly {
		q = q.Where("read_at IS NULL")
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, fmt.Errorf("notification.list.count: %w", err)
	}

	// The unread total is counted WITHOUT the unread filter and without the
	// category filter, because it is the badge, and the badge must not change
	// when somebody switches tab.
	var unread int64
	if err := s.db.Model(&models.Notification{}).
		Where("user_id = ? AND read_at IS NULL", f.UserID).
		Count(&unread).Error; err != nil {
		return nil, fmt.Errorf("notification.list.unread: %w", err)
	}

	var rows []models.Notification
	if err := q.Order("created_at DESC").
		Offset((page - 1) * size).
		Limit(size).
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("notification.list: %w", err)
	}

	totalPages := int((total + int64(size) - 1) / int64(size))
	return &NotificationPage{
		Items: rows, Total: total, UnreadTotal: unread,
		Page: page, PageSize: size, TotalPages: totalPages,
	}, nil
}

// UnreadCount is the badge. Its own query because the bell asks for it far more
// often than it asks for the list.
func (s *NotificationService) UnreadCount(userID string) (int64, error) {
	var n int64
	err := s.db.Model(&models.Notification{}).
		Where("user_id = ? AND read_at IS NULL", userID).
		Count(&n).Error
	return n, err
}

// MarkRead marks one notification read.
//
// Scoped by user id as well as row id, so a guessed identifier reads nothing
// and marks nothing belonging to somebody else.
func (s *NotificationService) MarkRead(userID, id string) error {
	now := time.Now().UTC()
	res := s.db.Model(&models.Notification{}).
		Where("id = ? AND user_id = ? AND read_at IS NULL", id, userID).
		Update("read_at", now)
	if res.Error != nil {
		return res.Error
	}
	// Zero rows is not an error: marking an already-read item read is exactly
	// what a double click does, and it should be a no-op rather than a failure.
	return nil
}

// MarkAllRead clears the badge. Returns how many were affected so the UI can
// say something true rather than guessing.
func (s *NotificationService) MarkAllRead(userID string) (int64, error) {
	now := time.Now().UTC()
	res := s.db.Model(&models.Notification{}).
		Where("user_id = ? AND read_at IS NULL", userID).
		Update("read_at", now)
	return res.RowsAffected, res.Error
}
