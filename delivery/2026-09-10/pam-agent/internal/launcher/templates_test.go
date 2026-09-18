package launcher

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/yourorg/pam-agent/internal/apiclient"
	"github.com/yourorg/pam-agent/internal/discovery"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// notFoundSpec never resolves to anything on this machine — used to force
// SelectAndBuildCommand to fall through to the next candidate.
func notFoundSpec() discovery.Spec {
	return discovery.Spec{BinaryNames: []string{"definitely-not-a-real-binary-xyz-123"}}
}

func TestSelectAndBuildCommandFallsBackToNextCandidate(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{ResourceType: "postgresql", Host: "h", Port: 5432, AccountName: "u", Password: "p"}
	candidates := []Candidate{
		{ID: "missing-tool", Kind: "cli", Command: "missing-tool", CredentialInjection: "none", Discovery: notFoundSpec()},
		{ID: "go-fallback", Kind: "cli", Command: "go", CredentialInjection: "none", Discovery: discovery.Spec{BinaryNames: []string{"go"}}},
	}

	cmd, chosen, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chosen.ID != "go-fallback" {
		t.Fatalf("chosen candidate = %q, want %q", chosen.ID, "go-fallback")
	}
	if cmd.Exec == "" {
		t.Fatal("expected a resolved Exec path")
	}
}

func TestSelectAndBuildCommandErrorsWhenNothingFound(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{ResourceType: "oracle"}
	candidates := []Candidate{
		{ID: "sqlplus", Kind: "cli", Discovery: notFoundSpec()},
		{ID: "sqlcl", Kind: "cli", Discovery: notFoundSpec()},
	}
	_, _, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), testLogger())
	if err == nil {
		t.Fatal("expected an error when no candidate is found")
	}
	if !strings.Contains(err.Error(), "sqlplus") || !strings.Contains(err.Error(), "sqlcl") {
		t.Fatalf("expected error to name every tried candidate, got: %v", err)
	}
}

func TestSelectAndBuildCommandBrowserKindNeedsNoDiscovery(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{ResourceType: "minio", ConsoleURL: "https://minio.example.com/browser"}
	candidates := []Candidate{
		{ID: "minio-console", Kind: "browser", Command: "{{.ConsoleURL}}"},
	}
	cmd, chosen, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chosen.ID != "minio-console" {
		t.Fatalf("chosen = %q", chosen.ID)
	}
	if cmd.Exec != resolved.ConsoleURL {
		t.Fatalf("Exec = %q, want the rendered console URL %q", cmd.Exec, resolved.ConsoleURL)
	}
	if cmd.Mode != "browser" {
		t.Fatalf("Mode = %q, want %q", cmd.Mode, "browser")
	}
	if cmd.CopyPasswordToClipboard {
		t.Fatal("expected CopyPasswordToClipboard = false when credential_injection is unset")
	}
}

// TestSelectAndBuildCommandPgAdminCopiesPasswordToClipboard covers the real
// "pgadmin4" entry from launch-templates.default.json: alongside the
// --load-servers preseed (host/port/username, never the password),
// CopyPasswordToClipboard must come back true. A PGPASSFILE-based headless
// attempt (mirroring psql's own "pgpass" case) was tried and confirmed LIVE
// not to work — pgAdmin4's "Connect to Server" dialog is its own UI-level
// gate shown before any real libpq connection is attempted, so PGPASSFILE is
// never consulted — see buildCommand's "pgadmin_preseed" case. Discovery
// targets "go" as a stand-in for pgAdmin4 (same trick used elsewhere in this
// file) since this test can't assume pgAdmin4 is actually installed on the
// machine running it.
func TestSelectAndBuildCommandPgAdminCopiesPasswordToClipboard(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{
		ResourceType: "postgresql", Host: "h", Port: 5432, DatabaseName: "mydb",
		AccountName: "postgres", Password: "s3cret",
	}
	candidates := []Candidate{
		{ID: "pgadmin4", Kind: "gui", Command: "go", CredentialInjection: "pgadmin_preseed", Discovery: discovery.Spec{BinaryNames: []string{"go"}}},
	}
	cmd, chosen, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chosen.ID != "pgadmin4" {
		t.Fatalf("chosen = %q, want pgadmin4", chosen.ID)
	}
	if cmd.PreseedLoadServersPath == "" {
		t.Fatal("expected a non-empty PreseedLoadServersPath")
	}
	if !cmd.CopyPasswordToClipboard {
		t.Fatal("expected CopyPasswordToClipboard = true for credential_injection \"pgadmin_preseed\"")
	}
}

