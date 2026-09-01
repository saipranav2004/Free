// pam/internal/api/handlers/identity_handler.go
//
// Identity Management — the Admin Center's user lifecycle screens. Full
// CRUD + lifecycle (activate/disable/lock-clear) + RBAC role assignment +
// PBAC direct policy attachment. Everything here sits behind
// middleware.RequireAdmin() (wired in main.go) — ordinary users never reach
// these routes.
package handlers

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/middleware"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

type IdentityHandler struct {
	identity *services.IdentityService
	logger   *zap.Logger
}

func NewIdentityHandler(identity *services.IdentityService, logger *zap.Logger) *IdentityHandler {
	return &IdentityHandler{identity: identity, logger: logger}
}

// List handles GET /api/v1/pam/admin/identity/users?q=
func (h *IdentityHandler) List(c *gin.Context) {
	users, truncated, err := h.identity.ListUsers(c.Query("q"))
	if err != nil {
		h.logger.Error("identity.list.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to list users")
		return
	}
	response.Success(c, gin.H{
		"users":     users,
		"count":     len(users),
		"truncated": truncated,
		"limit":     services.MaxUnpagedRows,
	}, "Users fetched")
}

// Get handles GET /api/v1/pam/admin/identity/users/:id
func (h *IdentityHandler) Get(c *gin.Context) {
	user, err := h.identity.GetUser(c.Param("id"))
	if err != nil {
		if errors.Is(err, services.ErrUserNotFound) {
			response.Error(c, http.StatusNotFound, "User not found")
			return
		}
		response.Error(c, http.StatusInternalServerError, "Failed to fetch user")
		return
	}
	access, err := h.identity.GetEffectiveAccess(user.UserID)
	if err != nil {
		h.logger.Error("identity.get.access.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to resolve effective access")
		return
	}
	response.Success(c, gin.H{"user": user, "access": access}, "User fetched")
}

type createUserRequest struct {
	Username  string   `json:"username" binding:"required"`
	Email     string   `json:"email" binding:"required"`
	FullName  string   `json:"full_name"`
	Password  string   `json:"password" binding:"required"`
	RoleNames []string `json:"role_names"`
}

// Create handles POST /api/v1/pam/admin/identity/users
func (h *IdentityHandler) Create(c *gin.Context) {
	var req createUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	if len(req.RoleNames) == 0 {
		// Defaulting to "user" rather than requiring the caller to always
		// spell it out — but never silently creating an account with NO
		// role at all, which would be a dead-end account nobody could use.
		req.RoleNames = []string{"user"}
	}

	actorID, _ := middleware.AdminIdentityFromContext(c)
	user, err := h.identity.CreateUser(services.CreateUserInput{
		Username: req.Username, Email: req.Email, FullName: req.FullName,
		Password: req.Password, RoleNames: req.RoleNames, CreatedBy: actorID,
	})
	if err != nil {
		h.respondCreateErr(c, err)
		return
	}
	response.Created(c, gin.H{"user": user}, "User created")
}

func (h *IdentityHandler) respondCreateErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, services.ErrUsernameTaken), errors.Is(err, services.ErrEmailTaken):
		response.Error(c, http.StatusConflict, err.Error())
	case errors.Is(err, services.ErrWeakPassword):
		response.Error(c, http.StatusBadRequest, err.Error())
	case errors.Is(err, services.ErrRoleNotFound):
		response.Error(c, http.StatusBadRequest, err.Error())
	default:
		h.logger.Error("identity.create.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to create user")
	}
}

type updateUserRequest struct {
	FullName *string `json:"full_name"`
	Email    *string `json:"email"`
}

// Update handles PATCH /api/v1/pam/admin/identity/users/:id
func (h *IdentityHandler) Update(c *gin.Context) {
	var req updateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	user, err := h.identity.UpdateUser(c.Param("id"), services.UpdateUserInput{FullName: req.FullName, Email: req.Email})
	if err != nil {
		if errors.Is(err, services.ErrEmailTaken) {
			response.Error(c, http.StatusConflict, err.Error())
			return
		}
		if errors.Is(err, services.ErrUserNotFound) {
			response.Error(c, http.StatusNotFound, "User not found")
			return
		}
		h.logger.Error("identity.update.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to update user")
		return
	}
	response.Success(c, gin.H{"user": user}, "User updated")
}

type setStatusRequest struct {
	Status string `json:"status" binding:"required"` // ACTIVE | DISABLED
}

// SetStatus handles POST /api/v1/pam/admin/identity/users/:id/status
func (h *IdentityHandler) SetStatus(c *gin.Context) {
	var req setStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	status := strings.ToUpper(strings.TrimSpace(req.Status))
	if status != "ACTIVE" && status != "DISABLED" {
		response.Error(c, http.StatusBadRequest, "status must be ACTIVE or DISABLED")
		return
	}
	if err := h.identity.SetStatus(c.Param("id"), status); err != nil {
		h.respondLifecycleErr(c, err)
		return
	}
	response.Success(c, gin.H{"user_id": c.Param("id"), "status": status}, "User status updated")
}

