package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

func init() { gin.SetMode(gin.TestMode) }

// build wires the middleware into a router whose ClientIP behaviour matches
// production: trustedProxies nil means X-Forwarded-For is ignored and the
// socket peer decides, which is exactly what main.go configures when no
// reverse proxy is declared.
func build(t *testing.T, cfg NetworkAllowlistConfig, trustXFFFrom []string) (*gin.Engine, *[]auditCall) {
	t.Helper()
	calls := &[]auditCall{}
	audit := func(ip, path, ua string, breakGlass bool) {
		*calls = append(*calls, auditCall{ip: ip, path: path, breakGlass: breakGlass})
	}
	mw, err := NetworkAllowlist(cfg, audit, zap.NewNop())
	if err != nil {
		t.Fatalf("NetworkAllowlist: %v", err)
	}
	r := gin.New()
	if err := r.SetTrustedProxies(trustXFFFrom); err != nil {
		t.Fatalf("SetTrustedProxies: %v", err)
	}
	r.Use(mw)
	r.GET("/api/health", func(c *gin.Context) { c.String(200, "ok") })
	r.GET("/api/v1/pam/resources", func(c *gin.Context) { c.String(200, "data") })
	return r, calls
}

type auditCall struct {
	ip         string
	path       string
	breakGlass bool
}

