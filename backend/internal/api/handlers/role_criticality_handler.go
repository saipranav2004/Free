// pam/internal/api/handlers/role_criticality_handler.go
//
// HTTP surface for role criticality classification. See
// internal/services/role_criticality_service.go for the scoring model and the
// reasoning behind it.
//
// Four routes, mounted under the existing admin RBAC group so they inherit
// PAMAuth, the audit middleware, and RequireAdmin without restating any of it:
//
//	GET    /admin/rbac/criticality              estate-wide classification
//	GET    /admin/rbac/roles/:id/criticality    one role, with its evidence
//	PUT    /admin/rbac/roles/:id/criticality    set a reviewer override
//	DELETE /admin/rbac/roles/:id/criticality    clear it, back to computed
//
// This lives in its own file rather than inside rbac_handler.go so the feature
// is additive: nothing that already worked had to be edited to land it.
package handlers

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

// RoleCriticalityHandler serves the classification endpoints.
type RoleCriticalityHandler struct {
	criticality *services.RoleCriticalityService
	logger      *zap.Logger
}

// NewRoleCriticalityHandler wires the handler.
func NewRoleCriticalityHandler(criticality *services.RoleCriticalityService, logger *zap.Logger) *RoleCriticalityHandler {
	return &RoleCriticalityHandler{criticality: criticality, logger: logger}
}

// Summary handles GET /api/v1/pam/admin/rbac/criticality
//
// Returns every role classified and sorted most critical first, plus the band
// counts. One call, so the Roles table can render a criticality column without
// a request per row.
func (h *RoleCriticalityHandler) Summary(c *gin.Context) {
	summary, err := h.criticality.Summary()
	if err != nil {
		h.logger.Error("rbac.criticality.summary.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to classify roles")
		return
	}
	response.Success(c, summary, "Role criticality classified")
}

// Get handles GET /api/v1/pam/admin/rbac/roles/:id/criticality
//
// The single-role view, carrying the per-factor evidence the drawer renders.
func (h *RoleCriticalityHandler) Get(c *gin.Context) {
	result, err := h.criticality.Get(c.Param("id"))
	if err != nil {
		if errors.Is(err, services.ErrCriticalityRoleNotFound) {
			response.Error(c, http.StatusNotFound, "Role not found")
			return
		}
		h.logger.Error("rbac.criticality.get.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to classify role")
		return
	}
	response.Success(c, result, "Role criticality classified")
}

type setCriticalityRequest struct {
	// Band is one of CRITICAL, HIGH, MODERATE, LOW.
	Band string `json:"band" binding:"required"`
	// Reason is mandatory. An override with no justification is
	// indistinguishable from a mistake once the reviewer has moved on.
	Reason string `json:"reason" binding:"required"`
}

// SetOverride handles PUT /api/v1/pam/admin/rbac/roles/:id/criticality
//
// Records a reviewer's explicit classification. It replaces the computed band
// until cleared, and is written to the audit trail with the reason and with
// what the engine had computed at the time.
func (h *RoleCriticalityHandler) SetOverride(c *gin.Context) {
	var req setCriticalityRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "A band and a reason are both required")
		return
	}

	actorID := c.GetString("user_id")
	actorName := c.GetString("username")

	result, err := h.criticality.SetOverride(c.Request.Context(), services.SetOverrideInput{
		RoleID:    c.Param("id"),
		Band:      req.Band,
		Reason:    req.Reason,
		ActorID:   actorID,
		ActorName: actorName,
	})
	if err != nil {
		switch {
		case errors.Is(err, services.ErrCriticalityRoleNotFound):
			response.Error(c, http.StatusNotFound, "Role not found")
		case errors.Is(err, services.ErrInvalidBand):
			response.Error(c, http.StatusBadRequest, "Band must be one of CRITICAL, HIGH, MODERATE or LOW")
		case errors.Is(err, services.ErrReasonRequired):
			response.Error(c, http.StatusBadRequest, "A reason is required to override a criticality classification")
		default:
			h.logger.Error("rbac.criticality.override.set.fail", zap.Error(err))
			response.Error(c, http.StatusInternalServerError, "Failed to set the criticality override")
		}
		return
	}
	response.Success(c, result, "Criticality override set")
}

type clearCriticalityRequest struct {
	// Reason is optional here. Clearing hands the role back to the engine,
	// which is the safe direction, so it is not gated the way setting is.
	Reason string `json:"reason"`
}

// ClearOverride handles DELETE /api/v1/pam/admin/rbac/roles/:id/criticality
//
// Returns the role to whatever the engine derives.
func (h *RoleCriticalityHandler) ClearOverride(c *gin.Context) {
	// The body is optional on a DELETE, so a bind failure is not an error
	// here: it just means no reason was sent.
	var req clearCriticalityRequest
	_ = c.ShouldBindJSON(&req)

	result, err := h.criticality.ClearOverride(
		c.Request.Context(),
		c.Param("id"),
		c.GetString("user_id"),
		c.GetString("username"),
		req.Reason,
	)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrCriticalityRoleNotFound):
			response.Error(c, http.StatusNotFound, "Role not found")
		case errors.Is(err, services.ErrNoOverride):
			response.Error(c, http.StatusNotFound, "This role has no criticality override to clear")
		default:
			h.logger.Error("rbac.criticality.override.clear.fail", zap.Error(err))
			response.Error(c, http.StatusInternalServerError, "Failed to clear the criticality override")
		}
		return
	}
	response.Success(c, result, "Criticality override cleared")
}