// TestSelectAndBuildCommandBrowserClipboard covers MinIO's actual
// launch-templates.default.json entry: a "browser" candidate with
// credential_injection "clipboard" must come back with
// CopyPasswordToClipboard set, so cmdLaunch knows to copy the password
// before opening the console URL (see buildBrowserCommand's doc comment for
// why MinIO's console has no auto-login path this agent can drive instead).
func TestSelectAndBuildCommandBrowserClipboard(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{
		ResourceType: "minio",
		ConsoleURL:   "http://13.206.221.6:9001",
		AccountName:  "minioadmin",
		Password:     "DasAdmin@123",
	}
	candidates := []Candidate{
		{ID: "minio-console", Kind: "browser", Command: "{{.ConsoleURL}}", CredentialInjection: "clipboard"},
	}
	cmd, chosen, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chosen.ID != "minio-console" {
		t.Fatalf("chosen = %q", chosen.ID)
	}
	if !cmd.CopyPasswordToClipboard {
		t.Fatal("expected CopyPasswordToClipboard = true for credential_injection \"clipboard\"")
	}
	if cmd.Exec != resolved.ConsoleURL {
		t.Fatalf("Exec = %q, want %q", cmd.Exec, resolved.ConsoleURL)
	}
}

func TestSelectAndBuildCommandBrowserKindRequiresConsoleURL(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{ResourceType: "minio", ConsoleURL: ""}
	candidates := []Candidate{{ID: "minio-console", Kind: "browser", Command: "{{.ConsoleURL}}"}}
	_, _, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), testLogger())
	if err == nil {
		t.Fatal("expected an error when console_url is empty")
	}
	if !strings.Contains(err.Error(), "console_url") {
		t.Fatalf("expected error to mention console_url, got: %v", err)
	}
}

func TestReorderByPreferredMovesMatchToFront(t *testing.T) {
	candidates := []Candidate{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	ordered := reorderByPreferred(candidates, map[string]interface{}{"preferred_tool": "c"})
	got := []string{ordered[0].ID, ordered[1].ID, ordered[2].ID}
	want := []string{"c", "a", "b"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got order %v, want %v", got, want)
		}
	}
}

func TestReorderByPreferredNoOpWhenHintMissingOrUnknown(t *testing.T) {
	candidates := []Candidate{{ID: "a"}, {ID: "b"}}

	ordered := reorderByPreferred(candidates, nil)
	if ordered[0].ID != "a" || ordered[1].ID != "b" {
		t.Fatalf("expected unchanged order with no hint, got %+v", ordered)
	}

	ordered = reorderByPreferred(candidates, map[string]interface{}{"preferred_tool": "not-a-real-candidate"})
	if ordered[0].ID != "a" || ordered[1].ID != "b" {
		t.Fatalf("expected unchanged order with an unknown hint, got %+v", ordered)
	}
}

// TestSelectAndBuildCommandPreferredToolStillFallsBackWhenUnavailable proves
// the security boundary documented on reorderByPreferred: the backend hint
// can only reorder candidate IDs already baked into this machine's
// launch-templates.json, and if THAT preferred one isn't actually
// installed, selection still falls through to whatever else is — it can
// never force a launch to fail just because its top pick is missing, nor
// can it introduce a candidate that wasn't already configured locally.
func TestSelectAndBuildCommandPreferredToolStillFallsBackWhenUnavailable(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{
		ResourceType: "postgresql", Host: "h", Port: 5432, AccountName: "u", Password: "p",
		ExtraConfig: map[string]interface{}{"preferred_tool": "pgadmin4"},
	}
	candidates := []Candidate{
		{ID: "psql", Kind: "cli", Command: "go", CredentialInjection: "none", Discovery: discovery.Spec{BinaryNames: []string{"go"}}},
		{ID: "pgadmin4", Kind: "gui", Discovery: notFoundSpec()},
	}
	_, chosen, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chosen.ID != "psql" {
		t.Fatalf("expected fallback to psql when preferred pgadmin4 isn't installed, got %q", chosen.ID)
	}
}

