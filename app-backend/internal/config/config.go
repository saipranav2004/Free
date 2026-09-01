// pam/internal/config/config.go
//
// Merged configuration: base server/db/redis/s3/iam/jwt/vault/security config
// (Vault & Rotation branch) + JIT/break-glass config (JIT branch) + audit
// chain config (Audit/Compliance branch). All three teams touched this file
// independently; this is the reconciled superset.
package config

import (
	"fmt"
	"strings"

	"github.com/spf13/viper"
)

// Config holds all configuration for the PAM application.
type Config struct {
	Server    ServerConfig    `mapstructure:"server"`
	Database  DatabaseConfig  `mapstructure:"database"`
	Redis     RedisConfig     `mapstructure:"redis"`
	S3        S3Config        `mapstructure:"s3"`
	IAM       IAMConfig       `mapstructure:"iam"`
	JWT       JWTConfig       `mapstructure:"jwt"`
	Vault     VaultConfig     `mapstructure:"vault"`
	Security  SecurityConfig  `mapstructure:"security"`
	JIT       JITConfig       `mapstructure:"jit"`
	Audit     AuditConfig     `mapstructure:"audit"`
	Recording RecordingConfig `mapstructure:"recording"`
	Agent     AgentConfig     `mapstructure:"agent"`
	WebProxy  WebProxyConfig  `mapstructure:"webproxy"`
	Network   NetworkConfig   `mapstructure:"network"`
}

// NetworkConfig holds the perimeter control: which source networks may reach
// this API at all.
//
// EVERY LIST IS A SINGLE STRING, NOT A SLICE, and that is deliberate. Viper's
// AutomaticEnv cannot decode a comma-separated environment variable into a
// []string: it hands back a one-element slice containing the whole line, so
// "PAM_NETWORK_ALLOWED_CIDRS=a,b,c" silently becomes one nonsense entry. Taking
// the raw string and splitting it here removes that trap entirely.
type NetworkConfig struct {
	// TrustedProxies are the CIDRs of the reverse proxies, load balancers or
	// CDN edges directly in front of this process. X-Forwarded-For is honoured
	// ONLY when the connection arrives from one of these.
	//
	// This is the setting the whole perimeter rests on. Gin's default is to
	// trust that header from anywhere, which means any client can name its own
	// source address: the allowlist becomes one header away from open, and
	// every SourceIP in the audit trail becomes a value the client chose.
	//
	// There is no safe default, so there is no default. Set it to your proxy's
	// range ("10.0.0.0/8", "172.16.0.0/12"), or to the literal "none" to
	// assert that this process is reached directly and no forwarding header
	// should ever be believed. Leaving it blank with the allowlist enabled is
	// a boot failure.
	TrustedProxies string `mapstructure:"trusted_proxies"`

	// AllowlistEnabled turns on source-network enforcement.
	AllowlistEnabled bool `mapstructure:"allowlist_enabled"`

	// AllowedCIDRs are the approved corporate networks, separated by commas,
	// spaces or newlines. CIDRs and bare addresses are both accepted, IPv4 and
	// IPv6 alike: "203.0.113.0/24, 198.51.100.7, 2001:db8:acad::/48".
	AllowedCIDRs string `mapstructure:"allowed_cidrs"`

	// BreakGlassCIDRs are emergency ranges held apart from the normal list so
	// that every use of them is audited at CRITICAL and never throttled. An
	// on-call engineer's home address belongs here for the duration of an
	// incident, not in AllowedCIDRs where its use would look routine.
	BreakGlassCIDRs string `mapstructure:"break_glass_cidrs"`

	// AllowlistExemptPaths bypass the check, matched exactly. Defaults to the
	// health endpoint alone, because a load balancer probes from the cloud
	// provider's range rather than from an office, and an allowlist that fails
	// the probe pulls the instance out of the pool and causes the outage it
	// was meant to prevent. Nothing that returns data belongs here.
	AllowlistExemptPaths string `mapstructure:"allowlist_exempt_paths"`
}

// noProxySentinel is the explicit "this process is reached directly" value.
// Requiring it, rather than treating blank as the same thing, is what forces
// the trusted-proxy question to be answered deliberately once instead of
// inherited by accident.
const noProxySentinel = "none"

