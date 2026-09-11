package launcher

import (
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/yourorg/pam-agent/internal/apiclient"
	"github.com/yourorg/pam-agent/internal/discovery"
)

// candidateByID picks one candidate out of a resource type's list, so a
// test about a specific tool keeps testing that tool if the order changes.
func candidateByID(t *testing.T, resourceType, id string) Candidate {
	t.Helper()
	for _, c := range defaultCandidates(t, resourceType) {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("no candidate %q under %q", id, resourceType)
	return Candidate{}
}

func oracleResolved(pw string, extra map[string]interface{}) *apiclient.ResolvedLaunch {
	return &apiclient.ResolvedLaunch{
		ResourceType: "oracle", Host: "ora.internal", Port: 1521,
		AccountName: "DAS123", Password: pw, ExtraConfig: extra,
	}
}

// Order matters the same way it does for MongoDB: the two command-line
// tools first, the desktop app when neither is installed, and the browser
// last because it is selected without any discovery.
func TestDefaultTemplatesOracleOrder(t *testing.T) {
	got := make([]string, 0, 4)
	for _, c := range defaultCandidates(t, "oracle") {
		got = append(got, c.ID+"/"+c.Kind)
	}
	want := "sqlplus/cli,sqlcl/cli,sqldeveloper/gui,oracle-web/browser"
	if strings.Join(got, ",") != want {
		t.Fatalf("oracle candidates = %v, want %v", got, want)
	}
	for _, c := range defaultCandidates(t, "oracle") {
		if c.Kind == "cli" && c.CredentialInjection != "oracle_login_script" {
			t.Errorf("%s uses %q, want oracle_login_script so the credential stays out of argv",
				c.ID, c.CredentialInjection)
		}
	}
}

// A service name and a SID are not interchangeable in Oracle, and using one
// where the other is meant fails in a way that looks like the database is
// down. Service name wins when both are present.
func TestOracleConnectIdentifier(t *testing.T) {
	cases := []struct {
		name   string
		dbName string
		extra  map[string]interface{}
		want   string
	}{
		{
			name:  "service name from extra_config",
			extra: map[string]interface{}{"service_name": "ORCLPDB1"},
			want:  "//ora.internal:1521/ORCLPDB1",
		},
		{
			name:   "service name from database_name",
			dbName: "ORCLPDB1",
			want:   "//ora.internal:1521/ORCLPDB1",
		},
		{
			name:  "sid becomes a full TNS descriptor, not EZCONNECT",
			extra: map[string]interface{}{"sid": "XE"},
			want:  "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=ora.internal)(PORT=1521))(CONNECT_DATA=(SID=XE)))",
		},
		{
			name:   "both present: service name wins",
			dbName: "IGNORED",
			extra:  map[string]interface{}{"service_name": "ORCLPDB1", "sid": "XE"},
			want:   "//ora.internal:1521/ORCLPDB1",
		},
		{
			name:  "whitespace around the values is not part of them",
			extra: map[string]interface{}{"service_name": "  ORCLPDB1  "},
			want:  "//ora.internal:1521/ORCLPDB1",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := buildOracleConnectIdentifier(oracleResolved("pw", tc.extra), tc.dbName)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("identifier = %q, want %q", got, tc.want)
			}
		})
	}

	// Naming no database at all has to say which field to set, since three
	// different ones would have worked.
	_, err := buildOracleConnectIdentifier(oracleResolved("pw", nil), "")
	if err == nil {
		t.Fatal("expected an error when nothing names the database")
	}
	for _, want := range []string{"database_name", "service_name", "sid"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %q: %v", want, err)
		}
	}
}

// The characters this used to refuse outright are exactly the ones quoting
// handles. Verified against SQL*Plus 23.26, both directions.
func TestOraclePasswordQuoting(t *testing.T) {
	for _, pw := range []string{`p@ss`, `pa/ss`, `pa ss`, `Das@123`, `p#ss$`, ``} {
		got, err := oracleQuoted(pw)
		if err != nil {
			t.Errorf("password %q was refused: %v", pw, err)
			continue
		}
		if got != `"`+pw+`"` {
			t.Errorf("oracleQuoted(%q) = %q", pw, got)
		}
	}

	// The one character with no escape at all.
	if _, err := oracleQuoted(`pa"ss`); err == nil {
		t.Error("a password containing a double quote should be refused")
	} else if !strings.Contains(err.Error(), "double quote") {
		t.Errorf("error does not explain why: %v", err)
	}
}

