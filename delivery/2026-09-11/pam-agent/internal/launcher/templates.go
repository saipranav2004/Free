// pam-agent/internal/launcher/templates.go
package launcher

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/template"

	"github.com/yourorg/pam-agent/internal/apiclient"
	"github.com/yourorg/pam-agent/internal/discovery"
)

//go:embed launch-templates.default.json
var defaultTemplatesJSON []byte

// LoadTemplates reads launch-templates.json from configDir, writing the
// built-in defaults there first if no file exists yet — so `pam-agent` works
// out of the box, but an admin can edit that file afterward (add more
// resource types or candidates, point at a differently-installed binary,
// change discovery paths, change args) without recompiling anything.
//
// Each resource type maps to an ORDERED LIST of candidates — e.g. Postgres
// tries "psql" first and falls back to "pgAdmin4" if psql isn't installed —
// rather than a single fixed tool, so a machine that only has the GUI
// client still works.
func LoadTemplates(configDir string) (map[string][]Candidate, error) {
	path := filepath.Join(configDir, "launch-templates.json")

	if err := refreshUneditedTemplates(path); err != nil {
		return nil, err
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read %s: %w", path, err)
	}

	var templates map[string][]Candidate
	if err := json.Unmarshal(raw, &templates); err != nil {
		return nil, fmt.Errorf("failed to parse %s: %w", path, err)
	}
	return templates, nil
}

// templateData is what {{.Host}}-style placeholders in a Candidate's Args
// (or a "browser" Candidate's Command) resolve against. Password is
// deliberately NOT exposed here — every injection strategy in credential.go
// handles the credential explicitly and separately, so a plain
// arg-templating mistake can never leak it into a process's command line.
type templateData struct {
	Host         string
	Port         string
	DatabaseName string
	AccountName  string
	ConsoleURL   string
}

// stampFileName sits next to launch-templates.json holding the SHA-256 of
// whatever this agent last wrote there. It is the only way to tell an
// untouched copy of a previous release's defaults from a file an operator
// has deliberately edited.
const stampFileName = "launch-templates.defaults.sha256"

// refreshUneditedTemplates makes launch-templates.json track the agent that
// reads it, without ever discarding an operator's own edits.
//
// This file used to be written once, on first run, and then left alone
// forever. Since agent upgrades are manual redistribution (see CONTEXT.md's
// "No auto-update"), that meant a machine which had run ANY earlier version
// kept that version's launch templates permanently: a new binary shipped
// with new candidates, new tool-discovery paths and new command-line
// arguments, and none of it could ever take effect. Confirmed in the field
// twice — an operator on a current binary was still being sent to a desktop
// app by a template file written months earlier, and the arguments meant to
// suppress that app's connection prompt were absent for the same reason.
// Nothing in the logs said so, because from the agent's point of view it was
// faithfully following its configuration.
//
// The stamp file is what makes this safe. Every write records the hash of
// what was written, so on the next run there are exactly three cases:
//
//   - no file: first run. Write the defaults and stamp them.
//   - file still hashes to the stamp: nobody has touched it since this agent
//     wrote it, so replacing it loses nothing. Write the new defaults.
//   - file hashes to anything else: an operator edited it. Leave it exactly
//     as it is — launch-templates.json is documented as the place to point
//     the agent at a tool in an unusual location, and silently reverting
//     that would be a worse bug than the one this fixes.
//
// The fourth case is the one that matters right now: a file written before
// the stamp existed, which is every machine already in the field. There is
// no way to tell those apart from an edited file, and treating them as
// edited would mean this fix never reaches the machines that need it —
// the stamp would start protecting exactly the stale content it was added
// to replace. So a stampless file is migrated once: the old content is kept
// beside it as launch-templates.json.bak, the current defaults are written,
// and from then on the stamp tells the two cases apart properly. An
// operator who had customised that file gets their version back from the
// .bak, which is a worse outcome than not touching it but a far better one
// than a fleet permanently frozen on templates nobody can update.
func refreshUneditedTemplates(path string) error {
	current, readErr := os.ReadFile(path)
	if readErr != nil && !os.IsNotExist(readErr) {
		return fmt.Errorf("failed to read %s: %w", path, readErr)
	}

	if readErr == nil {
		if bytes.Equal(current, defaultTemplatesJSON) {
			writeTemplateStamp(path) // adopt a file that already matches
			return nil
		}
		switch stamped, matches := templateStamp(path), stampMatches(path, sha256.Sum256(current)); {
		case stamped && !matches:
			return nil // operator-edited since this agent wrote it: theirs wins.
		case !stamped:
			// Pre-stamp file. Keep a copy before replacing it, so an
			// operator who had customised this is one rename away from
			// their version rather than having lost it.
			_ = os.WriteFile(path+".bak", current, 0o644)
		}
	}

	if err := os.WriteFile(path, defaultTemplatesJSON, 0o644); err != nil {
		if readErr == nil {
			return nil // keep running on the templates already on disk
		}
		return fmt.Errorf("failed to write default launch-templates.json: %w", err)
	}
	writeTemplateStamp(path)
	return nil
}

