//go:build windows

// pam-agent/internal/launcher/spawn_windows.go
package launcher

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/yourorg/pam-agent/internal/recorder"
)

// win32InputModeSuppressor watches conhost's output for its "Win32 Input
// Mode" negotiation (CSI ?9001h) and immediately declines it (CSI ?9001l)
// the moment it appears.
//
// Win32 Input Mode asks whatever's relaying keyboard input to encode each
// keystroke as a rich CSI-terminated sequence carrying the full Win32
// KEY_EVENT_RECORD (virtual key code, scan code, key-down flag, modifier
// state, repeat count) instead of plain VT bytes — real terminal emulators
// either speak that encoding or explicitly decline it. This relay does
// neither on its own; silently ignoring the offer (rather than declining
// it) leaves conhost expecting an encoding that never arrives, which
// doesn't just fail to relay keystrokes cleanly, it corrupts them —
// confirmed live against psql on Windows: a typed "select 1;" arrived at
// the SQL parser as an empty statement ("syntax error at or near \"\"")
// once conhost switched into this mode, with garbled
// CSI-parameter-looking noise filling the visible session and the
// recording. Declining it keeps everything on plain VT text, which is what
// this relay (and keylog.go's line accumulator) actually implements.
type win32InputModeSuppressor struct {
	tail []byte
	done bool
}

const (
	win32InputModeEnable  = "\x1b[?9001h"
	win32InputModeDisable = "\x1b[?9001l"
)

// win32EchoFilter strips conhost's Win32-Input-Mode key-echo sequences
// (CSI Vk;Sc;Uc;Kd;Cs;Rc _ — see win32InputModeSuppressor's doc comment)
// from what gets fed into the recording, WITHOUT touching the live console
// write at all. Those sequences are meaningless noise to anything but a
// terminal that implements the Win32-Input-Mode protocol end to end — real
// conhost silently expects/consumes them for the live display (confirmed:
// typed characters echo completely normally on screen), but a standard
// xterm.js/asciinema-style replay player has never heard of this
// Windows-specific extension and renders it as literal garbage text, which
// is what actually showed up in a saved recording despite the live session
// looking completely normal.
//
// Every OTHER escape sequence (cursor movement, colors, clear-screen, the
// window-title OSC) passes through unchanged — those are standard VT and a
// real replay player needs them to render correctly.
type win32EchoFilter struct {
	pending []byte
}

// filter returns the subset of chunk that should actually be recorded: any
// completed Win32-Input-Mode echo sequence removed, everything else passed
// through unchanged. If chunk ends mid-sequence, the incomplete tail is
// held over internally and completed (or abandoned) on the next call.
func (f *win32EchoFilter) filter(chunk []byte) []byte {
	data := append(f.pending, chunk...)
	f.pending = nil

	out := make([]byte, 0, len(data))
	i := 0
	for i < len(data) {
		if data[i] != 0x1b || i+1 >= len(data) || data[i+1] != '[' {
			out = append(out, data[i])
			i++
			continue
		}
		// ESC '[' — scan forward for the final byte (0x40-0x7E); bytes in
		// between are CSI parameters/intermediates (0x20-0x3F).
		j := i + 2
		for j < len(data) && data[j] >= 0x20 && data[j] <= 0x3f {
			j++
		}
		if j >= len(data) {
			// Not complete yet — could still turn into a "_"-terminated
			// sequence once more bytes arrive; hold it all for next time.
			f.pending = append(f.pending, data[i:]...)
			return out
		}
		final := data[j]
		if final < 0x40 || final > 0x7e {
			// Not a well-formed CSI sequence — emit just the ESC byte and
			// let the loop reprocess the rest as plain bytes, the same
			// conservative fallback keylog.go's escape handling uses.
			out = append(out, data[i])
			i++
			continue
		}
		if final != '_' {
			out = append(out, data[i:j+1]...)
		}
		i = j + 1
	}
	return out
}

