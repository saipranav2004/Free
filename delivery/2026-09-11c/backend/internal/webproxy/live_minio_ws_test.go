package webproxy

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
)

// THE OBJECT BROWSER IS A WEBSOCKET, AND NOTHING TESTED IT.
//
// The reported "bucket view hangs on a spinner" is not an HTTP failure: the
// page loads and renders over plain HTTP, then the Object Browser opens
// ws://.../ws/objectManager to stream the listing. If that upgrade does not
// complete, the view spins for ever and nothing errors visibly.
//
// Every live test that existed checked HTTP responses and CSP headers, so all
// of them passed while the one exchange the screen depends on was never
// attempted. This drives the real upgrade, through the real proxy, against a
// real MinIO console.
func TestLiveMinIOObjectBrowserWebSocketUpgrades(t *testing.T) {
	target := liveMinIOTarget(t)

	auth := &MinIOConsoleAuthenticator{}
	state, err := auth.Login(context.Background(), &http.Client{}, target)
	if err != nil {
		t.Fatalf("server-side login failed: %v", err)
	}
	targetURL, err := url.Parse(target.BaseURL)
	if err != nil {
		t.Fatal(err)
	}
	rs := &ResolvedSession{
		Session:  &models.WebProxySession{ID: "live-ws", Subdomain: "minio-live"},
		Upstream: state,
		Target:   targetURL,
	}
	h := NewHandler(testService(defaultTestConfig()), zap.NewNop())

	// A real proxy server, not httptest.NewRecorder: an upgrade is a hijacked
	// connection, and a recorder cannot be hijacked. This is why the bug could
	// not have been caught by the existing recorder-based tests even if they
	// had asked for /ws/objectManager.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.buildReverseProxy(rs).ServeHTTP(w, r)
	}))
	defer srv.Close()

	proxyURL, _ := url.Parse(srv.URL)
	conn, err := net.DialTimeout("tcp", proxyURL.Host, 5*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

	key := make([]byte, 16)
	_, _ = rand.Read(key)
	// Origin is the PROXY's, exactly as a browser would send it. That is the
	// whole point: the target's Upgrader compares Origin against Host, and a
	// proxy that rewrites one without the other can never satisfy it.
	handshake := strings.Join([]string{
		"GET /ws/objectManager?bucket=pam-agent HTTP/1.1",
		"Host: " + proxyURL.Host,
		"Origin: http://" + proxyURL.Host,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Version: 13",
		"Sec-WebSocket-Key: " + base64.StdEncoding.EncodeToString(key),
		"Cookie: " + proxyCookieName + "=browser-side-pam-token",
		"", "",
	}, "\r\n")
	if _, err := conn.Write([]byte(handshake)); err != nil {
		t.Fatalf("write handshake: %v", err)
	}

	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("read handshake response: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("object browser WebSocket got %d, want 101. This is the bucket-view spinner: "+
			"the page renders, this upgrade is refused, and the listing never arrives.", resp.StatusCode)
	}
	if !strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") {
		t.Errorf("Upgrade header = %q, want websocket", resp.Header.Get("Upgrade"))
	}
	t.Logf("object browser WebSocket upgraded through the proxy: %s", resp.Status)
}