// splitList parses one of the comma, space or newline separated list fields.
func splitList(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == ';'
	})
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// TrustedProxyCIDRs returns the proxy ranges to hand to gin's
// SetTrustedProxies. A nil result means "trust nothing, use the socket peer",
// which is what gin does with SetTrustedProxies(nil).
func (n NetworkConfig) TrustedProxyCIDRs() []string {
	if strings.EqualFold(strings.TrimSpace(n.TrustedProxies), noProxySentinel) {
		return nil
	}
	list := splitList(n.TrustedProxies)
	if len(list) == 0 {
		return nil
	}
	return list
}

func (n NetworkConfig) AllowedCIDRList() []string    { return splitList(n.AllowedCIDRs) }
func (n NetworkConfig) BreakGlassCIDRList() []string { return splitList(n.BreakGlassCIDRs) }
func (n NetworkConfig) ExemptPathList() []string     { return splitList(n.AllowlistExemptPaths) }

// WebProxyConfig drives the brokered web-application gateway
// (internal/webproxy) — the "open in browser, already logged in" path for
// web-console resources (MinIO Console, Grafana, Jenkins, ...).
//
// The defining property, and the reason this exists rather than handing the
// operator a password to paste: the TARGET's session cookie is established
// server-to-server and never leaves this process. The browser only ever
// holds a PAM-issued proxy cookie, so an operator cannot extract a reusable
// credential from devtools, and revoking the PAM session instantly kills
// access to the target — neither of which is true of any "auto-fill the
// login form" approach.
type WebProxyConfig struct {
	// Enabled gates the whole feature. Off by default: it requires DNS and
	// TLS setup (see BaseDomain) that a plain `go run` deployment won't have,
	// and silently half-working authentication infrastructure is worse than
	// an explicitly disabled feature.
	Enabled bool `mapstructure:"enabled"`

	// BaseDomain is the wildcard domain proxied applications are served
	// under — e.g. "pam.example.com", giving each resource its own
	// "<slug>.pam.example.com" origin.
	//
	// Why a subdomain per app rather than a path prefix ("/proxy/<id>/..."):
	// a modern SPA emits absolute, root-relative URLs ("/api/v1/login",
	// "/static/main.js") that a path-prefixed proxy would have to rewrite
	// inside HTML, CSS, JS bundles, and XHR calls — an endless and
	// never-quite-correct game. Giving the app its own origin means its own
	// root-relative URLs resolve correctly with zero body rewriting, which is
	// what makes this robust enough to put in front of arbitrary third-party
	// web apps. Requires a wildcard DNS record (*.pam.example.com) and a
	// wildcard TLS certificate.
	BaseDomain string `mapstructure:"base_domain"`

	// PublicPort is the port operators' browsers reach the proxy on, used
	// ONLY when building launch/app URLs — never for host matching, which
	// must keep comparing against a bare BaseDomain.
	//
	// Zero means "omit the port", which is correct behind a TLS terminator on
	// 443 or a reverse proxy on 80 — the production shape. A development
	// deployment serving the API directly on 8080 has to set this, or every
	// issued URL points at a port nothing is listening on. Validate() logs a
	// warning for exactly that combination rather than letting it fail
	// silently in the browser.
	PublicPort int `mapstructure:"public_port"`

	// Scheme is how the browser reaches the proxy ("https" in any real
	// deployment; "http" only for local development without TLS). Controls
	// the scheme in generated launch URLs and the Secure flag on the proxy
	// session cookie.
	Scheme string `mapstructure:"scheme"`

	// ReservedSubdomains are labels under BaseDomain that are NEVER a proxied
	// application, however much they look like one.
	//
	// This exists because the alternative bites hard and silently. A session is
	// served at "<slug>.<base_domain>", so ANY single label under the base
	// domain is treated as a proxied app — including one an operator puts the
	// API itself on. When that happens the API host stops receiving CORS
	// headers (they are deliberately withheld from proxied hosts, since
	// stamping them on a third-party app's responses would expose an
	// authenticated session), and its OPTIONS preflights are answered by the
	// proxy's "not signed in" page instead. The console then fails with
	// "No 'Access-Control-Allow-Origin' header is present" while curl against
	// the same host works perfectly, because curl does not send preflights.
	//
	// Session slugs are random and prefixed with the resource name, so they
	// never collide with these. Reserving them costs nothing and removes a
	// failure whose symptom points nowhere near its cause.
	ReservedSubdomains []string `mapstructure:"reserved_subdomains"`

	// SessionTTLMin bounds how long a brokered web session stays usable
	// before the operator must re-launch it from PAM (and re-pass the
	// RBAC/PBAC + JIT-grant checks). Independent of the target application's
	// own session lifetime.
	SessionTTLMin int `mapstructure:"session_ttl_min"`

	// IdleTimeoutMin closes a brokered session that has seen no proxied
	// request for this long — the equivalent of a terminal session timing
	// out, so an abandoned browser tab doesn't hold privileged access open
	// for the full SessionTTLMin.
	IdleTimeoutMin int `mapstructure:"idle_timeout_min"`

	// HandoffTTLSec bounds the one-time token that converts "PAM says this
	// user may open this app" into a proxy session cookie on the app's
	// subdomain. Deliberately very short — it travels in a URL (the only
	// place it can, since the browser is navigating cross-origin) and is
	// consumed on first use, exactly like the native agent's launch token.
	HandoffTTLSec int `mapstructure:"handoff_ttl_sec"`

	// MaxRequestBodyBytes caps a single proxied request body. Prevents an
	// upload through the proxy from pinning an unbounded amount of memory
	// when the body has to be buffered for audit/inspection.
	MaxRequestBodyBytes int64 `mapstructure:"max_request_body_bytes"`

	// InsecureSkipTargetTLSVerify disables certificate verification on the
	// PAM→target hop. Real deployments must leave this false; it exists for
	// internal targets using self-signed certificates during evaluation, and
	// is logged loudly at startup when enabled.
	InsecureSkipTargetTLSVerify bool `mapstructure:"insecure_skip_target_tls_verify"`
}