// templateStamp reports whether a stamp file exists at all, which is what
// separates "an operator changed this" from "this predates the mechanism".
func templateStamp(templatesPath string) bool {
	_, err := os.Stat(stampPath(templatesPath))
	return err == nil
}

func stampPath(templatesPath string) string {
	return filepath.Join(filepath.Dir(templatesPath), stampFileName)
}

func stampMatches(templatesPath string, sum [32]byte) bool {
	recorded, err := os.ReadFile(stampPath(templatesPath))
	if err != nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(string(recorded)), hex.EncodeToString(sum[:]))
}

// writeTemplateStamp is best-effort: without it the next run simply treats
// the file as operator-edited and leaves it alone, which is the safe way to
// be wrong.
func writeTemplateStamp(templatesPath string) {
	sum := sha256.Sum256(defaultTemplatesJSON)
	_ = os.WriteFile(stampPath(templatesPath), []byte(hex.EncodeToString(sum[:])+"\n"), 0o644)
}

// SelectAndBuildCommand walks a resource type's candidate list in order —
// reordered first by any "preferred_tool" hint in the resource's
// ExtraConfig (set by an admin on the PAM backend; see reorderByPreferred)
// — and builds a PreparedCommand from the first one that's actually usable
// on this machine:
//   - a "browser" candidate is always usable (no discovery needed)
//   - any other candidate is usable only if discovery.Locate finds its tool
//
// Returns the Candidate actually chosen (for logging) alongside the
// command, or an error listing every candidate ID that was tried and not
// found if none of them are usable.
func SelectAndBuildCommand(resolved *apiclient.ResolvedLaunch, candidates []Candidate, tempDir string, log *slog.Logger) (*PreparedCommand, *Candidate, error) {
	return SelectAndBuildRecordable(resolved, candidates, tempDir, log, nil)
}

// ErrNoRecordableCandidate means every candidate this machine could otherwise
// have used opens in a way this machine cannot record, on a resource PAM
// requires to be recorded. The Candidate returned alongside it is the FIRST
// one that was skipped, which is the one the operator should be told about:
// it is the tool they would have got, and the highest-priority thing they
// could make work.
var ErrNoRecordableCandidate = errors.New("no candidate on this machine can be recorded")

// SelectAndBuildRecordable is SelectAndBuildCommand plus one rule: a candidate
// that is installed and usable is still SKIPPED when its launch could not be
// recorded and this resource must be. canRecord answers that for a launch
// mode ("cli", "gui", "browser"); nil turns the rule off entirely, which is
// what SelectAndBuildCommand passes and why nothing else changed behaviour.
//
// WHY THE CHECK BELONGS INSIDE THE WALK. It used to sit after it: the caller
// picked the first usable candidate, then asked whether the obligation could
// be met, and refused the whole launch if it could not. That was harmless
// only for as long as a recordable CLI was first in every list. The moment a
// DESKTOP app went first (Oracle, where SQL Developer is the tool operators
// actually use), a machine with SQL Developer, no ffmpeg and a perfectly good
// sqlplus refused the launch outright rather than falling through to the
// client it could record. Measured against the real agent before this existed:
// end=FAILED, code=recorder_not_installed, with sqlplus installed.
//
// The obligation is never weakened by this. A candidate is skipped, never
// downgraded to an unrecorded launch, and when every one of them is skipped
// the launch still fails.
func SelectAndBuildRecordable(resolved *apiclient.ResolvedLaunch, candidates []Candidate, tempDir string, log *slog.Logger, canRecord func(mode string) bool) (*PreparedCommand, *Candidate, error) {
	ordered := reorderByPreferred(candidates, resolved.ExtraConfig)

	// skip reports whether this prepared command has to be passed over, and
	// records why. Kept as a closure so both arms of the loop use the one
	// rule rather than two that can drift.
	var skipped []Candidate
	skip := func(cand *Candidate, cmd *PreparedCommand) bool {
		if canRecord == nil || cmd == nil || canRecord(cmd.Mode) {
			return false
		}
		skipped = append(skipped, *cand)
		log.Info("launch.candidate.unrecordable", "resource_type", resolved.ResourceType,
			"candidate", cand.ID, "mode", cmd.Mode,
			"note", "this resource must be recorded and this machine cannot record that mode")
		return true
	}

	var tried []MissingTool
	for i := range ordered {
		cand := &ordered[i]

		if cand.Kind == "browser" {
			cmd, err := buildBrowserCommand(resolved, cand)
			if err != nil {
				// A browser candidate that cannot be built is unusable for
				// THIS resource, not a reason to abandon the search. It used
				// to return immediately, and because a browser candidate is
				// usually last in the list, its error replaced the one the
				// operator needed: a MongoDB resource with no console_url and
				// no mongosh installed reported "an admin needs to set
				// console_url" and never mentioned mongosh at all. Observed
				// running the real agent against a real launch, not inferred.
				//
				// Recorded with its own reason rather than an install hint,
				// since nothing here is installable: what is missing is
				// configuration on the PAM resource.
				tried = append(tried, MissingTool{
					ID: cand.ID, Kind: cand.Kind, Command: cand.Command,
					Detail: "This resource has no web console configured. An administrator can set console_url on it.",
				})
				log.Debug("launch.candidate.unusable", "resource_type", resolved.ResourceType,
					"candidate", cand.ID, "kind", "browser", "error", err.Error())
				continue
			}
			if skip(cand, cmd) {
				continue
			}
			log.Info("launch.candidate.selected", "resource_type", resolved.ResourceType, "candidate", cand.ID, "kind", "browser")
			return cmd, cand, nil
		}

		result := discovery.Locate(cand.Discovery)
		if !result.Found() {
			tried = append(tried, MissingTool{ID: cand.ID, Kind: cand.Kind, Command: cand.Command, InstallHint: cand.InstallHint})
			log.Debug("launch.candidate.not_found", "resource_type", resolved.ResourceType, "candidate", cand.ID)
			continue
		}

		cmd, err := buildCommand(resolved, cand, result, tempDir)
		if err != nil {
			return nil, cand, err
		}
		if skip(cand, cmd) {
			continue
		}
		log.Info("launch.candidate.selected", "resource_type", resolved.ResourceType, "candidate", cand.ID, "kind", cand.Kind,
			"path", result.Path, "app_bundle", result.AppBundle)
		return cmd, cand, nil
	}

	if len(ordered) == 0 {
		return nil, nil, &NoCandidatesError{ResourceType: resolved.ResourceType}
	}
	// Something WAS installed and would have opened; the only thing stopping
	// it is the recording obligation. Saying "none of these tools are
	// installed" here would be false, and would send the operator to install
	// something they already have.
	if len(skipped) > 0 {
		return nil, &skipped[0], ErrNoRecordableCandidate
	}
	return nil, nil, &ToolNotFoundError{ResourceType: resolved.ResourceType, Tried: tried}
}

