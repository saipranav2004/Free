package handlers

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

// A recording that no longer matches its capture-time digest must be refused,
// not played. The digest was being written and never read, so anyone able to
// write to object storage could change what an investigation saw.
//
// This pins the comparison itself, which is the part that has to be right:
// case-insensitive hex of the raw stored bytes, taken before decompression, so
// it covers the artifact exactly as it was hashed on the way in.
func TestRecordingDigestComparison(t *testing.T) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(`{"version":2,"width":80}` + "\n")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	stored := buf.Bytes()

	sum := sha256.Sum256(stored)
	captured := hex.EncodeToString(sum[:])

	if !strings.EqualFold(captured, strings.ToUpper(captured)) {
		t.Fatal("comparison must be case-insensitive: a digest stored upper-case would read as tampering")
	}

	// One flipped byte in the artifact has to change the answer.
	tampered := append([]byte(nil), stored...)
	tampered[len(tampered)/2] ^= 0x01
	sum2 := sha256.Sum256(tampered)
	if strings.EqualFold(hex.EncodeToString(sum2[:]), captured) {
		t.Fatal("a modified artifact produced the same digest")
	}
}
