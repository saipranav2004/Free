// pam-agent/internal/launcher/credential.go
//
// Per-tool credential injection. The guiding rule: a password must never
// appear as a plain command-line argument, because argv is visible to every
// other process on the machine via `ps`/Task Manager/process-monitoring
// tools. Where the target tool supports it, we use an environment variable
// (still readable by another process running as the same OS user via
// /proc/<pid>/environ on Linux, but invisible to `ps` and to anything not
// running as that user — a real improvement, not a perfect one). Where a
// tool has no env-based auth, we write a short-lived temp file instead.
package launcher

import (
	"encoding/xml"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"

	"github.com/yourorg/pam-agent/internal/apiclient"
)

// writePgpassFile writes a libpq-format .pgpass line
// (host:port:database:user:password, with ':' and '\' escaped per the
// documented format) to a 0600 temp file and returns its path. psql reads
// this automatically via PGPASSFILE with no password prompt and nothing on
// its command line.
func writePgpassFile(tempDir, host, port, dbName, user, password string) (string, error) {
	if dbName == "" {
		dbName = "*"
	}
	line := strings.Join([]string{
		pgpassEscape(host), pgpassEscape(port), pgpassEscape(dbName),
		pgpassEscape(user), pgpassEscape(password),
	}, ":")

	f, err := os.CreateTemp(tempDir, "pam-agent-*.pgpass")
	if err != nil {
		return "", fmt.Errorf("failed to create temp pgpass file: %w", err)
	}
	defer f.Close()

	if err := f.Chmod(0o600); err != nil {
		return "", fmt.Errorf("failed to set permissions on temp pgpass file: %w", err)
	}
	if _, err := f.WriteString(line + "\n"); err != nil {
		return "", fmt.Errorf("failed to write temp pgpass file: %w", err)
	}
	return f.Name(), nil
}

func pgpassEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `:`, `\:`)
	return s
}

// mongoAuthSource decides which MongoDB database the credential is
// authenticated AGAINST, which is not necessarily the database being
// browsed. MongoDB stores users per-database, and a deployment's
// administrative users almost always live in "admin" while the data they
// work on lives elsewhere, so "connect to shop, authenticate against admin"
// is the normal shape rather than the exception. Getting this wrong does
// not fail at connect time, it fails later with a bare "Authentication
// failed" that looks like a wrong password.
//
// The resource's own extra_config["auth_source"] wins when an admin has set
// it. Otherwise this mirrors MongoDB's own default: the database named in
// the connection string, falling back to "admin" when none is named.
// Because writeMongoInitFile defaults an empty DatabaseName to "admin"
// before calling here, an unconfigured resource lands on "admin" either
// way.
//
// Shared by the mongosh path and the connection-string path below so the
// two cannot drift: the shell and the GUI must authenticate identically, or
// one works and the other reports a wrong password for the same resource.
func mongoAuthSource(resolved *apiclient.ResolvedLaunch, dbName string) string {
	if v, ok := resolved.ExtraConfig["auth_source"].(string); ok && v != "" {
		return v
	}
	return mongoDefaultAuthSource(dbName)
}

// mongoDefaultAuthSource is the database a MongoDB driver authenticates
// against when the connection string says nothing: the one named in the
// string, or admin when it names none. Kept separate from mongoAuthSource
// so a caller can ask "would spelling this out change anything?" rather
// than only "what is it?".
func mongoDefaultAuthSource(dbName string) string {
	if dbName == "" {
		return "admin"
	}
	return dbName
}

// writeMongoInitFile writes a small mongosh init script that opens an
// authenticated connection and assigns it to `db`, then returns its path.
// Invoked as `mongosh --shell <path>`: mongosh evaluates the file (running
// the connection logic, credential included) and then drops the operator
// into an interactive shell against the already-connected `db` — the
// command line itself only ever shows the temp file's path, never the
// credential.
func writeMongoInitFile(tempDir string, resolved *apiclient.ResolvedLaunch) (string, error) {
	dbName := resolved.DatabaseName
	if dbName == "" {
		dbName = "admin"
	}

	u := &url.URL{
		Scheme:   "mongodb",
		User:     url.UserPassword(resolved.AccountName, resolved.Password),
		Host:     fmt.Sprintf("%s:%d", resolved.Host, resolved.Port),
		Path:     "/" + dbName,
		RawQuery: "authSource=" + url.QueryEscape(mongoAuthSource(resolved, dbName)),
	}

	script := fmt.Sprintf(
		"var __pamConn = Mongo(%q);\ndb = __pamConn.getDB(%q);\nprint('PAM agent: connected to %s as %s');\n",
		u.String(), dbName, dbName, resolved.AccountName,
	)

	f, err := os.CreateTemp(tempDir, "pam-agent-*.mongo-init.js")
	if err != nil {
		return "", fmt.Errorf("failed to create temp mongo init file: %w", err)
	}
	defer f.Close()

	if err := f.Chmod(0o600); err != nil {
		return "", fmt.Errorf("failed to set permissions on temp mongo init file: %w", err)
	}
	if _, err := f.WriteString(script); err != nil {
		return "", fmt.Errorf("failed to write temp mongo init file: %w", err)
	}
	return f.Name(), nil
}

