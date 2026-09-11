//go:build darwin

// pam-agent/internal/launcher/spawn_darwin.go
package launcher

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/yourorg/pam-agent/internal/recorder"
)

// Spawn dispatches on pc.Mode:
//
//   - "gui": launches the GUI tool and WAITS for it — `open -W -a <bundle>`
//     when discovery found it as a .app bundle (pc.AppBundle set), or a
//     direct exec plus Wait when it's a plain binary path. No Terminal.app
//     involved. See spawnGUIAndWait for why waiting is the whole point.
//   - "cli" (default): opens a new Terminal.app window running the
//     command. Terminal's "do script" starts a brand-new login shell that
//     does NOT inherit this process's environment, so pc.Env entries are
//     folded into a generated wrapper script instead (as `export
//     KEY=VALUE` lines) — only the wrapper script's file PATH ever appears
//     in the AppleScript/osascript argument list, never the credential.
//     The wrapper is a 0700 temp file added to pc.CleanupFiles for the
//     caller to remove shortly after this returns.
//
// The cli path does not block until the window actually closes — osascript
// and `open` both return as soon as Terminal accepts the script. That is why
// this function does not report the session end for cli and sets
// EndReportedByWrapper instead: the exact end is known inside the window, not
// out here. The gui path has no window to put a reporter inside, so it waits
// here instead and lets the caller report.
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

	// The wrapper now also reports this session's end, because osascript
	// returns as soon as Terminal.app accepts the script and nothing else is
	// left alive to notice the window closing.
	wrapperPath, err := writeSessionWrapper(pc, EndReport{
		AgentPath: pc.AgentPath, ServerURL: pc.ServerURL, SessionID: pc.SessionID,
		PolicyJSON: pc.PolicyJSON, Record: pc.Record,
		RelayRequired: pc.Record || pc.Policy.Active(),
	})
	if err != nil {
		return false, enforcement, err
	}
	pc.CleanupFiles = append(pc.CleanupFiles, wrapperPath)
	pc.EndReportedByWrapper = true

	// `open -a Terminal <script>` and NOT osascript's
	// `tell application "Terminal" to do script`.
	//
	// The two look interchangeable and are not. `tell application` sends an
	// Apple Event, which macOS gates behind the per-app Automation
	// permission (System Settings > Privacy & Security > Automation). This
	// process is launched from a pam-agent:// URL by an LSUIElement applet
	// with no window on screen, and macOS will not show a permission prompt
	// for a client in that state — it denies silently instead. osascript
	// then exits 1, and the session never opens, with nothing on screen and
	// nothing in the log to say why. Confirmed on real hardware: install,
	// token redemption and psql discovery all succeeded, and this single
	// call failed ~40ms later with a bare "exit status 1", on a machine
	// whose Automation setting for the applet was switched ON.
	//
	// `open` goes through Launch Services instead. It is not an Apple Event,
	// so no Automation grant is involved at all: Terminal.app opens the
	// wrapper (0700, .sh, written by writeSessionWrapper) and runs it in a
	// new window the same way double-clicking it in Finder would. This is
	// also what README.md and CONTEXT.md have described this path as doing
	// all along — the code had drifted to the osascript form, and the drift
	// is what carried the hidden permission dependency in with it.
	//
	// Returns immediately either way, which is why the wrapper (not this
	// process) reports the session end — see EndReportedByWrapper above.
	c := exec.Command("open", "-a", "Terminal", wrapperPath)

	// CombinedOutput, not Run: `open` explains a failure on stderr and says
	// nothing through the exit status. Run() discarded that, which is how a
	// launch failure reached the operator as an unactionable bare exit code.
	if out, runErr := c.CombinedOutput(); runErr != nil {
		detail := strings.TrimSpace(string(out))
		if detail == "" {
			detail = "no output from open"
		}
		return false, enforcement, fmt.Errorf(
			"could not open Terminal for the session: %w (%s)", runErr, detail)
	}
	return false, enforcement, nil
}
