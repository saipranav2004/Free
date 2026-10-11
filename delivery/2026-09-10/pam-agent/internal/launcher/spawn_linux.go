//go:build linux

// pam-agent/internal/launcher/spawn_linux.go
package launcher

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/yourorg/pam-agent/internal/recorder"
)

// Spawn dispatches on pc.Mode:
//
//   - "gui": execs the GUI tool directly (e.g. pgAdmin4, MongoDB Compass),
//     no terminal involved — matches launching it from a desktop icon — and
//     WAITS for it, so closing the application ends the PAM session. See
//     spawnGUIAndWait in gui_linux.go.
//   - "cli" (default): opens a new terminal window running the command,
//     trying common Linux terminal emulators in order. xterm is tried
//     first specifically because it execs its child directly —
//     exec.Command(...).Run() genuinely blocks until that window closes,
//     giving an exact session-end time. The others (gnome-terminal,
//     konsole, xfce4-terminal, the generic x-terminal-emulator
//     alternative) are client/server-style emulators whose CLI invocation
//     returns almost immediately regardless of when the window actually
//     closes, so session-end tracking is best-effort with those —
//     documented in the README, not hidden. Edit launch-templates.json /
//     reorder this list if your fleet standardizes on a different
//     terminal.
//
// rec is ignored here, but the session IS recorded: the capture belongs to
// `pam-agent relay`, which the wrapper runs inside the terminal this function
// opens. It has to live there rather than in this process, because this
// process has no terminal to relay — the whole reason a terminal emulator is
// being asked for at all. The relay holds a pty with the tool inside it and
// uploads the asciicast itself when the tool exits, so `launch` deliberately
// skips its own upload for these platforms (see cmd/pam-agent/main.go).
func Spawn(pc *PreparedCommand, rec *recorder.Cast) (waited bool, enforcement Summary, err error) {
	if pc.Mode == "gui" {
		return spawnGUIAndWait(pc)
	}

	type candidate struct {
		name   string
		flag   string
		blocks bool
	}
	candidates := []candidate{
		{"xterm", "-e", true},
		{"x-terminal-emulator", "-e", false},
		{"gnome-terminal", "--", false},
		{"konsole", "-e", false},
		{"xfce4-terminal", "-e", false},
	}

	// Everything runs through a wrapper script rather than being handed to the
	// emulator as argv, for two reasons.
	//
	// Session end: only xterm's invocation genuinely blocks. The others are
	// client/server and return the instant the window is requested, so the
	// agent could never report when the session finished and PAM was left with
	// a session marked ACTIVE until an admin ended it by hand. The wrapper runs
	// INSIDE the terminal and outlives the tool, so it can report the end
	// itself — which works the same way on every emulator below.
	//
	// Credential exposure: pc.Env carried the credential into the emulator's
	// environment, and pc.Args onto a command line visible in `ps` to every
	// process on the machine. The wrapper is a 0700 file holding both, which
	// is how macOS has always done it (see wrapper.go).
	wrapperPath, wrapErr := writeSessionWrapper(pc, EndReport{
		AgentPath: pc.AgentPath, ServerURL: pc.ServerURL, SessionID: pc.SessionID,
		PolicyJSON: pc.PolicyJSON, Record: pc.Record,
		RelayRequired: pc.Record || pc.Policy.Active(),
	})
	if wrapErr != nil {
		return false, enforcement, wrapErr
	}
	pc.CleanupFiles = append(pc.CleanupFiles, wrapperPath)
	pc.EndReportedByWrapper = true

	for _, cand := range candidates {
		path, lookErr := exec.LookPath(cand.name)
		if lookErr != nil {
			continue
		}
		c := exec.Command(path, cand.flag, "/bin/bash", wrapperPath)
		// Deliberately NOT pc.Env here: the wrapper exports it internally, and
		// passing it again would put the credential back into the emulator's
		// own environment, where a child process could read it.
		c.Env = os.Environ()
		err = c.Run()
		return cand.blocks, enforcement, err
	}

	return false, enforcement, fmt.Errorf(
		"no supported terminal emulator found on this system (tried xterm, x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal) — install one of these, or edit launch-templates.json to target a GUI tool directly instead")
}
