// pam/internal/webproxy/proxy.go
//
// The brokered web-application reverse proxy — the data plane for
// "open in browser, already logged in."
//
// ── The security boundary this file implements ────────────────────────────
//
// Two invariants make this a real PAM control rather than a convenience
// wrapper, and both live here:
//
//  1. The TARGET's session never reaches the browser. Upstream Set-Cookie
//     headers are CAPTURED into the server-side jar and STRIPPED from the
//     response. An operator with devtools open finds only PAM's own opaque
//     proxy cookie, which is useless against the target directly.
//
//  2. PAM's own session never reaches the target. The proxy cookie is
//     removed from the outbound Cookie header before the request leaves,
//     so a compromised or malicious target application cannot capture a
//     token that would let it impersonate the operator back to PAM.
//
// Every request is additionally re-authorized from the database (no caching
// — see Service.Resolve), so an admin kill or a JIT grant revoke takes
// effect on the very next request, and every request lands in the activity
// log.
//
// ── Why host-based routing ────────────────────────────────────────────────
//
// Requests arrive on "<subdomain>.<base_domain>" and are matched by Host
// header. Serving each app on its own origin is what allows the app's own
// root-relative URLs ("/api/v1/...", "/static/...") to resolve correctly
// with zero HTML/JS/CSS body rewriting — the thing that makes a path-prefixed
// proxy endlessly fragile in front of arbitrary third-party SPAs.
package webproxy

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
)

const (
	// proxyCookieName is the browser-facing session cookie. Prefixed with
	// "__Host-" in secure deployments (see cookieName) — that prefix is
	// enforced by browsers to mean "Secure, Path=/, and NO Domain
	// attribute", which pins the cookie to exactly this one subdomain and
	// makes it impossible for a sibling app's origin to set or read it.
	proxyCookieName = "pam_web_session"

	// handoffPath is where a launch URL lands: it converts the single-use
	// handoff token into the session cookie, then redirects to the app root
	// so the token never stays in the address bar or browser history.
	// pamControlPrefix covers every path this package owns. Used to decide
	// whether an unrecognised host is worth logging: a stray scan of "/" is
	// noise, an arrival at "/__pam/…" is a launch that just broke.
	pamControlPrefix = "/__pam/"

	handoffPath = "/__pam/auth"

	// logoutPath lets the operator (or the app's own "log out" link, when
	// pointed here) end the brokered session explicitly.
	logoutPath = "/__pam/logout"

	// heartbeatPath is where the script injectHeartbeat embeds into every
	// proxied HTML page beacons back to, for as long as the tab stays open —
	// see the file-header comment on "operator closed the tab" detection.
	heartbeatPath = "/__pam/heartbeat"

	handoffQueryParam = "t"

	// heartbeatIntervalSeconds is how often the injected script beacons back
	// while the tab is open (plus once immediately on load). Must be kept in
	// sync with heartbeatGraceSeconds (service.go): the grace period is a
	// multiple of this interval, sized to tolerate a couple of missed beats
	// from normal network jitter or a background tab's throttled timers
	// without mistaking that for the tab having actually been closed.
	heartbeatIntervalSeconds = 15

	// unenteredGraceSeconds bounds how long a session may sit ACTIVE having
	// never been entered at all — no heartbeat, no proxied request. Longer
	// than the heartbeat grace because it covers a human opening a tab and a
	// console booting, not a missed beat on a live connection.
	unenteredGraceSeconds = 120

	// heartbeatGraceSeconds is how long a brokered session may go without a
	// heartbeat before ReconcileExpired (service.go) treats the tab as
	// closed and ends the session — three missed intervals, long enough to
	// absorb a slow network blip or a throttled background tab without
	// false-positiving, short enough that an actually-abandoned session
	// doesn't sit open for long.
	heartbeatGraceSeconds = 3 * heartbeatIntervalSeconds
)

// htmlBodyCap bounds both the heartbeat-injection buffering and the
// (separate, recording-gated) page-capture read in ModifyResponse — a
// response body over this size is passed through unmodified/uncaptured
// rather than buffered, so an oversized page can never pin unbounded memory
// or block the proxy's normal streaming behavior for everything else.
// Shares the configured request-body ceiling
// (PAM_WEBPROXY_MAX_REQUEST_BODY_BYTES) rather than introducing a second
// size knob to explain; falls back to a sane default if that's left at 0
// (unbounded requests, but HTML buffering still needs SOME ceiling).
func (h *Handler) htmlBodyCap() int64 {
	if max := h.svc.Config().MaxRequestBodyBytes; max > 0 {
		return max
	}
	return 16 * 1024 * 1024
}

