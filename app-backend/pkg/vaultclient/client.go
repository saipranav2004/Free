// Package vaultclient is the application-side SDK for reading secrets out of
// the PAM vault at runtime.
//
// The problem it solves is not "make an HTTP request", it is "let a process
// use a privileged credential continuously, across rotations, without ever
// being the reason the vault falls over and without ever being the reason a
// revoked credential stays live."
//
// # Flow
//
//	New(Config)            → resolves the service token (literal, file, or env)
//	Get(ctx, "safe/x/y")   → cache hit, or one authenticated GET to the vault
//	                         GET /api/v1/pam/svc/secrets/<path>?purpose=...
//	                         Header: X-Service-Token: pamsvc.<id>.<secret>
//	Close()                → stops the janitor, drops every cached plaintext
//
// # Caching model
//
// The server is authoritative about lifetime: every response carries
// cache_ttl_seconds already clamped to min(grant cap, deployment default,
// time-to-rotation, remaining token life). This client never invents a TTL of
// its own; it only ever shortens.
//
// Each entry therefore gets two deadlines:
//
//	refreshAt = fetched + TTL*refreshLead  (jittered)   → start refreshing
//	expiresAt = fetched + TTL                           → stop serving
//
// A read between those two returns the cached value immediately and kicks off
// a background refresh. That is what keeps rotation invisible to the caller:
// by the time the old value expires, the new one is already in place, and no
// request ever paid the latency. A read after expiresAt blocks on a fetch,
// which is correct but is the case worth avoiding.
//
// The jitter matters at fleet scale. A hundred pods that started together and
// share a TTL will otherwise refresh in the same instant, forever, the vault
// sees a flat line with periodic vertical spikes. Spreading refreshAt across
// ±10% breaks that lockstep permanently.
//
// # What is deliberately NOT here
//
// There is no background loop that refreshes every known secret on a timer.
// The previous implementation had one, and it fetched every cached secret
// every five minutes and then *discarded the result*, so it produced load
// without producing freshness, forever, including for secrets the application
// had stopped using hours earlier. Refresh here is driven by reads, so an
// unused secret costs exactly zero requests.
//
// # Concurrency
//
// Safe for concurrent use. Cache misses for the same path are collapsed:
// a thousand goroutines starting at once produce one HTTP request, and all
// thousand receive its result. Without that, every cold start and every
// post-expiry moment is a self-inflicted thundering herd against the one
// service that must not be down.
package vaultclient

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Errors callers are expected to branch on. Everything else is transport or
// server failure and should be treated as retryable-then-fatal.
var (
	// ErrUnauthenticated means the service token is unknown, expired or
	// revoked. Retrying with the same token will not help.
	ErrUnauthenticated = errors.New("vaultclient: service token rejected")

	// ErrForbidden means the token is valid but holds no grant covering this
	// path. This is a provisioning problem, not a transient one.
	ErrForbidden = errors.New("vaultclient: not authorized for this secret")

	// ErrNotFound means no such secret.
	ErrNotFound = errors.New("vaultclient: secret not found")

	// ErrAmbiguous means a bare name matched credentials in more than one
	// safe. Qualify it as <safe>/<folder>/<name>.
	ErrAmbiguous = errors.New("vaultclient: secret name is ambiguous, use the full path")

	// ErrRateLimited means this identity exceeded its read budget.
	ErrRateLimited = errors.New("vaultclient: rate limited by vault")

	// ErrClosed is returned by every method after Close.
	ErrClosed = errors.New("vaultclient: client is closed")
)

// Logger is the minimal sink this package needs. It is deliberately not
// io.Writer or a concrete logger: applications already have one, and the
// dependency should point their way, not ours.
//
// Nothing passed to it ever contains a secret value or a token.
type Logger interface {
	Debugf(format string, args ...any)
	Warnf(format string, args ...any)
}

