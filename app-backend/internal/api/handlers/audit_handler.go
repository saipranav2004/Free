// pam/internal/api/handlers/audit_handler.go
package handlers

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

type AuditHandler struct {
	queries *services.AuditQueryService
	reports *services.ReportService
	audit   *services.AuditService
	log     *zap.Logger
}

func NewAuditHandler(q *services.AuditQueryService, r *services.ReportService, a *services.AuditService, log *zap.Logger) *AuditHandler {
	return &AuditHandler{queries: q, reports: r, audit: a, log: log}
}

// ─── Caller scope ─────────────────────────────────────────────────────────
//
// EVERY ROUTE IN THIS FILE IS SELF-SERVICE. The org-wide trail lives under
// /api/v1/pam/admin/audit, behind RequireAdmin.
//
// That distinction was not being enforced. These routes are guarded by the
// pam:audit:Read permission, and the seeded standard-user-access policy grants
// exactly that on resources ["*"], as it has to, or a user could not read
// their own trail at all. So the permission check passed for everybody, and then
// Search filtered on a `user_id` QUERY PARAMETER supplied by the caller.
// Omitting it returned the whole organisation's audit log; setting it to
// somebody else's id returned theirs. Same for /audit/user/:user_id, which
// took the id straight from the path.
//
// callerScope answers "whose trail may this request see": the empty string for
// root and admin, meaning no restriction, and the caller's own id for everyone
// else. The scope is read from the token, never from the request, so there is
// no parameter to tamper with.
func callerScope(c *gin.Context) (userID string, unrestricted bool) {
	raw, _ := c.Get("user_id")
	uid, _ := raw.(string)
	rolesRaw, _ := c.Get("roles")
	roles, _ := rolesRaw.([]string)
	if services.IsAdminOrRoot(roles) {
		return uid, true
	}
	return uid, false
}

// ownRowsOnly drops entries that are not the caller's. Used by the lookups
// that take an identifier rather than a filter set, where narrowing the query
// itself would change what the identifier means.
func ownRowsOnly(rows []models.AuditLog, userID string) []models.AuditLog {
	out := make([]models.AuditLog, 0, len(rows))
	for _, r := range rows {
		if r.UserID == userID {
			out = append(out, r)
		}
	}
	return out
}

// ─── Search (Feature 107) ─────────────────────────────────────────────

// Search handles GET /api/v1/pam/audit
//
// Query parameters:
//
//	q            — free text (matches username, email, resource, action, details, justification)
//	user_id      — exact
//	username     — exact
//	category     — AUTH | AUTHZ | VAULT | SESSION | RESOURCE | BREAK_GLASS | ADMIN | REPORT
//	action       — exact, e.g. "pam:vault:Store"
//	outcome      — SUCCESS | DENIED | ERROR | PENDING
//	resource     — exact
//	resource_prefix — LIKE prefix
//	source_ip    — exact
//	from         — RFC3339
//	to           — RFC3339
//	limit, offset — pagination
//	sort         — occurred_at_desc (default) | occurred_at_asc | sequence_desc
func (h *AuditHandler) Search(c *gin.Context) {
	f := services.SearchFilters{
		OrgID:          c.Query("org_id"),
		UserID:         c.Query("user_id"),
		Username:       c.Query("username"),
		Category:       models.AuditCategory(c.Query("category")),
		Action:         c.Query("action"),
		Outcome:        models.AuditOutcome(c.Query("outcome")),
		Resource:       c.Query("resource"),
		ResourcePrefix: c.Query("resource_prefix"),
		SourceIP:       c.Query("source_ip"),
		Query:          c.Query("q"),
		Sort:           c.Query("sort"),
	}
	if v := c.Query("limit"); v != "" {
		f.Limit, _ = strconv.Atoi(v)
	}
	if v := c.Query("offset"); v != "" {
		f.Offset, _ = strconv.Atoi(v)
	}
	if v := c.Query("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.FromTime = &t
		}
	}
	if v := c.Query("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.ToTime = &t
		}
	}

	// The scope is imposed AFTER the query string is parsed, so it overwrites
	// whatever the caller asked for rather than merging with it. Username and
	// OrgID go too: either one alone would reopen the same hole that scoping
	// UserID closes.
	if uid, unrestricted := callerScope(c); !unrestricted {
		f.UserID = uid
		f.Username = ""
		f.OrgID = ""
	}

	res, err := h.queries.Search(c.Request.Context(), f)
	if err != nil {
		h.log.Error("audit.search.fail", zap.Error(err))
		response.Error(c, 500, "Search failed")
		return
	}
	response.Success(c, res, "Search results")
}

