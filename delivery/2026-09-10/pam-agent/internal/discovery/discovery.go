// Package discovery finds locally-installed tools without ever requiring
// the operator to have the "obvious" one (e.g. psql) — it also tries
// well-known GUI alternatives (e.g. pgAdmin4) so pam-agent keeps working on
// a machine that only has the GUI client installed.
//
// Zero third-party dependencies, by the same invariant as the rest of this
// module: Windows registry lookups shell out to reg.exe (built into every
// Windows install) instead of linking golang.org/x/sys/windows/registry or
// similar.
package discovery

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Spec describes every place Locate should look for one candidate tool.
// Every field is optional and OS-scoped fields are only consulted on their
// matching runtime.GOOS — a Spec is safe to share verbatim across all three
// platforms in launch-templates.json.
type Spec struct {
	// BinaryNames are tried on PATH first, in order, via exec.LookPath —
	// the fast, common case on any OS where the tool installer put itself
	// on PATH (true for most CLI tools: psql, redis-cli, mongosh, ...).
	BinaryNames []string `json:"binary_names,omitempty"`

	// WindowsAppPaths are registry value names under both
	// HKLM/HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ — the
	// mechanism most Windows GUI installers (including pgAdmin4's) register
	// themselves under even when they don't touch PATH. Only consulted when
	// GOOS is windows.
	WindowsAppPaths []string `json:"windows_app_paths,omitempty"`

	// AbsolutePathGlobs are last-resort, OS-specific install locations,
	// keyed by runtime.GOOS ("windows" | "darwin" | "linux"). Glob patterns
	// may contain a version-folder wildcard (e.g.
	// `C:\Program Files\pgAdmin 4\*\pgAdmin4.exe"`) — matches are sorted
	// and the lexicographically last (typically newest version) one that
	// actually exists on disk wins.
	AbsolutePathGlobs map[string][]string `json:"absolute_path_globs,omitempty"`

	// MacAppBundles are `.app` bundle names (e.g. "pgAdmin 4.app") checked
	// under /Applications and ~/Applications. Only consulted when GOOS is
	// darwin. A hit here is launched via `open`, not by exec-ing a binary
	// path directly — see launcher's darwin Spawn for why.
	MacAppBundles []string `json:"mac_app_bundles,omitempty"`
}

// Result is what Locate found — exactly one of Path or AppBundle is set
// when Found() is true.
type Result struct {
	// Path is a directly-executable binary path (from PATH, the Windows
	// registry, or an absolute-path glob).
	Path string
	// AppBundle is a macOS .app bundle directory — launch it with
	// `open -a <AppBundle>`, not by exec-ing something inside it directly.
	AppBundle string
}

func (r Result) Found() bool { return r.Path != "" || r.AppBundle != "" }

// Locate tries, in order: PATH, the Windows "App Paths" registry,
// OS-specific absolute install locations, then (macOS only) common
// /Applications bundle names. Returns the zero Result if nothing matched.
func Locate(spec Spec) Result {
	for _, name := range spec.BinaryNames {
		if name == "" {
			continue
		}
		if p, err := exec.LookPath(name); err == nil {
			return Result{Path: p}
		}
	}

	if runtime.GOOS == "windows" {
		for _, key := range spec.WindowsAppPaths {
			if p, ok := queryWindowsAppPath(key); ok {
				return Result{Path: p}
			}
		}
		for _, name := range spec.BinaryNames {
			if p, ok := lookInRegistryPath(name); ok {
				return Result{Path: p}
			}
		}
	}

	if globs, ok := spec.AbsolutePathGlobs[runtime.GOOS]; ok {
		if p, ok := globLatestExisting(globs); ok {
			return Result{Path: p}
		}
	}

	if runtime.GOOS == "darwin" {
		for _, bundle := range spec.MacAppBundles {
			if p, ok := findMacAppBundle(bundle); ok {
				return Result{AppBundle: p}
			}
		}
	}

	return Result{}
}

