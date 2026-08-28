// pam/internal/middleware/ratelimit.go
//
// Per-source request throttling for the endpoints worth brute-forcing.
//
// Before this file there was NO rate limiting anywhere in the process, which
// left POST /api/v1/auth/login, /auth/mfa/verify and /auth/mfa/recover open to
// unlimited attempts from a single source. Account lockout bounds the damage
// per account; it does nothing about an attacker spraying one password across
// every username, and nothing about grinding a 6-digit TOTP code or a backup
// code, both of which are small enough spaces to be worth grinding.
//
// A token bucket per source address: `Burst` requests may arrive at once, and
// the allowance then refills at `PerMinute` per minute. Bursting is the point.
// A human who mistypes a password three times in ten seconds is normal and
// must not be throttled; ten thousand attempts an hour is not, and is.
//
// ── Deliberately in-process ───────────────────────────────────────────────
//
// State lives in this process, so N replicas allow N times the configured
// rate, and a restart forgets everything. That is a real limitation and it is
// the right trade here: a shared Redis counter adds a dependency on the
// critical path of sign-in, and a limiter that fails open when Redis blips is
// worse than a slightly generous one that cannot fail at all. If the
// deployment ever needs an exact global limit, that belongs at the WAF or
// ingress, in front of every replica, not here.
//
// This is ABUSE CONTROL, not authentication. It never decides who a caller is,
// only how often they may ask.
package middleware

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// RateLimitConfig is the parsed shape of the network.auth_rate_limit_* keys.
type RateLimitConfig struct {
	Enabled bool

	// PerMinute is the sustained allowance per source address.
	PerMinute int

	// Burst is how many requests may be spent at once before the sustained
	// rate starts to bite. Must be at least 1 or nothing would ever pass.
	Burst int
}

// RateLimitAuditFunc records one throttled request. Throttled per source and
// window by the caller of this type, not per request, for the same reason the
// allowlist throttles its denials: the attacker chooses the request rate, and
// audit storage should not be a function of it.
type RateLimitAuditFunc func(sourceIP, path, userAgent string)

// RateLimit builds the middleware. Mount it on the routes worth protecting
// rather than globally: a legitimate console session makes a lot of ordinary
// API calls, and a limit tight enough to stop credential grinding would break
// normal use if applied to all of them.
func RateLimit(cfg RateLimitConfig, audit RateLimitAuditFunc, logger *zap.Logger) gin.HandlerFunc {
	if !cfg.Enabled {
		logger.Warn("ratelimit.disabled",
			zap.String("effect", "sign-in and MFA endpoints accept unlimited attempts per source"))
		return func(c *gin.Context) { c.Next() }
	}

	perMinute := cfg.PerMinute
	if perMinute < 1 {
		perMinute = 1
	}
	burst := cfg.Burst
	if burst < 1 {
		burst = 1
	}

	logger.Info("ratelimit.enabled",
		zap.Int("per_minute", perMinute),
		zap.Int("burst", burst))

	buckets := newBucketStore(float64(perMinute)/60.0, float64(burst), 10*time.Minute, 100_000)
	reportThrottle := newDenyThrottle(time.Minute, 4096)

	return func(c *gin.Context) {
		ip := c.ClientIP()
		if ip == "" {
			// No identifiable source means no bucket to charge. Fail closed:
			// this only guards a handful of unauthenticated endpoints, and an
			// unattributable request to those has nothing to lose by waiting.
			retryAfter(c, time.Minute)
			return
		}

		if buckets.take(ip) {
			c.Next()
			return
		}

		if reportThrottle.allow(ip) {
			logger.Warn("ratelimit.throttled",
				zap.String("source_ip", ip),
				zap.String("path", c.Request.URL.Path))
			if audit != nil {
				audit(ip, c.Request.URL.Path, c.Request.UserAgent())
			}
		}
		retryAfter(c, time.Duration(float64(time.Minute)/float64(perMinute)))
	}
}

func retryAfter(c *gin.Context, wait time.Duration) {
	seconds := int(wait.Seconds())
	if seconds < 1 {
		seconds = 1
	}
	c.Header("Retry-After", fmt.Sprintf("%d", seconds))
	c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
		"success": false,
		"error": gin.H{
			"code":    "RATE_LIMITED",
			"message": "Too many attempts. Wait a moment and try again.",
		},
	})
}

// ── token buckets ─────────────────────────────────────────────────────────

type bucket struct {
	tokens float64
	last   time.Time
}

// bucketStore holds one bucket per source address, bounded in both size and
// age.
//
// Both bounds exist because the key is attacker-chosen. idleTTL reclaims the
// buckets of addresses that stopped calling; maxKeys is the backstop for a
// burst of distinct sources arriving faster than the sweep reclaims them.
type bucketStore struct {
	mu       sync.Mutex
	refill   float64 // tokens per second
	capacity float64
	idleTTL  time.Duration
	maxKeys  int
	buckets  map[string]*bucket
	lastGC   time.Time
}

func newBucketStore(refillPerSecond, capacity float64, idleTTL time.Duration, maxKeys int) *bucketStore {
	return &bucketStore{
		refill:   refillPerSecond,
		capacity: capacity,
		idleTTL:  idleTTL,
		maxKeys:  maxKeys,
		buckets:  make(map[string]*bucket),
		lastGC:   time.Now(),
	}
}

// take spends one token, reporting whether there was one to spend.
//
// Swept inline rather than from a goroutine so the store has no lifecycle to
// manage and cannot outlive the router that owns it.
func (s *bucketStore) take(key string) bool {
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()

	if now.Sub(s.lastGC) > s.idleTTL {
		for k, b := range s.buckets {
			if now.Sub(b.last) > s.idleTTL {
				delete(s.buckets, k)
			}
		}
		s.lastGC = now
	}

	b, ok := s.buckets[key]
	if !ok {
		if len(s.buckets) >= s.maxKeys {
			// Over the cap, having just swept. Refuse rather than grow: the
			// alternative is letting whoever generated this many distinct
			// sources decide how much memory the process uses.
			return false
		}
		s.buckets[key] = &bucket{tokens: s.capacity - 1, last: now}
		return true
	}

	b.tokens += now.Sub(b.last).Seconds() * s.refill
	if b.tokens > s.capacity {
		b.tokens = s.capacity
	}
	b.last = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
