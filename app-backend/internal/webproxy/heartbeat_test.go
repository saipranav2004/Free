// pam/internal/webproxy/heartbeat_test.go
//
// Coverage for "operator closed the tab" detection — the piece HTTP's
// statelessness otherwise makes impossible (unlike the WebSocket-based
// terminal, there is no persistent connection whose EOF signals closure).
// A tiny script injected into every proxied HTML response beacons back on
// an interval; ReconcileExpired treats a session whose heartbeat has gone
// stale past the grace period as ended.
package webproxy

import (
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/yourorg/pam/internal/config"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

const webproxyTestCryptoKeyB64 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" // 32 raw bytes, test-only

func newHeartbeatTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file::memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open in-memory sqlite: %v", err)
	}
	if err := db.AutoMigrate(
		&models.WebProxySession{},
		&models.WebProxyActivity{},
		&models.PAMResource{},
		&models.VaultEntry{},
		&models.ConnectionSession{},
		&models.SessionRecording{},
		&models.SessionRecordingCommand{},
		// Deliberately NOT models.AuditLog: its TableName() hardcodes a
		// "<PAM_DATABASE_SCHEMA>.pam_audit_log" Postgres schema-qualified
		// name (even with the env var unset, producing a leading-dot table
		// name), which sqlite's CREATE TABLE parser rejects outright. Left
		// unmigrated on purpose — AuditService.Write() is documented
		// fire-and-forget (errors logged and swallowed, never propagated),
		// so every write against this missing table fails as an ordinary
		// "no such table" error exactly like it would fail closed in any
		// other environment-misconfiguration case, never a panic.
	); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	return db
}

// dbTestService is testService plus a real (in-memory) DB, a valid crypto
// key, a real *services.ResourceService, and a real *services.AuditService
// (all backed by the SAME DB) — every one of End()'s side effects
// (EndTrackedSession, audit.Write) dereferences its dependency unconditionally
// with no nil-check, so a nil resources/audit field panics the instant any
// test exercises End() (directly, or via ReconcileExpired). A real service
// against a DB with no matching pam_connection_sessions row degrades to a
// logged (non-fatal) warning instead, exactly matching End()'s documented
// contract.
func dbTestService(t *testing.T, cfg config.WebProxyConfig) *Service {
	t.Helper()
	svc := testService(cfg)
	svc.db = newHeartbeatTestDB(t)
	svc.cryptoKey = webproxyTestCryptoKeyB64
	vaultSvc, err := services.NewVaultService(svc.db, webproxyTestCryptoKeyB64, zap.NewNop())
	if err != nil {
		t.Fatalf("vault init: %v", err)
	}
	svc.resources = services.NewResourceService(svc.db, zap.NewNop()).WithVault(vaultSvc)
	svc.audit = services.NewAuditService(svc.db, []byte("test-hmac-secret-at-least-32-bytes-long"), "default", zap.NewNop())
	return svc
}

// ── isHTMLResponse ──────────────────────────────────────────────────────

func TestIsHTMLResponse(t *testing.T) {
	cases := []struct {
		contentType string
		want        bool
	}{
		{"text/html", true},
		{"text/html; charset=utf-8", true},
		{"TEXT/HTML", true},
		{"  text/html  ; charset=utf-8", true},
		{"application/json", false},
		{"application/json; charset=utf-8", false},
		{"image/png", false},
		{"", false},
		{"text/htmlish", false}, // must not substring-match
	}
	for _, tc := range cases {
		resp := &http.Response{Header: http.Header{}}
		resp.Header.Set("Content-Type", tc.contentType)
		if got := isHTMLResponse(resp); got != tc.want {
			t.Errorf("isHTMLResponse(%q) = %v, want %v", tc.contentType, got, tc.want)
		}
	}
}

// ── injectHeartbeatScript ───────────────────────────────────────────────

func TestInjectHeartbeatScriptBeforeClosingBodyTag(t *testing.T) {
	html := []byte("<html><body><h1>Hi</h1></body></html>")
	got := injectHeartbeatScript(html, heartbeatScriptTag)
	gotStr := string(got)

	if !strings.Contains(gotStr, string(heartbeatScriptTag)) {
		t.Fatal("expected the heartbeat script to be present in the output")
	}
	bodyClose := strings.Index(gotStr, "</body>")
	scriptIdx := strings.Index(gotStr, string(heartbeatScriptTag))
	if scriptIdx >= bodyClose {
		t.Fatalf("expected script to be inserted BEFORE </body>: script at %d, </body> at %d", scriptIdx, bodyClose)
	}
	if !strings.HasPrefix(gotStr, "<html><body><h1>Hi</h1>") {
		t.Fatalf("original content before the injection point was altered: %q", gotStr)
	}
	if !strings.HasSuffix(gotStr, "</body></html>") {
		t.Fatalf("original content after the injection point was altered: %q", gotStr)
	}
}