// TestSelectAndBuildCommandMinIOShell exercises the real "minio" entry from
// launch-templates.default.json end to end: mc has no interactive REPL to
// exec directly (see resolveInteractiveShell's doc comment), so a resolved
// mc-shell candidate must come back with Exec overridden to the operator's
// own shell (never left as the discovered mc path) and MC_HOST_pam set in
// Env with the resolved host/account/password/scheme baked in — exactly what
// the operator's shell needs to run `mc ls pam/...` already authenticated.
// Discovery targets "go" as a stand-in for "mc" (same trick as the
// go-fallback candidate above) since this test can't assume mc is actually
// installed on the machine running it.
func TestSelectAndBuildCommandMinIOShell(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{
		ResourceType: "minio",
		Host:         "13.206.221.6",
		Port:         9000,
		AccountName:  "minioadmin",
		Password:     "DasAdmin@123",
		ExtraConfig:  map[string]interface{}{"use_ssl": false},
		ConsoleURL:   "http://13.206.221.6:9001",
	}
	candidates := []Candidate{
		{ID: "mc-shell", Kind: "cli", Command: "mc", CredentialInjection: "minio_mc_shell", Discovery: discovery.Spec{BinaryNames: []string{"go"}}},
		{ID: "minio-console", Kind: "browser", Command: "{{.ConsoleURL}}"},
	}

	cmd, chosen, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chosen.ID != "mc-shell" {
		t.Fatalf("chosen = %q, want mc-shell", chosen.ID)
	}
	if cmd.Exec == "" {
		t.Fatal("expected a resolved shell Exec path")
	}
	if strings.Contains(strings.ToLower(cmd.Exec), "go.exe") || strings.HasSuffix(cmd.Exec, string("go")) {
		t.Fatalf("Exec = %q — must be overridden to the operator's shell, not left as the discovered mc stand-in", cmd.Exec)
	}
	// Raw, not percent-encoded — see buildMinIOAliasEnv's bugfix comment.
	wantEnv := "MC_HOST_pam=" + "http://minioadmin:DasAdmin@123@13.206.221.6:9000"
	found := false
	for _, e := range cmd.Env {
		if e == wantEnv {
			found = true
		}
	}
	if !found {
		t.Fatalf("Env = %v, want it to contain %q", cmd.Env, wantEnv)
	}
	if len(cmd.Args) != 0 {
		t.Fatalf("Args = %v, want empty — the shell takes no arguments", cmd.Args)
	}
}

// defaultCandidates pulls one resource type's candidate list straight out
// of the embedded launch-templates.default.json, so these tests exercise
// the shipped configuration rather than a hand-written copy of it that
// could drift from what actually runs.
func defaultCandidates(t *testing.T, resourceType string) []Candidate {
	t.Helper()
	// t.TempDir(), never "": LoadTemplates writes the defaults to
	// <configDir>/launch-templates.json when that file is missing, so an
	// empty configDir drops one into whatever directory the test runs in —
	// the package source directory — and every later run then reads that
	// stale copy instead of the embedded defaults. Caught exactly that way:
	// a template change appeared in the JSON and not in the test.
	tmpl, err := LoadTemplates(t.TempDir())
	if err != nil {
		t.Fatalf("LoadTemplates: %v", err)
	}
	cands, ok := tmpl[resourceType]
	if !ok {
		t.Fatalf("no candidates for resource type %q in the default templates", resourceType)
	}
	return cands
}

// Candidate order is the whole behaviour here: the shell first, the desktop
// app only when the shell is genuinely absent, and the web console last
// because a browser candidate needs no discovery and would otherwise win on
// every machine including the ones that do have mongosh.
func TestDefaultTemplatesMongoOrder(t *testing.T) {
	cands := defaultCandidates(t, "mongodb")
	got := make([]string, len(cands))
	for i, c := range cands {
		got[i] = c.ID + "/" + c.Kind
	}
	want := []string{"mongosh/cli", "mongodb-compass/gui", "mongodb-web/browser"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("mongodb candidates = %v, want %v", got, want)
	}
	if compass := defaultCandidates(t, "mongodb-compass"); compass[0].Kind != "gui" {
		t.Errorf("mongodb-compass first candidate kind = %q, want gui", compass[0].Kind)
	}
}

// mongosh connects to localhost:27017 before running a script unless told
// not to, and the script is the only thing that knows where this session is
// really going. Without --nodb the operator got that failed local connect
// instead of their session.
func TestDefaultTemplatesMongoshCarriesNoNodb(t *testing.T) {
	cand := defaultCandidates(t, "mongodb")[0]
	for _, a := range cand.Args {
		if strings.EqualFold(a, "--nodb") {
			t.Fatalf("mongosh args still carry --nodb: %v", cand.Args)
		}
	}
}

// Compass will not auto-connect to a string carrying an option it considers
// non-default: it shows a confirmation with the credential on screen
// instead. This flag is what turns that back into a real launch.
func TestDefaultTemplatesCompassPassesTrustedConnectionString(t *testing.T) {
	for _, rt := range []string{"mongodb", "mongodb-compass"} {
		var compass *Candidate
		for i, c := range defaultCandidates(t, rt) {
			if c.ID == "mongodb-compass" {
				compass = &defaultCandidates(t, rt)[i]
			}
		}
		if compass == nil {
			t.Fatalf("no compass candidate under %q", rt)
		}
		if len(compass.Args) != 1 || compass.Args[0] != "--trustedConnectionString" {
			t.Errorf("%s compass args = %v, want [--trustedConnectionString]", rt, compass.Args)
		}
	}
}

