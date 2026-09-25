//go:build linux

// pam-agent/internal/launcher/gui_linux.go
package launcher

import (
	"os"
	"os/exec"
)

// spawnGUIAndWait opens a desktop application and blocks until it exits, so
// the caller can report the session's real end.
//
// See gui_darwin.go for the reasoning; it applies identically here. Linux
// needs no `open`-style indirection: the template names the executable, this
// process starts it, and waiting on that child is exactly right.
//
// KNOWN LIMIT, same shape as macOS: an application that is really a shell
// script or launcher which re-execs and exits (some vendor-packaged Java
// tools do this) is observed as finishing immediately. The session then ends
// early rather than late. Where that matters, point the template at the real
// binary rather than the launcher; discovery.Spec already supports naming an
// exact path.
func spawnGUIAndWait(pc *PreparedCommand) (waited bool, enforcement Summary, err error) {
	c := exec.Command(pc.Exec, pc.Args...)
	c.Env = append(os.Environ(), pc.Env...)
	if startErr := c.Start(); startErr != nil {
		return false, enforcement, startErr
	}
	// The tool's own exit status is not a launch failure — the session
	// happened and has to be closed. Discarded for the same reason the cli
	// path does not treat a non-zero psql as a failed launch.
	_ = c.Wait()
	return true, enforcement, nil
}
