// pam/internal/webproxy/service.go
//
// Lifecycle for brokered web-application sessions: establish the upstream
// session server-side, mint the browser-facing handoff, resolve and
// authorize every proxied request, and tear down on expiry/revoke/kill.
//
// Everything here is deliberately built on the SAME session model every
// other connection method uses (ResourceService.StartTrackedSession /
// EndTrackedSession, pam_connection_sessions), rather than a parallel one:
// a brokered web session must show up in the org-wide session list, count
// toward active-session limits, be killable by the same admin action, and
// cascade-die when its JIT grant is revoked — all of which come for free by
// reusing that model instead of reinventing it.
package webproxy

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/yourorg/pam/internal/config"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/recorder"
	"github.com/yourorg/pam/internal/services"
	"github.com/yourorg/pam/pkg/crypto"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	ErrDisabled         = errors.New("web application proxy is not enabled on this server")
	ErrSessionNotFound  = errors.New("brokered web session not found")
	ErrSessionNotUsable = errors.New("brokered web session has expired, been revoked, or timed out")

	// ErrConnectMethodNotAllowed means the resource's policy closed this
	// connect path — see models.PAMResource.AllowedConnectMethods. Distinct
	// from an authorization failure: the operator may well be entitled to the
	// resource, just not by this route.
	ErrConnectMethodNotAllowed = errors.New("connect method not permitted for this resource")
	ErrHandoffInvalid          = errors.New("handoff token is invalid, expired, or already used")
	ErrResourceNotWebApp       = errors.New("this resource has no web console URL configured")
	ErrSessionNotOwned         = errors.New("brokered web session belongs to a different user")
)

// Service owns brokered web sessions.
type Service struct {
	db        *gorm.DB
	resources *services.ResourceService
	audit     *services.AuditService
	registry  *Registry
	cfg       config.WebProxyConfig
	cryptoKey string
	logger    *zap.Logger

	// client is the PAM→target HTTP client used for the login round trip.
	// Separate from the proxy's own transport (see proxy.go) because this
	// one deliberately does NOT follow redirects: a login endpoint that
	// answers 302 has already issued its Set-Cookie, and following the
	// redirect would just fetch a dashboard page we throw away.
	client *http.Client

	// recordingStorage is the SAME recorder.Storage the browser terminal
	// gateway and native agent write their casts to (MinIO/S3 or local
	// disk, per PAM_RECORDING_BACKEND) — a brokered web session's recording
	// is an asciicast in that same object store, under the same
	// recordings/YYYY/MM/DD/<recording-id>.cast.gz key layout, attached to
	// the same pam_session_recordings row. That is what makes it show up in
	// GET /admin/recordings and replay in the existing player with no
	// separate storage path, listing, or viewer.
	//
	// Nil when storage failed to initialize at startup: recording
	// obligations are still tracked and marked FAILED (a compliance gap to
	// surface), never a reason to refuse the operator access they are
	// otherwise entitled to — the same degradation gateway.go's Connect
	// already implements.
	recordingStorage recorder.Storage
	maxCastBytes     int64

	// activitySeq tracks the per-session request sequence number in memory.
	// The activity log's Sequence column exists to order rows that share a
	// millisecond timestamp; deriving it from a counter here avoids a
	// SELECT MAX(sequence) round trip on every single proxied request (a
	// modern SPA emits dozens per page load). A process restart resets these
	// — acceptable, since OccurredAt still orders across the restart
	// boundary and sequence only disambiguates within it.
	//
	// cmdSeq is the same pattern for the shared command log's Sequence
	// column, kept separate from activitySeq because the two count
	// deliberately different things: activitySeq counts EVERY proxied
	// request (the full forensic firehose), cmdSeq only the operator-
	// meaningful subset that reaches pam_session_recording_commands (see
	// isCommandWorthy).
	seqMu       sync.Mutex
	activitySeq map[string]int
	cmdSeq      map[string]int

	// casts holds the in-flight asciicast for each recorded session. Unlike
	// the browser terminal gateway — where the cast is a local variable in
	// the one goroutine that owns the WebSocket for the session's whole life
	// — a brokered web session is a series of independent, concurrent HTTP
	// requests with no owning goroutine, so the cast has to live here,
	// keyed by session, from StartSession until End finalizes it.
	//
	// recorder.Cast is itself mutex-guarded, so concurrent requests
	// appending frames for the same session is safe; castMu guards only
	// this map.
	castMu sync.Mutex
	casts  map[string]*recorder.Cast

	// replays holds the in-flight rrweb event stream per brokered session —
	// the visual counterpart to casts. See replay.go.
	replayMu       sync.Mutex
	replays        map[string]*replayBuffer
	maxReplayBytes int64

	// flushedSize records how many uncompressed bytes each session's artifact
	// held at its last successful flush, so a session that has produced
	// nothing new is skipped instead of re-gzipping and re-uploading identical
	// bytes on every sweeper tick. Guarded by castMu, which already serialises
	// the flush loop's view of the live set.
	flushedSize map[string]int64
}

func NewService(
	db *gorm.DB,
	resources *services.ResourceService,
	audit *services.AuditService,
	cfg config.WebProxyConfig,
	cryptoKey string,
	recordingStorage recorder.Storage,
	maxCastBytes int64,
	maxReplayBytes int64,
	logger *zap.Logger,
) *Service {
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
	}
	if cfg.InsecureSkipTargetTLSVerify {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
		logger.Warn("webproxy.insecure_tls_enabled",
			zap.String("impact", "PAM→target TLS certificates are NOT verified; brokered sessions are interceptable"))
	}

	return &Service{
		db:               db,
		resources:        resources,
		audit:            audit,
		registry:         NewRegistry(),
		cfg:              cfg,
		cryptoKey:        cryptoKey,
		recordingStorage: recordingStorage,
		maxCastBytes:     maxCastBytes,
		logger:           logger,
		client: &http.Client{
			Transport: transport,
			Timeout:   30 * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		activitySeq:    map[string]int{},
		cmdSeq:         map[string]int{},
		casts:          map[string]*recorder.Cast{},
		replays:        map[string]*replayBuffer{},
		maxReplayBytes: maxReplayBytes,
		flushedSize:    map[string]int64{},
	}
}

func (s *Service) Enabled() bool { return s.cfg.Enabled }

// Name identifies this service in sweeper logs, satisfying
// services.ExpiryReconciler alongside ReconcileExpired below.
func (s *Service) Name() string { return "webproxy" }

func (s *Service) Config() config.WebProxyConfig { return s.cfg }

// ──────────────────────────────────────────────────────────────────────────
// OPENING A SESSION
// ──────────────────────────────────────────────────────────────────────────

// StartSessionInput carries the authorization context the caller
// (handlers.WebProxyHandler.Open, running behind PAMAuth →
// RequirePermission → RequireActiveGrant) already resolved.
type StartSessionInput struct {
	UserID   string
	Username string

	ResourceID string
	SourceIP   string
	UserAgent  string

	AuthzDecisionID   string
	GrantID           string
	JITRequestID      string
	IsBreakglass      bool
	RecordingRequired bool

	// DataProtection is the effective egress policy for this session,
	// already composed from resource ∪ grant by the caller (see
	// middleware.GrantContext). Passed in rather than resolved here so the
	// grant half is not re-read, and snapshotted onto the session row so it
	// cannot drift for the session's lifetime.
	DataProtection models.DataProtection
}

// StartSessionResult is what the browser needs to enter the brokered
// session. LaunchURL is single-use: it carries the handoff token that
// converts this API call's authorization into a cookie on the app's own
// subdomain.
type StartSessionResult struct {
	WebProxySessionID string    `json:"web_proxy_session_id"`
	SessionID         string    `json:"session_id"`
	LaunchURL         string    `json:"launch_url"`
	AppURL            string    `json:"app_url"`
	AuthStrategy      string    `json:"auth_strategy"`
	ExpiresAt         time.Time `json:"expires_at"`
	HandoffExpiresAt  time.Time `json:"handoff_expires_at"`
}