// Delete handles DELETE /api/v1/pam/admin/identity/users/:id
func (h *IdentityHandler) Delete(c *gin.Context) {
	if err := h.identity.DeleteUser(c.Param("id")); err != nil {
		h.respondLifecycleErr(c, err)
		return
	}
	response.Success(c, gin.H{"user_id": c.Param("id")}, "User deleted")
}

func (h *IdentityHandler) respondLifecycleErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, services.ErrUserNotFound):
		response.Error(c, http.StatusNotFound, "User not found")
	case errors.Is(err, services.ErrUserProtected):
		response.Error(c, http.StatusForbidden, err.Error())
	default:
		h.logger.Error("identity.lifecycle.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to update user")
	}
}

type resetPasswordRequest struct {
	NewPassword string `json:"new_password" binding:"required"`
}

// ResetPassword handles POST /api/v1/pam/admin/identity/users/:id/reset-password
func (h *IdentityHandler) ResetPassword(c *gin.Context) {
	var req resetPasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	// The LIVE roles the middleware resolved for this request, so an
	// administrator whose role was revoked mid-session cannot still spend it
	// here.
	rolesRaw, _ := c.Get("roles")
	actorRoles, _ := rolesRaw.([]string)

	if err := h.identity.ResetPassword(c.Param("id"), req.NewPassword, actorRoles); err != nil {
		if errors.Is(err, services.ErrWeakPassword) {
			response.Error(c, http.StatusBadRequest, err.Error())
			return
		}
		if errors.Is(err, services.ErrPasswordResetForbidden) {
			// Named plainly. An administrator refused here is not being told
			// about a bug; they are being told this particular account is
			// above their level, which is the answer they need.
			response.Error(c, http.StatusForbidden,
				"Resetting the password for a root or administrator account is restricted to the root account.")
			return
		}
		h.logger.Error("identity.reset_password.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to reset password")
		return
	}
	response.Success(c, gin.H{"user_id": c.Param("id")}, "Password reset")
}

type roleNameRequest struct {
	RoleName string `json:"role_name" binding:"required"`
}

// AssignRole handles POST /api/v1/pam/admin/identity/users/:id/roles
func (h *IdentityHandler) AssignRole(c *gin.Context) {
	var req roleNameRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	actorID, _ := middleware.AdminIdentityFromContext(c)
	if err := h.identity.AssignRole(c.Param("id"), req.RoleName, actorID); err != nil {
		if errors.Is(err, services.ErrRoleNotFound) {
			response.Error(c, http.StatusNotFound, err.Error())
			return
		}
		h.logger.Error("identity.assign_role.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to assign role")
		return
	}
	response.Success(c, gin.H{"user_id": c.Param("id"), "role_name": req.RoleName}, "Role assigned")
}

// RemoveRole handles DELETE /api/v1/pam/admin/identity/users/:id/roles/:role_name
func (h *IdentityHandler) RemoveRole(c *gin.Context) {
	if err := h.identity.RemoveRole(c.Param("id"), c.Param("role_name")); err != nil {
		if errors.Is(err, services.ErrRoleNotFound) {
			response.Error(c, http.StatusNotFound, err.Error())
			return
		}
		h.logger.Error("identity.remove_role.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to remove role")
		return
	}
	response.Success(c, gin.H{"user_id": c.Param("id")}, "Role removed")
}

type policyIDRequest struct {
	PolicyID string `json:"policy_id" binding:"required"`
}

// AttachPolicy handles POST /api/v1/pam/admin/identity/users/:id/policies
func (h *IdentityHandler) AttachPolicy(c *gin.Context) {
	var req policyIDRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	actorID, _ := middleware.AdminIdentityFromContext(c)
	if err := h.identity.AttachPolicy(c.Param("id"), req.PolicyID, actorID); err != nil {
		if errors.Is(err, services.ErrPolicyNotFound) {
			response.Error(c, http.StatusNotFound, err.Error())
			return
		}
		h.logger.Error("identity.attach_policy.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to attach policy")
		return
	}
	response.Success(c, gin.H{"user_id": c.Param("id"), "policy_id": req.PolicyID}, "Policy attached")
}

// DetachPolicy handles DELETE /api/v1/pam/admin/identity/users/:id/policies/:policy_id
func (h *IdentityHandler) DetachPolicy(c *gin.Context) {
	if err := h.identity.DetachPolicy(c.Param("id"), c.Param("policy_id")); err != nil {
		h.logger.Error("identity.detach_policy.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to detach policy")
		return
	}
	response.Success(c, gin.H{"user_id": c.Param("id")}, "Policy detached")
}
