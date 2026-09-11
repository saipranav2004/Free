// pam-agent/internal/recorder/screen.go
//
// Recording a DESKTOP application session.
//
// WHY THIS EXISTS AND WHY IT IS A DIFFERENT MECHANISM. Everything else the
// agent records is a terminal: the relay owns a pseudo-terminal, every byte
// passes through it, and the result is an asciicast. A desktop application
// has no terminal to own. MongoDB Compass, pgAdmin 4, RedisInsight and SQL
// Developer draw pixels, so the only honest recording of one is pixels.
//
// Until this existed the agent refused such a launch whenever the resource
// required recording, which was correct but not useful: it meant a resource
// marked "always recorded" simply could not be opened in its own desktop
// client. This turns that refusal into a recording.
//
// HOW. ffmpeg captures the screen for exactly as long as the application is
// open, using each platform's own capture device:
//
//	linux    x11grab, reading the X display the application draws on
//	darwin   avfoundation, the framework screen capture goes through
//	windows  gdigrab, capturing the desktop
//
// WHICH CODEC, and why it is chosen at runtime rather than fixed. The console
// replays these in whatever browser an auditor happens to have, so the only
// thing that matters is what decodes everywhere:
//
//	VP9 in WebM   preferred. Royalty-free, so no codec licensing follows the
//	              recorder into a customer's deployment, and decoded by
//	              Chrome, Edge, Firefox and Safari 14.1+. It is also what a
//	              plain open-source Chromium build can play, and H.264 is
//	              NOT: measured here, a Chromium without proprietary codecs
//	              answers canPlayType('video/mp4; codecs="avc1.42E01E"') with
//	              the empty string and fails the load with
//	              DEMUXER_ERROR_NO_SUPPORTED_STREAMS.
//	H.264 in MP4  the fallback, for an ffmpeg build with no libvpx.
//
// Whichever is used, the agent TELLS PAM the media type rather than leaving
// it to be guessed from the bytes, and PAM serves it back with that type.
//
// THE STOP IS THE PART THAT MATTERS. Both containers keep an index that the
// muxer writes only when it finalises the file, so an ffmpeg that is killed
// leaves bytes on disk no player will open. Stop() therefore asks ffmpeg to
// quit through its own stdin and waits for it, and only escalates to a signal
// when that does not work. For MP4, -movflags +faststart additionally moves
// the index to the front of the finished file, which is what lets a player
// start before the whole artifact has arrived.
package recorder

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// ScreenRecorderName is what an operator has to install for desktop
// recording to be possible. Named once so the message and the lookup cannot
// drift apart.
const ScreenRecorderName = "ffmpeg"

// ErrScreenRecorderMissing means ffmpeg is not on this machine, so a session
// that must be recorded cannot be opened as a desktop application.
var ErrScreenRecorderMissing = errors.New("ffmpeg is not installed, so a desktop application session cannot be recorded")

// Screen is a running screen capture.
type Screen struct {
	cmd      *exec.Cmd
	stdin    *os.File
	path     string
	encoding Encoding
	started  time.Time
	stopped  bool
}

// Encoding reports what this capture is, so the caller can tell PAM.
func (s *Screen) Encoding() Encoding {
	if s == nil {
		return Encoding{}
	}
	return s.encoding
}

// ScreenOptions are the knobs an administrator might reasonably want to
// differ per fleet. Zero values are replaced with the defaults below.
type ScreenOptions struct {
	// FrameRate in frames per second. Five is deliberate: a session recording
	// is watched to see what someone did, not for motion fidelity, and every
	// extra frame is storage and upload on the operator's own connection.
	FrameRate int

	// CRF is x264's quality scale (lower is better and larger). 28 keeps text
	// in a database GUI readable while staying small.
	CRF int

	// MaxSeconds bounds a single recording. A desktop session that is left
	// open overnight would otherwise produce an artifact nobody can store or
	// replay. Reaching it stops the capture cleanly and leaves a playable
	// file; the session itself carries on.
	MaxSeconds int

	// Display overrides the X display on Linux. Empty uses $DISPLAY.
	Display string
}