// scan also returns chunk with any win32InputModeEnable request stripped
// out. That request must never reach the real, physical console
// (consoleOut) unfiltered: whatever terminal is actually hosting this
// process's own console (Windows Terminal, a re-used existing shell per
// the README's "invoked manually for testing" case, etc.) honors CSI
// ?9001h on ITS OWN input just as readily as the nested conhost this
// suppressor was originally written to protect — and once it does, this
// process's own consoleIn reads start arriving as Win32-Input-Mode-encoded
// CSI sequences instead of plain VT bytes, which keylog.go's accumulator
// has no decoder for and silently discards as unrecognized escape
// sequences. Confirmed live: with the request passed through unfiltered,
// every operator keystroke gets swallowed this way and the structured
// command log ends up permanently empty for the whole session, even
// though the byte-for-byte cast recording (which just stores raw bytes
// unconditionally) still looks non-empty.
func (s *win32InputModeSuppressor) scan(chunk []byte, respondTo io.Writer) []byte {
	if s.done {
		return chunk
	}
	s.tail = append(s.tail, chunk...)
	// The marker is 8 bytes; keeping a little more than that across calls
	// is enough to catch it even if a Read() split it mid-sequence.
	if len(s.tail) > 32 {
		s.tail = s.tail[len(s.tail)-32:]
	}
	if bytes.Contains(s.tail, []byte(win32InputModeEnable)) {
		s.done = true
		_, _ = respondTo.Write([]byte(win32InputModeDisable))
		return bytes.ReplaceAll(chunk, []byte(win32InputModeEnable), nil)
	}
	return chunk
}

// Spawn dispatches on pc.Mode:
//
//   - "gui": execs the GUI tool (e.g. pgAdmin4, MongoDB Compass) directly
//     via CreateProcess, with no new console and no wait — matches how a
//     user would normally double-click that app. Session-end tracking is
//     not available here (same caveat as macOS/Linux GUI launches). rec is
//     always ignored on this branch — a GUI app's window contents aren't
//     terminal I/O, capturing them is a fundamentally different problem
//     (screen recording, not a pty relay) and out of scope here.
//
//   - "cli": runs the tool attached to a ConPTY pseudo-console THIS process
//     owns, relaying every byte between it and a real console window —
//     rec (when the caller decided this launch needs recording — see
//     cmdLaunch) gets a copy of everything in both directions, exactly the
//     way gateway.go's RecordingConn captures a browser-terminal session on
//     the PAM server. This replaced an earlier design (`cmd /C start ""
//     /wait cmd /K <Exec> <Args...>`, still worth remembering because it
//     went through two broken iterations before landing there — see git
//     history) that opened the target tool in a genuinely separate console
//     window: correct for launching the tool, but pam-agent had zero stdio
//     access to it, which is exactly why recording was never possible on
//     this path before. Owning the pseudo-console is what makes both true
//     at once: the operator still gets a normal-looking interactive
//     session, and pam-agent now sees every byte passing through it.
func Spawn(pc *PreparedCommand, rec *recorder.Cast) (waited bool, enforcement Summary, err error) {
	if pc.Mode == "gui" {
		// Waits for the whole application, so closing it ends the PAM
		// session. See spawnGUIAndWait in gui_windows.go.
		return spawnGUIAndWait(pc)
	}
	return spawnCLIWithConPTY(pc, rec)
}