// lookInRegistryPath searches the PATH as the REGISTRY currently records it,
// rather than the PATH this process inherited.
//
// On Windows those are routinely different, and the difference is invisible
// to the person hitting it. A pam-agent:// launch is started by Explorer via
// the registry URL handler, so it inherits Explorer's environment — which was
// captured at sign-in and is not updated when an installer appends to PATH.
// The operator opens a fresh terminal, types `mongosh --version`, sees it
// work, and reasonably concludes the tool is installed and on PATH; meanwhile
// exec.LookPath inside the agent is still searching the PATH from before the
// install and finds nothing, so the agent silently moves on to the next
// candidate. Confirmed in the field: mongosh installed and working in a
// terminal, and the agent selecting the desktop app instead without a word
// about why.
//
// Reading it back from the registry is the same trick queryWindowsAppPath
// already uses, and for the same reason: reg.exe ships with Windows, so this
// keeps the module's zero-third-party-dependency rule. HKCU\Environment is
// the per-user PATH, the machine-wide one lives under Session Manager, and
// both are consulted because either installer shape is common.
//
// Only ever returns a file that exists and is not a directory, so a stale
// PATH entry left behind by an uninstall cannot be handed back as a tool.
func lookInRegistryPath(name string) (string, bool) {
	if name == "" {
		return "", false
	}
	exts := []string{".exe", ".cmd", ".bat", ".com", ""}
	if filepath.Ext(name) != "" {
		exts = []string{""}
	}

	for _, dir := range registryPathDirs() {
		for _, ext := range exts {
			candidate := filepath.Join(dir, name+ext)
			if fi, err := os.Stat(candidate); err == nil && !fi.IsDir() {
				return candidate, true
			}
		}
	}
	return "", false
}

// registryPathDirs reads the user and machine PATH values out of the
// registry and returns their entries, user first so a per-user install wins
// over a machine-wide one, matching how Windows itself composes PATH.
func registryPathDirs() []string {
	sources := []struct{ key, value string }{
		{`HKCU\Environment`, "Path"},
		{`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`, "Path"},
	}

	var dirs []string
	seen := map[string]bool{}
	for _, src := range sources {
		out, err := exec.Command("reg", "query", src.key, "/v", src.value).Output()
		if err != nil {
			continue
		}
		raw, ok := parseRegNamedValue(string(out), src.value)
		if !ok {
			continue
		}
		for _, dir := range strings.Split(raw, ";") {
			dir = strings.TrimSpace(strings.Trim(strings.TrimSpace(dir), `"`))
			if dir == "" {
				continue
			}
			// PATH entries routinely contain %USERPROFILE% and friends;
			// reg.exe hands back the unexpanded REG_EXPAND_SZ text.
			dir = expandWindowsEnv(dir)
			if dir == "" || seen[strings.ToLower(dir)] {
				continue
			}
			seen[strings.ToLower(dir)] = true
			dirs = append(dirs, dir)
		}
	}
	return dirs
}

// expandWindowsEnv resolves %NAME% references the way cmd.exe does.
//
// Not os.ExpandEnv: that understands $NAME, and rewriting the percent signs
// into dollars to reuse it leaves a stray delimiter behind — %USERPROFILE%\\bin
// becomes "C:\\Users\\someone$\\bin", a path that cannot exist, so every
// variable-based PATH entry silently resolves to nothing. Verified before
// writing this.
//
// An unset variable leaves its reference untouched rather than collapsing to
// an empty string, so a half-resolved path fails to stat instead of pointing
// at a directory nobody meant. A lone unpaired percent is literal, as it is
// in cmd.
func expandWindowsEnv(s string) string {
	var b strings.Builder
	for {
		open := strings.IndexByte(s, '%')
		if open < 0 {
			b.WriteString(s)
			return b.String()
		}
		close := strings.IndexByte(s[open+1:], '%')
		if close < 0 {
			b.WriteString(s)
			return b.String()
		}
		close += open + 1

		b.WriteString(s[:open])
		name := s[open+1 : close]
		if value, ok := os.LookupEnv(name); ok && name != "" {
			b.WriteString(value)
		} else {
			b.WriteString(s[open : close+1])
		}
		s = s[close+1:]
	}
}