// An ordinary user name must stay bare: Oracle upper-cases an unquoted
// identifier and takes a quoted one literally, so quoting DAS123 as
// "das123" would ask for a user that does not exist.
func TestOracleUsernameIsOnlyQuotedWhenItMustBe(t *testing.T) {
	for _, name := range []string{"DAS123", "system", "app_user", "C##ADMIN"} {
		got, err := oracleUsername(name)
		if err != nil {
			t.Errorf("%q was refused: %v", name, err)
			continue
		}
		if got != name {
			t.Errorf("oracleUsername(%q) = %q, want it left bare", name, got)
		}
	}
	got, err := oracleUsername("odd user")
	if err != nil {
		t.Fatal(err)
	}
	if got != `"odd user"` {
		t.Errorf("a name needing quotes = %q", got)
	}
}

// End to end for the shell path: the script must carry the credential, the
// command line must not, and the file must be 0600 and queued for removal.
func TestOracleLoginScriptKeepsTheCredentialOutOfArgv(t *testing.T) {
	dir := t.TempDir()
	resolved := oracleResolved("Das@123", map[string]interface{}{"service_name": "ORCLPDB1"})

	cand := candidateByID(t, "oracle", "sqlplus")
	cand.Discovery = discovery.Spec{BinaryNames: []string{"go"}}

	cmd, chosen, err := SelectAndBuildCommand(resolved, []Candidate{cand}, dir, testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chosen.ID != "sqlplus" {
		t.Fatalf("chose %q", chosen.ID)
	}
	if len(cmd.Args) != 2 || cmd.Args[0] != "/nolog" || !strings.HasPrefix(cmd.Args[1], "@") {
		t.Fatalf("args = %v, want [/nolog @<script>]", cmd.Args)
	}
	for _, a := range cmd.Args {
		if strings.Contains(a, "Das@123") || strings.Contains(a, "DAS123/") {
			t.Fatalf("credential reached argv: %v", cmd.Args)
		}
	}

	scriptPath := strings.TrimPrefix(cmd.Args[1], "@")
	if len(cmd.CleanupFiles) != 1 || cmd.CleanupFiles[0] != scriptPath {
		t.Errorf("script %q not queued for cleanup: %v", scriptPath, cmd.CleanupFiles)
	}
	body, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatal(err)
	}
	script := string(body)
	if !strings.Contains(script, `CONNECT DAS123/"Das@123"@//ora.internal:1521/ORCLPDB1`) {
		t.Errorf("unexpected CONNECT line:\n%s", script)
	}
	fi, err := os.Stat(scriptPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Errorf("script mode = %v, want 0600", fi.Mode().Perm())
	}
}

// SQL Developer accepts no connection on its command line, so the most that
// can be done is put the password one paste away. It must not be treated as
// an unknown injection mode and fail the launch outright.
func TestOracleSQLDeveloperCopiesThePassword(t *testing.T) {
	cand := candidateByID(t, "oracle", "sqldeveloper")
	cand.Discovery = discovery.Spec{BinaryNames: []string{"go"}}

	cmd, _, err := SelectAndBuildCommand(oracleResolved("pw", nil), []Candidate{cand}, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cmd.CopyPasswordToClipboard {
		t.Error("expected the password on the clipboard for SQL Developer")
	}
	if len(cmd.Args) != 0 {
		t.Errorf("args = %v, want none", cmd.Args)
	}
}

// Falls back down the list, and the browser candidate still insists on a
// console_url because Oracle has no web console that can be derived.
func TestOracleFallsBackToTheWebConsole(t *testing.T) {
	cands := defaultCandidates(t, "oracle")
	for i := range cands {
		if cands[i].Kind != "browser" {
			cands[i].Discovery = notFoundSpec()
		}
	}
	resolved := oracleResolved("pw", map[string]interface{}{"sid": "XE"})
	resolved.ConsoleURL = "https://apex.internal/ords/"

	cmd, chosen, err := SelectAndBuildCommand(resolved, cands, t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chosen.ID != "oracle-web" || cmd.Exec != "https://apex.internal/ords/" {
		t.Fatalf("chosen=%q exec=%q", chosen.ID, cmd.Exec)
	}
	if !cmd.CopyPasswordToClipboard {
		t.Error("expected the password on the clipboard for the web console")
	}

	resolved.ConsoleURL = ""
	if _, _, err := SelectAndBuildCommand(resolved, cands, t.TempDir(), testLogger()); err == nil {
		t.Error("expected an error with no console_url: Oracle has no derivable web console")
	}
}
