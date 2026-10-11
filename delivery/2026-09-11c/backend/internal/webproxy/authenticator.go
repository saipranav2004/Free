// pam/internal/webproxy/authenticator.go
//
// Target-application login strategies. Each Authenticator performs the
// target's own login flow SERVER-SIDE (PAM → target, over Go's http.Client)
// and returns the resulting upstream authentication state — a captured
// cookie jar and/or headers to inject on every subsequent proxied request.
//
// Doing the login server-side is the entire point, and it is what makes this
// work where a browser-based approach cannot:
//
//   - No CORS. CORS is a browser policy; it does not exist for a server
//     making an HTTP call. MinIO's console API, for one, refuses a
//     cross-origin browser login outright (no preflight support — verified
//     live: OPTIONS returns 405) AND rejects the form-encoded body a plain
//     cross-origin HTML form would have to send (415, "only application/json
//     are allowed"). Server-side, both problems simply do not arise.
//   - No credential exposure. The target's password/secret key is used here,
//     inside this process, and the resulting session token is stored
//     encrypted server-side. The browser receives neither.
//
// Adding support for a new web application means adding a strategy here (or,
// for the common cases, just configuring "form_post"/"json_post" via the
// resource's extra_config) — no change to the proxy itself.
package webproxy

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// UpstreamState is everything needed to speak to the target as the
// authenticated principal, captured once at login and replayed on every
// proxied request. Persisted encrypted (see models.WebProxySession's
// UpstreamStateEnc) because it is, functionally, a live credential.
type UpstreamState struct {
	// Cookies is the captured upstream cookie jar, keyed by cookie name.
	// Stored flat (name → value) rather than as full http.Cookie structs:
	// only the name/value pair is replayed upstream, and attributes like
	// Domain/Path/Secure belong to the browser-facing side of the proxy,
	// which serves its own PAM cookie instead.
	Cookies map[string]string `json:"cookies,omitempty"`

	// Headers are injected verbatim on every proxied request — the
	// mechanism for header-authenticated targets (Basic, Bearer, or a
	// vendor-specific API-key header).
	Headers map[string]string `json:"headers,omitempty"`
}

func (s *UpstreamState) setCookie(name, value string) {
	if s.Cookies == nil {
		s.Cookies = map[string]string{}
	}
	s.Cookies[name] = value
}

func (s *UpstreamState) setHeader(name, value string) {
	if s.Headers == nil {
		s.Headers = map[string]string{}
	}
	s.Headers[name] = value
}

// Target is the resolved connection detail an Authenticator logs in against.
// Mirrors the subset of services.ConnectionInfo the login flow needs, kept
// as its own struct so this package doesn't import services (services will
// import this one).
type Target struct {
	// BaseURL is the target application's own origin, e.g.
	// "http://10.0.0.5:9001" — derived from the resource's console_url when
	// set, else scheme://host:port.
	BaseURL string

	Username string
	Password string

	// ExtraConfig is the resource's parsed extra_config, carrying
	// per-application login tuning (see each strategy for the keys it reads).
	ExtraConfig map[string]interface{}
}

// Authenticator performs one application's login flow.
type Authenticator interface {
	// Name identifies the strategy in logs and in
	// models.WebProxySession.AuthStrategy.
	Name() string

	// Login authenticates against the target and returns the upstream state
	// to replay on proxied requests. An error here fails the whole
	// "open in browser" attempt — deliberately: silently proxying an
	// UNAUTHENTICATED session would dump the operator on the target's own
	// login page, which is exactly the credential-exposing flow this feature
	// exists to eliminate.
	Login(ctx context.Context, client *http.Client, target Target) (*UpstreamState, error)
}

// Registry maps a strategy name to its Authenticator.
type Registry struct {
	strategies map[string]Authenticator
}