// Secret is one retrieved credential and the metadata needed to use it.
type Secret struct {
	// Path is the canonical address the vault resolved this to. It may be
	// more qualified than what was asked for.
	Path string

	// Value is the plaintext. For a password credential the matching username
	// is AccountName; for an api_key or token it is the whole credential.
	Value string

	// AccountName is the login this credential belongs to.
	AccountName string

	// Type is the credential type: password, ssh_key, api_key, token,
	// connection_string, x509_cert, kerberos_keytab.
	Type string

	// Version increments on every rotation. A caller that wants to react to a
	// rotation, reopen a pool, re-dial, compares this across reads rather
	// than comparing the secret values, which avoids holding the old
	// plaintext just to diff against it.
	Version int

	// RotatesAt, when set, is when the vault next plans to change this
	// credential at the target.
	RotatesAt *time.Time

	// NotAfter is when this copy stops being servable from cache.
	NotAfter time.Time
}

// String redacts. It exists so the overwhelmingly most likely way to leak a
// credential into a log file, fmt.Printf("%v"/"%+v"/"%s", secret) somewhere
// in the calling application, produces nothing useful. Defined on the value
// receiver so it applies to both Secret and *Secret.
func (s Secret) String() string {
	return fmt.Sprintf("Secret{path:%s account:%s type:%s version:%d value:[REDACTED]}",
		s.Path, s.AccountName, s.Type, s.Version)
}

// GoString redacts under %#v as well.
func (s Secret) GoString() string { return s.String() }

// MarshalJSON redacts. A Secret must never be serialised into a response
// body, a trace attribute, or a structured log field by accident.
func (s Secret) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Path        string `json:"path"`
		AccountName string `json:"account_name"`
		Type        string `json:"credential_type"`
		Version     int    `json:"version"`
		Value       string `json:"value"`
	}{s.Path, s.AccountName, s.Type, s.Version, "[REDACTED]"})
}

// Config configures a Client. Only Address and Purpose are required; the
// token is resolved from Token, then TokenFile, then $PAM_SERVICE_TOKEN.
type Config struct {
	// Address is the PAM base URL, e.g. "https://pam.internal:8443". Plain
	// http is rejected unless AllowInsecureTransport is set: a service token
	// in a cleartext header is a credential on the wire.
	Address string

	// Purpose is recorded on every audit row this client generates. It is
	// mandatory server-side, and it is what makes the trail answerable to
	// "why did billing-api read the DB root password at 03:00". Name the
	// workload, not the operation: "billing-api settlement job".
	Purpose string

	// Token is the service token (pamsvc.<id>.<secret>). Prefer TokenFile.
	Token string

	// TokenFile is a path to a file containing the token. This is the
	// preferred source, and not only for hygiene: it is re-read whenever the
	// vault rejects the current token, so rotating the token becomes "write
	// the new one to the file", a Kubernetes projected volume update, a
	// systemd credential refresh, a config-management run, with no restart
	// and no dropped requests.
	TokenFile string

	// AllowInsecureTransport permits a plain-http Address. Development only.
	AllowInsecureTransport bool

	// TLSConfig overrides TLS settings, e.g. to pin an internal CA. Ignored
	// when HTTPClient is supplied.
	TLSConfig *tls.Config

	// HTTPClient replaces the built-in transport wholesale. Supplying one
	// opts out of the tuned connection pool below, so it should carry its own
	// timeout and keep-alive settings.
	HTTPClient *http.Client

	// Timeout bounds a single vault request. Default 10s.
	Timeout time.Duration

	// MaxRetries is the number of additional attempts after a failed request.
	// Only network errors, 429 and 5xx are retried, a 403 is a decision, not
	// a fault, and retrying it just burns the read budget. Default 3.
	MaxRetries int

	// RefreshLead is the fraction of the TTL at which a read starts a
	// background refresh. Default 0.75. Values outside (0,1) are clamped.
	RefreshLead float64

	// StaleGrace is how long past expiry a cached value may still be served
	// when the vault itself is unreachable. This is the deliberate trade at
	// the centre of the design: a vault outage degrades to "slightly stale
	// credentials" instead of "total application outage". It applies ONLY to
	// transport and 5xx failures, an explicit 401/403/404 evicts
	// immediately, because those mean the answer changed, not that the answer
	// is unavailable. Default 5m; set negative to disable.
	StaleGrace time.Duration

	// Logger is optional. Never receives secret values or tokens.
	Logger Logger
}

