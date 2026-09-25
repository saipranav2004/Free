// pam/internal/webproxy/live_langfuse_test.go
//
// End-to-end verification of the NextAuth sign-in against a REAL target:
// the server-side login runs for real, and the resulting session is then used
// through the real httputil.ReverseProxy to fetch a page the application
// serves only to a signed-in principal.
//
// That second half is the point. A login that captures a cookie proves
// nothing on its own; what the operator cares about is landing INSIDE
// Langfuse instead of on its sign-in form, and only a proxied request can
// show that.
//
// Gated behind PAM_TEST_LIVE_LANGFUSE=1 so an offline CI run never fails on a
// network dependency; nextauth_test.go covers the same logic unconditionally.
//
//	PAM_TEST_LIVE_LANGFUSE=1 \
//	PAM_TEST_LANGFUSE_URL=https://langfuse.internal \
//	PAM_TEST_LANGFUSE_USER=ops@example.com \
//	PAM_TEST_LANGFUSE_PASS='...' \
//	go test ./internal/webproxy/ -run TestLiveLangfuse -v
//
// PAM_TEST_LANGFUSE_BASE_PATH mirrors NEXT_PUBLIC_BASE_PATH when the
// deployment is served under a sub-path.
package webproxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
)

func liveLangfuseTarget(t *testing.T) Target {
	t.Helper()
	if os.Getenv("PAM_TEST_LIVE_LANGFUSE") != "1" {
		t.Skip("set PAM_TEST_LIVE_LANGFUSE=1 (plus PAM_TEST_LANGFUSE_URL/USER/PASS) to run the live Langfuse check")
	}
	base := os.Getenv("PAM_TEST_LANGFUSE_URL")
	user := os.Getenv("PAM_TEST_LANGFUSE_USER")
	pass := os.Getenv("PAM_TEST_LANGFUSE_PASS")
	if base == "" || user == "" || pass == "" {
		t.Fatal("PAM_TEST_LANGFUSE_URL, PAM_TEST_LANGFUSE_USER and PAM_TEST_LANGFUSE_PASS must all be set")
	}
	extra := map[string]interface{}{}
	if bp := os.Getenv("PAM_TEST_LANGFUSE_BASE_PATH"); bp != "" {
		extra["web_base_path"] = bp
	}
	return Target{
		BaseURL:     strings.TrimRight(base, "/"),
		Username:    user,
		Password:    pass,
		ExtraConfig: extra,
	}
}

func TestLiveLangfuseBrokeredSessionEndToEnd(t *testing.T) {
	target := liveLangfuseTarget(t)

	// ── 1. Server-side sign-in against the real application ───────────────
	//
	// The client mirrors the proxy service's own: it does NOT follow
	// redirects. NextAuth answers the credentials callback with a redirect,
	// and following it would discard the Set-Cookie carrying the session.
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	auth := &NextAuthCredentialsAuthenticator{}
	state, err := auth.Login(context.Background(), client, target)
	if err != nil {
		t.Fatalf("server-side NextAuth sign-in against the live target failed: %v", err)
	}
	if !hasNextAuthSession(state.Cookies) {
		t.Fatalf("live sign-in returned no NextAuth session cookie, got %v", cookieNames(state.Cookies))
	}
	t.Logf("live NextAuth sign-in OK, captured %d upstream cookie(s): %v", len(state.Cookies), cookieNames(state.Cookies))

	// ── 2. Use it through the real proxy ──────────────────────────────────
	targetURL, err := url.Parse(target.BaseURL)
	if err != nil {
		t.Fatalf("parse target URL: %v", err)
	}
	rs := &ResolvedSession{
		Session:  &models.WebProxySession{ID: "live-test", Subdomain: "langfuse-live"},
		Upstream: state,
		Target:   targetURL,
	}
	h := NewHandler(testService(defaultTestConfig()), zap.NewNop())

	basePath := ""
	if bp, _ := target.ExtraConfig["web_base_path"].(string); bp != "" {
		basePath = "/" + strings.Trim(bp, "/")
	}
	req := httptest.NewRequest(http.MethodGet, "http://langfuse-live.pam.example.com"+basePath+"/", nil)
	req.AddCookie(&http.Cookie{Name: proxyCookieName, Value: "browser-side-pam-token"})
	rec := httptest.NewRecorder()

	h.buildReverseProxy(rs).ServeHTTP(rec, req)

	// A signed-out request is bounced to the sign-in page. Reaching the app
	// itself is therefore the assertion that matters: it is the difference
	// between "PAM proxied you to a login form" and "PAM signed you in".
	if rec.Code == http.StatusFound || rec.Code == http.StatusSeeOther || rec.Code == http.StatusTemporaryRedirect {
		if loc := rec.Result().Header.Get("Location"); strings.Contains(loc, "sign-in") || strings.Contains(loc, "signin") {
			t.Fatalf("the brokered session is NOT signed in: the app redirected to %q", loc)
		}
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("proxied request returned %d, want 200. Body: %s", rec.Code, truncate(rec.Body.String(), 400))
	}
	t.Logf("proxied authenticated request OK (200), %d bytes", rec.Body.Len())

	// ── 3. The invariant that makes this safe to ship ─────────────────────
	//
	// The NextAuth session token is a bearer credential for the target. If
	// it reached the browser, an operator could lift it out of DevTools and
	// keep using Langfuse directly after PAM ended the session.
	if got := rec.Result().Header.Get("Set-Cookie"); got != "" {
		t.Fatalf("SECURITY: the target's Set-Cookie leaked to the browser: %q", got)
	}
	for name, value := range state.Cookies {
		if value != "" && strings.Contains(rec.Body.String(), value) {
			t.Fatalf("SECURITY: upstream cookie %q's value appeared in the proxied response body", name)
		}
	}
	t.Log("invariant OK, no upstream session cookie reached the browser")
}

// TestLiveLangfuseRejectsAWrongCredential proves the failure path is real
// against the live application rather than only against a test double: a bad
// password must fail the open, not produce an unauthenticated session that
// looks fine until the operator sees a login form.
func TestLiveLangfuseRejectsAWrongCredential(t *testing.T) {
	target := liveLangfuseTarget(t)
	target.Password += "-definitely-wrong"

	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	auth := &NextAuthCredentialsAuthenticator{}

	state, err := auth.Login(context.Background(), client, target)
	if err == nil {
		t.Fatalf("a wrong password produced a session: %v", cookieNames(state.Cookies))
	}
	t.Logf("live wrong-credential refusal: %v", err)
}
