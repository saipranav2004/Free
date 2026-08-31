// pam/internal/api/handlers/jit_handler.go
//
// HTTP surface for the JIT access workflow, time-boxed grants and break-glass.
// Handlers stay thin: validate → call service → map domain error → respond.
package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/middleware"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

type JITHandler struct {
	svc    *services.JITService
	notify *services.NotificationService
	// approvers answers "who can decide a request", for the fan-out. A function
	// rather than the whole IdentityService so this handler's dependency is
	// exactly the one question it asks.
	approvers func() ([]string, error)
	logger    *zap.Logger
}

func NewJITHandler(
	svc *services.JITService,
	notify *services.NotificationService,
	approvers func() ([]string, error),
	logger *zap.Logger,
) *JITHandler {
	return &JITHandler{svc: svc, notify: notify, approvers: approvers, logger: logger}
}

// notifyApprovers fans a notification out to everyone who can decide.
//
// Every failure is swallowed and logged: the request has already been created
// or decided by the time this runs, and failing the HTTP call because a
// notification could not be written would undo real work to report a cosmetic
// problem.
func (h *JITHandler) notifyApprovers(in services.NotifyInput) {
	if h.notify == nil || h.approvers == nil {
		return
	}
	ids, err := h.approvers()
	if err != nil {
		h.logger.Warn("jit.notify.approvers.fail", zap.Error(err))
		return
	}
	h.notify.Deliver(in, ids...)
}

func (h *JITHandler) notifyUser(in services.NotifyInput, userID string) {
	if h.notify == nil || userID == "" {
		return
	}
	h.notify.Deliver(in, userID)
}

// ──────────────────────────────────────────────────────────────────────────
// REQUEST
// ──────────────────────────────────────────────────────────────────────────

type createJITRequest struct {
	ResourceID      string `json:"resource_id" binding:"required"`
	Action          string `json:"action"`
	DurationMinutes int    `json:"duration_minutes"`
	Reason          string `json:"reason" binding:"required"`
	TicketRef       string `json:"ticket_ref"`
}

// Create handles POST /api/v1/pam/jit/requests
//
// Idempotency-Key header is honoured: replaying the same key returns the
// original request instead of creating a duplicate.
func (h *JITHandler) Create(c *gin.Context) {
	var req createJITRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}

	in := h.baseInput(c, req.ResourceID, req.Action, req.DurationMinutes, req.Reason, req.TicketRef)

	created, err := h.svc.CreateRequest(c.Request.Context(), in)
	if err != nil {
		h.fail(c, err, "Failed to create access request")
		return
	}

	// The queue is only useful if the people who work it are told. Deduped on
	// the request id, so a retried submission cannot notify twice.
	h.notifyApprovers(services.NotifyInput{
		Category:   models.NotifyCategoryApproval,
		Severity:   models.NotifySeverityWarning,
		Title:      "Access request awaiting your approval",
		Body:       created.RequesterUsername + " requested access to " + created.ResourceName,
		Link:       "/admin/jit",
		EntityType: "jit_request",
		EntityID:   created.ID,
		DedupeKey:  "jit.created." + created.ID,
	})

	response.Created(c, gin.H{
		"request": created,
		"next":    "Awaiting approver decision. Poll GET /api/v1/pam/jit/requests/" + created.ID,
	}, "Access request submitted")
}

// Breakglass handles POST /api/v1/pam/jit/breakglass
//
// No approver is involved, but the grant does not activate until the mandatory
// waiting period elapses, and the request raises a CRITICAL alert immediately.
func (h *JITHandler) Breakglass(c *gin.Context) {
	var req createJITRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}

	in := h.baseInput(c, req.ResourceID, req.Action, req.DurationMinutes, req.Reason, req.TicketRef)

	created, err := h.svc.RequestBreakglass(c.Request.Context(), in)
	if err != nil {
		h.fail(c, err, "Failed to raise break-glass request")
		return
	}

	cfg := h.svc.Config()
	response.Created(c, gin.H{
		"request":               created,
		"available_at":          created.AvailableAt,
		"waiting_period_min":    cfg.BreakglassWaitMin,
		"recording_enforced":    true,
		"alert_severity":        "CRITICAL",
		"activation_window_min": cfg.BreakglassActivationWindowMin,
		"warning": "Emergency access is fully recorded and auto-reported. " +
			"A CRITICAL alert has been raised and an administrator may revoke this before it activates.",
	}, "Break-glass request raised — waiting period started")
}

