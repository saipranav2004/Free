// pam/internal/api/handlers/notification_handler.go
//
// The notification centre's HTTP surface.
//
// Every route is scoped to the caller from the token. There is no user
// parameter anywhere in this file, and there must never be one: a notification
// list is a record of what one person has and has not seen.
package handlers

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

type NotificationHandler struct {
	svc *services.NotificationService
	log *zap.Logger
}

func NewNotificationHandler(svc *services.NotificationService, log *zap.Logger) *NotificationHandler {
	return &NotificationHandler{svc: svc, log: log}
}

func callerID(c *gin.Context) (string, bool) {
	v, ok := c.Get("user_id")
	if !ok {
		return "", false
	}
	id, _ := v.(string)
	return id, id != ""
}

// List handles GET /api/v1/pam/notifications
//
//	status=unread   only what has not been seen (the bell's view)
//	status=all      everything, newest first (the page's default)
//	category=...    optional narrowing
func (h *NotificationHandler) List(c *gin.Context) {
	userID, ok := callerID(c)
	if !ok {
		response.Error(c, http.StatusUnauthorized, "Not authenticated")
		return
	}

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))

	out, err := h.svc.List(services.NotificationFilter{
		UserID:     userID,
		UnreadOnly: c.Query("status") == "unread",
		Category:   c.Query("category"),
		Page:       page,
		PageSize:   size,
	})
	if err != nil {
		h.log.Error("notifications.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to load notifications")
		return
	}
	response.Success(c, out, "Notifications fetched")
}

// UnreadCount handles GET /api/v1/pam/notifications/unread-count
//
// Its own route because the bell polls this far more often than it opens the
// list, and a count is one indexed aggregate rather than a page of rows.
func (h *NotificationHandler) UnreadCount(c *gin.Context) {
	userID, ok := callerID(c)
	if !ok {
		response.Error(c, http.StatusUnauthorized, "Not authenticated")
		return
	}
	n, err := h.svc.UnreadCount(userID)
	if err != nil {
		h.log.Error("notifications.count.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to count notifications")
		return
	}
	response.Success(c, gin.H{"unread": n}, "Unread count fetched")
}

// MarkRead handles POST /api/v1/pam/notifications/:id/read
func (h *NotificationHandler) MarkRead(c *gin.Context) {
	userID, ok := callerID(c)
	if !ok {
		response.Error(c, http.StatusUnauthorized, "Not authenticated")
		return
	}
	if err := h.svc.MarkRead(userID, c.Param("id")); err != nil {
		h.log.Error("notifications.mark_read.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to update notification")
		return
	}
	response.Success(c, gin.H{"ok": true}, "Notification marked as read")
}

// MarkAllRead handles POST /api/v1/pam/notifications/read-all
func (h *NotificationHandler) MarkAllRead(c *gin.Context) {
	userID, ok := callerID(c)
	if !ok {
		response.Error(c, http.StatusUnauthorized, "Not authenticated")
		return
	}
	n, err := h.svc.MarkAllRead(userID)
	if err != nil {
		h.log.Error("notifications.mark_all.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to update notifications")
		return
	}
	response.Success(c, gin.H{"updated": n}, "All notifications marked as read")
}
