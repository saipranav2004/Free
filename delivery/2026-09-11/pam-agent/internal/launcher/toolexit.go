// pam-agent/internal/launcher/toolexit.go
//
// Telling "the tool would not start" apart from "the tool ran, and finished".
package launcher

import "fmt"

// ToolExitError reports that the tool STARTED, ran, and then exited with a
// non-zero status.
//
// This is a distinct type because it is not, on its own, a failed launch, and
// treating it as one was wrong in the most common case there is. An
// interactive client exits non-zero as a matter of routine: sqlplus and psql
// return 1 when the operator closes the window, mongosh does the same, and on
// Windows closing a console window delivers CTRL_CLOSE_EVENT and a non-zero
// status by definition.
//
// Measured on a real deployment's agent log rather than reasoned about: one
// Oracle session ran for fourteen hours and captured four commands, then
// reported
//
//	launch.spawn.fail ... "sqlplus.exe exited with code 1"
//	launch.recording.upload.ok status=COMPLETED commands_captured=4
//
// so the recording said COMPLETED and PAM's session said FAILED, for a session
// that had been used all day. Every successful session on that machine was
// filed as a failure.
//
// What a non-zero status IS good for is context: paired with how long the tool
// lived and what it printed, it is the difference between "the operator quit"
// and "it could not connect". See cmd/pam-agent's end-of-session reporting.
type ToolExitError struct {
	Exec string
	Code int
}

func (e *ToolExitError) Error() string {
	return fmt.Sprintf("%s exited with code %d", e.Exec, e.Code)
}

// ExitCodeOf returns the status a tool exited with, and whether the error was
// a tool exit at all. A false means the tool never got as far as running.
func ExitCodeOf(err error) (int, bool) {
	if e, ok := err.(*ToolExitError); ok {
		return e.Code, true
	}
	return 0, false
}
