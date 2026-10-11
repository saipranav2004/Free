package vaultclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testToken = "pamsvc.deadbeef.c2VjcmV0LXZhbHVl"

// vaultStub is a minimal stand-in for the PAM data plane. It counts requests
// so the caching claims can be asserted rather than assumed.
type vaultStub struct {
	mu      sync.Mutex
	hits    int32
	version int
	ttl     int
	status  int // when non-zero, returned instead of a secret
	delay   time.Duration
}

func (v *vaultStub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&v.hits, 1)

		v.mu.Lock()
		status, ttl, version, delay := v.status, v.ttl, v.version, v.delay
		v.mu.Unlock()

		if delay > 0 {
			time.Sleep(delay)
		}
		if status != 0 {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false})
			return
		}
		if r.Header.Get("X-Service-Token") != testToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Query().Get("purpose") == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		path := strings.TrimPrefix(r.URL.Path, "/api/v1/pam/svc/secrets/")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"data": map[string]any{
				"path":              path,
				"secret_value":      fmt.Sprintf("pw-v%d", version),
				"account_name":      "app_user",
				"credential_type":   "password",
				"version":           version,
				"cache_ttl_seconds": ttl,
			},
		})
	})
}

func (v *vaultStub) setStatus(s int) { v.mu.Lock(); v.status = s; v.mu.Unlock() }
func (v *vaultStub) rotate()         { v.mu.Lock(); v.version++; v.mu.Unlock() }
func (v *vaultStub) setTTL(t int)    { v.mu.Lock(); v.ttl = t; v.mu.Unlock() }
func (v *vaultStub) setDelay(d time.Duration) {
	v.mu.Lock()
	v.delay = d
	v.mu.Unlock()
}
func (v *vaultStub) count() int { return int(atomic.LoadInt32(&v.hits)) }

func newTestClient(t *testing.T, srv *httptest.Server, tune func(*Config)) *Client {
	t.Helper()
	cfg := Config{
		Address:                srv.URL,
		Purpose:                "unit test",
		Token:                  testToken,
		AllowInsecureTransport: true,
		MaxRetries:             0,
	}
	if tune != nil {
		tune(&cfg)
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// A repeated read inside the TTL must not touch the vault again, this is the
// "minimise unnecessary vault calls" claim.
func TestGetServesFromCache(t *testing.T) {
	stub := &vaultStub{ttl: 300, version: 1}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := newTestClient(t, srv, nil)
	ctx := context.Background()

	for i := 0; i < 20; i++ {
		s, err := c.Get(ctx, "prod-db/postgres/pg-app")
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if s.Value != "pw-v1" || s.AccountName != "app_user" {
			t.Fatalf("unexpected secret: %s value=%q", s, s.Value)
		}
	}
	if got := stub.count(); got != 1 {
		t.Fatalf("expected 1 vault request, got %d", got)
	}
}

// Concurrent cold-start misses must collapse onto one request.
func TestConcurrentMissesAreCollapsed(t *testing.T) {
	stub := &vaultStub{ttl: 300, version: 1}
	stub.setDelay(50 * time.Millisecond)
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := newTestClient(t, srv, nil)

	var wg sync.WaitGroup
	errs := make(chan error, 100)
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Get(context.Background(), "prod-db/postgres/pg-app"); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent Get: %v", err)
	}

	if got := stub.count(); got != 1 {
		t.Fatalf("expected 100 concurrent misses to collapse to 1 request, got %d", got)
	}
}

// Past refreshAt but before expiry: the caller is served immediately from
// cache and the new version lands in the background.
func TestStaleReadTriggersBackgroundRefresh(t *testing.T) {
	stub := &vaultStub{ttl: 1, version: 1}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	// refreshLead 0.1 of a 1s TTL → stale after ~100ms, expired after 1s.
	c := newTestClient(t, srv, func(cfg *Config) { cfg.RefreshLead = 0.1 })
	ctx := context.Background()

	if _, err := c.Get(ctx, "a/b/c"); err != nil {
		t.Fatalf("initial Get: %v", err)
	}
	stub.rotate() // vault now serves v2

	time.Sleep(250 * time.Millisecond) // past refreshAt, well before expiry

	// This read is served from cache (still v1) and schedules the refresh.
	s, err := c.Get(ctx, "a/b/c")
	if err != nil {
		t.Fatalf("stale Get: %v", err)
	}
	if s.Version != 1 {
		t.Fatalf("stale read should be served from cache without blocking, got version %d", s.Version)
	}

	// The background refresh should replace it shortly, with no read blocking.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s, _ = c.Get(ctx, "a/b/c"); s.Version == 2 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("background refresh never picked up the rotation (still version %d)", s.Version)
}

// A vault outage must degrade to slightly-stale credentials, not an error.
func TestServesStaleWhenVaultUnavailable(t *testing.T) {
	stub := &vaultStub{ttl: 1, version: 7}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := newTestClient(t, srv, func(cfg *Config) {
		cfg.StaleGrace = time.Minute
		cfg.RefreshLead = 0.9
	})
	ctx := context.Background()

	if _, err := c.Get(ctx, "a/b/c"); err != nil {
		t.Fatalf("initial Get: %v", err)
	}

	stub.setStatus(http.StatusServiceUnavailable)
	time.Sleep(1100 * time.Millisecond) // now past expiry

	s, err := c.Get(ctx, "a/b/c")
	if err != nil {
		t.Fatalf("expected stale fallback, got error: %v", err)
	}
	if s.Version != 7 {
		t.Fatalf("expected the cached version 7, got %d", s.Version)
	}
}

// An authoritative denial must evict, not fall back to stale.
func TestForbiddenEvictsCachedSecret(t *testing.T) {
	stub := &vaultStub{ttl: 1, version: 1}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := newTestClient(t, srv, func(cfg *Config) {
		cfg.StaleGrace = time.Minute
		cfg.RefreshLead = 0.9
	})
	ctx := context.Background()

	if _, err := c.Get(ctx, "a/b/c"); err != nil {
		t.Fatalf("initial Get: %v", err)
	}

	stub.setStatus(http.StatusForbidden)
	time.Sleep(1100 * time.Millisecond)

	if _, err := c.Get(ctx, "a/b/c"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden (grant revoked must not serve stale), got %v", err)
	}
	// And the entry must be gone rather than lingering for the grace window.
	c.mu.RLock()
	_, present := c.entries["a/b/c"]
	c.mu.RUnlock()
	if present {
		t.Fatal("revoked secret is still cached")
	}
}

func TestStatusCodeMapping(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   error
	}{
		{http.StatusUnauthorized, ErrUnauthenticated},
		{http.StatusForbidden, ErrForbidden},
		{http.StatusNotFound, ErrNotFound},
		{http.StatusConflict, ErrAmbiguous},
	} {
		stub := &vaultStub{ttl: 60, version: 1}
		stub.setStatus(tc.status)
		srv := httptest.NewServer(stub.handler())

		c := newTestClient(t, srv, nil)
		_, err := c.Get(context.Background(), "a/b/c")
		if !errors.Is(err, tc.want) {
			t.Errorf("status %d: expected %v, got %v", tc.status, tc.want, err)
		}
		srv.Close()
	}
}

