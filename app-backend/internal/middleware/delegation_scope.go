// pam/internal/middleware/delegation_scope.go
//
// The THIRD enforcement layer, and the one that was missing entirely.
//
//	Layer 1 (authz.go)  IAM/OPA: may this principal do this action at all?
//	Layer 2 (grant.go)  PAM JIT: do they hold a live grant right now?
//	Layer 3 (this file) DELEGATION: an administrator whose authority was
//	                    delegated over a NAMED SET OF RESOURCES may only act
//	                    on that set.
//
// POST .../users/:id/delegate-admin has always accepted scope_resource_ids,
// validated every id against the resource table, stored them, returned them in
// the API and rendered them in the console. No authorization path read them
// back. "Admin, but only for these three databases" produced an administrator
// with the entire estate, and the person who scoped the delegation had no way
// to tell.
//
// This middleware closes that. It is deliberately narrow: it answers only the
// question the field promises, which is whether a given RESOURCE is in scope.
// It does not invent a scope for identity, roles or policies, because
// scope_resource_ids never claimed to limit those.
//
// WHO IS UNAFFECTED. Root, every seeded admin, and every delegation created
// without a scope. For all of them DelegationScopeFor returns "not scoped" and
// this middleware is a pass-through, which is what an empty scope has always
// meant: the role default resource set.
package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// CtxDelegationScope holds []string when the caller is a scoped delegate, so a
// handler can filter a listing without asking the database again.
const CtxDelegationScope = "delegation_scope"

// ScopeResolver answers "which resources may this administrator act on".
// Second return is false when they are not a scoped delegate at all.
type ScopeResolver func(userID string) ([]string, bool, error)

// Cached for the same reason LiveRoles caches: this runs on every admin
// request and a delegation changes about once a quarter. Short enough that a
// revocation takes effect while somebody is still looking at the screen.
const scopeCacheTTL = 5 * time.Second

type scopeEntry struct {
	ids    []string
	scoped bool
	at     time.Time
}

type scopeCache struct {
	mu sync.RWMutex
	m  map[string]scopeEntry
}

func newScopeCache() *scopeCache { return &scopeCache{m: make(map[string]scopeEntry)} }

func (c *scopeCache) get(userID string) (scopeEntry, bool) {
	c.mu.RLock()
	e, ok := c.m[userID]
	c.mu.RUnlock()
	if !ok || time.Since(e.at) > scopeCacheTTL {
		return scopeEntry{}, false
	}
	return e, true
}

func (c *scopeCache) put(userID string, e scopeEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// Bounded, same as roleCache: an unbounded map keyed by user id is a slow
	// leak on a long-lived process.
	if len(c.m) > 4096 {
		c.m = make(map[string]scopeEntry, 64)
	}
	e.at = time.Now()
	c.m[userID] = e
}

// ResolveDelegationScope reads the caller's scope once per request and parks it
// in the context. Mounted on the whole admin group so a handler that filters a
// listing and a route that guards a single resource read the same answer.
//
// FAILS OPEN, and that is the correct direction here. A delegation lookup that
// errors must not lock every administrator out of the console; the actions that
// matter are still behind RequireAdmin and the per-resource guard below, which
// fails CLOSED when it has a scope and cannot match it.
func ResolveDelegationScope(resolve ScopeResolver, log *zap.Logger) gin.HandlerFunc {
	cache := newScopeCache()
	return func(c *gin.Context) {
		raw, _ := c.Get("user_id")
		userID, _ := raw.(string)
		if userID == "" || resolve == nil {
			c.Next()
			return
		}

		if e, hit := cache.get(userID); hit {
			if e.scoped {
				c.Set(CtxDelegationScope, e.ids)
			}
			c.Next()
			return
		}

		ids, scoped, err := resolve(userID)
		if err != nil {
			if log != nil {
				log.Warn("delegation.scope.resolve_fail", zap.String("user_id", userID), zap.Error(err))
			}
			c.Next()
			return
		}
		cache.put(userID, scopeEntry{ids: ids, scoped: scoped})
		if scoped {
			c.Set(CtxDelegationScope, ids)
		}
		c.Next()
	}
}

// DelegationScopeFromContext returns the caller's resource scope, and false
// when they are not scoped. Handlers use it to filter listings.
func DelegationScopeFromContext(c *gin.Context) ([]string, bool) {
	v, ok := c.Get(CtxDelegationScope)
	if !ok {
		return nil, false
	}
	ids, _ := v.([]string)
	return ids, len(ids) > 0
}

// ScopeAllows reports whether a resource id is inside the caller's scope. An
// unscoped caller is allowed everything, which is what unscoped means.
func ScopeAllows(c *gin.Context, resourceID string) bool {
	ids, scoped := DelegationScopeFromContext(c)
	if !scoped {
		return true
	}
	for _, id := range ids {
		if id == resourceID {
			return true
		}
	}
	return false
}

// RequireResourceInScope guards a route addressed at ONE resource.
//
// Fails closed: a scoped delegate whose target resource cannot be determined is
// refused, because the alternative is letting an unidentifiable target through
// the one check that exists to identify it.
func RequireResourceInScope(resourceIDFn func(*gin.Context) string, log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		ids, scoped := DelegationScopeFromContext(c)
		if !scoped {
			c.Next()
			return
		}

		resourceID := resourceIDFn(c)
		if resourceID == "" || !ScopeAllows(c, resourceID) {
			raw, _ := c.Get("user_id")
			userID, _ := raw.(string)
			if log != nil {
				log.Warn("delegation.scope.denied",
					zap.String("user_id", userID),
					zap.String("resource_id", resourceID),
					zap.Int("scope_size", len(ids)),
				)
			}
			// The body names no resource outside the scope, for the same
			// reason the network allowlist names no range: a refusal must not
			// become a way to enumerate what exists.
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"success": false,
				"error":   "Your administrator access is limited to specific resources, and this is not one of them",
				"code":    "delegation_scope_denied",
			})
			return
		}
		c.Next()
	}
}
