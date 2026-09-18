// pam/internal/webproxy/dlp.go
//
// Data-loss controls for brokered web sessions — the enforcement half of
// models.DataProtection.
//
// Read that type's doc comment first: it explains why "the operator cannot
// copy anything" is not what this delivers. The split matters here because
// two very different mechanisms live in this file and they must not be
// confused when reasoning about, or describing, the feature:
//
//	PREVENTION (server-side, in the data path, unbypassable)
//	  · download/attachment refusal        — blockedDownloadReason
//	  · cumulative egress budget           — WebProxySession.EgressBudgetExhausted
//
//	FRICTION + ATTRIBUTION (client-side, defeatable by design)
//	  · clipboard/selection suppression    — guardScriptTag
//	  · identity watermark overlay         — watermarkScriptTag
//
// A determined operator with devtools removes everything in the second group.
// That is not a defect to be patched with obfuscation — it is why the first
// group exists and why the watermark is there to make the result
// attributable. Reporting from the second group is treated as evidence of
// intent, never as proof a copy was prevented.
package webproxy

import (
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

// violationPath is where the injected guard reports a blocked copy attempt.
const violationPath = "/__pam/violation"

// downloadContentTypes are bodies whose only purpose is to become a file on
// the operator's disk. Deliberately a small, high-confidence list: a false
// positive here breaks a console outright, so anything ambiguous
// (application/json, text/csv served for display) is left to the egress
// budget rather than guessed at.
var downloadContentTypes = map[string]bool{
	"application/octet-stream":     true,
	"application/zip":              true,
	"application/x-zip":            true,
	"application/x-zip-compressed": true,
	"application/gzip":             true,
	"application/x-gzip":           true,
	"application/x-tar":            true,
	"application/x-7z-compressed":  true,
	"application/x-rar-compressed": true,
	"application/vnd.rar":          true,
	"application/x-bzip2":          true,
}

// blockedDownloadReason reports why a response must not be delivered, or ""
// when it may pass.
//
// Content-Disposition is checked first and is the stronger signal: it is the
// target application explicitly saying "save this as a file", which is the
// exact intent being denied, and it catches an export endpoint whatever
// content type it chooses to use.
func blockedDownloadReason(resp *http.Response) string {
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		if disposition, _, err := mime.ParseMediaType(cd); err == nil &&
			strings.EqualFold(strings.TrimSpace(disposition), "attachment") {
			return "the application served it as a file download (Content-Disposition: attachment)"
		}
	}

	ct := resp.Header.Get("Content-Type")
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	if downloadContentTypes[strings.ToLower(strings.TrimSpace(ct))] {
		return "its content type is a file/archive body (" + strings.TrimSpace(ct) + ")"
	}
	return ""
}

// denyDownload rewrites a response in place into a refusal. The status is 403
// rather than a stripped 200 so the target application's own error handling
// and the operator's browser both see an unambiguous denial instead of a
// silently empty or truncated file.
func denyDownload(resp *http.Response, reason string) {
	body := errorPage("Download blocked by policy",
		"This resource is configured to prevent data being copied out of a brokered session — "+
			reason+". The attempt has been recorded in the audit log.")
	replaceBody(resp, http.StatusForbidden, body)
}

