// pam-agent is the local companion to the PAM web application. It has five
// jobs, one per subcommand:
//
//	pam-agent install                                  register this OS's pam-agent:// URL handler
//	pam-agent pair   --code XXXX --server <url>        pair this machine to a PAM account (once)
//	pam-agent launch <pam-agent://... URL>              redeem a launch token and open the local tool (invoked by the OS)
//	pam-agent devices                                  list servers this machine has paired against
//	pam-agent uninstall                                 remove the URL handler registration
//
// See the top-of-package comments in internal/keystore, internal/apiclient,
// internal/discovery, and internal/launcher for the security model and
// per-OS caveats — they're deliberately spelled out rather than assumed.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/yourorg/pam-agent/internal/apiclient"
	"github.com/yourorg/pam-agent/internal/keystore"
	"github.com/yourorg/pam-agent/internal/launcher"
	"github.com/yourorg/pam-agent/internal/logging"
	"github.com/yourorg/pam-agent/internal/recorder"
	"github.com/yourorg/pam-agent/internal/register"
)

// log is set up once in main() before any subcommand runs, so every
// command below can log without threading a logger through every function
// signature. See internal/logging for why this is stdlib-only (log/slog).
var log *slog.Logger

func main() {
	configDir, configDirErr := agentConfigDir()

	var closeLog func()
	if configDirErr == nil {
		log, closeLog = logging.New(configDir, logging.LevelFromString(os.Getenv("PAM_AGENT_LOG_LEVEL")))
	} else {
		// Can't even determine the config dir — fall back to a stderr-only
		// logger rather than letting a nil *slog.Logger panic every call
		// site below.
		log, closeLog = logging.New(os.TempDir(), logging.LevelFromString(os.Getenv("PAM_AGENT_LOG_LEVEL")))
	}
	defer closeLog()

	log.Debug("pam-agent.start", "args", os.Args, "os", runtime.GOOS)

	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	var err error
	switch os.Args[1] {
	case "install":
		err = cmdInstall(os.Args[2:])
	case "uninstall":
		err = cmdUninstall(os.Args[2:])
	case "pair":
		err = cmdPair(os.Args[2:])
	case "launch":
		err = cmdLaunch(os.Args[2:], configDir, configDirErr)
	case "report-end":
		err = cmdReportEnd(os.Args[2:])
	case "relay":
		// Unix only: on Windows the relay is inside `launch` itself, because
		// that process can allocate its own console.
		err = cmdRelayDispatch(os.Args[2:])
	case "devices":
		err = cmdDevices(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Printf("pam-agent %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return
	case "-h", "--help", "help":
		printUsage()
		return
	default:
		fmt.Fprintf(os.Stderr, "pam-agent: unknown command %q\n\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}

	if err != nil {
		log.Error("pam-agent.command.fail", "command", os.Args[1], "error", err.Error())
		fmt.Fprintf(os.Stderr, "pam-agent: %v\n", err)
		os.Exit(1)
	}
	log.Debug("pam-agent.command.ok", "command", os.Args[1])
}

// agentConfigDir returns <OS per-user config dir>/pam-agent, creating it if
// necessary. Shared by logging setup (needs it before any subcommand
// parsing) and cmdLaunch (needs it for launch-templates.json).
func agentConfigDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("could not determine config directory: %w", err)
	}
	dir := filepath.Join(base, "pam-agent")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("could not create config directory: %w", err)
	}
	return dir, nil
}

// version is stamped at build time by install/build-release.sh via
// -ldflags "-X main.version=...". It has to be declared here for that to do
// anything: the linker silently ignores -X for a symbol that does not
// exist, which is what was happening — every release carried a version
// string that went nowhere, and there was no way for an operator to tell
// which agent build a machine was actually running. That question came up
// on every single support round, and answering it meant hashing binaries by
// hand. Now the log answers it.
var version = "dev"

func printUsage() {
	fmt.Fprint(os.Stderr, `pam-agent — local companion for the PAM web application

Usage:
  pam-agent install                             register this OS's pam-agent:// URL handler
  pam-agent pair --code XXXX --server <url>     pair this machine to a PAM account (run once)
  pam-agent launch <pam-agent://... URL>        redeem a launch token (normally invoked by the OS, not by hand)
  pam-agent devices                             list servers this machine has paired against
  pam-agent version                             print this agent's build version
  pam-agent uninstall                           remove the URL handler registration

Environment:
  PAM_AGENT_LOG_LEVEL   debug | info | warn | error (default info) — see the
                        per-user config dir's logs/agent.log for full history,
                        including what pam-agent did when the OS launched it
                        with no visible terminal at all.
`)
}

// ── install / uninstall ─────────────────────────────────────────────────

func cmdInstall(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.Parse(args)

	execPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not determine this binary's own path: %w", err)
	}
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		return fmt.Errorf("could not resolve this binary's real path: %w", err)
	}

	if err := register.Register(execPath); err != nil {
		log.Error("install.register.fail", "error", err.Error())
		return fmt.Errorf("failed to register pam-agent:// URL handler: %w", err)
	}

	log.Info("install.ok", "exec_path", execPath, "os", runtime.GOOS, "agent_version", version)
	fmt.Printf("Registered pam-agent:// URL handler for %s (%s).\n", execPath, runtime.GOOS)
	fmt.Println("Next: pam-agent pair --code <code from the PAM web app> --server <your PAM server URL>")
	return nil
}

func cmdUninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	fs.Parse(args)

	if err := register.Unregister(); err != nil {
		log.Error("uninstall.fail", "error", err.Error())
		return fmt.Errorf("failed to remove pam-agent:// URL handler: %w", err)
	}
	log.Info("uninstall.ok")
	fmt.Println("Removed pam-agent:// URL handler registration.")
	return nil
}

// ── pair ─────────────────────────────────────────────────────────────────

// cmdReportEnd closes out a session on behalf of the wrapper script that a
// macOS or Linux launch runs inside the operator's terminal.
//
// WHY THIS EXISTS AS A SEPARATE INVOCATION. On those platforms the agent
// process that started the launch is long gone by the time the operator closes
// the terminal — osascript and most Linux emulators return immediately (see
// internal/launcher/wrapper.go). The wrapper is the only thing still alive
// that knows the session finished, and it is a shell script, so the only way
// it can speak to PAM is by invoking the agent again.
//
// Deliberately quiet and forgiving. This runs as the last line of somebody's
// terminal session: it must not print over whatever the tool left on screen,
// and a failure to reach PAM must not look like the operator did something
// wrong. The wrapper already discards output and ignores the exit status; the
// worst case is that the session ages out on PAM's schedule instead of closing
// promptly, which is exactly the behaviour that existed before the wrapper.
func cmdReportEnd(args []string) error {
	fs := flag.NewFlagSet("report-end", flag.ContinueOnError)
	sessionID := fs.String("session", "", "PAM session id to close (required)")
	server := fs.String("server", "", "PAM server base URL (required)")
	exitCode := fs.Int("exit", 0, "exit status of the tool that just finished")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *sessionID == "" || *server == "" {
		return fmt.Errorf("--session and --server are both required")
	}

	identity, err := keystore.Load(*server)
	if err != nil {
		log.Warn("report_end.identity.fail", "server", *server, "error", err.Error())
		return err
	}

	// COMPLETED whatever the tool returned. The wrapper only runs at all
	// because the tool STARTED, so by the time this is reached the session
	// happened: the operator had their terminal and the recording is the
	// evidence of what they did in it.
	//
	// This used to file any non-zero status as FAILED, which is wrong for the
	// ordinary case rather than an edge one. psql, sqlplus, mongosh and
	// redis-cli all return non-zero when the operator closes the window or
	// quits after an error, so on a real deployment every working session was
	// recorded as a failure. The exit status still travels, as context on the
	// session (see reportEndFailure), so "psql ended on an error" is still
	// visible to an auditor without the session being called a failed launch.
	status := "COMPLETED"

	log.Info("report_end.start", "session_id", *sessionID, "status", status)
	client := apiclient.New(*server)
	// No enforcement summary: these platforms hand off to an external terminal
	// and the agent is not in the data path, so there is nothing it could have
	// enforced. Reporting nil says "unenforced" rather than "no violations".
	if err := client.EndLaunch(*sessionID, identity.AgentDeviceID, status, identity.PrivateKey(), nil, reportEndFailure(*exitCode)); err != nil {
		log.Warn("report_end.fail", "session_id", *sessionID, "error", err.Error())
		return err
	}
	log.Info("report_end.ok", "session_id", *sessionID, "status", status)
	return nil
}

