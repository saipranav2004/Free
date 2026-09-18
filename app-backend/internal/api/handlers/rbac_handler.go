// pam/internal/api/handlers/rbac_handler.go
//
// RBAC (Roles) and PBAC (Policies) management — the Admin Center screens
// for defining what a role or policy IS. Sits behind
// middleware.RequireAdmin(), same as identity_handler.go.
package handlers

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

// ── ROLES ──────────────────────────────────────────────────────────────────

type RoleHandler struct {
	roles  *services.RoleService
	logger *zap.Logger
}

func NewRoleHandler(roles *services.RoleService, logger *zap.Logger) *RoleHandler {
	return &RoleHandler{roles: roles, logger: logger}
}

// List handles GET /api/v1/pam/admin/rbac/roles
func (h *RoleHandler) List(c *gin.Context) {
	roles, truncated, err := h.roles.List()
	if err != nil {
		h.logger.Error("rbac.role.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to list roles")
		return
	}
	response.Success(c, gin.H{
		"roles":     roles,
		"truncated": truncated,
		"limit":     services.MaxUnpagedRows,
	}, "Roles fetched")
}

// Get handles GET /api/v1/pam/admin/rbac/roles/:id
func (h *RoleHandler) Get(c *gin.Context) {
	role, err := h.roles.Get(c.Param("id"))
	if err != nil {
		if errors.Is(err, services.ErrRoleNotFound) {
			response.Error(c, http.StatusNotFound, "Role not found")
			return
		}
		response.Error(c, http.StatusInternalServerError, "Failed to fetch role")
		return
	}
	policies, err := h.roles.ListPolicies(role.ID)
	if err != nil {
		h.logger.Error("rbac.role.get.policies.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to fetch role policies")
		return
	}
	response.Success(c, gin.H{"role": role, "policies": policies}, "Role fetched")
}

type createRoleRequest struct {
	Name        string `json:"name" binding:"required"`
	Description string `json:"description"`
}

// Create handles POST /api/v1/pam/admin/rbac/roles
func (h *RoleHandler) Create(c *gin.Context) {
	var req createRoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	role, err := h.roles.Create(req.Name, req.Description)
	if err != nil {
		response.Error(c, http.StatusConflict, err.Error())
		return
	}
	response.Created(c, gin.H{"role": role}, "Role created")
}

type updateRoleRequest struct {
	Description string `json:"description"`
}

// Update handles PATCH /api/v1/pam/admin/rbac/roles/:id
func (h *RoleHandler) Update(c *gin.Context) {
	var req updateRoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	role, err := h.roles.Update(c.Param("id"), req.Description)
	if err != nil {
		if errors.Is(err, services.ErrRoleNotFound) {
			response.Error(c, http.StatusNotFound, "Role not found")
			return
		}
		h.logger.Error("rbac.role.update.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to update role")
		return
	}
	response.Success(c, gin.H{"role": role}, "Role updated")
}

// Delete handles DELETE /api/v1/pam/admin/rbac/roles/:id
func (h *RoleHandler) Delete(c *gin.Context) {
	if err := h.roles.Delete(c.Param("id")); err != nil {
		switch {
		case errors.Is(err, services.ErrRoleNotFound):
			response.Error(c, http.StatusNotFound, "Role not found")
		case errors.Is(err, services.ErrRoleIsSystem):
			response.Error(c, http.StatusForbidden, err.Error())
		default:
			h.logger.Error("rbac.role.delete.fail", zap.Error(err))
			response.Error(c, http.StatusInternalServerError, "Failed to delete role")
		}
		return
	}
	response.Success(c, gin.H{"role_id": c.Param("id")}, "Role deleted")
}

type policyIDBody struct {
	PolicyID string `json:"policy_id" binding:"required"`
}

// AttachPolicy handles POST /api/v1/pam/admin/rbac/roles/:id/policies
func (h *RoleHandler) AttachPolicy(c *gin.Context) {
	var req policyIDBody
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	if err := h.roles.AttachPolicy(c.Param("id"), req.PolicyID); err != nil {
		h.logger.Error("rbac.role.attach_policy.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to attach policy")
		return
	}
	response.Success(c, gin.H{"role_id": c.Param("id"), "policy_id": req.PolicyID}, "Policy attached to role")
}

