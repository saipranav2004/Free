package webproxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
)

// ── injection ─────────────────────────────────────────────────────────────

// The guard rides the BlockClipboard policy flag, so a session whose resource
// was never marked protected must get no guard at all. Injecting it everywhere
// would put a DevTools blocker on consoles nobody asked to protect.
func TestGuardInjectedOnlyOnProtectedSessions(t *testing.T) {
	cases := []struct {
		name    string
		session *models.WebProxySession
		want    bool
	}{
		{"no session", nil, false},
		{"unprotected", &models.WebProxySession{}, false},
		{"protected", &models.WebProxySession{BlockClipboard: true}, true},
		{"watermark only", &models.WebProxySession{Watermark: true, Username: "alice"}, false},
		{"both", &models.WebProxySession{BlockClipboard: true, Watermark: true, Username: "alice"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tags := string(pamScriptTags("", false, tc.session))
			if got := strings.Contains(tags, "__pam_devtools_block"); got != tc.want {
				t.Fatalf("devtools guard present = %v, want %v", got, tc.want)
			}
		})
	}
}

// MinIO Console ships `script-src 'self' https://unpkg.com` with no
// 'unsafe-inline'. Without the nonce on BOTH tags nothing PAM injects runs, and
// the failure is completely silent: no console error, page renders perfectly.
func TestBothGuardTagsCarryTheCSPNonce(t *testing.T) {
	tags := string(devtoolsGuardScriptTag("N0NCE"))
	if n := strings.Count(tags, `<script nonce="N0NCE">`); n != 2 {
		t.Fatalf("both the config and the guard tag must carry the nonce, got %d nonced tags in %.200s", n, tags)
	}
	if strings.Contains(tags, "<script>") {
		t.Fatal("no tag may be emitted without the nonce when one was issued")
	}
}

func TestNoNonceEmitsPlainTags(t *testing.T) {
	tags := string(devtoolsGuardScriptTag(""))
	if strings.Contains(tags, "nonce=") {
		t.Fatal("a target with no CSP must not receive a nonce attribute")
	}
	if n := strings.Count(tags, "<script>"); n != 2 {
		t.Fatalf("want 2 plain script tags, got %d", n)
	}
}

// The config must be a complete statement before the guard's IIFE reads it, so
// order is not cosmetic.
func TestConfigIsEmittedBeforeTheGuard(t *testing.T) {
	tags := string(devtoolsGuardScriptTag(""))
	cfgAt := strings.Index(tags, "__PAM_DEVTOOLS_GUARD=")
	guardAt := strings.Index(tags, "__pamDevtoolsGuardInstalled")
	if cfgAt < 0 || guardAt < 0 {
		t.Fatalf("both parts must be present (cfg=%d guard=%d)", cfgAt, guardAt)
	}
	if cfgAt > guardAt {
		t.Fatal("the guard would read an undefined config")
	}
}

// Marshalled, not concatenated: a config injector that is only safe because of
// what it currently happens to carry is one field away from being an XSS.
func TestConfigIsValidJSONAndCarriesTheReportPath(t *testing.T) {
	tags := string(devtoolsGuardScriptTag(""))
	start := strings.Index(tags, "__PAM_DEVTOOLS_GUARD=") + len("__PAM_DEVTOOLS_GUARD=")
	end := strings.Index(tags[start:], ";</script>")
	if end < 0 {
		t.Fatalf("could not locate the config assignment in %.200s", tags)
	}
	var cfg devtoolsGuardConfig
	if err := json.Unmarshal([]byte(tags[start:start+end]), &cfg); err != nil {
		t.Fatalf("the injected config must be valid JSON: %v", err)
	}
	if cfg.Report != violationPath {
		t.Fatalf("the guard must report to %q, got %q", violationPath, cfg.Report)
	}
	// The setting that keeps this from being an outage.
	if cfg.ConfirmTicks < 2 {
		t.Fatalf("a single transient reading must not block a live session; confirmTicks=%d", cfg.ConfirmTicks)
	}
	if cfg.DockedDeltaPx < 100 {
		t.Fatalf("a threshold this low false-positives on a bookmarks bar; got %d", cfg.DockedDeltaPx)
	}
}

// ── what the asset must actually do ───────────────────────────────────────