// Handler serves the proxy host. Mounted with gin's NoRoute so it sees every
// path on the proxy subdomains, while the API's own routes on the API host
// are untouched — see IsProxyHost.
type Handler struct {
	svc    *Service
	logger *zap.Logger
}

func NewHandler(svc *Service, logger *zap.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

// IsProxyHost reports whether an incoming request is addressed to a proxied
// app rather than to PAM's own API. Compares only the host label(s) beneath
// the configured base domain, and requires a non-empty single label — so
// the API's own host, and the bare base domain itself, are never treated as
// a proxy target.
func (h *Handler) IsProxyHost(host string) (subdomain string, ok bool) {
	if !h.svc.Enabled() {
		return "", false
	}
	host = strings.ToLower(host)
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i] // strip port
	}
	suffix := "." + h.svc.Config().BaseDomain
	if !strings.HasSuffix(host, suffix) {
		return "", false
	}
	label := strings.TrimSuffix(host, suffix)
	if label == "" || strings.Contains(label, ".") {
		// Reject deeper nesting ("a.b.pam.example.com"): a wildcard TLS cert
		// only covers one level, and accepting deeper labels would let a
		// crafted host slip past the single-label subdomain lookup.
		return "", false
	}

	// Reserved labels are infrastructure, not sessions. See
	// config.WebProxyConfig.ReservedSubdomains for why this exists: without it,
	// putting the API on "api.<base_domain>" silently strips its CORS headers
	// and hands its preflights to the proxy, producing a browser error that
	// names neither the API host nor this setting.
	for _, reserved := range h.svc.Config().ReservedSubdomains {
		if label == reserved {
			return "", false
		}
	}

	return label, true
}

// ServeHTTP is the gin handler for every request on a proxy host.
func (h *Handler) ServeHTTP(c *gin.Context) {
	subdomain, ok := h.IsProxyHost(c.Request.Host)
	if !ok {
		// A request that looks like a session launch but landed on a host this
		// process does not consider a proxy host is the single most confusing
		// failure this package has: everything upstream succeeded, so the
		// operator sees a bare 404 with nothing naming the cause.
		//
		// Log it once, with both sides of the comparison. The body stays a
		// plain 404 — this is an unauthenticated edge and the configured
		// domain is not something to hand out — but the log now says exactly
		// which host arrived and what it was measured against.
		if strings.HasPrefix(c.Request.URL.Path, pamControlPrefix) {
			h.logger.Warn("webproxy.host_not_recognised",
				zap.String("request_host", c.Request.Host),
				zap.String("path", c.Request.URL.Path),
				zap.Bool("webproxy_enabled", h.svc.Enabled()),
				zap.String("configured_base_domain", h.svc.Config().BaseDomain),
				zap.String("hint", "this host is not \"<single-label>.\"+base_domain; "+
					"check PAM_WEBPROXY_ENABLED and PAM_WEBPROXY_BASE_DOMAIN on THIS process"))
		}
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "Not found"})
		return
	}

	switch c.Request.URL.Path {
	case handoffPath:
		h.handleHandoff(c, subdomain)
		return
	case logoutPath:
		h.handleLogout(c, subdomain)
		return
	case heartbeatPath:
		h.handleHeartbeat(c, subdomain)
		return
	case replayScriptPath:
		h.serveReplayScript(c)
		return
	case replayIngestPath:
		h.handleReplayIngest(c, subdomain)
		return
	case violationPath:
		h.handleViolation(c, subdomain)
		return
	}

	h.handleProxy(c, subdomain)
}