// replaceBody swaps a proxied response for PAM's own, fixing up the framing
// so nothing downstream is left describing bytes that are no longer there.
func replaceBody(resp *http.Response, status int, body string) {
	resp.StatusCode = status
	resp.Status = fmt.Sprintf("%d %s", status, http.StatusText(status))
	resp.Body = io.NopCloser(strings.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Type", "text/html; charset=utf-8")
	resp.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	resp.Header.Set("Cache-Control", "no-store")
	// An attachment header left on a refusal makes the browser save the
	// refusal page itself as the file the operator asked for.
	resp.Header.Del("Content-Disposition")
	resp.Header.Del("Content-Encoding")
}

// ── Client-side controls ──────────────────────────────────────────────────

// guardScriptTag suppresses the ordinary copy affordances and reports each
// attempt. Inline (it is tiny and must run before the operator can interact),
// so it carries the CSP nonce like the heartbeat does.
//
// Every listener is passive about failure: if a page stops propagation first,
// or the browser blocks the report, the page still works. Breaking the target
// application to protect it is not a trade this feature is allowed to make.
func guardScriptTag(nonce string) []byte {
	js := fmt.Sprintf(
		`(function(){try{`+
			`var R=%q;`+
			`function rep(k){try{if(navigator.sendBeacon){navigator.sendBeacon(R,new Blob([JSON.stringify({kind:k})],{type:"application/json"}));}}catch(e){}}`+
			`function kill(e,k){try{e.preventDefault();e.stopPropagation();}catch(x){}rep(k);return false;}`+
			`["copy","cut","dragstart","selectstart","contextmenu"].forEach(function(n){`+
			`document.addEventListener(n,function(e){return kill(e,n);},true);});`+
			`document.addEventListener("keydown",function(e){`+
			`if(!(e.ctrlKey||e.metaKey))return;`+
			`var k=(e.key||"").toLowerCase();`+
			`if(k==="c"||k==="x"||k==="s"||k==="p"){return kill(e,"key:"+k);}`+
			`},true);`+
			`var st=document.createElement("style");`+
			`st.appendChild(document.createTextNode("*{-webkit-user-select:none!important;user-select:none!important;}input,textarea,[contenteditable]{-webkit-user-select:text!important;user-select:text!important;}"));`+
			`(document.head||document.documentElement).appendChild(st);`+
			`}catch(e){}})();`,
		violationPath)
	return scriptTag(js, nonce)
}

// watermarkScriptTag overlays operator identity across the page.
//
// Built client-side rather than as a server-rendered element because a
// single-page app replaces its DOM freely; the interval re-attaches the
// overlay when that happens. pointer-events:none is what keeps it from being
// a usability disaster — the operator clicks straight through it.
//
// This is the control that actually discourages photographing the screen,
// which no amount of clipboard blocking touches.
func watermarkScriptTag(nonce, username, sessionID string) []byte {
	label := fmt.Sprintf("%s · %s", username, shortID(sessionID))
	js := fmt.Sprintf(
		`(function(){try{`+
			`var L=%q,ID="__pam_wm";`+
			`function mk(){`+
			`if(document.getElementById(ID))return;`+
			`var d=document.createElement("div");d.id=ID;`+
			`var s=d.style;s.position="fixed";s.inset="0";s.zIndex="2147483647";`+
			`s.pointerEvents="none";s.opacity="0.12";s.overflow="hidden";`+
			`s.fontFamily="monospace";s.fontSize="13px";s.color="#000";`+
			`s.mixBlendMode="difference";`+
			`var t=L+"  "+new Date().toISOString().slice(0,16)+"Z";`+
			`var h="";for(var i=0;i<40;i++){h+='<div style="transform:rotate(-30deg);white-space:nowrap;margin:38px 0;">'+`+
			`new Array(6).join(" ")+t+"        "+t+"        "+t+"</div>";}`+
			`d.innerHTML=h;(document.body||document.documentElement).appendChild(d);}`+
			`mk();setInterval(mk,2000);`+
			`}catch(e){}})();`,
		label)
	return scriptTag(js, nonce)
}

// scriptTag wraps JS in a tag, attaching the nonce when the page's policy
// needs one (see csp.go).
func scriptTag(js, nonce string) []byte {
	if nonce == "" {
		return []byte("<script>" + js + "</script>")
	}
	return []byte(`<script nonce="` + nonce + `">` + js + "</script>")
}

// shortID keeps the watermark legible: enough of the session id to correlate
// a leaked screenshot with an audit row, without a full UUID across the page.
func shortID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

// ── Violation reporting ───────────────────────────────────────────────────

// handleViolation records a copy attempt reported by the injected guard.
//
// Recorded as an ATTEMPT, never as a prevention: the report comes from the
// operator's own browser, so its absence proves nothing and its presence only
// proves intent. Paired with the session recording — which shows what was on
// screen at that moment — it becomes something an investigator can act on.
func (h *Handler) handleViolation(c *gin.Context, subdomain string) {
	rs, err := h.resolveFromRequest(c, subdomain)
	if err != nil {
		c.Status(http.StatusNoContent)
		return
	}

	var payload struct {
		Kind string `json:"kind"`
	}
	_ = c.ShouldBindJSON(&payload)
	kind := strings.TrimSpace(payload.Kind)
	if kind == "" {
		kind = "unknown"
	}
	if len(kind) > 40 {
		kind = kind[:40]
	}

	// The same beacon carries both guards' reports, so the kind decides which
	// record is written. Filing a DevTools detection as a clipboard attempt
	// would put it under the wrong control in every compliance query an
	// investigator runs.
	if strings.HasPrefix(kind, "devtools") {
		h.svc.RecordDevToolsDetected(rs, kind)
	} else {
		h.svc.RecordClipboardAttempt(rs, kind)
	}
	c.Status(http.StatusNoContent)
}

// RecordDevToolsDetected audits one report from the injected DevTools guard.
//
// Recorded as an ATTEMPT, exactly like the clipboard guard and for exactly the
// same reason: the report comes from the operator's own browser, so its absence
// proves nothing and its presence only proves intent. A browser with JavaScript
// disabled sends none of these and sees no block.
//
// Severity splits on what was reported. A suppressed shortcut or context menu
// is routine friction and lands at WARN. An actual detection ("devtools:docked",
// "devtools:debugger", "devtools:console") means the operator got DevTools open
// on a brokered production console despite the policy, which is the row worth
// alerting on, so it lands at CRITICAL.
func (s *Service) RecordDevToolsDetected(rs *ResolvedSession, kind string) {
	severity := models.AuditSeverityWarn
	if strings.HasPrefix(kind, "devtools:") {
		severity = models.AuditSeverityCritical
	}

	s.audit.Write(services.AuditEntry{
		ActorUserID:   rs.Session.UserID,
		ActorUsername: rs.Session.Username,
		Action:        models.AuditDevToolsDetected,
		Category:      models.SessionLifecycle,
		Outcome:       models.AuditOutcomeDenied,
		Severity:      severity,
		ResourceID:    rs.Session.ResourceID,
		SessionID:     rs.Session.ConnectionSessionID,
		Details: map[string]interface{}{
			"transport": "web_proxy",
			"control":   "devtools_guard",
			"kind":      kind,
			// Named explicitly so nobody reading this row later mistakes a
			// browser-reported detection for a server-side prevention.
			"enforcement": "client_side_reported",
		},
	})
	s.logger.Info("webproxy.dlp.devtools_detected",
		zap.String("web_proxy_session_id", rs.Session.ID),
		zap.String("kind", kind))
}

// RecordClipboardAttempt audits one reported copy attempt.
func (s *Service) RecordClipboardAttempt(rs *ResolvedSession, kind string) {
	s.audit.Write(services.AuditEntry{
		ActorUserID:   rs.Session.UserID,
		ActorUsername: rs.Session.Username,
		Action:        models.AuditClipboardBlocked,
		Category:      models.SessionLifecycle,
		Outcome:       models.AuditOutcomeDenied,
		Severity:      models.AuditSeverityWarn,
		ResourceID:    rs.Session.ResourceID,
		SessionID:     rs.Session.ConnectionSessionID,
		Details: map[string]interface{}{
			"transport": "web_proxy",
			"control":   "clipboard",
			"kind":      kind,
			// Named explicitly so nobody reading this row later mistakes a
			// browser-reported attempt for a server-side prevention.
			"enforcement": "client_side_reported",
		},
	})
	s.logger.Info("webproxy.dlp.clipboard_attempt",
		zap.String("web_proxy_session_id", rs.Session.ID),
		zap.String("kind", kind))
}

// RecordDownloadBlocked audits a download PAM actually refused.
func (s *Service) RecordDownloadBlocked(rs *ResolvedSession, path, reason string) {
	s.audit.Write(services.AuditEntry{
		ActorUserID:   rs.Session.UserID,
		ActorUsername: rs.Session.Username,
		Action:        models.AuditDownloadBlocked,
		Category:      models.SessionLifecycle,
		Outcome:       models.AuditOutcomeDenied,
		Severity:      models.AuditSeverityWarn,
		ResourceID:    rs.Session.ResourceID,
		SessionID:     rs.Session.ConnectionSessionID,
		Details: map[string]interface{}{
			"transport":   "web_proxy",
			"control":     "download",
			"path":        path,
			"reason":      reason,
			"enforcement": "server_side_prevented",
		},
	})
	s.logger.Warn("webproxy.dlp.download_blocked",
		zap.String("web_proxy_session_id", rs.Session.ID),
		zap.String("path", path), zap.String("reason", reason))
}

// RecordEgressBudgetExceeded audits a session stopped for pulling too much.
func (s *Service) RecordEgressBudgetExceeded(rs *ResolvedSession, path string) {
	s.audit.Write(services.AuditEntry{
		ActorUserID:   rs.Session.UserID,
		ActorUsername: rs.Session.Username,
		Action:        models.AuditEgressBudgetExceeded,
		Category:      models.SessionLifecycle,
		Outcome:       models.AuditOutcomeDenied,
		Severity:      models.AuditSeverityCritical,
		ResourceID:    rs.Session.ResourceID,
		SessionID:     rs.Session.ConnectionSessionID,
		Details: map[string]interface{}{
			"transport":        "web_proxy",
			"control":          "egress_budget",
			"path":             path,
			"egress_bytes":     rs.Session.EgressBytes,
			"max_egress_bytes": rs.Session.MaxEgressBytes,
			"enforcement":      "server_side_prevented",
		},
	})
	s.logger.Warn("webproxy.dlp.egress_budget_exceeded",
		zap.String("web_proxy_session_id", rs.Session.ID),
		zap.Int64("egress_bytes", rs.Session.EgressBytes),
		zap.Int64("max_egress_bytes", rs.Session.MaxEgressBytes))
}
