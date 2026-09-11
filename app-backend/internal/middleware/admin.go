// pam/internal/middleware/admin.go
//
// The Admin Center gate.
//
// This used to authenticate the external IAM console via a shared service
// token (RequireServiceToken) plus a forwarded X-Admin-User-Id header to
// attribute actions to a human. That entire model is gone: the Admin Center
// is now a first-class part of this same PAM backend, reached by a real
// PAM user who logged in and holds the "root" or "admin" role — the same
// PAMAuth-issued JWT every other route uses. Attribution is automatic
// because the acting user's own identity (user_id/username, already set in
// context by PAMAuth) IS the admin's identity — there is no separate
// identity to forward.
package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/services"
)

// RequireAdmin gates the entire /api/v1/pam/admin group. It reads the
// "roles" claim PAMAuth already put in context (resolved from PAM's own
// RBAC tables at login time — see AuthService.issueTokensForUser) and
// requires "root" or "admin". No database call on this path: the JWT
// already carries the answer, which is deliberate — the Admin Center gate
// must stay fast and must not itself depend on a policy lookup that a
// misconfigured policy could ever lock every administrator out of.
func RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		rolesRaw, _ := c.Get("roles")
		roles, _ := rolesRaw.([]string)

		if !services.IsAdminOrRoot(roles) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"success": false,
				"error":   "Admin Center access requires the root or admin role",
				"code":    "admin_access_required",
			})
			return
		}
		c.Next()
	}
}

// RequireRoot narrows an action to root alone, for the handful of operations
// where "an administrator" is not a tight enough answer.
//
// Whole-vault backup and restore are the reason this exists. They were behind
// RequireAdmin, the same gate as reading a list of roles, which meant any
// administrator — including one delegated admin scoped to two resources, since
// a scope cannot narrow an operation that has no resource — could export every
// secret in the product or overwrite the vault from an object key they chose.
// Meanwhile revealing ONE credential needed a verified second factor and a
// per-credential permission check. The cheap action was the guarded one.
//
// Reads the live roles the LiveRoles middleware resolved, so an admin whose
// role was revoked mid-session is refused here on the next request rather than
// on the next sign-in.
func RequireRoot(what string) gin.HandlerFunc {
	return func(c *gin.Context) {
		rolesRaw, _ := c.Get("roles")
		roles, _ := rolesRaw.([]string)

		if !services.IsRoot(roles) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"success": false,
				"error":   what + " is restricted to the root account.",
				"code":    "root_required",
			})
			return
		}
		c.Next()
	}
}

// AdminIdentityFromContext returns the acting administrator's identity for
// audit attribution. Now simply the authenticated PAM user — kept as a
// named helper (rather than inlining c.Get calls at every call site) so
// admin_handler.go's existing call sites needed no changes at all.
func AdminIdentityFromContext(c *gin.Context) (userID, username string) {
	if v, ok := c.Get("user_id"); ok {
		userID, _ = v.(string)
	}
	if v, ok := c.Get("username"); ok {
		username, _ = v.(string)
	}
	return userID, username
}