// StartSession performs the target login server-side and opens a tracked,
// grant-bound, auditable brokered session.
//
// Ordering matters: the upstream login happens BEFORE any session row is
// created, so a bad stored credential surfaces as a clean 502 with nothing
// to clean up, rather than leaving an orphaned ACTIVE session behind (the
// same class of bug that left stuck sessions when a native-agent launch
// failed — see pam-agent's cmdLaunch).
func (s *Service) StartSession(ctx context.Context, in StartSessionInput) (*StartSessionResult, error) {
	if !s.cfg.Enabled {
		return nil, ErrDisabled
	}

	// A resource may restrict which connect methods it permits. Checked
	// first, deliberately ahead of ResolveConnection: that call decrypts the
	// vaulted credential, and a method the policy has closed must not cause a
	// secret to be unwrapped at all.
	resource, err := s.resources.GetResource(in.ResourceID)
	if err != nil {
		return nil, err
	}
	if !resource.AllowsConnectMethod(models.ConnectMethodWebProxy) {
		s.audit.Write(services.AuditEntry{
			ActorUserID:   in.UserID,
			ActorUsername: in.Username,
			Action:        models.AuditConnectMethodDenied,
			Category:      models.SessionLifecycle,
			Outcome:       models.AuditOutcomeDenied,
			Severity:      models.AuditSeverityWarn,
			ResourceID:    in.ResourceID,
			Details: map[string]interface{}{
				"connect_method":          models.ConnectMethodWebProxy,
				"allowed_connect_methods": resource.AllowedConnectMethods,
			},
		})
		return nil, fmt.Errorf("%w: this resource does not permit the brokered web connect method",
			ErrConnectMethodNotAllowed)
	}

	info, err := s.resources.ResolveConnection(in.ResourceID)
	if err != nil {
		return nil, err
	}

	baseURL, err := targetBaseURL(info.ConsoleURL)
	if err != nil {
		return nil, err
	}

	auth, err := s.registry.Get(info.ResourceType, info.ExtraConfig)
	if err != nil {
		return nil, err
	}

	loginCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	state, err := auth.Login(loginCtx, s.client, Target{
		BaseURL:     baseURL,
		Username:    info.AccountName,
		Password:    info.Password,
		ExtraConfig: info.ExtraConfig,
	})
	if err != nil {
		s.logger.Warn("webproxy.upstream_login.fail",
			zap.String("resource_id", in.ResourceID),
			zap.String("strategy", auth.Name()),
			zap.Error(err))
		// Deliberately wrapped, not returned raw: the underlying error can
		// carry the target URL, and callers render it to an operator.
		return nil, fmt.Errorf("could not establish a session with the target application: %w", err)
	}

	stateJSON, err := json.Marshal(state)
	if err != nil {
		return nil, fmt.Errorf("encode upstream state: %w", err)
	}
	stateEnc, err := crypto.Encrypt(string(stateJSON), s.cryptoKey)
	if err != nil {
		return nil, fmt.Errorf("encrypt upstream state: %w", err)
	}

	session, recording, err := s.resources.StartTrackedSession(services.StartSessionInput{
		UserID:            in.UserID,
		Username:          in.Username,
		ResourceID:        in.ResourceID,
		SourceIP:          in.SourceIP,
		Protocol:          info.ResourceType,
		AuthzDecisionID:   in.AuthzDecisionID,
		GrantID:           in.GrantID,
		JITRequestID:      in.JITRequestID,
		IsBreakglass:      in.IsBreakglass,
		RecordingRequired: in.RecordingRequired,
	})
	if err != nil {
		return nil, fmt.Errorf("start tracked session: %w", err)
	}

	rawToken, err := generateToken(32)
	if err != nil {
		return nil, err
	}
	rawHandoff, err := generateToken(32)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	row := &models.WebProxySession{
		ConnectionSessionID: session.ID,
		ResourceID:          in.ResourceID,
		UserID:              in.UserID,
		Username:            in.Username,
		Subdomain:           Subdomain(info.ResourceName, in.ResourceID),
		TokenHash:           hashToken(rawToken),
		HandoffHash:         hashToken(rawHandoff),
		HandoffExpires:      now.Add(time.Duration(s.cfg.HandoffTTLSec) * time.Second),
		UpstreamStateEnc:    stateEnc,
		AuthStrategy:        auth.Name(),
		Status:              models.WebProxySessionActive,
		IsBreakglass:        in.IsBreakglass,
		SourceIP:            in.SourceIP,
		UserAgent:           in.UserAgent,
		LastActivityAt:      now,
		ExpiresAt:           now.Add(time.Duration(s.cfg.SessionTTLMin) * time.Minute),

		BlockClipboard: in.DataProtection.BlockClipboard,
		BlockDevTools:  in.DataProtection.BlockDevTools,
		BlockDownload:  in.DataProtection.BlockDownload,
		Watermark:      in.DataProtection.Watermark,
		MaxEgressBytes: in.DataProtection.MaxEgressBytes,
	}
	if recording != nil {
		row.RecordingID = &recording.ID
	}
	if in.GrantID != "" {
		row.GrantID = &in.GrantID
	}
	if in.JITRequestID != "" {
		row.JITRequestID = &in.JITRequestID
	}

	if err := s.db.Create(row).Error; err != nil {
		// The tracked session is already open at this point — close it so a
		// storage failure here doesn't strand an ACTIVE row nothing will
		// ever end.
		if _, endErr := s.resources.EndTrackedSession(session.ID, in.UserID, true); endErr != nil {
			s.logger.Error("webproxy.orphan_session_cleanup.fail",
				zap.String("session_id", session.ID), zap.Error(endErr))
		}
		return nil, fmt.Errorf("persist brokered session: %w", err)
	}

	appURL := s.appURL(row.Subdomain)

	// Open the recording, if this session carries an obligation. Same
	// degradation as gateway.go's Connect: storage being unavailable marks
	// the obligation FAILED (a compliance gap for an admin to see) rather
	// than denying access the operator is otherwise entitled to.
	if recording != nil {
		if s.recordingStorage == nil {
			s.logger.Warn("webproxy.recording.storage_unavailable",
				zap.String("recording_id", recording.ID), zap.String("session_id", session.ID))
			_ = s.resources.MarkRecordingFailed(recording.ID,
				"recording storage was not configured/available when this brokered web session opened")
		} else {
			cast := recorder.NewCast(120, 40,
				fmt.Sprintf("PAM %s web session — %s", info.ResourceType, info.ResourceName), s.maxCastBytes)
			cast.Output([]byte(sessionBanner(in.Username, info.ResourceName, info.ResourceType, appURL, baseURL, auth.Name(), now)))

			s.castMu.Lock()
			s.casts[row.ID] = cast
			s.castMu.Unlock()

			if err := s.resources.MarkRecordingActive(recording.ID); err != nil {
				s.logger.Warn("webproxy.recording.mark_active.fail",
					zap.String("recording_id", recording.ID), zap.Error(err))
			}
			// The positive confirmation that a cast is in flight for this
			// session. Paired with webproxy.recording.saved at the other end,
			// these two lines bracket every recording: a start with no
			// matching save is the signal that something ate the cast.
			s.logger.Info("webproxy.recording.started",
				zap.String("web_proxy_session_id", row.ID),
				zap.String("recording_id", recording.ID),
				zap.String("storage", s.recordingStorage.Label()))
		}
	}
	s.audit.Write(services.AuditEntry{
		ActorUserID:     in.UserID,
		ActorUsername:   in.Username,
		Action:          models.AuditSessionStarted,
		Category:        models.SessionLifecycle,
		Outcome:         models.AuditOutcomeSuccess,
		ResourceType:    info.ResourceType,
		ResourceID:      in.ResourceID,
		ResourceName:    info.ResourceName,
		SessionID:       session.ID,
		GrantID:         in.GrantID,
		RequestID:       in.JITRequestID,
		SourceIP:        in.SourceIP,
		UserAgent:       in.UserAgent,
		AuthzDecisionID: in.AuthzDecisionID,
		Details: map[string]interface{}{
			"transport":          "web_proxy",
			"auth_strategy":      auth.Name(),
			"app_url":            appURL,
			"is_breakglass":      in.IsBreakglass,
			"recording_required": in.RecordingRequired,
		},
	})

	s.logger.Info("webproxy.session.started",
		zap.String("web_proxy_session_id", row.ID),
		zap.String("session_id", session.ID),
		zap.String("user_id", in.UserID),
		zap.String("resource_id", in.ResourceID),
		zap.String("strategy", auth.Name()),
		zap.String("subdomain", row.Subdomain))

	return &StartSessionResult{
		WebProxySessionID: row.ID,
		SessionID:         session.ID,
		LaunchURL:         fmt.Sprintf("%s%s?%s=%s", appURL, handoffPath, handoffQueryParam, url.QueryEscape(rawHandoff)),
		AppURL:            appURL,
		AuthStrategy:      auth.Name(),
		ExpiresAt:         row.ExpiresAt,
		HandoffExpiresAt:  row.HandoffExpires,
	}, nil
}

