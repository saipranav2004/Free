// pam/internal/api/handlers/resource_handler.go
package handlers

import (
	"errors"
	"fmt"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/gateway"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

type ResourceHandler struct {
	svc    *services.ResourceService
	agent  *services.AgentService
	engine *services.PolicyEngineService
	// webProxyEnabled mirrors config.WebProxyConfig.Enabled. Passed as a
	// plain bool rather than the whole webproxy.Service because ConnectInfo
	// only needs to know whether to ADVERTISE the method — taking the
	// service here would make handlers depend on webproxy purely to read one
	// flag.
	webProxyEnabled bool
	logger          *zap.Logger
}

func NewResourceHandler(svc *services.ResourceService, agent *services.AgentService, engine *services.PolicyEngineService, webProxyEnabled bool, logger *zap.Logger) *ResourceHandler {
	return &ResourceHandler{svc: svc, agent: agent, engine: engine, webProxyEnabled: webProxyEnabled, logger: logger}
}

// canSeeResourceInCatalog reports whether resourceID should appear at all in
// ListGroups/List — the visibility tier of the three-tier per-resource model
// (List < Read < Connect, see opa/policies/default_bundle.json's comment on
// "resource-access-default-deny"). A resource shows up in the catalog the
// moment ANY of the three is granted: pam:resource:List alone surfaces just
// the entry (name/type) with nothing more — GET /resources/:id still
// separately requires pam:resource:Read, and connecting still separately
// requires pam:resource:Connect (both already gated per-resource by their
// own routes/middleware, unchanged here). Granting only Read or only Connect
// without List still makes sense to treat as "visible" — an admin who grants
// Connect obviously wants the user to be able to find the resource to use
// it. Deny-by-default: root/admin's full-access policy (resources: ["*"])
// still sees everything, but a standard user only ever sees the specific
// resources an admin explicitly granted via an RBAC role or a PBAC policy
// scoped to that resource's "pam:resource/<id>" pattern — there is no
// default "see all resources" grant anymore.
func canSeeResourceInCatalog(actx *services.AuthzContext, resourceID string) bool {
	pattern := fmt.Sprintf("pam:resource/%s", resourceID)
	return actx.Allowed("pam:resource:List", pattern) ||
		actx.Allowed("pam:resource:Read", pattern) ||
		actx.Allowed("pam:resource:Connect", pattern)
}

// ── LIST (grouped by type for the UI dashboard) ────────────────────────────

func (h *ResourceHandler) ListGroups(c *gin.Context) {
	userID, _ := c.Get("user_id")
	uid, _ := userID.(string)

	groups, err := h.svc.ListResourceGroups()
	if err != nil {
		h.logger.Error("resource.list_groups.fail", zap.Error(err))
		response.Error(c, 500, "Failed to fetch resources")
		return
	}

	actx, err := h.engine.ResolveAuthzContext(uid)
	if err != nil {
		h.logger.Error("resource.list_groups.authz_resolve.fail", zap.String("user_id", uid), zap.Error(err))
		response.Error(c, 500, "Failed to resolve access")
		return
	}

	filtered := make([]models.ResourceGroup, 0, len(groups))
	for _, g := range groups {
		visible := make([]models.PAMResource, 0, len(g.Resources))
		for _, r := range g.Resources {
			if canSeeResourceInCatalog(actx, r.ID) {
				visible = append(visible, r)
			}
		}
		if len(visible) > 0 {
			g.Resources = visible
			filtered = append(filtered, g)
		}
	}
	response.Success(c, gin.H{"groups": filtered}, "Resources fetched")
}

// ── LIST (flat, optional filter by type) ───────────────────────────────────

func (h *ResourceHandler) List(c *gin.Context) {
	userID, _ := c.Get("user_id")
	uid, _ := userID.(string)
	rtype := c.Query("type")

	resources, err := h.svc.ListResources(rtype)
	if err != nil {
		response.Error(c, 500, "Failed to fetch resources")
		return
	}

	actx, err := h.engine.ResolveAuthzContext(uid)
	if err != nil {
		h.logger.Error("resource.list.authz_resolve.fail", zap.String("user_id", uid), zap.Error(err))
		response.Error(c, 500, "Failed to resolve access")
		return
	}

	visible := make([]models.PAMResource, 0, len(resources))
	for _, r := range resources {
		if canSeeResourceInCatalog(actx, r.ID) {
			visible = append(visible, r)
		}
	}
	response.Success(c, gin.H{"resources": visible, "count": len(visible)}, "Resources fetched")
}

// ── GET single resource ────────────────────────────────────────────────────

func (h *ResourceHandler) Get(c *gin.Context) {
	r, err := h.svc.GetResource(c.Param("id"))
	if err != nil {
		response.Error(c, 404, "Resource not found")
		return
	}
	response.Success(c, gin.H{"resource": r}, "Resource fetched")
}

// ── CREATE resource (admin) ────────────────────────────────────────────────

type createResourceRequest struct {
	Name         string `json:"name" binding:"required"`
	Description  string `json:"description"`
	ResourceType string `json:"resource_type" binding:"required"`
	Host         string `json:"host" binding:"required"`
	Port         int    `json:"port" binding:"required"`
	DatabaseName string `json:"database_name"`
	ConnectMode  string `json:"connect_mode"` // web_terminal, embed_redirect
	ConsoleURL   string `json:"console_url"`
	ExtraConfig  string `json:"extra_config"` // JSON string
	// RequiresJIT/AlwaysRecord were previously not bindable here at all —
	// a resource could only ever be created with both defaulted to false,
	// with no way to mark it JIT-gated through the API. Fixed as part of
	// wiring resource management into the Admin Center: an admin creating a
	// resource can now actually decide, at creation time, whether it
	// requires a time-boxed grant to connect.
	RequiresJIT  bool `json:"requires_jit"`
	AlwaysRecord bool `json:"always_record"`

	// Data-protection policy (models/data_protection.go). Bindable at create
	// time so a resource can be onboarded already restricted, rather than
	// existing unprotected for however long it takes someone to PATCH it.
	BlockClipboard        bool   `json:"block_clipboard"`
	BlockDevTools         bool   `json:"block_devtools"`
	BlockDownload         bool   `json:"block_download"`
	Watermark             bool   `json:"watermark"`
	MaxEgressBytes        int64  `json:"max_egress_bytes"`
	AllowedConnectMethods string `json:"allowed_connect_methods"`
	DeniedCommands        string `json:"denied_commands"`
}

func (h *ResourceHandler) Create(c *gin.Context) {
	var req createResourceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, 400, "Invalid request: "+err.Error())
		return
	}
	if err := services.ValidateExtraConfigJSON(req.ExtraConfig); err != nil {
		response.Error(c, 400, err.Error())
		return
	}

	userID, _ := c.Get("user_id")
	r := &models.PAMResource{
		Name:         req.Name,
		Description:  req.Description,
		ResourceType: req.ResourceType,
		Host:         req.Host,
		Port:         req.Port,
		DatabaseName: req.DatabaseName,
		ConnectMode:  req.ConnectMode,
		ConsoleURL:   req.ConsoleURL,
		ExtraConfig:  req.ExtraConfig,
		RequiresJIT:  req.RequiresJIT,
		AlwaysRecord: req.AlwaysRecord,

		BlockClipboard:        req.BlockClipboard,
		BlockDevTools:         req.BlockDevTools,
		BlockDownload:         req.BlockDownload,
		Watermark:             req.Watermark,
		MaxEgressBytes:        req.MaxEgressBytes,
		AllowedConnectMethods: req.AllowedConnectMethods,
		DeniedCommands:        req.DeniedCommands,
		IsActive:              true,
		CreatedBy:             userID.(string),
	}
	if r.ConnectMode == "" {
		r.ConnectMode = "web_terminal"
	}

	if err := h.svc.CreateResource(r); err != nil {
		h.logger.Error("resource.create.fail", zap.Error(err))
		response.Error(c, 500, "Failed to create resource")
		return
	}

	h.logger.Info("resource.created",
		zap.String("id", r.ID),
		zap.String("name", r.Name),
		zap.String("type", r.ResourceType),
	)
	response.Created(c, gin.H{"resource": r}, "Resource created")
}