func TestInjectHeartbeatScriptCaseInsensitiveClosingTag(t *testing.T) {
	html := []byte("<HTML><BODY>hi</BODY></HTML>")
	got := string(injectHeartbeatScript(html, heartbeatScriptTag))
	if !strings.Contains(got, string(heartbeatScriptTag)) {
		t.Fatal("expected injection even with an uppercase </BODY> tag")
	}
	if !strings.Contains(got, "</BODY>") {
		t.Fatal("original uppercase closing tag should be preserved verbatim")
	}
}

func TestInjectHeartbeatScriptAppendsWhenNoBodyTag(t *testing.T) {
	html := []byte("<div>just a fragment, no body tag</div>")
	got := string(injectHeartbeatScript(html, heartbeatScriptTag))
	if !strings.HasSuffix(got, string(heartbeatScriptTag)) {
		t.Fatalf("expected the script appended at the end when there's no </body>, got: %q", got)
	}
}

// ── ModifyResponse-level buffering/injection ─────────────────────────────

func TestReverseProxyInjectsHeartbeatIntoHTMLResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		body := "<html><body>hello</body></html>"
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	defer upstream.Close()

	targetURL, _ := url.Parse(upstream.URL)
	rs := &ResolvedSession{
		Session:  &models.WebProxySession{ID: "wps-1", Subdomain: "app-abc12345"},
		Upstream: &UpstreamState{},
		Target:   targetURL,
	}
	h := NewHandler(testService(defaultTestConfig()), zap.NewNop())
	req := httptest.NewRequest(http.MethodGet, "http://app-abc12345.pam.example.com/", nil)
	rec := httptest.NewRecorder()
	h.buildReverseProxy(rs).ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, string(heartbeatScriptTag)) {
		t.Fatalf("expected heartbeat script in HTML response body, got: %q", body)
	}
	wantCL := strconv.Itoa(len(body))
	if got := rec.Result().Header.Get("Content-Length"); got != wantCL {
		t.Fatalf("Content-Length = %q, want %q (must match the actual injected body length)", got, wantCL)
	}
}

func TestReverseProxyDoesNotInjectIntoNonHTMLResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := `{"status":"ok"}`
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	defer upstream.Close()

	targetURL, _ := url.Parse(upstream.URL)
	rs := &ResolvedSession{
		Session:  &models.WebProxySession{ID: "wps-1", Subdomain: "app-abc12345"},
		Upstream: &UpstreamState{},
		Target:   targetURL,
	}
	h := NewHandler(testService(defaultTestConfig()), zap.NewNop())
	req := httptest.NewRequest(http.MethodGet, "http://app-abc12345.pam.example.com/api/status", nil)
	rec := httptest.NewRecorder()
	h.buildReverseProxy(rs).ServeHTTP(rec, req)

	if got := rec.Body.String(); got != `{"status":"ok"}` {
		t.Fatalf("JSON response body should pass through byte-for-byte, got: %q", got)
	}
}

func TestReverseProxySkipsOversizedHTMLResponse(t *testing.T) {
	bigBody := strings.Repeat("x", 200)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Content-Length", strconv.Itoa(len(bigBody)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(bigBody))
	}))
	defer upstream.Close()

	targetURL, _ := url.Parse(upstream.URL)
	rs := &ResolvedSession{
		Session:  &models.WebProxySession{ID: "wps-1", Subdomain: "app-abc12345"},
		Upstream: &UpstreamState{},
		Target:   targetURL,
	}
	cfg := defaultTestConfig()
	cfg.MaxRequestBodyBytes = 50 // deliberately smaller than bigBody
	h := NewHandler(testService(cfg), zap.NewNop())
	req := httptest.NewRequest(http.MethodGet, "http://app-abc12345.pam.example.com/", nil)
	rec := httptest.NewRecorder()
	h.buildReverseProxy(rs).ServeHTTP(rec, req)

	if got := rec.Body.String(); got != bigBody {
		t.Fatalf("oversized HTML body must pass through UNMODIFIED (not truncated, not injected), got %d bytes want %d",
			len(got), len(bigBody))
	}
	if strings.Contains(rec.Body.String(), string(heartbeatScriptTag)) {
		t.Fatal("must not inject into a response over the size cap")
	}
}

// ── Heartbeat endpoint + persistence ──────────────────────────────────────