func do(r *gin.Engine, path, remoteAddr string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.RemoteAddr = remoteAddr
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// ── the control itself ────────────────────────────────────────────────────

func TestApprovedRangeIsAdmittedAndUnapprovedIsRefused(t *testing.T) {
	r, calls := build(t, NetworkAllowlistConfig{
		Enabled:      true,
		AllowedCIDRs: []string{"203.0.113.0/24"},
	}, nil)

	if got := do(r, "/api/v1/pam/resources", "203.0.113.44:5555", nil).Code; got != 200 {
		t.Fatalf("office address must be admitted, got %d", got)
	}
	if got := do(r, "/api/v1/pam/resources", "198.51.100.9:5555", nil).Code; got != 403 {
		t.Fatalf("address outside every approved range must be refused, got %d", got)
	}
	if len(*calls) != 1 || (*calls)[0].ip != "198.51.100.9" {
		t.Fatalf("the refusal must be audited with the real source, got %+v", *calls)
	}
}

func TestRefusalDoesNotDiscloseThePolicy(t *testing.T) {
	r, _ := build(t, NetworkAllowlistConfig{
		Enabled:      true,
		AllowedCIDRs: []string{"203.0.113.0/24", "198.51.100.7"},
	}, nil)

	body := do(r, "/api/v1/pam/resources", "192.0.2.1:1", nil).Body.String()
	for _, leak := range []string{"203.0.113", "198.51.100", "/24"} {
		if strings.Contains(body, leak) {
			t.Fatalf("the 403 body must not name approved ranges, found %q in %s", leak, body)
		}
	}
}

// THE TEST THAT MATTERS MOST. Gin trusts X-Forwarded-For from every source by
// default, which would let any client pick its own address and walk straight
// through the allowlist. main.go must call SetTrustedProxies; this asserts the
// consequence of getting that wrong, and of getting it right.
func TestForgedForwardedHeaderCannotBypassTheAllowlist(t *testing.T) {
	r, _ := build(t, NetworkAllowlistConfig{
		Enabled:      true,
		AllowedCIDRs: []string{"203.0.113.0/24"},
	}, nil) // no proxy trusted

	w := do(r, "/api/v1/pam/resources", "198.51.100.9:5555", map[string]string{
		"X-Forwarded-For": "203.0.113.44",
		"X-Real-IP":       "203.0.113.44",
	})
	if w.Code != 403 {
		t.Fatalf("a client-supplied X-Forwarded-For must not admit an unapproved source, got %d", w.Code)
	}
}

func TestForwardedHeaderIsHonouredOnlyFromADeclaredProxy(t *testing.T) {
	// The real deployment: nginx or an ALB on 10.0.0.0/8 in front, forwarding
	// the true client address.
	r, _ := build(t, NetworkAllowlistConfig{
		Enabled:      true,
		AllowedCIDRs: []string{"203.0.113.0/24"},
	}, []string{"10.0.0.0/8"})

	fromProxy := do(r, "/api/v1/pam/resources", "10.0.5.6:443", map[string]string{
		"X-Forwarded-For": "203.0.113.44",
	})
	if fromProxy.Code != 200 {
		t.Fatalf("behind a declared proxy the forwarded office address must be admitted, got %d", fromProxy.Code)
	}

	proxyForwardingAnOutsider := do(r, "/api/v1/pam/resources", "10.0.5.6:443", map[string]string{
		"X-Forwarded-For": "198.51.100.9",
	})
	if proxyForwardingAnOutsider.Code != 403 {
		t.Fatalf("a forwarded unapproved address must still be refused, got %d", proxyForwardingAnOutsider.Code)
	}

	directNotViaProxy := do(r, "/api/v1/pam/resources", "198.51.100.9:5555", map[string]string{
		"X-Forwarded-For": "203.0.113.44",
	})
	if directNotViaProxy.Code != 403 {
		t.Fatalf("a header from a source that is not the declared proxy must be ignored, got %d", directNotViaProxy.Code)
	}
}

// ── addressing ────────────────────────────────────────────────────────────

func TestIPv6RangesAreEnforcedIndependentlyOfIPv4(t *testing.T) {
	r, _ := build(t, NetworkAllowlistConfig{
		Enabled:      true,
		AllowedCIDRs: []string{"2001:db8:acad::/48", "203.0.113.0/24"},
	}, nil)

	if got := do(r, "/api/v1/pam/resources", "[2001:db8:acad::10]:5555", nil).Code; got != 200 {
		t.Fatalf("approved IPv6 range must be admitted, got %d", got)
	}
	if got := do(r, "/api/v1/pam/resources", "[2001:db8:beef::10]:5555", nil).Code; got != 403 {
		t.Fatalf("unapproved IPv6 range must be refused, got %d", got)
	}
	// An office's v4 range must not implicitly admit v6 traffic.
	if got := do(r, "/api/v1/pam/resources", "[::1]:5555", nil).Code; got != 403 {
		t.Fatalf("IPv6 loopback is not in any approved range, got %d", got)
	}
}

// An IPv4 client reaching a dual-stack listener arrives as ::ffff:203.0.113.44.
// Without unmapping, that address matches no IPv4 rule and a whole office is
// locked out by a socket detail.
func TestIPv4MappedIPv6ClientMatchesTheIPv4Rule(t *testing.T) {
	r, _ := build(t, NetworkAllowlistConfig{
		Enabled:      true,
		AllowedCIDRs: []string{"203.0.113.0/24"},
	}, nil)

	if got := do(r, "/api/v1/pam/resources", "[::ffff:203.0.113.44]:5555", nil).Code; got != 200 {
		t.Fatalf("IPv4-mapped form of an approved address must be admitted, got %d", got)
	}
}

func TestBareAddressInConfigIsASingleHostRule(t *testing.T) {
	r, _ := build(t, NetworkAllowlistConfig{
		Enabled:      true,
		AllowedCIDRs: []string{"198.51.100.7"},
	}, nil)

	if got := do(r, "/api/v1/pam/resources", "198.51.100.7:1", nil).Code; got != 200 {
		t.Fatalf("the single approved host must be admitted, got %d", got)
	}
	if got := do(r, "/api/v1/pam/resources", "198.51.100.8:1", nil).Code; got != 403 {
		t.Fatalf("its neighbour must not be, got %d", got)
	}
}

// "203.0.113.7/24" is a range with host bits set. Masking makes it behave as
// the /24 its author meant; without it the rule matches nothing at all.
func TestCIDRWithHostBitsSetIsMasked(t *testing.T) {
	prefixes, err := parsePrefixes([]string{"203.0.113.7/24"})
	if err != nil {
		t.Fatalf("a CIDR with host bits set must be accepted: %v", err)
	}
	if got := prefixes[0].String(); got != "203.0.113.0/24" {
		t.Fatalf("want masked 203.0.113.0/24, got %s", got)
	}
}

// ── configuration errors are boot failures ────────────────────────────────

func TestEnabledWithNoRangesRefusesToBuild(t *testing.T) {
	_, err := NetworkAllowlist(NetworkAllowlistConfig{Enabled: true}, nil, zap.NewNop())
	if err == nil {
		t.Fatal("an enabled allowlist with no ranges must fail at boot, not deny every request at runtime")
	}
	if !strings.Contains(err.Error(), "PAM_NETWORK_ALLOWED_CIDRS") {
		t.Fatalf("the error must name the setting to fix: %v", err)
	}
}

func TestMalformedRangeRefusesToBuild(t *testing.T) {
	for _, bad := range []string{"203.0.113.0/33", "not-an-ip", "203.0.113.0/", "2001:db8::/129"} {
		if _, err := NetworkAllowlist(NetworkAllowlistConfig{
			Enabled: true, AllowedCIDRs: []string{"203.0.113.0/24", bad},
		}, nil, zap.NewNop()); err == nil {
			t.Fatalf("%q must be rejected at boot", bad)
		}
	}
}

func TestIPv4MappedPrefixIsRejectedRatherThanSilentlyDead(t *testing.T) {
	_, err := parsePrefixes([]string{"::ffff:203.0.113.0/120"})
	if err == nil {
		t.Fatal("a rule that can never match must be rejected, not accepted and ignored")
	}
}

func TestDisabledAllowlistPassesEverythingThrough(t *testing.T) {
	r, _ := build(t, NetworkAllowlistConfig{Enabled: false}, nil)
	if got := do(r, "/api/v1/pam/resources", "198.51.100.9:1", nil).Code; got != 200 {
		t.Fatalf("with the control off every source must pass, got %d", got)
	}
}

// ── operational behaviour ─────────────────────────────────────────────────

// A health probe originates from the load balancer, not from an office. If it
// is refused the instance leaves the pool and the allowlist causes the outage
// it exists to prevent.
func TestExemptPathIsReachableFromAnywhere(t *testing.T) {
	r, calls := build(t, NetworkAllowlistConfig{
		Enabled:      true,
		AllowedCIDRs: []string{"203.0.113.0/24"},
		ExemptPaths:  []string{"/api/health"},
	}, nil)

	if got := do(r, "/api/health", "10.4.5.6:1", nil).Code; got != 200 {
		t.Fatalf("the health probe must never be refused, got %d", got)
	}
	if got := do(r, "/api/v1/pam/resources", "10.4.5.6:1", nil).Code; got != 403 {
		t.Fatalf("exemption must not leak to other paths, got %d", got)
	}
	if len(*calls) != 1 {
		t.Fatalf("only the data request should have been audited, got %+v", *calls)
	}
}

func TestBreakGlassAdmitsAndIsAlwaysAudited(t *testing.T) {
	r, calls := build(t, NetworkAllowlistConfig{
		Enabled:         true,
		AllowedCIDRs:    []string{"203.0.113.0/24"},
		BreakGlassCIDRs: []string{"198.51.100.7"},
	}, nil)

	for i := 0; i < 3; i++ {
		if got := do(r, "/api/v1/pam/resources", "198.51.100.7:1", nil).Code; got != 200 {
			t.Fatalf("break-glass address must be admitted, got %d", got)
		}
	}
	if len(*calls) != 3 {
		t.Fatalf("every break-glass admission must be audited, unthrottled; got %d", len(*calls))
	}
	for _, c := range *calls {
		if !c.breakGlass {
			t.Fatal("break-glass admissions must be marked as such")
		}
	}
}

// Ordinary allowed traffic writes no audit rows. One row per request would
// bury the refusals that actually matter.
func TestAllowedTrafficIsNotAudited(t *testing.T) {
	r, calls := build(t, NetworkAllowlistConfig{
		Enabled:      true,
		AllowedCIDRs: []string{"203.0.113.0/24"},
	}, nil)
	for i := 0; i < 5; i++ {
		do(r, "/api/v1/pam/resources", "203.0.113.44:1", nil)
	}
	if len(*calls) != 0 {
		t.Fatalf("normal admitted traffic must not be audited, got %d rows", len(*calls))
	}
}

// A scanner must not be able to turn a blocked probe into a storage incident.
func TestRepeatedRefusalsFromOneSourceAreThrottled(t *testing.T) {
	r, calls := build(t, NetworkAllowlistConfig{
		Enabled:      true,
		AllowedCIDRs: []string{"203.0.113.0/24"},
	}, nil)

	for i := 0; i < 50; i++ {
		do(r, "/api/v1/pam/resources", "198.51.100.9:1", nil)
	}
	if len(*calls) != 1 {
		t.Fatalf("50 refusals from one source must produce 1 audit row, got %d", len(*calls))
	}

	// A different source is still recorded: throttling is per address, not global.
	do(r, "/api/v1/pam/resources", "198.51.100.10:1", nil)
	if len(*calls) != 2 {
		t.Fatalf("a distinct source must still be recorded, got %d", len(*calls))
	}
}

func TestDenyThrottleIsBoundedAndReopensAfterItsWindow(t *testing.T) {
	th := newDenyThrottle(20*time.Millisecond, 4)
	if !th.allow("a") || th.allow("a") {
		t.Fatal("first call passes, immediate repeat does not")
	}
	time.Sleep(30 * time.Millisecond)
	if !th.allow("a") {
		t.Fatal("the window must reopen")
	}
	for i := 0; i < 100; i++ {
		th.allow(string(rune('a' + i%60)))
	}
	if len(th.lastSeen) > 4 {
		t.Fatalf("the map must stay under its cap, got %d entries", len(th.lastSeen))
	}
}

// Fail closed: an address this process cannot parse is one it cannot vouch for.
func TestUnparseableClientAddressIsRefused(t *testing.T) {
	if _, ok := parseClientAddr(""); ok {
		t.Fatal("empty address must not parse")
	}
	if _, ok := parseClientAddr("not-an-ip"); ok {
		t.Fatal("garbage must not parse")
	}
	if a, ok := parseClientAddr("203.0.113.9:443"); !ok || a.String() != "203.0.113.9" {
		t.Fatalf("host:port form must parse to the host, got %v %v", a, ok)
	}
	if a, ok := parseClientAddr("fe80::1%eth0"); !ok || a.String() != "fe80::1" {
		t.Fatalf("a zoned address must parse with the zone dropped, got %v %v", a, ok)
	}
}