// mongosh has to be found where it actually installs, not only on PATH.
// The Windows MSI does not add itself to PATH, which is the whole reason
// the shell was being skipped in favour of the GUI.
func TestDefaultTemplatesMongoshDiscoveryCoversRealInstallPaths(t *testing.T) {
	spec := defaultCandidates(t, "mongodb")[0].Discovery

	if len(spec.BinaryNames) == 0 || spec.BinaryNames[0] != "mongosh" {
		t.Errorf("binary_names = %v, want mongosh first", spec.BinaryNames)
	}
	for _, goos := range []string{"windows", "darwin", "linux"} {
		if len(spec.AbsolutePathGlobs[goos]) == 0 {
			t.Errorf("no absolute_path_globs for %s", goos)
		}
	}
	joined := strings.Join(spec.AbsolutePathGlobs["windows"], "|")
	for _, want := range []string{`C:\Program Files\mongosh\mongosh.exe`, `AppData\Local\Programs\mongosh`} {
		if !strings.Contains(joined, want) {
			t.Errorf("windows globs missing %q, have %v", want, spec.AbsolutePathGlobs["windows"])
		}
	}

	// A hand-downloaded, hand-unpacked copy is the common case on a machine
	// that never ran an installer, and it is precisely the machine that
	// would otherwise silently get the desktop app instead.
	for _, goos := range []string{"windows", "darwin", "linux"} {
		if !strings.Contains(strings.Join(spec.AbsolutePathGlobs[goos], "|"), "Downloads") {
			t.Errorf("%s globs do not look in Downloads: %v", goos, spec.AbsolutePathGlobs[goos])
		}
	}
	for _, goos := range []string{"darwin", "linux"} {
		if !strings.Contains(strings.Join(spec.AbsolutePathGlobs[goos], "|"), "~/") {
			t.Errorf("%s Downloads globs are not home-relative: %v", goos, spec.AbsolutePathGlobs[goos])
		}
	}
}

// The shell and the GUI must authenticate against the same database, or
// one of them works and the other reports the password as wrong.
func TestMongoAuthSourceIsSharedByShellAndConnectionString(t *testing.T) {
	cases := []struct {
		name       string
		dbName     string
		extra      map[string]interface{}
		wantSource string
		// redundant marks the cases where spelling authSource out in the
		// connection string would not change which database the driver
		// authenticates against. Compass puts up a confirmation dialog for
		// any non-default option, so a redundant one costs a click per
		// launch and buys nothing — it must be left out.
		redundant bool
	}{
		{name: "no database named", dbName: "", wantSource: "admin", redundant: true},
		{name: "database named", dbName: "shop", wantSource: "shop", redundant: true},
		{
			name:       "admin realm override",
			dbName:     "shop",
			extra:      map[string]interface{}{"auth_source": "admin"},
			wantSource: "admin",
		},
		{
			name:       "override wins over an empty database too",
			dbName:     "",
			extra:      map[string]interface{}{"auth_source": "records"},
			wantSource: "records",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resolved := &apiclient.ResolvedLaunch{
				ResourceType: "mongodb", Host: "db.internal", Port: 27017,
				AccountName: "svc", Password: "p@ss word/1",
				DatabaseName: tc.dbName, ExtraConfig: tc.extra,
			}

			if got := mongoAuthSource(resolved, tc.dbName); got != tc.wantSource {
				t.Fatalf("mongoAuthSource = %q, want %q", got, tc.wantSource)
			}

			conn := buildConnectionString(resolved, tc.dbName)
			switch {
			case tc.redundant && strings.Contains(conn, "authSource="):
				t.Errorf("connection string %q spells out a redundant authSource", conn)
			case !tc.redundant && !strings.Contains(conn, "authSource="+tc.wantSource):
				t.Errorf("connection string %q missing authSource=%s", conn, tc.wantSource)
			}
			// A password with @ and / in it must not be able to break the
			// URL apart, which is exactly what a hand-built string does.
			if !strings.Contains(conn, "p%40ss%20word%2F1") {
				t.Errorf("connection string did not escape the password: %q", conn)
			}
		})
	}
}