// Encoding is the codec and container a capture actually used, which the
// agent reports to PAM so the console can serve it back with the right type.
type Encoding struct {
	// FFmpegCodec is the encoder name passed to -c:v.
	FFmpegCodec string
	// Extension includes the leading dot.
	Extension string
	// MediaType is the IANA type a browser needs to see.
	MediaType string
}

// vp9WebM is preferred: royalty-free and decodable by every current browser,
// including an open-source Chromium build that has no H.264 at all.
var vp9WebM = Encoding{FFmpegCodec: "libvpx-vp9", Extension: ".webm", MediaType: "video/webm"}

// h264MP4 is the fallback for an ffmpeg with no libvpx compiled in.
var h264MP4 = Encoding{FFmpegCodec: "libx264", Extension: ".mp4", MediaType: "video/mp4"}

// pickEncoding asks the LOCAL ffmpeg what it can actually do, rather than
// assuming a build. Distribution ffmpeg packages differ in exactly this way,
// and a capture that fails at the encoder is a session that had to be refused
// for no good reason.
func pickEncoding(ffmpegPath string) (Encoding, error) {
	available := availableEncoders(ffmpegPath)
	for _, enc := range []Encoding{vp9WebM, h264MP4} {
		if available[enc.FFmpegCodec] {
			return enc, nil
		}
	}
	return Encoding{}, fmt.Errorf("this %s build has neither %s nor %s, so it cannot encode a session recording",
		ScreenRecorderName, vp9WebM.FFmpegCodec, h264MP4.FFmpegCodec)
}

// availableEncoders reads `ffmpeg -encoders` once and returns the names as a
// set. A failure to run it yields an empty set, which makes pickEncoding
// report a clear error rather than producing an invocation that dies later
// with ffmpeg's own diagnostics going to a discarded stderr.
func availableEncoders(ffmpegPath string) map[string]bool {
	out, err := exec.Command(ffmpegPath, "-hide_banner", "-encoders").Output()
	if err != nil {
		return map[string]bool{}
	}
	found := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		// Lines look like " V....D libx264   libx264 H.264 ...": the flags
		// column, then the encoder name.
		if len(fields) >= 2 && strings.HasPrefix(fields[0], "V") {
			found[fields[1]] = true
		}
	}
	return found
}

func (o ScreenOptions) withDefaults() ScreenOptions {
	if o.FrameRate <= 0 {
		o.FrameRate = 5
	}
	if o.CRF <= 0 {
		o.CRF = 28
	}
	if o.MaxSeconds <= 0 {
		o.MaxSeconds = 4 * 60 * 60 // four hours
	}
	return o
}

// ScreenRecorderAvailable reports whether this machine can record a desktop
// session at all. Checked BEFORE a launch that requires recording, so the
// refusal names the missing piece instead of opening an unrecorded session.
func ScreenRecorderAvailable() bool {
	_, err := exec.LookPath(ScreenRecorderName)
	return err == nil
}

// StartScreen begins capturing, writing into dir. The returned Screen must be
// stopped, or the file it is writing will not be playable.
func StartScreen(dir string, opts ScreenOptions) (*Screen, error) {
	opts = opts.withDefaults()

	ffmpegPath, err := exec.LookPath(ScreenRecorderName)
	if err != nil {
		return nil, ErrScreenRecorderMissing
	}

	encoding, err := pickEncoding(ffmpegPath)
	if err != nil {
		return nil, err
	}

	out := filepath.Join(dir, "session"+encoding.Extension)
	args, err := screenCaptureArgs(opts, encoding, out)
	if err != nil {
		return nil, err
	}

	cmd := exec.Command(ffmpegPath, args...)
	// ffmpeg reads single-key commands from stdin, which is how Stop asks it
	// to finish the file properly. A pipe rather than the parent's stdin: the
	// agent is started by the OS from a URL handler and has no usable one.
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("could not create a control pipe for %s: %w", ScreenRecorderName, err)
	}
	cmd.Stdin = pr
	// ffmpeg writes its whole progress display to stderr. Discarded on
	// purpose: this process usually has no console, and the failure that
	// matters (it did not start at all) surfaces as a start error or as a
	// missing file at stop time.
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		return nil, fmt.Errorf("could not start %s: %w", ScreenRecorderName, err)
	}
	// The child holds its own copy of the read end now.
	pr.Close()

	return &Screen{cmd: cmd, stdin: pw, path: out, encoding: encoding, started: time.Now()}, nil
}