// NoCandidatesError means this agent has no entry at all for the resource
// type — a template file that predates the type, or a type nobody has
// taught the agent about yet. Distinct from ToolNotFoundError, because the
// fix is an administrator's, not the operator's.
type NoCandidatesError struct {
	ResourceType string
}

func (e *NoCandidatesError) Error() string {
	return fmt.Sprintf("this machine's PAM agent has no launch configuration for %q resources", e.ResourceType)
}

// Reason is the one-line summary sent to PAM and shown in the console.
func (e *NoCandidatesError) Reason() string { return e.Error() }

// Hint is the actionable half, kept separate so the console can present it
// as guidance rather than as part of the failure.
func (e *NoCandidatesError) Hint() string {
	return "Update the local agent, or add an entry for this resource type to launch-templates.json."
}

// Code is a stable identifier the console can branch on without parsing
// English.
func (e *NoCandidatesError) Code() string { return "no_launch_candidates" }

// MissingTool is one candidate that could not be used, and why.
//
// The distinction that matters is Kind. A "cli" or "gui" candidate is missing
// because the operator has not installed it, and the answer is an install
// hint. A "browser" candidate is never missing — every machine has a browser —
// so when one is unusable the fault is in the resource's configuration on the
// PAM server, and telling the operator to install something would send them
// after a problem that is not theirs and cannot be fixed from their laptop.
type MissingTool struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Command string `json:"command"`

	// InstallHint is set for an installable candidate; see Candidate.
	InstallHint string `json:"install_hint,omitempty"`

	// Detail is why a browser candidate was unusable, in the operator's terms.
	Detail string `json:"detail,omitempty"`
}

// installable reports whether an operator could resolve this one themselves.
func (m MissingTool) installable() bool { return m.Kind != "browser" }

// ToolNotFoundError means every tool that could open this resource type is
// absent from this machine.
//
// This used to be a bare fmt.Errorf, and the string went to the stderr of a
// process the operating system had launched with no terminal attached — so
// in practice it went nowhere. The operator clicked Connect, nothing opened,
// and PAM showed a session that had simply failed. Keeping the tried
// candidates structured is what lets the agent hand PAM a reason and an
// install hint the console can actually render.
type ToolNotFoundError struct {
	ResourceType string
	Tried        []MissingTool
}

func (e *ToolNotFoundError) Error() string {
	names := make([]string, 0, len(e.Tried))
	for _, t := range e.Tried {
		names = append(names, t.ID)
	}
	if len(e.installable()) == 0 {
		return fmt.Sprintf("no usable way to open resource type %q on this machine — tried: %s. %s",
			e.ResourceType, strings.Join(names, ", "), e.configDetail())
	}
	return fmt.Sprintf(
		"no installed tool found for resource type %q — tried: %s (none were on PATH or in their usual install location). "+
			"Install one of these, or edit launch-templates.json to point at where it's actually installed on this machine",
		e.ResourceType, strings.Join(names, ", "))
}