// handleHandoff converts the single-use launch token into an HttpOnly
// session cookie scoped to this one app subdomain, then redirects to the
// app root — so the token is gone from the URL bar, browser history, and
// any downstream access log after exactly one use.
func (h *Handler) handleHandoff(c *gin.Context, subdomain string) {
	raw := c.Query(handoffQueryParam)
	if raw == "" {
		h.renderError(c, http.StatusBadRequest, "Missing handoff token",
			"Open this application from the PAM console rather than by pasting the URL.")
		return
	}

	token, session, err := h.svc.ConsumeHandoff(raw, subdomain)
	if err != nil {
		h.logger.Warn("webproxy.handoff.reject",
			zap.String("subdomain", subdomain), zap.String("ip", c.ClientIP()), zap.Error(err))
		h.renderError(c, http.StatusUnauthorized, "This access link is no longer valid",
			"Launch links are single-use and expire within seconds. Open the resource again from the PAM console.")
		return
	}

	secure := h.svc.Config().Scheme == "https"
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     cookieName(secure),
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		// Lax, not Strict: the operator arrives here by a cross-site
		// top-level navigation from the PAM console, and Strict would
		// withhold the cookie on exactly that first navigation. Lax still
		// blocks it on cross-site subrequests, which is the CSRF-relevant
		// case.
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(time.Until(session.ExpiresAt).Seconds()),
	})

	c.Redirect(http.StatusFound, "/")
}

func (h *Handler) handleLogout(c *gin.Context, subdomain string) {
	if rs, err := h.resolveFromRequest(c, subdomain); err == nil {
		if endErr := h.svc.End(rs.Session.ID, rs.Session.UserID, true, "ENDED",
			"operator ended the brokered web session"); endErr != nil {
			h.logger.Warn("webproxy.logout.end.fail", zap.Error(endErr))
		}
	}
	h.clearCookie(c)
	h.renderError(c, http.StatusOK, "Session ended",
		"Your brokered session has been closed. Return to the PAM console to open it again.")
}

// handleHeartbeat is the beacon endpoint injectHeartbeat's script pings on
// an interval for as long as the tab stays open — see the file-header
// comment on why HTTP needs this at all (no persistent connection to detect
// EOF on, unlike the WebSocket-based terminal). Deliberately minimal: no
// error path distinguishes "session already dead" from "malformed
// cookie" from anything else — sendBeacon's caller (the browser) never
// inspects the response, so there is nothing useful to tell it, and the
// operator-visible failure mode either way is the same (the session ages
// out on schedule instead of being kept alive).
func (h *Handler) handleHeartbeat(c *gin.Context, subdomain string) {
	if rs, err := h.resolveFromRequest(c, subdomain); err == nil {
		h.svc.RecordHeartbeat(rs.Session.ID)
	}
	c.Status(http.StatusNoContent)
}

// handleProxy authorizes and forwards one request.
func (h *Handler) handleProxy(c *gin.Context, subdomain string) {
	rs, err := h.resolveFromRequest(c, subdomain)
	if err != nil {
		switch {
		case errors.Is(err, ErrSessionNotUsable):
			h.clearCookie(c)
			h.renderError(c, http.StatusUnauthorized, "Your session has ended",
				"This session expired, went idle, or was revoked by an administrator. Open the resource again from the PAM console.")
		case errors.Is(err, ErrSessionNotFound):
			h.clearCookie(c)
			h.renderError(c, http.StatusUnauthorized, "Not signed in",
				"Open this application from the PAM console to start a brokered session.")
		case errors.Is(err, ErrDisabled):
			h.renderError(c, http.StatusServiceUnavailable, "Web application access is disabled",
				"An administrator has not enabled the brokered web gateway on this server.")
		default:
			h.logger.Error("webproxy.resolve.fail", zap.String("subdomain", subdomain), zap.Error(err))
			h.renderError(c, http.StatusInternalServerError, "Could not open the application",
				"PAM could not resolve this brokered session. Try opening the resource again.")
		}
		return
	}

	// The egress budget is checked BEFORE forwarding: once a session has
	// pulled its allowance there is nothing to gain from fetching more bytes
	// from the target only to refuse them here. See
	// WebProxySession.EgressBudgetExhausted for why this bounds bulk egress
	// rather than enforcing an exact quota.
	if rs.Session.EgressBudgetExhausted() {
		h.svc.RecordEgressBudgetExceeded(rs, c.Request.URL.Path)
		h.renderError(c, http.StatusForbidden, "Data transfer limit reached",
			"This session has reached the data volume its policy permits. Further requests are "+
				"blocked and the event has been recorded. Contact an administrator if you need a larger allowance.")
		return
	}

	started := time.Now()
	requestBytes := c.Request.ContentLength
	if requestBytes < 0 {
		requestBytes = 0
	}
	// Bound what a single proxied request may stream through, so an upload
	// cannot be used to pin unbounded memory/bandwidth via the proxy.
	if max := h.svc.Config().MaxRequestBodyBytes; max > 0 && c.Request.Body != nil {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, max)
	}

	recorder := &responseRecorder{ResponseWriter: c.Writer, status: http.StatusOK}
	proxy := h.buildReverseProxy(rs)
	proxy.ServeHTTP(recorder, c.Request)

	h.svc.RecordActivity(rs, ActivityRecord{
		Method:            c.Request.Method,
		Path:              c.Request.URL.Path,
		StatusCode:        recorder.status,
		RequestBodyBytes:  requestBytes,
		ResponseBodyBytes: recorder.written,
		DurationMs:        time.Since(started).Milliseconds(),
		SourceIP:          c.ClientIP(),
		OccurredAt:        started.UTC(),
		IsDocument:        recorder.isDocument,
	})
}