// ──────────────────────────────────────────────────────────────────────────
// HANDOFF + PER-REQUEST RESOLUTION
// ──────────────────────────────────────────────────────────────────────────

// ConsumeHandoff exchanges the single-use handoff token (carried in the
// launch URL the browser navigated to) for the long-lived proxy session
// token that becomes an HttpOnly cookie on the app's subdomain.
//
// Consumption is an atomic conditional UPDATE, so two near-simultaneous
// navigations to the same launch URL can't both succeed — the same
// single-use enforcement AgentService.ResolveLaunchToken uses.
func (s *Service) ConsumeHandoff(rawHandoff, subdomain string) (sessionToken string, session *models.WebProxySession, err error) {
	if !s.cfg.Enabled {
		return "", nil, ErrDisabled
	}

	var row models.WebProxySession
	q := s.db.Where("handoff_hash = ? AND subdomain = ?", hashToken(rawHandoff), subdomain)
	if err := q.First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", nil, ErrHandoffInvalid
		}
		return "", nil, err
	}

	now := time.Now().UTC()
	if row.Status != models.WebProxySessionActive || row.HandoffUsedAt != nil || now.After(row.HandoffExpires) {
		return "", nil, ErrHandoffInvalid
	}

	newToken, err := generateToken(32)
	if err != nil {
		return "", nil, err
	}

	res := s.db.Model(&models.WebProxySession{}).
		Where("id = ? AND handoff_used_at IS NULL AND status = ?", row.ID, models.WebProxySessionActive).
		Updates(map[string]interface{}{
			"handoff_used_at":  now,
			"handoff_hash":     "",
			"token_hash":       hashToken(newToken),
			"last_activity_at": now,
		})
	if res.Error != nil {
		return "", nil, res.Error
	}
	if res.RowsAffected == 0 {
		return "", nil, ErrHandoffInvalid
	}

	s.logger.Info("webproxy.handoff.consumed",
		zap.String("web_proxy_session_id", row.ID),
		zap.String("user_id", row.UserID),
		zap.String("subdomain", subdomain))

	return newToken, &row, nil
}

// ResolvedSession is a usable brokered session plus its decrypted upstream
// authentication state, resolved fresh on every proxied request.
type ResolvedSession struct {
	Session  *models.WebProxySession
	Upstream *UpstreamState
	Target   *url.URL

	// RecordingRequired mirrors the underlying ConnectionSession's own flag
	// (the same one a CLI session's cast capture is gated on) — copied here
	// so proxy.go's ModifyResponse hook can decide whether to persist a page
	// capture without a second database round trip per request.
	RecordingRequired bool
}

// Resolve authorizes one proxied request. Reads state from the database
// every time — never cached — so an admin kill, a JIT grant revoke, an
// expiry, or an idle timeout takes effect on the very next request rather
// than whenever some cache happens to lapse.
func (s *Service) Resolve(rawToken, subdomain string) (*ResolvedSession, error) {
	if !s.cfg.Enabled {
		return nil, ErrDisabled
	}

	var row models.WebProxySession
	err := s.db.Where("token_hash = ? AND subdomain = ?", hashToken(rawToken), subdomain).First(&row).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrSessionNotFound
		}
		return nil, err
	}

	if !row.IsUsable(time.Now().UTC(), time.Duration(s.cfg.IdleTimeoutMin)*time.Minute) {
		return nil, ErrSessionNotUsable
	}

	// The underlying tracked session is authoritative for "is this still a
	// live session" — an admin killing it from the sessions screen, or a
	// grant revoke cascading through KillSessionsByGrantTx, both flip that
	// row without knowing this table exists. Checking it here is what makes
	// those existing controls reach brokered web sessions too.
	connSession, err := s.resources.GetSession(row.ConnectionSessionID)
	if err != nil || connSession.Status != "ACTIVE" {
		return nil, ErrSessionNotUsable
	}

	info, err := s.resources.GetResource(row.ResourceID)
	if err != nil {
		return nil, err
	}
	if !info.IsActive {
		return nil, ErrSessionNotUsable
	}

	stateJSON, err := crypto.Decrypt(row.UpstreamStateEnc, s.cryptoKey)
	if err != nil {
		return nil, fmt.Errorf("decrypt upstream state: %w", err)
	}
	var state UpstreamState
	if err := json.Unmarshal([]byte(stateJSON), &state); err != nil {
		return nil, fmt.Errorf("decode upstream state: %w", err)
	}

	// Re-derives the target from the SAME targetBaseURL StartSession used —
	// not a second copy of the fallback logic. That used to diverge (this
	// function had its own inline http://host:port fallback that survived an
	// earlier fix to StartSession's copy), which meant a resource that
	// legitimately failed StartSession's console_url check could still have
	// live requests silently proxied at a raw database port on every
	// subsequent call. One function, one behavior, checked in both places.
	rawBase, err := targetBaseURL(info.ConsoleURL)
	if err != nil {
		return nil, fmt.Errorf("resource %q is no longer a valid web-proxy target: %w", info.Name, err)
	}
	targetURL, err := url.Parse(rawBase)
	if err != nil {
		return nil, fmt.Errorf("resource %q has an unparseable console_url: %w", info.Name, err)
	}

	return &ResolvedSession{
		Session:           &row,
		Upstream:          &state,
		Target:            targetURL,
		RecordingRequired: connSession.RecordingRequired,
	}, nil
}

// PersistUpstreamState re-encrypts and stores the upstream jar after the
// target rotated its own session cookie mid-session (common: many apps
// refresh a session token periodically). Without this, a long-lived brokered
// session would keep replaying a cookie the target has already retired.
func (s *Service) PersistUpstreamState(sessionID string, state *UpstreamState) error {
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return err
	}
	enc, err := crypto.Encrypt(string(stateJSON), s.cryptoKey)
	if err != nil {
		return err
	}
	return s.db.Model(&models.WebProxySession{}).
		Where("id = ?", sessionID).
		Update("upstream_state_enc", enc).Error
}

// ──────────────────────────────────────────────────────────────────────────
// ACTIVITY + TEARDOWN
// ──────────────────────────────────────────────────────────────────────────