// Client retrieves and caches secrets. Create with New; safe for concurrent
// use; call Close when done.
type Client struct {
	baseURL     string
	purpose     string
	tokenFile   string
	http        *http.Client
	maxRetries  int
	refreshLead float64
	staleGrace  time.Duration
	log         Logger

	// tokenMu guards the in-memory token only. It is separate from mu so a
	// token reload cannot block cache reads.
	tokenMu sync.RWMutex
	token   string

	mu      sync.RWMutex
	entries map[string]*entry
	closed  bool

	// inflight collapses concurrent misses on the same path onto one request.
	flightMu sync.Mutex
	inflight map[string]*call

	stop     chan struct{}
	stopOnce sync.Once
	wg       sync.WaitGroup

	// rng is seeded per client and guarded, because math/rand's global source
	// is a shared mutex that a hot cache path has no business contending on.
	rngMu sync.Mutex
	rng   *rand.Rand
}

type entry struct {
	secret    Secret
	refreshAt time.Time
	expiresAt time.Time

	// refreshing prevents a burst of reads in the stale window from each
	// launching their own background refresh.
	refreshing bool
}

// call is one in-flight fetch that other goroutines can wait on.
type call struct {
	done   chan struct{}
	secret Secret
	err    error
}

const (
	defaultTimeout     = 10 * time.Second
	defaultMaxRetries  = 3
	defaultRefreshLead = 0.75
	defaultStaleGrace  = 5 * time.Minute
	janitorInterval    = time.Minute

	// maxEntries bounds memory, and bounds how much plaintext exists in the
	// process at once. A workload legitimately holding more than this many
	// distinct secrets should be split, not cached harder.
	maxEntries = 512
)

// New builds a Client and resolves its service token. It performs no network
// I/O: a vault that is briefly down at process start should not prevent the
// process from starting.
func New(cfg Config) (*Client, error) {
	addr := strings.TrimRight(strings.TrimSpace(cfg.Address), "/")
	if addr == "" {
		return nil, errors.New("vaultclient: Address is required")
	}
	u, err := url.Parse(addr)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("vaultclient: Address must be an absolute http(s) URL, got %q", cfg.Address)
	}
	if u.Scheme == "http" && !cfg.AllowInsecureTransport {
		return nil, errors.New("vaultclient: refusing plaintext http, the service token would travel in cleartext (set AllowInsecureTransport for local development only)")
	}
	if strings.TrimSpace(cfg.Purpose) == "" {
		return nil, errors.New("vaultclient: Purpose is required, it is recorded on every audit row")
	}

	c := &Client{
		baseURL:     addr,
		purpose:     strings.TrimSpace(cfg.Purpose),
		tokenFile:   cfg.TokenFile,
		maxRetries:  orInt(cfg.MaxRetries, defaultMaxRetries),
		refreshLead: cfg.RefreshLead,
		staleGrace:  cfg.StaleGrace,
		log:         cfg.Logger,
		entries:     make(map[string]*entry),
		inflight:    make(map[string]*call),
		stop:        make(chan struct{}),
		rng:         rand.New(rand.NewSource(time.Now().UnixNano())),
	}
	if c.refreshLead <= 0 || c.refreshLead >= 1 {
		c.refreshLead = defaultRefreshLead
	}
	if cfg.StaleGrace == 0 {
		c.staleGrace = defaultStaleGrace
	} else if cfg.StaleGrace < 0 {
		c.staleGrace = 0
	}

	token, err := resolveToken(cfg)
	if err != nil {
		return nil, err
	}
	c.token = token

	c.http = cfg.HTTPClient
	if c.http == nil {
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = defaultTimeout
		}
		// A dedicated transport rather than http.DefaultTransport: this client
		// talks to exactly one host, so a small warm pool keeps every read on
		// an established TLS connection. Handshaking per read would dominate
		// the latency of an operation that is otherwise a single indexed
		// lookup on the server.
		c.http = &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
				MaxIdleConns:          16,
				MaxIdleConnsPerHost:   8,
				IdleConnTimeout:       90 * time.Second,
				TLSHandshakeTimeout:   5 * time.Second,
				ExpectContinueTimeout: time.Second,
				ForceAttemptHTTP2:     true,
				TLSClientConfig:       cfg.TLSConfig,
			},
			// Never follow a redirect: it could send the service token to
			// another host.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}

	c.wg.Add(1)
	go c.janitor()
	return c, nil
}