// ByRequest handles GET /api/v1/pam/audit/request/:request_id
// MyStats handles GET /api/v1/pam/audit/stats
//
// The self-service twin of AdminHandler.AuditStats: the same aggregates,
// forced to the caller's own events.
//
// Exists so "All events" means the same thing on both dashboards. Without it
// the personal dashboard would still be walking rows and capped, and the same
// control would silently mean two different things depending on who is
// looking, which is worse than not offering it.
//
// ActorUserID is taken from the token and NOT from a query parameter, so this
// cannot be turned into a way to read somebody else's trail.
func (h *AuditHandler) MyStats(c *gin.Context) {
	userID, ok := c.Get("user_id")
	if !ok {
		response.Error(c, http.StatusUnauthorized, "Not authenticated")
		return
	}
	from, to := timeRange(c)

	stats, err := h.audit.Stats(services.AuditFilter{
		ActorUserID: userID.(string),
		From:        from,
		To:          to,
	}, c.Query("span"), c.Query("tz"))
	if err != nil {
		h.log.Error("audit.my_stats.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to compute activity statistics")
		return
	}
	response.Success(c, stats, "Activity statistics computed")
}

func (h *AuditHandler) ByRequest(c *gin.Context) {
	rid := c.Param("request_id")
	if rid == "" {
		response.Error(c, 400, "request_id is required")
		return
	}
	rows, err := h.queries.ByRequestID(c.Request.Context(), rid)
	if err != nil {
		h.log.Error("audit.byrequest.fail", zap.Error(err))
		response.Error(c, 500, "Lookup failed")
		return
	}
	// A request trace spans everyone who touched it, approvers included. A
	// standard user gets their own half of it; the full trace is an
	// administrative view and lives in the Admin Center.
	if uid, unrestricted := callerScope(c); !unrestricted {
		rows = ownRowsOnly(rows, uid)
	}
	response.Success(c, rows, "Request trace")
}

// ByUser handles GET /api/v1/pam/audit/user/:user_id
func (h *AuditHandler) ByUser(c *gin.Context) {
	uid := c.Param("user_id")
	limit, _ := strconv.Atoi(c.Query("limit"))

	// Refused rather than silently rewritten to the caller's own id: asking
	// for somebody else's trail here is not a filter the server may quietly
	// correct, it is a request that must not succeed.
	if caller, unrestricted := callerScope(c); !unrestricted && uid != caller {
		response.Error(c, http.StatusForbidden, "You may only read your own activity")
		return
	}
	rows, err := h.queries.ByUser(c.Request.Context(), uid, limit)
	if err != nil {
		h.log.Error("audit.byuser.fail", zap.Error(err))
		response.Error(c, 500, "Lookup failed")
		return
	}
	response.Success(c, rows, "User activity")
}

// ByResource handles GET /api/v1/pam/audit/resource/*resource
func (h *AuditHandler) ByResource(c *gin.Context) {
	r := c.Param("resource")
	limit, _ := strconv.Atoi(c.Query("limit"))
	rows, err := h.queries.ByResource(c.Request.Context(), r, limit)
	if err != nil {
		h.log.Error("audit.byresource.fail", zap.Error(err))
		response.Error(c, 500, "Lookup failed")
		return
	}
	// "Who else has been on this box" is an administrative question.
	if uid, unrestricted := callerScope(c); !unrestricted {
		rows = ownRowsOnly(rows, uid)
	}
	response.Success(c, rows, "Resource activity")
}