// End to end for the shell path: the init file must carry the credential
// and the authSource, and the credential must never reach argv.
func TestMongoInitFileCarriesCredentialOutOfArgv(t *testing.T) {
	dir := t.TempDir()
	resolved := &apiclient.ResolvedLaunch{
		ResourceType: "mongodb", Host: "db.internal", Port: 27017,
		AccountName: "svc", Password: "p@ss word/1",
		DatabaseName: "shop", ExtraConfig: map[string]interface{}{"auth_source": "admin"},
	}
	cand := defaultCandidates(t, "mongodb")[0]
	cand.Discovery = discovery.Spec{BinaryNames: []string{"go"}}

	cmd, chosen, err := SelectAndBuildCommand(resolved, []Candidate{cand}, dir, testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chosen.ID != "mongosh" {
		t.Fatalf("chosen = %q, want mongosh", chosen.ID)
	}
	if len(cmd.Args) != 3 || cmd.Args[0] != "mongodb://db.internal:27017/" || cmd.Args[1] != "--shell" {
		t.Fatalf("args = %v, want [<startup uri> --shell <init file>]", cmd.Args)
	}
	for _, a := range cmd.Args {
		if strings.Contains(a, "p@ss") || strings.Contains(a, "p%40ss") {
			t.Fatalf("credential leaked into argv: %v", cmd.Args)
		}
	}
	if len(cmd.CleanupFiles) != 1 || cmd.CleanupFiles[0] != cmd.Args[2] {
		t.Errorf("init file %q is not queued for cleanup: %v", cmd.Args[2], cmd.CleanupFiles)
	}

	body, err := os.ReadFile(cmd.Args[2])
	if err != nil {
		t.Fatalf("reading init file: %v", err)
	}
	script := string(body)
	for _, want := range []string{"p%40ss%20word%2F1", "authSource=admin", `getDB("shop")`} {
		if !strings.Contains(script, want) {
			t.Errorf("init file missing %q:\n%s", want, script)
		}
	}

	fi, err := os.Stat(cmd.Args[2])
	if err != nil {
		t.Fatalf("stat init file: %v", err)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Errorf("init file mode = %v, want 0600", fi.Mode().Perm())
	}
}

// With no mongosh on the machine, the operator gets the web console rather
// than a desktop app, and the password on the clipboard so signing in is a
// paste. With no console_url configured either, the error has to name the
// thing an admin must set.
func TestMongoFallsBackToWebConsole(t *testing.T) {
	cands := defaultCandidates(t, "mongodb")
	cands[0].Discovery = notFoundSpec()

	resolved := &apiclient.ResolvedLaunch{
		ResourceType: "mongodb", Host: "db.internal", Port: 27017,
		AccountName: "svc", Password: "pw",
		ConsoleURL: "https://mongo.internal/console",
	}
	cmd, chosen, err := SelectAndBuildCommand(resolved, cands, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chosen.ID != "mongodb-web" || cmd.Mode != "browser" {
		t.Fatalf("chosen = %q mode = %q, want mongodb-web/browser", chosen.ID, cmd.Mode)
	}
	if cmd.Exec != "https://mongo.internal/console" {
		t.Errorf("Exec = %q, want the console URL", cmd.Exec)
	}
	if !cmd.CopyPasswordToClipboard {
		t.Error("expected the password on the clipboard for the web console")
	}

	// With no console_url either, nothing can open this resource. The failure
	// has to name EVERY candidate that was tried, not just the last one.
	//
	// It used to name only console_url: a browser candidate that could not be
	// built returned immediately, and since the browser candidate is last in
	// the list its error replaced the one the operator could act on. Someone
	// with no mongosh installed was told to go and ask an administrator about
	// console_url, with mongosh never mentioned. Found by running the real
	// agent against a real launch.
	resolved.ConsoleURL = ""
	_, _, err = SelectAndBuildCommand(resolved, cands, t.TempDir(), testLogger())
	if err == nil {
		t.Fatal("expected an error when nothing can open the resource")
	}
	notFound, ok := err.(*ToolNotFoundError)
	if !ok {
		t.Fatalf("error type = %T, want *ToolNotFoundError", err)
	}
	for _, want := range []string{"mongosh", "mongodb-compass", "mongodb-web"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not name candidate %q: %v", want, err)
		}
	}
	// The console_url guidance is not lost, it moves into the hint alongside
	// the install instructions for the tools that CAN be installed.
	if hint := notFound.Hint(); !strings.Contains(hint, "console_url") {
		t.Errorf("hint does not mention console_url: %q", hint)
	}
	if hint := notFound.Hint(); !strings.Contains(hint, "mongosh") {
		t.Errorf("hint does not tell the operator how to install mongosh: %q", hint)
	}
}

// An Atlas resource whose admin never filled in console_url should still
// open the Atlas web application rather than failing, because unlike every
// other browser resource here Atlas is always at the same known origin and
// a .mongodb.net host cannot be anything else.
func TestAtlasConsoleURLFallback(t *testing.T) {
	cases := []struct {
		name  string
		host  string
		extra map[string]interface{}
		want  string
	}{
		{
			name: "atlas host with no console_url",
			host: "cluster0.ab12c.mongodb.net",
			want: "https://cloud.mongodb.com/",
		},
		{
			name: "atlas host, case and spacing ignored",
			host: "  Cluster0.AB12C.MongoDB.net  ",
			want: "https://cloud.mongodb.com/",
		},
		{
			name:  "project id deep links",
			host:  "cluster0.ab12c.mongodb.net",
			extra: map[string]interface{}{"atlas_project_id": "65f0a1b2c3d4e5f60718293a"},
			want:  "https://cloud.mongodb.com/v2/65f0a1b2c3d4e5f60718293a#/",
		},
		{
			name:  "project id alone is enough",
			host:  "mongo.internal",
			extra: map[string]interface{}{"atlas_project_id": "65f0a1b2c3d4e5f60718293a"},
			want:  "https://cloud.mongodb.com/v2/65f0a1b2c3d4e5f60718293a#/",
		},
		{name: "self hosted stays unguessed", host: "13.206.221.6", want: ""},
		{
			name: "a host merely containing the string is not atlas",
			host: "mongodb.net.internal.example.com",
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resolved := &apiclient.ResolvedLaunch{ResourceType: "mongodb", Host: tc.host, ExtraConfig: tc.extra}
			if got := atlasConsoleURL(resolved); got != tc.want {
				t.Errorf("atlasConsoleURL = %q, want %q", got, tc.want)
			}
		})
	}
}