// buildConnectionString is the best-effort GUI path — see the
// "connection_string_arg" case in BuildCommand for why this one mode is a
// deliberate, documented exception to "never in argv." It only understands
// the three URL-style schemes PAM's own connectors use (mongodb/postgresql/
// redis) — it is NOT a generic connection-string builder, and defaulting an
// unrecognized resource type to "mongodb://" would silently produce the
// wrong scheme rather than failing loudly. Anything else needs its own
// dedicated builder (see buildOracleConnectString below for why Oracle in
// particular can't just reuse this one).
func buildConnectionString(resolved *apiclient.ResolvedLaunch, dbName string) string {
	scheme := "mongodb"
	if resolved.ResourceType == "postgresql" {
		scheme = "postgresql"
	} else if resolved.ResourceType == "redis" {
		scheme = "redis"
	}

	u := &url.URL{
		Scheme: scheme,
		User:   url.UserPassword(resolved.AccountName, resolved.Password),
		Host:   resolved.Host + ":" + strconv.Itoa(resolved.Port),
	}
	if dbName != "" {
		u.Path = "/" + dbName
	}
	if scheme == "mongodb" {
		// authSource, but ONLY when it changes the outcome.
		//
		// Compass refuses to auto-connect to a connection string carrying
		// options it considers non-default, and puts up "This MongoDB
		// connection string contains options that are typically not set by
		// default and may present a security risk" with a Connect button
		// instead. Confirmed on a real machine against
		// mongodb://user:pass@host:27017?authSource=admin. So spelling out
		// a redundant authSource costs a manual click on every single
		// launch and buys nothing: the driver would have picked the same
		// database on its own.
		//
		// mongoAuthSource returns exactly the driver's own default when
		// nothing overrides it (the database in the path, else admin), so
		// comparing against that default is the same test as "does this
		// option do anything". When it does, it goes in and Compass is
		// told the string is trusted (see the --trustedConnectionString
		// argument on the mongodb-compass candidate in
		// launch-templates.default.json) so the click is not back.
		if src := mongoAuthSource(resolved, dbName); src != mongoDefaultAuthSource(dbName) {
			u.RawQuery = "authSource=" + url.QueryEscape(src)
		}
	}
	return u.String()
}

// buildOracleConnectString renders Oracle's classic EZCONNECT logon syntax
// — `username/password@host:port/service_name` — as used directly by
// sqlplus and SQLcl (Oracle's real command-line tools; the SQL Developer
// GUI does not accept a connect string as a launch argument at all, so this
// mode only helps for sqlplus/SQLcl-based templates). Deliberately NOT a
// case inside buildConnectionString: Oracle's syntax isn't a URL (no
// "oracle://" scheme, and it separates user/password with '/' rather than
// ':'), so bolting it onto the generic URL builder above would either
// panic or silently emit a string sqlplus can't parse.
//
// Same "never in argv" trade-off as connection_string_arg — see that case
// in BuildCommand. Unlike a URL, EZCONNECT has no escape mechanism for
// special characters at all, so rather than emit a connect string that
// would silently authenticate as the wrong identity (or just fail
// confusingly) if the stored credential contains '@', '/', or whitespace,
// this refuses outright and tells the operator why.
func buildOracleConnectString(resolved *apiclient.ResolvedLaunch, dbName string) (string, error) {
	if dbName == "" {
		return "", fmt.Errorf(
			"oracle_connect_string requires the resource's database_name to be set to the Oracle service name (or SID)")
	}
	if containsUnescapableChar(resolved.AccountName) || containsUnescapableChar(resolved.Password) {
		return "", fmt.Errorf(
			"the stored Oracle account name or password contains a character ('@', '/', or whitespace) " +
				"that EZCONNECT syntax cannot escape — store a credential without these characters, " +
				"or launch with credential_injection \"none\" and enter it manually")
	}
	return fmt.Sprintf("%s/%s@%s:%d/%s",
		resolved.AccountName, resolved.Password, resolved.Host, resolved.Port, dbName), nil
}

