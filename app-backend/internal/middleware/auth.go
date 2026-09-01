// pam/internal/middleware/auth.go
package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	pamjwt "github.com/yourorg/pam/pkg/jwt"
	"go.uber.org/zap"
)

// PAMAuth verifies a PAM-issued HS256 JWT (not IAM's RS256 token).
// PAM owns its own authentication entirely.
//
// A real WebSocket handshake (the in-browser terminal gateway, see
// internal/gateway) is the one case that also accepts the token as
// ?access_token=<jwt> on the URL: browsers cannot set a custom
// Authorization header on the WebSocket handshake itself (the
// `new WebSocket(url)` constructor has no headers parameter), so the token
// has nowhere else to travel. Every other route is unaffected — the header
// path is tried first, and a normal (non-WS) request with no header is
// still rejected exactly as before, via isWebSocketUpgrade's check below.
// This is the same trade-off most products with a browser-based terminal
// make (a URL-borne token can end up in a proxy/access log); the PAM
// access token's short TTL (see JWTConfig.AccessTTLMin) bounds the
// exposure window.
func PAMAuth(issuer *pamjwt.Issuer, log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		tokenString := ""
		switch {
		case strings.HasPrefix(authHeader, "Bearer "):
			tokenString = strings.TrimPrefix(authHeader, "Bearer ")
		case isWebSocketUpgrade(c) && c.Query("access_token") != "":
			tokenString = c.Query("access_token")
		default:
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"success": false,
				"error":   "Missing or malformed Authorization header. Expected: Bearer <token>",
			})
			return
		}

		claims, sessionID, err := issuer.Verify(tokenString)
		if err != nil {
			log.Debug("pam.jwt.verify.fail", zap.Error(err))
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"success": false,
				"error":   "Invalid or expired PAM token",
			})
			return
		}

		c.Set("user_id", claims.Subject)
		c.Set("username", claims.Username)
		c.Set("email", claims.Email)
		c.Set("account_id", claims.AccountID)
		c.Set("mfa_verified", claims.MFAVerified)
		c.Set("mfa_enrolment_required", claims.MFAEnrolmentRequired)
		c.Set("roles", claims.Roles)
		c.Set("session_id", sessionID)
		c.Set("jti", claims.ID)
		c.Next()
	}
}

// isWebSocketUpgrade reports whether this request is an actual WebSocket
// handshake (the only case PAMAuth accepts a query-string token for).
func isWebSocketUpgrade(c *gin.Context) bool {
	return strings.EqualFold(c.GetHeader("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(c.GetHeader("Connection")), "upgrade")
}

// EnrolmentOnlyGate is the teeth behind role-gated MFA policy.
//
// A user whose role requires a second factor, who has not enrolled one, and
// whose grace window has closed still needs A session — otherwise they can
// never reach the enrolment endpoints to fix it, and the policy becomes a
// lockout rather than a control. So Login issues one, marked enrolment-only,
// and this refuses every request it makes except the handful that enrolment
// itself needs.
//
// It has to live server-side. The console has its own gate (MfaEnforcementGate),
// but as src/lib/mfaPolicy.js says in as many words: a session the console
// refuses to use is still a session curl will happily use.
//
// Mounted on the authenticated group, so it runs after PAMAuth has verified
// the token and before anything that acts on it.
func EnrolmentOnlyGate() gin.HandlerFunc {
	// Everything enrolment genuinely needs, and nothing else. /me is included
	// because the console loads the current user before it can render the
	// enrolment screen at all.
	allowed := map[string]bool{
		"/api/v1/auth/me":                 true,
		"/api/v1/auth/logout":             true,
		"/api/v1/auth/mfa/setup/initiate": true,
		"/api/v1/auth/mfa/setup/verify":   true,
	}

	return func(c *gin.Context) {
		required, exists := c.Get("mfa_enrolment_required")
		if !exists {
			c.Next()
			return
		}
		if blocked, ok := required.(bool); !ok || !blocked {
			c.Next()
			return
		}
		if allowed[c.Request.URL.Path] {
			c.Next()
			return
		}
		// 403 with a machine-readable code, so the console can route straight
		// to enrolment instead of showing a generic permission error.
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
			"success": false,
			"error":   "Your role requires multi-factor authentication. Enrol a second factor to continue.",
			"code":    "mfa_enrolment_required",
		})
	}
}

// RequireMFA blocks requests if the PAM JWT doesn't have mfa_verified=true.
// RequireMFA refuses an action unless THIS session actually proved a second
// factor.
//
// The claim it reads is now truthful, and that is what makes this middleware
// worth anything. Login used to stamp mfa_verified=true on accounts that had
// no enrolled device at all, on the reasoning that no challenge was owed, so
// this gate passed for exactly the accounts it exists to stop: a password-only
// admin could reveal a vault credential, approve a JIT request or pair an
// agent, while the console told them a second factor was being re-checked.
// See services/auth_service.go's login path.
//
// The refusal names enrolment, and carries a machine-readable code, because
// the two ways to fail this are not the same problem: an account with a factor
// that signed in before enrolling needs to sign in again, and an account with
// no factor needs to go and enrol one. A bare "MFA verification required" left
// the console unable to tell those apart and unable to offer the fix.
func RequireMFA() gin.HandlerFunc {
	return func(c *gin.Context) {
		mfa, exists := c.Get("mfa_verified")
		if !exists || !mfa.(bool) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"success": false,
				"code":    "mfa_verification_required",
				"error": "This action needs a second factor. Enrol an authenticator in " +
					"Settings > Security, or sign in again if you already have one.",
			})
			return
		}
		c.Next()
	}
}
