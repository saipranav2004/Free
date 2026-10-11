package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

// A generated root password must reach a 0600 file and NOT the log. It is the
// one credential that opens the whole product, and application logs are
// shipped, retained and readable by people who should not hold root.
func TestGeneratedRootPasswordStaysOutOfTheLog(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "root-password.txt")
	t.Setenv("PAM_ROOT_PASSWORD_FILE", path)

	core, logs := observer.New(zapcore.DebugLevel)
	secret := "S3cret-Generated-Value-Not-For-Logs"
	writeGeneratedPassword("root", secret, zap.New(core))

	for _, e := range logs.All() {
		if strings.Contains(e.Message, secret) {
			t.Fatalf("password appeared in the log message")
		}
		for _, f := range e.Context {
			if f.String == secret {
				t.Fatalf("password appeared in log field %q", f.Key)
			}
		}
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("password file not written: %v", err)
	}
	if !strings.Contains(string(body), secret) {
		t.Fatalf("password file does not contain the password")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("password file mode is %v, want 0600", perm)
	}
}
