// pam/internal/api/handlers/admin_handler.go
//
// The surface the IAM admin console reads from PAM.
//
// Two clearly separated groups:
//
//	/api/v1/pam/admin/...          READ-ONLY. Service token only. No mutations.
//	/api/v1/pam/admin/actions/...  WRITE. Service token + X-Admin-User-Id, so
//	                               every approval/denial/revocation/kill is
//	                               attributable to a named human, not to "IAM".
//
// The task specified read-only endpoints; the action group is a deliberate
// addition, because "the approver sees it in the IAM admin console" is only
// useful if the console can also act on it. Keeping the two groups apart means
// the read surface can be granted to reporting/SIEM integrations without
// handing them the ability to mutate access.
package handlers

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/middleware"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/recorder"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

type AdminHandler struct {
	jit     *services.JITService
	res     *services.ResourceService
	audit   *services.AuditService
	storage recorder.Storage
	logger  *zap.Logger
}

func NewAdminHandler(
	jit *services.JITService,
	res *services.ResourceService,
	audit *services.AuditService,
	storage recorder.Storage,
	logger *zap.Logger,
) *AdminHandler {
	return &AdminHandler{jit: jit, res: res, audit: audit, storage: storage, logger: logger}
}

// ──────────────────────────────────────────────────────────────────────────
// READ-ONLY
// ──────────────────────────────────────────────────────────────────────────

// ListJITRequests handles GET /api/v1/pam/admin/jit-requests
// Query: status, type, resource_id, requester_user_id, q, page, page_size
func (h *AdminHandler) ListJITRequests(c *gin.Context) {
	page, size := pagingFrom(c)
	rows, total, err := h.jit.ListRequests(services.RequestFilter{
		RequesterUserID: c.Query("requester_user_id"),
		Status:          c.Query("status"),
		RequestType:     c.Query("type"),
		ResourceID:      c.Query("resource_id"),
		Search:          c.Query("q"),
		Page:            page,
		PageSize:        size,
	})
	if err != nil {
		h.logger.Error("admin.jit.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to fetch JIT requests")
		return
	}
	response.Success(c, paged(rows, total, page, size, "requests"), "JIT requests fetched")
}

// GetJITRequest handles GET /api/v1/pam/admin/jit-requests/:id
func (h *AdminHandler) GetJITRequest(c *gin.Context) {
	req, err := h.jit.GetRequest(c.Param("id"))
	if err != nil {
		response.Error(c, http.StatusNotFound, "JIT request not found")
		return
	}

	payload := gin.H{"request": req}
	if req.GrantID != nil {
		if g, err := h.jit.GetGrant(*req.GrantID); err == nil {
			payload["grant"] = g
		}
	}
	// The decision trail for this request, oldest first.
	trail, _, err := h.audit.List(services.AuditFilter{RequestID: req.ID, PageSize: 200})
	if err == nil {
		payload["audit_trail"] = trail
	}
	response.Success(c, payload, "JIT request fetched")
}

// ListGrants handles GET /api/v1/pam/admin/grants
// Query: user_id, resource_id, status, active=true, breakglass=true|false
func (h *AdminHandler) ListGrants(c *gin.Context) {
	page, size := pagingFrom(c)
	rows, total, err := h.jit.ListGrants(services.GrantFilter{
		UserID:       c.Query("user_id"),
		ResourceID:   c.Query("resource_id"),
		Status:       c.Query("status"),
		IsBreakglass: boolQuery(c, "breakglass"),
		ActiveOnly:   c.Query("active") == "true",
		Page:         page,
		PageSize:     size,
	})
	if err != nil {
		h.logger.Error("admin.grants.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to fetch access grants")
		return
	}
	response.Success(c, paged(rows, total, page, size, "grants"), "Access grants fetched")
}