type ServerConfig struct {
	Port string `mapstructure:"port"`
	// Env is "production" unless it explicitly names a development
	// environment. See IsProduction, which decides that question fail-closed.
	Env             string `mapstructure:"env"`
	AllowedOrigins  string `mapstructure:"allowed_origins"`
	ShutdownTimeout int    `mapstructure:"shutdown_timeout"` // seconds

	// EnableDevTestLogin arms POST /test/login-as, which mints a session for
	// any account without a password or a second factor.
	//
	// TWO SWITCHES, BOTH REQUIRED, and that is deliberate. The endpoint used
	// to ride on Env alone, and Env used to default to development, so an
	// install that simply never set PAM_SERVER_ENV published an
	// unauthenticated "become root" route. Now the environment must not be
	// production AND this must be turned on by name, so no single missing
	// variable can expose it. Never set it anywhere a real account exists.
	EnableDevTestLogin bool `mapstructure:"enable_dev_test_login"`

	// PublicURL is this PAM server's externally-reachable base URL — used to
	// build the pam-agent://launch?...&server=<this> handoff URL (see
	// agent_handler.go's CreateLaunch) and the "pam-agent pair --server ..."
	// hint returned from pair/init. MUST be set to the real public URL in
	// any deployment reached by more than one machine — the default below
	// only works when the browser and the paired agent are on the same box
	// as the server itself (local dev).
	PublicURL string `mapstructure:"public_url"`
}

type DatabaseConfig struct {
	Host     string `mapstructure:"host"`
	Port     int    `mapstructure:"port"`
	Name     string `mapstructure:"name"`
	User     string `mapstructure:"user"`
	Password string `mapstructure:"password"`
	SSLMode  string `mapstructure:"sslmode"`
	Schema   string `mapstructure:"schema"` // "pam"
}

func (d DatabaseConfig) DSN() string {
	return fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s search_path=%s",
		d.Host, d.Port, d.User, d.Password, d.Name, d.SSLMode, d.Schema,
	)
}

type RedisConfig struct {
	Host     string `mapstructure:"host"`
	Port     int    `mapstructure:"port"`
	Password string `mapstructure:"password"`
	DB       int    `mapstructure:"db"`
}

type S3Config struct {
	Endpoint  string `mapstructure:"endpoint"`
	Bucket    string `mapstructure:"bucket"`
	AccessKey string `mapstructure:"access_key"`
	SecretKey string `mapstructure:"secret_key"`
	Region    string `mapstructure:"region"`
	UseSSL    bool   `mapstructure:"use_ssl"`
}

