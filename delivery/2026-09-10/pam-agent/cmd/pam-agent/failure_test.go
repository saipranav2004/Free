package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yourorg/pam-agent/internal/launcher"
	"github.com/yourorg/pam-agent/internal/recorder"
)

// The whole point of the failure path: a missing tool becomes a code, a
// sentence and an install hint that PAM can store and the console can render.
func TestDescribeLaunchFailureCarriesTheToolDetail(t *testing.T) {
	err := &launcher.ToolNotFoundError{
		ResourceType: "mongodb",
		Tried: []launcher.MissingTool{
			{ID: "mongosh", Command: "mongosh", InstallHint: "macOS 'brew install mongosh'."},
			{ID: "mongodb-compass", Command: "mongodb-compass", InstallHint: "Download Compass from mongodb.com."},
		},
	}

	got := describeLaunchFailure(err)
	if got == nil {
		t.Fatal("describeLaunchFailure returned nil for a real failure")
	}
	if got.Code != "tool_not_installed" {
		t.Fatalf("code = %q", got.Code)
	}
	if !strings.Contains(got.Reason, "mongosh") {
		t.Fatalf("reason = %q, want it to name the tool", got.Reason)
	}
	if !strings.Contains(got.Hint, "brew install mongosh") {
		t.Fatalf("hint = %q, want the install guidance", got.Hint)
	}
}

// The error is wrapped by the time it reaches the reporting call in some
// paths. errors.As has to see through that, or a wrapped ToolNotFoundError
// silently degrades to a generic "launch failed" and the operator loses the
// only sentence that would have helped them.
func TestDescribeLaunchFailureSeesThroughWrapping(t *testing.T) {
	inner := &launcher.ToolNotFoundError{
		ResourceType: "oracle",
		Tried:        []launcher.MissingTool{{ID: "sqlplus", Command: "sqlplus", InstallHint: "Install Oracle Instant Client."}},
	}
	got := describeLaunchFailure(fmt.Errorf("preparing the launch: %w", inner))
	if got.Code != "tool_not_installed" {
		t.Fatalf("code = %q, want the wrapped error's own code", got.Code)
	}
	if !strings.Contains(got.Hint, "Instant Client") {
		t.Fatalf("hint = %q, want the wrapped error's hint", got.Hint)
	}
}

// Anything the agent could not classify still has to reach the operator. A
// silent failure is the bug this whole path exists to remove.
func TestDescribeLaunchFailureAlwaysSaysSomething(t *testing.T) {
	got := describeLaunchFailure(fmt.Errorf("could not open Terminal for the session"))
	if got == nil || got.Reason == "" {
		t.Fatalf("an unclassified error produced %#v, want a reason", got)
	}
	if got.Code != "launch_failed" {
		t.Fatalf("code = %q, want the generic code", got.Code)
	}
	if describeLaunchFailure(nil) != nil {
		t.Fatal("a nil error must not produce a failure report")
	}
}

// A tool that ran and exited non-zero is not a launch failure: the session
// happened. It is still worth reporting, but as a different thing.
func TestReportEndFailureOnlyForANonZeroExit(t *testing.T) {
	if got := reportEndFailure(0); got != nil {
		t.Fatalf("a clean exit produced a failure report: %#v", got)
	}
	got := reportEndFailure(2)
	if got == nil || got.Code != "tool_exited_nonzero" {
		t.Fatalf("got %#v, want a tool_exited_nonzero report", got)
	}
	if !strings.Contains(got.Reason, "2") {
		t.Fatalf("reason = %q, want it to carry the exit status", got.Reason)
	}
}