// parseRegNamedValue pulls one named value out of `reg query ... /v <name>`
// output, whose data column is the fourth whitespace-separated field and may
// itself contain spaces.
func parseRegNamedValue(out, name string) (string, bool) {
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 3 || !strings.EqualFold(fields[0], name) {
			continue
		}
		if !strings.HasPrefix(strings.ToUpper(fields[1]), "REG_") {
			continue
		}
		idx := strings.Index(line, fields[1])
		value := strings.TrimSpace(line[idx+len(fields[1]):])
		if value != "" {
			return value, true
		}
	}
	return "", false
}

// globLatestExisting expands every glob pattern, sorts all matches
// descending, and returns the first one that stats as a regular file —
// version-folder globs (".../v*/pgAdmin4.exe") sort so a newer version
// folder is preferred over an older one left behind by an upgrade.
func globLatestExisting(patterns []string) (string, bool) {
	var all []string
	for _, pattern := range patterns {
		matches, err := filepath.Glob(expandHome(pattern))
		if err != nil {
			continue
		}
		all = append(all, matches...)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(all)))
	for _, m := range all {
		if fi, err := os.Stat(m); err == nil && !fi.IsDir() {
			return m, true
		}
	}
	return "", false
}

// expandHome turns a leading "~/" into this user's home directory.
// filepath.Glob has no notion of "~" — it is a shell convention, and a
// pattern starting with one simply matches a literal directory named "~",
// which never exists. Windows patterns can name the user directly
// (C:\Users\*\...) because the layout is fixed; macOS and Linux cannot,
// so without this there is no way to write a glob for anything under the
// operator's own home, which is exactly where a tool downloaded and
// unpacked by hand ends up.
//
// A pattern that does not start with "~/" is returned untouched, and so is
// one where the home directory cannot be determined, in which case the
// glob simply finds nothing rather than matching somewhere unintended.
func expandHome(pattern string) string {
	if !strings.HasPrefix(pattern, "~/") {
		return pattern
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return pattern
	}
	return filepath.Join(home, pattern[2:])
}

func findMacAppBundle(name string) (string, bool) {
	candidates := []string{filepath.Join("/Applications", name)}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		candidates = append(candidates, filepath.Join(home, "Applications", name))
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && fi.IsDir() {
			return c, true
		}
	}
	return "", false
}

// queryWindowsAppPath shells out to reg.exe (present on every Windows
// install) rather than linking a registry-access package, preserving this
// module's zero-third-party-dependency invariant. Tries HKLM then HKCU —
// a per-machine install typically registers under HKLM, a per-user install
// (common for things users install without admin rights) under HKCU.
func queryWindowsAppPath(exeName string) (string, bool) {
	for _, root := range []string{"HKLM", "HKCU"} {
		key := fmt.Sprintf(`%s\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%s`, root, exeName)
		out, err := exec.Command("reg", "query", key, "/ve").Output()
		if err != nil {
			continue
		}
		if p, ok := parseRegDefaultValue(string(out)); ok {
			return p, true
		}
	}
	return "", false
}

// parseRegDefaultValue pulls the path out of `reg query <key> /ve` output:
//
//	HKEY_LOCAL_MACHINE\...\App Paths\pgAdmin4.exe
//	    (Default)    REG_SZ    C:\Program Files\pgAdmin 4\8\pgAdmin4.exe
func parseRegDefaultValue(out string) (string, bool) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		idx := strings.Index(line, "REG_SZ")
		if idx == -1 {
			continue
		}
		val := strings.TrimSpace(line[idx+len("REG_SZ"):])
		val = strings.Trim(val, `"`)
		if val != "" && val != "(value not set)" {
			return val, true
		}
	}
	return "", false
}