// installable is the subset the operator could fix by installing something.
func (e *ToolNotFoundError) installable() []MissingTool {
	var out []MissingTool
	for _, t := range e.Tried {
		if t.installable() {
			out = append(out, t)
		}
	}
	return out
}

// configDetail is what the unusable browser candidates had to say, which is
// the whole story when there was nothing installable to begin with.
func (e *ToolNotFoundError) configDetail() string {
	for _, t := range e.Tried {
		if !t.installable() && strings.TrimSpace(t.Detail) != "" {
			return t.Detail
		}
	}
	return ""
}

// Reason names the tools rather than the resource type, because that is the
// half the operator can act on.
//
// When nothing was installable — a resource whose only candidate opens a web
// console, and that console is not configured — it says so instead, rather
// than telling someone to install a browser they already have.
func (e *ToolNotFoundError) Reason() string {
	installable := e.installable()
	if len(installable) == 0 {
		if detail := e.configDetail(); detail != "" {
			return detail
		}
		return fmt.Sprintf("This %s resource cannot be opened from this machine.", e.ResourceType)
	}
	if len(installable) == 1 {
		return fmt.Sprintf("%s is not installed on this machine.", installable[0].ID)
	}
	names := make([]string, 0, len(installable))
	for _, t := range installable {
		names = append(names, t.ID)
	}
	return fmt.Sprintf("None of the tools that can open %s resources are installed on this machine: %s.",
		e.ResourceType, strings.Join(names, ", "))
}

// Hint is the per-tool install guidance from launch-templates.json, joined
// in candidate order so the tool the fleet prefers is named first, followed
// by anything the unusable browser candidates had to add. Falls back to
// naming the executables when a template carries no hint, which is still more
// use than naming nothing.
func (e *ToolNotFoundError) Hint() string {
	installable := e.installable()

	var hints []string
	for _, t := range installable {
		if strings.TrimSpace(t.InstallHint) != "" {
			hints = append(hints, t.ID+": "+t.InstallHint)
		}
	}

	var lead string
	switch {
	case len(hints) > 0:
		lead = "Install any one of these, then try again. " + strings.Join(hints, "  ")
	case len(installable) > 0:
		var cmds []string
		for _, t := range installable {
			if t.Command != "" {
				cmds = append(cmds, t.Command)
			}
		}
		if len(cmds) > 0 {
			lead = "Install one of: " + strings.Join(cmds, ", ") + "."
		}
	}

	// Configuration notes come last: they are an administrator's job, so they
	// are context for the operator rather than the thing to go and do.
	for _, t := range e.Tried {
		if !t.installable() && strings.TrimSpace(t.Detail) != "" {
			if lead != "" {
				lead += " "
			}
			lead += t.Detail
			break
		}
	}
	return lead
}

// Code separates the two so the console can branch without reading English:
// one is the operator's to fix, the other an administrator's.
func (e *ToolNotFoundError) Code() string {
	if len(e.installable()) == 0 {
		return "resource_not_openable"
	}
	return "tool_not_installed"
}

// reorderByPreferred moves the candidate whose ID matches
// extraConfig["preferred_tool"] to the front of the list, leaving the rest
// of the fallback order intact. This is the ONLY way the PAM backend can
// influence which local tool gets used — it names a candidate ID already
// baked into this machine's launch-templates.json, never an arbitrary path
// or command. A backend that wants "always use pgAdmin4 for this resource"
// sets extra_config: {"preferred_tool": "pgadmin4"} on the resource; a
// backend trying to make the agent run something unexpected has no lever
// to pull here at all — deliberately.
func reorderByPreferred(candidates []Candidate, extraConfig map[string]interface{}) []Candidate {
	preferred, _ := extraConfig["preferred_tool"].(string)
	if preferred == "" {
		return candidates
	}
	idx := -1
	for i, c := range candidates {
		if c.ID == preferred {
			idx = i
			break
		}
	}
	if idx <= 0 {
		return candidates
	}
	out := make([]Candidate, 0, len(candidates))
	out = append(out, candidates[idx])
	out = append(out, candidates[:idx]...)
	out = append(out, candidates[idx+1:]...)
	return out
}

