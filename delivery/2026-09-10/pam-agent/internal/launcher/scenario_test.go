package launcher

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yourorg/pam-agent/internal/apiclient"
	"github.com/yourorg/pam-agent/internal/discovery"
)

// Reproduces the reported machine end to end: a stale launch-templates.json
// written by an older agent, the real resource from the logs, and mongosh
// present. Asserts the three things that were wrong.
func TestReportedWindowsScenario(t *testing.T) {
	configDir := t.TempDir()
	path := filepath.Join(configDir, "launch-templates.json")

	// What the machine actually had: an older release's templates, with no
	// arguments on either candidate and no web console.
	stale := []byte(`{"mongodb":[` +
		`{"id":"mongosh","kind":"cli","command":"mongosh","credential_injection":"mongo_init_file",` +
		`"discovery":{"binary_names":["mongosh"]}},` +
		`{"id":"mongodb-compass","kind":"gui","command":"MongoDBCompass","credential_injection":"connection_string_arg",` +
		`"discovery":{"windows_app_paths":["MongoDBCompass.exe"]}}]}`)
	if err := os.WriteFile(path, stale, 0o644); err != nil {
		t.Fatal(err)
	}
	// A previous agent would have stamped what IT wrote, so stamp the stale
	// bytes rather than the current defaults.
	staleSum := sha256.Sum256(stale)
	if err := os.WriteFile(stampPath(path), []byte(hex.EncodeToString(staleSum[:])), 0o644); err != nil {
		t.Fatal(err)
	}

	tmpl, err := LoadTemplates(configDir)
	if err != nil {
		t.Fatalf("LoadTemplates: %v", err)
	}
	cands := tmpl["mongodb"]

	// 1. The stale file must have been replaced, so the shell is tried
	//    first, the desktop app second and the web console last.
	var ids []string
	for _, c := range cands {
		ids = append(ids, c.ID)
	}
	if strings.Join(ids, ",") != "mongosh,mongodb-compass,mongodb-web" {
		t.Fatalf("candidates = %v, want mongosh,mongodb-compass,mongodb-web", ids)
	}

	resolved := &apiclient.ResolvedLaunch{
		ResourceType: "mongodb", Host: "13.206.221.6", Port: 27017,
		AccountName: "Das123", Password: "Das@123",
	}

	// 2. With mongosh installed, the shell wins and never touches the app.
	withShell := append([]Candidate(nil), cands...)
	withShell[0].Discovery = discovery.Spec{BinaryNames: []string{"go"}}
	cmd, chosen, err := SelectAndBuildCommand(resolved, withShell, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("shell path: %v", err)
	}
	if chosen.ID != "mongosh" {
		t.Fatalf("chose %q, want mongosh", chosen.ID)
	}
	if len(cmd.Args) != 3 || cmd.Args[0] != "mongodb://13.206.221.6:27017/" || cmd.Args[1] != "--shell" {
		t.Errorf("mongosh args = %v, want [<startup uri> --shell <file>]", cmd.Args)
	}
	for _, a := range cmd.Args {
		if strings.Contains(a, "Das%40123") || strings.Contains(a, "Das@123") {
			t.Errorf("credential reached argv: %v", cmd.Args)
		}
	}

	// 3. Without mongosh, Compass is used and must not stop on the dialog.
	noShell := append([]Candidate(nil), cands...)
	noShell[0].Discovery = notFoundSpec()
	noShell[1].Discovery = discovery.Spec{BinaryNames: []string{"go"}}
	cmd, chosen, err = SelectAndBuildCommand(resolved, noShell, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("compass path: %v", err)
	}
	if chosen.ID != "mongodb-compass" {
		t.Fatalf("chose %q, want mongodb-compass", chosen.ID)
	}
	if len(cmd.Args) != 2 || cmd.Args[0] != "--trustedConnectionString" {
		t.Fatalf("compass args = %v, want [--trustedConnectionString <conn>]", cmd.Args)
	}
	if cmd.Args[1] != "mongodb://Das123:Das%40123@13.206.221.6:27017" {
		t.Errorf("connection string = %q", cmd.Args[1])
	}
	if strings.Contains(cmd.Args[1], "?") {
		t.Errorf("connection string carries options Compass warns about: %q", cmd.Args[1])
	}
	t.Logf("compass argv: %v", cmd.Args)
}