// resolveToken reads the token from the first source that yields one, and
// validates its shape locally so a misconfiguration surfaces at startup
// rather than as an opaque 401 on the first read.
func resolveToken(cfg Config) (string, error) {
	if t := strings.TrimSpace(cfg.Token); t != "" {
		return validateToken(t)
	}
	if cfg.TokenFile != "" {
		b, err := os.ReadFile(cfg.TokenFile)
		if err != nil {
			return "", fmt.Errorf("vaultclient: reading TokenFile: %w", err)
		}
		return validateToken(strings.TrimSpace(string(b)))
	}
	if t := strings.TrimSpace(os.Getenv("PAM_SERVICE_TOKEN")); t != "" {
		return validateToken(t)
	}
	return "", errors.New("vaultclient: no service token (set Config.Token, Config.TokenFile, or $PAM_SERVICE_TOKEN)")
}

func validateToken(t string) (string, error) {
	// Shape only: pamsvc.<id>.<secret>. Never log any part of it, the id half
	// is public but printing it invites printing the whole string later.
	if parts := strings.Split(t, "."); len(parts) != 3 || parts[0] != "pamsvc" || parts[1] == "" || parts[2] == "" {
		return "", errors.New("vaultclient: malformed service token (expected pamsvc.<id>.<secret>)")
	}
	return t, nil
}

// ── Public API ───────────────────────────────────────────────────────────────

// Get returns a secret by canonical path ("prod-db/postgres/pg-app") or by
// credential UUID, serving from cache when possible.
//
// It is cheap enough to call on every request that needs the credential, and
// that is the intended usage: it means the caller never holds a stale copy of
// its own, and a rotation propagates as soon as this client sees it.
func (c *Client) Get(ctx context.Context, path string) (Secret, error) {
	key := strings.Trim(strings.TrimSpace(path), "/")
	if key == "" {
		return Secret{}, errors.New("vaultclient: secret path is required")
	}

	c.mu.RLock()
	closed := c.closed
	e, ok := c.entries[key]
	var (
		secret     Secret
		fresh      bool
		servable   bool
		needsAsync bool
	)
	if ok {
		now := time.Now()
		secret = e.secret
		fresh = now.Before(e.refreshAt)
		servable = now.Before(e.expiresAt)
		needsAsync = servable && !fresh && !e.refreshing
	}
	c.mu.RUnlock()

	if closed {
		return Secret{}, ErrClosed
	}
	if fresh {
		return secret, nil
	}
	if servable {
		// Stale but still valid: answer now, refresh behind the caller's back.
		// This is the whole point of refreshLead, after the first fetch, a
		// steadily-used secret is never again fetched on the critical path.
		if needsAsync {
			c.refreshAsync(key)
		}
		return secret, nil
	}

	return c.fetchShared(ctx, key)
}

// GetValue is Get for callers that only need the plaintext.
func (c *Client) GetValue(ctx context.Context, path string) (string, error) {
	s, err := c.Get(ctx, path)
	if err != nil {
		return "", err
	}
	return s.Value, nil
}

// GetResourceSecrets returns every secret attached to a resource that this
// identity is allowed to read, keyed by account name.
//
// Results are NOT cached: the batch endpoint is for wiring up a connection at
// startup, where one request beats N. Anything read repeatedly should be read
// through Get by path so it participates in caching and refresh.
func (c *Client) GetResourceSecrets(ctx context.Context, resourceID string) (map[string]Secret, error) {
	if c.isClosed() {
		return nil, ErrClosed
	}
	id := strings.TrimSpace(resourceID)
	if id == "" {
		return nil, errors.New("vaultclient: resource id is required")
	}

	var payload struct {
		Data map[string]secretWire `json:"data"`
	}
	if err := c.do(ctx, "/api/v1/pam/svc/resources/"+url.PathEscape(id)+"/secrets", &payload); err != nil {
		return nil, err
	}

	out := make(map[string]Secret, len(payload.Data))
	for account, wire := range payload.Data {
		out[account] = wire.toSecret()
	}
	return out, nil
}

// Invalidate drops a cached secret so the next Get re-reads it. Use it when
// the credential is rejected by the target, that is the one signal this
// client cannot get from the vault, and the correct response to it is to stop
// trusting the cached copy.
func (c *Client) Invalidate(path string) {
	key := strings.Trim(strings.TrimSpace(path), "/")
	c.mu.Lock()
	delete(c.entries, key)
	c.mu.Unlock()
}

