package config

import (
	"strings"
	"testing"
)

// The perimeter must fail at boot rather than in production traffic. Both
// cases below are configurations that look enabled and are not safe.

func TestAllowlistWithoutATrustedProxyDecisionRefusesToBoot(t *testing.T) {
	c := &Config{}
	c.Server.Env = "production"
	c.Network.AllowlistEnabled = true
	c.Network.AllowedCIDRs = "203.0.113.0/24"

	err := c.validateNetwork()
	if err == nil {
		t.Fatal("an allowlist with X-Forwarded-For trusted from everywhere is bypassable and must not boot")
	}
	if !strings.Contains(err.Error(), "PAM_NETWORK_TRUSTED_PROXIES") {
		t.Fatalf("the error must name the setting to fix: %v", err)
	}
}

func TestAllowlistWithNoRangesRefusesToBoot(t *testing.T) {
	c := &Config{}
	c.Network.AllowlistEnabled = true
	c.Network.TrustedProxies = "none"
	c.Network.AllowedCIDRs = "   "

	if err := c.validateNetwork(); err == nil {
		t.Fatal("an empty allowlist would refuse every request including the administrator's")
	}
}

func TestValidConfigurationsBoot(t *testing.T) {
	for _, tc := range []struct{ name, proxies, cidrs string }{
		{"behind a load balancer", "10.0.0.0/8, 172.16.0.0/12", "203.0.113.0/24"},
		{"reached directly", "none", "203.0.113.0/24 2001:db8::/32"},
	} {
		c := &Config{}
		c.Network.AllowlistEnabled = true
		c.Network.TrustedProxies = tc.proxies
		c.Network.AllowedCIDRs = tc.cidrs
		if err := c.validateNetwork(); err != nil {
			t.Fatalf("%s should boot: %v", tc.name, err)
		}
	}
}

func TestDisabledAllowlistNeverBlocksBoot(t *testing.T) {
	c := &Config{}
	c.Network.AllowlistEnabled = false
	if err := c.validateNetwork(); err != nil {
		t.Fatalf("a disabled allowlist must not require any other setting: %v", err)
	}
}

// "none" means trust nothing, which gin spells as a nil slice. A blank value
// resolves the same way, but validateNetwork refuses to let it reach here with
// the allowlist on, so the two are never confused in a live deployment.
func TestTrustedProxyParsing(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"none", nil},
		{"NONE", nil},
		{"  ", nil},
		{"10.0.0.0/8", []string{"10.0.0.0/8"}},
		{"10.0.0.0/8, 172.16.0.0/12", []string{"10.0.0.0/8", "172.16.0.0/12"}},
		{"10.0.0.0/8\n172.16.0.0/12", []string{"10.0.0.0/8", "172.16.0.0/12"}},
	}
	for _, tc := range cases {
		got := NetworkConfig{TrustedProxies: tc.in}.TrustedProxyCIDRs()
		if len(got) != len(tc.want) {
			t.Fatalf("%q -> %v, want %v", tc.in, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("%q -> %v, want %v", tc.in, got, tc.want)
			}
		}
	}
}

// The reason every list is a string: a comma-separated env var must not become
// one nonsense entry.
func TestCommaSeparatedEnvValueSplitsIntoSeparateRanges(t *testing.T) {
	n := NetworkConfig{AllowedCIDRs: "203.0.113.0/24,198.51.100.7 , 2001:db8::/32"}
	got := n.AllowedCIDRList()
	if len(got) != 3 {
		t.Fatalf("want 3 ranges, got %d: %v", len(got), got)
	}
	if got[1] != "198.51.100.7" {
		t.Fatalf("entries must be trimmed, got %q", got[1])
	}
}
