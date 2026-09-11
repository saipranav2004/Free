package apiclient

import "testing"

// Nothing on the server parses the multipart filename: the artifact's
// container comes from the "format" and "media_type" fields. It still has to
// be honest, because it is what a person sees in a proxy log or a WAF rule
// when they are trying to work out why a recording did not arrive, and
// "session.cast.gz" on a screen video sends them after the wrong thing.
func TestTheUploadedPartIsNamedAfterWhatItHolds(t *testing.T) {
	for _, tc := range []struct {
		name      string
		format    string
		mediaType string
		want      string
	}{
		{"terminal capture", RecordingFormatAsciicast, "", "session.cast.gz"},
		{"desktop capture, webm", RecordingFormatVideo, "video/webm", "session.webm"},
		{"desktop capture, mp4", RecordingFormatVideo, "video/mp4", "session.mp4"},
		// An older agent, or one whose ffmpeg reported nothing usable, may send
		// no media type at all. WebM is what the recorder prefers, so it is the
		// better guess, and the field the server actually reads is unaffected.
		{"video with no media type", RecordingFormatVideo, "", "session.webm"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := uploadFilename(tc.format, tc.mediaType); got != tc.want {
				t.Errorf("uploadFilename(%q, %q) = %q, want %q", tc.format, tc.mediaType, got, tc.want)
			}
		})
	}
}