// ActivityRecord is one proxied request's audit row.
type ActivityRecord struct {
	Method            string
	Path              string
	StatusCode        int
	RequestBodyBytes  int64
	ResponseBodyBytes int64
	DurationMs        int64
	SourceIP          string
	OccurredAt        time.Time

	// IsDocument marks a request whose RESPONSE was an HTML document — i.e.
	// the operator navigated to a page, as opposed to the browser fetching
	// an asset or the app polling an API. Used (with mutations) to decide
	// what reaches the shared command log; see isCommandWorthy.
	IsDocument bool
}

// isCommandWorthy decides whether a proxied request belongs in the SHARED
// pam_session_recording_commands log — the same table a CLI session's typed
// commands land in, and what an admin reads as "what did this person
// actually do."
//
// A modern SPA emits dozens-to-hundreds of requests per page (JS chunks,
// fonts, icons, telemetry pings, poll loops). Writing all of them there
// would bury the handful of meaningful actions in noise and make the
// web-session command log useless next to a CLI one, which contains only
// things a human deliberately typed. So only two categories qualify:
//
//   - Any mutation (POST/PUT/PATCH/DELETE/...): the operator changed
//     something on the target. Always significant.
//   - A navigation to an HTML document: the operator moved to a new screen.
//
// Everything else still lands, in full, in pam_web_proxy_activity — nothing
// is lost, it is only kept out of the human-readable summary. The cast
// recording likewise shows every request, so replay stays complete.
func isCommandWorthy(rec ActivityRecord) bool {
	return isMutatingMethod(rec.Method) || rec.IsDocument
}

// RecordActivity persists one proxied request and advances the session's
// activity clock. Best-effort by design: a failure to write the audit row
// must not break the operator's in-flight request (they'd see a broken app
// for an audit-storage problem), so it is logged rather than surfaced.
//
// Mutations additionally go to the main hash-chained audit trail — a modern
// SPA emits far too many asset/polling GETs for every one of them to belong
// in the tamper-evident org-wide log, but every state-changing call does.
func (s *Service) RecordActivity(rs *ResolvedSession, rec ActivityRecord) {
	now := rec.OccurredAt
	if now.IsZero() {
		now = time.Now().UTC()
	}

	s.seqMu.Lock()
	s.activitySeq[rs.Session.ID]++
	seq := s.activitySeq[rs.Session.ID]
	s.seqMu.Unlock()

	isMutation := isMutatingMethod(rec.Method)

	row := &models.WebProxyActivity{
		WebProxySessionID:   rs.Session.ID,
		ConnectionSessionID: rs.Session.ConnectionSessionID,
		ResourceID:          rs.Session.ResourceID,
		UserID:              rs.Session.UserID,
		Sequence:            seq,
		Method:              rec.Method,
		Path:                truncate(rec.Path, 2048),
		StatusCode:          rec.StatusCode,
		RequestBodyBytes:    rec.RequestBodyBytes,
		ResponseBodyBytes:   rec.ResponseBodyBytes,
		DurationMs:          rec.DurationMs,
		IsMutation:          isMutation,
		SourceIP:            rec.SourceIP,
		OccurredAt:          now,
	}
	if err := s.db.Create(row).Error; err != nil {
		s.logger.Warn("webproxy.activity.persist.fail",
			zap.String("web_proxy_session_id", rs.Session.ID), zap.Error(err))
	}

	if err := s.db.Model(&models.WebProxySession{}).
		Where("id = ?", rs.Session.ID).
		Updates(map[string]interface{}{
			"last_activity_at": now,
			"request_count":    gorm.Expr("request_count + 1"),
			// Accumulated in SQL rather than from the in-memory value so
			// concurrent requests on the same session cannot lose counts to a
			// read-modify-write race — the egress budget is a security control
			// and undercounting it silently raises the cap.
			"egress_bytes": gorm.Expr("egress_bytes + ?", rec.ResponseBodyBytes),
		}).Error; err != nil {
		s.logger.Warn("webproxy.activity.touch.fail",
			zap.String("web_proxy_session_id", rs.Session.ID), zap.Error(err))
	}

	if isMutation {
		outcome := models.AuditOutcomeSuccess
		if rec.StatusCode >= 400 {
			outcome = models.AuditOutcomeFailure
		}
		s.audit.Write(services.AuditEntry{
			ActorUserID:   rs.Session.UserID,
			ActorUsername: rs.Session.Username,
			Action:        "WEB_PROXY_REQUEST",
			Category:      models.ResourceLifecycle,
			Outcome:       outcome,
			ResourceID:    rs.Session.ResourceID,
			SessionID:     rs.Session.ConnectionSessionID,
			SourceIP:      rec.SourceIP,
			Details: map[string]interface{}{
				"method":      rec.Method,
				"path":        truncate(rec.Path, 2048),
				"status":      rec.StatusCode,
				"duration_ms": rec.DurationMs,
			},
		})
	}

	s.recordToCast(rs, rec, now)
}

// recordToCast appends one request to this session's asciicast (every
// request — replay must be complete) and, for the operator-meaningful
// subset, to the SHARED command log the CLI player's command pane already
// reads. Both are no-ops when the session isn't being recorded.
func (s *Service) recordToCast(rs *ResolvedSession, rec ActivityRecord, now time.Time) {
	s.castMu.Lock()
	cast := s.casts[rs.Session.ID]
	s.castMu.Unlock()
	if cast == nil {
		return
	}

	cast.Output([]byte(requestFrame(rec, now)))

	if !isCommandWorthy(rec) {
		return
	}
	if rs.Session.RecordingID == nil || *rs.Session.RecordingID == "" {
		return
	}

	s.seqMu.Lock()
	s.cmdSeq[rs.Session.ID]++
	seq := s.cmdSeq[rs.Session.ID]
	s.seqMu.Unlock()

	outcome := models.AuditOutcomeSuccess
	if rec.StatusCode >= 400 {
		outcome = models.AuditOutcomeFailure
	}
	// Same masking the cast itself applies (recorder.Cast.record calls
	// MaskSecrets) — a path or query fragment can carry a token, and the
	// command log is exactly as readable as the replay is.
	input := recorder.MaskSecrets(fmt.Sprintf("%s %s", rec.Method, rec.Path))

	if err := s.resources.AppendRecordingCommand(&models.SessionRecordingCommand{
		RecordingID:   *rs.Session.RecordingID,
		SessionID:     rs.Session.ConnectionSessionID,
		Sequence:      seq,
		Input:         input,
		InputMasked:   input != fmt.Sprintf("%s %s", rec.Method, rec.Path),
		Outcome:       string(outcome),
		OutputSummary: fmt.Sprintf("%d · %s · %dms", rec.StatusCode, humanBytes(rec.ResponseBodyBytes), rec.DurationMs),
		DurationMs:    rec.DurationMs,
		OccurredAt:    now,
	}); err != nil {
		s.logger.Warn("webproxy.recording.command.append.fail",
			zap.String("web_proxy_session_id", rs.Session.ID), zap.Error(err))
	}
}

// sessionArtifact is one snapshot of a session's recording: the bytes to
// store, what they are, and where they go.
type sessionArtifact struct {
	gz           []byte
	sha256Hex    string
	size         int64
	format       string
	extension    string
	transcriptGz []byte // set only when a visual replay demoted it to secondary
	truncated    bool
}

