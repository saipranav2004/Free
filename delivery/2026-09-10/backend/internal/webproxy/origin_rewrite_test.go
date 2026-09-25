package webproxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
)

// The proxy rewrites Host so the target sees its own hostname. Origin has to
// travel with it, or every WebSocket upgrade through this proxy is refused.
//
// gorilla/websocket's default Upgrader.CheckOrigin — which MinIO's Console,
// and most Go admin UIs, use unchanged — accepts a handshake only when the
// Origin header's host equals the request's Host header. Rewriting one and
// not the other guarantees they disagree.
//
// Measured against a real MinIO Console (RELEASE.2025-09-07), same cookie and
// path, varying only these headers: no Origin -> 101, Origin == Host -> 101,
// Origin = proxy while Host = target -> 403 "request origin not allowed by
// Upgrader.CheckOrigin". That 403 is the reported bucket-view spinner: the
// page renders, the Object Browser's ws://.../ws/objectManager is refused,
// and the console retries it forever without ever surfacing an error.
func TestDirectorRewritesOriginToTheTarget(t *testing.T) {
	var seen http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		seen.Set("X-Test-Observed-Host", r.Host)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	targetURL, _ := url.Parse(upstream.URL)
	h := NewHandler(testService(defaultTestConfig()), zap.NewNop())
	proxy := h.buildReverseProxy(&ResolvedSession{
		Session:  &models.WebProxySession{ID: "wps-1", Subdomain: "app-abc12345"},
		Upstream: &UpstreamState{Cookies: map[string]string{}},
		Target:   targetURL,
	})

	req := httptest.NewRequest(http.MethodGet, "http://app-abc12345.pam.example.com/ws/objectManager", nil)
	req.Header.Set("Origin", "http://app-abc12345.pam.example.com")
	proxy.ServeHTTP(httptest.NewRecorder(), req)

	wantOrigin := targetURL.Scheme + "://" + targetURL.Host
	if got := seen.Get("Origin"); got != wantOrigin {
		t.Fatalf("Origin reaching the target = %q, want %q — a WebSocket upgrade with this mismatch is answered 403 by gorilla's default CheckOrigin", got, wantOrigin)
	}
	if got := seen.Get("X-Test-Observed-Host"); got != targetURL.Host {
		t.Fatalf("Host reaching the target = %q, want %q", got, targetURL.Host)
	}
	if got := seen.Get("Origin"); got == "" {
		t.Fatal("Origin was dropped rather than rewritten; some targets reject a browser request with no Origin at all")
	}
}

// A request that never carried an Origin must not gain one. Inventing a
// header asserts something about the request that was never true, and a
// target may log or authorise on it.
func TestDirectorDoesNotInventAnOrigin(t *testing.T) {
	var seen http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	targetURL, _ := url.Parse(upstream.URL)
	h := NewHandler(testService(defaultTestConfig()), zap.NewNop())
	proxy := h.buildReverseProxy(&ResolvedSession{
		Session:  &models.WebProxySession{ID: "wps-1", Subdomain: "app-abc12345"},
		Upstream: &UpstreamState{Cookies: map[string]string{}},
		Target:   targetURL,
	})

	req := httptest.NewRequest(http.MethodGet, "http://app-abc12345.pam.example.com/api/v1/buckets", nil)
	proxy.ServeHTTP(httptest.NewRecorder(), req)

	if got := seen.Get("Origin"); got != "" {
		t.Fatalf("Origin was invented for a request that had none: %q", got)
	}
}

// Referer is rewritten only when it points at this proxy. One naming
// somewhere else is the browser reporting a genuine off-site navigation.
func TestDirectorRewritesOnlyOurOwnReferer(t *testing.T) {
	targetURL := func(srv *httptest.Server) *url.URL { u, _ := url.Parse(srv.URL); return u }

	for _, tc := range []struct {
		name    string
		referer string
		want    func(target *url.URL) string
	}{
		{
			name:    "our proxy host is rewritten, path kept",
			referer: "http://app-abc12345.pam.example.com/browser/payments-archive",
			want: func(target *url.URL) string {
				return target.Scheme + "://" + target.Host + "/browser/payments-archive"
			},
		},
		{
			name:    "a foreign referer is left alone",
			referer: "https://wiki.example.org/runbook",
			want:    func(*url.URL) string { return "https://wiki.example.org/runbook" },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var seen string
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen = r.Header.Get("Referer")
				w.WriteHeader(http.StatusOK)
				_, _ = io.WriteString(w, "ok")
			}))
			defer upstream.Close()

			target := targetURL(upstream)
			h := NewHandler(testService(defaultTestConfig()), zap.NewNop())
			proxy := h.buildReverseProxy(&ResolvedSession{
				Session:  &models.WebProxySession{ID: "wps-1", Subdomain: "app-abc12345"},
				Upstream: &UpstreamState{Cookies: map[string]string{}},
				Target:   target,
			})

			req := httptest.NewRequest(http.MethodGet, "http://app-abc12345.pam.example.com/api/v1/buckets", nil)
			req.Header.Set("Referer", tc.referer)
			proxy.ServeHTTP(httptest.NewRecorder(), req)

			if want := tc.want(target); seen != want {
				t.Fatalf("Referer reaching the target = %q, want %q", seen, want)
			}
		})
	}
}
