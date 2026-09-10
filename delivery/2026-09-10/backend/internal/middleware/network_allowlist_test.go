package middleware

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

type fakeChecker struct {
	allow map[string]bool
	err   error
	asked []string
}

func (f *fakeChecker) IsAllowed(ip string) (bool, error) {
	f.asked = append(f.asked, ip)
	if f.err != nil {
		return false, f.err
	}
	return f.allow[ip], nil
}

func newRouter(t *testing.T, checker AllowlistChecker, trustedProxies []string, exempt []string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	if err := r.SetTrustedProxies(trustedProxies); err != nil {
		t.Fatalf("SetTrustedProxies: %v", err)
	}
	r.Use(NetworkAllowlist(checker, exempt))
	r.GET("/api/v1/pam/resources", func(c *gin.Context) { c.String(http.StatusOK, "resources") })
	r.GET("/api/health", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	return r
}

func do(r *gin.Engine, path, remoteAddr, xff string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.RemoteAddr = remoteAddr
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestBlockedNetworkGetsAClearRefusal(t *testing.T) {
	checker := &fakeChecker{allow: map[string]bool{"183.82.2.29": true}}
	r := newRouter(t, checker, nil, []string{"/api/health"})

	if w := do(r, "/api/v1/pam/resources", "183.82.2.29:1234", ""); w.Code != http.StatusOK {
		t.Errorf("allowed address got %d, want 200", w.Code)
	}

	w := do(r, "/api/v1/pam/resources", "203.0.113.9:1234", "")
	if w.Code != http.StatusForbidden {
		t.Fatalf("blocked address got %d, want 403", w.Code)
	}
	// The body has to say which control refused, or the operator has no way
	// to tell this apart from an authorisation failure.
	if body := w.Body.String(); !strings.Contains(body, "network_not_allowed") {
		t.Errorf("403 body does not name the control: %s", body)
	}
}

// The health endpoint must stay reachable from anywhere, or a blocked
// network makes the orchestrator restart a container that is serving the
// permitted ones perfectly well.
func TestHealthIsExempt(t *testing.T) {
	checker := &fakeChecker{allow: map[string]bool{}}
	r := newRouter(t, checker, nil, []string{"/api/health"})

	if w := do(r, "/api/health", "203.0.113.9:1234", ""); w.Code != http.StatusOK {
		t.Fatalf("health got %d from a blocked address, want 200", w.Code)
	}
	if len(checker.asked) != 0 {
		t.Errorf("the exempt path should not even consult the allowlist, asked: %v", checker.asked)
	}
}

// The whole control rests on which address is believed. With no trusted
// proxies configured, a client that sends X-Forwarded-For must NOT be able
// to name itself onto the allowlist.
func TestForgedForwardedForCannotGrantAccess(t *testing.T) {
	checker := &fakeChecker{allow: map[string]bool{"183.82.2.29": true}}
	r := newRouter(t, checker, nil, []string{"/api/health"})

	w := do(r, "/api/v1/pam/resources", "203.0.113.9:1234", "183.82.2.29")
	if w.Code != http.StatusForbidden {
		t.Fatalf("a forged X-Forwarded-For was believed: got %d, want 403", w.Code)
	}
	if len(checker.asked) == 0 || checker.asked[0] != "203.0.113.9" {
		t.Errorf("the socket peer should have been checked, got %v", checker.asked)
	}
}

// And with a proxy configured, the header IS believed, but only from that
// proxy — which is what lets a real deployment see the operator rather than
// the load balancer.
func TestForwardedForIsBelievedFromATrustedProxy(t *testing.T) {
	checker := &fakeChecker{allow: map[string]bool{"183.82.2.29": true}}
	r := newRouter(t, checker, []string{"10.0.0.0/8"}, []string{"/api/health"})

	if w := do(r, "/api/v1/pam/resources", "10.0.0.7:1234", "183.82.2.29"); w.Code != http.StatusOK {
		t.Fatalf("a trusted proxy's X-Forwarded-For was ignored: got %d, want 200", w.Code)
	}
	if w := do(r, "/api/v1/pam/resources", "10.0.0.7:1234", "203.0.113.9"); w.Code != http.StatusForbidden {
		t.Fatalf("a trusted proxy reporting a blocked client got %d, want 403", w.Code)
	}
}

// A database that cannot be read must not take the whole product down. The
// authentication in front of every route behind this still stands.
func TestUnreadableAllowlistFailsOpen(t *testing.T) {
	checker := &fakeChecker{err: errors.New("database is down")}
	r := newRouter(t, checker, nil, []string{"/api/health"})

	if w := do(r, "/api/v1/pam/resources", "203.0.113.9:1234", ""); w.Code != http.StatusOK {
		t.Fatalf("an unreadable allowlist returned %d, want the request to proceed", w.Code)
	}
}
