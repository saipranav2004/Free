// pam/internal/webproxy/devtools.go
//
// Injection of the DevTools deterrent into brokered pages.
//
// Read dlp.go's header first. This control belongs squarely in its second
// group — FRICTION + ATTRIBUTION, defeatable by design — and nothing here
// should ever be described as prevention. The asset's own header says the same
// thing at length; this file is only the plumbing that gets it onto the page.
//
// ── Why inline rather than an external script ─────────────────────────────
//
// replay.js is served from /__pam/replay.js because it is 260KB and benefits
// from being cached. This one is 14KB and must run BEFORE the operator can
// interact with the page, so a second round trip is exactly the wrong trade.
// Inline also reuses the CSP path that already works: csp.go rewrites the
// target's policy to admit one nonce, and MinIO Console — the case that
// motivated all of this — ships `script-src 'self' https://unpkg.com` with no
// 'unsafe-inline', so without that nonce nothing PAM injects runs at all.
//
// ── Why the JS lives in a .js file ────────────────────────────────────────
//
// go:embed rather than a Go string literal so the asset stays lintable,
// syntax-checkable and readable as JavaScript. A 400-line guard hidden inside
// a backtick string is how a stray backtick becomes a production outage.
package webproxy

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed assets/devtools-guard.js
var devtoolsGuardJS []byte

// devtoolsGuardConfig is written to window.__PAM_DEVTOOLS_GUARD immediately
// before the guard runs.
//
// Marshalled through encoding/json rather than string-concatenated so a value
// can never break out of the script context. Nothing here is operator-supplied
// today, but a config injector that is only safe because of what it currently
// happens to carry is one field away from being an XSS.
type devtoolsGuardConfig struct {
	Report             string `json:"report"`
	DockedDeltaPx      int    `json:"dockedDeltaPx"`
	DebuggerPauseMs    int    `json:"debuggerPauseMs"`
	CheckIntervalMs    int    `json:"checkIntervalMs"`
	RecoveryIntervalMs int    `json:"recoveryIntervalMs"`
	ConfirmTicks       int    `json:"confirmTicks"`
}

// Tuning, kept here so the two guards (this one and the console's) can be read
// side by side and confirmed identical.
//
// confirmTicks is the setting that keeps this from becoming an outage: a
// signal must hold for two consecutive checks before the page is blocked, so a
// single transient reading during a window drag cannot wipe a live session on
// somebody's production database console.
var defaultDevtoolsGuardConfig = devtoolsGuardConfig{
	Report:             violationPath,
	DockedDeltaPx:      160,
	DebuggerPauseMs:    100,
	CheckIntervalMs:    1000,
	RecoveryIntervalMs: 2000,
	ConfirmTicks:       2,
}

// devtoolsGuardScriptTag returns the config assignment and the guard, as two
// tags sharing the response's CSP nonce.
//
// Two tags rather than one concatenated blob because the config must be a
// complete statement before the guard's IIFE reads it, and because a failure to
// marshal the config should degrade to the guard's own defaults rather than
// emitting a half-written script.
func devtoolsGuardScriptTag(nonce string) []byte {
	out := make([]byte, 0, len(devtoolsGuardJS)+256)

	if raw, err := json.Marshal(defaultDevtoolsGuardConfig); err == nil {
		out = append(out, scriptTag(fmt.Sprintf("window.__PAM_DEVTOOLS_GUARD=%s;", raw), nonce)...)
	}

	out = append(out, scriptTag(string(devtoolsGuardJS), nonce)...)
	return out
}
