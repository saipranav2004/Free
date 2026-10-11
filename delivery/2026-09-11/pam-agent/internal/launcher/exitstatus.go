// pam-agent/internal/launcher/exitstatus.go
package launcher

import (
	"errors"
	"os/exec"
)

// exitStatusOf reads the status a finished process returned, and reports
// whether the error was a process exit at all. Anything else — the binary not
// being there, a permission refusal — means no process ever ran, which is a
// different thing entirely and must stay a launch failure.
func exitStatusOf(err error) (int, bool) {
	if err == nil {
		return 0, false
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), true
	}
	return 0, false
}
