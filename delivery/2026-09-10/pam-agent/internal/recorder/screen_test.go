package recorder

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A capture that cannot be replayed in a browser is not a recording, so the
// invocation is pinned rather than left to drift.
func TestScreenCaptureArgsProduceABrowserPlayableStream(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the x11grab input is only built on linux")
	}
	t.Setenv("DISPLAY", ":99")

	args, err := screenCaptureArgs(ScreenOptions{}.withDefaults(), vp9WebM, "/tmp/out.webm")
	if err != nil {
		t.Fatalf("screenCaptureArgs: %v", err)
	}
	joined := strings.Join(args, " ")

	for _, want := range []string{
		"-f x11grab", // capture the desktop, not a file
		"-i :99",     // the display the application draws on
		"-c:v libvpx-vp9",
		// The only pixel format every browser decodes. Without it the
		// recording plays in VLC and shows a black rectangle in a browser.
		"-pix_fmt yuv420p",
		// Neither encoder takes an odd width or height at yuv420p, and a real
		// screen often has one.
		"-vf pad=ceil(iw/2)*2:ceil(ih/2)*2",
		// A session left open overnight must not produce an artifact nobody
		// can store or replay.
		"-t ",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("invocation is missing %q:\n%s", want, joined)
		}
	}

	// Audio is never captured. It would record whatever else is happening on
	// the operator's machine, including calls, which is well beyond what a
	// privileged-access session recording is entitled to.
	if strings.Contains(joined, "-c:a") || strings.Contains(joined, ":audio") {
		t.Errorf("the invocation captures audio:\n%s", joined)
	}
}

// Linux has no desktop to capture without a display, and saying so is far
// more use than ffmpeg's own error about a device it could not open.
func TestNoDisplayIsAClearFailure(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("display resolution is linux-specific")
	}
	t.Setenv("DISPLAY", "")
	if _, err := screenCaptureArgs(ScreenOptions{}.withDefaults(), vp9WebM, "/tmp/out.webm"); err == nil {
		t.Fatal("expected an error when no display is set")
	} else if !strings.Contains(err.Error(), "display") {
		t.Fatalf("error does not mention the display: %v", err)
	}
}

// The encoder is chosen from what the LOCAL ffmpeg can do, because
// distribution builds genuinely differ and a capture that dies at the encoder
// is a session refused for no good reason.
func TestEncoderSelectionPrefersTheRoyaltyFreeOne(t *testing.T) {
	// A stub that answers -encoders with both, so the preference is what is
	// being tested rather than this machine's ffmpeg build.
	both := stubFFmpeg(t, " V....D libx264              libx264 H.264\n V....D libvpx-vp9           libvpx VP9\n")
	enc, err := pickEncoding(both)
	if err != nil {
		t.Fatalf("pickEncoding: %v", err)
	}
	if enc.FFmpegCodec != vp9WebM.FFmpegCodec {
		t.Fatalf("chose %q, want VP9: it is royalty-free and the only one a plain open-source Chromium can decode", enc.FFmpegCodec)
	}
	if enc.MediaType != "video/webm" || enc.Extension != ".webm" {
		t.Fatalf("encoding = %+v", enc)
	}

	// An ffmpeg with no libvpx still has to produce something playable.
	onlyH264 := stubFFmpeg(t, " V....D libx264              libx264 H.264\n")
	enc, err = pickEncoding(onlyH264)
	if err != nil {
		t.Fatalf("pickEncoding: %v", err)
	}
	if enc.FFmpegCodec != h264MP4.FFmpegCodec || enc.MediaType != "video/mp4" {
		t.Fatalf("fallback = %+v, want H.264/MP4", enc)
	}

	// Neither available is a real failure, reported before a session opens
	// rather than after it has been recorded to nothing.
	neither := stubFFmpeg(t, " A....D aac                  AAC\n")
	if _, err := pickEncoding(neither); err == nil {
		t.Fatal("expected an error when the build can encode no video at all")
	}
}

// stubFFmpeg writes a script that prints the given encoder listing, so
// encoder selection can be tested against a known build.
func stubFFmpeg(t *testing.T, listing string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stub is a shell script")
	}
	path := filepath.Join(t.TempDir(), "ffmpeg")
	script := "#!/bin/sh\ncat <<'ENC'\n" + listing + "ENC\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	return path
}

// Stop asks ffmpeg to finish the file by writing "q" to the stdin pipe
// StartScreen gives it. -nostdin makes ffmpeg ignore that pipe entirely, so
// the "q" would be written into a void and every desktop session end would
// wait out the ten-second timeout before escalating to a signal. On Windows
// there is no signal to escalate to, so it would wait out both timeouts and
// then kill ffmpeg, leaving a file no player can open.
//
// This was shipped once and measured: session end took 10.0s with the flag
// and 0.26s without it, for the same eight-second capture.
func TestTheInvocationLeavesTheQuitKeyReachable(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the x11grab input is only built on linux")
	}
	t.Setenv("DISPLAY", ":99")

	args, err := screenCaptureArgs(ScreenOptions{}.withDefaults(), vp9WebM, "/tmp/out.webm")
	if err != nil {
		t.Fatalf("screenCaptureArgs: %v", err)
	}
	for _, arg := range args {
		if arg == "-nostdin" {
			t.Fatalf("-nostdin is back; Stop's \"q\" can no longer reach ffmpeg:\n%s", strings.Join(args, " "))
		}
	}
}