// ── Oracle ──────────────────────────────────────────────────────────────

// writeOracleLoginScript writes a SQL*Plus script holding a single CONNECT
// and returns its path. Run as `sqlplus /nolog @<path>`, the tool starts
// with no session, executes the CONNECT, and then drops the operator at a
// SQL> prompt against the connected database — so the credential reaches
// Oracle through a 0600 file the operator's own account owns, and the
// command line holds nothing but a path.
//
// This replaces putting `user/password@host:port/service` directly in argv,
// where it was readable by anything that can list processes (ps, Task
// Manager). Same reasoning, and the same shape, as the psql pgpass file and
// the mongosh init file.
//
// Verified against SQL*Plus 23.26 and SQLcl 26.2: both accept the script,
// execute the CONNECT, and stay interactive afterwards — including when the
// connection itself fails, so a wrong credential leaves the operator at a
// prompt with the Oracle error on screen rather than a window that vanishes.
func writeOracleLoginScript(tempDir string, resolved *apiclient.ResolvedLaunch, dbName string) (string, error) {
	identifier, err := buildOracleConnectIdentifier(resolved, dbName)
	if err != nil {
		return "", err
	}
	user, err := oracleUsername(resolved.AccountName)
	if err != nil {
		return "", err
	}
	password, err := oracleQuoted(resolved.Password)
	if err != nil {
		return "", fmt.Errorf("the stored Oracle password %w", err)
	}

	script := fmt.Sprintf(
		"-- Auto-generated by pam-agent for one session. Deleted moments after\n"+
			"-- the tool starts; do not edit or rely on this file.\n"+
			"SET SQLPROMPT \"PAM %s> \"\n"+
			"CONNECT %s/%s@%s\n",
		oracleSafeComment(resolved.ResourceType), user, password, identifier)

	f, err := os.CreateTemp(tempDir, "pam-agent-*.sql")
	if err != nil {
		return "", fmt.Errorf("failed to create temp Oracle login script: %w", err)
	}
	defer f.Close()

	if err := f.Chmod(0o600); err != nil {
		return "", fmt.Errorf("failed to set permissions on temp Oracle login script: %w", err)
	}
	if _, err := f.WriteString(script); err != nil {
		return "", fmt.Errorf("failed to write temp Oracle login script: %w", err)
	}
	return f.Name(), nil
}

