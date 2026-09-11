package recorder

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// The capture command on every platform, asserted from one test run.
// ---------------------------------------------------------------------------
// Until screenCaptureArgsFor took the OS as an argument, these branches were
// unreachable from a test: runtime.GOOS is fixed at compile time, so a run on
// Linux could only ever execute x11grab, and every existing screen test skipped
// unless it was on Linux. gdigrab and avfoundation compiled and were never
// exercised once. That is how -nostdin shipped and cost ten seconds on every
// desktop session end.

func argsFor(t *testing.T, goos string, enc Encoding) []string {
	t.Helper()
	opts := ScreenOptions{Display: ":99"}.withDefaults()
	args, err := screenCaptureArgsFor(goos, opts, enc, "/tmp/out"+enc.Extension)
	if err != nil {
		t.Fatalf("%s: %v", goos, err)
	}
	return args
}

// joined renders the argv for substring assertions, with separators so a
// match cannot span two unrelated arguments.
func joined(args []string) string { return "\x00" + strings.Join(args, "\x00") + "\x00" }

func hasPair(args []string, flag, value string) bool {
	for i := 0; i < len(args)-1; i++ {
		if args[i] == flag && args[i+1] == value {
			return true
		}
	}
	return false
}

func TestEachPlatformCapturesItsOwnDesktop(t *testing.T) {
	cases := []struct {
		goos   string
		format string
		input  string
	}{
		{"linux", "x11grab", ":99"},
		{"darwin", "avfoundation", "1:none"},
		{"windows", "gdigrab", "desktop"},
	}
	for _, c := range cases {
		t.Run(c.goos, func(t *testing.T) {
			args := argsFor(t, c.goos, h264MP4)
			if !hasPair(args, "-f", c.format) {
				t.Fatalf("%s does not capture with %s: %v", c.goos, c.format, args)
			}
			if !hasPair(args, "-i", c.input) {
				t.Fatalf("%s does not read input %q: %v", c.goos, c.input, args)
			}
		})
	}
}

// An unsupported platform must say so rather than build an invocation that
// ffmpeg will reject with a message about a device nobody has heard of.
func TestAnUnsupportedPlatformIsNamed(t *testing.T) {
	_, err := screenCaptureArgsFor("plan9", ScreenOptions{}.withDefaults(), h264MP4, "/tmp/out.mp4")
	if err == nil {
		t.Fatal("plan9 should not produce a capture command")
	}
	if !strings.Contains(err.Error(), "plan9") {
		t.Fatalf("the error should name the platform, got: %v", err)
	}
}

// macOS records the SCREEN and no audio. "1:none" is that pair. Capturing
// audio would pick up whatever else is on the operator's machine, including
// calls, which is beyond what a session recording is entitled to.
func TestMacOSNeverCapturesAudio(t *testing.T) {
	args := argsFor(t, "darwin", h264MP4)
	for _, a := range args {
		if strings.Contains(a, ":0") && strings.Contains(a, "1:") {
			t.Fatalf("macOS capture appears to name an audio device: %v", args)
		}
	}
	if !hasPair(args, "-i", "1:none") {
		t.Fatalf("macOS must capture screen 1 with no audio: %v", args)
	}
}

// The stop path writes "q" to ffmpeg's stdin. -nostdin makes ffmpeg ignore
// stdin entirely, so the "q" is never read and the stop falls through to
// signal escalation: ten seconds on Linux and macOS, and on Windows, which has
// no SIGINT to send, all the way to Kill and a file no player will open.
// This held on Linux already; it has never been checked for the other two.
func TestTheQuitKeyStaysReachableOnEveryPlatform(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "windows"} {
		t.Run(goos, func(t *testing.T) {
			for _, enc := range []Encoding{h264MP4, vp9WebM} {
				args := argsFor(t, goos, enc)
				if strings.Contains(joined(args), "\x00-nostdin\x00") {
					t.Fatalf("%s/%s passes -nostdin, so Stop cannot ask ffmpeg to finish the file: %v",
						goos, enc.FFmpegCodec, args)
				}
			}
		})
	}
}