func TestGuardSuppressesEveryRequestedInteraction(t *testing.T) {
	js := string(devtoolsGuardJS)
	// paste is included deliberately: a brokered session is not only about data
	// leaving, and pasting a command into a proxied admin console is the one
	// action a keystroke recording cannot reconstruct.
	for _, ev := range []string{"contextmenu", "copy", "cut", "paste", "dragstart", "selectstart"} {
		if !strings.Contains(js, "'"+ev+"'") {
			t.Fatalf("the guard must suppress %q", ev)
		}
	}
}

func TestGuardInterceptsTheDevToolsShortcuts(t *testing.T) {
	js := string(devtoolsGuardJS)
	for _, frag := range []string{
		"'f12'", "e.keyCode === 123", // F12
		"key === 'i'", "key === 'j'", "key === 'c'", "key === 'k'", // Ctrl+Shift+I/J/C/K
		"key === 'u'", "key === 's'", "key === 'p'", // view-source, save, print
		"e.metaKey", // macOS
	} {
		if !strings.Contains(js, frag) {
			t.Fatalf("shortcut handling is missing %q", frag)
		}
	}
}

func TestGuardImplementsAllThreeSignals(t *testing.T) {
	js := string(devtoolsGuardJS)
	for _, fn := range []string{"function dockedOpen", "function debuggerPaused", "function consoleOpen"} {
		if !strings.Contains(js, fn) {
			t.Fatalf("missing detection signal: %s", fn)
		}
	}
	// Built from a string so a CSP without 'unsafe-eval' fails once here and
	// degrades to two signals, instead of throwing on every tick forever.
	if !strings.Contains(js, "new Function('debugger')") {
		t.Fatal("the pause probe must be built via new Function, not a literal debugger statement")
	}
	if !strings.Contains(js, "devicePixelRatio !== baseDpr") {
		t.Fatal("page zoom must re-take the baseline, otherwise zooming blocks the console")
	}
}

func TestGuardBlocksAndRecovers(t *testing.T) {
	js := string(devtoolsGuardJS)
	if !strings.Contains(js, "Developer Tools detected") {
		t.Fatal("the block screen must say what happened")
	}
	if !strings.Contains(js, "window.location.reload()") {
		t.Fatal("the block must lift by itself once DevTools closes")
	}
	if !strings.Contains(js, "MIN_BLOCK_MS") {
		t.Fatal("a dwell time is what stops the page flapping between blocked and reloaded")
	}
}

// Inputs must stay usable. A proxied console has search boxes and command
// fields, and breaking the target to protect it is not a trade this feature is
// allowed to make.
func TestSelectionGuardExemptsRealInputs(t *testing.T) {
	js := string(devtoolsGuardJS)
	if !strings.Contains(js, "isEditable") {
		t.Fatal("selection suppression must exempt inputs")
	}
	if !strings.Contains(js, "input,textarea,[contenteditable]") {
		t.Fatal("the injected stylesheet must re-enable selection inside form fields")
	}
}

// It must never take the target application down with it.
func TestGuardIsFailSafe(t *testing.T) {
	js := string(devtoolsGuardJS)
	if !strings.Contains(js, "window.__pamDevtoolsGuardInstalled") {
		t.Fatal("double injection must be a no-op")
	}
	if strings.Count(js, "catch (") < 8 {
		t.Fatalf("every optional path must be guarded; found only %d catch blocks", strings.Count(js, "catch ("))
	}
	if !strings.HasPrefix(strings.TrimSpace(js[strings.Index(js, "(function ()"):]), "(function ()") {
		t.Fatal("the guard must be a self-contained IIFE, not leak globals into the target page")
	}
}

// The honesty requirement: this file must never claim to be prevention.
func TestGuardDocumentsThatItIsADeterrent(t *testing.T) {
	js := string(devtoolsGuardJS)
	if !strings.Contains(js, "DETERRENT, NOT A SECURITY BOUNDARY") {
		t.Fatal("the asset must state plainly that it is not a security boundary")
	}
}