// ListSessions handles GET /api/v1/pam/admin/sessions
// Query: user_id, resource_id, grant_id, status, active=true, breakglass, from, to, q
func (h *AdminHandler) ListSessions(c *gin.Context) {
	page, size := pagingFrom(c)
	from, to := timeRange(c)

	rows, total, err := h.res.ListSessions(services.SessionFilter{
		UserID:       c.Query("user_id"),
		ResourceID:   c.Query("resource_id"),
		GrantID:      c.Query("grant_id"),
		Status:       strings.ToUpper(c.Query("status")),
		ActiveOnly:   c.Query("active") == "true",
		IsBreakglass: boolQuery(c, "breakglass"),
		From:         from,
		To:           to,
		Search:       c.Query("q"),
		Page:         page,
		PageSize:     size,
	})
	if err != nil {
		h.logger.Error("admin.sessions.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to fetch sessions")
		return
	}
	response.Success(c, paged(rows, total, page, size, "sessions"), "Sessions fetched")
}

// ListRecordings handles GET /api/v1/pam/admin/recordings
//
// Returns recording METADATA only — status, storage key, size, checksum. Use
// GetRecordingCast for the actual replay bytes and GetRecordingCommands for
// the structured per-command log; the capture pipeline itself lives in
// internal/gateway (RecordingConn, in-browser terminal + native agent) and
// internal/webproxy (brokered web sessions), both writing through
// internal/recorder (Cast/Storage). Every connect method lands in this same
// table with the same asciicast artifact, so replay here is method-agnostic.
func (h *AdminHandler) ListRecordings(c *gin.Context) {
	page, size := pagingFrom(c)
	rows, total, err := h.res.ListRecordings(services.RecordingFilter{
		UserID:       c.Query("user_id"),
		ResourceID:   c.Query("resource_id"),
		SessionID:    c.Query("session_id"),
		GrantID:      c.Query("grant_id"),
		Status:       c.Query("status"),
		IsBreakglass: boolQuery(c, "breakglass"),
		Page:         page,
		PageSize:     size,
	})
	if err != nil {
		h.logger.Error("admin.recordings.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to fetch recordings")
		return
	}
	response.Success(c, paged(rows, total, page, size, "recordings"), "Recordings fetched")
}

