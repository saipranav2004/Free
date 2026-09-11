// pam/internal/middleware/root.go
package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/services"
)

// RequireRoot narrows a route to the root role alone.
//
// RequireAdmin already covers "root or admin" and gates the whole Admin
// Center. This is for the few controls where admin is not enough because the
// control governs who can reach the product at all: an admin who could edit
// the network allowlist could lock out root, or open the console to a range
// root never sanctioned. Reads the same "roles" claim RequireAdmin does, so
// it adds no database call to the request path.
func RequireRoot() gin.HandlerFunc {
	return func(c *gin.Context) {
		rolesRaw, _ := c.Get("roles")
		roles, _ := rolesRaw.([]string)

		if !services.IsRoot(roles) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"success": false,
				"error":   "This setting can only be changed by the root account",
				"code":    "root_access_required",
			})
			return
		}
		c.Next()
	}
}
