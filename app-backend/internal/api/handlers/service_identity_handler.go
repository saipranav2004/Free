// pam/internal/api/handlers/service_identity_handler.go
//
// Control-plane surface for provisioning the machine data plane. Mounted in
// the admin group (JWT + MFA + OPA), never on the service group, a service
// token must not be able to mint itself a broader one.
package handlers

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

type ServiceIdentityHandler struct {
	svc    *services.ServiceIdentityService
	logger *zap.Logger
}

func NewServiceIdentityHandler(svc *services.ServiceIdentityService, logger *zap.Logger) *ServiceIdentityHandler {
	return &ServiceIdentityHandler{svc: svc, logger: logger}
}

func (h *ServiceIdentityHandler) actor(c *gin.Context) string {
	if u := c.GetString("user_id"); u != "" {
		return u
	}
	return c.GetString("username")
}

// POST /admin/services
func (h *ServiceIdentityHandler) CreateIdentity(c *gin.Context) {
	var req struct {
		Name                string `json:"name" binding:"required"`
		Description         string `json:"description"`
		Environment         string `json:"environment"`
		OwnerID             string `json:"owner_id"`
		MaxSecretsPerMinute int    `json:"max_secrets_per_minute"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}

	// Default the owner to the creating admin rather than leaving it blank:
	// an unowned machine identity is one nobody is accountable for.
	ownerID := req.OwnerID
	if ownerID == "" {
		ownerID = h.actor(c)
	}

	identity, err := h.svc.CreateIdentity(c.Request.Context(),
		req.Name, req.Description, req.Environment, ownerID, h.actor(c), req.MaxSecretsPerMinute)
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Created(c, identity, "Service identity created successfully")
}

// GET /admin/services
func (h *ServiceIdentityHandler) ListIdentities(c *gin.Context) {
	out, err := h.svc.ListIdentities(c.Request.Context())
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, out, "Service identities retrieved successfully")
}

// POST /admin/services/:service/tokens
//
// The response carries the only copy of the token that will ever exist. The
// previous token stays valid until explicitly revoked, that overlap is what
// makes rotation a rolling deploy instead of an outage.
func (h *ServiceIdentityHandler) IssueToken(c *gin.Context) {
	noStore(c)

	var req struct {
		Description string `json:"description"`
		TTLDays     int    `json:"ttl_days"`
	}
	_ = c.ShouldBindJSON(&req)

	// Default to a finite lifetime. A non-expiring machine credential is a
	// permanent liability, and defaulting to "never expires" guarantees that
	// is what ends up in production.
	if req.TTLDays <= 0 {
		req.TTLDays = 90
	}

	issued, err := h.svc.IssueToken(c.Request.Context(),
		c.Param("service"), req.Description, h.actor(c),
		time.Duration(req.TTLDays)*24*time.Hour)
	if err != nil {
		h.writeErr(c, err)
		return
	}
	response.Created(c, issued, "Service token issued. Store it now, it cannot be retrieved again.")
}

// GET /admin/services/:service/tokens
func (h *ServiceIdentityHandler) ListTokens(c *gin.Context) {
	out, err := h.svc.ListTokens(c.Request.Context(), c.Param("service"))
	if err != nil {
		h.writeErr(c, err)
		return
	}
	response.Success(c, out, "Service tokens retrieved successfully")
}

// DELETE /admin/service-tokens/:token_id
func (h *ServiceIdentityHandler) RevokeToken(c *gin.Context) {
	if err := h.svc.RevokeToken(c.Request.Context(), c.Param("token_id"), h.actor(c)); err != nil {
		h.writeErr(c, err)
		return
	}
	response.Success(c, gin.H{"status": "revoked"}, "Service token revoked successfully")
}

// POST /admin/services/:service/disable
func (h *ServiceIdentityHandler) DisableIdentity(c *gin.Context) {
	if err := h.svc.DisableIdentity(c.Request.Context(), c.Param("service"), h.actor(c)); err != nil {
		h.writeErr(c, err)
		return
	}
	response.Success(c, gin.H{"status": "disabled"}, "Service identity disabled and all tokens revoked")
}

// POST /admin/services/:service/grants
func (h *ServiceIdentityHandler) GrantScope(c *gin.Context) {
	var req struct {
		Scope         string `json:"scope" binding:"required"`
		Reason        string `json:"reason" binding:"required"`
		MaxTTLSeconds int    `json:"max_ttl_seconds"`
		ExpiresInDays int    `json:"expires_in_days"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}

	// A WILDCARD GRANT IS A WHOLE-VAULT GRANT, so it is held to the same rule
	// as exporting the vault: root only. "prod-db/**" is a scope somebody
	// reasoned about; "*" is every secret in the product handed to a process,
	// and an administrator who can already read the vault by hand should not
	// be able to hand that reach to a machine without root agreeing.
	if scope := strings.Trim(strings.TrimSpace(req.Scope), "/"); scope == "*" || scope == "**" {
		rolesRaw, _ := c.Get("roles")
		roles, _ := rolesRaw.([]string)
		if !services.IsRoot(roles) {
			response.Error(c, http.StatusForbidden,
				"A grant covering every secret is restricted to the root account. Scope this grant to a safe or a folder instead.")
			return
		}
	}

	var expiresAt *time.Time
	if req.ExpiresInDays > 0 {
		t := time.Now().UTC().AddDate(0, 0, req.ExpiresInDays)
		expiresAt = &t
	}

	grant, err := h.svc.GrantScope(c.Request.Context(), c.Param("service"),
		req.Scope, req.Reason, h.actor(c), req.MaxTTLSeconds, expiresAt)
	if err != nil {
		h.writeErr(c, err)
		return
	}
	response.Created(c, grant, "Service grant created successfully")
}

// GET /admin/services/:service/grants
func (h *ServiceIdentityHandler) ListGrants(c *gin.Context) {
	out, err := h.svc.ListGrants(c.Request.Context(), c.Param("service"))
	if err != nil {
		h.writeErr(c, err)
		return
	}
	response.Success(c, out, "Service grants retrieved successfully")
}

// DELETE /admin/service-grants/:grant_id
func (h *ServiceIdentityHandler) RevokeGrant(c *gin.Context) {
	if err := h.svc.RevokeGrant(c.Request.Context(), c.Param("grant_id"), h.actor(c)); err != nil {
		h.writeErr(c, err)
		return
	}
	response.Success(c, gin.H{"status": "revoked"}, "Service grant revoked successfully")
}

func (h *ServiceIdentityHandler) writeErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, services.ErrIdentityNotFound):
		response.Error(c, http.StatusNotFound, "Service identity not found")
	case errors.Is(err, services.ErrTokenInvalid):
		response.Error(c, http.StatusNotFound, "Service token not found or already revoked")
	case errors.Is(err, services.ErrServiceDisabled):
		response.Error(c, http.StatusConflict, "Service identity is disabled")
	default:
		h.logger.Error("service_identity.request.failed", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, err.Error())
	}
}