func NewRegistry() *Registry {
	r := &Registry{strategies: map[string]Authenticator{}}
	for _, a := range []Authenticator{
		&MinIOConsoleAuthenticator{},
		&NextAuthCredentialsAuthenticator{},
		&JSONPostAuthenticator{},
		&FormPostAuthenticator{},
		&BasicAuthAuthenticator{},
		&BearerTokenAuthenticator{},
		&NoAuthAuthenticator{},
	} {
		r.strategies[a.Name()] = a
	}
	return r
}

// Get resolves the strategy for a resource. The explicit
// extra_config.web_auth_strategy always wins; otherwise a sensible default
// is inferred from the resource type so the common cases need no
// configuration at all. An unknown explicit strategy is an error rather than
// a silent fallback — a typo in a security-relevant setting must not
// degrade quietly into "no authentication."
func (r *Registry) Get(resourceType string, extraConfig map[string]interface{}) (Authenticator, error) {
	if explicit, _ := extraConfig["web_auth_strategy"].(string); explicit != "" {
		a, ok := r.strategies[strings.ToLower(strings.TrimSpace(explicit))]
		if !ok {
			return nil, fmt.Errorf("unknown web_auth_strategy %q — valid values: %s",
				explicit, strings.Join(r.names(), ", "))
		}
		return a, nil
	}

	switch strings.ToLower(resourceType) {
	case "minio":
		return r.strategies[strategyMinIOConsole], nil
	case "langfuse":
		// Langfuse is a Next.js app authenticating through NextAuth's
		// credentials provider (web/src/server/auth.ts). Inferred rather than
		// configured so an operator opening a Langfuse resource lands inside
		// the app, instead of on its sign-in form being asked for a password
		// PAM is already holding.
		return r.strategies[strategyNextAuth], nil
	default:
		// No inference available: proxy + audit still work, the operator just
		// authenticates to the app itself. Better than guessing a login flow
		// and firing credentials at an endpoint that may not be a login form
		// at all.
		return r.strategies[strategyNone], nil
	}
}

func (r *Registry) names() []string {
	out := make([]string, 0, len(r.strategies))
	for n := range r.strategies {
		out = append(out, n)
	}
	return out
}

const (
	strategyMinIOConsole = "minio_console"
	strategyJSONPost     = "json_post"
	strategyFormPost     = "form_post"
	strategyBasicAuth    = "basic_auth"
	strategyBearerToken  = "bearer_token"
	strategyNone         = "none"
)

// ── MinIO Console ─────────────────────────────────────────────────────────

// MinIOConsoleAuthenticator speaks MinIO Console's documented login API:
// POST /api/v1/login with a JSON {accessKey, secretKey} body, which responds
// with a "token" session cookie.
//
// Verified against a live MinIO Console (RELEASE.2025-08-13): a JSON POST
// returns 204 with Set-Cookie: token=...; HttpOnly; SameSite=Lax. The same
// request form-encoded returns 415, and there is no CORS preflight support
// at all — which is precisely why this has to happen server-side.
type MinIOConsoleAuthenticator struct{}

func (a *MinIOConsoleAuthenticator) Name() string { return strategyMinIOConsole }