// ── end to end, through the real proxy ────────────────────────────────────
//
// Everything above tests pieces. This drives a real HTTP round trip through
// buildReverseProxy against a fake MinIO Console, so the whole chain is
// exercised: isHTMLResponse decides to inject, injectHeartbeat buffers the
// body, csp.go issues a nonce and rewrites the target's policy, and
// pamScriptTags assembles the tags. A break anywhere in that chain fails here.
//
// The upstream deliberately ships MinIO Console's real Content-Security-Policy.
// It carries no 'unsafe-inline' in script-src, which is exactly the condition
// under which an injected script silently never runs: no console error, no
// failed request, the page renders perfectly and the guard simply is not there.
func TestGuardReachesTheBrowserThroughTheRealProxy(t *testing.T) {
	const minioCSP = "default-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
		"script-src 'self' https://unpkg.com; connect-src 'self' https://unpkg.com"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", minioCSP)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `<!doctype html><html><head><title>Object Browser</title></head>`+
			`<body><div id="root">pam-agent</div></body></html>`)
	}))
	defer upstream.Close()

	targetURL, _ := url.Parse(upstream.URL)
	rs := &ResolvedSession{
		Session: &models.WebProxySession{
			ID:             "wps-1",
			Subdomain:      "minio-dev-test-pam",
			Username:       "d.okonkwo",
			BlockClipboard: true, // the policy flag that marks this session protected
		},
		Upstream: &UpstreamState{Cookies: map[string]string{}},
		Target:   targetURL,
	}

	h := NewHandler(testService(defaultTestConfig()), zap.NewNop())
	req := httptest.NewRequest(http.MethodGet, "http://minio-dev-test-pam.pam.example.com/browser/pam-agent", nil)
	rec := httptest.NewRecorder()
	h.buildReverseProxy(rs).ServeHTTP(rec, req)

	res := rec.Result()
	body := rec.Body.String()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("proxy returned %d", res.StatusCode)
	}
	// The target's own page must survive: the guard rides along, it does not
	// replace the application.
	if !strings.Contains(body, `<div id="root">pam-agent</div>`) {
		t.Fatal("the target application's markup was lost")
	}
	if !strings.Contains(body, "__pam_devtools_block") {
		t.Fatalf("the DevTools guard never reached the browser; body was:\n%.400s", body)
	}
	if !strings.Contains(body, "__PAM_DEVTOOLS_GUARD=") {
		t.Fatal("the guard arrived without its configuration")
	}

	// Injected before </body> so the document still parses as one page.
	if strings.Index(body, "__pam_devtools_block") > strings.Index(body, "</body>") {
		t.Fatal("scripts were appended after </body>")
	}

	// The nonce is the difference between running and silently not running.
	nonce := ""
	if i := strings.Index(body, `<script nonce="`); i >= 0 {
		rest := body[i+len(`<script nonce="`):]
		nonce = rest[:strings.Index(rest, `"`)]
	}
	if nonce == "" {
		t.Fatal("no nonce was issued, so MinIO's own CSP would refuse every injected script")
	}
	if csp := res.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "nonce-"+nonce) {
		t.Fatalf("the response CSP does not admit the nonce it issued: %s", csp)
	}
}

// The mirror image: a session whose resource carries no data-protection policy
// must be proxied untouched apart from the heartbeat. Injecting a DevTools
// blocker onto a console nobody asked to protect is its own kind of outage.
func TestUnprotectedSessionIsProxiedWithoutTheGuard(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, `<!doctype html><html><body><div id="root">ok</div></body></html>`)
	}))
	defer upstream.Close()

	targetURL, _ := url.Parse(upstream.URL)
	rs := &ResolvedSession{
		Session:  &models.WebProxySession{ID: "wps-2", Subdomain: "grafana"},
		Upstream: &UpstreamState{Cookies: map[string]string{}},
		Target:   targetURL,
	}

	h := NewHandler(testService(defaultTestConfig()), zap.NewNop())
	req := httptest.NewRequest(http.MethodGet, "http://grafana.pam.example.com/", nil)
	rec := httptest.NewRecorder()
	h.buildReverseProxy(rs).ServeHTTP(rec, req)

	body := rec.Body.String()
	if strings.Contains(body, "__pam_devtools_block") {
		t.Fatal("an unprotected session must not receive the DevTools guard")
	}
	if !strings.Contains(body, `<div id="root">ok</div>`) {
		t.Fatal("the target page must still be served")
	}
}