func buildCommand(resolved *apiclient.ResolvedLaunch, cand *Candidate, located discovery.Result, tempDir string) (*PreparedCommand, error) {
	dbName := resolved.DatabaseName
	if dbName == "" && resolved.ResourceType == "postgresql" {
		dbName = "postgres" // matches the browser session gateway's own default
	}

	data := templateData{
		Host:         resolved.Host,
		Port:         strconv.Itoa(resolved.Port),
		DatabaseName: dbName,
		AccountName:  resolved.AccountName,
		ConsoleURL:   resolved.ConsoleURL,
	}

	args, err := renderArgs(cand.Args, data)
	if err != nil {
		return nil, fmt.Errorf("failed to render command arguments for candidate %s: %w", cand.ID, err)
	}

	execPath := located.Path
	if execPath == "" {
		// macOS app-bundle-only hit (no direct binary path) — Exec carries
		// the bundle name for logging/Title purposes; the darwin Spawn
		// implementation launches AppBundle via `open -a`, not Exec.
		execPath = cand.Command
	}

	cmd := &PreparedCommand{
		Exec:      execPath,
		Args:      args,
		Mode:      cand.Kind,
		Title:     fmt.Sprintf("PAM — %s (%s)", resolved.ResourceType, cand.ID),
		AppBundle: located.AppBundle,
	}

	switch cand.CredentialInjection {
	case "", "none":
		// nothing to inject
	case "env":
		if cand.CredentialEnvVar == "" {
			return nil, fmt.Errorf("candidate %s uses env credential injection but has no credential_env_var set", cand.ID)
		}
		cmd.Env = append(cmd.Env, cand.CredentialEnvVar+"="+resolved.Password)
	case "pgpass":
		pgpassPath, err := writePgpassFile(tempDir, data.Host, data.Port, dbName, resolved.AccountName, resolved.Password)
		if err != nil {
			return nil, err
		}
		cmd.Env = append(cmd.Env, "PGPASSFILE="+pgpassPath)
		cmd.CleanupFiles = append(cmd.CleanupFiles, pgpassPath)
	case "mongo_init_file":
		initPath, err := writeMongoInitFile(tempDir, resolved)
		if err != nil {
			return nil, err
		}
		// A connection specifier FIRST, then the init file. Both positional,
		// and the order is what tells them apart. See mongoStartupURI for
		// why the specifier has to be here at all, and dropNodb for why
		// --nodb cannot be.
		cmd.Args = append(dropNodb(cmd.Args), mongoStartupURI(resolved), "--shell", initPath)
		cmd.CleanupFiles = append(cmd.CleanupFiles, initPath)
	case "clickhouse_config_file":
		configPath, err := writeClickhouseConfigFile(tempDir, resolved)
		if err != nil {
			return nil, err
		}
		cmd.Args = append(cmd.Args, "--config-file", configPath)
		cmd.CleanupFiles = append(cmd.CleanupFiles, configPath)
	case "connection_string_arg":
		// Best-effort GUI path (e.g. MongoDB Compass, which accepts a
		// connection string as its first CLI argument). This is the one
		// injection mode where the credential IS present in the argument
		// list, and therefore briefly visible to other processes/tools that
		// can read this process's command line (ps, Task Manager, etc.) —
		// documented in the README as a real, known tradeoff of this mode,
		// not hidden. Prefer "env"/"pgpass"/"mongo_init_file" wherever the
		// target tool supports it.
		cmd.Args = ensureCompassTrustsConnectionString(cmd.Args, cand.Command, cmd.Exec, cmd.AppBundle)
		cmd.Args = append(cmd.Args, buildConnectionString(resolved, dbName))
	case "oracle_login_script":
		// `/nolog` first so the tool starts with no session at all, then
		// `@<path>` to run the CONNECT out of a 0600 file. The path is
		// deliberately NOT quoted: SQL*Plus takes everything after the @ as
		// the file name, so a directory containing a space works as-is,
		// while quoting it produces "SP2-0310: unable to open file". Both
		// checked against SQL*Plus 23.26 rather than assumed.
		scriptPath, err := writeOracleLoginScript(tempDir, resolved, dbName)
		if err != nil {
			return nil, err
		}
		cmd.Args = append(cmd.Args, "/nolog", "@"+scriptPath)
		cmd.CleanupFiles = append(cmd.CleanupFiles, scriptPath)
	case "clipboard":
		// For a GUI that offers no way to be handed a credential from
		// outside — Oracle SQL Developer is one; it takes no connection on
		// its command line at all — the closest thing to "already logged
		// in" is landing on its login dialog with the password one paste
		// away. Same treatment browser consoles already get; see
		// CopyPasswordToClipboard.
		cmd.CopyPasswordToClipboard = true
	case "oracle_connect_string":
		// sqlplus/SQLcl's own EZCONNECT logon syntax — see
		// buildOracleConnectString for why this isn't just another branch
		// of buildConnectionString above.
		connStr, err := buildOracleConnectString(resolved, dbName)
		if err != nil {
			return nil, err
		}
		cmd.Args = append(cmd.Args, connStr)
	case "minio_mc_shell":
		// mc was confirmed installed by discovery above (that's what
		// execPath/located.Path just resolved), but mc itself has no
		// interactive REPL to exec directly — see resolveInteractiveShell's
		// doc comment. So this candidate's real payload is the operator's
		// own shell, with MC_HOST_pam already exported: every `mc ls
		// pam/...`, `mc cp ...`, etc. they type from that shell is already
		// authenticated, with nothing ever written to argv or to this
		// machine's own ~/.mc/config.json.
		shellPath, err := resolveInteractiveShell()
		if err != nil {
			return nil, fmt.Errorf("found mc, but %w — install one, or edit launch-templates.json to use a different minio candidate", err)
		}

		// mc's OWN DIRECTORY GOES ON PATH, not just the credential.
		//
		// This candidate is the one that hands the operator a shell instead
		// of running the tool, so "discovery found mc" is not enough on its
		// own: the shell has to be able to resolve `mc` too. Discovery
		// locates it by absolute path (C:\mc\mc.exe, /usr/local/bin/mc, an
		// absolute_path_globs hit) just as readily as it finds it on PATH,
		// and in the absolute-path case the shell inherits no knowledge of
		// where it went.
		//
		// Confirmed live on Windows with mc at C:\mc\mc.exe: the session
		// opened, MC_HOST_pam was set correctly, and the very first command
		// the operator was told to type answered "'mc' is not recognized as
		// an internal or external command" — an authenticated session in
		// which nothing could be run. Prepending, so a copy already on PATH
		// still wins for anything else the operator does in that shell.
		if mcDir := filepath.Dir(execPath); mcDir != "" && mcDir != "." {
			cmd.Env = append(cmd.Env, "PATH="+mcDir+string(os.PathListSeparator)+os.Getenv("PATH"))
		}

		cmd.Exec = shellPath
		cmd.Args = nil
		cmd.Title = fmt.Sprintf("PAM — %s (mc alias %q ready)", resolved.ResourceType, "pam")
		cmd.Env = append(cmd.Env, buildMinIOAliasEnv(resolved))
	case "langfuse_cli_shell":
		// Langfuse's CLI is one-shot: `langfuse api <resource> <action>` runs
		// a single call and exits, exactly like mc. Exec-ing it directly
		// would open a terminal that printed usage and closed, so this
		// candidate hands the operator their own shell with the three
		// LANGFUSE_* variables already exported. Every `langfuse api ...`
		// they type is authenticated, and because the shell is what runs
		// inside the relay, the whole session is recorded the same way a
		// psql session is.
		shellPath, err := resolveInteractiveShell()
		if err != nil {
			return nil, fmt.Errorf("found the Langfuse CLI, but %w. Install one, or edit launch-templates.json to use a different langfuse candidate", err)
		}
		// The CLI's own directory goes on PATH for the same reason mc's
		// does: discovery resolves an absolute path just as readily as a
		// PATH hit, and in that case the shell inherits no idea where the
		// binary went. Prepended, so a copy already on PATH still wins.
		if cliDir := filepath.Dir(execPath); cliDir != "" && cliDir != "." {
			cmd.Env = append(cmd.Env, "PATH="+cliDir+string(os.PathListSeparator)+os.Getenv("PATH"))
		}
		cmd.Exec = shellPath
		cmd.Args = nil
		cmd.Title = fmt.Sprintf("PAM — %s (langfuse CLI ready)", resolved.ResourceType)
		cmd.Env = append(cmd.Env, buildLangfuseEnv(resolved)...)
	case "pgadmin_preseed":
		// Best-effort: registers host/port/username (NEVER the password)
		// into pgAdmin4's own server tree via its documented --load-servers
		// mechanism, run as a separate pre-step before the GUI itself
		// launches. See pgadmin_preseed.go — failure here is logged and
		// swallowed, not fatal, since pgAdmin4 still opens fine without it
		// and this mechanism is known to vary across pgAdmin4 install types.
		preseedPath, err := writePgAdminServersFile(tempDir, resolved, dbName)
		if err != nil {
			return nil, err
		}
		cmd.CleanupFiles = append(cmd.CleanupFiles, preseedPath)
		cmd.PreseedLoadServersPath = preseedPath

		// CONFIRMED LIVE: setting PGPASSFILE here (the same libpq mechanism
		// psql's own "pgpass" case relies on) does NOT suppress pgAdmin4's
		// password prompt — its "Connect to Server" dialog is pgAdmin4's own
		// UI-level gate, shown unconditionally on first connect BEFORE it
		// ever attempts a real libpq/psycopg2 connection, so PGPASSFILE is
		// never consulted at all. This is a hard limit of pgAdmin4 itself,
		// not something fixable from the agent side — do not re-attempt a
		// PGPASSFILE/env-based approach here without first confirming
		// pgAdmin4 has changed this behavior. Clipboard is the closest thing
		// left to "already logged in" for this specific GUI tool; psql (this
		// resource type's preferred candidate) remains the fully headless
		// path — see CopyPasswordToClipboard's doc comment.
		cmd.CopyPasswordToClipboard = true
	default:
		return nil, fmt.Errorf("unknown credential_injection %q for candidate %s", cand.CredentialInjection, cand.ID)
	}

	return cmd, nil
}

