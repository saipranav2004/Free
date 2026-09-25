// pam-agent/cmd/pam-agent/failure.go
//
// Turning a launch failure into something the operator can read in the PAM
// console.
//
// The operating system starts `pam-agent launch` from a pam-agent:// URL with
// no terminal attached, so everything this process writes to stderr is
// discarded. That is why a missing psql looked, from the browser, like a
// button that did nothing: the agent knew exactly what was wrong, said so,
// and said it into a void. These helpers put the same explanation on the
// session-end report instead, which is a channel the console can read.
package main

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"unicode/utf8"

	"github.com/yourorg/pam-agent/internal/apiclient"
	"github.com/yourorg/pam-agent/internal/launcher"
	"github.com/yourorg/pam-agent/internal/recorder"
)

// describedFailure is implemented by every launcher error that knows how to
// explain itself to a person. Anything else falls back to its Error() string,
// which is still better than silence.
type describedFailure interface {
	Reason() string
	Hint() string
	Code() string
}

// describeLaunchFailure converts an error into the report PAM stores against
// the session and the console renders.
//
// errors.As rather than a type switch: the error may already be wrapped by
// the time it gets here, and a wrapped ToolNotFoundError must not silently
// degrade into a generic message.
func describeLaunchFailure(err error) *apiclient.LaunchFailure {
	if err == nil {
		return nil
	}

	var described describedFailure
	if errors.As(err, &described) {
		return &apiclient.LaunchFailure{
			Code:   described.Code(),
			Reason: clampFailureText(described.Reason(), 400),
			Hint:   clampFailureText(described.Hint(), 600),
		}
	}

	return &apiclient.LaunchFailure{
		Code:   "launch_failed",
		Reason: clampFailureText(err.Error(), 400),
		Hint:   "Check the local agent log for the full error, then try again.",
	}
}

// reportEndFailure describes a session that ended because the tool itself
// exited non-zero. There is no error value to inspect here — the wrapper has
// only the exit status — so the report says exactly that and no more. A clean
// exit reports nothing at all, which is what keeps a normal session end free
// of a failure record.
func reportEndFailure(exitCode int) *apiclient.LaunchFailure {
	if exitCode == 0 {
		return nil
	}
	// CONTEXT ON A COMPLETED SESSION, not a verdict on a failed one. The
	// caller reports status COMPLETED alongside this; see the end-of-session
	// reporting in main.go for why a non-zero status from an interactive
	// client is routine rather than an error.
	return &apiclient.LaunchFailure{
		Code: "tool_exited_nonzero",
		Reason: fmt.Sprintf("The tool exited with status %d. That is normal when you close the window, "+
			"and also what it returns when it could not connect.", exitCode),
		Hint: "The session was recorded either way. Replay it to see what the tool printed before it stopped.",
	}
}

// unrecordableLaunchError is raised when PAM requires this session to be
// recorded and nothing on this machine can record it.
//
// The agent has two ways to record. A terminal is captured by the relay,
// which owns the pseudo-terminal the tool runs inside (see
// internal/launcher/relay_unix.go and conpty_windows.go). A DESKTOP
// application has no terminal, so it is captured as video by
// internal/recorder's screen recorder instead: a desktop client draws pixels,
// so pixels are the only honest recording of one.
//
// That leaves exactly two cases where the obligation still cannot be met, and
// they are the only ones this error covers now:
//
//	a desktop application on a machine with no ffmpeg installed, and
//	a "browser" candidate, which opens the operator's own browser at a URL.
//	  Nothing in that path is the agent, so it can neither capture nor stop
//	  anything. A web application that IS recorded is recorded by PAM's own
//	  brokered proxy, a different launch path that does not come through here.
//
// The obligation is never silently dropped. Before any of this existed,
// `Record` was computed as "recording required AND this is a cli launch", so
// a GUI candidate set it false and opened anyway: the operator got their
// session, PAM's row carried an obligation nothing would ever satisfy, and
// the audit trail implied a supervised session that was never supervised.
type unrecordableLaunchError struct {
	ResourceType string
	CandidateID  string
	Mode         string

	// RecorderMissing distinguishes "this machine is missing a tool" (the
	// operator can fix it) from "this way in cannot be recorded at all" (they
	// cannot). They need different advice.
	RecorderMissing bool
}

func (e *unrecordableLaunchError) Error() string {
	if e.RecorderMissing {
		return fmt.Sprintf("this %s resource must be recorded, and %s is not installed to record the %q desktop session",
			e.ResourceType, recorder.ScreenRecorderName, e.CandidateID)
	}
	return fmt.Sprintf("this %s resource must be recorded, and %q opens in a browser, which the agent cannot record",
		e.ResourceType, e.CandidateID)
}