// buildOracleConnectIdentifier names the database to connect to.
//
// Oracle has two different ways to be told which database is meant, and
// they are not interchangeable. A SERVICE NAME goes in EZCONNECT syntax
// (//host:port/service). A SID does not: EZCONNECT has no SID form, so a
// SID has to be spelled out as a full TNS descriptor. Feeding a SID where a
// service name is expected produces ORA-12514 ("listener does not currently
// know of service requested"), which reads like the database is down rather
// than like the wrong field was used — so the two are kept distinct here
// rather than hopefully passed through one code path.
//
// A resource carrying both is connected by service name, which is the form
// Oracle itself recommends and the only one that works against a multitenant
// or Data Guard setup where the SID differs per instance.
//
// Both forms verified to parse with SQL*Plus 23.26.
func buildOracleConnectIdentifier(resolved *apiclient.ResolvedLaunch, dbName string) (string, error) {
	extra := func(key string) string {
		v, _ := resolved.ExtraConfig[key].(string)
		return strings.TrimSpace(v)
	}

	if service := firstNonEmpty(extra("service_name"), strings.TrimSpace(dbName)); service != "" {
		return fmt.Sprintf("//%s:%d/%s", resolved.Host, resolved.Port, service), nil
	}
	if sid := extra("sid"); sid != "" {
		return fmt.Sprintf(
			"(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=%s)(PORT=%d))(CONNECT_DATA=(SID=%s)))",
			resolved.Host, resolved.Port, sid), nil
	}
	return "", fmt.Errorf(
		"this Oracle resource names no database: set database_name to the service name, " +
			"or set extra_config.service_name, or extra_config.sid for a SID-based listener")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// oracleQuoted wraps a value in the double quotes SQL*Plus uses to hold a
// CONNECT field together.
//
// Without them a password containing '@', '/' or a space silently ends the
// field early and SQL*Plus answers "SP2-0306: Invalid option" — which is
// why this used to refuse such passwords outright rather than risk
// authenticating as something unintended. Confirmed both halves against
// SQL*Plus 23.26: unquoted really does produce SP2-0306, and quoted really
// does carry '@', '/' and spaces through to the listener untouched.
//
// A double quote inside the value is the one character with no way out:
// SQL*Plus has no escape for it, and doubling it up ("") produces SP2-0306
// as well, so that single case is still refused. Everything else now works.
func oracleQuoted(value string) (string, error) {
	if strings.Contains(value, `"`) {
		return "", fmt.Errorf(
			`contains a double quote, which SQL*Plus has no way to escape inside a CONNECT ` +
				`(doubling it up does not work either) — store a credential without one`)
	}
	return `"` + value + `"`, nil
}

// oracleUsername leaves an ordinary user name bare and only quotes one that
// needs it.
//
// Quoting is not free for a user name the way it is for a password: Oracle
// folds an unquoted identifier to upper case and takes a quoted one
// literally, so wrapping DAS123 as "das123" asks for a user that does not
// exist. Only a name that would otherwise break the CONNECT is quoted, and
// then its stored spelling is what gets used.
func oracleUsername(name string) (string, error) {
	if !strings.ContainsAny(name, "@/ \t\n\"") {
		return name, nil
	}
	quoted, err := oracleQuoted(name)
	if err != nil {
		return "", fmt.Errorf("the stored Oracle account name %w", err)
	}
	return quoted, nil
}

// oracleSafeComment keeps anything interpolated into the script's SQLPROMPT
// from carrying a quote or newline that would break the surrounding
// statement. Resource types are tame, but the value comes from the server.
func oracleSafeComment(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '"' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, s)
}

func containsUnescapableChar(s string) bool {
	return strings.ContainsAny(s, "@/ \t\n")
}

// clickhouseConfigXML mirrors the small subset of clickhouse-client's own
// --config-file XML schema needed to carry connection details + credential
// (https://clickhouse.com/docs/en/interfaces/cli — "Configuring" section):
// <config><user>...</user><password>...</password><host>...</host>
// <port>...</port></config>. Go's encoding/xml handles escaping, so a
// credential containing '&', '<', etc. can't corrupt the document.
type clickhouseConfigXML struct {
	XMLName  xml.Name `xml:"config"`
	User     string   `xml:"user"`
	Password string   `xml:"password"`
	Host     string   `xml:"host"`
	Port     int      `xml:"port"`
	Database string   `xml:"database,omitempty"`
}

// writeClickhouseConfigFile writes a 0600 temp clickhouse-client config
// file carrying the resolved credential, so `clickhouse-client
// --config-file <path>` connects fully authenticated with nothing on its
// command line. Same lifecycle as the pgpass/mongo-init-file temp files:
// per-session temp dir, cleaned up shortly after the tool exits.
func writeClickhouseConfigFile(tempDir string, resolved *apiclient.ResolvedLaunch) (string, error) {
	doc := clickhouseConfigXML{
		User:     resolved.AccountName,
		Password: resolved.Password,
		Host:     resolved.Host,
		Port:     resolved.Port,
		Database: resolved.DatabaseName,
	}

	raw, err := xml.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to encode clickhouse-client config: %w", err)
	}

	f, err := os.CreateTemp(tempDir, "pam-agent-*.clickhouse-client.xml")
	if err != nil {
		return "", fmt.Errorf("failed to create temp clickhouse-client config file: %w", err)
	}
	defer f.Close()
	if err := f.Chmod(0o600); err != nil {
		return "", fmt.Errorf("failed to set permissions on temp clickhouse-client config file: %w", err)
	}
	if _, err := f.Write(append([]byte(xml.Header), raw...)); err != nil {
		return "", fmt.Errorf("failed to write temp clickhouse-client config file: %w", err)
	}
	return f.Name(), nil
}

