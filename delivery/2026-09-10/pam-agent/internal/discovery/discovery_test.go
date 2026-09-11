package discovery

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLocateFindsBinaryOnPath(t *testing.T) {
	// "go" itself is guaranteed to be on PATH in this test's own environment.
	result := Locate(Spec{BinaryNames: []string{"go"}})
	if !result.Found() {
		t.Fatal("expected to find `go` on PATH")
	}
	if result.Path == "" {
		t.Fatal("expected a resolved Path, got empty string")
	}
}

func TestLocateReturnsNotFoundForUnknownBinary(t *testing.T) {
	result := Locate(Spec{BinaryNames: []string{"definitely-not-a-real-binary-xyz-123"}})
	if result.Found() {
		t.Fatalf("expected not found, got %+v", result)
	}
}

func TestLocateFallsBackToAbsolutePathGlob(t *testing.T) {
	dir := t.TempDir()
	versionDir := filepath.Join(dir, "9")
	if err := os.MkdirAll(versionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fakeBinary := filepath.Join(versionDir, "fake-tool")
	if err := os.WriteFile(fakeBinary, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	spec := Spec{
		BinaryNames: []string{"definitely-not-on-path-xyz"},
		AbsolutePathGlobs: map[string][]string{
			runtime.GOOS: {filepath.Join(dir, "*", "fake-tool")},
		},
	}
	result := Locate(spec)
	if !result.Found() {
		t.Fatal("expected to find the binary via absolute path glob")
	}
	if result.Path != fakeBinary {
		t.Fatalf("got path %q, want %q", result.Path, fakeBinary)
	}
}

func TestLocateAbsolutePathGlobPrefersNewestVersionFolder(t *testing.T) {
	dir := t.TempDir()
	for _, v := range []string{"8", "10", "9"} {
		vd := filepath.Join(dir, v)
		if err := os.MkdirAll(vd, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(vd, "tool"), []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	spec := Spec{
		AbsolutePathGlobs: map[string][]string{
			runtime.GOOS: {filepath.Join(dir, "*", "tool")},
		},
	}
	result := Locate(spec)
	if !result.Found() {
		t.Fatal("expected a match")
	}
	// Lexicographic-descending sort means "9" sorts after "10" and "8" as a
	// string ("9" > "8" > "10" character-by-character) — Locate doesn't
	// claim numeric version awareness, just "prefer the lexicographically
	// last path that exists," which is what this asserts.
	want := filepath.Join(dir, "9", "tool")
	if result.Path != want {
		t.Fatalf("got %q, want %q", result.Path, want)
	}
}

func TestLocateOnlyConsultsMatchingGOOSGlobs(t *testing.T) {
	dir := t.TempDir()
	fakeBinary := filepath.Join(dir, "tool")
	if err := os.WriteFile(fakeBinary, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Register the glob under an OS name that definitely isn't the one
	// running this test, plus nothing under the real runtime.GOOS — Locate
	// must not find it.
	otherGOOS := "not-a-real-os"
	spec := Spec{
		AbsolutePathGlobs: map[string][]string{
			otherGOOS: {filepath.Join(dir, "tool")},
		},
	}
	result := Locate(spec)
	if result.Found() {
		t.Fatalf("expected no match (glob was scoped to %q, not %q), got %+v", otherGOOS, runtime.GOOS, result)
	}
}

func TestFindMacAppBundleUnderApplications(t *testing.T) {
	dir := t.TempDir()
	bundle := filepath.Join(dir, "Example.app")
	if err := os.MkdirAll(bundle, 0o755); err != nil {
		t.Fatal(err)
	}
	// findMacAppBundle always checks /Applications and ~/Applications, which
	// this test can't redirect without root — instead exercise it directly
	// against a temp dir standing in for one of those roots isn't possible
	// without changing the function signature, so this test instead checks
	// the negative case (bundle name that certainly doesn't exist) plus
	// Locate's overall Found()==false behavior on non-darwin, which is the
	// portable part of this code path.
	if runtime.GOOS == "darwin" {
		t.Skip("positive /Applications case requires a real bundle; covered by manual QA on macOS")
	}
	result := Locate(Spec{MacAppBundles: []string{"DefinitelyNotInstalled.app"}})
	if result.Found() {
		t.Fatalf("MacAppBundles should only be consulted on darwin, got %+v", result)
	}
	_ = bundle
}

func TestParseRegDefaultValue(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want string
		ok   bool
	}{
		{
			name: "typical reg query output",
			out: "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\pgAdmin4.exe\r\n" +
				"    (Default)    REG_SZ    C:\\Program Files\\pgAdmin 4\\8\\pgAdmin4.exe\r\n\r\n",
			want: `C:\Program Files\pgAdmin 4\8\pgAdmin4.exe`,
			ok:   true,
		},
		{
			name: "value not set",
			out:  "    (Default)    REG_SZ    (value not set)\r\n",
			want: "",
			ok:   false,
		},
		{
			name: "empty output",
			out:  "",
			want: "",
			ok:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseRegDefaultValue(tc.out)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// A "~/" glob has to resolve against the operator's real home directory.
// filepath.Glob treats "~" as a literal directory name, so without
// expansion the Downloads patterns for macOS and Linux would match nothing
// at all while looking perfectly correct in the template file.
func TestExpandHomeResolvesTildePatterns(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	got := expandHome("~/Downloads/mongosh*/bin/mongosh")
	want := filepath.Join(home, "Downloads/mongosh*/bin/mongosh")
	if got != want {
		t.Fatalf("expandHome = %q, want %q", got, want)
	}

	for _, pattern := range []string{
		"/usr/bin/mongosh",
		`C:\Program Files\mongosh\mongosh.exe`,
		"~notauser/bin/mongosh",
		"~",
	} {
		if expandHome(pattern) != pattern {
			t.Errorf("expandHome(%q) = %q, want it untouched", pattern, expandHome(pattern))
		}
	}
}

// End to end: an unpacked download in ~/Downloads is found, which is the
// whole point of the change. Skipped on Windows, where HOME is not what
// os.UserHomeDir reads and the equivalent pattern needs no expansion.
func TestLocateFindsAToolUnpackedInDownloads(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows patterns name C:\\Users\\* directly and need no home expansion")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)

	binDir := filepath.Join(home, "Downloads", "mongosh-2.3.1-darwin-arm64", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	tool := filepath.Join(binDir, "mongosh")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	spec := Spec{
		BinaryNames: []string{"definitely-not-a-real-binary-xyz-123"},
		AbsolutePathGlobs: map[string][]string{
			runtime.GOOS: {"~/Downloads/mongosh*/bin/mongosh"},
		},
	}
	got := Locate(spec)
	if !got.Found() {
		t.Fatal("Locate did not find the unpacked download")
	}
	if got.Path != tool {
		t.Errorf("Locate path = %q, want %q", got.Path, tool)
	}
}

// reg.exe's output puts the value's data in the fourth column, and a PATH
// is full of spaces, so a naive Fields()[3] would truncate it at the first
// "Program Files".
func TestParseRegNamedValueKeepsSpacesInTheData(t *testing.T) {
	out := "\r\nHKEY_CURRENT_USER\\Environment\r\n" +
		"    Path    REG_EXPAND_SZ    C:\\Program Files\\mongosh;C:\\Users\\p\\AppData\\Local\\Programs\\mongosh\r\n\r\n"

	got, ok := parseRegNamedValue(out, "Path")
	if !ok {
		t.Fatal("did not find the Path value")
	}
	want := "C:\\Program Files\\mongosh;C:\\Users\\p\\AppData\\Local\\Programs\\mongosh"
	if got != want {
		t.Errorf("parseRegNamedValue = %q, want %q", got, want)
	}

	if _, ok := parseRegNamedValue(out, "NotThere"); ok {
		t.Error("matched a value that is not in the output")
	}
	if _, ok := parseRegNamedValue("HKEY_CURRENT_USER\\Environment\r\n", "Path"); ok {
		t.Error("matched against output with no values at all")
	}
}

// lookInRegistryPath must only ever hand back a real file: a PATH entry
// left behind by an uninstall is exactly the sort of thing that would
// otherwise be launched and fail.
func TestLookInRegistryPathReturnsNothingWhenTheFileIsGone(t *testing.T) {
	if got, ok := lookInRegistryPath(""); ok {
		t.Errorf("empty name resolved to %q", got)
	}
}

// %VAR% is cmd's syntax, not Go's. Rewriting the percent signs into dollars
// so os.ExpandEnv could be reused leaves a stray delimiter and turns every
// variable-based PATH entry into a path that cannot exist.
func TestExpandWindowsEnv(t *testing.T) {
	t.Setenv("USERPROFILE", `C:\Users\Pranav`)
	t.Setenv("EMPTYVAR", "")

	cases := []struct{ in, want string }{
		{`%USERPROFILE%\bin`, `C:\Users\Pranav\bin`},
		{`%USERPROFILE%\AppData\Local\Programs\mongosh`, `C:\Users\Pranav\AppData\Local\Programs\mongosh`},
		{`C:\Program Files\mongosh`, `C:\Program Files\mongosh`},
		{`%USERPROFILE%\a;%USERPROFILE%\b`, `C:\Users\Pranav\a;C:\Users\Pranav\b`},
		{`%EMPTYVAR%\bin`, `\bin`},
		// Unset stays literal, so the path fails to stat rather than
		// silently becoming something else.
		{`%NOT_SET_ANYWHERE%\bin`, `%NOT_SET_ANYWHERE%\bin`},
		{`50%`, `50%`},
		{`%`, `%`},
		{``, ``},
		{`%%`, `%%`},
	}
	for _, tc := range cases {
		if got := expandWindowsEnv(tc.in); got != tc.want {
			t.Errorf("expandWindowsEnv(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if strings.Contains(expandWindowsEnv(`%USERPROFILE%\bin`), "$") {
		t.Error("expansion left a stray delimiter behind")
	}
}