func (e *unrecordableLaunchError) Reason() string {
	if e.RecorderMissing {
		return fmt.Sprintf("This resource must be recorded, and %s is not installed on this machine to record a desktop session.",
			recorder.ScreenRecorderName)
	}
	return fmt.Sprintf("This resource must be recorded, and %s opens in your browser, which the agent cannot record.", e.CandidateID)
}

func (e *unrecordableLaunchError) Hint() string {
	if e.RecorderMissing {
		return recorder.ScreenUnavailableHint()
	}
	return "Install the command line client for this resource so the session can be opened in a recorded terminal, " +
		"or ask an administrator to route this web application through PAM's own browser proxy, which records it."
}

func (e *unrecordableLaunchError) Code() string {
	if e.RecorderMissing {
		return "recorder_not_installed"
	}
	return "recording_not_possible"
}

// recordingObligationUnmet reports whether this prepared command would open a
// session PAM expects to be recorded, through something that cannot record
// it. See unrecordableLaunchError for the two remaining cases.
func recordingObligationUnmet(recordingRequired bool, pc *launcher.PreparedCommand) bool {
	if !recordingRequired || pc == nil {
		return false
	}
	return !modeIsRecordable(pc.Mode)
}

// modeIsRecordable answers, for one launch mode, whether THIS machine can
// produce a recording of it right now.
//
// Split out of recordingObligationUnmet because the candidate walk needs the
// same answer before it has a PreparedCommand to ask about: it uses this to
// pass over a candidate it cannot record and try the next one, rather than
// refusing a launch that a later candidate could have satisfied. Two copies
// of this rule would eventually disagree, and the disagreement would look
// like the agent refusing a launch it had just decided was fine.
func modeIsRecordable(mode string) bool {
	switch mode {
	case "cli":
		return true // the relay owns the pseudo-terminal and records it
	case "gui":
		// A desktop app is recorded as video, which needs ffmpeg installed.
		return recorder.ScreenRecorderAvailable()
	default:
		// A browser tab. Nothing in that path is the agent, so it can neither
		// capture nor stop anything.
		return false
	}
}

// clampFailureText keeps a report short enough to render and free of the
// incidental newlines a wrapped error accumulates. It is a presentation
// bound, not a security one: describeLaunchFailure's callers are responsible
// for never putting a credential in one of these in the first place.
//
// max counts BYTES, because that is what the server bounds on arrival and
// what the column stores. The ellipsis costs three of them, and the cut has
// to land on a rune boundary — an error string can carry a path or a message
// that is not ASCII, and half a rune renders as a replacement character.
func clampFailureText(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= max {
		return s
	}
	const ellipsis = "…"
	cut := max - len(ellipsis)
	if cut <= 0 {
		return ""
	}
	for cut > 0 && !utf8.ValidString(s[:cut]) {
		cut--
	}
	return strings.TrimSpace(s[:cut]) + ellipsis
}

// clipboardHandoffError is raised when the only way this candidate can receive
// the password is the clipboard, and the clipboard could not be written.
//
// It is a launch failure rather than a warning because the alternative is
// worse than not opening: the application starts, asks for a password the
// operator does not have and cannot get from the agent, and PAM records a
// session that was never usable. See the call site in main.go for the full
// history.
type clipboardHandoffError struct {
	CandidateID string
	Err         error
}

func (e *clipboardHandoffError) Error() string {
	return fmt.Sprintf("could not put the password on the clipboard for %q, which is the only way it can receive one: %v",
		e.CandidateID, e.Err)
}

func (e *clipboardHandoffError) Unwrap() error { return e.Err }

func (e *clipboardHandoffError) Reason() string {
	return fmt.Sprintf("%s receives its password through the clipboard, and this machine has no clipboard tool, so the password could not be handed over.", e.CandidateID)
}

func (e *clipboardHandoffError) Hint() string {
	switch runtime.GOOS {
	case "darwin":
		return "macOS normally provides pbcopy. If it is missing from PATH, restore it, then try again."
	case "windows":
		return "Windows normally provides clip.exe. If it is missing from PATH, restore it, then try again."
	default:
		return "Install one of xclip, xsel or wl-clipboard, then try again. Until then you can reveal the password in PAM and paste it yourself."
	}
}

func (e *clipboardHandoffError) Code() string { return "clipboard_unavailable" }
