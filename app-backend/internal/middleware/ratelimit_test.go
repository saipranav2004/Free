package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

func rlRouter(t *testing.T, cfg RateLimitConfig) (*gin.Engine, *[]string) {
	t.Helper()
	hits := &[]string{}
	mw := RateLimit(cfg, func(ip, path, ua string) { *hits = append(*hits, ip) }, zap.NewNop())
	r := gin.New()
	if err := r.SetTrustedProxies(nil); err != nil {
		t.Fatalf("SetTrustedProxies: %v", err)
	}
	r.POST("/api/v1/auth/login", mw, func(c *gin.Context) { c.String(200, "ok") })
	return r, hits
}

func post(r *gin.Engine, remoteAddr string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	req.RemoteAddr = remoteAddr
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestBurstIsAllowedThenTheSourceIsThrottled(t *testing.T) {
	r, hits := rlRouter(t, RateLimitConfig{Enabled: true, PerMinute: 10, Burst: 5})

	for i := 0; i < 5; i++ {
		if got := post(r, "203.0.113.5:1").Code; got != 200 {
			t.Fatalf("attempt %d is inside the burst and must pass, got %d", i+1, got)
		}
	}
	w := post(r, "203.0.113.5:1")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("the attempt past the burst must be throttled, got %d", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("a 429 must tell the caller how long to wait")
	}
	if len(*hits) != 1 {
		t.Fatalf("the throttled attempt must be recorded once, got %d", len(*hits))
	}
}

// The limiter must bound one attacker without touching anybody else. A shared
// counter would turn a single brute-force source into an outage for the whole
// company, which is a denial of service delivered by the defence.
func TestThrottlingIsPerSourceNotGlobal(t *testing.T) {
	r, _ := rlRouter(t, RateLimitConfig{Enabled: true, PerMinute: 10, Burst: 2})

	post(r, "203.0.113.5:1")
	post(r, "203.0.113.5:1")
	if got := post(r, "203.0.113.5:1").Code; got != http.StatusTooManyRequests {
		t.Fatalf("the noisy source must be throttled, got %d", got)
	}
	if got := post(r, "203.0.113.6:1").Code; got != 200 {
		t.Fatalf("a different source must be unaffected, got %d", got)
	}
}

func TestAllowanceRefillsOverTime(t *testing.T) {
	// 600/minute is 10 per second, so one token returns in ~100ms.
	r, _ := rlRouter(t, RateLimitConfig{Enabled: true, PerMinute: 600, Burst: 1})

	if got := post(r, "203.0.113.5:1").Code; got != 200 {
		t.Fatalf("first attempt must pass, got %d", got)
	}
	if got := post(r, "203.0.113.5:1").Code; got != http.StatusTooManyRequests {
		t.Fatalf("second immediate attempt must be throttled, got %d", got)
	}
	time.Sleep(150 * time.Millisecond)
	if got := post(r, "203.0.113.5:1").Code; got != 200 {
		t.Fatalf("after the refill interval the attempt must pass again, got %d", got)
	}
}

func TestDisabledLimiterPassesEverything(t *testing.T) {
	r, hits := rlRouter(t, RateLimitConfig{Enabled: false, PerMinute: 1, Burst: 1})
	for i := 0; i < 20; i++ {
		if got := post(r, "203.0.113.5:1").Code; got != 200 {
			t.Fatalf("with the limiter off every attempt must pass, got %d", got)
		}
	}
	if len(*hits) != 0 {
		t.Fatal("a disabled limiter must record nothing")
	}
}

// Nonsense configuration must clamp to something workable rather than lock the
// endpoint out entirely.
func TestNonPositiveSettingsClampInsteadOfBlockingEveryone(t *testing.T) {
	r, _ := rlRouter(t, RateLimitConfig{Enabled: true, PerMinute: 0, Burst: 0})
	if got := post(r, "203.0.113.5:1").Code; got != 200 {
		t.Fatalf("a burst of at least 1 must survive clamping, got %d", got)
	}
}

// The key is chosen by the caller, so the store must never grow without bound.
func TestBucketStoreStaysUnderItsCap(t *testing.T) {
	s := newBucketStore(1, 5, time.Hour, 10)
	for i := 0; i < 500; i++ {
		s.take(netipKey(i))
	}
	if len(s.buckets) > 10 {
		t.Fatalf("store must stay under its cap, got %d buckets", len(s.buckets))
	}
}

func TestIdleBucketsAreReclaimed(t *testing.T) {
	s := newBucketStore(1, 5, 20*time.Millisecond, 1000)
	s.take("203.0.113.1")
	s.take("203.0.113.2")
	if len(s.buckets) != 2 {
		t.Fatalf("expected 2 buckets, got %d", len(s.buckets))
	}
	time.Sleep(40 * time.Millisecond)
	s.take("203.0.113.3") // triggers the inline sweep
	if len(s.buckets) != 1 {
		t.Fatalf("idle buckets must be reclaimed, got %d", len(s.buckets))
	}
}

func netipKey(i int) string {
	return "203.0.113." + string(rune('0'+i%10)) + "." + string(rune('0'+i/10%10))
}