// buildReverseProxy constructs the per-request proxy. Built per request
// rather than cached because Director/ModifyResponse close over this
// specific session's upstream state.
func (h *Handler) buildReverseProxy(rs *ResolvedSession) *httputil.ReverseProxy {
	target := rs.Target
	proxyHost := rs.Session.Subdomain + "." + h.svc.Config().BaseDomain

	return &httputil.ReverseProxy{
		Transport: h.svc.client.Transport,

		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			// The target must see its OWN hostname in Host — many apps
			// generate absolute URLs, validate Host, or route virtual hosts
			// on it, and would misbehave given the proxy's hostname.
			req.Host = target.Host

			// INVARIANT 2 (see file header): PAM's proxy cookie must never
			// leave for the target. Rebuild the Cookie header from the
			// server-side jar only.
			stripProxyCookie(req)
			for name, value := range rs.Upstream.Cookies {
				req.AddCookie(&http.Cookie{Name: name, Value: value})
			}
			for name, value := range rs.Upstream.Headers {
				req.Header.Set(name, value)
			}

			// Identify the real client to the target the standard way, and
			// overwrite rather than append — a client-supplied
			// X-Forwarded-For would otherwise let the operator forge the
			// source IP that lands in the target's own logs.
			req.Header.Set("X-Forwarded-Proto", h.svc.Config().Scheme)
			req.Header.Set("X-Forwarded-Host", proxyHost)
			req.Header.Del("X-Real-IP")

			// Dropping the client's Accept-Encoding hands encoding
			// negotiation to Go's Transport, which requests gzip itself and
			// decompresses transparently — so ModifyResponse always sees a
			// plain body it can rewrite, and the hop back to the browser
			// re-compresses at the edge if configured to. Note the cost:
			// a transparently-decompressed response has ContentLength -1 and
			// no Content-Length header (the compressed length no longer
			// describes the bytes), which is why injectHeartbeat must not
			// depend on knowing the body length up front.
			req.Header.Del("Accept-Encoding")
		},

		ModifyResponse: func(resp *http.Response) error {
			// INVARIANT 1 (see file header): capture the target's cookies
			// into the server-side jar and strip them from what the browser
			// sees. This is the single most important line in this file.
			if cookies := resp.Cookies(); len(cookies) > 0 {
				changed := false
				for _, ck := range cookies {
					// An upstream deletion (empty value / MaxAge<0) must
					// clear the jar entry too, or we would keep replaying a
					// cookie the target has explicitly retired.
					if ck.Value == "" || ck.MaxAge < 0 {
						if _, ok := rs.Upstream.Cookies[ck.Name]; ok {
							delete(rs.Upstream.Cookies, ck.Name)
							changed = true
						}
						continue
					}
					if rs.Upstream.Cookies[ck.Name] != ck.Value {
						rs.Upstream.setCookie(ck.Name, ck.Value)
						changed = true
					}
				}
				resp.Header.Del("Set-Cookie")
				if changed {
					if err := h.svc.PersistUpstreamState(rs.Session.ID, rs.Upstream); err != nil {
						// Non-fatal: the in-memory jar for THIS request is
						// already correct, so the operator's session keeps
						// working; only a later request would fall back to
						// the stale stored jar.
						h.logger.Warn("webproxy.upstream_state.persist.fail",
							zap.String("web_proxy_session_id", rs.Session.ID), zap.Error(err))
					}
				}
			}

			rewriteRedirect(resp, target, h.svc.Config().Scheme, proxyHost)

			// The target's HSTS policy is about the target's own hostname
			// and would be misapplied to the proxy domain — PAM's own edge
			// is responsible for HSTS here.
			resp.Header.Del("Strict-Transport-Security")

			// Sever window.opener. The console opens a brokered session with
			// window.open() and must NOT pass noopener — that flag makes
			// window.open return null, leaving the caller no handle to point
			// at the launch URL. Declaring the opener policy on our own
			// responses achieves the same isolation without that cost: the
			// browser breaks the opener relationship, so the proxied
			// application cannot navigate or inspect the console tab that
			// launched it.
			resp.Header.Set("Cross-Origin-Opener-Policy", "same-origin")

			// Download refusal happens before injection: a blocked response
			// is replaced wholesale, so there is nothing left worth
			// injecting into and the reason must not be lost to a rewrite.
			if rs.Session.BlockDownload {
				if reason := blockedDownloadReason(resp); reason != "" {
					h.svc.RecordDownloadBlocked(rs, resp.Request.URL.Path, reason)
					denyDownload(resp, reason)
					return nil
				}
			}

			if isHTMLResponse(resp) {
				h.injectHeartbeat(rs, resp)
			}
			return nil
		},

		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			h.logger.Warn("webproxy.upstream.error",
				zap.String("web_proxy_session_id", rs.Session.ID),
				zap.String("target", target.String()),
				zap.String("path", r.URL.Path),
				zap.Error(err))
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, errorPage("Application unreachable",
				"PAM could not reach the target application. It may be down, or unreachable from the PAM server."))
		},
	}
}

