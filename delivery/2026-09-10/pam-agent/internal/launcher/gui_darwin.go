//go:build darwin

// pam-agent/internal/launcher/gui_darwin.go
package launcher

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// spawnGUIAndWait opens a desktop application and blocks until the operator
// closes it, so the caller can report the session's real end.
//
// WHY THIS BLOCKS. A GUI candidate (MongoDB Compass, pgAdmin 4, RedisInsight,
// SQL Developer) has no terminal, so none of the machinery the cli path uses
// applies: there is no wrapper script running inside a window and no relay
// holding a pseudo-terminal. This function used to Start() the application and
// return immediately, which meant nothing anywhere was still watching when the
// operator quit it. PAM kept the session ACTIVE until an administrator ended
// it by hand, the grant stayed consumed, and `launch` printed a note saying so
// as though it were a property of the platform rather than a gap.
//
// It is not a property of the platform. `open -W` blocks until the application
// exits, and a directly-executed binary can simply be waited on. The cost is
// that this process stays alive for the life of the session — a few megabytes
// of idle Go binary, with no console attached, which is what the cli path's
// relay already does on the same machine.
//
// WHY `open -W -a` AND NOT Wait ON `open`. For a .app bundle, `open` is a
// launcher: it asks Launch Services to bring the application up and exits
// immediately, so waiting on `open` itself measures nothing. -W ("wait-apps")
// makes it wait for the APPLICATION rather than for a process, which is the
// distinction that matters here — every one of these tools is an Electron or
// Java application whose visible window is not the process `open` spoke to,
// and several re-exec themselves during startup.
//
// KNOWN LIMIT, stated rather than hidden: if the application was ALREADY
// running before this launch, -W returns when that shared instance quits, not
// when the operator closes the window PAM opened. macOS gives no per-window
// lifetime for a document-less application, so no honest alternative exists;
// the session ends late in that case, never early.
func spawnGUIAndWait(pc *PreparedCommand) (waited bool, enforcement Summary, err error) {
	if pc.AppBundle != "" {
		// -W waits for the application, -n is deliberately NOT passed: forcing
		// a second instance of an app that is already running is how these
		// tools lose their existing state, and several refuse outright.
		args := append([]string{"-W", "-a", pc.AppBundle, "--args"}, pc.Args...)
		c := exec.Command("open", args...)
		c.Env = append(os.Environ(), pc.Env...)
		// CombinedOutput rather than Run for the same reason the Terminal
		// launch below uses it: `open` reports why it failed on stderr and
		// says nothing through the exit status.
		out, runErr := c.CombinedOutput()
		if runErr != nil {
			detail := strings.TrimSpace(string(out))
			if detail == "" {
				detail = "no output from open"
			}
			// waited=false: the application never came up, so there is no
			// session end to report, only a failure.
			return false, enforcement, fmt.Errorf("could not open %s: %w (%s)", pc.AppBundle, runErr, detail)
		}
		return true, enforcement, nil
	}

	c := exec.Command(pc.Exec, pc.Args...)
	c.Env = append(os.Environ(), pc.Env...)
	if startErr := c.Start(); startErr != nil {
		return false, enforcement, startErr
	}
	// A non-zero exit from the tool is the tool's business, not a launch
	// failure: the session still happened and still has to be closed. So the
	// wait error is discarded here and the caller reports COMPLETED, matching
	// how the cli path treats a psql that exits 1.
	_ = c.Wait()
	return true, enforcement, nil
}
