// pam/internal/models/data_protection.go
//
// Data-protection policy: the controls that limit what an operator can take
// OUT of a privileged session, as opposed to whether they may open one.
//
// A deliberate framing note, because it governs every decision in here and in
// internal/webproxy/dlp.go. "The operator cannot copy anything" is not
// achievable and this type does not pretend to deliver it — a phone camera
// defeats every client-side control ever shipped. What it delivers is three
// separable things:
//
//  1. Bulk egress prevention   — server-side, genuinely unbypassable
//  2. Friction on casual copy  — client-side, deliberately defeatable
//  3. Attribution              — watermark + audit, so attempts are visible
//     and a leaked screenshot names one person
//
// Only (1) survives a determined insider. (2) is what a client SEES, and it
// is important not to confuse the two when describing this feature: a control
// advertised as prevention but implemented as friction is how an audit gets
// failed.
//
// Enforceability is not uniform across connect methods, and it is not a
// matter of effort. PAM sits in the data path for the in-browser terminal
// (it dials the target itself) and for the brokered web proxy (every byte is
// proxied), so server-side controls there are real. The native agent receives
// the plaintext credential and connects DIRECT to the target — PAM never sees
// that traffic, so no control here can bind it. A resource that genuinely
// requires egress control must therefore be restricted to the brokered paths;
// see AllowedConnectMethods.
package models

import "strings"

// Connect methods, matching the three entry points in cmd/pam-api/main.go.
const (
	ConnectMethodWebTerminal = "web_terminal" // internal/gateway  — PAM in path
	ConnectMethodWebProxy    = "web_proxy"    // internal/webproxy — PAM in path
	ConnectMethodAgent       = "agent"        // pam-agent         — PAM NOT in path
)

// DataProtection is the effective egress policy for one session. Resolved
// once at session start from the resource and the grant, then snapshotted
// onto the session row: a grant expiring mid-session must not silently
// relax the controls the session was opened under, and per-request
// enforcement must not depend on a grant lookup it would have to repeat
// thousands of times.
type DataProtection struct {
	// BlockClipboard suppresses copy/cut/context-menu/selection in the
	// brokered browser paths. FRICTION, not prevention — devtools defeats
	// it, and it is reported as an audited attempt rather than assumed to
	// have worked.
	BlockClipboard bool `json:"block_clipboard"`

	// BlockDevTools injects the browser DevTools deterrent into brokered
	// pages: shortcut suppression (F12, Ctrl/Cmd+Shift+I/J/C/K, Ctrl+U) on top
	// of the clipboard set, plus detection that blanks the page while a panel
	// is open and reports it.
	//
	// FRICTION AND ATTRIBUTION, exactly like BlockClipboard, and for the same
	// reason: DevTools is the debugger and the page is the debuggee, so it can
	// disable JavaScript or open before the page loads. It also cannot empty
	// the Network panel, which records below the page entirely. What actually
	// protects a brokered session is that the target's own session cookie is
	// captured server-side and stripped from the response.
	//
	// Kept separate from BlockClipboard rather than folded into it because the
	// two have different costs. Clipboard blocking is invisible until someone
	// tries to copy; this one blanks the page on a heuristic, so an
	// administrator must be able to protect a resource from copying without
	// accepting that risk on a console their team uses all day.
	BlockDevTools bool `json:"block_devtools"`

	// BlockDownload refuses proxied responses that exist to move a file to
	// the operator's disk (Content-Disposition: attachment, archive and
	// octet-stream bodies). PREVENTION: server-side, in the data path.
	BlockDownload bool `json:"block_download"`

	// Watermark overlays operator identity, session id and UTC time on
	// proxied pages. ATTRIBUTION: the only control that meaningfully
	// discourages photographing the screen, because it makes the resulting
	// image trace back to one named person.
	Watermark bool `json:"watermark"`

	// DeniedCommands is a comma-separated list of bulk-extraction patterns
	// refused in a terminal session — COPY, pg_dump, mongoexport and the like.
	// PREVENTION on the paths PAM relays, matched at token boundaries so an
	// ordinary query that merely mentions one of these words still runs.
	//
	// Empty means "use the built-in list for this resource type" rather than
	// "allow everything", so enabling command blocking does not require an
	// administrator to know every dump verb for every tool.
	DeniedCommands string `json:"denied_commands"`

	// MaxEgressBytes caps the total response volume one session may pull.
	// PREVENTION, and the single most useful control here: it bounds the
	// worst case regardless of which endpoint or technique is used. Zero
	// means unlimited.
	MaxEgressBytes int64 `json:"max_egress_bytes"`
}

// Any reports whether any control is active, so callers can skip the whole
// enforcement path (and its injected assets) for an unrestricted session.
func (d DataProtection) Any() bool {
	return d.BlockClipboard || d.BlockDevTools || d.BlockDownload || d.Watermark ||
		d.MaxEgressBytes > 0 || d.DeniedCommands != ""
}