func cmdPair(args []string) error {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	code := fs.String("code", "", "pairing code shown in the PAM web app (required)")
	server := fs.String("server", "", "PAM server base URL, e.g. https://pam.company.com (required)")
	name := fs.String("name", "", "friendly name for this device (defaults to hostname)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *code == "" || *server == "" {
		return fmt.Errorf("--code and --server are both required")
	}

	deviceName := *name
	if deviceName == "" {
		host, _ := os.Hostname()
		if host == "" {
			host = "unknown-host"
		}
		deviceName = fmt.Sprintf("%s (%s)", host, runtime.GOOS)
	}

	log.Info("pair.start", "server", *server, "device_name", deviceName)

	identity, err := keystore.Generate(*server)
	if err != nil {
		log.Error("pair.keygen.fail", "error", err.Error())
		return err
	}

	client := apiclient.New(*server)
	result, err := client.PairComplete(*code, deviceName, identity.PublicKeyB64)
	if err != nil {
		log.Error("pair.complete.fail", "server", *server, "error", err.Error())
		return fmt.Errorf("pairing failed: %w", err)
	}

	identity.AgentDeviceID = result.AgentDeviceID
	if err := keystore.Save(identity); err != nil {
		log.Error("pair.save_identity.fail", "error", err.Error())
		return fmt.Errorf("paired successfully but failed to save the device identity locally: %w", err)
	}

	log.Info("pair.ok", "server", *server, "agent_device_id", result.AgentDeviceID)
	fmt.Printf("Paired as %q against %s (agent_device_id=%s).\n", deviceName, *server, result.AgentDeviceID)
	fmt.Println("You can now click \"Open in Desktop App\" for any resource you're authorized to connect to.")
	return nil
}

// ── launch ───────────────────────────────────────────────────────────────

