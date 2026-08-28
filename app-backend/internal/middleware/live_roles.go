// pam/internal/middleware/live_roles.go
package middleware

import (
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// LiveRoles replaces the roles carried in the JWT with the roles the database
// says the account holds RIGHT NOW.
//
// WHY THIS HAS TO EXIST, AND WHY IT IS NOT A CACHING NICETY
// ────────────────────────────────────────────────────────────────────────
// PAMAuth sets c.Set("roles", claims.Roles), and claims.Roles was written when
// the token was minted at sign-in. Every authorisation decision downstream
// reads that: RequireAdmin, the Admin Center gate, the enrolment gate, and
// /auth/me, which the console reads to decide what to put in its navigation.
//
// So until this middleware existed, a role change did nothing at all to a
// session already open. Root delegating admin to somebody sitting in the
// console changed a row in pam_user_roles and changed nothing else: their
// token still said "user", RequireAdmin still refused them, and the Admin
// Center still did not appear. They had to sign out and back in, and nothing
// in the product told them so.
//
// The same gap runs the other way, and that direction is the serious one.
// REVOKING admin, or removing the role a deny policy is attached to, also did
// nothing until the person being revoked chose to sign out. In a product whose
// entire purpose is controlling privileged access, "your access is removed,
// but not until you feel like closing the tab" is not an access control.
//
// THE COST, AND WHY IT IS BOUNDED
// ────────────────────────────────────────────────────────────────────────
// Correctness here means reading pam_user_roles, and doing that on every
// request to every route would put a join in front of the whole API. So the
// answer is cached per account for a few seconds: long enough that a burst of
// requests from one console costs one query, short enough that a grant or a
// revocation lands almost immediately rather than at the next sign-in. Seconds
// is the window every comparable product lives with; sign-in is not a window,
// it is an indefinite hold.
//
// ON FAILURE it keeps the token's roles rather than dropping them. A database
// blip should not silently strip an administrator of their own console
// mid-session; the failure is logged and the request proceeds exactly as it
// would have before this middleware was added.
type RoleResolver func(userID string) ([]string, error)

const liveRolesTTL = 5 * time.Second

type roleCacheEntry struct {
	roles []string
	at    time.Time
}

type roleCache struct {
	mu sync.RWMutex
	m  map[string]roleCacheEntry
}

func (c *roleCache) get(userID string) ([]string, bool) {
	c.mu.RLock()
	e, ok := c.m[userID]
	c.mu.RUnlock()
	if !ok || time.Since(e.at) > liveRolesTTL {
		return nil, false
	}
	return e.roles, true
}

func (c *roleCache) put(userID string, roles []string) {
	c.mu.Lock()
	// Bounded so a long-lived process cannot accumulate an entry per account
	// forever. Entries are seconds old by construction, so dropping the whole
	// map costs one query per active session and nothing else.
	if len(c.m) > 4096 {
		c.m = make(map[string]roleCacheEntry, 256)
	}
	c.m[userID] = roleCacheEntry{roles: roles, at: time.Now()}
	c.mu.Unlock()
}

// LiveRoles returns the middleware. Mount it directly after PAMAuth on every
// authenticated group: a group that skips it is a group still authorising
// against a token that may be hours out of date.
func LiveRoles(resolve RoleResolver, log *zap.Logger) gin.HandlerFunc {
	cache := &roleCache{m: make(map[string]roleCacheEntry, 256)}

	return func(c *gin.Context) {
		idRaw, ok := c.Get("user_id")
		if !ok {
			c.Next()
			return
		}
		userID, _ := idRaw.(string)
		if userID == "" {
			c.Next()
			return
		}

		if roles, hit := cache.get(userID); hit {
			c.Set("roles", roles)
			c.Set("roles_live", true)
			c.Next()
			return
		}

		roles, err := resolve(userID)
		if err != nil {
			if log != nil {
				log.Warn("pam.roles.live.resolve_fail",
					zap.String("user_id", userID), zap.Error(err))
			}
			// Token roles stand. Marked so a handler that cares can tell the
			// difference between "these are current" and "these are what the
			// token said and we could not check".
			c.Set("roles_live", false)
			c.Next()
			return
		}

		cache.put(userID, roles)
		c.Set("roles", roles)
		c.Set("roles_live", true)
		c.Next()
	}
}

// RolesChanged reports whether two role sets differ, ignoring order and case.
// Used to tell a console that what it is holding is out of date.
func RolesChanged(a, b []string) bool {
	if len(a) != len(b) {
		return true
	}
	seen := make(map[string]int, len(a))
	for _, v := range a {
		seen[strings.ToLower(v)]++
	}
	for _, v := range b {
		k := strings.ToLower(v)
		seen[k]--
		if seen[k] < 0 {
			return true
		}
	}
	return false
}

// ── Live MFA enrolment ─────────────────────────────────────────────────────
//
// The same staleness, one claim over. EnrolmentOnlyGate reads
// mfa_enrolment_required out of the context, and PAMAuth put it there from the
// token, which decided it at sign-in. So attaching an MFA policy to a role did
// nothing to anybody already signed in: the policy was stored, shown on the
// policy screen, and enforced on precisely nobody until their next login.
//
// That is the same defect the login path was fixed for once already, at a
// different layer: the comment in auth_service.go says the policy "was stored,
// displayed, and never enforced" for users who had never enrolled. Enforcing
// it only at sign-in leaves the identical hole for users who are already in.
//
// EnrolmentDecider reports whether this account must enrol right now. It is
// given the live roles resolved above, so a policy attached to a role the user
// was granted a minute ago is evaluated against that role immediately.
type EnrolmentDecider func(userID string, roles []string) (bool, error)

const liveEnrolmentTTL = 10 * time.Second

type enrolCacheEntry struct {
	blocked bool
	at      time.Time
}

// LiveMFAEnrolment recomputes the enrolment requirement per request, cached
// briefly, and overwrites the token's claim with the answer.
//
// It only ever RAISES the gate, never lowers it: if the token already says
// enrolment is required, that stands even when the decider errors. Lowering a
// gate on a failed lookup would turn a database blip into a way past the MFA
// policy, which is the one direction this must never fail in.
func LiveMFAEnrolment(decide EnrolmentDecider, log *zap.Logger) gin.HandlerFunc {
	var mu sync.RWMutex
	cache := make(map[string]enrolCacheEntry, 256)

	return func(c *gin.Context) {
		idRaw, ok := c.Get("user_id")
		userID, _ := idRaw.(string)
		if !ok || userID == "" {
			c.Next()
			return
		}
		// Already gated by the token: nothing to recompute, and nothing this
		// middleware is allowed to do about it.
		if v, exists := c.Get("mfa_enrolment_required"); exists {
			if blocked, isBool := v.(bool); isBool && blocked {
				c.Next()
				return
			}
		}

		mu.RLock()
		e, hit := cache[userID]
		mu.RUnlock()
		if hit && time.Since(e.at) <= liveEnrolmentTTL {
			if e.blocked {
				c.Set("mfa_enrolment_required", true)
			}
			c.Next()
			return
		}

		rolesRaw, _ := c.Get("roles")
		roles, _ := rolesRaw.([]string)
		blocked, err := decide(userID, roles)
		if err != nil {
			if log != nil {
				log.Warn("pam.mfa_policy.live.evaluate_fail",
					zap.String("user_id", userID), zap.Error(err))
			}
			c.Next()
			return
		}

		mu.Lock()
		if len(cache) > 4096 {
			cache = make(map[string]enrolCacheEntry, 256)
		}
		cache[userID] = enrolCacheEntry{blocked: blocked, at: time.Now()}
		mu.Unlock()

		if blocked {
			c.Set("mfa_enrolment_required", true)
		}
		c.Next()
	}
}