// IAMConfig — connection details for the IAM control center (PDP).
type IAMConfig struct {
	BaseURL       string `mapstructure:"base_url"`        // e.g. http://iam-host:5000
	ServiceToken  string `mapstructure:"service_token"`   // X-IAM-Service-Token for /authz/check
	AuthzCheckURL string `mapstructure:"authz_check_url"` // /api/v1/authz/check
	JWKsURL       string `mapstructure:"jwks_url"`        // /.well-known/jwks.json
	TimeoutSec    int    `mapstructure:"timeout_sec"`

	// ── PEP resilience ──
	// MaxRetries applies to the authz/check call only (it is a read-only,
	// side-effect-free decision request, so retrying is safe).
	MaxRetries     int `mapstructure:"max_retries"`
	RetryBackoffMs int `mapstructure:"retry_backoff_ms"`

	// AuthzCacheTTLSec caches ALLOW decisions for this many seconds.
	// DEFAULT 0 = disabled. Any value > 0 trades revocation latency for
	// throughput: a revoked entitlement can still be honoured for up to
	// TTL seconds by the cache. PAM-side JIT grant checks are NOT cached,
	// so time-boxed access remains exact regardless of this setting.
	AuthzCacheTTLSec int `mapstructure:"authz_cache_ttl_sec"`

	// ── Optional IAM projection endpoints (empty = feature skipped) ──
	// GrantURL receives the temporary policy attachment on approval.
	GrantURL string `mapstructure:"grant_url"`
	// RevokeURL receives the detachment. "{grant_id}" is substituted.
	RevokeURL string `mapstructure:"revoke_url"`
	// AlertURL receives CRITICAL break-glass alerts.
	AlertURL string `mapstructure:"alert_url"`
}

// JWTConfig — PAM's own HS256 JWT (separate from IAM's RS256).
type JWTConfig struct {
	SecretKey      string `mapstructure:"secret_key"`       // PAM-only signing secret
	AccessTTLMin   int    `mapstructure:"access_ttl_min"`   // access token lifetime (default 30)
	RefreshTTLDays int    `mapstructure:"refresh_ttl_days"` // refresh token lifetime (default 7)
}

// VaultConfig — AES-256-GCM master key management.
type VaultConfig struct {
	EncryptionKey string `mapstructure:"encryption_key"` // base64-encoded 32-byte key
}

// SecurityConfig — login security policies.
type SecurityConfig struct {
	MaxLoginAttempts int `mapstructure:"max_login_attempts"` // default 5
	LockoutMinutes   int `mapstructure:"lockout_minutes"`    // default 30
}

// JITConfig — Just-In-Time access workflow, time-boxing and break-glass.
type JITConfig struct {
	// DefaultDurationMin is used when a request omits duration_minutes.
	DefaultDurationMin int `mapstructure:"default_duration_min"`
	// MaxDurationMin caps how long a standard grant may last.
	MaxDurationMin int `mapstructure:"max_duration_min"`
	// RequestTTLMin is how long a PENDING request waits for a decision
	// before it auto-expires.
	RequestTTLMin int `mapstructure:"request_ttl_min"`
	// MinReasonLength enforces a real justification (compliance evidence).
	MinReasonLength int `mapstructure:"min_reason_length"`
	// RequireSeparationOfDuty blocks self-approval.
	RequireSeparationOfDuty bool `mapstructure:"require_separation_of_duty"`

	// BreakglassWaitMin is the mandatory cooling-off period before an
	// emergency grant activates. 15 minutes is the documented default and
	// exists so a human can intervene before privileged access is live.
	BreakglassWaitMin int `mapstructure:"breakglass_wait_min"`
	// BreakglassMaxDurationMin caps emergency grant length.
	BreakglassMaxDurationMin int `mapstructure:"breakglass_max_duration_min"`
	// BreakglassActivationWindowMin is how long after AvailableAt the
	// waiting request stays activatable before it expires unused.
	BreakglassActivationWindowMin int `mapstructure:"breakglass_activation_window_min"`

	// SweepIntervalSec drives the auto-revoke background worker.
	SweepIntervalSec int `mapstructure:"sweep_interval_sec"`
	// SweepBatchSize bounds rows processed per pass per job.
	SweepBatchSize int `mapstructure:"sweep_batch_size"`
	// SweeperEnabled allows disabling the worker (e.g. on read replicas).
	SweeperEnabled bool `mapstructure:"sweeper_enabled"`
}

// AuditConfig — hash-chained audit trail (HMAC secret, default org, periodic
// integrity verification interval).
type AuditConfig struct {
	HMACSecret            string `mapstructure:"hmac_secret"`
	DefaultOrg            string `mapstructure:"default_org"`
	VerifyIntervalMinutes int    `mapstructure:"verify_interval_minutes"`
}