func TestHeartbeatEndpointUpdatesLastHeartbeatAt(t *testing.T) {
	svc := dbTestService(t, defaultTestConfig())
	now := time.Now().UTC()

	row := &models.WebProxySession{
		ConnectionSessionID: "conn-1",
		ResourceID:          "res-1",
		UserID:              "user-1",
		Subdomain:           "app-abc12345",
		TokenHash:           hashToken("raw-token"),
		UpstreamStateEnc:    "",
		Status:              models.WebProxySessionActive,
		LastActivityAt:      now.Add(-time.Hour),
		ExpiresAt:           now.Add(time.Hour),
	}
	if err := svc.db.Create(row).Error; err != nil {
		t.Fatalf("seed session: %v", err)
	}

	svc.RecordHeartbeat(row.ID)

	var reloaded models.WebProxySession
	if err := svc.db.Where("id = ?", row.ID).First(&reloaded).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.LastHeartbeatAt == nil {
		t.Fatal("expected LastHeartbeatAt to be set after RecordHeartbeat")
	}
	if reloaded.LastActivityAt.Before(now) {
		t.Fatal("expected LastActivityAt to also be bumped by a heartbeat")
	}
}

func TestHeartbeatOnUnknownSessionIsANoop(t *testing.T) {
	svc := dbTestService(t, defaultTestConfig())
	// Must not panic or error visibly — the browser's sendBeacon never
	// inspects the response either way.
	svc.RecordHeartbeat("does-not-exist")
}

// ── ReconcileExpired: heartbeat-based "tab closed" detection ─────────────

func TestReconcileExpiredClosesSessionWithStaleHeartbeat(t *testing.T) {
	svc := dbTestService(t, defaultTestConfig())
	now := time.Now().UTC()
	staleHeartbeat := now.Add(-(heartbeatGraceSeconds + 30) * time.Second)

	row := &models.WebProxySession{
		ConnectionSessionID: "conn-1",
		ResourceID:          "res-1",
		UserID:              "user-1",
		Subdomain:           "app-abc12345",
		TokenHash:           hashToken("raw-token"),
		Status:              models.WebProxySessionActive,
		LastActivityAt:      now, // NOT idle by the idle-timeout measure
		LastHeartbeatAt:     &staleHeartbeat,
		ExpiresAt:           now.Add(3 * time.Hour), // NOT past absolute expiry
	}
	if err := svc.db.Create(row).Error; err != nil {
		t.Fatalf("seed session: %v", err)
	}

	closed, err := svc.ReconcileExpired(context.Background())
	if err != nil {
		t.Fatalf("ReconcileExpired: %v", err)
	}
	if closed != 1 {
		t.Fatalf("expected 1 session closed for stale heartbeat, got %d", closed)
	}

	var reloaded models.WebProxySession
	svc.db.Where("id = ?", row.ID).First(&reloaded)
	if reloaded.Status == models.WebProxySessionActive {
		t.Fatal("expected the session to no longer be ACTIVE after a stale-heartbeat reconcile")
	}
}

func TestReconcileExpiredLeavesFreshHeartbeatSessionAlone(t *testing.T) {
	svc := dbTestService(t, defaultTestConfig())
	now := time.Now().UTC()
	freshHeartbeat := now.Add(-5 * time.Second)

	row := &models.WebProxySession{
		ConnectionSessionID: "conn-1",
		ResourceID:          "res-1",
		UserID:              "user-1",
		Subdomain:           "app-abc12345",
		TokenHash:           hashToken("raw-token"),
		Status:              models.WebProxySessionActive,
		LastActivityAt:      now,
		LastHeartbeatAt:     &freshHeartbeat,
		ExpiresAt:           now.Add(3 * time.Hour),
	}
	if err := svc.db.Create(row).Error; err != nil {
		t.Fatalf("seed session: %v", err)
	}

	closed, err := svc.ReconcileExpired(context.Background())
	if err != nil {
		t.Fatalf("ReconcileExpired: %v", err)
	}
	if closed != 0 {
		t.Fatalf("expected a session with a fresh heartbeat to be left alone, got %d closed", closed)
	}
}

func TestReconcileExpiredIgnoresHeartbeatForSessionsThatNeverSentOne(t *testing.T) {
	svc := dbTestService(t, defaultTestConfig())
	now := time.Now().UTC()

	// A pure-API resource (no HTML ever served, so no heartbeat script was
	// ever injected) must fall back to idle-timeout/expiry-only teardown —
	// never killed just because LastHeartbeatAt is nil.
	row := &models.WebProxySession{
		ConnectionSessionID: "conn-1",
		ResourceID:          "res-1",
		UserID:              "user-1",
		Subdomain:           "app-abc12345",
		TokenHash:           hashToken("raw-token"),
		Status:              models.WebProxySessionActive,
		LastActivityAt:      now, // fresh — not idle
		LastHeartbeatAt:     nil,
		ExpiresAt:           now.Add(3 * time.Hour), // not expired
	}
	if err := svc.db.Create(row).Error; err != nil {
		t.Fatalf("seed session: %v", err)
	}

	closed, err := svc.ReconcileExpired(context.Background())
	if err != nil {
		t.Fatalf("ReconcileExpired: %v", err)
	}
	if closed != 0 {
		t.Fatalf("expected a session with no heartbeat ever sent to be judged purely on idle/expiry, got %d closed", closed)
	}
}

