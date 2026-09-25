// pam/internal/middleware/network_allowlist.go
//
// Corporate-network access control — "this console is reachable only from
// approved networks", enforced server-side, in the request path, before any
// handler runs.
//
// ── Why this is here and not in the frontend ──────────────────────────────
//
// A frontend check is a suggestion. The browser is the attacker's machine, so
// anything the page decides can be edited, skipped, or simply never loaded:
// the API answers curl exactly as happily as it answers React. The only place
// a network restriction means anything is somewhere the client cannot reach,
// which is here (and, better still, one layer further out — see the note on
// defence in depth below).
//
// ── The one thing that makes or breaks this control ───────────────────────
//
// EVERYTHING DEPENDS ON c.ClientIP() BEING TRUE. Gin's default is to trust
// X-Forwarded-For from ANY source (trustedProxies defaults to 0.0.0.0/0 and
// ::/0), which means that before this package existed, any client could send
//
//	X-Forwarded-For: 203.0.113.10
//
// and become whatever address it liked. An allowlist built on that is not a
// control at all, it is a single header away from open. It also silently
// poisoned every SourceIP in the audit trail.
//
// The fix is in two halves and both are required:
//
//  1. cmd/pam-api/main.go calls r.SetTrustedProxies(...) with the real CIDRs
//     of the reverse proxies in front of this process, so X-Forwarded-For is
//     honoured only when it arrives FROM one of them.
//  2. This middleware refuses to build when the allowlist is on and the
//     trusted-proxy set was never decided (see config.Validate). Deploying a
//     bypassable allowlist should fail loudly at boot, not quietly at runtime.
//
// ── Fail-closed, and what that means precisely ───────────────────────────
//
//	empty allowlist while enabled  -> refuses to build (boot fails)
//	unparseable client address     -> DENY
//	address matches nothing        -> DENY
//	exempt path                    -> ALLOW, before any of the above
//
// The empty-list case is deliberately a boot failure rather than a
// deny-everything: an allowlist that locks out every administrator including
// the person who has to fix it is an outage, and it should surface at deploy
// time where it is cheap, not at 3am where it is not.
//
// ── Defence in depth ──────────────────────────────────────────────────────
//
// This middleware is the LAST line, not the only one. It runs inside the
// application, so it protects the application but does nothing for anything
// else listening on the host. The security group / firewall in front of the
// instance is what stops traffic ever arriving, and it is the layer that also
// covers the database, the object store, and the SSH port. Keep both: the
// firewall because it is unbypassable and cheap, this because it is
// per-request, auditable, and knows which user was refused.
package middleware

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// NetworkAllowlistConfig is the parsed, validated shape of the network.*
// configuration block.
type NetworkAllowlistConfig struct {
	// Enabled turns the control on. Off means every request passes, which is
	// the correct default for local development and for a deployment that has
	// not yet been given its office ranges.
	Enabled bool

	// AllowedCIDRs are the approved networks. Accepts CIDRs ("203.0.113.0/24",
	// "2001:db8::/32") and bare addresses ("203.0.113.7"), which are treated
	// as single-host prefixes.
	AllowedCIDRs []string

	// BreakGlassCIDRs are emergency ranges kept SEPARATE from the normal list
	// purely so their use is visible. A request admitted through one of these
	// is audited at CRITICAL and logged at Warn every single time, with no
	// throttling, so "somebody used the emergency path" is a question the
	// audit trail can answer rather than a gap in it.
	BreakGlassCIDRs []string

	// ExemptPaths bypass the check entirely, matched exactly. This exists for
	// one real reason: a load balancer's health probe originates from the
	// cloud provider's own address range, not from an office, and an
	// allowlist that fails the health check takes the service out of the
	// pool and causes the outage it was meant to prevent.
	//
	// Keep this list to health endpoints. Anything that returns data does not
	// belong here.
	ExemptPaths []string
}