// isHTMLResponse reports whether a proxied response is a real HTML document
// worth buffering for heartbeat injection / page capture — everything else
// (JSON APIs, images, fonts, SSE/chunked streams, WebSocket upgrades) stays
// on the pure streaming path untouched.
func isHTMLResponse(resp *http.Response) bool {
	ct := resp.Header.Get("Content-Type")
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	return strings.EqualFold(strings.TrimSpace(ct), "text/html")
}

// injectHeartbeat buffers an HTML response to append the heartbeat beacon
// script (see the file-header note on tab-close detection).
//
// The body length is deliberately neither trusted nor required. Director
// drops Accept-Encoding, which makes Go's Transport negotiate gzip itself
// and decompress transparently: the body arrives plain, but ContentLength is
// -1 with no Content-Length header, exactly as a chunked response looks.
// Gating injection on a known length therefore skipped every gzip-capable
// upstream — which is nearly all of them — and silently disabled tab-close
// detection everywhere while the page still rendered perfectly, so nothing
// looked broken; sessions just sat ACTIVE until the idle timeout and their
// recordings, finalised on End, never landed.
//
// Reading through a cap+1 limit removes the need to know anything in
// advance: at or under the cap the buffer IS the whole body and can be
// rewritten exactly; over it, the already-read prefix is stitched back in
// front of the unread remainder and the response streams on untouched. No
// truncation risk either way, and memory stays bounded by the cap.
func (h *Handler) injectHeartbeat(rs *ResolvedSession, resp *http.Response) {
	// Bodiless by definition: injecting would both corrupt the response and
	// stamp it with a Content-Length describing bytes that must not be sent.
	if resp.Body == nil ||
		resp.StatusCode == http.StatusNoContent ||
		resp.StatusCode == http.StatusNotModified ||
		(resp.Request != nil && resp.Request.Method == http.MethodHead) {
		return
	}

	limit := h.htmlBodyCap()
	buf, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		// The stream is already broken; there is nothing intact left to hand
		// back, so fail closed with an empty body rather than a partial page.
		h.logger.Warn("webproxy.html_body.read.fail",
			zap.String("web_proxy_session_id", rs.Session.ID), zap.Error(err))
		_ = resp.Body.Close()
		resp.Body = io.NopCloser(bytes.NewReader(nil))
		resp.ContentLength = 0
		resp.Header.Set("Content-Length", "0")
		return
	}

	if int64(len(buf)) > limit {
		// Over the cap: pass through unmodified. The prefix is already off
		// the wire, so it has to be replayed ahead of the rest — and the
		// original body still needs closing, hence the wrapper.
		resp.Body = struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(buf), resp.Body), resp.Body}
		return
	}
	_ = resp.Body.Close()

	// A target's own CSP will silently refuse an inline script unless the
	// policy is taught about this one specifically — see csp.go. Done here,
	// after the decision to inject, so a page that is only passed through
	// never has its headers touched.
	nonce := ""
	if n, err := newCSPNonce(); err != nil {
		// Without a usable nonce the beacon may be blocked, but a page served
		// with no script at all is worse than one whose heartbeat degrades to
		// the idle timeout — carry on unnonced.
		h.logger.Warn("webproxy.csp_nonce.generate.fail",
			zap.String("web_proxy_session_id", rs.Session.ID), zap.Error(err))
	} else if prepareCSPForBeacon(resp.Header, n) {
		nonce = n
	}

	// Say what was injected, so a page that behaves unexpectedly can be
	// diagnosed from the response rather than by guessing at the server.
	applied := appliedGuards(rs.Session, rs.RecordingRequired)
	resp.Header.Set("X-PAM-Guards", strings.Join(applied, ","))
	h.logger.Info("webproxy.inject",
		zap.String("web_proxy_session_id", rs.Session.ID),
		zap.String("path", func() string {
			if resp.Request != nil {
				return resp.Request.URL.Path
			}
			return ""
		}()),
		zap.Strings("guards", applied),
		zap.Bool("block_clipboard", rs.Session.BlockClipboard),
		zap.Bool("block_devtools", rs.Session.BlockDevTools),
		zap.Bool("nonce_issued", nonce != ""))

	injected := injectHeartbeatScript(buf, pamScriptTags(nonce, rs.RecordingRequired, rs.Session))
	resp.Body = io.NopCloser(bytes.NewReader(injected))
	resp.ContentLength = int64(len(injected))
	resp.Header.Set("Content-Length", strconv.Itoa(len(injected)))
}