// DetachPolicy handles DELETE /api/v1/pam/admin/rbac/roles/:id/policies/:policy_id
func (h *RoleHandler) DetachPolicy(c *gin.Context) {
	if err := h.roles.DetachPolicy(c.Param("id"), c.Param("policy_id")); err != nil {
		h.logger.Error("rbac.role.detach_policy.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to detach policy")
		return
	}
	response.Success(c, gin.H{"role_id": c.Param("id")}, "Policy detached from role")
}

// ── POLICIES ────────────────────────────────────────────────────────────────

type PolicyHandler struct {
	policies *services.PolicyService
	logger   *zap.Logger
}

func NewPolicyHandler(policies *services.PolicyService, logger *zap.Logger) *PolicyHandler {
	return &PolicyHandler{policies: policies, logger: logger}
}

// List handles GET /api/v1/pam/admin/rbac/policies
func (h *PolicyHandler) List(c *gin.Context) {
	policies, truncated, err := h.policies.List()
	if err != nil {
		h.logger.Error("rbac.policy.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to list policies")
		return
	}
	response.Success(c, gin.H{
		"policies":  policies,
		"truncated": truncated,
		"limit":     services.MaxUnpagedRows,
	}, "Policies fetched")
}

// Get handles GET /api/v1/pam/admin/rbac/policies/:id
func (h *PolicyHandler) Get(c *gin.Context) {
	policy, err := h.policies.Get(c.Param("id"))
	if err != nil {
		if errors.Is(err, services.ErrPolicyNotFound) {
			response.Error(c, http.StatusNotFound, "Policy not found")
			return
		}
		response.Error(c, http.StatusInternalServerError, "Failed to fetch policy")
		return
	}
	response.Success(c, gin.H{"policy": policy}, "Policy fetched")
}

type createPolicyRequest struct {
	Name        string   `json:"name" binding:"required"`
	Description string   `json:"description"`
	Effect      string   `json:"effect" binding:"required"`
	Actions     []string `json:"actions" binding:"required"`
	Resources   []string `json:"resources" binding:"required"`
}

// Create handles POST /api/v1/pam/admin/rbac/policies
func (h *PolicyHandler) Create(c *gin.Context) {
	var req createPolicyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	policy, err := h.policies.Create(services.CreatePolicyInput{
		Name: req.Name, Description: req.Description, Effect: req.Effect,
		Actions: req.Actions, Resources: req.Resources,
	})
	if err != nil {
		response.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	response.Created(c, gin.H{"policy": policy}, "Policy created")
}

type updatePolicyRequest struct {
	Description *string  `json:"description"`
	Effect      *string  `json:"effect"`
	Actions     []string `json:"actions"`
	Resources   []string `json:"resources"`
}

// Update handles PATCH /api/v1/pam/admin/rbac/policies/:id
func (h *PolicyHandler) Update(c *gin.Context) {
	var req updatePolicyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	policy, err := h.policies.Update(c.Param("id"), services.UpdatePolicyInput{
		Description: req.Description, Effect: req.Effect,
		Actions: req.Actions, Resources: req.Resources,
	})
	if err != nil {
		if errors.Is(err, services.ErrPolicyNotFound) {
			response.Error(c, http.StatusNotFound, "Policy not found")
			return
		}
		response.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	response.Success(c, gin.H{"policy": policy}, "Policy updated")
}

// Delete handles DELETE /api/v1/pam/admin/rbac/policies/:id
func (h *PolicyHandler) Delete(c *gin.Context) {
	if err := h.policies.Delete(c.Param("id")); err != nil {
		switch {
		case errors.Is(err, services.ErrPolicyNotFound):
			response.Error(c, http.StatusNotFound, "Policy not found")
		case errors.Is(err, services.ErrPolicyIsSystem):
			response.Error(c, http.StatusForbidden, err.Error())
		default:
			h.logger.Error("rbac.policy.delete.fail", zap.Error(err))
			response.Error(c, http.StatusInternalServerError, "Failed to delete policy")
		}
		return
	}
	response.Success(c, gin.H{"policy_id": c.Param("id")}, "Policy deleted")
}
