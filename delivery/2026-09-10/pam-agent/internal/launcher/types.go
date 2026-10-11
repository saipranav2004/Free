// pam-agent/internal/launcher/types.go
package launcher

import "github.com/yourorg/pam-agent/internal/discovery"

// PreparedCommand is an OS-agnostic description of the local command to
// run. Exec/Args must never contain the credential in plaintext — secrets
// are carried via Env (which the per-OS spawn implementation is responsible
// for propagating without ever putting them on a visible command line) or,
// for tools with no env-based auth option, a temp file referenced only by
// path in Args/Env, cleaned up shortly after spawn.
type PreparedCommand struct {
	// Session identity, for the wrapper that reports this session's end on
	// macOS and Linux (see wrapper.go). Set by the caller before Spawn.
	SessionID string
	ServerURL string
	AgentPath string

	// PolicyJSON is Policy serialised for the relay invocation, and Record
	// says whether the relay should capture. Both set by the caller, which is
	// the only place that knows the session's recording obligation.
	PolicyJSON string
	Record     bool

	// EndReportedByWrapper is set by the platform spawn when the launch script
	// will report the session end itself. The caller uses it to skip its own
	// report rather than sending two, and to tell the operator the session
	// will close on its own instead of warning that it will not.
	EndReportedByWrapper bool

	// Policy is the server's data-protection decision for this session,
	// enforced by the ConPTY relay on Windows (see guard.go). Zero value means
	// unrestricted, which is what every non-Windows launch gets because those
	// paths hand off to an external terminal the agent is not inside.
	Policy Policy

	Exec         string
	Args         []string
	Env          []string // extra entries, appended to os.Environ() by the spawn layer
	CleanupFiles []string // temp files to remove a few seconds after spawn
	Title        string   // window title, where the OS supports one
	Mode         string   // "cli" | "gui" | "browser" — which per-OS spawn strategy to use (terminal vs. direct exec vs. open a URL)
	AppBundle    string   // macOS only: a .app bundle path, launched via `open -a`, when Exec itself isn't directly executable

	// PreseedLoadServersPath, when set, is a temp file path to feed to the
	// GUI tool's own "--load-servers"-style preseed mechanism as a
	// best-effort pre-step before the tool itself is spawned normally. See
	// pgadmin_preseed.go.
	PreseedLoadServersPath string

	// CopyPasswordToClipboard, when true, tells the caller (cmdLaunch) to
	// copy the resolved credential's password to the OS clipboard right
	// before opening this candidate — for any tool that has no way to accept
	// the password headlessly and always prompts interactively instead:
	// MinIO's console login page (its API rejects both a plain HTML form
	// POST and a cross-origin fetch/XHR — no CORS preflight support at all;
	// see launch-templates.default.json's minio entry) and pgAdmin4's
	// "Connect to Server" dialog (its --load-servers preseed mechanism only
	// ever carries host/port/username — see pgadmin_preseed.go for why the
	// password specifically is never included). In both cases the closest
	// thing to "already logged in" is landing on that exact prompt with the
	// password one paste away, instead of the operator having to go look it
	// up in PAM separately. Set by buildBrowserCommand (credential_injection
	// "clipboard") and buildCommand's "pgadmin_preseed" case.
	CopyPasswordToClipboard bool
}

// Candidate is one fallback option for opening a resource type — e.g.
// Postgres tries "psql" first and falls back to "pgAdmin4" if psql isn't
// installed. A resource type's entry in launch-templates.json is an
// ordered list of these; the first one whose tool is actually found on
// this machine (via Discovery) is used. A "browser" Kind candidate needs
// no discovery at all — opening the OS default browser is always assumed
// available.
type Candidate struct {
	// ID names this candidate for logs, error messages, and the
	// "preferred_tool" ExtraConfig hint (see SelectCandidate).
	ID string `json:"id"`

	// Kind selects which per-OS spawn strategy applies:
	//   "cli"     - runs inside a terminal window (see per-OS Spawn notes)
	//   "gui"     - spawned directly, not inside a terminal
	//   "browser" - opens the OS default browser to a URL; Command is a
	//               text/template string (typically "{{.ConsoleURL}}"),
	//               Args/CredentialInjection/Discovery are ignored
	Kind string `json:"kind"`

	Command string   `json:"command"` // executable name/path (cli/gui) or a URL template (browser)
	Args    []string `json:"args"`    // text/template strings; may reference {{.Host}} {{.Port}} {{.DatabaseName}} {{.AccountName}} {{.ConsoleURL}}

	// CredentialInjection selects how the resolved password reaches the
	// tool without ever appearing in a process listing — see credential.go
	// for each mode's implementation:
	//   "env"                    - a single env var (CredentialEnvVar) carries it
	//   "pgpass"                 - a temp .pgpass file + PGPASSFILE env var
	//   "mongo_init_file"        - a temp mongosh init script constructs the connection
	//   "clickhouse_config_file" - a temp clickhouse-client XML config file
	//   "connection_string_arg"  - best-effort GUI path: embedded in a connection
	//                              string passed as an argument (the one mode that
	//                              DOES put the credential in argv — see the README)
	//   "oracle_connect_string"  - sqlplus/SQLcl's EZCONNECT logon string as an argument
	//   "pgadmin_preseed"        - best-effort: seeds host/port/username (never the
	//                              password) into pgAdmin4 via --load-servers
	//   "none"                   - no credential to inject (e.g. auth-less local Redis,
	//                              or a GUI tool the operator must configure by hand)
	CredentialInjection string `json:"credential_injection"`
	CredentialEnvVar    string `json:"credential_env_var,omitempty"`

	// Discovery is ignored for Kind == "browser".
	Discovery discovery.Spec `json:"discovery,omitempty"`

	// InstallHint is what to tell the operator when Discovery finds nothing.
	//
	// "no installed tool found" is true but useless: the person reading it is
	// on their own laptop and wants to know which thing to install and how.
	// That answer is per-tool and per-OS, it belongs next to the tool's own
	// definition rather than in agent code, and it travels to the operator's
	// browser through the launch failure report so they never have to go
	// looking in a terminal window that already closed.
	//
	// Lives in launch-templates.json so a fleet with an internal package
	// mirror can replace "brew install ..." with whatever is actually true
	// there, without a new agent build.
	InstallHint string `json:"install_hint,omitempty"`
}