// heartbeatScriptTag is injected into every proxied HTML page. Uses
// sendBeacon (fire-and-forget, survives the page unloading) where available,
// falling back to a synchronous XHR for the rare browser without it. Wrapped
// in try/catch so a hostile or unusual page's own script errors, or a
// browser that blocks the call entirely, can never break the page itself —
// worst case, this session just ages out via idle timeout instead of the
// faster heartbeat-based detection.
var heartbeatScriptJS = fmt.Sprintf(
	`(function(){try{function b(){try{if(navigator.sendBeacon){navigator.sendBeacon(%q);}else{var x=new XMLHttpRequest();x.open('POST',%q,true);x.send();}}catch(e){}}b();setInterval(b,%d);}catch(e){}})();`,
	heartbeatPath, heartbeatPath, heartbeatIntervalSeconds*1000,
)

// heartbeatScriptTag is the tag as injected into a page whose CSP (if any)
// already permits inline script.
var heartbeatScriptTag = []byte("<script>" + heartbeatScriptJS + "</script>")

// heartbeatScriptTagWithNonce returns the tag carrying a CSP nonce, for a
// page whose policy forbids inline script — see csp.go. An empty nonce means
// no policy needed one, so the plain tag is used and nothing is added to the
// page that was not there before.
func heartbeatScriptTagWithNonce(nonce string) []byte {
	if nonce == "" {
		return heartbeatScriptTag
	}
	return []byte(`<script nonce="` + nonce + `">` + heartbeatScriptJS + `</script>`)
}

