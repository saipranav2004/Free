package services

import (
	"errors"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/yourorg/pam/internal/config"
	"github.com/yourorg/pam/internal/models"
)

func newAllowlistService(t *testing.T) *NetworkAllowlistService {
	t.Helper()
	// Most tests are about the list itself, not about how the deployment is
	// fronted, so they run as a deployment that has answered the proxy
	// question. The tests that are about that answer use
	// newAllowlistServiceWithProxyState below.
	return newAllowlistServiceWithProxyState(t, config.TrustedProxyDirect)
}

func newAllowlistServiceWithProxyState(t *testing.T, state config.TrustedProxyState) *NetworkAllowlistService {
	t.Helper()
	// One in-memory database per test, named after the test. A shared
	// ":memory:" is the same database for every caller, so tests that create
	// and drop the same tables trip over each other; and an unnamed private
	// one is a NEW empty database per pooled connection, which loses the
	// schema the moment GORM opens a second. A unique name plus a single
	// connection is the combination that behaves like a real database.
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared&_pragma=busy_timeout(5000)"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("db handle: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := db.AutoMigrate(&models.NetworkAllowlistEntry{}, &models.NetworkAllowlistSettings{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return NewNetworkAllowlistService(db, state)
}

// What an operator types is not what should be stored: two spellings of the
// same network must land on one row, and a bare address must mean that
// address only.
func TestNormalizeCIDR(t *testing.T) {
	cases := []struct{ in, want string }{
		{"183.82.2.29", "183.82.2.29/32"},
		{" 183.82.2.29 ", "183.82.2.29/32"},
		{"10.0.0.0/8", "10.0.0.0/8"},
		// Host bits set. This is the shape people paste, and masking it is
		// unambiguous where rejecting it would only be annoying.
		{"183.82.2.29/24", "183.82.2.0/24"},
		{"2001:db8::1", "2001:db8::1/128"},
		{"2001:db8::1/32", "2001:db8::/32"},
	}
	for _, tc := range cases {
		got, err := NormalizeCIDR(tc.in)
		if err != nil {
			t.Errorf("NormalizeCIDR(%q): %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("NormalizeCIDR(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}

	for _, bad := range []string{"", "  ", "not-an-ip", "10.0.0.0/33", "999.1.1.1", "10.0.0.0/", "/8"} {
		if got, err := NormalizeCIDR(bad); err == nil {
			t.Errorf("NormalizeCIDR(%q) accepted, returned %q", bad, got)
		}
	}
}

// The core rule, and the one that decides whether anybody can log in.
func TestIsAllowed(t *testing.T) {
	svc := newAllowlistService(t)

	// Nothing configured: everything is allowed. An empty list must not mean
	// deny-all, or first boot locks everyone out.
	if ok, _ := svc.IsAllowed("203.0.113.9"); !ok {
		t.Fatal("an unconfigured allowlist must allow everything")
	}

	if _, err := svc.AddEntry("183.82.2.0/24", "head office", "u1", "root"); err != nil {
		t.Fatal(err)
	}
	// Still off, so still open.
	if ok, _ := svc.IsAllowed("203.0.113.9"); !ok {
		t.Fatal("entries alone must not enforce anything while the switch is off")
	}

	if err := svc.SetEnabled(true, "183.82.2.29", "u1", "root"); err != nil {
		t.Fatalf("enable: %v", err)
	}

	for _, ip := range []string{"183.82.2.29", "183.82.2.1", "183.82.2.255", "127.0.0.1", "::1"} {
		if ok, _ := svc.IsAllowed(ip); !ok {
			t.Errorf("%s should be allowed", ip)
		}
	}
	for _, ip := range []string{"183.82.3.1", "203.0.113.9", "10.0.0.1", "", "garbage"} {
		if ok, _ := svc.IsAllowed(ip); ok {
			t.Errorf("%s should be blocked", ip)
		}
	}
}

// The rule that stops this feature becoming an outage.
func TestSetEnabledRefusesToLockTheOperatorOut(t *testing.T) {
	svc := newAllowlistService(t)

	// No entries at all.
	err := svc.SetEnabled(true, "203.0.113.9", "u1", "root")
	if !errors.Is(err, ErrWouldLockOut) {
		t.Fatalf("enabling an empty allowlist should be refused, got %v", err)
	}

	if _, err := svc.AddEntry("183.82.2.0/24", "head office", "u1", "root"); err != nil {
		t.Fatal(err)
	}

	// Entries exist, but not covering the caller.
	err = svc.SetEnabled(true, "203.0.113.9", "u1", "root")
	if !errors.Is(err, ErrWouldLockOut) {
		t.Fatalf("enabling from outside every range should be refused, got %v", err)
	}
	if !strings.Contains(err.Error(), "203.0.113.9") {
		t.Errorf("the refusal should name the address it saw: %v", err)
	}

	// From inside a listed range it goes through.
	if err := svc.SetEnabled(true, "183.82.2.29", "u1", "root"); err != nil {
		t.Fatalf("enabling from a listed address: %v", err)
	}

	// Turning it OFF is never refused, from anywhere. Recovery must not be
	// gated by the thing being recovered from.
	if err := svc.SetEnabled(false, "203.0.113.9", "u1", "root"); err != nil {
		t.Fatalf("disabling from outside should always be allowed: %v", err)
	}
}

func TestRemoveEntryRefusesToRemoveTheGroundYouStandOn(t *testing.T) {
	svc := newAllowlistService(t)
	office, err := svc.AddEntry("183.82.2.0/24", "head office", "u1", "root")
	if err != nil {
		t.Fatal(err)
	}
	vpn, err := svc.AddEntry("10.0.0.0/8", "vpn", "u1", "root")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SetEnabled(true, "183.82.2.29", "u1", "root"); err != nil {
		t.Fatal(err)
	}

	// Removing the range the caller is inside, leaving one that does not
	// cover them.
	if err := svc.RemoveEntry(office.ID, "183.82.2.29"); !errors.Is(err, ErrWouldLockOut) {
		t.Fatalf("expected a lockout refusal, got %v", err)
	}

	// Removing a different range is fine.
	if err := svc.RemoveEntry(vpn.ID, "183.82.2.29"); err != nil {
		t.Fatalf("removing an unrelated range: %v", err)
	}

	// Once enforcement is off, anything can be removed.
	if err := svc.SetEnabled(false, "183.82.2.29", "u1", "root"); err != nil {
		t.Fatal(err)
	}
	if err := svc.RemoveEntry(office.ID, "203.0.113.9"); err != nil {
		t.Fatalf("removing with enforcement off: %v", err)
	}
}

func TestAddEntryRejectsDuplicatesAcrossSpellings(t *testing.T) {
	svc := newAllowlistService(t)
	if _, err := svc.AddEntry("183.82.2.29/24", "office", "u1", "root"); err != nil {
		t.Fatal(err)
	}
	// Same network, typed canonically. Must not create a second row.
	if _, err := svc.AddEntry("183.82.2.0/24", "office again", "u1", "root"); err == nil {
		t.Fatal("the same network in a different spelling should be rejected as a duplicate")
	}
	snap, err := svc.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(snap.Entries))
	}
	if snap.Entries[0].CIDR != "183.82.2.0/24" {
		t.Errorf("stored CIDR = %q, want the masked form", snap.Entries[0].CIDR)
	}
}

// The snippet is a config file nginx parses, so it has to be exactly
// directives and nothing else, and it must not turn into "deny all" the
// moment the switch is off.
func TestNginxSnippet(t *testing.T) {
	svc := newAllowlistService(t)

	off, err := svc.NginxSnippet()
	if err != nil {
		t.Fatal(err)
	}
	if directiveLines(off) != 0 {
		t.Fatalf("an unconfigured snippet must carry no directives:\n%s", off)
	}

	if _, err := svc.AddEntry("183.82.2.0/24", "head office", "u1", "root"); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetEnabled(true, "183.82.2.29", "u1", "root"); err != nil {
		t.Fatal(err)
	}

	on, err := svc.NginxSnippet()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"allow 127.0.0.1;", "allow ::1;", "allow 183.82.2.0/24;", "deny all;"} {
		if !strings.Contains(on, want) {
			t.Errorf("snippet missing %q:\n%s", want, on)
		}
	}
	// deny must be last or it would shadow the allows above it.
	if idx := strings.Index(on, "deny all;"); idx < strings.LastIndex(on, "allow ") {
		t.Errorf("deny all must come after every allow:\n%s", on)
	}
	for _, line := range strings.Split(on, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.HasPrefix(line, "allow ") && !strings.HasPrefix(line, "deny ") {
			t.Errorf("snippet contains a non-directive line: %q", line)
		}
	}
}

// A label is free text that reaches a file nginx parses.
func TestNginxSnippetLabelCannotInjectDirectives(t *testing.T) {
	svc := newAllowlistService(t)
	if _, err := svc.AddEntry("203.0.113.0/24", "evil\nallow 0.0.0.0/0; # ", "u1", "root"); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetEnabled(true, "203.0.113.9", "u1", "root"); err != nil {
		t.Fatal(err)
	}
	snippet, err := svc.NginxSnippet()
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(snippet, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}
		// Compare the directive itself, before any trailing comment.
		directive, _, _ := strings.Cut(line, "#")
		directive = strings.TrimSpace(directive)
		switch directive {
		case "allow 203.0.113.0/24;", "allow 127.0.0.1;", "allow ::1;", "deny all;":
		default:
			t.Fatalf("a label produced an unexpected directive %q in:\n%s", directive, snippet)
		}
	}
	// The label text itself must not survive in a form that reads like a
	// directive to whoever debugs this file next.
	if strings.Contains(snippet, "allow 0.0.0.0/0") {
		t.Fatalf("a label left directive-shaped text behind:\n%s", snippet)
	}
	if strings.Count(snippet, "allow 203.0.113.0/24;") != 1 {
		t.Errorf("expected exactly one allow for the real range:\n%s", snippet)
	}
}

// directiveLines counts the lines nginx would act on, ignoring comments and
// blanks. Substring checks are not enough: the header comment contains the
// word "allowlist".
func directiveLines(snippet string) int {
	n := 0
	for _, line := range strings.Split(snippet, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		n++
	}
	return n
}
