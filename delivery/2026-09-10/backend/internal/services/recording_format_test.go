// pam/internal/services/recording_format_test.go
//
// A desktop application session is recorded as VIDEO, because a desktop
// client has no terminal for the relay to own and pixels are the only honest
// recording of one. That makes the artifact's format a real branch through
// the upload path, and this pins it.
//
// The format is STATED by the agent, never sniffed from the bytes. It is
// therefore a value chosen on the operator's own machine that decides which
// player the console loads for an auditor, which is why it is whitelisted on
// arrival rather than passed through.
package services

import (
	"strings"
	"testing"
)

func TestRecordingFormatIsWhitelistedNotPassedThrough(t *testing.T) {
	cases := []struct {
		in   string
		want string
		why  string
	}{
		{"video", RecordingFormatVideo, "a desktop session"},
		{"VIDEO", RecordingFormatVideo, "case is not significant"},
		{"  video  ", RecordingFormatVideo, "surrounding space is trimmed"},
		{"asciicast", RecordingFormatAsciicast, "a terminal session"},
		{"", RecordingFormatAsciicast, "an agent built before desktop recording sends no format at all"},
		{"rrweb", RecordingFormatAsciicast, "the agent never produces rrweb; only the brokered web proxy does"},
		{"mp4", RecordingFormatAsciicast, "a plausible-looking value is still not one of ours"},
		{"video; drop table", RecordingFormatAsciicast, "nothing arbitrary reaches the column"},
	}
	for _, tc := range cases {
		if got := NormalizeRecordingFormat(tc.in); got != tc.want {
			t.Errorf("NormalizeRecordingFormat(%q) = %q, want %q (%s)", tc.in, got, tc.want, tc.why)
		}
	}
}

// The stored object is named for what it actually is, and for a video the
// extension is the ONLY record of which container the agent's encoder chose.
// GetRecordingVideo serves the Content-Type straight back from it, which is
// why this needs no column and no migration, and why getting it wrong makes a
// perfectly good recording unplayable.
func TestArtifactSuffixRecordsTheContainer(t *testing.T) {
	cases := []struct {
		format, mediaType, want string
		why                     string
	}{
		{RecordingFormatVideo, "video/webm", ".webm", "the preferred encoder"},
		{RecordingFormatVideo, "video/mp4", ".mp4", "the fallback encoder"},
		{RecordingFormatVideo, "", ".mp4", "an agent that reports no media type"},
		{RecordingFormatVideo, "video/quicktime", ".mp4", "an unrecognised container never reaches the key"},
		{RecordingFormatAsciicast, "", ".cast.gz", "a terminal transcript, gzip'd"},
		{RecordingFormatAsciicast, "video/webm", ".cast.gz", "the format decides first, not the media type"},
		{"something else", "", ".cast.gz", "already normalised by the time this runs"},
	}
	for _, tc := range cases {
		if got := recordingArtifactSuffix(tc.format, tc.mediaType); got != tc.want {
			t.Errorf("recordingArtifactSuffix(%q, %q) = %q, want %q (%s)", tc.format, tc.mediaType, got, tc.want, tc.why)
		}
	}
	if !strings.HasSuffix(recordingArtifactSuffix(RecordingFormatAsciicast, ""), ".gz") {
		t.Error("a terminal transcript must keep its .gz suffix")
	}
}

// And the mapping back: a browser refuses a WebM labelled video/mp4, so the
// served type has to follow the stored key rather than a fixed default.
func TestMediaTypeIsDerivedFromTheStoredKey(t *testing.T) {
	cases := map[string]string{
		"recordings/2026/09/10/rec-1.webm": "video/webm",
		"recordings/2026/09/10/rec-1.WEBM": "video/webm",
		"recordings/2026/09/10/rec-1.mp4":  "video/mp4",
		"recordings/2026/09/10/rec-1":      "video/mp4",
	}
	for key, want := range cases {
		if got := RecordingMediaType(key); got != want {
			t.Errorf("RecordingMediaType(%q) = %q, want %q", key, got, want)
		}
	}
}