// The fallback must not leak into the other browser resources, whose URLs
// genuinely can only come from the PAM record.
func TestBrowserCandidateStillRequiresConsoleURLForSelfHosted(t *testing.T) {
	cands := defaultCandidates(t, "mongodb")
	for i := range cands {
		if cands[i].Kind != "browser" {
			cands[i].Discovery = notFoundSpec()
		}
	}

	atlas := &apiclient.ResolvedLaunch{
		ResourceType: "mongodb", Host: "cluster0.ab12c.mongodb.net", Port: 27017,
		AccountName: "svc", Password: "pw",
	}
	cmd, chosen, err := SelectAndBuildCommand(atlas, cands, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("atlas: unexpected error: %v", err)
	}
	if chosen.ID != "mongodb-web" || cmd.Exec != "https://cloud.mongodb.com/" {
		t.Errorf("atlas: chosen=%q exec=%q", chosen.ID, cmd.Exec)
	}

	selfHosted := &apiclient.ResolvedLaunch{
		ResourceType: "minio", Host: "10.0.0.9", Port: 9000,
		AccountName: "svc", Password: "pw",
	}
	minio := []Candidate{{ID: "minio-console", Kind: "browser", Command: "{{.ConsoleURL}}"}}
	if _, _, err := SelectAndBuildCommand(selfHosted, minio, t.TempDir(), testLogger()); err == nil {
		t.Error("minio with no console_url should still fail")
	}
}

// The whole point of the stamp: an agent that ships new templates must
// actually deliver them to a machine that already ran an older agent.
func TestLoadTemplatesReplacesUneditedDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "launch-templates.json")

	// A previous release's defaults, written by a previous agent.
	stale := []byte(`{"mongodb":[{"id":"old-candidate","kind":"cli","command":"old"}]}`)
	if err := os.WriteFile(path, stale, 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(stale)
	if err := os.WriteFile(stampPath(path), []byte(hex.EncodeToString(sum[:])), 0o644); err != nil {
		t.Fatal(err)
	}

	tmpl, err := LoadTemplates(dir)
	if err != nil {
		t.Fatalf("LoadTemplates: %v", err)
	}
	if len(tmpl["mongodb"]) == 1 && tmpl["mongodb"][0].ID == "old-candidate" {
		t.Fatal("stale templates were not replaced")
	}
	if tmpl["mongodb"][0].ID != "mongosh" {
		t.Errorf("first mongodb candidate = %q, want mongosh", tmpl["mongodb"][0].ID)
	}

	on, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(on, defaultTemplatesJSON) {
		t.Error("file on disk is not the shipped defaults")
	}

	// The stamp must now describe what was just written, or the next run
	// would mistake this file for an operator edit and freeze again.
	newSum := sha256.Sum256(defaultTemplatesJSON)
	if !stampMatches(path, newSum) {
		t.Error("stamp was not updated to the newly written defaults")
	}
}

// The other half of the contract, and the more important one: a file the
// operator has edited is never silently reverted. launch-templates.json is
// documented as the place to point the agent at a tool in an unusual
// location.
func TestLoadTemplatesNeverClobbersAnEditedFile(t *testing.T) {
	edited := []byte(`{"mongodb":[{"id":"mongosh","kind":"cli","command":"mongosh",` +
		`"credential_injection":"mongo_init_file",` +
		`"discovery":{"absolute_path_globs":{"windows":["D:\\tools\\mongosh.exe"]}}}]}`)

	for _, tc := range []struct{ name, stamp string }{
		{name: "stamp records different content", stamp: strings.Repeat("ab", 32)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "launch-templates.json")
			if err := os.WriteFile(path, edited, 0o644); err != nil {
				t.Fatal(err)
			}
			if tc.stamp != "" {
				if err := os.WriteFile(stampPath(path), []byte(tc.stamp), 0o644); err != nil {
					t.Fatal(err)
				}
			}

			tmpl, err := LoadTemplates(dir)
			if err != nil {
				t.Fatalf("LoadTemplates: %v", err)
			}
			if len(tmpl["mongodb"]) != 1 {
				t.Fatalf("operator's candidate list was replaced: %d entries", len(tmpl["mongodb"]))
			}
			got := tmpl["mongodb"][0].Discovery.AbsolutePathGlobs["windows"]
			if len(got) != 1 || got[0] != `D:\tools\mongosh.exe` {
				t.Errorf("operator's discovery path was lost: %v", got)
			}
			on, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(on, edited) {
				t.Error("file on disk was rewritten")
			}
		})
	}
}