// Close stops the background janitor and drops every cached plaintext. It is
// idempotent.
//
// Dropping the map is the strongest thing achievable here: Go strings are
// immutable and may have been copied by the runtime, so there is no honest
// way to promise a plaintext has been scrubbed from process memory. What this
// does guarantee is that no further reference is held, so the values become
// collectable and a heap dump taken later is far less likely to contain them.
func (c *Client) Close() error {
	c.stopOnce.Do(func() { close(c.stop) })
	c.wg.Wait()

	c.mu.Lock()
	c.closed = true
	c.entries = make(map[string]*entry)
	c.mu.Unlock()

	if t, ok := c.http.Transport.(*http.Transport); ok {
		t.CloseIdleConnections()
	}
	return nil
}

// ── Fetch, dedup, refresh ────────────────────────────────────────────────────

// fetchShared performs a fetch, collapsing concurrent callers for the same key
// onto a single request.
func (c *Client) fetchShared(ctx context.Context, key string) (Secret, error) {
	c.flightMu.Lock()
	if existing, ok := c.inflight[key]; ok {
		c.flightMu.Unlock()
		select {
		case <-existing.done:
			return existing.secret, existing.err
		case <-ctx.Done():
			// This caller gave up; the shared fetch continues for the others.
			return Secret{}, ctx.Err()
		}
	}
	cl := &call{done: make(chan struct{})}
	c.inflight[key] = cl
	c.flightMu.Unlock()

	cl.secret, cl.err = c.fetchAndStore(ctx, key)
	close(cl.done)

	c.flightMu.Lock()
	delete(c.inflight, key)
	c.flightMu.Unlock()

	return cl.secret, cl.err
}

// refreshAsync renews an entry that is inside its stale window, off the
// caller's critical path. Marking the entry refreshing under the lock is what
// keeps a burst of concurrent reads to one background fetch.
func (c *Client) refreshAsync(key string) {
	c.mu.Lock()
	e, ok := c.entries[key]
	if !ok || e.refreshing || c.closed {
		c.mu.Unlock()
		return
	}
	e.refreshing = true
	c.mu.Unlock()

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer func() {
			c.mu.Lock()
			if cur, ok := c.entries[key]; ok {
				cur.refreshing = false
			}
			c.mu.Unlock()
		}()

		// Not derived from the triggering request's context: that request may
		// well finish first, and cancelling the refresh with it would leave
		// the entry stale and re-trigger on the next read.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		if _, err := c.fetchShared(ctx, key); err != nil {
			c.warnf("background refresh failed for %s: %v", key, err)
		}
	}()
}

// fetchAndStore does the request and updates the cache.
func (c *Client) fetchAndStore(ctx context.Context, key string) (Secret, error) {
	var payload struct {
		Data secretWire `json:"data"`
	}
	err := c.do(ctx, "/api/v1/pam/svc/secrets/"+escapePath(key), &payload)
	if err != nil {
		// An authoritative "no" invalidates whatever we hold: the grant was
		// withdrawn, the token died, or the secret is gone. Continuing to
		// serve a cached copy past that point is exactly the failure a vault
		// exists to prevent.
		if errors.Is(err, ErrForbidden) || errors.Is(err, ErrUnauthenticated) || errors.Is(err, ErrNotFound) {
			c.Invalidate(key)
			return Secret{}, err
		}
		// Otherwise the vault is unavailable, not disagreeing. Serve stale
		// within the grace window rather than taking the application down
		// with it.
		if s, ok := c.stale(key); ok {
			c.warnf("vault unreachable (%v); serving cached %s past expiry", err, key)
			return s, nil
		}
		return Secret{}, err
	}

	secret := payload.Data.toSecret()
	ttl := time.Duration(payload.Data.CacheTTLSeconds) * time.Second
	if ttl <= 0 {
		// A server that declines to say means "do not cache". Return the value
		// but keep nothing.
		c.Invalidate(key)
		return secret, nil
	}

	now := time.Now()
	expiresAt := now.Add(ttl)
	// Honour an explicit rotation deadline even if it is sooner than the TTL.
	if secret.RotatesAt != nil && secret.RotatesAt.Before(expiresAt) {
		expiresAt = *secret.RotatesAt
	}
	secret.NotAfter = expiresAt

	lead := time.Duration(float64(expiresAt.Sub(now)) * c.refreshLead)
	refreshAt := now.Add(c.jitter(lead))

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return secret, nil
	}
	// Evict before insert so the map cannot exceed the bound even transiently.
	if _, exists := c.entries[key]; !exists && len(c.entries) >= maxEntries {
		c.evictOldestLocked()
	}
	if e, ok := c.entries[key]; ok {
		e.secret, e.refreshAt, e.expiresAt = secret, refreshAt, expiresAt
	} else {
		c.entries[key] = &entry{secret: secret, refreshAt: refreshAt, expiresAt: expiresAt}
	}
	c.mu.Unlock()

	c.debugf("cached %s (version=%d ttl=%s)", secret.Path, secret.Version, ttl)
	return secret, nil
}

