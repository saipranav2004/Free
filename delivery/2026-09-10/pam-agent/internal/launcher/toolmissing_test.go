package launcher

import (
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/yourorg/pam-agent/internal/apiclient"
	"github.com/yourorg/pam-agent/internal/discovery"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// When nothing that could open a resource type is installed, the failure has
// to arrive as something the agent can explain to PAM, not as a bare string
// that dies on the stderr of a process with no terminal.
func TestMissingToolsProduceATypedErrorCarryingInstallHints(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{ResourceType: "postgresql", Host: "db.internal", Port: 5432}
	candidates := []Candidate{
		{
			ID: "psql", Kind: "cli", Command: "psql-that-is-not-installed",
			InstallHint: "macOS 'brew install libpq', Debian/Ubuntu 'sudo apt install postgresql-client'.",
			Discovery:   discovery.Spec{BinaryNames: []string{"psql-that-is-not-installed"}},
		},
		{
			ID: "pgadmin4", Kind: "gui", Command: "pgadmin4-that-is-not-installed",
			InstallHint: "Download pgAdmin 4 from pgadmin.org/download.",
			Discovery:   discovery.Spec{BinaryNames: []string{"pgadmin4-that-is-not-installed"}},
		},
	}

	_, _, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), quietLogger())
	if err == nil {
		t.Fatal("expected an error when no candidate tool is installed")
	}

	notFound, ok := err.(*ToolNotFoundError)
	if !ok {
		t.Fatalf("error type = %T, want *ToolNotFoundError — a bare error cannot be reported to PAM with a reason and a hint", err)
	}
	if len(notFound.Tried) != 2 {
		t.Fatalf("tried %d candidates, want 2: %#v", len(notFound.Tried), notFound.Tried)
	}
	if notFound.Code() != "tool_not_installed" {
		t.Fatalf("code = %q", notFound.Code())
	}

	reason := notFound.Reason()
	for _, want := range []string{"psql", "pgadmin4"} {
		if !strings.Contains(reason, want) {
			t.Fatalf("reason %q does not name %q — the operator needs to know which tool to install", reason, want)
		}
	}

	hint := notFound.Hint()
	if !strings.Contains(hint, "brew install libpq") || !strings.Contains(hint, "pgadmin.org") {
		t.Fatalf("hint %q lost the per-tool install guidance from the templates", hint)
	}
	// Candidate order is the fleet's preference order, and the hint has to
	// keep it so the first thing named is the first thing to try.
	if strings.Index(hint, "psql") > strings.Index(hint, "pgadmin4") {
		t.Fatalf("hint %q reordered the candidates", hint)
	}
}

// A single missing tool reads as a sentence about that tool, not as a list of
// one.
func TestASingleMissingToolReadsNaturally(t *testing.T) {
	e := &ToolNotFoundError{
		ResourceType: "clickhouse",
		Tried:        []MissingTool{{ID: "clickhouse-client", Command: "clickhouse-client", InstallHint: "macOS 'brew install clickhouse'."}},
	}
	if got, want := e.Reason(), "clickhouse-client is not installed on this machine."; got != want {
		t.Fatalf("reason = %q, want %q", got, want)
	}
}

// A template with no install_hint still has to say something useful, because
// an operator can install a binary they can name.
func TestHintFallsBackToTheExecutableNames(t *testing.T) {
	e := &ToolNotFoundError{
		ResourceType: "redis",
		Tried:        []MissingTool{{ID: "redis-cli", Command: "redis-cli"}},
	}
	if got := e.Hint(); !strings.Contains(got, "redis-cli") {
		t.Fatalf("hint = %q, want it to name the executable", got)
	}
}

// A resource type this agent has never heard of is an administrator's problem,
// not the operator's, so it is a different error with different guidance.
func TestAnUnknownResourceTypeIsItsOwnFailure(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{ResourceType: "cassandra"}
	_, _, err := SelectAndBuildCommand(resolved, nil, t.TempDir(), quietLogger())
	if _, ok := err.(*NoCandidatesError); !ok {
		t.Fatalf("error type = %T, want *NoCandidatesError", err)
	}
}