// List handles GET /api/v1/pam/jit/requests (caller's own requests).
func (h *JITHandler) List(c *gin.Context) {
	userID, _ := c.Get("user_id")
	uid, _ := userID.(string)

	page, size := pagingFrom(c)
	rows, total, err := h.svc.ListRequests(services.RequestFilter{
		RequesterUserID: uid,
		Status:          c.Query("status"),
		RequestType:     c.Query("type"),
		ResourceID:      c.Query("resource_id"),
		Search:          c.Query("q"),
		Page:            page,
		PageSize:        size,
	})
	if err != nil {
		h.logger.Error("jit.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to fetch access requests")
		return
	}
	response.Success(c, paged(rows, total, page, size, "requests"), "Access requests fetched")
}

// Get handles GET /api/v1/pam/jit/requests/:id
func (h *JITHandler) Get(c *gin.Context) {
	req, err := h.svc.GetRequest(c.Param("id"))
	if err != nil {
		h.fail(c, err, "Failed to fetch access request")
		return
	}

	// A user may only read their own request through this route; admins use
	// the IAM console endpoints under /api/v1/pam/admin.
	userID, _ := c.Get("user_id")
	if uid, _ := userID.(string); uid != "" && req.RequesterUserID != uid {
		response.Error(c, http.StatusForbidden, "This access request belongs to another user")
		return
	}
	response.Success(c, gin.H{"request": req}, "Access request fetched")
}

// Cancel handles POST /api/v1/pam/jit/requests/:id/cancel
func (h *JITHandler) Cancel(c *gin.Context) {
	var body struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&body)
	if strings.TrimSpace(body.Reason) == "" {
		body.Reason = "cancelled by requester"
	}

	userID, _ := c.Get("user_id")
	username, _ := c.Get("username")
	uid, _ := userID.(string)
	uname, _ := username.(string)

	req, err := h.svc.Cancel(c.Request.Context(), c.Param("id"), uid, uname, body.Reason, c.ClientIP())
	if err != nil {
		h.fail(c, err, "Failed to cancel access request")
		return
	}
	response.Success(c, gin.H{"request": req}, "Access request cancelled")
}

// ──────────────────────────────────────────────────────────────────────────
// DECISION (approver)
// ──────────────────────────────────────────────────────────────────────────

type decisionBody struct {
	Reason string `json:"reason"`
}