// stale returns an expired entry if it is still inside the grace window.
func (c *Client) stale(key string) (Secret, bool) {
	if c.staleGrace <= 0 {
		return Secret{}, false
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[key]
	if !ok || time.Now().After(e.expiresAt.Add(c.staleGrace)) {
		return Secret{}, false
	}
	return e.secret, true
}

// jitter spreads refresh times by ±10% so a fleet started together does not
// stay in lockstep against the vault for the life of the deployment.
func (c *Client) jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	c.rngMu.Lock()
	f := 0.9 + 0.2*c.rng.Float64()
	c.rngMu.Unlock()
	return time.Duration(float64(d) * f)
}

// evictOldestLocked drops the entry closest to expiry. Caller holds c.mu.
func (c *Client) evictOldestLocked() {
	var oldestKey string
	var oldest time.Time
	for k, e := range c.entries {
		if oldestKey == "" || e.expiresAt.Before(oldest) {
			oldestKey, oldest = k, e.expiresAt
		}
	}
	if oldestKey != "" {
		delete(c.entries, oldestKey)
	}
}

// janitor drops entries that are past expiry plus the grace window, so a
// long-lived process does not accumulate plaintext for secrets it stopped
// using. It does not fetch anything, refresh is read-driven by design.
func (c *Client) janitor() {
	defer c.wg.Done()
	t := time.NewTicker(janitorInterval)
	defer t.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-t.C:
			cutoff := time.Now().Add(-c.staleGrace)
			c.mu.Lock()
			for k, e := range c.entries {
				if e.expiresAt.Before(cutoff) && !e.refreshing {
					delete(c.entries, k)
				}
			}
			c.mu.Unlock()
		}
	}
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

// secretWire mirrors services.SecretResponse. It is a separate type on purpose:
// the SDK must be buildable by applications that do not import the server, and
// decoding into a narrow struct means an added server-side field cannot change
// client behaviour.
type secretWire struct {
	Path            string     `json:"path"`
	SecretValue     string     `json:"secret_value"`
	AccountName     string     `json:"account_name"`
	Type            string     `json:"credential_type"`
	Version         int        `json:"version"`
	CacheTTLSeconds int        `json:"cache_ttl_seconds"`
	RotatesAt       *time.Time `json:"rotates_at,omitempty"`
}

func (w secretWire) toSecret() Secret {
	return Secret{
		Path:        w.Path,
		Value:       w.SecretValue,
		AccountName: w.AccountName,
		Type:        w.Type,
		Version:     w.Version,
		RotatesAt:   w.RotatesAt,
	}
}

// do issues an authenticated GET and decodes the envelope into out, retrying
// only what is safe to retry.
func (c *Client) do(ctx context.Context, path string, out any) error {
	endpoint := c.baseURL + path + "?purpose=" + url.QueryEscape(c.purpose)

	var lastErr error
	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		if attempt > 0 {
			if err := c.sleep(ctx, c.backoff(attempt)); err != nil {
				return err
			}
		}

		body, retryable, err := c.attempt(ctx, endpoint)
		if err == nil {
			if derr := json.Unmarshal(body, out); derr != nil {
				return fmt.Errorf("vaultclient: decoding vault response: %w", derr)
			}
			return nil
		}
		lastErr = err
		if !retryable {
			return err
		}
		c.debugf("vault request failed (attempt %d/%d): %v", attempt+1, c.maxRetries+1, err)
	}
	return lastErr
}