// ── UPDATE resource (admin) ────────────────────────────────────────────────
// Lets an admin fix a resource's connection details (host/port/console URL/
// extra_config/JIT+recording flags) in place — e.g. correcting a MinIO
// resource's use_ssl/region after it was created, or fixing a wrong console
// URL — without deleting and recreating the row, which would orphan its
// vault_entry_id linkage and connection-session history. Every field is
// optional; only fields present in the request body are changed, via the
// same UpdateResource(map[string]interface{}) the service already exposed
// but which, until now, no handler actually called.
type updateResourceRequest struct {
	Name         *string `json:"name"`
	Description  *string `json:"description"`
	Host         *string `json:"host"`
	Port         *int    `json:"port"`
	DatabaseName *string `json:"database_name"`
	ConnectMode  *string `json:"connect_mode"`
	ConsoleURL   *string `json:"console_url"`
	ExtraConfig  *string `json:"extra_config"`
	RequiresJIT  *bool   `json:"requires_jit"`
	AlwaysRecord *bool   `json:"always_record"`

	BlockClipboard        *bool   `json:"block_clipboard"`
	BlockDevTools         *bool   `json:"block_devtools"`
	BlockDownload         *bool   `json:"block_download"`
	Watermark             *bool   `json:"watermark"`
	MaxEgressBytes        *int64  `json:"max_egress_bytes"`
	AllowedConnectMethods *string `json:"allowed_connect_methods"`
	// Empty string is a meaningful value here, not "unset": it means "fall
	// back to the built-in patterns for this resource type". A pointer is
	// what lets the handler tell "clear it" from "leave it alone", which a
	// plain string could not.
	DeniedCommands *string `json:"denied_commands"`
	IsActive       *bool   `json:"is_active"`
}