// buildArtifact renders the current state of a session's recording.
//
// Shared deliberately by flushRecording and finalizeRecording: they used to be
// one code path only because finalize was the only writer, and letting them
// drift would mean a mid-session flush storing a different format — or a
// different key — from the final write, which is how you end up with two
// half-artifacts and no complete one.
//
// Safe to call repeatedly: recorder.Cast.Finalize copies the buffer and never
// resets it, so each call is an independent snapshot of everything so far.
func (s *Service) buildArtifact(cast *recorder.Cast, replay *replayBuffer) (sessionArtifact, error) {
	gz, sha, size, err := cast.Finalize()
	if err != nil {
		return sessionArtifact{}, fmt.Errorf("encode transcript: %w", err)
	}

	out := sessionArtifact{
		gz: gz, sha256Hex: sha, size: size,
		format: "asciicast", extension: "cast.gz", truncated: cast.Truncated(),
	}

	// Prefer the visual replay when the browser has delivered frames — it
	// answers "what did the operator see", which the request transcript
	// cannot. The transcript is kept as the secondary artifact rather than
	// discarded, because the two are different evidence about one session.
	if replay != nil && replay.events > 0 {
		replayGz, replaySHA, replaySize, replayErr := gzipReplay(replay)
		if replayErr != nil {
			return out, nil // keep the transcript; the caller logs the encode failure
		}
		out.transcriptGz = gz
		out.gz, out.sha256Hex, out.size = replayGz, replaySHA, replaySize
		out.format, out.extension, out.truncated = replayFormat, "rrweb.gz", replay.truncated
	}
	return out, nil
}

// artifactKey is the storage key for a recording's artifact.
//
// Reuses the key already on the row so repeated flushes overwrite one object
// rather than scattering a session across many — and so a session running past
// midnight does not jump date prefixes mid-flight.
//
// The reuse is conditional on the EXTENSION still matching, which matters more
// than it looks. A session's format can change mid-flight: early flushes write
// a request transcript (.cast.gz), and the moment the browser delivers rrweb
// frames the visual replay takes over as the primary (.rrweb.gz). Reusing the
// key unconditionally would leave the replay stored under a .cast.gz name —
// and since finalize writes the demoted transcript to exactly that name as the
// secondary artifact, the transcript would overwrite the replay and the
// session's visual evidence would be silently replaced by its request log.
func artifactKey(existing, recordingID, extension string) string {
	suffix := "." + extension
	if existing != "" && strings.HasSuffix(existing, suffix) {
		return existing
	}
	return fmt.Sprintf("recordings/%s/%s%s", time.Now().UTC().Format("2006/01/02"), recordingID, suffix)
}

// flushOpenRecordings writes every in-flight recording to storage.
//
// This is what makes the feature durable, and it is the difference between
// losing a session and losing its last few seconds. Before this existed the
// entire stream lived in process memory until End, so a restart, a crash, a
// deploy — or any fault at all in the end-of-session path — destroyed the
// whole recording and left the row to be orphaned to FAILED with nothing
// behind it.
//
// Driven from ReconcileExpired rather than its own goroutine: that already
// runs on the sweeper's cadence and at startup, so the flush inherits a
// lifecycle that is started, stopped and recovered correctly, with no second
// timer to leak. It runs BEFORE the expiry pass so a session about to be
// closed is snapshotted first.
//
// Every failure here is logged and skipped, never fatal: a flush that cannot
// write must not interrupt a live privileged session, and the next tick will
// try again.
func (s *Service) flushOpenRecordings(ctx context.Context) {
	if s.recordingStorage == nil {
		return
	}

	// Snapshot the live set under the lock, then do the I/O outside it — a
	// slow object store must not block RecordActivity on every request.
	s.castMu.Lock()
	ids := make([]string, 0, len(s.casts))
	for id := range s.casts {
		ids = append(ids, id)
	}
	s.castMu.Unlock()
	if len(ids) == 0 {
		return
	}

	for _, id := range ids {
		s.castMu.Lock()
		cast := s.casts[id]
		s.castMu.Unlock()
		if cast == nil {
			continue // ended between the snapshot and now; End owns it
		}

		var row models.WebProxySession
		if err := s.db.Where("id = ?", id).First(&row).Error; err != nil {
			continue
		}
		if row.RecordingID == nil || *row.RecordingID == "" {
			continue
		}

		s.replayMu.Lock()
		replay := s.replays[id]
		s.replayMu.Unlock()

		art, err := s.buildArtifact(cast, replay)
		if err != nil {
			s.logger.Warn("webproxy.recording.flush.encode_fail",
				zap.String("web_proxy_session_id", id), zap.Error(err))
			continue
		}

		var rec models.SessionRecording
		if err := s.db.Where("id = ?", *row.RecordingID).First(&rec).Error; err != nil {
			continue
		}
		// A resolved recording is finished business — never rewrite it.
		if rec.Status != models.RecordingStatusRecording && rec.Status != models.RecordingStatusPending {
			continue
		}

		// Nothing new since the last flush: re-uploading the same bytes every
		// 30s for the life of an idle session is pure cost. A format change
		// still forces a write, because that lands on a different key.
		s.castMu.Lock()
		lastSize, seen := s.flushedSize[id]
		s.castMu.Unlock()
		key := artifactKey(rec.StorageKey, rec.ID, art.extension)
		if seen && lastSize == art.size && key == rec.StorageKey {
			continue
		}

		if err := s.recordingStorage.Save(ctx, key, art.gz); err != nil {
			s.logger.Warn("webproxy.recording.flush.save_fail",
				zap.String("recording_id", rec.ID), zap.String("key", key), zap.Error(err))
			continue
		}
		if err := s.resources.AttachRecordingProgress(
			rec.ID, s.recordingStorage.Label(), key, art.size, art.sha256Hex); err != nil {
			s.logger.Warn("webproxy.recording.flush.attach_fail",
				zap.String("recording_id", rec.ID), zap.Error(err))
			continue
		}
		if art.format != rec.Format {
			if err := s.resources.SetRecordingFormat(rec.ID, art.format); err != nil {
				s.logger.Warn("webproxy.recording.flush.format_fail",
					zap.String("recording_id", rec.ID), zap.Error(err))
			}
		}
		s.castMu.Lock()
		if s.flushedSize == nil {
			// Defensive: a writer to a nil map panics, and this runs on the
			// sweeper goroutine, whose panic recovery would turn that into
			// "the flush silently never runs again" — the failure mode this
			// whole change exists to eliminate.
			s.flushedSize = map[string]int64{}
		}
		s.flushedSize[id] = art.size
		s.castMu.Unlock()

		s.logger.Debug("webproxy.recording.flushed",
			zap.String("recording_id", rec.ID),
			zap.String("format", art.format),
			zap.Int64("bytes", art.size))
	}
}