// ── Regression: the length of an HTML body is not knowable up front ───────

// TestReverseProxyInjectsHeartbeatIntoGzippedHTMLResponse pins the bug that
// made tab-close detection silently dead in practice against every real
// target.
//
// Director deletes Accept-Encoding intending to get an identity-encoded body
// back. Go's Transport then requests gzip ITSELF and decompresses
// transparently — which is fine for the body (it arrives plain) but sets
// resp.ContentLength to -1 and drops the Content-Length header, because the
// compressed length no longer describes the bytes. Gating injection on a
// known Content-Length therefore skipped every gzip-capable upstream, which
// is essentially all of them (MinIO Console, ClickHouse, pgAdmin). The page
// rendered perfectly and the beacon was simply never there, so the session
// only ended at the 30-minute idle timeout and its recording — finalised on
// End — never landed.
func TestReverseProxyInjectsHeartbeatIntoGzippedHTMLResponse(t *testing.T) {
	const page = "<html><body>bucket browser</body></html>"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Encoding", "gzip")
		w.WriteHeader(http.StatusOK)
		zw := gzip.NewWriter(w)
		_, _ = zw.Write([]byte(page))
		_ = zw.Close()
	}))
	defer upstream.Close()

	targetURL, _ := url.Parse(upstream.URL)
	rs := &ResolvedSession{
		Session:  &models.WebProxySession{ID: "wps-1", Subdomain: "app-abc12345"},
		Upstream: &UpstreamState{},
		Target:   targetURL,
	}
	h := NewHandler(testService(defaultTestConfig()), zap.NewNop())
	req := httptest.NewRequest(http.MethodGet, "http://app-abc12345.pam.example.com/", nil)
	rec := httptest.NewRecorder()
	h.buildReverseProxy(rs).ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "bucket browser") {
		t.Fatalf("upstream page did not survive the proxy: %q", body)
	}
	if !strings.Contains(body, string(heartbeatScriptTag)) {
		t.Fatalf("no heartbeat beacon in a gzipped HTML page — tab close will never be detected for this target:\n%s", body)
	}
	if got := rec.Result().Header.Get("Content-Length"); got != strconv.Itoa(len(body)) {
		t.Fatalf("Content-Length = %q, want %q", got, strconv.Itoa(len(body)))
	}
}

// Chunked HTML (no Content-Length at all) is the same class of failure
// reached by a different route — a server-rendered page streamed to the
// client. It must get the beacon too.
func TestReverseProxyInjectsHeartbeatIntoChunkedHTMLResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		// No Content-Length set and flushed in pieces => chunked.
		_, _ = w.Write([]byte("<html><body>part one"))
		w.(http.Flusher).Flush()
		_, _ = w.Write([]byte(" part two</body></html>"))
	}))
	defer upstream.Close()

	targetURL, _ := url.Parse(upstream.URL)
	rs := &ResolvedSession{
		Session:  &models.WebProxySession{ID: "wps-1", Subdomain: "app-abc12345"},
		Upstream: &UpstreamState{},
		Target:   targetURL,
	}
	h := NewHandler(testService(defaultTestConfig()), zap.NewNop())
	req := httptest.NewRequest(http.MethodGet, "http://app-abc12345.pam.example.com/", nil)
	rec := httptest.NewRecorder()
	h.buildReverseProxy(rs).ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "part one part two") {
		t.Fatalf("chunked page was corrupted by the proxy: %q", body)
	}
	if !strings.Contains(body, string(heartbeatScriptTag)) {
		t.Fatalf("no heartbeat beacon in a chunked HTML page:\n%s", body)
	}
}

// A bodiless response must not acquire a body (or a bogus Content-Length)
// just because its Content-Type says HTML.
func TestReverseProxyDoesNotInjectIntoNotModifiedResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotModified)
	}))
	defer upstream.Close()

	targetURL, _ := url.Parse(upstream.URL)
	rs := &ResolvedSession{
		Session:  &models.WebProxySession{ID: "wps-1", Subdomain: "app-abc12345"},
		Upstream: &UpstreamState{},
		Target:   targetURL,
	}
	h := NewHandler(testService(defaultTestConfig()), zap.NewNop())
	req := httptest.NewRequest(http.MethodGet, "http://app-abc12345.pam.example.com/app.html", nil)
	rec := httptest.NewRecorder()
	h.buildReverseProxy(rs).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", rec.Code)
	}
	if body := rec.Body.String(); body != "" {
		t.Fatalf("304 must stay bodiless, got %q", body)
	}
}