func (h *ResourceHandler) Update(c *gin.Context) {
	var req updateResourceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, 400, "Invalid request: "+err.Error())
		return
	}
	if req.ExtraConfig != nil {
		if err := services.ValidateExtraConfigJSON(*req.ExtraConfig); err != nil {
			response.Error(c, 400, err.Error())
			return
		}
	}

	updates := map[string]interface{}{}
	if req.Name != nil {
		updates["name"] = *req.Name
	}
	if req.Description != nil {
		updates["description"] = *req.Description
	}
	if req.Host != nil {
		updates["host"] = *req.Host
	}
	if req.Port != nil {
		updates["port"] = *req.Port
	}
	if req.DatabaseName != nil {
		updates["database_name"] = *req.DatabaseName
	}
	if req.ConnectMode != nil {
		updates["connect_mode"] = *req.ConnectMode
	}
	if req.ConsoleURL != nil {
		updates["console_url"] = *req.ConsoleURL
	}
	if req.ExtraConfig != nil {
		updates["extra_config"] = *req.ExtraConfig
	}
	if req.RequiresJIT != nil {
		updates["requires_jit"] = *req.RequiresJIT
	}
	if req.BlockClipboard != nil {
		updates["block_clipboard"] = *req.BlockClipboard
	}
	if req.BlockDevTools != nil {
		updates["block_devtools"] = *req.BlockDevTools
	}
	if req.BlockDownload != nil {
		updates["block_download"] = *req.BlockDownload
	}
	if req.Watermark != nil {
		updates["watermark"] = *req.Watermark
	}
	if req.MaxEgressBytes != nil {
		updates["max_egress_bytes"] = *req.MaxEgressBytes
	}
	if req.DeniedCommands != nil {
		updates["denied_commands"] = *req.DeniedCommands
	}
	if req.AllowedConnectMethods != nil {
		updates["allowed_connect_methods"] = *req.AllowedConnectMethods
	}
	if req.AlwaysRecord != nil {
		updates["always_record"] = *req.AlwaysRecord
	}
	if req.IsActive != nil {
		updates["is_active"] = *req.IsActive
	}
	if len(updates) == 0 {
		response.Error(c, 400, "No updatable fields were provided")
		return
	}

	if err := h.svc.UpdateResource(c.Param("id"), updates); err != nil {
		if errors.Is(err, services.ErrResourceNotFound) {
			response.Error(c, 404, "Resource not found")
			return
		}
		h.logger.Error("resource.update.fail", zap.String("id", c.Param("id")), zap.Error(err))
		response.Error(c, 500, "Failed to update resource")
		return
	}

	r, err := h.svc.GetResource(c.Param("id"))
	if err != nil {
		response.Success(c, nil, "Resource updated")
		return
	}
	response.Success(c, gin.H{"resource": r}, "Resource updated")
}

// ── STORE CREDENTIAL (admin — encrypts and stores in vault) ───────────────

type storeCredentialRequest struct {
	AccountName    string `json:"account_name" binding:"required"` // username
	CredentialType string `json:"credential_type"`                 // password, api_key, connection_string
	Credential     string `json:"credential" binding:"required"`   // plaintext (encrypted before storage)
}

