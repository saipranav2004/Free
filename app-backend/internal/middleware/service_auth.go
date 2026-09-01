// pam/internal/middleware/service_auth.go
//
// PEP for the vault's machine data plane.
//
// This must be mounted on its OWN route group. Chaining it after PAMAuth on
// the human group makes every endpoint in that group demand a user JWT AND a
// service token simultaneously, which 401s all human traffic, the two are
// alternative authentication schemes for two different planes, not layers.
package middleware

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

// Context keys set on success. Handlers read these, never the raw token.
const (
	CtxServicePrincipal = "service_principal"
	CtxServiceID        = "service_id"
	CtxServiceName      = "service_name"
	CtxServiceTokenID   = "service_token_id"
)

// ServiceAuth authenticates a machine caller and applies its read budget.
//
// The token is accepted from `X-Service-Token` or `Authorization: Bearer`.
// Everything expensive (hashing, DB lookup) happens inside the service layer,
// which caches resolved principals for ~30s, so at steady state this
// middleware costs a map lookup and a token-bucket decrement.
func ServiceAuth(identity *services.ServiceIdentityService, logger *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := extractServiceToken(c)
		if token == "" {
			// WWW-Authenticate so a misconfigured client gets a usable hint
			// without us echoing anything about which tokens exist.
			c.Header("WWW-Authenticate", `Bearer realm="pam-vault", error="invalid_request"`)
			response.Error(c, http.StatusUnauthorized, "Service token required")
			c.Abort()
			return
		}

		principal, err := identity.Authenticate(c.Request.Context(), token)
		if err != nil {
			// One indistinguishable answer for malformed / unknown / expired /
			// revoked / wrong-secret. Anything more specific turns this into a
			// token-enumeration oracle.
			status := http.StatusUnauthorized
			msg := "Invalid or expired service token"
			if errors.Is(err, services.ErrServiceDisabled) {
				status, msg = http.StatusForbidden, "Service identity is disabled"
			} else if !errors.Is(err, services.ErrTokenInvalid) && !errors.Is(err, services.ErrTokenMalformed) {
				// Genuine infrastructure failure, fail closed, but say so, so
				// it is distinguishable in monitoring from a credential problem.
				logger.Error("service_auth.backend_error", zap.Error(err))
				status, msg = http.StatusServiceUnavailable, "Service authentication temporarily unavailable"
			}
			logger.Warn("service_auth.denied",
				zap.String("path", c.Request.URL.Path),
				zap.String("source_ip", c.ClientIP()),
				zap.Error(err),
			)
			response.Error(c, status, msg)
			c.Abort()
			return
		}

		// Rate limit per identity. A leaked token is contained by how fast it
		// can drain the vault, so this is a security control and belongs in
		// front of the handler, not in it.
		if !identity.AllowRead(principal, 1) {
			logger.Warn("service_auth.rate_limited",
				zap.String("service", principal.ServiceName),
				zap.String("token_id", principal.TokenID),
				zap.String("source_ip", c.ClientIP()),
			)
			c.Header("Retry-After", "1")
			response.Error(c, http.StatusTooManyRequests, "Secret read rate limit exceeded")
			c.Abort()
			return
		}

		identity.TouchToken(principal.TokenID, c.ClientIP())

		c.Set(CtxServicePrincipal, principal)
		c.Set(CtxServiceID, principal.ServiceID)
		c.Set(CtxServiceName, principal.ServiceName)
		c.Set(CtxServiceTokenID, principal.TokenID)
		c.Next()
	}
}

// ServicePrincipalFrom retrieves the authenticated machine caller.
func ServicePrincipalFrom(c *gin.Context) (*services.ServicePrincipal, bool) {
	v, ok := c.Get(CtxServicePrincipal)
	if !ok {
		return nil, false
	}
	p, ok := v.(*services.ServicePrincipal)
	return p, ok
}

func extractServiceToken(c *gin.Context) string {
	if t := strings.TrimSpace(c.GetHeader("X-Service-Token")); t != "" {
		return t
	}
	auth := strings.TrimSpace(c.GetHeader("Authorization"))
	if auth == "" {
		return ""
	}
	// Only strip a real "Bearer " prefix. The previous version called
	// TrimPrefix unconditionally, so a raw `Authorization: <token>` and a
	// `Bearer <token>` were both accepted, harmless, but it also meant a
	// Basic-auth header was passed through to the token lookup verbatim.
	if len(auth) >= 7 && strings.EqualFold(auth[:7], "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	return ""
}