// finalizeRecording encodes the session's cast, persists it to the SAME
// object store the browser terminal and native agent use, and attaches it to
// the SAME pam_session_recordings row — which is the entire reason a
// brokered web recording appears in GET /admin/recordings and replays in the
// existing player with no separate plumbing.
//
// Mirrors gateway.go's finalizeRecording deliberately, including its
// posture: this runs after the session is already closed, so nothing here
// can affect the operator's access anymore — a storage failure is a
// compliance-visibility problem for an admin, never a reason the work should
// have been blocked.
func (s *Service) finalizeRecording(row *models.WebProxySession, cast *recorder.Cast, replay *replayBuffer, status, reason string) {
	if row.RecordingID == nil || *row.RecordingID == "" {
		// Unreachable via End (which only calls this when a cast exists, and a
		// cast only exists when a recording was opened), so reaching it means
		// the session row lost its recording link. Logged rather than returned
		// silently: this was one of two paths that produced a FAILED recording
		// with no artifact and no explanation anywhere in the logs.
		s.logger.Error("webproxy.recording.finalize.no_recording_id",
			zap.String("web_proxy_session_id", row.ID),
			zap.String("impact", "a cast was open for a session with no recording id; the artifact "+
				"cannot be attached to anything and is discarded"))
		return
	}
	recordingID := *row.RecordingID

	cast.Output([]byte(sessionFooter(status, reason, row.RequestCount)))

	art, err := s.buildArtifact(cast, replay)
	if err != nil {
		s.logger.Error("webproxy.recording.finalize.encode_fail",
			zap.String("recording_id", recordingID), zap.Error(err))
		_ = s.resources.MarkRecordingFailed(recordingID, "failed to encode brokered web session recording: "+err.Error())
		return
	}
	if art.transcriptGz != nil {
		s.logger.Info("webproxy.replay.captured",
			zap.String("recording_id", recordingID),
			zap.Int("events", replay.events),
			zap.Bool("truncated", replay.truncated))
	}

	if s.recordingStorage == nil {
		_ = s.resources.MarkRecordingFailed(recordingID, "recording storage was not configured/available")
		return
	}

	// Reuse the key any earlier flush already established, so the final write
	// overwrites the partial artifact instead of leaving an orphan beside it.
	var existing models.SessionRecording
	existingKey := ""
	if err := s.db.Where("id = ?", recordingID).First(&existing).Error; err == nil {
		existingKey = existing.StorageKey
	}
	key := artifactKey(existingKey, recordingID, art.extension)

	if err := s.recordingStorage.Save(context.Background(), key, art.gz); err != nil {
		s.logger.Error("webproxy.recording.finalize.save_fail",
			zap.String("recording_id", recordingID), zap.String("key", key), zap.Error(err))
		_ = s.resources.MarkRecordingFailed(recordingID, "failed to persist brokered web session recording: "+err.Error())
		return
	}

	// Format first: a player picks its renderer off this field, so a row that
	// briefly reads COMPLETED with the wrong format would replay as garbage.
	if err := s.resources.SetRecordingFormat(recordingID, art.format); err != nil {
		s.logger.Error("webproxy.recording.finalize.format_fail",
			zap.String("recording_id", recordingID), zap.String("format", art.format), zap.Error(err))
	}
	if err := s.resources.AttachRecordingArtifact(
		recordingID, s.recordingStorage.Label(), key, art.size, art.sha256Hex, art.truncated); err != nil {
		s.logger.Error("webproxy.recording.finalize.attach_fail",
			zap.String("recording_id", recordingID), zap.Error(err))
		return
	}

	// The transcript rides along as supplementary evidence: a visual replay
	// shows what the operator saw, the transcript shows every request they
	// caused. Best-effort — losing it must never cost the primary artifact
	// that has already been stored and attached.
	if art.transcriptGz != nil {
		transcriptKey := fmt.Sprintf("recordings/%s/%s.cast.gz",
			time.Now().UTC().Format("2006/01/02"), recordingID)
		if err := s.recordingStorage.Save(context.Background(), transcriptKey, art.transcriptGz); err != nil {
			s.logger.Warn("webproxy.transcript.save_fail",
				zap.String("recording_id", recordingID), zap.String("key", transcriptKey), zap.Error(err))
		} else if err := s.resources.AttachRecordingTranscript(recordingID, transcriptKey); err != nil {
			s.logger.Warn("webproxy.transcript.attach_fail",
				zap.String("recording_id", recordingID), zap.Error(err))
		}
	}

	s.audit.Write(services.AuditEntry{
		ActorUserID:   row.UserID,
		ActorUsername: row.Username,
		Action:        models.AuditRecordingSaved,
		Category:      models.SessionLifecycle,
		Outcome:       models.AuditOutcomeSuccess,
		ResourceID:    row.ResourceID,
		SessionID:     row.ConnectionSessionID,
		Details: map[string]interface{}{
			"transport":   "web_proxy",
			"format":      art.format,
			"storage_key": key,
			"size_bytes":  art.size,
			"truncated":   art.truncated,
		},
	})
	s.logger.Info("webproxy.recording.saved",
		zap.String("recording_id", recordingID),
		zap.String("format", art.format),
		zap.String("storage_key", key),
		zap.Int64("size_bytes", art.size))
}

// End closes a brokered session and its underlying tracked session.
// Idempotent — ending an already-ended session is not an error, matching
// EndTrackedSession's own contract. allowAnyOwner mirrors
// ResourceService.EndTrackedSession's own parameter exactly: false for the
// operator's self-service "end my own session" call (any other user's
// session must come back ErrSessionNotOwned), true for the admin force-end
// path, where ending someone else's session is the entire point.
func (s *Service) End(webProxySessionID, actorUserID string, allowAnyOwner bool, status, reason string) error {
	var row models.WebProxySession
	if err := s.db.Where("id = ?", webProxySessionID).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrSessionNotFound
		}
		return err
	}
	if !allowAnyOwner && row.UserID != actorUserID {
		return ErrSessionNotOwned
	}
	if row.Status != models.WebProxySessionActive {
		return nil
	}

	now := time.Now().UTC()
	if err := s.db.Model(&models.WebProxySession{}).
		Where("id = ? AND status = ?", row.ID, models.WebProxySessionActive).
		Updates(map[string]interface{}{
			"status":        status,
			"revoke_reason": reason,
			"ended_at":      now,
		}).Error; err != nil {
		return err
	}

	// Ordering mirrors gateway.go's Connect teardown for the same reason
	// documented on closeRecordingTx: EndTrackedSession stamps the
	// recording's ended_at while it is still PENDING/RECORDING, and
	// finalizeRecording below is the only thing that may then mark it
	// COMPLETED — so the session must be closed out BEFORE the artifact is
	// attached, never after.
	if _, err := s.resources.EndTrackedSession(row.ConnectionSessionID, actorUserID, true); err != nil {
		s.logger.Warn("webproxy.session.end_tracked.fail",
			zap.String("session_id", row.ConnectionSessionID), zap.Error(err))
	}

	// Re-read RequestCount so the recording's footer reports the real total
	// rather than the value from before this session's last few requests.
	var finalRow models.WebProxySession
	if err := s.db.Where("id = ?", row.ID).First(&finalRow).Error; err == nil {
		row.RequestCount = finalRow.RequestCount
	}

	s.castMu.Lock()
	cast := s.casts[row.ID]
	delete(s.casts, row.ID)
	delete(s.flushedSize, row.ID)
	s.castMu.Unlock()
	replay := s.takeReplay(row.ID)
	if cast != nil {
		s.finalizeRecording(&row, cast, replay, status, reason)
	} else {
		// No cast. Either the session genuinely carries no recording
		// obligation, or one was opened and its cast has been lost — most
		// plausibly because this process did not serve StartSession (a
		// restart mid-session). Those two cases have very different
		// consequences and used to be indistinguishable in the logs: the
		// second leaves the recording to be orphaned to FAILED by the sweep
		// two minutes later, whose message can only guess at the cause.
		if row.RecordingID != nil && *row.RecordingID != "" {
			s.logger.Error("webproxy.recording.cast_missing",
				zap.String("web_proxy_session_id", row.ID),
				zap.String("recording_id", *row.RecordingID),
				zap.String("impact", "this session had a recording obligation but no in-flight cast, "+
					"so no artifact can be produced; the recording will be marked FAILED by orphan "+
					"reconciliation. Expected only if the process that started the session has since restarted."))
		}
		s.discardReplay(row.ID)
	}

	s.seqMu.Lock()
	delete(s.activitySeq, row.ID)
	delete(s.cmdSeq, row.ID)
	s.seqMu.Unlock()

	s.audit.Write(services.AuditEntry{
		ActorUserID:   actorUserID,
		ActorUsername: row.Username,
		Action:        models.AuditSessionEnded,
		Category:      models.SessionLifecycle,
		Outcome:       models.AuditOutcomeSuccess,
		ResourceID:    row.ResourceID,
		SessionID:     row.ConnectionSessionID,
		Details: map[string]interface{}{
			"transport":     "web_proxy",
			"status":        status,
			"reason":        reason,
			"request_count": row.RequestCount,
		},
	})

	s.logger.Info("webproxy.session.ended",
		zap.String("web_proxy_session_id", row.ID),
		zap.String("status", status),
		zap.String("reason", reason))
	return nil
}

