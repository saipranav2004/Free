// pam/internal/middleware/network_allowlist.go
package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// AllowlistChecker is the one thing this middleware needs from the service,
// named as an interface so the middleware can be exercised without a
// database standing behind it.
type AllowlistChecker interface {
	IsAllowed(ip string) (bool, error)
}

// NetworkAllowlist refuses requests from source addresses the root operator
// has not permitted.
//
// This is the enforcement that actually protects data. The edge copy in
// nginx guards the static console, but the browser talks to this API on its
// own origin, so a request that never touches that container still reaches
// here — blocking only at nginx would look like a control and stop nothing.
//
// c.ClientIP() rather than the socket peer, because there is a load balancer
// in front: gin resolves the real client through the trusted-proxy list
// configured in main (see NetworkConfig.TrustedProxyCIDRs), so a client
// cannot name its own address unless the deployment has been told to trust
// the hop it came from.
//
// exempt paths stay reachable from anywhere:
//   - the health endpoint, or the orchestrator kills a container that is
//     working perfectly for the people on the list;
//   - the allowlist endpoints themselves are NOT exempt, deliberately. They
//     are protected instead by the lockout guard in the service, which is a
//     better answer: leaving them open would mean the one control that can
//     disable the allowlist is the one thing the allowlist never covers.
func NetworkAllowlist(checker AllowlistChecker, exemptPrefixes []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		for _, p := range exemptPrefixes {
			if p != "" && strings.HasPrefix(c.Request.URL.Path, p) {
				c.Next()
				return
			}
		}

		ip := c.ClientIP()
		allowed, err := checker.IsAllowed(ip)
		if err != nil {
			// A database that cannot be read must not become an outage.
			// The API's own authentication still stands in front of every
			// route behind this, so failing open here degrades to "the
			// controls that were working yesterday" rather than to "no
			// controls at all".
			c.Next()
			return
		}
		if !allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"success": false,
				"error":   "Your network is not permitted to reach this console",
				"code":    "network_not_allowed",
			})
			return
		}
		c.Next()
	}
}