func TestLoadTemplatesFirstRunWritesDefaultsAndStamp(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadTemplates(dir); err != nil {
		t.Fatalf("LoadTemplates: %v", err)
	}
	path := filepath.Join(dir, "launch-templates.json")
	on, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(on, defaultTemplatesJSON) {
		t.Error("first run did not write the shipped defaults")
	}
	if !stampMatches(path, sha256.Sum256(defaultTemplatesJSON)) {
		t.Error("first run did not stamp what it wrote")
	}
}

// Compass gets the flag even from a template that predates it, because the
// template is a file on the operator's disk and cannot be relied on.
func TestCompassGetsTrustFlagEvenFromAStaleTemplate(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{
		ResourceType: "mongodb", Host: "13.206.221.6", Port: 27017,
		AccountName: "Das123", Password: "Das@123",
	}
	stale := Candidate{
		ID: "mongodb-compass", Kind: "gui", Command: "MongoDBCompass",
		Args:                nil, // the old template carried no arguments
		CredentialInjection: "connection_string_arg",
		Discovery:           discovery.Spec{BinaryNames: []string{"go"}},
	}

	cmd, _, err := SelectAndBuildCommand(resolved, []Candidate{stale}, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cmd.Args) != 2 || cmd.Args[0] != "--trustedConnectionString" {
		t.Fatalf("args = %v, want [--trustedConnectionString <connection string>]", cmd.Args)
	}
	if strings.Contains(cmd.Args[1], "authSource") {
		t.Errorf("connection string carries an option Compass will warn about: %s", cmd.Args[1])
	}

	// Not added twice when the template already has it.
	stale.Args = []string{"--trustedConnectionString"}
	cmd, _, err = SelectAndBuildCommand(resolved, []Candidate{stale}, t.TempDir(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	if len(cmd.Args) != 2 {
		t.Errorf("flag duplicated: %v", cmd.Args)
	}
}

// And it must not be bolted onto anything that is not Compass.
func TestTrustFlagIsCompassOnly(t *testing.T) {
	for _, exe := range []string{"/usr/bin/psql", `C:\redis\redis-cli.exe`, "mongosh"} {
		if got := ensureCompassTrustsConnectionString(nil, "psql", exe, ""); len(got) != 0 {
			t.Errorf("%s got %v, want no added flags", exe, got)
		}
	}
	for _, tc := range []struct{ name, command, exe, bundle string }{
		{name: "template command only", command: "MongoDBCompass"},
		{name: "resolved windows exe", exe: `C:\Users\p\AppData\Local\MongoDBCompass\MongoDBCompass.exe`},
		{name: "mac app bundle", bundle: "/Applications/MongoDB Compass.app"},
	} {
		if got := ensureCompassTrustsConnectionString(nil, tc.command, tc.exe, tc.bundle); len(got) != 1 {
			t.Errorf("%s got %v, want the flag", tc.name, got)
		}
	}
}

// Every machine already in the field has a launch-templates.json and no
// stamp beside it. Those are exactly the machines running templates too old
// to reach a current tool, so they have to be migrated, not protected — but
// not at the cost of losing whatever was there.
func TestLoadTemplatesMigratesAPreStampFileAndKeepsABackup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "launch-templates.json")

	old := []byte(`{"mongodb":[{"id":"mongosh","kind":"cli","command":"mongosh"},` +
		`{"id":"mongodb-compass","kind":"gui","command":"MongoDBCompass"}]}`)
	if err := os.WriteFile(path, old, 0o644); err != nil {
		t.Fatal(err)
	}

	tmpl, err := LoadTemplates(dir)
	if err != nil {
		t.Fatalf("LoadTemplates: %v", err)
	}
	if len(tmpl["mongodb"]) != 3 {
		t.Fatalf("pre-stamp file was not migrated: %d mongodb candidates", len(tmpl["mongodb"]))
	}

	backup, err := os.ReadFile(path + ".bak")
	if err != nil {
		t.Fatalf("no backup of the replaced file: %v", err)
	}
	if !bytes.Equal(backup, old) {
		t.Error("backup does not hold the operator's original file")
	}

	// Second run: the stamp now exists and matches, so this is the ordinary
	// up-to-date case and nothing is rewritten or backed up again.
	if err := os.Remove(path + ".bak"); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTemplates(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".bak"); !os.IsNotExist(err) {
		t.Error("migrated a second time")
	}
}

