package launcher

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/yourorg/pam-agent/internal/apiclient"
	"github.com/yourorg/pam-agent/internal/discovery"
)

// The CLI resolves its host as
//
//	--host ?? LANGFUSE_BASE_URL ?? LANGFUSE_HOST ?? https://cloud.langfuse.com
//
// (read out of langfuse-cli 1.2.0's own dist/cli.js, not from documentation).
// So the variable to set is BASE_URL: it outranks a LANGFUSE_HOST the
// operator may already export from their shell profile, which would otherwise
// point a PAM session at whatever instance they use personally.
func TestLangfuseEnvUsesBaseURLAndCarriesBothKeys(t *testing.T) {
	env := buildLangfuseEnv(&apiclient.ResolvedLaunch{
		Host: "langfuse.internal", Port: 3000,
		AccountName: "pk-lf-abc", Password: "sk-lf-xyz",
		ConsoleURL: "https://langfuse.internal/",
	})

	got := map[string]string{}
	for _, kv := range env {
		parts := strings.SplitN(kv, "=", 2)
		got[parts[0]] = parts[1]
	}

	if got["LANGFUSE_PUBLIC_KEY"] != "pk-lf-abc" {
		t.Errorf("LANGFUSE_PUBLIC_KEY = %q, want the account name", got["LANGFUSE_PUBLIC_KEY"])
	}
	if got["LANGFUSE_SECRET_KEY"] != "sk-lf-xyz" {
		t.Errorf("LANGFUSE_SECRET_KEY = %q, want the vaulted secret", got["LANGFUSE_SECRET_KEY"])
	}
	if _, ok := got["LANGFUSE_HOST"]; ok {
		t.Error("LANGFUSE_HOST was set; BASE_URL is the one that outranks an operator's own exported HOST")
	}
	// The trailing slash is stripped so the CLI's own URL join does not
	// produce a double slash against the API path.
	if got["LANGFUSE_BASE_URL"] != "https://langfuse.internal" {
		t.Errorf("LANGFUSE_BASE_URL = %q", got["LANGFUSE_BASE_URL"])
	}
}

// Never leave the host unset. Unset does not fail, it succeeds against
// Langfuse's EU cloud, which would send a key minted for a private instance
// to a third party.
func TestLangfuseBaseURLAlwaysNamesThisResource(t *testing.T) {
	cases := []struct {
		name     string
		resolved *apiclient.ResolvedLaunch
		want     string
	}{
		{
			name:     "console_url wins, it is the value an admin checked",
			resolved: &apiclient.ResolvedLaunch{Host: "h", Port: 3000, ConsoleURL: "https://lf.example.com"},
			want:     "https://lf.example.com",
		},
		{
			name:     "no console_url falls back to host and port",
			resolved: &apiclient.ResolvedLaunch{Host: "langfuse.internal", Port: 3000},
			want:     "http://langfuse.internal:3000",
		},
		{
			name: "use_ssl on the resource selects https",
			resolved: &apiclient.ResolvedLaunch{
				Host: "langfuse.internal", Port: 443,
				ExtraConfig: map[string]interface{}{"use_ssl": true},
			},
			want: "https://langfuse.internal:443",
		},
		{
			name:     "no port at all still produces a usable URL",
			resolved: &apiclient.ResolvedLaunch{Host: "langfuse.internal"},
			want:     "http://langfuse.internal",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := langfuseBaseURL(tc.resolved)
			if got != tc.want {
				t.Fatalf("langfuseBaseURL = %q, want %q", got, tc.want)
			}
			if strings.Contains(got, "cloud.langfuse.com") {
				t.Fatal("fell through to Langfuse's own cloud")
			}
		})
	}
}