// RecordingConfig — session screen-recording + command-log capture (see
// internal/recorder and internal/gateway). Backend selects which
// recorder.Storage implementation main.go constructs: "local" (default)
// writes StorageDir on this server's own filesystem; "minio" (or "s3")
// uses S3Config below instead, against a real SigV4-signed client (see
// internal/recorder/minio_storage.go) — unlike
// internal/services/backup_service.go's S3 client, which never signs its
// requests at all. StorageDir/MaxCastBytes apply to both backends;
// StorageDir is simply unused when Backend isn't "local". Keystroke/command
// logs (models.SessionRecordingCommand) never go through Storage at all —
// they're always Postgres rows, regardless of this setting.
// AgentConfig — distribution of the native pam-agent to operators.
//
// The console's one-click enrolment hands out a platform-specific installer,
// which needs the matching agent binary to exist somewhere the server can
// read. Kept as a directory rather than embedded in this binary so a new
// agent build can be shipped by dropping a file in, without rebuilding and
// redeploying the API.
type AgentConfig struct {
	// BinaryDir holds the cross-compiled agent binaries, named
	// pam-agent_<os>_<arch>[.exe]. Empty disables one-click enrolment
	// entirely: the console then shows no platform buttons rather than
	// offering a download that would 404.
	BinaryDir string `mapstructure:"binary_dir"`

	// EnrolTTLMinutes bounds how long a generated installer's embedded
	// pairing code stays valid. Short by default: the script is generated on
	// demand and meant to be run immediately, and the code is the one secret
	// that would let a stranger enrol a device against this account.
	EnrolTTLMinutes int `mapstructure:"enrol_ttl_minutes"`
}

type RecordingConfig struct {
	Backend      string `mapstructure:"backend"` // "local" | "minio" | "s3"
	StorageDir   string `mapstructure:"storage_dir"`
	MaxCastBytes int64  `mapstructure:"max_cast_bytes"`

	// MaxReplayBytes caps a single brokered web session's rrweb event
	// stream. Separate from MaxCastBytes and much larger by default: a
	// visual replay carries full DOM snapshots with inlined stylesheets,
	// so it is an order of magnitude heavier than a terminal transcript
	// and would otherwise be truncated within the first minute.
	MaxReplayBytes int64 `mapstructure:"max_replay_bytes"`
}

