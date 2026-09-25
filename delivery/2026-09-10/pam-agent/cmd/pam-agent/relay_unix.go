//go:build darwin || linux

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/yourorg/pam-agent/internal/apiclient"
	"github.com/yourorg/pam-agent/internal/keystore"
	"github.com/yourorg/pam-agent/internal/launcher"
	"github.com/yourorg/pam-agent/internal/recorder"
)

// cmdRelay is the macOS/Linux equivalent of what Windows does inside a single
// process: own the terminal the tool runs in, so the session can be recorded,
// guarded, and closed out exactly when it ends.
//
// It exists as a separate invocation because `launch` has no terminal — the
// desktop starts it from a pam-agent:// URL. `launch` asks a terminal emulator
// for a window and has it run this command; this process inherits that
// window's tty and relays between it and a pseudo-terminal holding the tool.
// See internal/launcher/relay_unix.go for the full reasoning.
//
// Everything after the tool exits happens here rather than in `launch`,
// because `launch` is already gone by then: the recording upload and the
// session-end report both belong to the process that actually watched the
// session.
func cmdRelay(args []string) error {
	fs := flag.NewFlagSet("relay", flag.ContinueOnError)
	sessionID := fs.String("session", "", "PAM session id (required)")
	server := fs.String("server", "", "PAM server base URL (required)")
	policyJSON := fs.String("policy", "", "data-protection policy as JSON")
	record := fs.Bool("record", false, "capture and upload a session recording")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) == 0 {
		return fmt.Errorf("relay needs a command to run: pam-agent relay [flags] -- <tool> [args…]")
	}
	if *sessionID == "" || *server == "" {
		return fmt.Errorf("--session and --server are both required")
	}

	var policy launcher.Policy
	if *policyJSON != "" {
		if err := json.Unmarshal([]byte(*policyJSON), &policy); err != nil {
			// A policy that cannot be parsed must not silently become "no
			// restrictions": that would turn a configuration typo into an
			// unprotected session. Refusing is the safe direction.
			return fmt.Errorf("unreadable data-protection policy: %w", err)
		}
	}

	var cast *recorder.Cast
	if *record {
		cast = recorder.NewCast(120, 30, fmt.Sprintf("PAM native session — %s", rest[0]))
	}

	result, runErr := launcher.RunRelay(launcher.RelayOptions{
		Exec:   rest[0],
		Args:   rest[1:],
		Env:    nil, // already exported by the wrapper this runs inside
		Policy: policy,
		Rec:    cast,
	})
	if runErr != nil {
		log.Error("relay.run.fail", "error", runErr.Error())

		// The operator is looking at a terminal window that is about to close.
		//
		// This process IS the window's foreground command, so returning an
		// error here makes the window disappear — and the operator reports
		// "the agent did not open anything", with the reason gone with it.
		// A relay that cannot start is precisely when the reason matters most,
		// so print it and hold the window open until they have read it.
		fmt.Fprintf(os.Stderr, "\n*** PAM could not open %s ***\n\n%v\n\n", rest[0], runErr)
		fmt.Fprint(os.Stderr, "The session has been reported as failed. Press Enter to close... ")
		_, _ = fmt.Fscanln(os.Stdin)
	}

	// Best-effort from here on. The operator's work is finished; a failure to
	// report it must not look like their session went wrong, and must not
	// change the exit status they see.
	identity, idErr := keystore.Load(*server)
	if idErr != nil {
		log.Warn("relay.identity.fail", "server", *server, "error", idErr.Error())
		return exitWith(result.ExitCode, runErr)
	}
	client := apiclient.New(*server)

	// Session end BEFORE the recording upload, matching the ordering the
	// Windows launch and the browser gateway both use: EndLaunch stamps the
	// recording's ended_at while it is still PENDING/RECORDING, and the upload
	// is what marks it COMPLETED. Reversed, ended_at stays NULL forever
	// because the row is already COMPLETED by the time the stamp runs.
	status := "COMPLETED"
	var failure *apiclient.LaunchFailure
	switch {
	case runErr != nil:
		// The tool could not be started at all. This is the most useful
		// failure the agent ever has: discovery found the executable moments
		// ago, so runErr names what changed (removed, permissions, a broken
		// interpreter line). It reached only the terminal window before, which
		// the operator closes as soon as they read it, if they read it.
		status, failure = "FAILED", describeLaunchFailure(runErr)
	case result.ExitCode != 0:
		status, failure = "FAILED", reportEndFailure(result.ExitCode)
	}
	if endErr := client.EndLaunch(*sessionID, identity.AgentDeviceID, status,
		identity.PrivateKey(), result.Enforcement, failure); endErr != nil {
		log.Warn("relay.session_end.fail", "session_id", *sessionID, "error", endErr.Error())
	} else {
		log.Info("relay.session_end.ok", "session_id", *sessionID, "status", status)
	}

	if cast != nil {
		uploadStatus := "COMPLETED"
		failureReason := ""
		var gz []byte
		if gzBytes, encErr := cast.Finalize(); encErr != nil {
			uploadStatus, failureReason = "FAILED", "failed to encode local recording: "+encErr.Error()
			log.Error("relay.recording.finalize.fail", "session_id", *sessionID, "error", encErr.Error())
		} else {
			gz = gzBytes
		}
		commands := cast.Commands()
		if upErr := client.UploadRecording(*sessionID, identity.AgentDeviceID, identity.PrivateKey(),
			gz, uploadStatus, failureReason, commands); upErr != nil {
			log.Warn("relay.recording.upload.fail", "session_id", *sessionID, "error", upErr.Error())
		} else {
			log.Info("relay.recording.upload.ok", "session_id", *sessionID,
				"status", uploadStatus, "commands_captured", len(commands))
		}
	}

	return exitWith(result.ExitCode, runErr)
}

// exitWith propagates the tool's own status to whoever launched the terminal,
// so a failed psql still reads as a failure.
func exitWith(code int, runErr error) error {
	if runErr != nil {
		return runErr
	}
	if code != 0 {
		os.Exit(code)
	}
	return nil
}