func spawnCLIWithConPTY(pc *PreparedCommand, rec *recorder.Cast) (waited bool, enforcement Summary, err error) {
	debugf("allocConsole")
	// AllocConsole fails with ERROR_ACCESS_DENIED if this process already
	// has one (e.g. `pam-agent launch` invoked manually from an existing
	// shell for testing, per the README) — that's fine, not fatal: it just
	// means CONIN$/CONOUT$ below already resolve to that existing console
	// instead of a freshly allocated one. Only the double-launch-from-a-
	// console-less-process case (the OS invoking the pam-agent:// handler,
	// the normal case) actually needs this call to succeed.
	allocErr := allocConsole()
	debugf("allocConsole done err=%v", allocErr)

	consoleIn, consoleOut, err := openConsoleHandles()
	if err != nil {
		return false, enforcement, fmt.Errorf("could not attach to a console: %w", err)
	}
	debugf("openConsoleHandles done")
	// Deliberately never explicitly closed. The input-relay goroutine below
	// holds a permanently-blocked Read() on consoleIn once the operator
	// stops typing (nothing left to read once the child has exited) — and
	// Go's Windows file-close synchronizes with any in-flight operation on
	// the same *os.File before returning, so consoleIn.Close() would block
	// forever waiting for a Read() that will never complete (confirmed by
	// hitting exactly this hang while testing this file). Same underlying
	// justification as leaking that goroutine itself: the whole process
	// exits shortly after Spawn returns either way, which reclaims both.

	if err := setRawConsoleMode(consoleIn, consoleOut, pc.Policy.BlockClipboard); err != nil {
		// Degraded (echo/line-buffering may double up, ANSI colors might
		// not render) but not fatal — the relay below still works.
		fmt.Fprintf(os.Stderr, "pam-agent: warning: console mode setup failed, output may render oddly: %v\n", err)
	}
	debugf("setRawConsoleMode done")

	pty, err := newPseudoConsole(120, 30)
	if err != nil {
		return false, enforcement, fmt.Errorf("could not create pseudo console: %w", err)
	}
	debugf("newPseudoConsole done")

	env := mergeEnv(os.Environ(), pc.Env)
	processHandle, threadHandle, pid, err := spawnAttachedTo(pty, pc.Exec, pc.Args, env)
	if err != nil {
		pty.Close()
		return false, enforcement, fmt.Errorf("could not launch %s: %w", pc.Exec, err)
	}
	debugf("spawnAttachedTo done pid=%d processHandle=%v", pid, processHandle)
	syscall.CloseHandle(threadHandle)
	defer syscall.CloseHandle(processHandle)

	// The child is attached to the pseudo console we own, not to the real
	// window the operator can see and close — so closing that window would
	// otherwise leave the child running as an orphan (still connected to
	// whatever it opened) with PAM never told the session ended. See
	// installCloseHandler's doc comment for the full mechanism.
	installCloseHandler(processHandle)

	var wg sync.WaitGroup
	wg.Add(2)

	// Reconstructs typed commands from the same raw bytes for the
	// structured, searchable command log (models.SessionRecordingCommand)
	// — see keylog.go's doc comment for why this is best-effort. Only
	// matters when rec != nil (recording was actually required); skipping
	// it otherwise avoids the reconstruction work for the common
	// unrecorded case.
	// One guard per session, shared by both relay goroutines. They touch
	// disjoint fields (input counters vs output counters), and nothing reads
	// across until both have finished and Summary() is taken.
	guard := NewGuard(pc.Policy)

	var keylog *lineAccumulator
	if rec != nil {
		keylog = newLineAccumulator(func(line string) { rec.Command(line) })
	}

	// Operator keystrokes: real console -> ConPTY input pipe. Left running
	// after the child exits (see below) rather than torn down explicitly —
	// there is no clean way to unblock a pending console Read, and it's
	// harmless: the process exits shortly after this function returns
	// either way, which reclaims it.
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, rerr := consoleIn.Read(buf)
			if n > 0 {
				// Recorded before the guard runs, deliberately: the recording
				// is evidence of what the operator did, which includes the
				// paste they attempted and the command that was refused. A
				// recording that only showed permitted input would hide
				// exactly the events an investigator came for.
				if rec != nil {
					rec.Input(buf[:n])
				}
				if keylog != nil {
					keylog.Feed(buf[:n])
				}

				act := guard.OnInput(buf[:n])
				if act.Notice != "" {
					// Written to the operator's console, not into the ConPTY:
					// this is PAM speaking, not the tool, and injecting it into
					// the child's input would feed it to psql as a command.
					_, _ = consoleOut.WriteString(act.Notice)
					if rec != nil {
						rec.Output([]byte(act.Notice))
					}
				}
				if len(act.Forward) > 0 {
					if _, werr := pty.InPipe.Write(act.Forward); werr != nil {
						return
					}
				}
			}
			if rerr != nil {
				return
			}
		}
	}()

	// Child output: ConPTY output pipe -> real console. This is the
	// goroutine spawnCLIWithConPTY actually waits on before returning (via
	// wg below), so trailing output isn't lost once the child exits and
	// pty.Close() unblocks its final Read with EOF.
	var win32Input win32InputModeSuppressor
	var echoFilter win32EchoFilter
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, rerr := pty.OutPipe.Read(buf)
			if n > 0 {
				// The recording gets the full stream even past the cap. The
				// budget exists to stop data reaching the OPERATOR; truncating
				// the evidence as well would punish the investigation for the
				// operator's behaviour.
				if rec != nil {
					if clean := echoFilter.filter(buf[:n]); len(clean) > 0 {
						rec.Output(clean)
					}
				}

				visible, capped, notice := guard.OnOutput(buf[:n])
				if len(visible) > 0 {
					_, _ = consoleOut.Write(win32Input.scan(visible, pty.InPipe))
				}
				if capped {
					if notice != "" {
						_, _ = consoleOut.WriteString(notice)
						if rec != nil {
							rec.Output([]byte(notice))
						}
					}
					// Ending the session is the point of the cap: leaving the
					// child running with its output suppressed would let it
					// keep pulling data it could still write to a file.
					debugf("output budget exhausted; closing the session")
					pty.Close()
					return
				}
			}
			if rerr != nil {
				return
			}
		}
	}()

	// Taken after the relays finish, below — declared here so every return
	// path carries whatever had been enforced by the time it was reached.
	debugf("waiting for process exit")
	waitErr := waitForProcessExit(processHandle)
	debugf("wait returned err=%v", waitErr)
	exitCode, _ := getExitCode(processHandle)

	// Read only now: both relay goroutines have finished, so the input-side and
	// output-side counters are stable and no lock is needed to combine them.
	enforcement = guard.Summary()
	debugf("exitCode=%d", exitCode)

	// conhost renders/flushes ConPTY output on its own cycle, not
	// synchronously with the child process's own exit — closing the pseudo
	// console the instant WaitForSingleObject returns can race ahead of
	// that flush and truncate whatever the child printed right before
	// exiting (confirmed while testing this file: a plain `echo` had its
	// own output dropped, with only conhost's initial VT mode-set sequences
	// making it through). This grace period is the documented workaround —
	// give conhost a moment to push its remaining buffered output through
	// the pipe before ClosePseudoConsole severs it.
	time.Sleep(250 * time.Millisecond)

	// Closing the pseudo console signals conhost to close its end of the
	// output pipe, which is what actually unblocks the output-relay
	// goroutine's Read() with EOF — without this, that goroutine (and this
	// function) would block forever after the child has already exited.
	pty.Close()
	debugf("pty closed")

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
		debugf("relay goroutines drained")
	case <-time.After(2 * time.Second):
		debugf("relay drain timed out")
		// Best-effort drain timeout — if conhost is unusually slow to tear
		// down, don't hang the whole launch indefinitely over it.
	}

	fmt.Fprintf(consoleOut, "\r\n*** %s exited (code %d) ***\r\n", pc.Exec, exitCode)

	if waitErr != nil {
		return true, enforcement, waitErr
	}
	if exitCode != 0 {
		return true, enforcement, fmt.Errorf("%s exited with code %d", pc.Exec, exitCode)
	}
	return true, enforcement, nil
}

