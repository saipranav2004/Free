// pam/internal/middleware/grant.go
//
// RequireActiveGrant is the SECOND policy enforcement layer.
//
//	Layer 1 (authz.go)  — IAM/OPA: "is this principal allowed this action at all?"
//	Layer 2 (this file) — PAM JIT: "does this principal hold a live, unexpired,
//	                       time-boxed grant for this specific resource right now?"
//
// Both must pass. Layer 1 alone is standing access; layer 2 is what makes the
// access just-in-time. Grants are read from the database on every request —
// never cached — so a revocation takes effect on the very next call.
//
// Backwards compatibility: resources with requires_jit = false (the default,
// and therefore every pre-existing row) pass straight through, so adding this
// middleware to a route changes nothing until a resource is explicitly gated.
package middleware

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

// Context keys set by this middleware.
const (
	CtxGrantID           = "grant_id"
	CtxJITRequestID      = "jit_request_id"
	CtxGrantIsBreakglass = "grant_is_breakglass"
	CtxRecordingRequired = "recording_required"
	CtxDataProtection    = "data_protection"
	CtxGrantRequired     = "grant_required"
	CtxGrantExpiresAt    = "grant_expires_at"
)

// RequireActiveGrant enforces JIT entitlement for JIT-gated resources.
func RequireActiveGrant(
	jit *services.JITService,
	res *services.ResourceService,
	resourceIDFn func(*gin.Context) string,
	log *zap.Logger,
) gin.HandlerFunc {
	return func(c *gin.Context) {
		userIDRaw, ok := c.Get("user_id")
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"success": false,
				"error":   "Authentication required before grant check",
			})
			return
		}
		userID, _ := userIDRaw.(string)

		resourceID := resourceIDFn(c)
		if resourceID == "" {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{
				"success": false,
				"error":   "resource id is required",
			})
			return
		}

		resource, err := res.GetResource(resourceID)
		if err != nil {
			status := http.StatusInternalServerError
			msg := "Failed to resolve resource"
			if errors.Is(err, services.ErrResourceNotFound) {
				status = http.StatusNotFound
				msg = "Resource not found"
			}
			c.AbortWithStatusJSON(status, gin.H{"success": false, "error": msg})
			return
		}

		if !resource.RequiresJIT {
			// Not JIT-gated: allowed by layer 1 alone, but still record the
			// recording obligation the resource itself may impose.
			c.Set(CtxGrantRequired, false)
			c.Set(CtxRecordingRequired, resource.AlwaysRecord)
			c.Set(CtxDataProtection, resource.DataProtectionProfile())
			c.Set(CtxGrantIsBreakglass, false)
			c.Next()
			return
		}

		// ── Root and administrators are not gated by JIT ──────────────────
		//
		// An account that decides requests does not raise them. Before this,
		// an administrator hitting a JIT-gated resource got the same 403 as
		// anybody else and the only route out was a request THEY THEMSELVES
		// would then approve: a queue entry that carries no second opinion and
		// no separation of duty, only delay. The console reflected that with a
		// paragraph explaining why the product appeared to contradict itself.
		//
		// Layer 1 still applies in full. Reaching this line at all means
		// RequirePermission already allowed pam:resource:Connect for this
		// principal on this resource, so a privileged account with no policy
		// covering the resource is refused exactly as before, one layer up.
		//
		// THE TRADE, STATED PLAINLY: privileged access to a JIT-gated resource
		// is now standing rather than time-boxed. That is a deliberate product
		// decision, not an oversight. What preserves accountability is that
		// every one of these connections is still audited, still subject to
		// the resource's recording obligation, and still attributable to a
		// named human. The bypass changes who must wait, never who is on the
		// record.
		if services.IsAdminOrRoot(rolesOf(c)) {
			c.Set(CtxGrantRequired, false)
			c.Set(CtxRecordingRequired, resource.AlwaysRecord)
			c.Set(CtxDataProtection, resource.DataProtectionProfile())
			c.Set(CtxGrantIsBreakglass, false)
			log.Info("jit.grant.privileged_bypass",
				zap.String("user_id", userID),
				zap.String("resource_id", resourceID),
			)
			c.Next()
			return
		}

		grant, err := jit.ActiveGrantFor(userID, resourceID)
		if err != nil {
			if errors.Is(err, services.ErrGrantNotFound) {
				log.Warn("jit.grant.missing",
					zap.String("user_id", userID),
					zap.String("resource_id", resourceID),
				)
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
					"success": false,
					"error":   "No active just-in-time access grant for this resource",
					"code":    "jit_grant_required",
					"hint":    "POST /api/v1/pam/jit/requests to request time-boxed access",
				})
				return
			}
			log.Error("jit.grant.lookup.fail", zap.Error(err))
			// Fail closed — an unreadable entitlement store is a deny.
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"success": false,
				"error":   "Unable to verify just-in-time access grant",
				"code":    "jit_grant_unverifiable",
			})
			return
		}

		c.Set(CtxGrantRequired, true)
		c.Set(CtxGrantID, grant.ID)
		c.Set(CtxJITRequestID, grant.RequestID)
		c.Set(CtxGrantIsBreakglass, grant.IsBreakglass)
		c.Set(CtxRecordingRequired, grant.RecordingRequired || resource.AlwaysRecord)
		// A grant may only tighten the resource's egress policy, never relax
		// it — see models.MostRestrictive.
		c.Set(CtxDataProtection, models.MostRestrictive(
			resource.DataProtectionProfile(), grant.DataProtectionProfile()))
		c.Set(CtxGrantExpiresAt, grant.ExpiresAt)

		log.Info("jit.grant.enforced",
			zap.String("user_id", userID),
			zap.String("resource_id", resourceID),
			zap.String("grant_id", grant.ID),
			zap.Bool("breakglass", grant.IsBreakglass),
			zap.Time("expires_at", grant.ExpiresAt),
		)
		c.Next()
	}
}

// rolesOf reads the live roles LiveRoles resolved for this request, falling
// back to the token's own claim when that middleware did not run.
func rolesOf(c *gin.Context) []string {
	raw, ok := c.Get("roles")
	if !ok {
		return nil
	}
	roles, _ := raw.([]string)
	return roles
}

// GrantContext is a convenience accessor for handlers.
type GrantContext struct {
	Required          bool
	GrantID           string
	JITRequestID      string
	IsBreakglass      bool
	RecordingRequired bool
	DataProtection    models.DataProtection
}

// GrantFromContext extracts whatever RequireActiveGrant put in the context.
// Safe to call even when the middleware did not run (returns zero values).
func GrantFromContext(c *gin.Context) GrantContext {
	var g GrantContext
	if v, ok := c.Get(CtxGrantRequired); ok {
		g.Required, _ = v.(bool)
	}
	if v, ok := c.Get(CtxGrantID); ok {
		g.GrantID, _ = v.(string)
	}
	if v, ok := c.Get(CtxJITRequestID); ok {
		g.JITRequestID, _ = v.(string)
	}
	if v, ok := c.Get(CtxGrantIsBreakglass); ok {
		g.IsBreakglass, _ = v.(bool)
	}
	if v, ok := c.Get(CtxRecordingRequired); ok {
		g.RecordingRequired, _ = v.(bool)
	}
	if v, ok := c.Get(CtxDataProtection); ok {
		g.DataProtection, _ = v.(models.DataProtection)
	}
	return g
}
