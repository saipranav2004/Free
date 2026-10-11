// pam-agent/internal/launcher/capabilities.go
//
// What this machine can actually open, reported to PAM so the console can
// answer "will Connect work?" BEFORE the operator clicks it.
package launcher

import (
	"log/slog"
	"runtime"
	"sort"

	"github.com/yourorg/pam-agent/internal/discovery"
)

// Capability is one resource type and whether this machine can open it.
//
// WHY THE SERVER NEEDS THIS AT ALL. Only the operator's own machine knows
// what is installed on it. Without it the console can offer "Open in desktop
// app" for a MongoDB resource to somebody with no mongosh and no Compass, and
// the first they hear of it is a launch that fails after the fact. The whole
// point is to say so beforehand, and to say WHICH tool to install.
type Capability struct {
	ResourceType string `json:"resource_type"`

	// Available is whether at least one candidate for this type was found.
	Available bool `json:"available"`

	// Tool is the candidate that would be used. Empty when nothing is
	// installed, in which case InstallHint describes the best option.
	Tool string `json:"tool,omitempty"`
	Kind string `json:"kind,omitempty"`

	// InstallHint is the first candidate's own guidance, so the console can
	// tell the operator what to install rather than only that something is
	// missing. Carried for the unavailable case only.
	InstallHint string `json:"install_hint,omitempty"`
}

// Inventory walks every resource type this agent knows about and reports what
// it can open, in a stable order so two reports from an unchanged machine are
// byte-identical and the server can skip a pointless write.
//
// A "browser" candidate counts as available: every machine has a browser. It
// is reported with its kind so the console can still distinguish "opens in
// your browser" from "opens a real client", which matters because only one of
// those can be recorded.
func Inventory(templates map[string][]Candidate, log *slog.Logger) []Capability {
	types := make([]string, 0, len(templates))
	for rt := range templates {
		types = append(types, rt)
	}
	sort.Strings(types)

	out := make([]Capability, 0, len(types))
	for _, rt := range types {
		cap := Capability{ResourceType: rt}
		for i := range templates[rt] {
			cand := &templates[rt][i]
			if cand.Kind == "browser" {
				cap.Available, cap.Tool, cap.Kind = true, cand.ID, cand.Kind
				break
			}
			if discovery.Locate(cand.Discovery).Found() {
				cap.Available, cap.Tool, cap.Kind = true, cand.ID, cand.Kind
				break
			}
			// Remember the FIRST candidate's hint: the list is in preference
			// order, so that is the one the operator should be pointed at.
			if cap.InstallHint == "" {
				cap.InstallHint = cand.InstallHint
			}
		}
		if cap.Available {
			cap.InstallHint = ""
		}
		out = append(out, cap)
	}
	if log != nil {
		available := 0
		for _, c := range out {
			if c.Available {
				available++
			}
		}
		log.Info("agent.capabilities.scanned", "os", runtime.GOOS, "types", len(out), "available", available)
	}
	return out
}