// mongoStartupURI is the connection string handed to mongosh on the command
// line: the real host and port, and deliberately NO credential.
//
// It exists to stop mongosh interrupting the session with "Please enter a
// MongoDB connection string (Default: mongodb://localhost/):" before the
// operator can do anything. That prompt is not a misconfiguration, it is
// mongosh's own behaviour, and its condition is visible in the shipped
// binary: no connection specifier on the command line, running on Windows,
// stdin and stdout both a TTY, and mongosh the only process attached to its
// console. A pam-agent launch satisfies every one of those, because the
// session gets a brand new console with nothing in it but mongosh — the
// exact shape of a double-click, which is what the check is there to catch.
// Reproduced here and then fixed against a real authenticating mongod.
//
// There is no flag to switch the prompt off; the only lever is to give
// mongosh a specifier, so that is what this does. The credential still goes
// in the init file rather than argv, which is the whole point of that file:
// a connection string on the command line is readable by anything that can
// list processes. Host and port are not secret — the agent prints them to
// the operator's own terminal as it launches — so putting them here costs
// nothing.
//
// mongosh connects to this unauthenticated at startup, then the init file
// opens the authenticated connection and rebinds db. Verified against
// MongoDB 7.0 with --auth: the startup connection is accepted in silence,
// the init file authenticates, and db.runCommand({connectionStatus:1})
// reports the expected user.
func mongoStartupURI(resolved *apiclient.ResolvedLaunch) string {
	return fmt.Sprintf("mongodb://%s:%d/", resolved.Host, resolved.Port)
}