func (a *MinIOConsoleAuthenticator) Login(ctx context.Context, client *http.Client, target Target) (*UpstreamState, error) {
	body, err := json.Marshal(map[string]string{
		"accessKey": target.Username,
		"secretKey": target.Password,
	})
	if err != nil {
		return nil, fmt.Errorf("encode minio login body: %w", err)
	}

	loginURL := strings.TrimRight(target.BaseURL, "/") + "/api/v1/login"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, loginURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build minio login request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("minio console login request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusCreated {
		// Only 401/403 actually means "the credential is wrong". Verified
		// against a live console (RELEASE.2025-08-13): a wrong secret, an
		// empty secret, an empty access key and an over-short secret ALL
		// answer 401 {"message":"invalid login"}. Any other status is far
		// more likely to mean this URL is not a Console login endpoint at
		// all — and blaming the vault for that sends an admin off rotating a
		// perfectly good credential while the real fault (a misconfigured
		// console_url) goes untouched.
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return nil, fmt.Errorf("minio console rejected the stored credential (status %d) — "+
				"check the resource's access key/secret key in the vault", resp.StatusCode)
		}
		hint := "check the resource's console_url points at the MinIO Console, not another service"
		// The S3 API answers this path with 400 BadRequest and identifies
		// itself as "MinIO" where the Console says "MinIO Console" — the
		// single most common misconfiguration (console_url set to the API
		// port 9000 instead of the Console port 9001), and cheap to name
		// outright instead of making someone diff two port numbers.
		if srv := resp.Header.Get("Server"); strings.Contains(srv, "MinIO") && !strings.Contains(srv, "Console") {
			hint = "console_url is pointing at the MinIO S3 API port, which rejects this path — " +
				"point it at the MinIO Console port instead (9001 by default, vs 9000 for the S3 API)"
		}
		return nil, fmt.Errorf("%s did not answer MinIO Console's login API (status %d) — %s",
			loginURL, resp.StatusCode, hint)
	}

	state := &UpstreamState{}
	for _, ck := range resp.Cookies() {
		state.setCookie(ck.Name, ck.Value)
	}
	if len(state.Cookies) == 0 {
		return nil, fmt.Errorf("minio console login returned no session cookie (status %d) — "+
			"the console may be running a version with a different login API", resp.StatusCode)
	}
	return state, nil
}

// ── Generic JSON login ────────────────────────────────────────────────────

// JSONPostAuthenticator handles any application whose login is a JSON POST
// returning a session cookie. Configured entirely through the resource's
// extra_config, so onboarding such an app needs no code change:
//
//	web_login_path        (default "/api/v1/login")
//	web_username_field    (default "username")
//	web_password_field    (default "password")
//	web_extra_login_fields  optional object merged into the body verbatim,
//	                        for apps needing a constant alongside the
//	                        credential (e.g. {"realm": "internal"})
type JSONPostAuthenticator struct{}

func (a *JSONPostAuthenticator) Name() string { return strategyJSONPost }

