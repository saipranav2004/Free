package launcher

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/yourorg/pam-agent/internal/discovery"
)

// A pinned tool path that no longer exists is the failure mode an
// administrator cannot otherwise see. The launch does not stop: the candidate
// list carries on and the operator gets a session in whatever tool IS
// installed, so nothing in the product would ever tell the admin their pin is
// dead. The warning in the agent log is the only signal, and these tests hold
// it in place.
func TestAStalePinnedPathIsWarnedAboutAndDoesNotStopTheLaunch(t *testing.T) {
	dir := t.TempDir()
	sqlplus := filepath.Join(dir, "sqlplus")
	if err := os.WriteFile(sqlplus, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	cands := defaultCandidates(t, "oracle")
	for i := range cands {
		switch cands[i].ID {
		case "sqlplus":
			cands[i].Discovery = discovery.Spec{AbsolutePathGlobs: map[string][]string{runtime.GOOS: {sqlplus}}}
		default:
			cands[i].Discovery = notFoundSpec()
		}
	}

	resolved := oracleResolved("pw", map[string]interface{}{
		"sid":        "XE",
		"tool_paths": map[string]interface{}{"sqldeveloper": filepath.Join(dir, "does-not-exist", "sqldeveloper")},
	})

	var logged bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelDebug}))

	_, chosen, err := SelectAndBuildCommand(resolved, cands, t.TempDir(), log)
	if err != nil {
		t.Fatalf("a stale pin must not fail a launch that has another usable tool: %v", err)
	}
	if chosen.ID != "sqlplus" {
		t.Fatalf("chose %q, expected the launch to carry on to sqlplus", chosen.ID)
	}

	out := logged.String()
	if !strings.Contains(out, "launch.candidate.pinned_path_missing") {
		t.Fatalf("a stale pin was skipped silently; the admin would never learn.\nlog:\n%s", out)
	}
	// Warn, not Debug: a default-level log must carry it, or it is invisible
	// on every machine that has not turned debug logging on.
	if !strings.Contains(out, "level=WARN") {
		t.Fatalf("the stale pin was logged below WARN, so it will not appear in a normal agent log.\nlog:\n%s", out)
	}
	if !strings.Contains(out, "does-not-exist") {
		t.Fatalf("the warning does not name the configured path, so it is not actionable.\nlog:\n%s", out)
	}
}

// The tool that simply is not installed must NOT produce the same warning, or
// the signal is worthless: every machine without pgAdmin would emit it.
func TestAnUnpinnedMissingToolIsNotWarnedAbout(t *testing.T) {
	cands := defaultCandidates(t, "oracle")
	for i := range cands {
		if cands[i].Kind != "browser" {
			cands[i].Discovery = notFoundSpec()
		}
	}
	resolved := oracleResolved("pw", map[string]interface{}{"sid": "XE"})
	resolved.ConsoleURL = "https://apex.internal/ords/"

	var logged bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelDebug}))
	if _, _, err := SelectAndBuildCommand(resolved, cands, t.TempDir(), log); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(logged.String(), "pinned_path_missing") {
		t.Fatalf("a tool that was never pinned was reported as a stale pin:\n%s", logged.String())
	}
}