// appliedGuards names the controls injected into this page, in the order
// pamScriptTags adds them.
//
// EXISTS TO END A CLASS OF UNANSWERABLE QUESTION. "The guard is not working"
// has three completely different causes that look identical from a browser: the
// running binary predates the feature, the resource's policy never asked for
// it, or it was injected and something in the page defeated it. Each needs a
// different fix and none of them is visible in the rendered page.
//
// The result is emitted as the X-PAM-Guards response header on every injected
// document, so the answer is one click away in the Network panel:
//
//	header absent          the running build has no guard injection at all
//	"heartbeat"            injected, but this session's policy asked for nothing
//	"heartbeat,clipboard"  copy blocking on, developer-tools blocking off
//	"...,devtools"         the guard is on the page; look at the page, not the server
//
// It reveals nothing an operator cannot already learn by pressing a key, and it
// costs one header on documents only.
func appliedGuards(session *models.WebProxySession, recordingRequired bool) []string {
	out := []string{"heartbeat"}
	if session != nil {
		if session.BlockClipboard {
			out = append(out, "clipboard")
		}
		if session.BlockDevTools {
			out = append(out, "devtools")
		}
		if session.Watermark {
			out = append(out, "watermark")
		}
	}
	if recordingRequired {
		out = append(out, "replay")
	}
	return out
}

// pamScriptTags is everything PAM adds to a proxied page: the inline
// heartbeat that detects a closed tab, plus — only when the session carries a
// recording obligation — the visual replay recorder from replay.go.
//
// The recorder is a 260KB external script, so loading it on a session nobody
// will ever replay is pure cost imposed on the operator's page load; gating
// it on RecordingRequired also means an administrator who chose not to record
// a resource gets no capture machinery in the page at all.
//
// Both tags carry the nonce when one was needed. The external tag would
// usually be admitted by `script-src 'self'` regardless (it is served from
// the proxy origin), but a nonce authorises an element whatever its source,
// which covers a policy that omits 'self' entirely.
func pamScriptTags(nonce string, recordingRequired bool, session *models.WebProxySession) []byte {
	tags := heartbeatScriptTagWithNonce(nonce)

	// Data-protection controls, per the policy this session was opened under.
	// Both are client-side by nature — see dlp.go on why that is a friction
	// and attribution layer rather than prevention.
	if session != nil {
		if session.BlockClipboard {
			tags = append(tags, guardScriptTag(nonce)...)
		}
		if session.BlockDevTools {
			// Its own policy flag, set per resource in the Edit dialog's Data
			// protection section, NOT folded into BlockClipboard. The two have
			// different costs: clipboard blocking is invisible until somebody
			// tries to copy, while this one blanks the page on a heuristic. An
			// administrator has to be able to stop copying from a console their
			// team uses all day without also accepting that risk on it.
			tags = append(tags, devtoolsGuardScriptTag(nonce)...)
		}
		if session.Watermark {
			tags = append(tags, watermarkScriptTag(nonce, session.Username, session.ID)...)
		}
	}

	if !recordingRequired {
		return tags
	}

	attrs := ` src="` + replayScriptPath + `" async`
	if nonce != "" {
		attrs = ` nonce="` + nonce + `"` + attrs
	}
	out := make([]byte, 0, len(tags)+len(attrs)+20)
	out = append(out, tags...)
	out = append(out, "<script"...)
	out = append(out, attrs...)
	out = append(out, "></script>"...)
	return out
}

// injectHeartbeatScript inserts heartbeatScriptTag immediately before the
// last </body> (case-insensitive), or appends it if the page has none (a
// fragment, or unusual markup) — either way every full HTML page load gets
// the beacon without needing to understand the rest of the document.
func injectHeartbeatScript(html, tag []byte) []byte {
	idx := bytes.LastIndex(bytes.ToLower(html), []byte("</body>"))
	out := make([]byte, 0, len(html)+len(tag))
	if idx < 0 {
		out = append(out, html...)
		out = append(out, tag...)
		return out
	}
	out = append(out, html[:idx]...)
	out = append(out, tag...)
	out = append(out, html[idx:]...)
	return out
}

// resolveFromRequest pulls the proxy cookie and resolves it to a live,
// authorized session.
func (h *Handler) resolveFromRequest(c *gin.Context, subdomain string) (*ResolvedSession, error) {
	secure := h.svc.Config().Scheme == "https"
	ck, err := c.Request.Cookie(cookieName(secure))
	if err != nil || ck.Value == "" {
		return nil, ErrSessionNotFound
	}
	return h.svc.Resolve(ck.Value, subdomain)
}