// Approve handles POST .../jit/requests/:id/approve
// Serves both the PAM-authenticated approver route and the IAM console route.
func (h *JITHandler) Approve(c *gin.Context) {
	var body decisionBody
	_ = c.ShouldBindJSON(&body)

	approverID, approverName := middleware.AdminIdentityFromContext(c)
	if approverID == "" {
		response.Error(c, http.StatusUnauthorized, "Approver identity could not be determined")
		return
	}

	req, grant, err := h.svc.Approve(c.Request.Context(), services.DecisionInput{
		RequestID:        c.Param("id"),
		ApproverUserID:   approverID,
		ApproverUsername: approverName,
		Reason:           body.Reason,
		SourceIP:         c.ClientIP(),
		UserAgent:        c.Request.UserAgent(),
		// Roles decide whether this approval is final on its own. Root is;
		// admin needs a second, different person.
		ApproverRoles: rolesOf(c),
	})
	if err != nil {
		h.fail(c, err, "Failed to approve access request")
		return
	}

	// Four-eyes: the first admin approval issues NO grant. Reaching for
	// grant.ExpiresAt here would panic on a nil grant, and — worse — a
	// response shaped like the approved one would tell the console that
	// access had been granted when nothing was entitled yet.
	if grant == nil {
		// Half-approved. The requester learns their request moved; the other
		// approvers learn one of them still has to act.
		h.notifyUser(services.NotifyInput{
			Category:   models.NotifyCategoryRequest,
			Severity:   models.NotifySeverityInfo,
			Title:      "One approval recorded on your access request",
			Body:       "A second, different approver is required before access to " + req.ResourceName + " is granted",
			Link:       "/jit",
			EntityType: "jit_request",
			EntityID:   req.ID,
			DedupeKey:  "jit.partial." + req.ID,
		}, req.RequesterUserID)

		h.notifyApprovers(services.NotifyInput{
			Category:   models.NotifyCategoryApproval,
			Severity:   models.NotifySeverityWarning,
			Title:      "Access request needs a second approver",
			Body:       req.RequesterUsername + " requested access to " + req.ResourceName,
			Link:       "/admin/jit",
			EntityType: "jit_request",
			EntityID:   req.ID,
			DedupeKey:  "jit.second." + req.ID,
		})

		response.Success(c, gin.H{
			"request":      req,
			"grant":        nil,
			"four_eyes":    "awaiting_second_approver",
			"status":       req.Status,
			"grant_issued": false,
		}, "Approval recorded — a second, different approver is required before access is granted")
		return
	}

	h.notifyUser(services.NotifyInput{
		Category:   models.NotifyCategoryAccess,
		Severity:   models.NotifySeverityInfo,
		Title:      "Access approved",
		Body:       "Your access to " + req.ResourceName + " is active until " + grant.ExpiresAt.Format("15:04 on 2 Jan"),
		Link:       "/jit",
		EntityType: "jit_request",
		EntityID:   req.ID,
		DedupeKey:  "jit.approved." + req.ID,
	}, req.RequesterUserID)

	response.Success(c, gin.H{
		"request":      req,
		"grant":        grant,
		"expires_at":   grant.ExpiresAt,
		"grant_issued": true,
	}, "Access request approved — time-boxed grant issued")
}

// Deny handles POST .../jit/requests/:id/deny
func (h *JITHandler) Deny(c *gin.Context) {
	var body decisionBody
	_ = c.ShouldBindJSON(&body)
	if strings.TrimSpace(body.Reason) == "" {
		response.Error(c, http.StatusBadRequest, "A denial reason is required for the audit record")
		return
	}

	approverID, approverName := middleware.AdminIdentityFromContext(c)
	if approverID == "" {
		response.Error(c, http.StatusUnauthorized, "Approver identity could not be determined")
		return
	}

	req, err := h.svc.Deny(c.Request.Context(), services.DecisionInput{
		RequestID:        c.Param("id"),
		ApproverUserID:   approverID,
		ApproverUsername: approverName,
		Reason:           body.Reason,
		SourceIP:         c.ClientIP(),
		UserAgent:        c.Request.UserAgent(),
	})
	if err != nil {
		h.fail(c, err, "Failed to deny access request")
		return
	}
	h.notifyUser(services.NotifyInput{
		Category:   models.NotifyCategoryRequest,
		Severity:   models.NotifySeverityWarning,
		Title:      "Access request denied",
		Body:       "Your request for " + req.ResourceName + " was not approved",
		Link:       "/jit",
		EntityType: "jit_request",
		EntityID:   req.ID,
		DedupeKey:  "jit.denied." + req.ID,
	}, req.RequesterUserID)

	response.Success(c, gin.H{"request": req}, "Access request denied")
}

// ──────────────────────────────────────────────────────────────────────────
// GRANTS
// ──────────────────────────────────────────────────────────────────────────

// ListGrants handles GET /api/v1/pam/jit/grants (caller's own grants).
func (h *JITHandler) ListGrants(c *gin.Context) {
	userID, _ := c.Get("user_id")
	uid, _ := userID.(string)

	page, size := pagingFrom(c)
	rows, total, err := h.svc.ListGrants(services.GrantFilter{
		UserID:     uid,
		Status:     c.Query("status"),
		ResourceID: c.Query("resource_id"),
		ActiveOnly: c.Query("active") == "true",
		Page:       page,
		PageSize:   size,
	})
	if err != nil {
		h.logger.Error("jit.grants.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to fetch access grants")
		return
	}
	response.Success(c, paged(rows, total, page, size, "grants"), "Access grants fetched")
}