// The CLI is one-shot: `langfuse api <resource> <action>` runs a single call
// and exits, so exec-ing it would open a terminal that printed usage and
// closed. The candidate hands over an interactive shell instead, which is
// also what puts the session inside the relay and therefore on the recording.
func TestLangfuseCandidateOpensAShellNotTheToolItself(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{
		ResourceType: "langfuse", Host: "langfuse.internal", Port: 3000,
		AccountName: "pk-lf-abc", Password: "sk-lf-xyz",
		ConsoleURL: "https://langfuse.internal",
	}
	// Discovery has to find something real for the candidate to be selected;
	// "go" is on PATH wherever these tests run.
	candidates := []Candidate{{
		ID: "langfuse-cli", Kind: "cli", Command: "langfuse",
		CredentialInjection: "langfuse_cli_shell",
		Discovery:           discovery.Spec{BinaryNames: []string{"go"}},
	}}

	cmd, chosen, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), quietLogger())
	if err != nil {
		t.Fatalf("SelectAndBuildCommand: %v", err)
	}
	if chosen.ID != "langfuse-cli" || cmd.Mode != "cli" {
		t.Fatalf("chosen %q mode %q", chosen.ID, cmd.Mode)
	}
	if strings.Contains(cmd.Exec, "langfuse") {
		t.Fatalf("Exec = %q, want the operator's shell: the CLI exits immediately, so a terminal running it would just flash", cmd.Exec)
	}
	if len(cmd.Args) != 0 {
		t.Fatalf("Args = %v, want none", cmd.Args)
	}

	joined := strings.Join(cmd.Env, "\n")
	for _, want := range []string{"LANGFUSE_PUBLIC_KEY=pk-lf-abc", "LANGFUSE_SECRET_KEY=sk-lf-xyz", "LANGFUSE_BASE_URL=https://langfuse.internal"} {
		if !strings.Contains(joined, want) {
			t.Errorf("environment is missing %q:\n%s", want, joined)
		}
	}
	// The secret must never reach a command line: argv is world-readable in
	// `ps` on every platform the agent runs on.
	for _, a := range cmd.Args {
		if strings.Contains(a, "sk-lf-xyz") {
			t.Fatalf("the secret key reached argv: %q", a)
		}
	}
	if strings.Contains(cmd.Exec, "sk-lf-xyz") {
		t.Fatal("the secret key reached the executable path")
	}
	// The shell has to be able to resolve the tool the operator was just told
	// to run, even when discovery found it by absolute path.
	if !strings.Contains(joined, "PATH=") {
		t.Error("the CLI's own directory was not put on PATH for the shell")
	}
}

// The shipped template has to name the real package and the real binary, or
// the install hint sends people somewhere that does not exist.
func TestShippedLangfuseTemplateMatchesTheRealTool(t *testing.T) {
	var templates map[string][]Candidate
	if err := json.Unmarshal(defaultTemplatesJSON, &templates); err != nil {
		t.Fatalf("parse templates: %v", err)
	}
	cands, ok := templates["langfuse"]
	if !ok || len(cands) == 0 {
		t.Fatal("no langfuse entry")
	}

	cli := cands[0]
	if cli.Kind != "cli" {
		t.Fatalf("first candidate kind = %q, want cli so an operator with the CLI installed gets a recorded terminal rather than a browser tab", cli.Kind)
	}
	// npm's langfuse-cli package installs a binary called "langfuse".
	if cli.Command != "langfuse" {
		t.Fatalf("command = %q, want langfuse", cli.Command)
	}
	if !contains(cli.Discovery.BinaryNames, "langfuse") {
		t.Fatalf("discovery does not look for the langfuse binary: %#v", cli.Discovery.BinaryNames)
	}
	if !strings.Contains(cli.InstallHint, "langfuse-cli") {
		t.Errorf("install hint does not name the npm package: %q", cli.InstallHint)
	}

	// Langfuse ships no desktop application. Inventing a "gui" candidate
	// would produce a launch that can never succeed and an install hint
	// pointing at a download that does not exist.
	for _, c := range cands {
		if c.Kind == "gui" {
			t.Errorf("a gui candidate %q was added, but Langfuse has no desktop application", c.ID)
		}
	}
	if cands[len(cands)-1].Kind != "browser" {
		t.Error("the last candidate should be the web console, so a machine without the CLI still gets in")
	}
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