func (h *Handler) clearCookie(c *gin.Context) {
	secure := h.svc.Config().Scheme == "https"
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     cookieName(secure),
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func (h *Handler) renderError(c *gin.Context, status int, title, detail string) {
	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Header("Cache-Control", "no-store")
	c.String(status, errorPage(title, detail))
}

// ── helpers ───────────────────────────────────────────────────────────────

// cookieName applies the __Host- prefix when the deployment is HTTPS.
// Browsers refuse a __Host- cookie that isn't Secure+Path=/+no-Domain, which
// makes it structurally impossible for one proxied app's origin to set a
// cookie that another would read.
func cookieName(secure bool) string {
	if secure {
		return "__Host-" + proxyCookieName
	}
	return proxyCookieName
}

// stripProxyCookie removes PAM's own session cookie from an outbound
// request while preserving every other cookie the browser sent.
func stripProxyCookie(req *http.Request) {
	cookies := req.Cookies()
	req.Header.Del("Cookie")
	for _, ck := range cookies {
		if ck.Name == proxyCookieName || ck.Name == "__Host-"+proxyCookieName {
			continue
		}
		req.AddCookie(ck)
	}
}

// rewriteRedirect maps a Location header pointing at the target's own origin
// back onto the proxy origin, so a login/redirect chain inside the app keeps
// the operator on the proxy instead of bouncing them to the target directly
// (where they would have no session, and would be prompted for the very
// credential this feature exists to keep from them).
func rewriteRedirect(resp *http.Response, target *url.URL, scheme, proxyHost string) {
	loc := resp.Header.Get("Location")
	if loc == "" {
		return
	}
	u, err := url.Parse(loc)
	if err != nil {
		return
	}
	// Relative Location resolves against the proxy host already — nothing to do.
	if u.Host == "" {
		return
	}
	if !strings.EqualFold(u.Host, target.Host) {
		// Points somewhere else entirely (an external IdP, a CDN). Leave it:
		// rewriting it onto the proxy origin would proxy a host this session
		// was never authorized for.
		return
	}
	u.Scheme = scheme
	u.Host = proxyHost
	resp.Header.Set("Location", u.String())
}

// responseRecorder captures status and byte count for the activity log
// without buffering the body — the proxy must stay a streaming proxy, or a
// large download would sit in memory before reaching the operator.
type responseRecorder struct {
	http.ResponseWriter
	status  int
	written int64
	wrote   bool
	// isDocument records whether this response was an HTML document, read
	// off the headers at WriteHeader time (the last moment they are still
	// the response's own, before the body starts streaming). Feeds
	// ActivityRecord.IsDocument, which decides whether this request counts
	// as an operator "navigation" for the shared command log.
	isDocument bool
}

func (r *responseRecorder) WriteHeader(status int) {
	if !r.wrote {
		r.status = status
		r.wrote = true
		ct := r.Header().Get("Content-Type")
		if i := strings.IndexByte(ct, ';'); i >= 0 {
			ct = ct[:i]
		}
		r.isDocument = strings.EqualFold(strings.TrimSpace(ct), "text/html")
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *responseRecorder) Write(b []byte) (int, error) {
	if !r.wrote {
		r.wrote = true
	}
	n, err := r.ResponseWriter.Write(b)
	r.written += int64(n)
	return n, err
}

// Flush and Hijack are forwarded so streaming responses (SSE, chunked logs)
// and WebSocket upgrades keep working through the recorder. Many admin
// consoles — MinIO's included — use both.
func (r *responseRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (r *responseRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("webproxy: underlying ResponseWriter does not support hijacking")
	}
	return hj.Hijack()
}

func errorPage(title, detail string) string {
	return fmt.Sprintf(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s — PAM</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;
 font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
 background:#0f1115;color:#e6e8eb}
@media (prefers-color-scheme:light){body{background:#f6f7f9;color:#1a1d21}}
.card{max-width:34rem;padding:2.5rem;text-align:center}
h1{margin:0 0 .75rem;font-size:1.35rem;font-weight:600}
p{margin:0;opacity:.75}
.badge{display:inline-block;margin-bottom:1.25rem;padding:.25rem .6rem;
 border:1px solid currentColor;border-radius:99px;font-size:.7rem;
 letter-spacing:.08em;text-transform:uppercase;opacity:.6}
</style></head>
<body><div class="card"><div class="badge">PAM brokered session</div>
<h1>%s</h1><p>%s</p></div></body></html>`,
		htmlEscape(title), htmlEscape(title), htmlEscape(detail))
}

func htmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return r.Replace(s)
}