// A file that already equals the shipped defaults but has no stamp is
// adopted, not backed up: there is nothing to preserve and a .bak of
// identical content is just litter.
func TestLoadTemplatesAdoptsAnIdenticalStamplessFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "launch-templates.json")
	if err := os.WriteFile(path, defaultTemplatesJSON, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTemplates(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".bak"); !os.IsNotExist(err) {
		t.Error("backed up a file that was already the defaults")
	}
	if !stampMatches(path, sha256.Sum256(defaultTemplatesJSON)) {
		t.Error("identical file was not adopted with a stamp")
	}
}

// mongosh prompts for a connection string when it is given none, on
// Windows, in a console it is alone in — which is exactly the console a
// pam-agent launch creates. The specifier is what suppresses that, and it
// must carry no credential.
func TestMongoshGetsAStartupURIWithoutTheCredential(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{
		ResourceType: "mongodb", Host: "13.206.221.6", Port: 27017,
		AccountName: "Das123", Password: "Das@123",
	}
	if got := mongoStartupURI(resolved); got != "mongodb://13.206.221.6:27017/" {
		t.Errorf("mongoStartupURI = %q", got)
	}

	cand := defaultCandidates(t, "mongodb")[0]
	cand.Discovery = discovery.Spec{BinaryNames: []string{"go"}}
	cmd, _, err := SelectAndBuildCommand(resolved, []Candidate{cand}, t.TempDir(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Args[0] != "mongodb://13.206.221.6:27017/" {
		t.Errorf("first positional = %q, want the startup URI", cmd.Args[0])
	}
	for _, a := range cmd.Args {
		if strings.Contains(a, "Das@123") || strings.Contains(a, "Das%40123") {
			t.Fatalf("credential reached argv: %v", cmd.Args)
		}
	}
}

// --nodb and a specifier are mutually exclusive: with --nodb present
// mongosh tries to open the connection string as a script file. A stale
// template carrying --nodb must not be able to break every session.
func TestNodbIsStrippedFromAStaleTemplate(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{
		ResourceType: "mongodb", Host: "h", Port: 27017, AccountName: "u", Password: "p",
	}
	stale := Candidate{
		ID: "mongosh", Kind: "cli", Command: "mongosh",
		Args:                []string{"--nodb"},
		CredentialInjection: "mongo_init_file",
		Discovery:           discovery.Spec{BinaryNames: []string{"go"}},
	}
	cmd, _, err := SelectAndBuildCommand(resolved, []Candidate{stale}, t.TempDir(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range cmd.Args {
		if strings.EqualFold(a, "--nodb") {
			t.Fatalf("--nodb survived: %v", cmd.Args)
		}
	}
	if cmd.Args[0] != "mongodb://h:27017/" {
		t.Errorf("args = %v, want the startup URI first", cmd.Args)
	}

	if got := dropNodb(nil); len(got) != 0 {
		t.Errorf("dropNodb(nil) = %v", got)
	}
	if got := dropNodb([]string{"--quiet", "--NODB", "--json"}); strings.Join(got, ",") != "--quiet,--json" {
		t.Errorf("dropNodb = %v", got)
	}
}

// A console_url pointing at the database port cannot render, and the way it
// fails looks like the server is down rather than like the URL is wrong.
func TestConsoleURLOnTheDatabasePortIsRejectedClearly(t *testing.T) {
	mongo := &apiclient.ResolvedLaunch{ResourceType: "mongodb", Host: "13.206.221.6", Port: 27017}

	for _, bad := range []string{
		"http://13.206.221.6:27017/",
		"https://13.206.221.6:27017",
		"http://mongo.internal:27018/",
	} {
		err := rejectWireProtocolConsoleURL(mongo, bad)
		if err == nil {
			t.Errorf("%s was accepted", bad)
			continue
		}
		for _, want := range []string{"database port", "Atlas"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("%s error does not mention %q: %v", bad, want, err)
			}
		}
	}

	for _, ok := range []string{
		"",
		"https://mongo-express.internal/",
		"https://mongo-express.internal:8081/",
		"https://cloud.mongodb.com/",
		"not a url at all",
	} {
		if err := rejectWireProtocolConsoleURL(mongo, ok); err != nil {
			t.Errorf("%q was rejected: %v", ok, err)
		}
	}

	// A non-Mongo resource that happens to use its own port for a real web
	// console must not be caught by this.
	minio := &apiclient.ResolvedLaunch{ResourceType: "minio", Host: "10.0.0.9", Port: 9001}
	if err := rejectWireProtocolConsoleURL(minio, "http://10.0.0.9:9001/"); err != nil {
		t.Errorf("minio console on its own port was rejected: %v", err)
	}
}