// The redaction contract: no formatting verb and no JSON encoder may emit the
// plaintext.
func TestSecretNeverRendersItsValue(t *testing.T) {
	s := Secret{Path: "a/b/c", Value: "hunter2", AccountName: "app_user", Type: "password", Version: 3}

	for _, rendered := range []string{
		fmt.Sprintf("%v", s),
		fmt.Sprintf("%+v", s),
		fmt.Sprintf("%s", s),
		fmt.Sprintf("%#v", s),
		fmt.Sprintf("%v", &s),
	} {
		if strings.Contains(rendered, "hunter2") {
			t.Fatalf("secret value leaked through formatting: %s", rendered)
		}
	}

	b, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(b), "hunter2") {
		t.Fatalf("secret value leaked through JSON: %s", b)
	}
	if strings.Contains(string(b), "[REDACTED]") == false {
		t.Fatalf("expected redaction marker, got %s", b)
	}
}

func TestNewRejectsUnsafeConfig(t *testing.T) {
	cases := map[string]Config{
		"plaintext http":  {Address: "http://vault.internal", Purpose: "p", Token: testToken},
		"no purpose":      {Address: "https://vault.internal", Token: testToken, AllowInsecureTransport: true},
		"no address":      {Purpose: "p", Token: testToken},
		"malformed token": {Address: "https://vault.internal", Purpose: "p", Token: "not-a-token"},
	}
	for name, cfg := range cases {
		t.Run(name, func(t *testing.T) {
			t.Setenv("PAM_SERVICE_TOKEN", "")
			if _, err := New(cfg); err == nil {
				t.Fatal("expected New to reject this configuration")
			}
		})
	}
}

func TestCloseDropsCachedPlaintext(t *testing.T) {
	stub := &vaultStub{ttl: 300, version: 1}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	c := newTestClient(t, srv, nil)
	if _, err := c.Get(context.Background(), "a/b/c"); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	c.mu.RLock()
	n := len(c.entries)
	c.mu.RUnlock()
	if n != 0 {
		t.Fatalf("expected cache to be emptied on Close, %d entries remain", n)
	}
	if _, err := c.Get(context.Background(), "a/b/c"); !errors.Is(err, ErrClosed) {
		t.Fatalf("expected ErrClosed after Close, got %v", err)
	}
	_ = c.Close() // idempotent
}