// screenCaptureArgs builds the per-platform ffmpeg invocation.
//
// The input differs by platform and the output does not: every platform
// produces the same H.264/MP4 so the console has exactly one thing to play.
// screenCaptureArgs builds the invocation for THIS machine.
func screenCaptureArgs(opts ScreenOptions, encoding Encoding, out string) ([]string, error) {
	return screenCaptureArgsFor(runtime.GOOS, opts, encoding, out)
}

// screenCaptureArgsFor takes the operating system as an argument rather than
// reading runtime.GOOS, and that is the entire reason it exists.
//
// The capture device is the one part of desktop recording that differs per
// platform, and it was the one part no test could reach: runtime.GOOS is fixed
// when the package is compiled, so a test running on Linux could only ever
// execute the x11grab branch. gdigrab and avfoundation were compiled and never
// exercised — including by the tests that exist to hold the stop behaviour in
// place, every one of which skipped unless it was running on Linux. A mistake
// in either branch would have shipped and been found by an operator on Windows
// or a Mac, which is exactly what happened with -nostdin.
//
// With the OS passed in, all three are assertable from one test run on any
// host. Callers on the real path go through screenCaptureArgs above.
func screenCaptureArgsFor(goos string, opts ScreenOptions, encoding Encoding, out string) ([]string, error) {
	rate := strconv.Itoa(opts.FrameRate)

	var input []string
	switch goos {
	case "linux":
		display := opts.Display
		if display == "" {
			display = os.Getenv("DISPLAY")
		}
		if display == "" {
			// No X display means no desktop to capture. Saying so is far more
			// use than an ffmpeg error about a device it could not open.
			return nil, fmt.Errorf("no X display is set, so there is no desktop session to record")
		}
		input = []string{"-f", "x11grab", "-framerate", rate, "-i", display}
	case "darwin":
		// "1:none" is the capture screen with no audio. Audio is deliberately
		// never captured: it would record whatever else is on the operator's
		// machine, including calls, which is beyond what a privileged-access
		// session recording is entitled to.
		input = []string{"-f", "avfoundation", "-framerate", rate, "-capture_cursor", "1", "-i", "1:none"}
	case "windows":
		input = []string{"-f", "gdigrab", "-framerate", rate, "-i", "desktop"}
	default:
		return nil, fmt.Errorf("desktop recording is not supported on %s", goos)
	}

	// No -nostdin here, deliberately. ffmpeg is given its own stdin pipe
	// (see StartScreen) so it cannot steal the parent's terminal, and Stop
	// asks it to finish the file by writing "q" to that pipe. -nostdin makes
	// ffmpeg ignore stdin entirely, so the "q" is never read: the stop then
	// falls through to the signal escalation, costing ten seconds on every
	// desktop session end, and on Windows, where there is no SIGINT to send,
	// falling all the way to Kill and an unfinalised file.
	args := []string{"-hide_banner", "-loglevel", "error"}
	args = append(args, input...)
	args = append(args,
		"-t", strconv.Itoa(opts.MaxSeconds),
		"-c:v", encoding.FFmpegCodec,
		// yuv420p rather than the capture's native format: it is the only
		// pixel format every browser will decode. Without it a recording
		// plays in VLC and shows a black rectangle in a browser.
		"-pix_fmt", "yuv420p",
		// Pad odd dimensions up to even. Neither encoder can take an odd
		// width or height at yuv420p, and a real screen often has one.
		"-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
	)

	switch encoding.FFmpegCodec {
	case vp9WebM.FFmpegCodec:
		// realtime/cpu-used 8 is the fastest VP9 setting. This runs on the
		// operator's own machine, alongside the application being recorded,
		// so spending their CPU on compression they will never notice is the
		// wrong trade. -b:v 0 makes -crf the sole quality control, which is
		// what VP9 needs to behave like x264's CRF.
		args = append(args, "-deadline", "realtime", "-cpu-used", "8", "-b:v", "0", "-crf", strconv.Itoa(opts.CRF))
	default:
		args = append(args, "-preset", "veryfast", "-crf", strconv.Itoa(opts.CRF))
		// Puts the MP4 index at the front so a player can start before the
		// whole file has arrived. WebM needs no equivalent.
		args = append(args, "-movflags", "+faststart")
	}

	args = append(args, "-y", out)
	return args, nil
}