// dropNodb removes --nodb from a mongosh argument list.
//
// --nodb and a connection specifier cannot be used together: with --nodb
// present mongosh stops treating the first positional as a connection
// string and tries to open it as a script file instead, failing with
// "ENOENT: no such file or directory, open '/tmp/mongodb:/...'". Verified
// directly rather than reasoned about.
//
// This agent's own templates no longer carry --nodb, but the templates
// actually in use live in a file on the operator's disk that may be older
// than this binary, and a leftover --nodb there would turn every MongoDB
// session into that error. Removing it here costs nothing when it is
// already absent.
func dropNodb(args []string) []string {
	out := args[:0:0]
	for _, a := range args {
		if strings.EqualFold(a, "--nodb") {
			continue
		}
		out = append(out, a)
	}
	return out
}

// compassTrustFlag stops MongoDB Compass putting up "Are you sure that you
// want to proceed? This MongoDB connection string contains options that are
// typically not set by default and may present a security risk", with the
// credential on screen and a Connect button, on every single launch.
// Documented as "Suppresses warnings about disallowed connection string
// properties and allows automatic connection".
const compassTrustFlag = "--trustedConnectionString"

// ensureCompassTrustsConnectionString adds that flag for Compass even when
// the machine's launch-templates.json does not carry it.
//
// The flag belongs in the template, and it is there. It is repeated here
// because the template is a file on the operator's disk that this agent
// cannot count on: it may predate the flag, or an operator may have edited
// the file for an unrelated reason and pinned an older candidate definition
// in the process. Both were observed. A Compass launch that stops on a
// confirmation dialog is indistinguishable from a broken launch to the
// person watching it, so this is worth asserting from code rather than
// hoping the configuration is current.
//
// Matched on the template's command name AND on whatever was actually
// resolved on disk, so it holds whether the operator's file says
// MongoDBCompass, discovery landed on MongoDBCompass.exe, or macOS handed
// back the MongoDB Compass.app bundle. Anything else using
// connection_string_arg is left alone: the flag is Compass-specific and
// would be an unknown argument elsewhere.
func ensureCompassTrustsConnectionString(args []string, command, execPath, appBundle string) []string {
	target := strings.ToLower(strings.Join([]string{
		command, filepath.Base(execPath), filepath.Base(appBundle),
	}, " "))
	if !strings.Contains(target, "compass") {
		return args
	}
	for _, a := range args {
		if strings.EqualFold(a, compassTrustFlag) {
			return args
		}
	}
	return append(args, compassTrustFlag)
}

// buildBrowserCommand renders a "browser" candidate's Command as the URL to
// open. Most "browser" resources (Langfuse, Metabase, Qdrant's dashboard)
// have no credential involved at all — the operator authenticates in the
// browser itself, same as if they'd typed the URL in by hand.
//
// "clipboard" is the one exception: a resource whose web console has no
// auto-login mechanism this agent can drive from outside the browser (see
// MinIO's entry in launch-templates.default.json — its console API rejects
// both a plain HTML form POST, wrong content-type, and a cross-origin
// fetch/XHR, no CORS preflight support at all) still gets the password onto
// the clipboard, so logging in is one paste instead of retyping/copying it
// out of PAM's own UI separately.
func buildBrowserCommand(resolved *apiclient.ResolvedLaunch, cand *Candidate) (*PreparedCommand, error) {
	consoleURL := resolved.ConsoleURL
	if err := rejectWireProtocolConsoleURL(resolved, consoleURL); err != nil {
		return nil, err
	}
	if consoleURL == "" {
		consoleURL = atlasConsoleURL(resolved)
	}
	if consoleURL == "" {
		return nil, fmt.Errorf(
			"resource type %q is configured to open in a browser, but this resource has no console_url set — "+
				"an admin needs to set console_url on the PAM resource", resolved.ResourceType)
	}

	data := templateData{
		Host: resolved.Host, Port: strconv.Itoa(resolved.Port),
		DatabaseName: resolved.DatabaseName, AccountName: resolved.AccountName,
		ConsoleURL: consoleURL,
	}
	rendered, err := renderArgs([]string{cand.Command}, data)
	if err != nil {
		return nil, fmt.Errorf("failed to render browser URL for candidate %s: %w", cand.ID, err)
	}

	cmd := &PreparedCommand{
		Exec:  rendered[0],
		Mode:  "browser",
		Title: fmt.Sprintf("PAM — %s (%s)", resolved.ResourceType, cand.ID),
	}
	if cand.CredentialInjection == "clipboard" {
		cmd.CopyPasswordToClipboard = true
	}
	return cmd, nil
}