// RevokeGrant handles POST .../jit/grants/:id/revoke
// Immediately terminates the entitlement and kills its live sessions.
func (h *JITHandler) RevokeGrant(c *gin.Context) {
	var body decisionBody
	_ = c.ShouldBindJSON(&body)
	if strings.TrimSpace(body.Reason) == "" {
		response.Error(c, http.StatusBadRequest, "A revocation reason is required for the audit record")
		return
	}

	actorID, actorName := middleware.AdminIdentityFromContext(c)
	if actorID == "" {
		response.Error(c, http.StatusUnauthorized, "Revoker identity could not be determined")
		return
	}

	grant, killed, err := h.svc.RevokeGrant(c.Request.Context(),
		c.Param("id"), actorID, actorName, body.Reason, c.ClientIP())
	if err != nil {
		h.fail(c, err, "Failed to revoke access grant")
		return
	}

	response.Success(c, gin.H{
		"grant":           grant,
		"sessions_killed": killed,
	}, "Access grant revoked and active sessions terminated")
}

// ──────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────

func (h *JITHandler) baseInput(c *gin.Context, resourceID, action string, duration int, reason, ticket string) services.CreateRequestInput {
	userID, _ := c.Get("user_id")
	username, _ := c.Get("username")
	decisionID, _ := c.Get("authz_decision_id")

	uid, _ := userID.(string)
	uname, _ := username.(string)
	did, _ := decisionID.(string)

	return services.CreateRequestInput{
		RequesterUserID:   uid,
		RequesterUsername: uname,
		ResourceID:        resourceID,
		Action:            action,
		DurationMinutes:   duration,
		Reason:            reason,
		TicketRef:         ticket,
		SourceIP:          c.ClientIP(),
		UserAgent:         c.Request.UserAgent(),
		AuthzDecisionID:   did,
		IdempotencyKey:    strings.TrimSpace(c.GetHeader("Idempotency-Key")),
	}
}

// fail maps domain errors onto HTTP status codes. Unknown errors become 500
// and are logged with full detail; the client never sees internals.
func (h *JITHandler) fail(c *gin.Context, err error, fallback string) {
	switch {
	case errors.Is(err, services.ErrJITNotFound), errors.Is(err, services.ErrGrantNotFound):
		response.Error(c, http.StatusNotFound, err.Error())
	case errors.Is(err, services.ErrResourceNotFound):
		response.Error(c, http.StatusNotFound, "Resource not found")
	case errors.Is(err, services.ErrNotRequestOwner):
		response.Error(c, http.StatusForbidden, err.Error())
	case errors.Is(err, services.ErrSelfApproval):
		response.Error(c, http.StatusForbidden, err.Error())
	case errors.Is(err, services.ErrNotBreakglassEligible):
		response.Error(c, http.StatusForbidden, err.Error())
	case errors.Is(err, services.ErrInvalidState):
		response.Error(c, http.StatusConflict, err.Error())
	case errors.Is(err, services.ErrDuplicateRequest):
		response.Error(c, http.StatusConflict, err.Error())
	// 409, and the console keys off exactly this: it means "your approval is
	// already counted", not "the request is in a bad state".
	case errors.Is(err, services.ErrDuplicateApprover):
		response.Error(c, http.StatusConflict, err.Error())
	case errors.Is(err, services.ErrDurationExceeded),
		errors.Is(err, services.ErrReasonTooShort),
		errors.Is(err, services.ErrResourceInactive):
		response.Error(c, http.StatusUnprocessableEntity, err.Error())
	default:
		h.logger.Error("jit.handler.error", zap.String("fallback", fallback), zap.Error(err))
		response.Error(c, http.StatusInternalServerError, fallback)
	}
}

// pagingFrom reads page/page_size query params with safe defaults.
func pagingFrom(c *gin.Context) (int, int) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("page_size", "50"))
	if page < 1 {
		page = 1
	}
	if size <= 0 {
		size = 50
	}
	if size > 200 {
		size = 200
	}
	return page, size
}

// paged wraps a result set in a consistent pagination envelope.
func paged(items interface{}, total int64, page, size int, key string) gin.H {
	totalPages := int((total + int64(size) - 1) / int64(size))
	return gin.H{
		key: items,
		"pagination": gin.H{
			"page":        page,
			"page_size":   size,
			"total":       total,
			"total_pages": totalPages,
		},
	}
}