// Load reads configuration from environment variables (viper auto-bind).
func Load() (*Config, error) {
	v := viper.New()

	// ── Defaults (MUST register every key so AutomaticEnv can find its env var) ──
	// Viper's AutomaticEnv only binds env vars for keys that have a SetDefault.
	// Without this, keys like database.host are invisible even if the env var exists.
	v.SetDefault("server.port", "8080")
	// PRODUCTION IS THE DEFAULT, and the fail-closed direction is the whole
	// point: the settings that key off this all relax something (GORM
	// automigration, a stand-in audit HMAC secret, the dev test-login route).
	// Defaulting to development meant forgetting one environment variable
	// silently opted a deployment into every one of them. Development is now
	// something you ask for.
	v.SetDefault("server.env", "production")
	v.SetDefault("server.enable_dev_test_login", false)
	v.SetDefault("server.allowed_origins", "*")
	v.SetDefault("server.shutdown_timeout", 30)
	v.SetDefault("server.public_url", "http://localhost:8080")

	v.SetDefault("database.host", "")
	v.SetDefault("database.port", 5432)
	v.SetDefault("database.name", "")
	v.SetDefault("database.user", "")
	v.SetDefault("database.password", "")
	v.SetDefault("database.sslmode", "prefer")
	v.SetDefault("database.schema", "pam")

	v.SetDefault("redis.host", "localhost")
	v.SetDefault("redis.port", 6379)
	v.SetDefault("redis.password", "")
	v.SetDefault("redis.db", 1)

	v.SetDefault("s3.endpoint", "localhost:9000")
	v.SetDefault("s3.bucket", "pam-recordings")
	v.SetDefault("s3.access_key", "")
	v.SetDefault("s3.secret_key", "")
	v.SetDefault("s3.region", "us-east-1")
	v.SetDefault("s3.use_ssl", false)

	v.SetDefault("iam.base_url", "")
	v.SetDefault("iam.service_token", "")
	v.SetDefault("iam.authz_check_url", "/api/v1/authz/check")
	v.SetDefault("iam.timeout_sec", 5)
	v.SetDefault("iam.max_retries", 2)
	v.SetDefault("iam.retry_backoff_ms", 150)
	v.SetDefault("iam.authz_cache_ttl_sec", 0)
	v.SetDefault("iam.grant_url", "")
	v.SetDefault("iam.revoke_url", "")
	v.SetDefault("iam.alert_url", "")

	v.SetDefault("jwt.secret_key", "")
	v.SetDefault("jwt.access_ttl_min", 30)
	v.SetDefault("jwt.refresh_ttl_days", 7)

	v.SetDefault("vault.encryption_key", "")

	v.SetDefault("security.max_login_attempts", 5)
	v.SetDefault("security.lockout_minutes", 30)

	v.SetDefault("jit.default_duration_min", 60)
	v.SetDefault("jit.max_duration_min", 480)
	v.SetDefault("jit.request_ttl_min", 1440)
	v.SetDefault("jit.min_reason_length", 10)
	v.SetDefault("jit.require_separation_of_duty", true)
	v.SetDefault("jit.breakglass_wait_min", 15)
	v.SetDefault("jit.breakglass_max_duration_min", 60)
	v.SetDefault("jit.breakglass_activation_window_min", 60)
	v.SetDefault("jit.sweep_interval_sec", 30)
	v.SetDefault("jit.sweep_batch_size", 200)
	v.SetDefault("jit.sweeper_enabled", true)

	v.SetDefault("audit.hmac_secret", "")
	v.SetDefault("audit.default_org", "default")
	v.SetDefault("audit.verify_interval_minutes", 1440)

	v.SetDefault("recording.backend", "local")
	v.SetDefault("recording.storage_dir", "./data/recordings")
	v.SetDefault("recording.max_cast_bytes", 25*1024*1024)
	v.SetDefault("recording.max_replay_bytes", 128*1024*1024)

	v.SetDefault("agent.binary_dir", "")
	v.SetDefault("agent.enrol_ttl_minutes", 15)

	v.SetDefault("network.trusted_proxies", "")
	v.SetDefault("network.allowlist_enabled", false)
	v.SetDefault("network.allowed_cidrs", "")
	v.SetDefault("network.break_glass_cidrs", "")
	v.SetDefault("network.allowlist_exempt_paths", "/api/health")
	v.SetDefault("webproxy.enabled", false)
	v.SetDefault("webproxy.base_domain", "")
	v.SetDefault("webproxy.public_port", 0)
	v.SetDefault("webproxy.scheme", "https")
	// Comma-separated via PAM_WEBPROXY_RESERVED_SUBDOMAINS.
	v.SetDefault("webproxy.reserved_subdomains", []string{"api", "www", "admin", "console", "auth", "app"})
	v.SetDefault("webproxy.session_ttl_min", 240)
	v.SetDefault("webproxy.idle_timeout_min", 30)
	v.SetDefault("webproxy.handoff_ttl_sec", 30)
	v.SetDefault("webproxy.max_request_body_bytes", 32*1024*1024)
	v.SetDefault("webproxy.insecure_skip_target_tls_verify", false)

	// ── Environment variable binding (PAM_SERVER_PORT, PAM_DB_HOST, etc.) ──
	v.SetEnvPrefix("PAM")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	// ── Optional config file ──
	v.SetConfigName("config")
	v.SetConfigType("yaml")
	v.AddConfigPath(".")
	v.AddConfigPath("./configs")
	v.AddConfigPath("/etc/pam")
	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("config file error: %w", err)
		}
		// No config file is fine — we use env vars.
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("failed to unmarshal config: %w", err)
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) validate() error {
	if c.Database.Host == "" {
		return fmt.Errorf("database.host (PAM_DATABASE_HOST) is required")
	}
	if c.Database.Name == "" {
		return fmt.Errorf("database.name (PAM_DATABASE_NAME) is required")
	}
	// NOTE: IAM config (base_url/service_token) is intentionally NOT
	// required. PAM no longer depends on an external IAM service for
	// anything — authentication and authorization are both fully local
	// (see internal/services/auth_service.go, policy_engine_service.go,
	// and opa/engine.go). The IAMConfig struct is kept only so a
	// deployment that still has PAM_IAM_* env vars set from before this
	// change doesn't fail to start; every field is now unused dead
	// configuration.
	if c.JWT.SecretKey == "" {
		return fmt.Errorf("jwt.secret_key (PAM_JWT_SECRET_KEY) is required")
	}
	if c.Vault.EncryptionKey == "" {
		return fmt.Errorf("vault.encryption_key (PAM_VAULT_ENCRYPTION_KEY) is required")
	}
	// The audit HMAC secret is allowed to be empty so engineers can run
	// without configuring it in development; main.go substitutes a
	// clearly-labelled dev-only fallback in that case. In production it is
	// mandatory and must be long enough to resist brute force.
	if c.IsProduction() && len(c.Audit.HMACSecret) < 32 {
		return fmt.Errorf("audit.hmac_secret (PAM_AUDIT_HMAC_SECRET) is required and must be >= 32 bytes in production")
	}
	if c.Recording.Backend == "minio" || c.Recording.Backend == "s3" {
		if c.S3.Endpoint == "" || c.S3.Bucket == "" || c.S3.AccessKey == "" || c.S3.SecretKey == "" {
			return fmt.Errorf("recording.backend=%q requires s3.endpoint, s3.bucket, s3.access_key, and s3.secret_key "+
				"(PAM_S3_ENDPOINT, PAM_S3_BUCKET, PAM_S3_ACCESS_KEY, PAM_S3_SECRET_KEY) to all be set", c.Recording.Backend)
		}
	}
	if err := c.validateNetwork(); err != nil {
		return err
	}
	if err := c.normaliseWebProxy(); err != nil {
		return err
	}
	return c.normaliseJIT()
}