// Stop ends the capture and returns the finished file's bytes.
//
// The escalation is the whole point. ffmpeg finalises an MP4 only when it
// exits of its own accord, so this asks nicely first ("q" on stdin), then
// interrupts, and only kills as a last resort — a killed ffmpeg leaves a file
// no player will open, which is the same as having no recording at all.
func (s *Screen) Stop() ([]byte, error) {
	if s == nil {
		return nil, nil
	}
	if s.stopped {
		return os.ReadFile(s.path)
	}
	s.stopped = true

	done := make(chan error, 1)
	go func() { done <- s.cmd.Wait() }()

	// 1. ffmpeg's own quit key. This is the only path that produces a
	// correctly finalised file.
	_, _ = s.stdin.WriteString("q")
	_ = s.stdin.Close()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		// 2. SIGINT, which ffmpeg also handles by finishing the file.
		_ = interruptProcess(s.cmd)
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			// 3. Give up on a clean file rather than hang the session end.
			_ = s.cmd.Process.Kill()
			<-done
		}
	}

	data, err := os.ReadFile(s.path)
	if err != nil {
		return nil, fmt.Errorf("the screen recording could not be read back: %w", err)
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("the screen recording is empty; %s may not have been able to open a capture device", ScreenRecorderName)
	}
	return data, nil
}

// Path is where the capture is being written, for cleanup by the caller.
func (s *Screen) Path() string {
	if s == nil {
		return ""
	}
	return s.path
}

// Duration is how long the capture ran, for the session's own log line.
func (s *Screen) Duration() time.Duration {
	if s == nil {
		return 0
	}
	return time.Since(s.started)
}

// ScreenUnavailableHint tells an operator how to get desktop recording
// working, per platform, in the same shape as the launch templates' own
// install hints.
func ScreenUnavailableHint() string {
	return screenUnavailableHintFor(runtime.GOOS)
}

// screenUnavailableHintFor takes the platform as an argument for the same
// reason screenCaptureArgsFor does: this text is only ever SEEN on the
// platform it names, so a mistake in the macOS or Windows branch would reach
// an operator before it reached a test.
//
// The macOS wording carries the part that costs the most time: ffmpeg being
// installed is not sufficient there. Without the Screen Recording permission
// avfoundation returns a black frame and reports no error at all, so an
// operator gets a recording that plays and shows nothing.
func screenUnavailableHintFor(goos string) string {
	switch goos {
	case "darwin":
		return "Install ffmpeg with 'brew install ffmpeg', then allow screen recording for the terminal or agent under System Settings > Privacy & Security > Screen Recording."
	case "windows":
		return "Install ffmpeg with 'winget install Gyan.FFmpeg' (or download a build from ffmpeg.org) and make sure ffmpeg.exe is on PATH."
	default:
		return "Install ffmpeg, for example 'sudo apt install ffmpeg', and make sure it is on PATH."
	}
}

// screenSummary is a one-line description for the log and the session record.
func (s *Screen) String() string {
	if s == nil {
		return "no screen capture"
	}
	return strings.TrimSpace(fmt.Sprintf("screen capture at %s for %s", s.path, s.Duration().Round(time.Second)))
}