// minioAliasEnvVar is the `mc` alias this launch pre-configures. `mc` reads
// MC_HOST_<alias> to learn an alias's endpoint+credential with no `mc alias
// set` step — that step would put the access/secret key on argv (visible via
// ps/Task Manager) AND permanently write them into the operator's own
// ~/.mc/config.json, which a PAM-brokered credential must never do (the next
// rotation would leave that config file holding a dead key, and the
// credential would outlive the session entirely). One fixed alias name is
// enough: each launch gets its own process/env, so there is no collision
// between concurrent sessions to different MinIO resources.
const minioAliasEnvVar = "MC_HOST_pam"

// buildMinIOAliasEnv renders the MC_HOST_pam value for a MinIO launch —
// scheme://accessKey:secretKey@host:port.
//
// BUGFIX: this used to build the value with net/url (url.UserPassword +
// url.URL.String()), which correctly percent-encodes a credential containing
// '@'/':' per RFC 3986 — the right thing for a real URL, and the wrong thing
// here. `mc` does NOT run its MC_HOST_<alias> value through a URL decoder:
// it locates the host by splitting on the LAST '@' and the user/pass by
// splitting the remainder on the FIRST ':', then uses those substrings
// completely raw. Confirmed live: a secret key containing '@' (e.g.
// "DasAdmin@123") got percent-encoded to "...%40123", which mc then signed
// requests with VERBATIM as the secret key ("DasAdmin%40123") instead of
// decoding it back — every request came back "SignatureDoesNotMatch" even
// though the credential itself was correct. mc's own last-'@'/first-':'
// split is exactly why this is safe to do raw: the host portion (an IP or
// hostname) will never itself contain '@', so however many '@' characters
// the secret key contains, the split still lands in the right place; and a
// MinIO/S3 access key never contains ':', so the first ':' always correctly
// separates it from a secret key that might contain ':' of its own.
//
// scheme comes from the resource's extra_config.use_ssl (set on the PAM
// resource, not guessed here) — an unset/missing value defaults to plain
// http, matching how MinIO is commonly run on a private/internal network;
// getting this wrong in either direction would silently connect over the
// wrong scheme instead of failing loudly.
func buildMinIOAliasEnv(resolved *apiclient.ResolvedLaunch) string {
	scheme := "http"
	if useSSL, _ := resolved.ExtraConfig["use_ssl"].(bool); useSSL {
		scheme = "https"
	}
	return fmt.Sprintf("%s=%s://%s:%s@%s:%d",
		minioAliasEnvVar, scheme, resolved.AccountName, resolved.Password, resolved.Host, resolved.Port)
}

// Langfuse's CLI reads all three of these; there is no flag form and no
// config file it will accept instead, so an environment is the only way to
// hand it a credential without putting the secret key on a command line.
//
// Names read out of the shipped tool, not from memory. langfuse-cli 1.2.0
// (npm, binary "langfuse") resolves its host as:
//
//	host = --host ?? LANGFUSE_BASE_URL ?? LANGFUSE_HOST ?? "https://cloud.langfuse.com"
//
// Two things follow, and both are why BASE_URL is the one used here.
//
// The default is Langfuse's EU CLOUD. With no host set, the CLI does not
// fail: it succeeds against a third party, carrying a key minted for a
// private instance. So a value is always exported, never left to the default.
//
// BASE_URL outranks HOST. An operator with LANGFUSE_HOST exported from their
// own shell profile (pointing at their personal or a staging instance) cannot
// therefore redirect a PAM session away from the resource it was opened for.
// Setting HOST instead would have let that stale value win on some machines
// and not others.
//
// Auth is HTTP Basic over publicKey:secretKey, which is why the account name
// and the secret map onto the pair the way they do below.
const (
	langfusePublicKeyEnvVar = "LANGFUSE_PUBLIC_KEY"
	langfuseSecretKeyEnvVar = "LANGFUSE_SECRET_KEY"
	langfuseBaseURLEnvVar   = "LANGFUSE_BASE_URL"
)

// buildLangfuseEnv maps PAM's credential shape onto the CLI's three
// variables.
//
// The mapping follows MinIO's, which is the same shape of credential: the
// vault's account name is the PUBLIC half (pk-lf-...) and the secret is the
// private half (sk-lf-...). Nothing is guessed about which is which.
func buildLangfuseEnv(resolved *apiclient.ResolvedLaunch) []string {
	return []string{
		langfusePublicKeyEnvVar + "=" + resolved.AccountName,
		langfuseSecretKeyEnvVar + "=" + resolved.Password,
		langfuseBaseURLEnvVar + "=" + langfuseBaseURL(resolved),
	}
}

