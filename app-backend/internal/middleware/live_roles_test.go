// pam/internal/middleware/live_roles_test.go
//
// These pin the property the whole file exists for: an authorisation decision
// must follow the database, not the token. Both directions are covered, and
// the revocation direction is the one that matters most.
package middleware

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func runWith(t *testing.T, mw gin.HandlerFunc, tokenRoles []string) []string {
	t.Helper()
	gin.SetMode(gin.TestMode)
	var seen []string
	r := gin.New()
	r.GET("/x", func(c *gin.Context) {
		c.Set("user_id", "u-1")
		c.Set("roles", tokenRoles)
	}, mw, func(c *gin.Context) {
		v, _ := c.Get("roles")
		seen, _ = v.([]string)
		c.Status(http.StatusOK)
	})
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))
	return seen
}

func TestLiveRolesPrefersTheDatabaseOverTheToken(t *testing.T) {
	mw := LiveRoles(func(string) ([]string, error) { return []string{"user", "admin"}, nil }, nil)
	got := runWith(t, mw, []string{"user"})
	if len(got) != 2 || got[1] != "admin" {
		t.Fatalf("a delegation granted after sign-in must reach the open session, got %v", got)
	}
}

// The direction that matters: an admin whose role was taken away must stop
// being an admin now, not whenever they next choose to sign out.
func TestLiveRolesAppliesARevocationImmediately(t *testing.T) {
	mw := LiveRoles(func(string) ([]string, error) { return []string{"user"}, nil }, nil)
	got := runWith(t, mw, []string{"user", "admin"})
	for _, r := range got {
		if r == "admin" {
			t.Fatalf("revoked admin still present in %v", got)
		}
	}
}

func TestLiveRolesKeepsTokenRolesWhenTheLookupFails(t *testing.T) {
	mw := LiveRoles(func(string) ([]string, error) { return nil, errors.New("db down") }, nil)
	got := runWith(t, mw, []string{"user", "admin"})
	if len(got) != 2 {
		t.Fatalf("a database blip must not strip an open session, got %v", got)
	}
}

func TestLiveRolesCachesWithinTheWindow(t *testing.T) {
	calls := 0
	mw := LiveRoles(func(string) ([]string, error) {
		calls++
		return []string{"user"}, nil
	}, nil)
	for i := 0; i < 5; i++ {
		runWith(t, mw, []string{"user"})
	}
	if calls != 1 {
		t.Fatalf("five requests inside the TTL should cost one lookup, got %d", calls)
	}
}

func TestLiveRolesRefreshesAfterTheWindow(t *testing.T) {
	if liveRolesTTL > 30*time.Second {
		t.Skip("TTL too long to exercise in a unit test")
	}
	calls := 0
	mw := LiveRoles(func(string) ([]string, error) {
		calls++
		return []string{"user"}, nil
	}, nil)
	runWith(t, mw, []string{"user"})
	time.Sleep(liveRolesTTL + 50*time.Millisecond)
	runWith(t, mw, []string{"user"})
	if calls != 2 {
		t.Fatalf("expected a second lookup once the entry expired, got %d", calls)
	}
}

// The gate may only be raised. A failed policy lookup must never become a way
// past the MFA requirement.
func TestLiveMFAEnrolmentNeverLowersTheGate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var blockedSeen bool
	r := gin.New()
	r.GET("/x", func(c *gin.Context) {
		c.Set("user_id", "u-1")
		c.Set("mfa_enrolment_required", true)
	}, LiveMFAEnrolment(func(string, []string) (bool, error) { return false, nil }, nil),
		func(c *gin.Context) {
			v, _ := c.Get("mfa_enrolment_required")
			blockedSeen, _ = v.(bool)
			c.Status(http.StatusOK)
		})
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))
	if !blockedSeen {
		t.Fatal("a token that already demands enrolment must stay gated")
	}
}

func TestLiveMFAEnrolmentRaisesTheGateForAPolicyAttachedAfterSignIn(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var blockedSeen bool
	r := gin.New()
	r.GET("/x", func(c *gin.Context) {
		c.Set("user_id", "u-1")
		c.Set("roles", []string{"admin"})
		c.Set("mfa_enrolment_required", false)
	}, LiveMFAEnrolment(func(_ string, roles []string) (bool, error) {
		for _, r := range roles {
			if r == "admin" {
				return true, nil
			}
		}
		return false, nil
	}, nil), func(c *gin.Context) {
		v, _ := c.Get("mfa_enrolment_required")
		blockedSeen, _ = v.(bool)
		c.Status(http.StatusOK)
	})
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))
	if !blockedSeen {
		t.Fatal("a policy attached after sign-in must gate the open session")
	}
}

func TestRolesChangedIgnoresOrderAndCase(t *testing.T) {
	if RolesChanged([]string{"user", "Admin"}, []string{"admin", "user"}) {
		t.Fatal("same set, different order and case, must not read as changed")
	}
	if !RolesChanged([]string{"user"}, []string{"user", "admin"}) {
		t.Fatal("a added role must read as changed")
	}
}