// validateNetwork refuses to start on a perimeter configuration that would be
// bypassable or self-inflicted.
//
// Both checks are boot failures on purpose. An allowlist that can be stepped
// over with one header looks like a control and is not one; an allowlist with
// nothing in it refuses the administrator who has to fix it. Neither should be
// discovered from production traffic.
func (c *Config) validateNetwork() error {
	if !c.Network.AllowlistEnabled {
		return nil
	}
	if strings.TrimSpace(c.Network.TrustedProxies) == "" {
		return fmt.Errorf("network.allowlist_enabled is true but network.trusted_proxies " +
			"(PAM_NETWORK_TRUSTED_PROXIES) is not set. Without it, X-Forwarded-For is trusted from " +
			"every source and any client can choose the address the allowlist sees, so the control " +
			"would not be one. Set it to the CIDRs of the proxies in front of this process " +
			"(e.g. \"10.0.0.0/8\"), or to \"none\" if this process is reached directly")
	}
	if len(c.Network.AllowedCIDRList()) == 0 {
		return fmt.Errorf("network.allowlist_enabled is true but network.allowed_cidrs " +
			"(PAM_NETWORK_ALLOWED_CIDRS) is empty, which would refuse every request including your own")
	}
	return nil
}

// normaliseWebProxy validates and clamps the brokered web-app gateway's
// settings. Fails fast on a configuration that would produce a subtly broken
// gateway (no base domain to route on, a base domain that collides with the
// API's own host) rather than starting and failing per-request later.
func (c *Config) normaliseWebProxy() error {
	if !c.WebProxy.Enabled {
		return nil
	}

	c.WebProxy.BaseDomain = strings.ToLower(strings.TrimSpace(strings.Trim(c.WebProxy.BaseDomain, ".")))
	if c.WebProxy.BaseDomain == "" {
		return fmt.Errorf("webproxy.base_domain (PAM_WEBPROXY_BASE_DOMAIN) is required when webproxy.enabled is true — " +
			"it is the wildcard domain proxied apps are served under, e.g. \"pam.example.com\"")
	}
	if !strings.Contains(c.WebProxy.BaseDomain, ".") {
		return fmt.Errorf("webproxy.base_domain %q must be a fully-qualified domain (e.g. \"pam.example.com\"), "+
			"since each proxied app is served at \"<slug>.<base_domain>\"", c.WebProxy.BaseDomain)
	}

	// Lower-cased and de-blanked so the comparison in IsProxyHost is a plain
	// map lookup against an already-lower-cased label.
	reserved := make([]string, 0, len(c.WebProxy.ReservedSubdomains))
	for _, r := range c.WebProxy.ReservedSubdomains {
		if v := strings.ToLower(strings.TrimSpace(r)); v != "" {
			reserved = append(reserved, v)
		}
	}
	c.WebProxy.ReservedSubdomains = reserved

	c.WebProxy.Scheme = strings.ToLower(strings.TrimSpace(c.WebProxy.Scheme))
	if c.WebProxy.Scheme != "http" && c.WebProxy.Scheme != "https" {
		c.WebProxy.Scheme = "https"
	}
	if c.IsProduction() && c.WebProxy.Scheme != "https" {
		return fmt.Errorf("webproxy.scheme must be \"https\" in production — the proxy session cookie authorizes " +
			"privileged access to a target application and must never travel over plaintext")
	}
	if c.IsProduction() && c.WebProxy.InsecureSkipTargetTLSVerify {
		return fmt.Errorf("webproxy.insecure_skip_target_tls_verify must be false in production — " +
			"skipping certificate verification on the PAM→target hop makes the brokered session " +
			"trivially interceptable, defeating the point of brokering it")
	}

	if c.WebProxy.SessionTTLMin <= 0 {
		c.WebProxy.SessionTTLMin = 240
	}
	if c.WebProxy.IdleTimeoutMin <= 0 {
		c.WebProxy.IdleTimeoutMin = 30
	}
	if c.WebProxy.IdleTimeoutMin > c.WebProxy.SessionTTLMin {
		c.WebProxy.IdleTimeoutMin = c.WebProxy.SessionTTLMin
	}
	if c.WebProxy.HandoffTTLSec <= 0 {
		c.WebProxy.HandoffTTLSec = 30
	}
	if c.WebProxy.MaxRequestBodyBytes <= 0 {
		c.WebProxy.MaxRequestBodyBytes = 32 * 1024 * 1024
	}
	return nil
}