// DeniedCommandList splits the stored patterns for an enforcer.
func (d DataProtection) DeniedCommandList() []string {
	raw := strings.Split(d.DeniedCommands, ",")
	out := make([]string, 0, len(raw))
	for _, p := range raw {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// MostRestrictive combines a resource-level and a grant-level policy. Every
// control ratchets one way only: a grant may tighten what a resource allows
// and never loosen it, which is what makes it safe to hand grant authorship
// to approvers who are not resource owners.
//
// Mirrors how the recording obligation already composes
// (grant.RecordingRequired || resource.AlwaysRecord) rather than introducing
// a second, differently-shaped precedence rule for the same kind of decision.
func MostRestrictive(resource, grant DataProtection) DataProtection {
	out := DataProtection{
		BlockClipboard: resource.BlockClipboard || grant.BlockClipboard,
		BlockDevTools:  resource.BlockDevTools || grant.BlockDevTools,
		BlockDownload:  resource.BlockDownload || grant.BlockDownload,
		Watermark:      resource.Watermark || grant.Watermark,
		MaxEgressBytes: resource.MaxEgressBytes,
		// Concatenated rather than overridden: a grant may add patterns to the
		// resource's list but cannot shorten it, which is the same
		// tighten-only rule every other control here follows.
		DeniedCommands: joinPatterns(resource.DeniedCommands, grant.DeniedCommands),
	}
	// Zero means "no cap", so it must lose to any real limit rather than
	// winning as the numerically smaller value.
	switch {
	case out.MaxEgressBytes == 0:
		out.MaxEgressBytes = grant.MaxEgressBytes
	case grant.MaxEgressBytes > 0 && grant.MaxEgressBytes < out.MaxEgressBytes:
		out.MaxEgressBytes = grant.MaxEgressBytes
	}
	return out
}

// ParseConnectMethods reads the resource's stored allow-list. An empty or
// absent value means every method is permitted, so existing resources keep
// behaving exactly as they did before this policy existed.
func ParseConnectMethods(csv string) []string {
	csv = strings.TrimSpace(csv)
	if csv == "" {
		return nil
	}
	parts := strings.Split(csv, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.ToLower(strings.TrimSpace(p)); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// ConnectMethodAllowed reports whether a method may be used for a resource.
//
// Fails OPEN on an empty list, which is the correct default for a field being
// introduced to a populated table — but note the asymmetry that follows: a
// resource is only genuinely egress-controlled once this list excludes
// ConnectMethodAgent, because that path takes the data outside PAM's reach
// entirely. Enforcing clipboard and download controls on a resource that
// still permits the agent is a control an operator bypasses by clicking a
// different connect button.
func ConnectMethodAllowed(csv, method string) bool {
	allowed := ParseConnectMethods(csv)
	if len(allowed) == 0 {
		return true
	}
	for _, a := range allowed {
		if a == method {
			return true
		}
	}
	return false
}

// EgressControlled reports whether a resource's policy is actually
// enforceable end to end: it has a control worth enforcing AND it has closed
// the connect path PAM cannot see. Surfaced so an admin UI can show the
// difference between a resource that is protected and one that merely looks
// protected — the distinction a client will otherwise assume in their favour.
func EgressControlled(csv string, d DataProtection) bool {
	return d.Any() && !ConnectMethodAllowed(csv, ConnectMethodAgent)
}

// joinPatterns merges two comma-separated pattern lists, de-duplicated.
func joinPatterns(a, b string) string {
	seen := map[string]bool{}
	out := make([]string, 0, 8)
	for _, list := range []string{a, b} {
		for _, p := range strings.Split(list, ",") {
			v := strings.TrimSpace(p)
			if v == "" || seen[strings.ToLower(v)] {
				continue
			}
			seen[strings.ToLower(v)] = true
			out = append(out, v)
		}
	}
	return strings.Join(out, ",")
}

// defaultDeniedCommands is the built-in bulk-extraction deny list per resource
// type, used when a resource enables command blocking without naming its own
// patterns.
//
// Deliberately short. Every entry costs an operator some legitimate
// capability, so the list holds only commands whose primary purpose is moving
// a whole table or bucket somewhere PAM cannot see. A resource that needs more
// sets its own list; one that needs fewer overrides with a narrower one.
var defaultDeniedCommands = map[string][]string{
	"postgresql": {`\copy`, "copy", "pg_dump", `\o`, `\out`},
	"mysql":      {"mysqldump", "into outfile", "into dumpfile"},
	"mongodb":    {"mongoexport", "mongodump"},
	"redis":      {"save", "bgsave", "debug reload"},
	"minio":      {"mirror"},
	"ssh":        {"tar", "scp", "base64", "dd"},
}

// DefaultDeniedCommands returns the built-in patterns for a resource type, or
// nil when there is no sensible default — an unknown type gets no deny list
// rather than someone else's, because guessing here would block real work.
func DefaultDeniedCommands(resourceType string) []string {
	return defaultDeniedCommands[strings.ToLower(strings.TrimSpace(resourceType))]
}