func (h *ResourceHandler) StoreCredential(c *gin.Context) {
	var req storeCredentialRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, 400, "Invalid request: "+err.Error())
		return
	}
	if req.CredentialType == "" {
		req.CredentialType = "password"
	}

	entry, err := h.svc.StoreCredential(
		c.Param("id"), req.AccountName, req.CredentialType, req.Credential,
	)
	if err != nil {
		h.logger.Error("vault.store.fail", zap.Error(err))
		response.Error(c, 500, "Failed to store credential")
		return
	}
	response.Created(c, gin.H{"vault_entry_id": entry.ID}, "Credential stored securely")
}

// ── ROTATE CREDENTIAL (admin) ──────────────────────────────────────────────

type rotateCredentialRequest struct {
	NewCredential string `json:"new_credential" binding:"required"`
}

func (h *ResourceHandler) RotateCredential(c *gin.Context) {
	var req rotateCredentialRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, 400, "new_credential is required")
		return
	}
	if err := h.svc.RotateCredential(c.Param("id"), req.NewCredential); err != nil {
		response.Error(c, 500, "Failed to rotate credential")
		return
	}
	response.Success(c, nil, "Credential rotated successfully")
}

// ── CONNECT INFO (returns safe connection details — no password) ──────────
// The frontend uses this to display the resource info before connecting.
// The actual credential is resolved server-side during the WebSocket handshake.

func (h *ResourceHandler) ConnectInfo(c *gin.Context) {
	resourceID := c.Param("id")
	userID, _ := c.Get("user_id")

	r, err := h.svc.GetResource(resourceID)
	if err != nil {
		response.Error(c, 404, "Resource not found")
		return
	}

	hasCredential := r.VaultEntryID != nil && *r.VaultEntryID != ""

	// available_methods / recommended_method — the concrete fix for "opening
	// a resource must always work": the frontend is never left to guess
	// whether the in-browser terminal, the native agent, or an embedded
	// console will actually work for this resource right now. web_terminal
	// is included whenever this resource type has a real protocol connector
	// (internal/gateway.SupportedResourceTypes) AND a credential is
	// configured — which makes it the one method that never depends on
	// anything the user has to install or an admin has to additionally
	// configure, so it is always the recommended (primary) method when it's
	// available at all. native_agent and web_app are additional, optional
	// methods layered on top, not substitutes — if either of them isn't
	// actually usable right now, they are simply absent from this list
	// rather than presented as a dead end.
	var methods []string
	if hasCredential && gateway.SupportedResourceTypes[r.ResourceType] {
		methods = append(methods, "web_terminal")
	}
	hasPairedAgent := false
	if h.agent != nil {
		if uid, ok := userID.(string); ok && uid != "" {
			if ok, err := h.agent.HasActiveDevice(uid); err == nil {
				hasPairedAgent = ok
			}
		}
	}
	if hasCredential && hasPairedAgent {
		methods = append(methods, "native_agent")
	}
	// web_proxy is the BROKERED browser path (internal/webproxy): PAM logs
	// into the target server-side and reverse-proxies it, so the operator
	// lands in the app already authenticated without the credential ever
	// reaching their browser. Listed ahead of the raw web_app console link
	// below because that link is the unbrokered fallback — it opens the
	// app's own login page and leaves the operator to authenticate
	// themselves, with no PAM session binding, no activity trail, and no
	// central kill switch.
	if hasCredential && r.ConsoleURL != "" && h.webProxyEnabled {
		methods = append(methods, "web_proxy")
	}
	if r.ConsoleURL != "" {
		methods = append(methods, "web_app")
	}
	// Drop any method the resource's connect-method policy forbids. Filtering
	// HERE, at the one place that tells the frontend what is possible, is what
	// keeps the UI from offering a button whose only outcome is a 403 — and
	// more importantly stops it advertising a route that would bypass the
	// resource's egress controls. The three entry points still enforce
	// independently (this is presentation, not the gate).
	methods = filterByConnectPolicy(r, methods)

	recommended := ""
	if len(methods) > 0 {
		recommended = methods[0]
	}

	policy := r.DataProtectionProfile()

	// Return safe info — NO password, NO decrypted credential.
	response.Success(c, gin.H{
		"resource_id":        r.ID,
		"name":               r.Name,
		"type":               r.ResourceType,
		"host":               r.Host,
		"port":               r.Port,
		"database_name":      r.DatabaseName,
		"connect_mode":       r.ConnectMode,
		"console_url":        r.ConsoleURL,
		"has_credential":     hasCredential,
		"has_paired_agent":   hasPairedAgent,
		"available_methods":  methods,
		"recommended_method": recommended,

		// permitted_methods is what the POLICY allows, independent of whether
		// a method happens to be usable right now. available_methods conflates
		// the two — "native_agent" is absent both when the policy forbids it
		// and when the user simply has not paired a device yet — and a UI that
		// cannot tell those apart either hides the pairing flow from someone
		// who needs it, or offers a button whose only outcome is a 403.
		"permitted_methods": permittedMethods(r),

		// Data-protection policy, so the console can reflect what the session
		// will actually be subject to instead of the operator discovering it
		// mid-session. `data_protection_active` is the honest summary: controls
		// are set AND the unenforceable connect path is closed (see
		// models.EgressControlled) — a UI that reports "protected" without
		// that second half is telling the client something untrue.
		"data_protection":        policy,
		"data_protection_active": models.EgressControlled(r.AllowedConnectMethods, policy),
	}, "Connection info retrieved")
}

