package discovery

import (
	"os"
	"path/filepath"
	"testing"
)

// Oracle SQL Developer has NO INSTALLER. It ships as a ZIP that the operator
// extracts wherever they like, and the archive contains a version-stamped
// folder with a second `sqldeveloper` directory inside it. Nothing is put on
// PATH and nothing is registered.
//
// These tests build the real layouts on disk and search for them, which is the
// opposite of what the earlier "test" did: that one dropped a stub at one of
// the glob patterns and then checked the glob matched it, proving only that a
// string equals itself. The layouts below are the ones the official archive
// and the common install habits actually produce.
func TestSQLDeveloperIsFoundWhereTheZipActuallyLands(t *testing.T) {
	root := t.TempDir()

	layouts := map[string]string{
		"flat extract":            "sqldeveloper/sqldeveloper",
		"versioned, nested":       "sqldeveloper-24.3.1-347.1826-no-jre/sqldeveloper/sqldeveloper",
		"downloads, versioned":    "Users/pranav/Downloads/sqldeveloper-24.3.1/sqldeveloper/sqldeveloper",
		"downloads, flat":         "Users/pranav/Downloads/sqldeveloper-24.3.1/sqldeveloper",
		"second drive, tools dir": "tools/sqldeveloper/sqldeveloper",
	}
	for name, rel := range layouts {
		t.Run(name, func(t *testing.T) {
			full := filepath.Join(root, name, rel)
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, []byte("#!/bin/sh\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			base := filepath.Join(root, name)
			// The same shapes the shipped template carries, rooted at the
			// temp dir so the test does not depend on this machine.
			globs := []string{
				base + "/sqldeveloper/sqldeveloper",
				base + "/sqldeveloper*/sqldeveloper/sqldeveloper",
				base + "/tools/sqldeveloper/sqldeveloper",
				base + "/Users/*/Downloads/sqldeveloper*/sqldeveloper",
				base + "/Users/*/Downloads/sqldeveloper*/sqldeveloper/sqldeveloper",
			}
			if p, ok := globLatestExisting(globs); !ok {
				t.Errorf("SQL Developer at %s was not found by any pattern", rel)
			} else if p != full {
				t.Errorf("found %s, want %s", p, full)
			}
		})
	}
}

// An administrator can pin the path on the PAM resource, which is the only
// answer that works for an extract in a place nobody can predict.
func TestAnExplicitPathWinsAndIsNotSecondGuessed(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "somewhere", "odd", "sqldeveloper.exe")
	if err := os.MkdirAll(filepath.Dir(real), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(real, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := Locate(Spec{ExplicitPath: real, BinaryNames: []string{"definitely-not-a-real-binary"}})
	if got.Path != real {
		t.Errorf("Locate = %q, want the administrator's path %q", got.Path, real)
	}

	// A path that is set but wrong must FAIL, not silently fall back to
	// something else on the machine: an operator told to use a specific build
	// needs to hear it is missing rather than be handed a different one.
	bad := Locate(Spec{ExplicitPath: filepath.Join(dir, "gone.exe"), BinaryNames: []string{"sh"}})
	if bad.Found() {
		t.Errorf("a missing explicit path fell back to %q", bad.Path)
	}

	// Pointing at the folder instead of the executable is a common slip and
	// must not be reported as a hit, since a directory cannot be spawned.
	asDir := Locate(Spec{ExplicitPath: filepath.Dir(real)})
	if asDir.Found() {
		t.Errorf("a directory was accepted as the tool: %q", asDir.Path)
	}
}

// The Oracle client install seen in the field was dbhomeFree, and the shipped
// pattern only covered dbhome_1, so it was found by PATH alone. On a machine
// where the installer did not touch PATH it would not have been found at all.
func TestSqlplusIsFoundInARealOracleHome(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "app", "T14", "product", "26ai", "dbhomeFree", "bin", "sqlplus")
	if err := os.MkdirAll(filepath.Dir(real), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(real, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	globs := []string{
		root + "/app/*/product/*/dbhome_1/bin/sqlplus", // the old pattern
	}
	if _, ok := globLatestExisting(globs); ok {
		t.Fatal("fixture is wrong: the old pattern should not match dbhomeFree")
	}
	widened := []string{root + "/app/*/product/*/dbhome*/bin/sqlplus"}
	if p, ok := globLatestExisting(widened); !ok {
		t.Error("the widened pattern still does not find a dbhomeFree install")
	} else if p != real {
		t.Errorf("found %s, want %s", p, real)
	}
}