// VerifyChain handles GET /api/v1/pam/audit/verify
func (h *AuditHandler) VerifyChain(c *gin.Context) {
	org := c.DefaultQuery("org_id", "default")
	res, err := h.audit.VerifyChain(c.Request.Context(), org)
	if err != nil {
		h.log.Error("audit.verify.fail", zap.Error(err))
		response.Error(c, 500, "Verify failed")
		return
	}
	if !res.Valid {
		// 200 with valid=false is the right call here — the request itself
		// succeeded; the *chain* is what's bad. An auditor paging on this
		// status needs the body, not an HTTP error.
		c.JSON(http.StatusOK, res)
		return
	}
	response.Success(c, res, "Chain intact")
}

// ─── Reports (Feature 106) ────────────────────────────────────────────

type reportRequestBody struct {
	FromTime   string   `json:"from"`
	ToTime     string   `json:"to"`
	Format     string   `json:"format"` // "pdf" or "csv"
	Title      string   `json:"title"`
	Frameworks []string `json:"frameworks"`

	UserID         string `json:"user_id"`
	Username       string `json:"username"`
	Category       string `json:"category"`
	Action         string `json:"action"`
	Outcome        string `json:"outcome"`
	ResourcePrefix string `json:"resource_prefix"`
}

// Generate handles POST /api/v1/pam/audit/report
func (h *AuditHandler) Generate(c *gin.Context) {
	var body reportRequestBody
	if err := c.ShouldBindJSON(&body); err != nil {
		response.Error(c, 400, "invalid request body: "+err.Error())
		return
	}
	from, err := time.Parse(time.RFC3339, body.FromTime)
	if err != nil {
		response.Error(c, 400, "from must be RFC3339")
		return
	}
	to, err := time.Parse(time.RFC3339, body.ToTime)
	if err != nil {
		response.Error(c, 400, "to must be RFC3339")
		return
	}
	format := services.ReportFormat(body.Format)
	if format == "" {
		format = services.FormatPDF
	}
	if format != services.FormatPDF && format != services.FormatCSV {
		response.Error(c, 400, "format must be 'pdf' or 'csv'")
		return
	}

	userID, _ := c.Get("user_id")
	uidStr, _ := userID.(string)

	// THE REPORT IS A QUERY, SO IT IS SCOPED LIKE ONE. This route took UserID
	// straight from the request body while the seeded standard-user policy
	// holds pam:report:Generate on "*", so a standard user could ask for a
	// signed compliance report over the whole organisation and get one: a
	// downloadable file, formatted for auditors, containing everybody's
	// sign-ins, reveals and connections.
	//
	// It is the same hole as the one closed on Search, ByUser, ByResource and
	// ByRequest, on the one route in this file that does not read the log
	// directly. A report is a harder failure than a listing, because the
	// output leaves the console as a file.
	scopedUserID := body.UserID
	scopedUsername := body.Username
	if caller, unrestricted := callerScope(c); !unrestricted {
		scopedUserID = caller
		scopedUsername = ""
	}

	req := services.ReportRequest{
		OrgID:             "default",
		FromTime:          from,
		ToTime:            to,
		Format:            format,
		GeneratedBy:       uidStr,
		ReportTitle:       body.Title,
		ControlFrameworks: body.Frameworks,
		UserID:            scopedUserID,
		Username:          scopedUsername,
		Category:          models.AuditCategory(body.Category),
		Action:            body.Action,
		Outcome:           models.AuditOutcome(body.Outcome),
		ResourcePrefix:    body.ResourcePrefix,
	}

	res, err := h.reports.Build(c.Request.Context(), req)
	if err != nil {
		h.log.Error("audit.report.fail", zap.Error(err))
		response.Error(c, 500, "Report generation failed: "+err.Error())
		return
	}

	c.Header("Content-Disposition", "attachment; filename=\""+res.Filename+"\"")
	if format == services.FormatPDF {
		c.Data(http.StatusOK, "application/pdf", res.Bytes)
	} else {
		c.Data(http.StatusOK, "text/csv; charset=utf-8", res.Bytes)
	}
}