func (a *JSONPostAuthenticator) Login(ctx context.Context, client *http.Client, target Target) (*UpstreamState, error) {
	payload := map[string]interface{}{
		stringOr(target.ExtraConfig, "web_username_field", "username"): target.Username,
		stringOr(target.ExtraConfig, "web_password_field", "password"): target.Password,
	}
	if extra, ok := target.ExtraConfig["web_extra_login_fields"].(map[string]interface{}); ok {
		for k, v := range extra {
			payload[k] = v
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode login body: %w", err)
	}

	loginURL := strings.TrimRight(target.BaseURL, "/") + stringOr(target.ExtraConfig, "web_login_path", "/api/v1/login")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, loginURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build login request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	return doLoginAndCaptureCookies(client, req, "json login")
}

// ── Generic HTML form login ───────────────────────────────────────────────

// FormPostAuthenticator handles the classic server-rendered login form
// (application/x-www-form-urlencoded), covering most self-hosted admin UIs
// that predate SPA login APIs. Same extra_config keys as JSONPostAuthenticator,
// with web_login_path defaulting to "/login".
type FormPostAuthenticator struct{}

func (a *FormPostAuthenticator) Name() string { return strategyFormPost }

func (a *FormPostAuthenticator) Login(ctx context.Context, client *http.Client, target Target) (*UpstreamState, error) {
	form := url.Values{}
	form.Set(stringOr(target.ExtraConfig, "web_username_field", "username"), target.Username)
	form.Set(stringOr(target.ExtraConfig, "web_password_field", "password"), target.Password)
	if extra, ok := target.ExtraConfig["web_extra_login_fields"].(map[string]interface{}); ok {
		for k, v := range extra {
			form.Set(k, fmt.Sprintf("%v", v))
		}
	}

	loginURL := strings.TrimRight(target.BaseURL, "/") + stringOr(target.ExtraConfig, "web_login_path", "/login")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, loginURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build login request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	return doLoginAndCaptureCookies(client, req, "form login")
}

// ── Header-based auth (no login round trip) ───────────────────────────────

// BasicAuthAuthenticator injects HTTP Basic credentials on every proxied
// request. No login call is made — Basic has no session concept — so this
// never fails at open time; a wrong credential surfaces as the target's own
// 401 on the first real request.
type BasicAuthAuthenticator struct{}

func (a *BasicAuthAuthenticator) Name() string { return strategyBasicAuth }

func (a *BasicAuthAuthenticator) Login(ctx context.Context, client *http.Client, target Target) (*UpstreamState, error) {
	state := &UpstreamState{}
	state.setHeader("Authorization", "Basic "+basicAuthValue(target.Username, target.Password))
	return state, nil
}

// BearerTokenAuthenticator injects the vaulted secret as a bearer token —
// for applications fronted by an API key rather than a login session. The
// header name is configurable (extra_config.web_auth_header, default
// "Authorization") for vendors using a custom header such as "X-API-Key",
// as is the prefix (extra_config.web_auth_header_prefix, default "Bearer ").
type BearerTokenAuthenticator struct{}

func (a *BearerTokenAuthenticator) Name() string { return strategyBearerToken }

func (a *BearerTokenAuthenticator) Login(ctx context.Context, client *http.Client, target Target) (*UpstreamState, error) {
	header := stringOr(target.ExtraConfig, "web_auth_header", "Authorization")
	// Presence-checked rather than emptiness-checked: an EXPLICIT empty
	// prefix is a meaningful configuration (a raw "X-API-Key: <key>" header
	// carries no prefix at all), and collapsing it to the "Bearer " default
	// would send a header the target rejects.
	prefix := "Bearer "
	if raw, ok := target.ExtraConfig["web_auth_header_prefix"]; ok {
		if s, isString := raw.(string); isString {
			prefix = s
		}
	}
	state := &UpstreamState{}
	state.setHeader(header, prefix+target.Password)
	return state, nil
}

// NoAuthAuthenticator brokers and audits the session without injecting any
// credential — the honest default for an application PAM has no login
// strategy for yet. The operator authenticates to the app themselves, but
// every request still flows through the proxy, so the access is still
// gated by RBAC/PBAC + JIT, still recorded in the activity log, and still
// killable centrally. Strictly better than sending them at the app directly.
type NoAuthAuthenticator struct{}

func (a *NoAuthAuthenticator) Name() string { return strategyNone }

func (a *NoAuthAuthenticator) Login(ctx context.Context, client *http.Client, target Target) (*UpstreamState, error) {
	return &UpstreamState{}, nil
}

// ── shared helpers ────────────────────────────────────────────────────────

// doLoginAndCaptureCookies executes a prepared login request and turns the
// response into an UpstreamState, treating "2xx/3xx but no cookie" as a
// failure: a login that sets no session is not a login, and proxying
// onward from there would silently land the operator on the app's own login
// page.
func doLoginAndCaptureCookies(client *http.Client, req *http.Request, what string) (*UpstreamState, error) {
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s request failed: %w", what, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("%s rejected the stored credential (status %d)", what, resp.StatusCode)
	}

	state := &UpstreamState{}
	for _, ck := range resp.Cookies() {
		state.setCookie(ck.Name, ck.Value)
	}
	if len(state.Cookies) == 0 {
		return nil, fmt.Errorf("%s returned no session cookie (status %d) — "+
			"the configured login path or field names may not match this application", what, resp.StatusCode)
	}
	return state, nil
}

func stringOr(cfg map[string]interface{}, key, fallback string) string {
	if v, ok := cfg[key].(string); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return fallback
}

func basicAuthValue(username, password string) string {
	return base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
}