// attempt performs one request. It reports whether the failure is worth
// retrying, so the caller does not have to re-derive that from the error.
func (c *Client) attempt(ctx context.Context, endpoint string) (body []byte, retryable bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("X-Service-Token", c.currentToken())
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		// A cancelled or timed-out caller context is the caller's decision,
		// not a vault fault, do not spend retries on it.
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		return nil, true, fmt.Errorf("vaultclient: vault request failed: %w", err)
	}
	defer func() {
		// Drain before close so the connection returns to the pool instead of
		// being torn down, otherwise every read pays a fresh TLS handshake.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
	}()

	switch {
	case resp.StatusCode == http.StatusOK:
		b, rerr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if rerr != nil {
			return nil, true, fmt.Errorf("vaultclient: reading vault response: %w", rerr)
		}
		return b, false, nil

	case resp.StatusCode == http.StatusUnauthorized:
		// The token died, expired, revoked, or rotated out from under us.
		// Re-read TokenFile: if the new token is already on disk, the very
		// next attempt succeeds and the rotation is invisible to the caller.
		if c.reloadToken() {
			return nil, true, ErrUnauthenticated
		}
		return nil, false, ErrUnauthenticated

	case resp.StatusCode == http.StatusForbidden:
		return nil, false, ErrForbidden
	case resp.StatusCode == http.StatusNotFound:
		return nil, false, ErrNotFound
	case resp.StatusCode == http.StatusConflict:
		return nil, false, ErrAmbiguous
	case resp.StatusCode == http.StatusTooManyRequests:
		return nil, true, ErrRateLimited
	case resp.StatusCode >= 500:
		return nil, true, fmt.Errorf("vaultclient: vault returned %d", resp.StatusCode)
	default:
		// The body is not echoed: on the read path it can carry the resolved
		// secret path and other detail that does not belong in a caller's
		// error string or, downstream, its logs.
		return nil, false, fmt.Errorf("vaultclient: unexpected vault status %d", resp.StatusCode)
	}
}

// backoff is exponential with full jitter, capped. Full jitter rather than a
// fixed multiplier because the whole fleet retries at once during an outage,
// and a deterministic backoff reconverges them into the same synchronised
// wave that caused the problem.
func (c *Client) backoff(attempt int) time.Duration {
	const base, ceiling = 100 * time.Millisecond, 3 * time.Second
	d := base << uint(attempt-1)
	if d > ceiling {
		d = ceiling
	}
	c.rngMu.Lock()
	defer c.rngMu.Unlock()
	return time.Duration(c.rng.Int63n(int64(d) + 1))
}

func (c *Client) sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.stop:
		return ErrClosed
	case <-t.C:
		return nil
	}
}

// ── Token handling ───────────────────────────────────────────────────────────

func (c *Client) currentToken() string {
	c.tokenMu.RLock()
	defer c.tokenMu.RUnlock()
	return c.token
}

// reloadToken re-reads TokenFile and reports whether it produced a token
// different from the one that was just rejected. Returning false tells the
// caller not to retry, which is what stops a permanently-dead token from
// burning the full retry budget on every single read.
func (c *Client) reloadToken() bool {
	if c.tokenFile == "" {
		return false
	}
	b, err := os.ReadFile(c.tokenFile)
	if err != nil {
		c.warnf("service token rejected and TokenFile unreadable: %v", err)
		return false
	}
	next, err := validateToken(strings.TrimSpace(string(b)))
	if err != nil {
		c.warnf("service token rejected and TokenFile contents are malformed")
		return false
	}

	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	if next == c.token {
		return false
	}
	c.token = next
	c.warnf("service token rejected; reloaded a new token from TokenFile")
	return true
}

// ── small helpers ────────────────────────────────────────────────────────────

func (c *Client) isClosed() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.closed
}

func (c *Client) debugf(format string, args ...any) {
	if c.log != nil {
		c.log.Debugf(format, args...)
	}
}

func (c *Client) warnf(format string, args ...any) {
	if c.log != nil {
		c.log.Warnf(format, args...)
	}
}

func orInt(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

// escapePath percent-encodes each segment while keeping the separators, so a
// multi-segment secret path survives the URL intact.
func escapePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}

// interface guard: keeps the redaction contract from being dropped silently.
var _ fmt.Stringer = Secret{}