func waitForProcessExit(h syscall.Handle) error {
	_, err := syscall.WaitForSingleObject(h, syscall.INFINITE)
	return err
}

func getExitCode(h syscall.Handle) (uint32, error) {
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return 0, err
	}
	return code, nil
}

func debugf(format string, a ...interface{}) {
	if os.Getenv("PAM_AGENT_CONPTY_DEBUG") != "" {
		fmt.Fprintf(os.Stderr, "[conpty-debug] "+format+"\n", a...)
	}
}

// mergeEnv overlays overrides onto base, replacing any variable that already
// exists rather than appending a second copy of it.
//
// WHY THIS IS NOT `append(base, overrides...)`, WHICH IS WHAT IT USED TO BE.
// Two Windows-specific rules make the naive append wrong, and both bit the
// MinIO shell candidate at once:
//
//   - The environment block handed to CreateProcessW (see buildEnvBlock) is
//     written out verbatim, and Windows requires the names in it to be
//     unique. With a duplicate the child's lookup is not defined to pick
//     either one, and in practice it takes the FIRST — which, with base
//     first, is the value the override was trying to replace. Go's own
//     exec.Cmd de-duplicates for the GUI path a few lines up, so only this
//     ConPTY path was exposed.
//
//   - Windows variable names are case-insensitive. os.Environ() reports the
//     real registry casing, "Path", while code setting an override naturally
//     writes "PATH" — so even a de-duplicating consumer would treat them as
//     two different variables. The comparison here is therefore folded.
//
// Confirmed live: the MinIO candidate prepends mc's own directory to PATH so
// the shell it opens can resolve `mc`, and with the plain append that
// override never reached the session at all.
func mergeEnv(base, overrides []string) []string {
	if len(overrides) == 0 {
		return base
	}

	// Index of fold-cased name to position in out, so a later override
	// replaces an earlier value in place instead of adding a second entry.
	pos := make(map[string]int, len(base)+len(overrides))
	out := make([]string, 0, len(base)+len(overrides))

	put := func(entry string) {
		eq := strings.IndexByte(entry, '=')
		if eq <= 0 {
			// No name, or a leading '=' (Windows' hidden per-drive cwd
			// entries like "=C:=C:\dir"). Nothing to key on, so carry it
			// through untouched rather than dropping it.
			out = append(out, entry)
			return
		}
		key := strings.ToUpper(entry[:eq])
		if i, seen := pos[key]; seen {
			out[i] = entry
			return
		}
		pos[key] = len(out)
		out = append(out, entry)
	}

	for _, e := range base {
		put(e)
	}
	for _, e := range overrides {
		put(e)
	}
	return out
}