func cmdLaunch(args []string, configDir string, configDirErr error) error {
	fs := flag.NewFlagSet("launch", flag.ContinueOnError)
	tokenFlag := fs.String("token", "", "launch token (alternative to passing a pam-agent:// URL positionally)")
	serverFlag := fs.String("server", "", "PAM server base URL (alternative to passing a pam-agent:// URL positionally)")

	var token, server string
	// The OS invokes this as `pam-agent launch "pam-agent://launch?token=...&server=..."`
	// — a single positional URL argument. Support --token/--server directly
	// too, for manual testing without going through a browser.
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		u, err := url.Parse(args[0])
		if err != nil {
			return fmt.Errorf("could not parse launch URL: %w", err)
		}
		token = u.Query().Get("token")
		server = u.Query().Get("server")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
	} else {
		if err := fs.Parse(args); err != nil {
			return err
		}
		token = *tokenFlag
		server = *serverFlag
	}

	if token == "" || server == "" {
		return fmt.Errorf("could not determine token/server — pass a pam-agent:// URL or use --token/--server")
	}
	if configDirErr != nil {
		return configDirErr
	}

	log.Info("launch.start", "server", server, "agent_version", version)

	identity, err := keystore.Load(server)
	if err != nil {
		log.Error("launch.identity_load.fail", "server", server, "error", err.Error())
		return err
	}

	client := apiclient.New(server)
	resolved, err := client.ResolveLaunch(token, identity.AgentDeviceID, identity.PrivateKey())
	if err != nil {
		log.Error("launch.resolve.fail", "server", server, "error", err.Error())
		return fmt.Errorf("could not redeem launch token: %w", err)
	}
	log.Info("launch.resolved", "session_id", resolved.SessionID, "resource_type", resolved.ResourceType, "host", resolved.Host)

	templates, err := launcher.LoadTemplates(configDir)
	if err != nil {
		log.Error("launch.templates_load.fail", "error", err.Error())
		return err
	}
	candidates, ok := templates[resolved.ResourceType]
	if !ok || len(candidates) == 0 {
		return fmt.Errorf("no launch candidates configured for resource type %q — add one to %s",
			resolved.ResourceType, filepath.Join(configDir, "launch-templates.json"))
	}

	sessionTempDir := filepath.Join(os.TempDir(), "pam-agent-"+resolved.SessionID)
	if err := os.MkdirAll(sessionTempDir, 0o700); err != nil {
		return fmt.Errorf("could not create session temp directory: %w", err)
	}

	// The recording obligation is part of CHOOSING, not a check applied to
	// whatever was chosen. On a resource that must be recorded, a candidate
	// this machine cannot record is passed over and the next one is tried;
	// see launcher.SelectAndBuildRecordable for why that has to happen inside
	// the walk. canRecordMode is the same rule recordingObligationUnmet
	// applies below, so the two can never disagree about what is recordable.
	var canRecordMode func(string) bool
	if resolved.RecordingRequired {
		canRecordMode = modeIsRecordable
	}
	preparedCmd, chosen, err := launcher.SelectAndBuildRecordable(resolved, candidates, sessionTempDir, log, canRecordMode)

	// Every usable candidate was passed over for the reason above. The report
	// names the FIRST one, which is both the tool the operator would have got
	// and the highest-priority thing they can make work.
	if errors.Is(err, launcher.ErrNoRecordableCandidate) && chosen != nil {
		mode := chosen.Kind
		log.Error("launch.recording.impossible",
			"session_id", resolved.SessionID, "resource_type", resolved.ResourceType,
			"candidate", chosen.ID, "mode", mode)
		err = &unrecordableLaunchError{
			ResourceType:    resolved.ResourceType,
			CandidateID:     chosen.ID,
			Mode:            mode,
			RecorderMissing: mode == "gui",
		}
	}
	if preparedCmd != nil {
		// The policy is the server's decision, carried through untouched. The
		// agent enforces it where it can (the Windows ConPTY relay) and reports
		// honestly where it cannot.
		// What the wrapper needs to report this session's end on macOS and
		// Linux. os.Executable() rather than os.Args[0]: the wrapper runs from
		// the terminal's working directory, where a relative path would not
		// resolve.
		if exe, exeErr := os.Executable(); exeErr == nil {
			preparedCmd.AgentPath = exe
		}
		preparedCmd.SessionID = resolved.SessionID
		preparedCmd.ServerURL = server

		preparedCmd.Policy = launcher.Policy{
			BlockClipboard: resolved.DataProtection.BlockClipboard,
			MaxEgressBytes: resolved.DataProtection.MaxEgressBytes,
			DeniedCommands: resolved.DataProtection.DeniedCommands,
		}

		// What the macOS/Linux relay needs, since it runs as a separate process
		// in the terminal window and cannot see any of this otherwise. Windows
		// ignores both: `launch` relays in-process there and already holds them.
		preparedCmd.Record = resolved.RecordingRequired && preparedCmd.Mode == "cli"

		if policyBytes, mErr := json.Marshal(preparedCmd.Policy); mErr == nil {
			preparedCmd.PolicyJSON = string(policyBytes)
		} else {
			// Refuse to launch rather than hand the relay a session with no
			// policy: a marshalling failure must not quietly become "no
			// restrictions" on a resource an admin restricted.
			log.Error("launch.policy.marshal.fail", "session_id", resolved.SessionID, "error", mErr.Error())
			err = fmt.Errorf("could not prepare data-protection policy for this session: %w", mErr)
		}

		// A recording obligation this launch cannot meet is a refusal, not a
		// footnote. See unrecordableLaunchError: the agent records by owning
		// the pseudo-terminal the tool runs in, and a desktop app or a browser
		// tab has no terminal to own — so "recording required" plus a non-cli
		// candidate previously meant the session opened with Record quietly
		// set to false just above. PAM was then left holding a session whose
		// policy said recorded and whose evidence would never arrive.
		if err == nil && recordingObligationUnmet(resolved.RecordingRequired, preparedCmd) {
			log.Error("launch.recording.impossible",
				"session_id", resolved.SessionID, "resource_type", resolved.ResourceType,
				"candidate", chosen.ID, "mode", preparedCmd.Mode)
			err = &unrecordableLaunchError{
				ResourceType:    resolved.ResourceType,
				CandidateID:     chosen.ID,
				Mode:            preparedCmd.Mode,
				RecorderMissing: preparedCmd.Mode == "gui",
			}
		}

		// The credential handoff, for the candidates that have no other one.
		//
		// CopyPasswordToClipboard is set only where the clipboard IS the whole
		// handoff: SQL Developer, and the MinIO, MongoDB and Oracle web
		// consoles. No env var, no login script and no argument carries the
		// password for those, so a failed copy means the app opens at a login
		// prompt the operator cannot get past.
		//
		// This used to warn and open the app anyway. The warning went to
		// stderr, and the OS starts `pam-agent launch` from a URL handler with
		// no terminal attached, so it went nowhere: the operator got a window,
		// no password and no explanation. Seen on a machine with none of
		// xclip, xsel or wl-copy, which is an ordinary state for a minimal or
		// Wayland-only desktop.
		//
		// It lives HERE, inside the block that assigns err, rather than just
		// before the spawn where it used to. That is not tidiness: everything
		// after this block goes through the one handler below that reports the
		// session as FAILED and ends it. Returning from further down would
		// leave the ACTIVE row PAM opened at resolve time stuck for an admin
		// to clear by hand, which is the bug the comment in that handler
		// describes. Ordered after the recording check so a launch that is
		// about to be refused does not put a password on the clipboard first.
		if err == nil && preparedCmd.CopyPasswordToClipboard {
			if clipErr := launcher.CopyToClipboard(resolved.Password); clipErr != nil {
				log.Error("launch.clipboard_copy.fail", "resource_type", resolved.ResourceType,
					"candidate", chosen.ID, "error", clipErr.Error())
				err = &clipboardHandoffError{CandidateID: chosen.ID, Err: clipErr}
			} else {
				log.Info("launch.clipboard_copy.ok", "resource_type", resolved.ResourceType)
				fmt.Println("Password copied to clipboard. Paste it into the login prompt.")
			}
		}
	}
	if err != nil {
		log.Error("launch.candidate_selection.fail", "resource_type", resolved.ResourceType, "error", err.Error())
		os.RemoveAll(sessionTempDir)
		// BUGFIX: this used to return here without ever calling EndLaunch.
		// By this point ResolveLaunch has already succeeded, which means
		// StartTrackedSession already created a live ACTIVE row on the PAM
		// server (see AgentService.ResolveLaunchToken) — no local process was
		// ever spawned to fail, so nothing else was ever going to report this
		// session as anything but ACTIVE. Confirmed live: a MinIO resource
		// with no console_url configured (before mc-shell existed as a
		// non-browser fallback) left one stuck ACTIVE session per failed
		// launch attempt, each one invisible to the operator and needing an
		// admin to kill it by hand. Best-effort — a failure to report the
		// failure itself is logged, not returned, since the original
		// candidate-selection error is what the operator actually needs to see.
		if endErr := client.EndLaunch(resolved.SessionID, identity.AgentDeviceID, "FAILED", identity.PrivateKey(), nil,
			describeLaunchFailure(err)); endErr != nil {
			log.Warn("launch.session_end_report.fail", "session_id", resolved.SessionID, "error", endErr.Error())
		}
		return err
	}

	if preparedCmd.Mode == "browser" {
		fmt.Printf("Opening %s in your default browser...\n", resolved.ResourceType)
		openErr := launcher.OpenBrowser(preparedCmd.Exec)
		os.RemoveAll(sessionTempDir)
		if openErr != nil {
			log.Error("launch.browser_open.fail", "url_host_only", resolved.Host, "error", openErr.Error())
			fmt.Fprintf(os.Stderr, "warning: failed to open browser: %v\n", openErr)
		}
		fmt.Println("Note: browser-based sessions can't be tracked for automatic session-end — " +
			"this session will show as ACTIVE in PAM until an admin ends it.")
		return openErr
	}

	if preparedCmd.PreseedLoadServersPath != "" {
		if err := launcher.RunPgAdminPreseed(preparedCmd.Exec, preparedCmd.AppBundle, preparedCmd.PreseedLoadServersPath); err != nil {
			// Best-effort by design — see RunPgAdminPreseed. Log and carry
			// on to the normal launch; the operator just won't see the
			// connection pre-filled.
			log.Warn("launch.pgadmin_preseed.fail", "candidate", chosen.ID, "error", err.Error())
		} else {
			log.Info("launch.pgadmin_preseed.ok", "candidate", chosen.ID)
		}
	}

	// Only create a recording obligation's local half when the server says
	// this session actually needs one — see AgentService.ResolveLaunchToken.
	// Capture is currently only wired up for "cli" launches on Windows (see
	// spawn_windows.go); rec is passed through as nil everywhere else, and
	// every Spawn implementation already treats a nil rec as "don't record."
	var rec *recorder.Cast
	if preparedCmd.Record {
		rec = recorder.NewCast(120, 30, fmt.Sprintf("PAM %s session — %s@%s", resolved.ResourceType, resolved.AccountName, resolved.Host))
	}

	// A recorded DESKTOP session is captured as video, because a desktop
	// application has no terminal for the relay to own. Started just before
	// the application so the recording covers the whole of it, including the
	// moments before its window appears, which is where a login prompt or an
	// error dialog would be.
	//
	// recordingObligationUnmet already refused this launch above if ffmpeg is
	// not installed, so reaching here with RecordingRequired and Mode "gui"
	// means a recorder is available.
	var screen *recorder.Screen
	if resolved.RecordingRequired && preparedCmd.Mode == "gui" {
		s, screenErr := recorder.StartScreen(sessionTempDir, recorder.ScreenOptions{})
		if screenErr != nil {
			// Refuse rather than open unrecorded. The check above said this
			// machine could record; if it turns out it cannot, the session
			// must not proceed as though nobody had asked for a recording.
			log.Error("launch.screen_recording.start.fail",
				"session_id", resolved.SessionID, "error", screenErr.Error())
			cleanupErr := screenErr
			launcher.RemoveFiles(preparedCmd.CleanupFiles)
			os.RemoveAll(sessionTempDir)
			if endErr := client.EndLaunch(resolved.SessionID, identity.AgentDeviceID, "FAILED",
				identity.PrivateKey(), nil, describeLaunchFailure(cleanupErr)); endErr != nil {
				log.Warn("launch.session_end_report.fail", "session_id", resolved.SessionID, "error", endErr.Error())
			}
			return cleanupErr
		}
		screen = s
		log.Info("launch.screen_recording.start.ok", "session_id", resolved.SessionID, "candidate", chosen.ID)
		fmt.Println("This desktop session is being recorded.")
	}

	fmt.Printf("Opening %s via %s (%s:%d)...\n", resolved.ResourceType, chosen.ID, resolved.Host, resolved.Port)

	// A "gui" launch now blocks for the whole session, so that a desktop
	// application being closed is what ends it (see the per-OS
	// spawnGUIAndWait). The credential files it was handed must NOT live that
	// long: they are read during the application's first seconds and are a
	// plaintext credential on disk for every second after that. So the
	// deletion keeps the timing it always had — a few seconds after the tool
	// starts — and is moved off this goroutine rather than moved later.
	//
	// Safe to snapshot the slice here: the wrapper script that appends to
	// CleanupFiles is written only on the "cli" path.
	cleanupOnce := &sync.Once{}
	cleanup := func() {
		cleanupOnce.Do(func() {
			launcher.RemoveFiles(preparedCmd.CleanupFiles)
			// The session temp directory is ALSO where a screen recording is
			// being written, so it can only be removed once that recording
			// has been read back. The recorded path defers the whole removal
			// to the end; the unrecorded one keeps the old timing.
			if screen == nil {
				os.RemoveAll(sessionTempDir)
			}
		})
	}
	if preparedCmd.Mode == "gui" {
		go func() {
			time.Sleep(5 * time.Second)
			cleanup()
		}()
	}

	waited, enforcement, spawnErr := launcher.Spawn(preparedCmd, rec)

	if !waited {
		// Give the newly-launched process a few seconds to open/read any
		// temp credential files before we remove them — see the per-OS
		// spawn implementations for why this can't be made exact everywhere.
		time.Sleep(5 * time.Second)
	}
	cleanup()

	// A TOOL THAT RAN AND EXITED IS NOT A FAILED LAUNCH.
	//
	// toolExit is the status an interactive client returned when it finished.
	// It is separated from spawnErr here because everything below keys off
	// "did this launch fail", and a non-zero exit is not that: sqlplus and
	// psql return 1 when the operator closes the window, and on Windows
	// closing a console window produces a non-zero status by definition. See
	// launcher.ToolExitError for the log that proved it.
	toolExitCode, toolRanAndExited := launcher.ExitCodeOf(spawnErr)
	if toolRanAndExited {
		spawnErr = nil
	}

	switch {
	case spawnErr != nil:
		log.Error("launch.spawn.fail", "candidate", chosen.ID, "exec", preparedCmd.Exec, "error", spawnErr.Error())
		fmt.Fprintf(os.Stderr, "warning: failed to launch %s: %v\n", preparedCmd.Exec, spawnErr)
	case toolRanAndExited:
		log.Info("launch.tool.exited", "candidate", chosen.ID, "exec", preparedCmd.Exec, "exit_code", toolExitCode)
	default:
		log.Info("launch.spawn.ok", "candidate", chosen.ID, "waited", waited)
	}

	// EndLaunch (session-end, stamps ended_at) is deliberately reported
	// BEFORE UploadRecording (artifact-attach, stamps status=COMPLETED) —
	// matching the browser session gateway's own ordering (EndTrackedSession
	// always runs before finalizeRecording there; see gateway.go's Connect).
	// closeRecordingTx (called via EndTrackedSession) only ever stamps
	// ended_at on a recording still PENDING/RECORDING — reversing this
	// order left ended_at permanently NULL on every agent-captured
	// recording, since by the time it ran the row was already COMPLETED.
	switch {
	case spawnErr != nil:
		// A launch that never started has nothing left to report it. This
		// case used to fall into the EndReportedByWrapper branch below and
		// print "this session will close automatically when you exit the
		// tool" while no tool, and no wrapper, existed anywhere: the wrapper
		// script is written (setting that flag) BEFORE the terminal emulator
		// is looked for, so a machine with no emulator installed produced a
		// promise nothing could keep. PAM held an ACTIVE session forever and
		// was never told why. Observed running the real agent on a host with
		// no terminal emulator, which is also every server and container.
		//
		// So the spawn failure is checked first, unconditionally: whatever
		// was supposed to report this session, it is not running.
		if endErr := client.EndLaunch(resolved.SessionID, identity.AgentDeviceID, "FAILED",
			identity.PrivateKey(), enforcement, describeLaunchFailure(spawnErr)); endErr != nil {
			log.Warn("launch.session_end_report.fail", "session_id", resolved.SessionID, "error", endErr.Error())
			fmt.Fprintf(os.Stderr, "warning: failed to report session end to PAM: %v\n", endErr)
		}

	case preparedCmd.EndReportedByWrapper:
		// The wrapper running inside the operator's terminal reports this one
		// when the tool exits. Reporting here as well would close the session
		// the moment the window opened.
		fmt.Println("This session will close automatically when you exit the tool.")

	case waited:
		// A GUI launch, which now blocks for the life of the application (see
		// the per-OS spawnGUIAndWait), or a terminal that genuinely blocks.
		// Either way this process watched the session finish and is the one
		// that knows it is over.
		//
		// COMPLETED even when the tool returned non-zero: it ran, the operator
		// used it, and the recording is the evidence of what happened. The
		// exit status travels as context on the session rather than as a
		// verdict on it, so an auditor can still see that psql ended on an
		// error without the session being filed as a launch that never worked.
		var exitNote *apiclient.LaunchFailure
		if toolRanAndExited {
			exitNote = reportEndFailure(toolExitCode)
		}
		if endErr := client.EndLaunch(resolved.SessionID, identity.AgentDeviceID, "COMPLETED",
			identity.PrivateKey(), enforcement, exitNote); endErr != nil {
			log.Warn("launch.session_end_report.fail", "session_id", resolved.SessionID, "error", endErr.Error())
			fmt.Fprintf(os.Stderr, "warning: failed to report session end to PAM: %v\n", endErr)
		}

	default:
		fmt.Println("Note: this session will show as ACTIVE in PAM until an admin ends it — " +
			"automatic session-end tracking isn't available for this terminal/OS/tool combination (see README).")
	}

	// On macOS and Linux the relay in the operator's terminal owns the capture
	// and uploads it when the tool exits (see internal/launcher/relay_unix.go).
	// Uploading from here too would attach an empty recording — this process
	// never saw a byte of that session — and, being first, it would be the one
	// that marked the row COMPLETED, so the relay's real artifact would arrive
	// to a session already closed out.
	if rec != nil && !preparedCmd.EndReportedByWrapper {
		uploadStatus := "COMPLETED"
		failureReason := ""
		var gz []byte
		if gzBytes, encErr := rec.Finalize(); encErr != nil {
			uploadStatus, failureReason = "FAILED", "failed to encode local recording: "+encErr.Error()
			log.Error("launch.recording.finalize.fail", "session_id", resolved.SessionID, "error", encErr.Error())
		} else {
			gz = gzBytes
		}
		commands := rec.Commands()
		if uploadErr := client.UploadRecording(resolved.SessionID, identity.AgentDeviceID, identity.PrivateKey(), gz, uploadStatus, failureReason, commands); uploadErr != nil {
			log.Warn("launch.recording.upload.fail", "session_id", resolved.SessionID, "error", uploadErr.Error())
			fmt.Fprintf(os.Stderr, "warning: failed to upload session recording to PAM: %v\n", uploadErr)
		} else {
			log.Info("launch.recording.upload.ok", "session_id", resolved.SessionID, "status", uploadStatus, "commands_captured", len(commands))
		}
	}

	// The desktop session's video. Stopped only now, after Spawn has returned,
	// which for a gui launch means the operator has closed the application:
	// the capture therefore covers the whole session and nothing after it.
	//
	// Uploaded AFTER the session-end report above, matching the ordering
	// every other recording path uses: EndLaunch stamps the recording's
	// ended_at while it is still PENDING/RECORDING, and the upload is what
	// marks it COMPLETED. Reversed, ended_at stays NULL because the row is
	// already COMPLETED by the time the stamp runs.
	if screen != nil {
		uploadStatus, failureReason := "COMPLETED", ""
		video, stopErr := screen.Stop()
		if stopErr != nil {
			// The session happened either way, so this is reported as a
			// FAILED recording rather than swallowed: an obligation that was
			// not met has to be visible to an auditor.
			uploadStatus, failureReason = "FAILED", "screen recording failed: "+stopErr.Error()
			log.Error("launch.screen_recording.stop.fail", "session_id", resolved.SessionID, "error", stopErr.Error())
		} else {
			log.Info("launch.screen_recording.stop.ok",
				"session_id", resolved.SessionID, "bytes", len(video), "duration", screen.Duration().Round(time.Second).String())
		}
		// No command list: a desktop application has no keystroke stream the
		// agent can see, and inventing one would be worse than an empty log.
		if uploadErr := client.UploadRecordingArtifact(resolved.SessionID, identity.AgentDeviceID, identity.PrivateKey(),
			video, apiclient.RecordingFormatVideo, screen.Encoding().MediaType, uploadStatus, failureReason, nil); uploadErr != nil {
			log.Warn("launch.screen_recording.upload.fail", "session_id", resolved.SessionID, "error", uploadErr.Error())
			fmt.Fprintf(os.Stderr, "warning: failed to upload the session recording to PAM: %v\n", uploadErr)
		} else {
			log.Info("launch.screen_recording.upload.ok", "session_id", resolved.SessionID, "status", uploadStatus)
		}
		// Only now is the temp directory safe to remove: it held the video.
		launcher.RemoveFiles(preparedCmd.CleanupFiles)
		os.RemoveAll(sessionTempDir)
	}

	// Tells the Windows ConPTY close-handler (see launcher.installCloseHandler)
	// it no longer needs to wait out its grace period — PAM has already
	// been told this session ended. No-op everywhere else, and harmless
	// even on the normal (non-window-close) exit path this always runs.
	launcher.SignalShutdownComplete()

	return spawnErr
}

// ── devices ──────────────────────────────────────────────────────────────

func cmdDevices(args []string) error {
	fs := flag.NewFlagSet("devices", flag.ContinueOnError)
	fs.Parse(args)

	servers, err := keystore.List()
	if err != nil {
		log.Error("devices.list.fail", "error", err.Error())
		return err
	}
	if len(servers) == 0 {
		fmt.Println("This machine hasn't paired with any PAM server yet. Run: pam-agent pair --code <code> --server <url>")
		return nil
	}

	fmt.Println("Paired PAM servers on this machine:")
	for _, s := range servers {
		identity, err := keystore.Load(s)
		if err != nil {
			fmt.Printf("  %s (could not load identity: %v)\n", s, err)
			continue
		}
		fmt.Printf("  %s — agent_device_id=%s\n", s, identity.AgentDeviceID)
	}
	return nil
}