// NetworkAuditFunc records one allowlist decision. Kept as a function rather
// than a service dependency so this package stays testable without a database
// and does not import services (which imports models, which imports gorm).
//
// allowed is true only for a break-glass admission; ordinary allowed traffic
// is not audited, because one row per request would drown the trail.
type NetworkAuditFunc func(sourceIP, path, userAgent string, breakGlass bool)

// NetworkAllowlist builds the middleware.
//
// Returns an error rather than panicking so main can decide how loudly to die;
// every error here is a configuration mistake that must stop the process.
func NetworkAllowlist(cfg NetworkAllowlistConfig, audit NetworkAuditFunc, logger *zap.Logger) (gin.HandlerFunc, error) {
	if !cfg.Enabled {
		logger.Warn("network.allowlist.disabled",
			zap.String("effect", "every source network can reach this API"),
			zap.String("enable_with", "PAM_NETWORK_ALLOWLIST_ENABLED=true"))
		return func(c *gin.Context) { c.Next() }, nil
	}

	allowed, err := parsePrefixes(cfg.AllowedCIDRs)
	if err != nil {
		return nil, fmt.Errorf("network.allowed_cidrs: %w", err)
	}
	if len(allowed) == 0 {
		return nil, fmt.Errorf(
			"network.allowlist_enabled is true but network.allowed_cidrs is empty. " +
				"Starting with an empty allowlist would refuse every request including your own, " +
				"so this is a boot failure rather than a running outage. " +
				"Set PAM_NETWORK_ALLOWED_CIDRS to your approved ranges, or set " +
				"PAM_NETWORK_ALLOWLIST_ENABLED=false")
	}

	breakGlass, err := parsePrefixes(cfg.BreakGlassCIDRs)
	if err != nil {
		return nil, fmt.Errorf("network.break_glass_cidrs: %w", err)
	}

	exempt := make(map[string]struct{}, len(cfg.ExemptPaths))
	for _, p := range cfg.ExemptPaths {
		if p = strings.TrimSpace(p); p != "" {
			exempt[p] = struct{}{}
		}
	}

	logger.Info("network.allowlist.enabled",
		zap.Int("allowed_ranges", len(allowed)),
		zap.Int("break_glass_ranges", len(breakGlass)),
		zap.Int("exempt_paths", len(exempt)))

	throttle := newDenyThrottle(time.Minute, 4096)

	return func(c *gin.Context) {
		if _, ok := exempt[c.Request.URL.Path]; ok {
			c.Next()
			return
		}

		raw := c.ClientIP()
		addr, ok := parseClientAddr(raw)
		if !ok {
			// Fail closed. An address this process cannot parse is an address
			// it cannot vouch for.
			deny(c, logger, audit, throttle, raw, "client address could not be parsed")
			return
		}

		if matches(allowed, addr) {
			c.Next()
			return
		}

		if matches(breakGlass, addr) {
			// Never throttled, always audited: the whole point of separating
			// these ranges is that every single use is visible.
			logger.Warn("network.allowlist.break_glass",
				zap.String("source_ip", addr.String()),
				zap.String("path", c.Request.URL.Path))
			if audit != nil {
				audit(addr.String(), c.Request.URL.Path, c.Request.UserAgent(), true)
			}
			c.Next()
			return
		}

		deny(c, logger, audit, throttle, addr.String(), "source network is not approved")
	}, nil
}

func deny(c *gin.Context, logger *zap.Logger, audit NetworkAuditFunc, throttle *denyThrottle, sourceIP, reason string) {
	// Throttled because a scanner hitting a closed port would otherwise write
	// one audit row and one log line per request, turning a blocked probe into
	// a storage incident. The first denial per address per window is recorded
	// in full; the rest are counted, not written.
	if throttle.allow(sourceIP) {
		logger.Warn("network.allowlist.denied",
			zap.String("source_ip", sourceIP),
			zap.String("path", c.Request.URL.Path),
			zap.String("reason", reason))
		if audit != nil {
			audit(sourceIP, c.Request.URL.Path, c.Request.UserAgent(), false)
		}
	}

	// The response says nothing about what the policy is. Confirming which
	// ranges are approved would turn a refusal into a hint, and the person who
	// legitimately hit this needs to call their administrator either way.
	c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
		"success": false,
		"error": gin.H{
			"code":    "NETWORK_NOT_ALLOWED",
			"message": "This service is only available from approved corporate networks. Connect from an office network or the corporate VPN, then try again.",
		},
	})
}