// mongoWirePorts are the ports a mongod/mongos listens on. Nothing there
// speaks HTTP: a browser pointed at one gets the server's own "It looks
// like you are trying to access MongoDB over HTTP on the native driver
// port." and nothing else. Confirmed against MongoDB 7.0.
var mongoWirePorts = map[string]bool{"27017": true, "27018": true, "27019": true}

// rejectWireProtocolConsoleURL catches a console_url pointing at the
// database port itself.
//
// This is an easy and reasonable mistake — the resource's host and port are
// right there — but it cannot work, and the way it fails hides that. The
// browser, or PAM's own session gateway proxying on the operator's behalf,
// gets a non-HTTP reply and reports the application as unreachable, which
// reads like the server is down rather than like the URL names something
// that was never a web application.
//
// Worth being explicit about what a console_url has to be: a web
// application that exists and is reachable. A self-hosted mongod does not
// ship one. MongoDB's own web console is Atlas, which only administers
// clusters hosted in Atlas — it has no page for a mongod running on a
// machine of your own, and it is behind its own sign-in, so no URL this
// agent opens can arrive there already authenticated. For a self-hosted
// deployment the console_url has to be something separately deployed and
// pointed at the database.
func rejectWireProtocolConsoleURL(resolved *apiclient.ResolvedLaunch, consoleURL string) error {
	if consoleURL == "" {
		return nil
	}
	parsed, err := url.Parse(strings.TrimSpace(consoleURL))
	if err != nil || parsed.Host == "" {
		return nil // not something this check can reason about
	}
	port := parsed.Port()
	if port == "" {
		return nil
	}
	if !mongoWirePorts[port] && port != strconv.Itoa(resolved.Port) {
		return nil
	}
	if !mongoWirePorts[port] && !strings.HasPrefix(resolved.ResourceType, "mongo") {
		return nil
	}

	return fmt.Errorf(
		"console_url for this resource is %s, which is the MongoDB database port, not a web application — "+
			"nothing there answers HTTP, so a browser only ever gets MongoDB's own \"trying to access MongoDB over HTTP\" reply. "+
			"Point console_url at a web console that is actually deployed and serving HTTP, or clear it and connect with mongosh instead. "+
			"MongoDB Atlas is not an option here: it only administers clusters hosted in Atlas, and it has its own sign-in",
		consoleURL)
}

// atlasConsoleURL is the web application for a MongoDB Atlas resource whose
// admin never filled in console_url. Every other browser resource here is
// something the customer hosts, so its URL genuinely can only come from the
// PAM record — but Atlas is MongoDB's own SaaS, always at the same origin,
// and a hostname ending in .mongodb.net is an Atlas cluster and cannot be
// anything else. Deriving it rather than erroring is the difference between
// "open the Atlas console" working out of the box and every Atlas resource
// needing a field set by hand first.
//
// Returns "" for anything that is not recognisably Atlas, which leaves the
// missing-console_url error exactly as it was for self-hosted MinIO,
// Langfuse, Metabase and the rest.
//
// extra_config.atlas_project_id, when an admin has set it, deep-links to
// that project rather than dropping the operator on the Atlas landing page.
// The /v2/<project>#/ shape is Atlas's own documented project URL. The
// operator still signs in to Atlas themselves: Atlas is an SSO web
// application with no credential this process could hand it, so unlike
// mongosh there is nothing here to automate beyond arriving in the right
// place.
func atlasConsoleURL(resolved *apiclient.ResolvedLaunch) string {
	host := strings.ToLower(strings.TrimSpace(resolved.Host))
	isAtlasHost := strings.HasSuffix(host, ".mongodb.net")

	projectID, _ := resolved.ExtraConfig["atlas_project_id"].(string)
	projectID = strings.TrimSpace(projectID)

	if !isAtlasHost && projectID == "" {
		return ""
	}
	if projectID != "" {
		return "https://cloud.mongodb.com/v2/" + url.PathEscape(projectID) + "#/"
	}
	return "https://cloud.mongodb.com/"
}

func renderArgs(argTemplates []string, data templateData) ([]string, error) {
	rendered := make([]string, len(argTemplates))
	for i, a := range argTemplates {
		tmpl, err := template.New("arg").Parse(a)
		if err != nil {
			return nil, fmt.Errorf("invalid template %q: %w", a, err)
		}
		var sb strings.Builder
		if err := tmpl.Execute(&sb, data); err != nil {
			return nil, fmt.Errorf("failed to render %q: %w", a, err)
		}
		rendered[i] = sb.String()
	}
	return rendered, nil
}