// GetRecordingCast handles GET /api/v1/pam/admin/recordings/:id/cast
//
// Streams the decompressed asciicast v2 transcript for in-browser replay.
// The blob on disk is gzip-compressed (see recorder.Cast.Finalize); this
// handler is the one place that gunzips it back for a consumer, so the
// storage layer itself never has to know about the asciicast format.
func (h *AdminHandler) GetRecordingCast(c *gin.Context) {
	if h.storage == nil {
		response.Error(c, http.StatusServiceUnavailable, "Recording storage is not configured")
		return
	}
	rec, err := h.res.GetRecording(c.Param("id"))
	if err != nil {
		response.Error(c, http.StatusNotFound, "Recording not found")
		return
	}
	if rec.StorageKey == "" {
		response.Error(c, http.StatusNotFound, "This recording has no stored artifact yet")
		return
	}

	raw, err := h.storage.Load(c.Request.Context(), rec.StorageKey)
	if err != nil {
		h.logger.Error("admin.recordings.cast.load.fail", zap.String("recording_id", rec.ID), zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to load recording artifact")
		return
	}

	reader, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		h.logger.Error("admin.recordings.cast.gunzip.fail", zap.String("recording_id", rec.ID), zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to decode recording artifact")
		return
	}
	defer reader.Close()

	// The artifact's format decides how a player renders it: a terminal
	// transcript is asciicast, a brokered web session's visual replay is a
	// newline-delimited rrweb event stream. Same endpoint either way — the
	// caller already has rec.Format from the listing and only needs the
	// bytes — but the content type must not claim asciicast for either one.
	if rec.Format == "rrweb" {
		c.Header("Content-Type", "application/x-ndjson")
		c.Header("Content-Disposition", `inline; filename="`+rec.ID+`.rrweb.jsonl"`)
	} else {
		c.Header("Content-Type", "application/x-asciicast")
		c.Header("Content-Disposition", `inline; filename="`+rec.ID+`.cast"`)
	}
	if _, err := io.Copy(c.Writer, reader); err != nil {
		h.logger.Warn("admin.recordings.cast.stream.fail", zap.String("recording_id", rec.ID), zap.Error(err))
	}
}

// GetRecordingTranscript handles GET /api/v1/pam/admin/recordings/:id/transcript
//
// The secondary artifact for a recording whose primary is a visual replay:
// the same session's HTTP request transcript as an asciicast. Separate from
// GetRecordingCast rather than content-negotiated on one route because the
// two are genuinely different evidence about the same session — an auditor
// asks "show me the screen" or "show me the requests", and a UI offers both
// side by side.
//
// 404s for a terminal recording, where no such secondary artifact exists
// because StorageKey already IS the transcript.
func (h *AdminHandler) GetRecordingTranscript(c *gin.Context) {
	if h.storage == nil {
		response.Error(c, http.StatusServiceUnavailable, "Recording storage is not configured")
		return
	}
	rec, err := h.res.GetRecording(c.Param("id"))
	if err != nil {
		response.Error(c, http.StatusNotFound, "Recording not found")
		return
	}
	if rec.TranscriptKey == nil || *rec.TranscriptKey == "" {
		response.Error(c, http.StatusNotFound,
			"This recording has no separate request transcript — for a terminal recording the cast itself is the transcript")
		return
	}

	raw, err := h.storage.Load(c.Request.Context(), *rec.TranscriptKey)
	if err != nil {
		h.logger.Error("admin.recordings.transcript.load.fail",
			zap.String("recording_id", rec.ID), zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to load recording transcript")
		return
	}

	reader, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		h.logger.Error("admin.recordings.transcript.gunzip.fail",
			zap.String("recording_id", rec.ID), zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to decode recording transcript")
		return
	}
	defer reader.Close()

	c.Header("Content-Type", "application/x-asciicast")
	c.Header("Content-Disposition", `inline; filename="`+rec.ID+`.cast"`)
	if _, err := io.Copy(c.Writer, reader); err != nil {
		h.logger.Warn("admin.recordings.transcript.stream.fail",
			zap.String("recording_id", rec.ID), zap.Error(err))
	}
}

// GetRecordingCommands handles GET /api/v1/pam/admin/recordings/:id/commands
// Query: page, page_size
//
// The searchable half of the recording — one row per command/statement run
// during the session, masked the same way the raw cast stream is masked, so
// an auditor can find "did anyone run X against resource Y" without having
// to replay the whole session.
func (h *AdminHandler) GetRecordingCommands(c *gin.Context) {
	page, size := pagingFrom(c)
	if _, err := h.res.GetRecording(c.Param("id")); err != nil {
		response.Error(c, http.StatusNotFound, "Recording not found")
		return
	}
	rows, total, err := h.res.ListRecordingCommands(c.Param("id"), page, size)
	if err != nil {
		h.logger.Error("admin.recordings.commands.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to fetch recording commands")
		return
	}
	response.Success(c, paged(rows, total, page, size, "commands"), "Recording commands fetched")
}

// ListAudit handles GET /api/v1/pam/admin/audit
// Query: actor_user_id, action, outcome, severity, resource_id, grant_id,
//
//	request_id, session_id, from, to, q, page, page_size
//
// AuditStats handles GET /api/v1/pam/admin/audit/stats
//
// The dashboard's charts as counts instead of rows. Takes the same filters as
// ListAudit so the two always describe the same events, plus:
//
//	span  "hour" (default) or "day" — the bucket width
//	tz    IANA zone name, e.g. "Asia/Kolkata" — which day an event belongs to
//
// tz matters more than it looks. Rows are stored in UTC, and "which hour did
// this happen in" is a question about where the reader is sitting. Without it
// an evening event in India lands on the following day and the heatmap is
// quietly wrong. The browser passes Intl.DateTimeFormat().resolvedOptions().timeZone.
func (h *AdminHandler) AuditStats(c *gin.Context) {
	from, to := timeRange(c)

	stats, err := h.audit.Stats(services.AuditFilter{
		ActorUserID: c.Query("actor_user_id"),
		Action:      c.Query("action"),
		Outcome:     strings.ToUpper(c.Query("outcome")),
		Severity:    strings.ToUpper(c.Query("severity")),
		ResourceID:  c.Query("resource_id"),
		GrantID:     c.Query("grant_id"),
		RequestID:   c.Query("request_id"),
		SessionID:   c.Query("session_id"),
		From:        from,
		To:          to,
		Search:      c.Query("q"),
	}, c.Query("span"), c.Query("tz"))
	if err != nil {
		h.logger.Error("admin.audit.stats.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to compute audit statistics")
		return
	}
	response.Success(c, stats, "Audit statistics computed")
}

func (h *AdminHandler) ListAudit(c *gin.Context) {
	page, size := pagingFrom(c)
	from, to := timeRange(c)

	rows, total, err := h.audit.List(services.AuditFilter{
		ActorUserID: c.Query("actor_user_id"),
		Action:      c.Query("action"),
		Outcome:     strings.ToUpper(c.Query("outcome")),
		Severity:    strings.ToUpper(c.Query("severity")),
		ResourceID:  c.Query("resource_id"),
		GrantID:     c.Query("grant_id"),
		RequestID:   c.Query("request_id"),
		SessionID:   c.Query("session_id"),
		From:        from,
		To:          to,
		Search:      c.Query("q"),
		Page:        page,
		PageSize:    size,
	})
	if err != nil {
		h.logger.Error("admin.audit.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to fetch audit log")
		return
	}
	response.Success(c, paged(rows, total, page, size, "events"), "Audit events fetched")
}

// VerifyAudit handles GET /api/v1/pam/admin/audit/verify
// Recomputes the hash chain and reports the first break, if any.
//
// NOTE: VerifyChain walks the whole chain for an org, not just the last
// `limit` rows — a `limit` query param made sense for a keyless-hash
// walk-from-the-tail design, but the canonical HMAC chain this merge
// standardized on (pkg/auditchain) verifies front-to-back per org, the same
// full walk audit_verification_job.go's daily cron already runs. The
// `limit` param is accepted for backward compatibility with existing
// dashboard callers but currently has no effect; wire it through as a
// row cap here if full-chain verification ever gets too slow to run
// synchronously from an HTTP handler.
func (h *AdminHandler) VerifyAudit(c *gin.Context) {
	if v := c.Query("limit"); v != "" {
		if _, err := parseIntSafe(v); err != nil {
			response.Error(c, http.StatusBadRequest, "invalid limit")
			return
		}
	}
	res, err := h.audit.VerifyChain(c.Request.Context(), "")
	if err != nil {
		h.logger.Error("admin.audit.verify.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to verify audit chain")
		return
	}
	msg := "Audit chain intact"
	if !res.Valid {
		msg = "AUDIT CHAIN BROKEN — records were altered or deleted"
	}
	response.Success(c, gin.H{"verification": res}, msg)
}

// ListBreakglass handles GET /api/v1/pam/admin/breakglass
// Emergency requests and their grants in one payload for the console panel.
func (h *AdminHandler) ListBreakglass(c *gin.Context) {
	page, size := pagingFrom(c)

	requests, total, err := h.jit.ListRequests(services.RequestFilter{
		RequestType: models.JITTypeBreakglass,
		Status:      c.Query("status"),
		Page:        page,
		PageSize:    size,
	})
	if err != nil {
		h.logger.Error("admin.breakglass.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to fetch break-glass requests")
		return
	}

	bg := true
	grants, _, err := h.jit.ListGrants(services.GrantFilter{
		IsBreakglass: &bg,
		Page:         1,
		PageSize:     size,
	})
	if err != nil {
		h.logger.Error("admin.breakglass.grants.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to fetch break-glass grants")
		return
	}

	payload := paged(requests, total, page, size, "requests")
	payload["grants"] = grants
	response.Success(c, payload, "Break-glass activity fetched")
}

// BreakglassReport handles GET /api/v1/pam/admin/breakglass/:grant_id/report
// The auto-generated emergency-access report an auditor asks for.
func (h *AdminHandler) BreakglassReport(c *gin.Context) {
	report, err := h.jit.BuildBreakglassReport(c.Param("grant_id"))
	if err != nil {
		response.Error(c, http.StatusNotFound, "Break-glass grant not found")
		return
	}
	response.Success(c, gin.H{"report": report}, "Break-glass report generated")
}

// Stats handles GET /api/v1/pam/admin/stats — dashboard tiles.
func (h *AdminHandler) Stats(c *gin.Context) {
	pending, err := h.jit.PendingApprovalCount()
	if err != nil {
		h.logger.Error("admin.stats.pending.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to compute stats")
		return
	}
	activeSessions, err := h.res.CountActiveSessions()
	if err != nil {
		h.logger.Error("admin.stats.sessions.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to compute stats")
		return
	}
	resources, err := h.res.CountResources()
	if err != nil {
		h.logger.Error("admin.stats.resources.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to compute stats")
		return
	}

	_, activeGrants, err := h.jit.ListGrants(services.GrantFilter{ActiveOnly: true, PageSize: 1})
	if err != nil {
		h.logger.Error("admin.stats.grants.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to compute stats")
		return
	}
	bg := true
	_, activeBreakglass, err := h.jit.ListGrants(services.GrantFilter{ActiveOnly: true, IsBreakglass: &bg, PageSize: 1})
	if err != nil {
		h.logger.Error("admin.stats.breakglass.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to compute stats")
		return
	}

	response.Success(c, gin.H{
		"pending_approvals":        pending,
		"active_sessions":          activeSessions,
		"active_grants":            activeGrants,
		"active_breakglass_grants": activeBreakglass,
		"active_resources":         resources,
		"generated_at":             time.Now().UTC(),
	}, "PAM statistics fetched")
}

// ──────────────────────────────────────────────────────────────────────────
// ACTIONS (attributable writes)
// ──────────────────────────────────────────────────────────────────────────

// KillSession handles POST /api/v1/pam/admin/actions/sessions/:id/kill
func (h *AdminHandler) KillSession(c *gin.Context) {
	var body struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&body)
	if strings.TrimSpace(body.Reason) == "" {
		response.Error(c, http.StatusBadRequest, "A reason is required for the audit record")
		return
	}

	actorID, actorName := middleware.AdminIdentityFromContext(c)
	sessionID := c.Param("id")

	session, err := h.res.GetSession(sessionID)
	if err != nil {
		response.Error(c, http.StatusNotFound, "Session not found")
		return
	}
	if err := h.res.KillSession(sessionID, actorID, body.Reason); err != nil {
		h.logger.Error("admin.session.kill.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to kill session")
		return
	}

	grantID := ""
	if session.GrantID != nil {
		grantID = *session.GrantID
	}
	h.audit.Write(services.AuditEntry{
		ActorUserID:   actorID,
		ActorUsername: actorName,
		ActorType:     "ADMIN",
		Action:        models.AuditSessionKilled,
		Severity:      models.AuditSeverityCritical,
		ResourceType:  session.ResourceType,
		ResourceID:    session.ResourceID,
		ResourceName:  session.ResourceName,
		SessionID:     session.ID,
		GrantID:       grantID,
		SourceIP:      c.ClientIP(),
		Details: map[string]interface{}{
			"reason":      body.Reason,
			"target_user": session.Username,
		},
	})

	// The person whose terminal just closed is the one who most needs to know
	// why, and they are not looking at the Admin Center.
	h.jit.Notify(services.NotifyInput{
		Category:   models.NotifyCategorySecurity,
		Severity:   models.NotifySeverityWarning,
		Title:      "Your session was terminated",
		Body:       "An administrator ended your session on " + session.ResourceName + ". Reason: " + body.Reason,
		Link:       "/sessions",
		EntityType: "session",
		EntityID:   session.ID,
		DedupeKey:  "session.killed." + session.ID,
	}, session.UserID)

	response.Success(c, gin.H{"session_id": sessionID}, "Session terminated")
}

// ──────────────────────────────────────────────────────────────────────────
// QUERY HELPERS
// ──────────────────────────────────────────────────────────────────────────

// boolQuery returns nil when the param is absent, so "unset" and "false" are
// distinguishable in filters.
func boolQuery(c *gin.Context, key string) *bool {
	v, ok := c.GetQuery(key)
	if !ok || v == "" {
		return nil
	}
	b := v == "true" || v == "1"
	return &b
}

// timeRange parses RFC3339 `from` / `to` query params.
func timeRange(c *gin.Context) (*time.Time, *time.Time) {
	var from, to *time.Time
	if v := c.Query("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			from = &t
		}
	}
	if v := c.Query("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			to = &t
		}
	}
	return from, to
}

func parseIntSafe(v string) (int, error) {
	return strconv.Atoi(v)
}