// langfuseBaseURL prefers the resource's own console_url, because that is the
// value an administrator actually checked, and falls back to host/port.
//
// The fallback matters more here than for most tools: with this unset the
// CLI does not fail, it succeeds against Langfuse's EU cloud instead. A
// credential for a self-hosted instance would then be sent to a third party.
// So there is always a value, and it always names this resource.
func langfuseBaseURL(resolved *apiclient.ResolvedLaunch) string {
	if u := strings.TrimSpace(resolved.ConsoleURL); u != "" {
		return strings.TrimRight(u, "/")
	}
	scheme := "http"
	// Same switch MinIO uses, and set on the PAM resource rather than
	// guessed: connecting over the wrong scheme fails in confusing ways.
	if useSSL, _ := resolved.ExtraConfig["use_ssl"].(bool); useSSL {
		scheme = "https"
	}
	if resolved.Port == 0 {
		return fmt.Sprintf("%s://%s", scheme, resolved.Host)
	}
	return fmt.Sprintf("%s://%s:%d", scheme, resolved.Host, resolved.Port)
}

// resolveInteractiveShell finds the operator's own interactive shell.
// `mc` (MinIO's CLI) has no REPL of its own — every invocation runs exactly
// one command and exits — so unlike psql/mongosh/redis-cli, the tool itself
// can't be the thing this launch execs. Instead the "minio_mc_shell"
// credential injection (see buildCommand) drops the operator into their own
// shell with MC_HOST_pam already exported, so every `mc ...` command they
// type is already authenticated. Windows always has cmd.exe on PATH; Unix
// honors $SHELL first (the operator's own configured shell) and falls back
// to bash, then the POSIX-guaranteed sh.
func resolveInteractiveShell() (string, error) {
	if runtime.GOOS == "windows" {
		if p, err := exec.LookPath("cmd"); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("could not locate cmd.exe on PATH")
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		if p, err := exec.LookPath(sh); err == nil {
			return p, nil
		}
	}
	for _, name := range []string{"bash", "sh"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("could not locate an interactive shell (tried $SHELL, bash, sh)")
}

// CopyToClipboard puts text on the OS clipboard by shelling out to the
// platform's own built-in clipboard tool — same zero-third-party-dependency
// approach as everything else in this module (see discovery.go's doc
// comment on why reg.exe is used instead of a registry package). Best-effort
// by design: the caller (cmdLaunch, for CopyPasswordToClipboard) logs a
// failure and still opens the browser rather than blocking the whole launch
// over a clipboard write — the operator can always copy the password from
// PAM's own UI instead if this fails.
//
// Windows: clip.exe (present on every Windows install) reads stdin.
// macOS: pbcopy (present on every macOS install) reads stdin.
// Linux has no universal built-in, so this tries the common X11/Wayland
// clipboard tools in order and reports a clear error (naming all three) only
// if none of them are installed.
func CopyToClipboard(text string) error {
	var candidates [][]string
	switch runtime.GOOS {
	case "windows":
		candidates = [][]string{{"clip"}}
	case "darwin":
		candidates = [][]string{{"pbcopy"}}
	default:
		candidates = [][]string{
			{"xclip", "-selection", "clipboard"},
			{"xsel", "--clipboard", "--input"},
			{"wl-copy"},
		}
	}

	var tried []string
	for _, args := range candidates {
		path, err := exec.LookPath(args[0])
		if err != nil {
			tried = append(tried, args[0])
			continue
		}
		cmd := exec.Command(path, args[1:]...)
		cmd.Stdin = strings.NewReader(text)
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("%s failed to copy to clipboard: %w", args[0], err)
		}
		return nil
	}
	return fmt.Errorf("no clipboard tool found (tried: %s)", strings.Join(tried, ", "))
}

// RemoveFiles deletes each path in files, best-effort. Called by main.go a
// few seconds after spawning the local process, giving it time to open/read
// them first. Deleting a file on Linux/macOS after a process has opened it
// is safe — the open file descriptor keeps working even after the directory
// entry is unlinked. Windows file-locking semantics differ (a still-open
// file may resist deletion); this is best-effort there and documented as
// such in the README.
func RemoveFiles(files []string) {
	for _, p := range files {
		if p == "" {
			continue
		}
		_ = os.Remove(p)
	}
}