// A recording obligation must never be quietly dropped, and there are now two
// ways to meet one:
//
//	a terminal is captured by the relay, which owns the pseudo-terminal, and
//	a desktop application is captured as video by the screen recorder.
//
// So the answer for a "gui" launch depends on whether this machine has a
// screen recorder, which is exactly what these subtests vary. PATH is what
// ScreenRecorderAvailable consults, so emptying it is a faithful stand-in for
// a machine without ffmpeg rather than a mock of the check.
func TestRecordingObligationDependsOnWhatCanActuallyRecord(t *testing.T) {
	t.Run("no screen recorder on this machine", func(t *testing.T) {
		t.Setenv("PATH", "")
		for _, tc := range []struct {
			mode     string
			required bool
			unmet    bool
		}{
			// The relay records a terminal; it needs no ffmpeg.
			{mode: "cli", required: true, unmet: false},
			// Nothing can record a desktop app here, so it must be refused.
			{mode: "gui", required: true, unmet: true},
			// A browser tab is never recordable by the agent, recorder or not.
			{mode: "browser", required: true, unmet: true},
			// With no obligation, none of this applies.
			{mode: "gui", required: false, unmet: false},
			{mode: "browser", required: false, unmet: false},
			{mode: "cli", required: false, unmet: false},
		} {
			pc := &launcher.PreparedCommand{Mode: tc.mode}
			if got := recordingObligationUnmet(tc.required, pc); got != tc.unmet {
				t.Errorf("mode=%s recordingRequired=%v: unmet=%v, want %v", tc.mode, tc.required, got, tc.unmet)
			}
		}
	})

	t.Run("a screen recorder is available", func(t *testing.T) {
		dir := t.TempDir()
		// A file named like the recorder and marked executable is all
		// exec.LookPath asks for, which keeps this test off the real ffmpeg.
		stub := filepath.Join(dir, recorder.ScreenRecorderName)
		if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatalf("write stub recorder: %v", err)
		}
		t.Setenv("PATH", dir)

		// The whole point of the round: a desktop application session is now
		// RECORDED rather than refused.
		if recordingObligationUnmet(true, &launcher.PreparedCommand{Mode: "gui"}) {
			t.Error("a desktop launch was refused even though this machine can record one")
		}
		// A browser tab still cannot be recorded by anything the agent runs.
		if !recordingObligationUnmet(true, &launcher.PreparedCommand{Mode: "browser"}) {
			t.Error("a browser launch must still be refused: nothing in that path is the agent")
		}
	})

	if recordingObligationUnmet(true, nil) {
		t.Error("a nil command cannot have an unmet obligation; there is no launch to refuse")
	}
}

// The refusal has to explain itself in the same shape as every other failure,
// and the two remaining reasons need DIFFERENT advice: one is the operator's
// to fix, the other is not.
func TestUnrecordableLaunchExplainsItself(t *testing.T) {
	t.Run("a machine with no screen recorder", func(t *testing.T) {
		got := describeLaunchFailure(&unrecordableLaunchError{
			ResourceType: "mongodb", CandidateID: "mongodb-compass", Mode: "gui",
			RecorderMissing: true,
		})
		if got.Code != "recorder_not_installed" {
			t.Fatalf("code = %q", got.Code)
		}
		if !strings.Contains(got.Reason, recorder.ScreenRecorderName) {
			t.Fatalf("reason = %q, want it to name what is missing", got.Reason)
		}
		if !strings.Contains(strings.ToLower(got.Hint), "install") {
			t.Fatalf("hint = %q, want an install instruction the operator can act on", got.Hint)
		}
	})

	t.Run("a browser candidate, which nothing can record", func(t *testing.T) {
		got := describeLaunchFailure(&unrecordableLaunchError{
			ResourceType: "metabase", CandidateID: "metabase-web", Mode: "browser",
		})
		if got.Code != "recording_not_possible" {
			t.Fatalf("code = %q", got.Code)
		}
		if !strings.Contains(got.Reason, "metabase-web") {
			t.Fatalf("reason = %q, want it to name the way in that cannot be recorded", got.Reason)
		}
		if !strings.Contains(got.Hint, "command line client") {
			t.Fatalf("hint = %q, want the way out", got.Hint)
		}
	})
}

// These strings are stored server-side and rendered in a panel, so a runaway
// error from someone's laptop must not arrive unbounded or full of newlines.
func TestFailureTextIsClampedAndFlattened(t *testing.T) {
	got := describeLaunchFailure(fmt.Errorf("line one\nline two\t\tspaced   out %s", strings.Repeat("x", 5000)))
	if strings.ContainsAny(got.Reason, "\n\t") {
		t.Fatalf("reason kept raw whitespace: %q", got.Reason)
	}
	if len(got.Reason) > 400 {
		t.Fatalf("reason length %d exceeds the 400 bound", len(got.Reason))
	}
	if !strings.Contains(got.Reason, "line one line two spaced out") {
		t.Fatalf("reason = %q, want the whitespace collapsed rather than the text mangled", got.Reason[:60])
	}
}