// ReconcileExpired closes out brokered sessions whose deadline passed, that
// went idle, or whose browser tab has gone quiet past the heartbeat grace
// period (see heartbeatGraceSeconds — the "operator closed the tab"
// detection HTTP's statelessness otherwise makes impossible). Called on the
// same sweeper tick as the JIT auto-revoke worker, so an abandoned browser
// tab stops holding privileged access open without anyone having to notice.
//
// Also runs at startup, for the same reason
// ResourceService.ReconcileStaleSessionsOnStartup does: a session left
// ACTIVE by a crashed process has no owner to close it.
func (s *Service) ReconcileExpired(ctx context.Context) (int, error) {
	if !s.cfg.Enabled {
		return 0, nil
	}
	// Snapshot every in-flight recording to storage BEFORE closing anything,
	// so a session ended by this very pass is persisted first and a crash
	// between passes costs one interval of frames rather than the session.
	s.flushOpenRecordings(ctx)

	now := time.Now().UTC()
	idleCutoff := now.Add(-time.Duration(s.cfg.IdleTimeoutMin) * time.Minute)
	heartbeatCutoff := now.Add(-heartbeatGraceSeconds * time.Second)
	unenteredCutoff := now.Add(-unenteredGraceSeconds * time.Second)

	var rows []models.WebProxySession
	if err := s.db.WithContext(ctx).
		Where(`status = ? AND (
			expires_at <= ? OR
			last_activity_at <= ? OR
			(last_heartbeat_at IS NOT NULL AND last_heartbeat_at <= ?) OR
			(last_heartbeat_at IS NULL AND request_count = 0 AND created_at <= ?)
		)`, models.WebProxySessionActive, now, idleCutoff, heartbeatCutoff, unenteredCutoff).
		Find(&rows).Error; err != nil {
		return 0, err
	}

	closed := 0
	for i := range rows {
		row := &rows[i]
		// Priority order matters for the message an admin sees: an
		// abandoned tab typically hits the heartbeat cutoff first (45s) long
		// before idle timeout (minutes) or absolute expiry (hours), so
		// checking heartbeat staleness before idle gives the accurate reason
		// in the overwhelmingly common case instead of always reporting the
		// generic idle-timeout message.
		reason := "brokered web session reached its maximum lifetime"
		switch {
		case row.LastHeartbeatAt != nil && row.LastHeartbeatAt.Before(heartbeatCutoff) && row.ExpiresAt.After(now):
			reason = "browser tab was closed or lost connectivity (no heartbeat received)"
		case row.LastHeartbeatAt == nil && row.RequestCount == 0 && row.ExpiresAt.After(now):
			// Distinguished from the stale-heartbeat case on purpose: this one
			// means the operator never got into the application at all, which
			// points at the launch URL or a blocked popup rather than at
			// anything they did.
			reason = "brokered session was never entered — the launch URL was not opened"
		case row.ExpiresAt.After(now):
			reason = fmt.Sprintf("brokered web session was idle for more than %d minutes", s.cfg.IdleTimeoutMin)
		}
		if err := s.End(row.ID, row.UserID, true, models.WebProxySessionExpired, reason); err != nil {
			s.logger.Warn("webproxy.reconcile.end.fail",
				zap.String("web_proxy_session_id", row.ID), zap.Error(err))
			continue
		}
		closed++
	}
	if closed > 0 {
		s.logger.Info("webproxy.reconcile.closed", zap.Int("count", closed))
	}
	return closed, nil
}

// ListActive powers the admin view of live brokered web sessions.
func (s *Service) ListActive() ([]models.WebProxySession, error) {
	var rows []models.WebProxySession
	err := s.db.Where("status = ?", models.WebProxySessionActive).
		Order("last_activity_at DESC").Find(&rows).Error
	return rows, err
}

