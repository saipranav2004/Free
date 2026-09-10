// pam/internal/services/network_allowlist_proxy_test.go
//
// The guard that stops the allowlist from being switched on in the one state
// where it silently does nothing.
//
// The allowlist compares c.ClientIP() against the stored ranges. That is only
// the operator's address when the deployment has said which proxies to
// believe. Unset, behind a load balancer, every request carries the
// balancer's address: the operator sees it in the console, clicks the button
// that adds "their" address, enables enforcement, and the product is now open
// to every network that can reach the balancer. Nothing looks wrong at any
// step, which is why it needs a refusal rather than a warning.
package services

import (
	"errors"
	"strings"
	"testing"

	"github.com/yourorg/pam/internal/config"
)

// The dangerous combination, refused. A private caller address plus a
// deployment that never answered the proxy question is exactly the load
// balancer case.
func TestEnablingIsRefusedWhenTheProxyQuestionIsUnanswered(t *testing.T) {
	svc := newAllowlistServiceWithProxyState(t, config.TrustedProxyUndecided)

	// The operator adds the address the console showed them, which behind an
	// unconfigured balancer IS the balancer.
	if _, err := svc.AddEntry("10.0.3.44", "my address", "u-root", "root"); err != nil {
		t.Fatalf("AddEntry: %v", err)
	}

	err := svc.SetEnabled(true, "10.0.3.44", "u-root", "root")
	if err == nil {
		t.Fatal("enforcement was switched on while the API cannot tell whose address it sees; " +
			"the list would then match every request through the proxy and block nothing")
	}
	if !errors.Is(err, ErrProxyUnresolved) {
		t.Fatalf("error = %v, want ErrProxyUnresolved", err)
	}
	// The message has to name the way out, because the operator's instinct
	// here is to add more ranges, which makes it worse.
	for _, want := range []string{"10.0.3.44", "PAM_NETWORK_TRUSTED_PROXIES", "none"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message does not mention %q: %v", want, err)
		}
	}

	// And it really is off.
	snap, err := svc.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if snap.Enabled {
		t.Fatal("enforcement was persisted despite the refusal")
	}
}

// Answering the question either way is the fix, and both answers work. This
// is what keeps the guard from being something operators have to defeat.
func TestEnablingIsAllowedOnceTheProxyQuestionIsAnswered(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state config.TrustedProxyState
	}{
		{"proxy ranges configured", config.TrustedProxyConfigured},
		{"declared reached directly", config.TrustedProxyDirect},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := newAllowlistServiceWithProxyState(t, tc.state)
			if _, err := svc.AddEntry("10.0.3.44", "office", "u-root", "root"); err != nil {
				t.Fatalf("AddEntry: %v", err)
			}
			if err := svc.SetEnabled(true, "10.0.3.44", "u-root", "root"); err != nil {
				t.Fatalf("SetEnabled: %v — answering the proxy question must be enough to proceed", err)
			}
		})
	}
}

// A public caller address reached this process directly. Nothing was
// forwarded, so nothing could have been misread, and refusing would be a
// false alarm on a correct deployment.
func TestAPublicCallerIsNotRefused(t *testing.T) {
	svc := newAllowlistServiceWithProxyState(t, config.TrustedProxyUndecided)
	if _, err := svc.AddEntry("203.0.113.7", "office", "u-root", "root"); err != nil {
		t.Fatalf("AddEntry: %v", err)
	}
	if err := svc.SetEnabled(true, "203.0.113.7", "u-root", "root"); err != nil {
		t.Fatalf("SetEnabled: %v", err)
	}
}

// Turning enforcement OFF is never gated. Recovery must not itself be
// blocked by the guard that describes the problem.
func TestDisablingIsNeverRefusedByTheProxyGuard(t *testing.T) {
	svc := newAllowlistServiceWithProxyState(t, config.TrustedProxyUndecided)
	if err := svc.SetEnabled(false, "10.0.3.44", "u-root", "root"); err != nil {
		t.Fatalf("SetEnabled(false): %v", err)
	}
}

// Which addresses count as "a machine between the operator and the API".
func TestInfrastructureAddressClassification(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
		why  string
	}{
		{"10.0.3.44", true, "RFC1918"},
		{"172.16.9.1", true, "RFC1918"},
		{"192.168.1.10", true, "RFC1918"},
		{"100.64.0.7", true, "RFC6598 carrier-grade NAT, which several cloud load balancers use"},
		{"169.254.10.1", true, "link-local"},
		{"fd00::1", true, "IPv6 unique local"},
		{"203.0.113.7", false, "public"},
		{"2001:db8::1", false, "public"},
		{"127.0.0.1", false, "loopback is somebody on the host, handled separately"},
		{"::1", false, "loopback"},
		{"not-an-ip", false, "unparseable is not evidence of a proxy"},
		{"", false, "empty is not evidence of a proxy"},
	}
	for _, tc := range cases {
		if got := IsInfrastructureAddress(tc.ip); got != tc.want {
			t.Errorf("IsInfrastructureAddress(%q) = %v, want %v (%s)", tc.ip, got, tc.want, tc.why)
		}
	}
}

// The generated nginx file has to declare which address the API is comparing,
// because nginx compares a different one and the two are configured
// separately. Getting one right and the other wrong produces a 403 from nginx
// on a console the API is perfectly happy to serve.
func TestSnippetDeclaresTheProxyState(t *testing.T) {
	for _, tc := range []struct {
		state config.TrustedProxyState
		want  string
	}{
		{config.TrustedProxyUndecided, "UNDECIDED"},
		{config.TrustedProxyDirect, "declared direct"},
		{config.TrustedProxyConfigured, "trusted proxy ranges are configured"},
	} {
		t.Run(string(tc.state), func(t *testing.T) {
			svc := newAllowlistServiceWithProxyState(t, tc.state)
			snippet, err := svc.NginxSnippet()
			if err != nil {
				t.Fatalf("NginxSnippet: %v", err)
			}
			if !strings.Contains(snippet, tc.want) {
				t.Fatalf("snippet does not declare the state %q:\n%s", tc.state, snippet)
			}
			// Still only comments and directives: this file is included from
			// inside an nginx server block.
			for _, line := range strings.Split(strings.TrimSpace(snippet), "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				if !strings.HasPrefix(line, "allow ") && !strings.HasPrefix(line, "deny ") {
					t.Fatalf("snippet emitted something other than a comment or an allow/deny directive: %q", line)
				}
			}
		})
	}
}