// Every recording has to play in a BROWSER, which is where an auditor opens
// it. yuv420p and even dimensions are both hard requirements there and both
// easy to lose; a recording that plays in VLC and shows a black rectangle in
// Chrome is worse than none, because it looks like it worked.
func TestEveryPlatformProducesABrowserPlayableStream(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "windows"} {
		for _, enc := range []Encoding{h264MP4, vp9WebM} {
			args := argsFor(t, goos, enc)
			if !hasPair(args, "-pix_fmt", "yuv420p") {
				t.Errorf("%s/%s: no yuv420p, so a browser may decode this to a black rectangle: %v",
					goos, enc.FFmpegCodec, args)
			}
			if !hasPair(args, "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2") {
				t.Errorf("%s/%s: odd screen dimensions are not padded, and neither encoder accepts them at yuv420p: %v",
					goos, enc.FFmpegCodec, args)
			}
			if !hasPair(args, "-c:v", enc.FFmpegCodec) {
				t.Errorf("%s: encoder is not %s: %v", goos, enc.FFmpegCodec, args)
			}
			// MP4 keeps its index at the front so a player can start before
			// the whole file has arrived. WebM needs no equivalent, and
			// passing it there is an error.
			hasFaststart := strings.Contains(joined(args), "\x00+faststart\x00")
			if enc.FFmpegCodec == h264MP4.FFmpegCodec && !hasFaststart {
				t.Errorf("%s/mp4: no +faststart, so the recording will not start until fully downloaded: %v", goos, args)
			}
			if enc.FFmpegCodec == vp9WebM.FFmpegCodec && hasFaststart {
				t.Errorf("%s/webm: +faststart is an mp4-only flag: %v", goos, args)
			}
		}
	}
}

// A capture with no ceiling fills the operator's disk. The cap is applied on
// every platform or it is applied on none of them.
func TestTheCaptureIsTimeCappedEverywhere(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "windows"} {
		opts := ScreenOptions{Display: ":99", MaxSeconds: 1800}.withDefaults()
		args, err := screenCaptureArgsFor(goos, opts, h264MP4, "/tmp/out.mp4")
		if err != nil {
			t.Fatalf("%s: %v", goos, err)
		}
		if !hasPair(args, "-t", "1800") {
			t.Errorf("%s: capture is not time-capped: %v", goos, args)
		}
	}
}

// Linux is the only platform that needs a display to be named, and saying so
// is far more use than an ffmpeg error about a device it could not open.
// Windows and macOS must NOT inherit that requirement: neither reads DISPLAY,
// and failing there would make desktop recording impossible on both.
func TestOnlyLinuxNeedsADisplay(t *testing.T) {
	bare := ScreenOptions{}.withDefaults() // no Display set
	t.Setenv("DISPLAY", "")

	if _, err := screenCaptureArgsFor("linux", bare, h264MP4, "/tmp/o.mp4"); err == nil {
		t.Error("linux with no display should refuse rather than let ffmpeg fail obscurely")
	}
	for _, goos := range []string{"darwin", "windows"} {
		if _, err := screenCaptureArgsFor(goos, bare, h264MP4, "/tmp/o.mp4"); err != nil {
			t.Errorf("%s does not read DISPLAY and must not require one: %v", goos, err)
		}
	}
}

// The hint an operator reads when desktop recording is unavailable is only
// ever shown on the platform it names, so without passing the OS in, two of
// the three branches could say anything at all and no test would notice.
func TestTheInstallHintIsRightForEachPlatform(t *testing.T) {
	linux := screenUnavailableHintFor("linux")
	if !strings.Contains(linux, "apt") || !strings.Contains(linux, "ffmpeg") {
		t.Errorf("linux hint does not name a way to install ffmpeg: %q", linux)
	}

	win := screenUnavailableHintFor("windows")
	if !strings.Contains(win, "ffmpeg.exe") {
		t.Errorf("windows hint should name ffmpeg.exe and PATH: %q", win)
	}

	// The one that matters most. On macOS ffmpeg being installed is NOT
	// enough: without the Screen Recording permission, avfoundation returns a
	// black frame and reports no error, so the operator gets a recording that
	// plays and shows nothing. A hint that stops at "brew install ffmpeg"
	// sends them away believing they are done.
	mac := screenUnavailableHintFor("darwin")
	if !strings.Contains(mac, "brew") {
		t.Errorf("macOS hint does not say how to install ffmpeg: %q", mac)
	}
	if !strings.Contains(mac, "Screen Recording") {
		t.Errorf("macOS hint omits the Screen Recording permission, which is the step that actually blocks capture: %q", mac)
	}
}