// ListMine powers the operator's own "my brokered sessions" self-service
// view — the web-proxy counterpart to ResourceService.ListSessions filtered
// to one user, since brokered sessions live in their own table.
func (s *Service) ListMine(userID string) ([]MySession, error) {
	var rows []models.WebProxySession
	if err := s.db.Where("user_id = ? AND status = ?", userID, models.WebProxySessionActive).
		Order("last_activity_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}

	out := make([]MySession, 0, len(rows))
	for i := range rows {
		out = append(out, MySession{
			WebProxySession: rows[i],
			AppURL:          s.appURL(rows[i].Subdomain),
		})
	}
	return out, nil
}

// MySession is a live brokered session as its own operator sees it: the row
// plus the URL to re-enter it.
//
// AppURL is computed here rather than in the browser because the subdomain is
// only half of it — the scheme and base domain come from server config the
// console has no way to know. Without it the console can only offer "start
// another session", and because a resource's subdomain is deterministic
// (Subdomain(name, id)), a second session silently overwrites the first
// session's cookie on that host and abandons the row as ACTIVE. Re-entry
// needs no new handoff: the cookie is already set on that subdomain and lives
// for the session's TTL.
type MySession struct {
	models.WebProxySession
	AppURL string `json:"app_url"`
}

// RecordHeartbeat updates the liveness signal a heartbeat-injected browser
// tab sends on an interval for as long as it stays open (see proxy.go's
// injectHeartbeat and the heartbeatPath route). Best-effort and silent on
// failure/unknown-session by design: this is called by an unauthenticated
// beacon from the browser with no response the page ever inspects, so there
// is nothing useful to surface — a missed heartbeat write just means the
// NEXT one (15s later) carries the liveness signal instead.
//
// Deliberately does NOT re-validate the full session (status/grant/etc. —
// that's Resolve()'s job on the requests that actually matter); a stray
// heartbeat for an already-dead session updating a column nobody reads
// again is harmless, and adding those checks here would only cost a second
// query on the hottest, most frequent request this feature makes.
func (s *Service) RecordHeartbeat(webProxySessionID string) {
	now := time.Now().UTC()
	if err := s.db.Model(&models.WebProxySession{}).
		Where("id = ? AND status = ?", webProxySessionID, models.WebProxySessionActive).
		Updates(map[string]interface{}{
			"last_heartbeat_at": now,
			"last_activity_at":  now,
		}).Error; err != nil {
		s.logger.Warn("webproxy.heartbeat.persist.fail",
			zap.String("web_proxy_session_id", webProxySessionID), zap.Error(err))
	}
}

// ListActivity returns the per-request audit trail for one brokered session,
// oldest first.
func (s *Service) ListActivity(webProxySessionID string, page, pageSize int) ([]models.WebProxyActivity, int64, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 500 {
		pageSize = 100
	}
	q := s.db.Model(&models.WebProxyActivity{}).Where("web_proxy_session_id = ?", webProxySessionID)

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []models.WebProxyActivity
	err := q.Order("sequence ASC").
		Limit(pageSize).Offset((page - 1) * pageSize).Find(&rows).Error
	return rows, total, err
}

// ──────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────

func (s *Service) appURL(subdomain string) string {
	host := subdomain + "." + s.cfg.BaseDomain
	// The port belongs in the URL but NOT in BaseDomain: host matching
	// (IsProxyHost) strips the port off the request host and compares against
	// a bare domain, so putting it in BaseDomain would break every match.
	// Omitted when unset or when it is the scheme's default, so a production
	// deployment behind 443 yields a clean https://app.example.com.
	if p := s.cfg.PublicPort; p > 0 && !isDefaultPort(s.cfg.Scheme, p) {
		host = fmt.Sprintf("%s:%d", host, p)
	}
	return s.cfg.Scheme + "://" + host
}

func isDefaultPort(scheme string, port int) bool {
	return (scheme == "http" && port == 80) || (scheme == "https" && port == 443)
}

// targetBaseURL resolves the origin PAM should log into and proxy toward.
// console_url is the ONLY source for this — there is deliberately no
// host:port fallback.
//
// An earlier version of this function fell back to http://<host>:<port>
// when console_url was empty, on the theory that some resource types serve
// their web UI directly on their main port. In practice this made the
// brokered gateway silently attempt to speak HTTP to whatever port a
// resource happens to have configured — for postgresql/mongodb/redis/ssh/
// clickhouse, that port speaks a binary wire protocol, not HTTP, and the
// failure surfaced as an opaque "application unreachable" error with no hint
// that the actual problem was "this resource was never meant to be
// web-proxied in the first place." Requiring console_url explicitly makes
// "this resource has no web console" a clear, immediate error instead of a
// confusing connection failure — and costs nothing for resource types where
// the web UI genuinely is host:port, since an admin can just set
// console_url to "http://<host>:<port>" explicitly when that's true.
//
// Takes the raw console_url string rather than a whole resource/connection
// struct on purpose: StartSession has a *services.ConnectionInfo and Resolve
// has a *models.PAMResource — two different types that each merely happen to
// carry a field named ConsoleURL. A shared helper over that one field avoids
// wrapping one type in the other, and is what stops Resolve() from ever again
// growing its own independently-drifting copy of this exact logic (which is
// exactly what happened before this comment was written).
func targetBaseURL(consoleURL string) (string, error) {
	raw := strings.TrimSpace(consoleURL)
	if raw == "" {
		return "", ErrResourceNotWebApp
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("%w: console_url %q is not an absolute URL (expected e.g. http://host:9001)",
			ErrResourceNotWebApp, raw)
	}
	return strings.TrimRight(raw, "/"), nil
}

// Subdomain derives the DNS label a resource's proxied app is served under.
// Deterministic (same resource always gets the same host, so browser state
// and bookmarks behave sanely) and collision-proof (a short hash of the
// resource ID is appended, so two resources named "MinIO" stay distinct).
func Subdomain(resourceName, resourceID string) string {
	slug := slugify(resourceName)
	if slug == "" {
		slug = "app"
	}
	if len(slug) > 40 {
		slug = strings.Trim(slug[:40], "-")
	}
	sum := sha256.Sum256([]byte(resourceID))
	return fmt.Sprintf("%s-%s", slug, hex.EncodeToString(sum[:])[:8])
}

func slugify(s string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

func hashToken(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}

func generateToken(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func isMutatingMethod(method string) bool {
	switch strings.ToUpper(method) {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// ──────────────────────────────────────────────────────────────────────────
// CAST RENDERING
//
// A brokered web session has no character stream to record — there is no
// pty, only a series of HTTP requests. What gets recorded instead is that
// request stream, rendered as terminal text: one timestamped, colour-coded
// line per proxied request, written into the exact same asciicast v2 format
// the terminal gateway produces.
//
// That choice is what makes "same player for CLI and web" true rather than
// aspirational — the artifact is byte-for-byte a valid asciicast, so the
// existing replay endpoint and frontend player handle it with no branch on
// session type anywhere. It is also the same approach other PAM/access
// products take for non-terminal protocols (structured events rendered as a
// playable stream), because a video of a browser is a fundamentally
// different, far heavier artifact than what a proxy can honestly capture.
//
// ANSI SGR codes are used directly (not a colour library) to keep this
// package dependency-free, matching the rest of the codebase.
// ──────────────────────────────────────────────────────────────────────────

const (
	ansiReset  = "\x1b[0m"
	ansiDim    = "\x1b[2m"
	ansiBold   = "\x1b[1m"
	ansiRed    = "\x1b[31m"
	ansiGreen  = "\x1b[32m"
	ansiYellow = "\x1b[33m"
	ansiBlue   = "\x1b[34m"
	ansiCyan   = "\x1b[36m"
	ansiGrey   = "\x1b[90m"
)

// sessionBanner is the opening frame of a brokered web session's recording —
// the context an auditor needs before the request stream starts making
// sense (who, what target, which auth strategy, when).
func sessionBanner(username, resourceName, resourceType, appURL, targetURL, authStrategy string, startedAt time.Time) string {
	var b strings.Builder
	b.WriteString(ansiBold + "*** PAM brokered web session — recorded ***" + ansiReset + "\r\n")
	fmt.Fprintf(&b, ansiDim+"Resource "+ansiReset+"%s (%s)\r\n", resourceName, resourceType)
	fmt.Fprintf(&b, ansiDim+"Operator "+ansiReset+"%s\r\n", username)
	fmt.Fprintf(&b, ansiDim+"Target   "+ansiReset+"%s\r\n", targetURL)
	fmt.Fprintf(&b, ansiDim+"Proxied  "+ansiReset+"%s\r\n", appURL)
	fmt.Fprintf(&b, ansiDim+"Auth     "+ansiReset+"%s (established server-side; credential never sent to the browser)\r\n", authStrategy)
	fmt.Fprintf(&b, ansiDim+"Started  "+ansiReset+"%s\r\n", startedAt.Format("2006-01-02 15:04:05 UTC"))
	b.WriteString(ansiGrey + strings.Repeat("─", 100) + ansiReset + "\r\n")
	return b.String()
}

// requestFrame renders one proxied request as a single terminal line:
//
//	15:04:05  GET     /browser/pam-agent                     200    1.4 KB     45ms
func requestFrame(rec ActivityRecord, now time.Time) string {
	return fmt.Sprintf("%s%s%s  %s%-7s%s %-52s %s%3d%s  %10s  %6dms\r\n",
		ansiGrey, now.Format("15:04:05"), ansiReset,
		methodColour(rec.Method), rec.Method, ansiReset,
		truncate(rec.Path, 52),
		statusColour(rec.StatusCode), rec.StatusCode, ansiReset,
		humanBytes(rec.ResponseBodyBytes),
		rec.DurationMs,
	)
}

// sessionFooter closes the recording with how and why the session ended —
// the same information an admin sees on the session row, so a replay is
// self-contained.
func sessionFooter(status, reason string, requestCount int64) string {
	var b strings.Builder
	b.WriteString(ansiGrey + strings.Repeat("─", 100) + ansiReset + "\r\n")
	fmt.Fprintf(&b, ansiBold+"*** Session %s ***"+ansiReset+"\r\n", strings.ToLower(status))
	if reason != "" {
		fmt.Fprintf(&b, ansiDim+"Reason   "+ansiReset+"%s\r\n", reason)
	}
	fmt.Fprintf(&b, ansiDim+"Requests "+ansiReset+"%d proxied\r\n", requestCount)
	return b.String()
}

func methodColour(method string) string {
	switch strings.ToUpper(method) {
	case http.MethodGet, http.MethodHead:
		return ansiCyan
	case http.MethodPost, http.MethodPut, http.MethodPatch:
		return ansiYellow
	case http.MethodDelete:
		return ansiRed
	default:
		return ansiBlue
	}
}

func statusColour(status int) string {
	switch {
	case status >= 500:
		return ansiRed
	case status >= 400:
		return ansiYellow
	case status >= 200 && status < 300:
		return ansiGreen
	default:
		return ansiGrey
	}
}

func humanBytes(n int64) string {
	switch {
	case n <= 0:
		return "-"
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	default:
		return fmt.Sprintf("%.1f MB", float64(n)/(1024*1024))
	}
}