// ── LIST SESSIONS (admin — see who's connected to what) ───────────────────

func (h *ResourceHandler) ListSessions(c *gin.Context) {
	activeOnly := c.Query("active") == "true"

	var sessions []models.ConnectionSession
	var err error
	if activeOnly {
		sessions, err = h.svc.ListActiveSessions()
	} else {
		err = h.db().Where("1=1").Order("started_at DESC").Limit(100).Find(&sessions).Error
	}

	if err != nil {
		response.Error(c, 500, "Failed to fetch sessions")
		return
	}
	response.Success(c, gin.H{"sessions": sessions, "count": len(sessions)}, "Sessions fetched")
}

// ── KILL SESSION (admin — terminate a user's connection) ──────────────────

type killSessionRequest struct {
	Reason string `json:"reason"`
}

func (h *ResourceHandler) KillSession(c *gin.Context) {
	sessionID := c.Param("id")
	var req killSessionRequest
	c.ShouldBindJSON(&req)
	if req.Reason == "" {
		req.Reason = "killed by admin"
	}

	killedBy, _ := c.Get("user_id")
	if err := h.svc.KillSession(sessionID, killedBy.(string), req.Reason); err != nil {
		response.Error(c, 500, "Failed to kill session")
		return
	}
	response.Success(c, gin.H{"session_id": sessionID}, "Session terminated")
}

// ── DELETE resource (soft delete) ──────────────────────────────────────────

func (h *ResourceHandler) Delete(c *gin.Context) {
	if err := h.svc.DeleteResource(c.Param("id")); err != nil {
		response.Error(c, 500, "Failed to delete resource")
		return
	}
	response.Success(c, nil, "Resource deleted")
}

// ── Helper: get DB from service ────────────────────────────────────────────

func (h *ResourceHandler) db() *gorm.DB {
	return h.svc.DB()
}

// filterByConnectPolicy removes advertised connect methods the resource's
// AllowedConnectMethods forbids.
//
// The two vocabularies differ and must be mapped rather than compared
// directly: this endpoint speaks the UI's names ("native_agent", "web_app")
// while the policy speaks models.ConnectMethod* ("agent"). Getting that
// mapping wrong fails silently in the dangerous direction — an unmapped name
// looks unrestricted and the method stays on offer.
//
// "web_app" is the UNBROKERED console link: PAM is not in its data path at
// all, so it is governed by the same rule as the native agent rather than
// treated as a browser method.
func filterByConnectPolicy(r *models.PAMResource, methods []string) []string {
	policyName := map[string]string{
		"web_terminal": models.ConnectMethodWebTerminal,
		"web_proxy":    models.ConnectMethodWebProxy,
		"native_agent": models.ConnectMethodAgent,
		"web_app":      models.ConnectMethodAgent,
	}

	out := make([]string, 0, len(methods))
	for _, m := range methods {
		name, known := policyName[m]
		if !known {
			// Unrecognised method: keep it, but it is a bug that a new connect
			// method was added without a policy mapping.
			out = append(out, m)
			continue
		}
		if r.AllowsConnectMethod(name) {
			out = append(out, m)
		}
	}
	return out
}

// permittedMethods lists every connect method this resource's policy allows,
// in the vocabulary this endpoint speaks, regardless of current usability.
func permittedMethods(r *models.PAMResource) []string {
	all := []string{"web_terminal", "web_proxy", "native_agent", "web_app"}
	out := make([]string, 0, len(all))
	for _, m := range all {
		if len(filterByConnectPolicy(r, []string{m})) == 1 {
			out = append(out, m)
		}
	}
	return out
}