// Every tool the agent ships a template for must carry install guidance.
// This is the test that keeps the promise honest when someone adds a
// candidate later: the failure message is only useful if the data behind it
// is complete.
func TestEveryShippedToolCandidateHasAnInstallHint(t *testing.T) {
	var templates map[string][]Candidate
	if err := json.Unmarshal(defaultTemplatesJSON, &templates); err != nil {
		t.Fatalf("parse the embedded default templates: %v", err)
	}
	if len(templates) == 0 {
		t.Fatal("the embedded templates are empty")
	}

	for resourceType, candidates := range templates {
		for _, c := range candidates {
			// A browser candidate needs nothing installed: it opens the
			// operator's existing browser, so it can never be "not found".
			if c.Kind == "browser" {
				continue
			}
			if strings.TrimSpace(c.InstallHint) == "" {
				t.Errorf("%s candidate %q has no install_hint, so an operator without it would be told only that something is missing",
					resourceType, c.ID)
			}
		}
	}
}

// A resource whose ONLY way in is a web console, with no console URL set, is
// an administrator's problem. Telling the operator to install something would
// send them after a fault they cannot fix from their own machine, and there
// is nothing to install: every machine already has a browser.
func TestAnUnconfiguredWebConsoleIsNotAnInstallProblem(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{ResourceType: "metabase", Host: "mb.internal", Port: 3000}
	candidates := []Candidate{{ID: "metabase-web", Kind: "browser", Command: "{{.ConsoleURL}}"}}

	_, _, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), quietLogger())
	notFound, ok := err.(*ToolNotFoundError)
	if !ok {
		t.Fatalf("error type = %T, want *ToolNotFoundError", err)
	}
	if notFound.Code() != "resource_not_openable" {
		t.Fatalf("code = %q, want resource_not_openable — nothing here is the operator's to install", notFound.Code())
	}
	if strings.Contains(strings.ToLower(notFound.Reason()), "not installed") {
		t.Fatalf("reason = %q, want it to describe the missing configuration, not a missing install", notFound.Reason())
	}
	if !strings.Contains(notFound.Reason()+notFound.Hint(), "console_url") {
		t.Fatalf("neither reason (%q) nor hint (%q) names console_url", notFound.Reason(), notFound.Hint())
	}
}

// The mixed case, which is the one that was actually broken: a tool the
// operator could install AND a web console nobody configured. The install
// instruction has to survive, because it is the half they can act on.
func TestAMissingToolSurvivesAnUnusableBrowserFallback(t *testing.T) {
	resolved := &apiclient.ResolvedLaunch{ResourceType: "mongodb", Host: "m.internal", Port: 27017}
	candidates := []Candidate{
		{
			ID: "mongosh", Kind: "cli", Command: "mongosh-not-installed",
			InstallHint: "macOS 'brew install mongosh'.",
			Discovery:   discovery.Spec{BinaryNames: []string{"mongosh-not-installed"}},
		},
		{ID: "mongodb-web", Kind: "browser", Command: "{{.ConsoleURL}}"},
	}

	_, _, err := SelectAndBuildCommand(resolved, candidates, t.TempDir(), quietLogger())
	notFound, ok := err.(*ToolNotFoundError)
	if !ok {
		t.Fatalf("error type = %T, want *ToolNotFoundError", err)
	}
	if notFound.Code() != "tool_not_installed" {
		t.Fatalf("code = %q, want tool_not_installed", notFound.Code())
	}
	if !strings.Contains(notFound.Reason(), "mongosh") {
		t.Fatalf("reason = %q — the browser candidate's failure replaced the one the operator can act on", notFound.Reason())
	}
	hint := notFound.Hint()
	if !strings.Contains(hint, "brew install mongosh") {
		t.Fatalf("hint = %q, lost the install instruction", hint)
	}
	if !strings.Contains(hint, "console_url") {
		t.Fatalf("hint = %q, lost the configuration note", hint)
	}
	if strings.Index(hint, "mongosh") > strings.Index(hint, "console_url") {
		t.Fatalf("hint = %q puts the administrator's job before the operator's", hint)
	}
}