// ── address handling ──────────────────────────────────────────────────────

// parsePrefixes turns configuration strings into prefixes, accepting both
// CIDRs and bare addresses.
//
// An IPv4-mapped IPv6 prefix ("::ffff:203.0.113.0/120") is REJECTED rather
// than silently normalised. It compares against nothing in practice, because
// client addresses are unmapped before matching, and accepting a rule that can
// never fire is how an allowlist ends up looking correct and being empty.
func parsePrefixes(entries []string) ([]netip.Prefix, error) {
	out := make([]netip.Prefix, 0, len(entries))
	for _, raw := range entries {
		entry := strings.TrimSpace(raw)
		if entry == "" {
			continue
		}

		if strings.Contains(entry, "/") {
			p, err := netip.ParsePrefix(entry)
			if err != nil {
				return nil, fmt.Errorf("%q is not a valid CIDR: %w", entry, err)
			}
			if p.Addr().Is4In6() {
				return nil, fmt.Errorf(
					"%q is an IPv4-mapped IPv6 range and would never match; write it as plain IPv4", entry)
			}
			// Masked so a sloppy "203.0.113.7/24" behaves as the /24 the
			// author meant rather than silently matching nothing.
			out = append(out, p.Masked())
			continue
		}

		a, err := netip.ParseAddr(entry)
		if err != nil {
			return nil, fmt.Errorf("%q is not a valid IP address or CIDR: %w", entry, err)
		}
		a = a.Unmap()
		out = append(out, netip.PrefixFrom(a, a.BitLen()))
	}
	return out, nil
}

// parseClientAddr normalises whatever ClientIP returned into a comparable
// address.
//
// ClientIP should hand back a bare address, but it is derived from headers and
// RemoteAddr, so a value carrying a port or an IPv6 zone is possible. Both are
// handled here rather than being allowed to fail the parse and deny a
// legitimate user.
func parseClientAddr(raw string) (netip.Addr, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return netip.Addr{}, false
	}
	if a, err := netip.ParseAddr(s); err == nil {
		return a.Unmap().WithZone(""), true
	}
	if host, _, err := net.SplitHostPort(s); err == nil {
		if a, err := netip.ParseAddr(strings.TrimSpace(host)); err == nil {
			return a.Unmap().WithZone(""), true
		}
	}
	return netip.Addr{}, false
}

func matches(prefixes []netip.Prefix, addr netip.Addr) bool {
	for _, p := range prefixes {
		// Contains is family-strict, so an IPv4 address never matches an IPv6
		// prefix and vice versa. That is the behaviour we want: an office's
		// v4 range must not implicitly admit its v6 traffic.
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// ── deny throttle ─────────────────────────────────────────────────────────

// denyThrottle allows one record per key per window, with a hard cap on how
// many keys it will remember.
//
// The cap matters: keying on source address means an attacker chooses the
// keys, and an unbounded map is then a memory-exhaustion primitive. On
// overflow the whole map is dropped, which costs at most one extra record per
// active address and cannot grow without bound.
type denyThrottle struct {
	mu       sync.Mutex
	window   time.Duration
	maxKeys  int
	lastSeen map[string]time.Time
}

func newDenyThrottle(window time.Duration, maxKeys int) *denyThrottle {
	return &denyThrottle{window: window, maxKeys: maxKeys, lastSeen: make(map[string]time.Time)}
}

func (t *denyThrottle) allow(key string) bool {
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()

	if last, ok := t.lastSeen[key]; ok && now.Sub(last) < t.window {
		return false
	}
	if len(t.lastSeen) >= t.maxKeys {
		t.lastSeen = make(map[string]time.Time)
	}
	t.lastSeen[key] = now
	return true
}