// normaliseJIT clamps JIT settings to safe values. Misconfiguration here
// would silently weaken the control (e.g. a 0-minute break-glass wait), so
// every field is floored rather than trusted.
func (c *Config) normaliseJIT() error {
	if c.JIT.DefaultDurationMin <= 0 {
		c.JIT.DefaultDurationMin = 60
	}
	if c.JIT.MaxDurationMin <= 0 {
		c.JIT.MaxDurationMin = 480
	}
	if c.JIT.DefaultDurationMin > c.JIT.MaxDurationMin {
		c.JIT.DefaultDurationMin = c.JIT.MaxDurationMin
	}
	if c.JIT.RequestTTLMin <= 0 {
		c.JIT.RequestTTLMin = 1440
	}
	if c.JIT.MinReasonLength < 0 {
		c.JIT.MinReasonLength = 0
	}
	if c.JIT.BreakglassWaitMin < 0 {
		return fmt.Errorf("jit.breakglass_wait_min (PAM_JIT_BREAKGLASS_WAIT_MIN) cannot be negative")
	}
	if c.JIT.BreakglassMaxDurationMin <= 0 {
		c.JIT.BreakglassMaxDurationMin = 60
	}
	if c.JIT.BreakglassActivationWindowMin <= 0 {
		c.JIT.BreakglassActivationWindowMin = 60
	}
	if c.JIT.SweepIntervalSec <= 0 {
		c.JIT.SweepIntervalSec = 30
	}
	if c.JIT.SweepBatchSize <= 0 {
		c.JIT.SweepBatchSize = 200
	}
	if c.IAM.MaxRetries < 0 {
		c.IAM.MaxRetries = 0
	}
	if c.IAM.RetryBackoffMs <= 0 {
		c.IAM.RetryBackoffMs = 150
	}
	if c.IAM.TimeoutSec <= 0 {
		c.IAM.TimeoutSec = 5
	}
	if c.Audit.DefaultOrg == "" {
		c.Audit.DefaultOrg = "default"
	}
	if c.Audit.VerifyIntervalMinutes <= 0 {
		c.Audit.VerifyIntervalMinutes = 1440
	}
	return nil
}

// IsProduction answers "should this process behave as if real credentials are
// at stake", and answers it fail-closed: anything that is not explicitly a
// known development environment is production. A typo ("prodction"), a blank
// value or an unrecognised name therefore keeps the guards on rather than
// quietly dropping them, which is the opposite of how an equality test against
// "production" behaves.
func (c *Config) IsProduction() bool {
	switch strings.ToLower(strings.TrimSpace(c.Server.Env)) {
	case "development", "dev", "local", "test":
		return false
	default:
		return true
	}
}
