// pam/internal/services/role_criticality_service.go
//
// ROLE CRITICALITY CLASSIFICATION
// ═══════════════════════════════
//
// What this answers: "if this role were compromised tomorrow, how bad is it?"
// Sorted, banded, and explained, so an administrator reviewing 40 roles knows
// which 3 to protect first instead of reading 40 policy documents.
//
// WHY IT IS SHAPED LIKE THIS
// ──────────────────────────
// Every mature identity governance product converges on the same structure,
// and this implementation follows it rather than inventing a private one:
//
//   - CyberArk ranks privileged accounts with an "Account Criticality Matrix"
//     built from three axes: the LEVEL OF PRIVILEGE granted (read-only through
//     to full administrative control, including the ability to modify other
//     identities' permissions), the BLAST RADIUS or scope of influence (one
//     service, several services, or every resource), and the EASE OF
//     COMPROMISE (what compensating controls stand in the way). The four
//     factors below are those axes, with escalation split out of privilege
//     because it behaves differently, see the next point.
//
//   - Microsoft Entra ID's privileged role guidance makes the point that a
//     role which can reset another identity's credentials or mint new ones is
//     functionally equivalent to Global Administrator, and therefore Tier 0,
//     no matter how narrow it looks on paper. That is why "can this role
//     escalate itself" is its own scored factor here rather than one more
//     verb in the privilege bucket.
//
//   - SailPoint classifies entitlements into privilege bands, and lets a
//     reviewer override the automatic result, with the override taking
//     precedence and suppressing further automatic reclassification. Classify
//     plus override plus audit is the contract implemented here.
//
//   - Saviynt's risk model is a weighted sum of factors against configurable
//     thresholds. The weights below are fixed rather than configurable,
//     because a scoring model nobody can explain is worse than a blunt one
//     everybody can, but they are named constants in one block so tuning them
//     is a one-line change with an obvious blast radius of its own.
//
// THE SCORE
// ─────────
// Four factors sum to 100 before mitigation:
//
//	Privilege        0..40   how dangerous the verbs it can call are
//	Blast radius     0..30   how much of the estate those verbs reach
//	Escalation       0..15   can it grant itself or others more power
//	Exposure         0..15   how many people hold it right now
//	                ------
//	                  100
//
// Compensating controls then SUBTRACT, floored at zero. This is CyberArk's
// ease-of-compromise axis: the same permissions behind a JIT gate and a forced
// recording are genuinely less dangerous than the same permissions standing
// open, and a model that ignores that punishes the installs that did the right
// thing.
//
// Bands are cut at 75 / 50 / 25. A role holding wildcard actions on wildcard
// resources scores 100 and lands Critical; a read-only role over a handful of
// resources lands Low.
//
// IMPORTANT, ON HONESTY: nothing here is stored or cached. The classification
// is recomputed from live rows on every call, so it cannot go stale behind a
// policy edit. Only the human override is persisted.
package services

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	// ErrCriticalityRoleNotFound is returned when the role id does not resolve.
	ErrCriticalityRoleNotFound = errors.New("role not found")
	// ErrInvalidBand is returned for an override band outside the four published values.
	ErrInvalidBand = errors.New("invalid criticality band")
	// ErrReasonRequired is returned when an override is submitted with no justification.
	ErrReasonRequired = errors.New("a reason is required to override a criticality classification")
	// ErrNoOverride is returned when clearing an override that is not there.
	ErrNoOverride = errors.New("this role has no criticality override to clear")
)

// ── Weights ────────────────────────────────────────────────────────────────
// One block, so retuning the model is one visible edit rather than a hunt
// through the file. The four maxima must sum to 100.

const (
	maxPrivilege   = 40
	maxBlastRadius = 30
	maxEscalation  = 15
	maxExposure    = 15

	// Band thresholds, inclusive lower bounds.
	thresholdCritical = 75
	thresholdHigh     = 50
	thresholdModerate = 25

	// Compensating controls, subtracted from the raw total.
	mitigationAllJIT      = 6
	mitigationAllRecorded = 4
	mitigationDenyPolicy  = 2
)

// actionRisk scores a single action on 0..10 by how much damage one successful
// call can do. The vocabulary is PAM's own (pam:<domain>:<Verb>), and every
// action the running system actually guards is listed explicitly rather than
// pattern-matched, because "Reveal" and "Read" differ by eight points and a
// regex that got that wrong would be invisible.
//
// Unknown actions, which is to say custom ones an operator wrote, fall back to
// verbRisk below.
var actionRisk = map[string]int{
	// Break glass is the emergency bypass. Nothing outranks it.
	"pam:breakglass:Use": 10,

	// Vault. Reveal hands over a live secret in plaintext, which is the single
	// most damaging call in the product; rotation can lock a fleet out.
	"pam:vault:Reveal": 10,
	"pam:vault:Rotate": 8,
	"pam:vault:Store":  7,
	"pam:vault:Create": 6,
	"pam:vault:Read":   3,
	"pam:vault:List":   2,

	// Sessions. Kill terminates somebody else's live connection; Connect and
	// Start open one in the caller's name.
	"pam:session:Kill":    7,
	"pam:session:Connect": 6,
	"pam:session:Start":   5,
	"pam:session:End":     3,
	"pam:session:List":    1,

	// Resources. Connect is the door itself.
	"pam:resource:Connect": 6,
	"pam:resource:Read":    1,
	"pam:resource:List":    1,

	// JIT. Requesting access is the designed, reviewed path, so it is low.
	"pam:jit:Request": 3,
	"pam:jit:Cancel":  2,

	// Audit and reporting. Verify touches the tamper-evidence chain.
	"pam:audit:Verify":    3,
	"pam:audit:Read":      2,
	"pam:report:Generate": 2,

	// Authentication. Every account can already do these.
	"pam:auth:Login":            1,
	"pam:auth:Logout":           1,
	"pam:auth:Me":               1,
	"pam:auth:MFAVerify":        1,
	"pam:auth:MFASetupInitiate": 1,
	"pam:auth:MFASetupVerify":   1,
}

// verbRisk is the fallback for actions outside the built-in vocabulary, keyed
// on the verb alone. Deliberately conservative: an unrecognised mutating verb
// scores as a mutation rather than as a read.
var verbRisk = map[string]int{
	"reveal": 9, "decrypt": 9, "export": 7, "rotate": 8, "delete": 7,
	"kill": 7, "revoke": 6, "approve": 6, "assign": 6, "attach": 6,
	"delegate": 8, "create": 5, "update": 5, "write": 5, "store": 5,
	"connect": 6, "start": 4, "end": 3, "request": 3, "cancel": 2,
	"generate": 2, "verify": 3, "list": 1, "read": 1, "get": 1, "describe": 1,
}

// escalatingActions are the calls that let a holder increase privilege, their
// own or somebody else's. Entra's Tier 0 reasoning: whoever can hand out
// credentials is equivalent to whoever already holds them.
var escalatingActions = map[string]bool{
	"pam:breakglass:Use": true,
	"pam:vault:Reveal":   true,
	"pam:vault:Rotate":   true,
}

// escalatingVerbs catches custom actions that grant or take away authority.
var escalatingVerbs = map[string]bool{
	"delegate": true, "assign": true, "attach": true, "grant": true,
	"impersonate": true, "reveal": true, "reset": true,
}

// ── Result shapes ──────────────────────────────────────────────────────────

// CriticalityFactor is one scored axis, carrying its own evidence. The UI
// renders these directly: a score with no explanation is a number people learn
// to ignore, so every factor states what it found and why that scored.
type CriticalityFactor struct {
	Key      string   `json:"key"`
	Label    string   `json:"label"`
	Score    int      `json:"score"`
	Max      int      `json:"max"`
	Summary  string   `json:"summary"`
	Evidence []string `json:"evidence"`
}

// CriticalityMitigation is a compensating control that reduced the score.
type CriticalityMitigation struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Points int    `json:"points"`
	Detail string `json:"detail"`
}

// RoleCriticality is the full classification for one role.
type RoleCriticality struct {
	RoleID   string `json:"role_id"`
	RoleName string `json:"role_name"`
	IsSystem bool   `json:"is_system"`

	// Band and Score are the published answer: the override when one is set,
	// the computed values otherwise.
	Band  models.CriticalityBand `json:"band"`
	Score int                    `json:"score"`
	Tier  int                    `json:"tier"`

	// ComputedBand and ComputedScore are always what the engine derived, so
	// the UI can show "engine says High, reviewer set Critical" side by side.
	ComputedBand  models.CriticalityBand `json:"computed_band"`
	ComputedScore int                    `json:"computed_score"`

	IsOverridden bool                            `json:"is_overridden"`
	Override     *models.RoleCriticalityOverride `json:"override,omitempty"`

	Factors     []CriticalityFactor     `json:"factors"`
	Mitigations []CriticalityMitigation `json:"mitigations"`

	// Counts an administrator wants without a second round trip.
	PolicyCount   int `json:"policy_count"`
	MemberCount   int `json:"member_count"`
	ResourceReach int `json:"resource_reach"`

	EvaluatedAt time.Time `json:"evaluated_at"`
}

// CriticalitySummary is the estate-wide roll-up behind the Roles page header.
type CriticalitySummary struct {
	Total       int               `json:"total"`
	ByBand      map[string]int    `json:"by_band"`
	Overridden  int               `json:"overridden"`
	Roles       []RoleCriticality `json:"roles"`
	EvaluatedAt time.Time         `json:"evaluated_at"`
}

// ── Service ────────────────────────────────────────────────────────────────

// RoleCriticalityService derives and stores role criticality classifications.
type RoleCriticalityService struct {
	db     *gorm.DB
	audit  *AuditService
	logger *zap.Logger
}

// NewRoleCriticalityService wires the service. audit may be nil in tests; every
// call site guards for it.
func NewRoleCriticalityService(db *gorm.DB, audit *AuditService, logger *zap.Logger) *RoleCriticalityService {
	return &RoleCriticalityService{db: db, audit: audit, logger: logger}
}

// Migrate creates the override table. Called once at startup, alongside the
// other additive tables, so this feature carries its own schema rather than
// editing the shared AutoMigrate list.
func (s *RoleCriticalityService) Migrate() error {
	return s.db.AutoMigrate(&models.RoleCriticalityOverride{})
}

// evaluationInput is everything the scorer needs, loaded once so scoring a
// whole estate of roles is a fixed number of queries rather than N per role.
type evaluationInput struct {
	resources      []models.PAMResource
	policyByRole   map[string][]models.Policy
	membersByRole  map[string]int
	overrideByRole map[string]models.RoleCriticalityOverride
	actionVocab    int
}

// load reads every row the scorer needs in one pass.
func (s *RoleCriticalityService) load(roleIDs []string) (*evaluationInput, error) {
	in := &evaluationInput{
		policyByRole:   map[string][]models.Policy{},
		membersByRole:  map[string]int{},
		overrideByRole: map[string]models.RoleCriticalityOverride{},
		actionVocab:    len(actionRisk),
	}

	// Active resources only. A soft-deleted or deactivated resource is not
	// reachable, so counting it would inflate every blast radius equally.
	if err := s.db.Where("is_active = ?", true).Find(&in.resources).Error; err != nil {
		return nil, fmt.Errorf("load resources: %w", err)
	}

	if len(roleIDs) == 0 {
		return in, nil
	}

	// Role to policy, through the join table, in one query.
	var links []models.RolePolicy
	if err := s.db.Where("role_id IN ?", roleIDs).Find(&links).Error; err != nil {
		return nil, fmt.Errorf("load role policies: %w", err)
	}
	policyIDs := make([]string, 0, len(links))
	seen := map[string]bool{}
	for _, l := range links {
		if !seen[l.PolicyID] {
			seen[l.PolicyID] = true
			policyIDs = append(policyIDs, l.PolicyID)
		}
	}
	policyByID := map[string]models.Policy{}
	if len(policyIDs) > 0 {
		var policies []models.Policy
		if err := s.db.Where("id IN ?", policyIDs).Find(&policies).Error; err != nil {
			return nil, fmt.Errorf("load policies: %w", err)
		}
		for _, p := range policies {
			policyByID[p.ID] = p
		}
	}
	for _, l := range links {
		if p, ok := policyByID[l.PolicyID]; ok {
			in.policyByRole[l.RoleID] = append(in.policyByRole[l.RoleID], p)
		}
	}

	// Holder counts.
	var holders []models.UserRole
	if err := s.db.Where("role_id IN ?", roleIDs).Find(&holders).Error; err != nil {
		return nil, fmt.Errorf("load role holders: %w", err)
	}
	for _, h := range holders {
		in.membersByRole[h.RoleID]++
	}

	// Standing overrides.
	var overrides []models.RoleCriticalityOverride
	if err := s.db.Where("role_id IN ?", roleIDs).Find(&overrides).Error; err != nil {
		return nil, fmt.Errorf("load criticality overrides: %w", err)
	}
	for _, o := range overrides {
		in.overrideByRole[o.RoleID] = o
	}

	return in, nil
}

// Get classifies a single role.
func (s *RoleCriticalityService) Get(roleID string) (*RoleCriticality, error) {
	var role models.Role
	if err := s.db.Where("id = ?", roleID).First(&role).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrCriticalityRoleNotFound
		}
		return nil, err
	}
	in, err := s.load([]string{role.ID})
	if err != nil {
		return nil, err
	}
	result := s.evaluate(role, in)
	return &result, nil
}

// Summary classifies every role, sorted most critical first. This is what the
// Roles list reads: one call, so the table can show a criticality column
// without firing a request per row.
func (s *RoleCriticalityService) Summary() (*CriticalitySummary, error) {
	var roles []models.Role
	if err := s.db.Order("name asc").Find(&roles).Error; err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(roles))
	for _, r := range roles {
		ids = append(ids, r.ID)
	}
	in, err := s.load(ids)
	if err != nil {
		return nil, err
	}

	out := &CriticalitySummary{
		Total: len(roles),
		ByBand: map[string]int{
			string(models.BandCritical): 0,
			string(models.BandHigh):     0,
			string(models.BandModerate): 0,
			string(models.BandLow):      0,
		},
		Roles:       make([]RoleCriticality, 0, len(roles)),
		EvaluatedAt: time.Now().UTC(),
	}
	for _, r := range roles {
		c := s.evaluate(r, in)
		out.ByBand[string(c.Band)]++
		if c.IsOverridden {
			out.Overridden++
		}
		out.Roles = append(out.Roles, c)
	}
	// Most critical first, then by score, then by name, so the ordering is
	// total and stable rather than dependent on map iteration.
	sort.SliceStable(out.Roles, func(i, j int) bool {
		a, b := out.Roles[i], out.Roles[j]
		if a.Tier != b.Tier {
			return a.Tier < b.Tier
		}
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		return a.RoleName < b.RoleName
	})
	return out, nil
}

// evaluate is the scorer. Pure with respect to the database: everything it
// reads comes from the preloaded input, so it is cheap to call in a loop and
// straightforward to reason about.
func (s *RoleCriticalityService) evaluate(role models.Role, in *evaluationInput) RoleCriticality {
	policies := in.policyByRole[role.ID]
	members := in.membersByRole[role.ID]

	// Only ALLOW policies grant anything. A deny policy cannot raise the
	// blast radius, and treating it as if it could would score the safest
	// roles in the install as the most dangerous ones.
	var allow, deny []models.Policy
	for _, p := range policies {
		if strings.EqualFold(p.Effect, string(models.PolicyEffectDeny)) {
			deny = append(deny, p)
			continue
		}
		allow = append(allow, p)
	}

	privilege, privFactor := scorePrivilege(allow)
	blast, blastFactor, reach, sensitiveReach, allJIT, allRecorded := scoreBlastRadius(allow, in.resources)
	escalation, escFactor := scoreEscalation(allow)
	exposure, expFactor := scoreExposure(members)

	raw := privilege + blast + escalation + exposure

	// Compensating controls. Only meaningful when the role actually reaches
	// something: a role that reaches nothing gets no credit for the estate's
	// JIT posture.
	mitigations := []CriticalityMitigation{}
	total := raw
	if reach > 0 && allJIT {
		mitigations = append(mitigations, CriticalityMitigation{
			Key:    "jit_gated",
			Label:  "Every reachable resource is JIT gated",
			Points: mitigationAllJIT,
			Detail: "No standing access. A holder still has to request and be granted time-boxed elevation before any of these resources will accept a connection.",
		})
		total -= mitigationAllJIT
	}
	if reach > 0 && allRecorded {
		mitigations = append(mitigations, CriticalityMitigation{
			Key:    "always_recorded",
			Label:  "Every reachable resource forces session recording",
			Points: mitigationAllRecorded,
			Detail: "Any session opened through this role is recorded, so misuse is reconstructable after the fact.",
		})
		total -= mitigationAllRecorded
	}
	if len(deny) > 0 {
		mitigations = append(mitigations, CriticalityMitigation{
			Key:    "deny_policy",
			Label:  fmt.Sprintf("%d deny %s attached", len(deny), plural(len(deny), "policy", "policies")),
			Points: mitigationDenyPolicy,
			Detail: "Deny beats allow at evaluation time, so these carve holes out of the reach scored above.",
		})
		total -= mitigationDenyPolicy
	}
	if total < 0 {
		total = 0
	}
	if total > 100 {
		total = 100
	}

	computedBand := bandForScore(total)

	result := RoleCriticality{
		RoleID:        role.ID,
		RoleName:      role.Name,
		IsSystem:      role.IsSystem,
		Band:          computedBand,
		Score:         total,
		Tier:          computedBand.Tier(),
		ComputedBand:  computedBand,
		ComputedScore: total,
		Factors:       []CriticalityFactor{privFactor, blastFactor, escFactor, expFactor},
		Mitigations:   mitigations,
		PolicyCount:   len(policies),
		MemberCount:   members,
		ResourceReach: reach,
		EvaluatedAt:   time.Now().UTC(),
	}
	_ = sensitiveReach

	// A standing override replaces the published band, and says so. The
	// computed values stay on the record so a reviewer can see exactly what
	// they are overriding.
	if o, ok := in.overrideByRole[role.ID]; ok {
		band := models.CriticalityBand(o.Band)
		if band.Valid() {
			override := o
			result.Band = band
			result.Tier = band.Tier()
			result.IsOverridden = true
			result.Override = &override
			// The published score follows the published band to the middle of
			// its range, so sorting by score and sorting by band cannot
			// disagree on an overridden row.
			result.Score = representativeScore(band)
		}
	}

	return result
}

// scorePrivilege rates the most dangerous verb the role can call, and how many
// distinct dangerous verbs it holds. Peak dominates breadth on purpose: one
// pam:vault:Reveal is worse than twelve read-only actions.
func scorePrivilege(allow []models.Policy) (int, CriticalityFactor) {
	f := CriticalityFactor{Key: "privilege", Label: "Privilege level", Max: maxPrivilege}

	if len(allow) == 0 {
		f.Summary = "Grants nothing. No allow policy is attached to this role."
		return 0, f
	}

	actions := map[string]bool{}
	wildcard := false
	for _, p := range allow {
		for _, a := range p.Actions {
			a = strings.TrimSpace(a)
			if a == "" {
				continue
			}
			if a == "*" {
				wildcard = true
			}
			actions[a] = true
		}
	}

	if wildcard {
		f.Score = maxPrivilege
		f.Summary = "Unrestricted. A wildcard action grant lets this role call every operation the API exposes, including credential reveal and break glass."
		f.Evidence = append(f.Evidence, "Allows action \"*\" (every action)")
		return maxPrivilege, f
	}

	peak := 0
	peakAction := ""
	weighted := 0
	for a := range actions {
		r := riskOfAction(a)
		weighted += r
		if r > peak {
			peak, peakAction = r, a
		}
	}

	// Peak carries 30 of the 40, breadth the remaining 10.
	peakPart := peak * 30 / 10
	breadthPart := 0
	if len(actionRisk) > 0 {
		breadthPart = len(actions) * 10 / len(actionRisk)
	}
	if breadthPart > 10 {
		breadthPart = 10
	}
	score := clamp(peakPart+breadthPart, 0, maxPrivilege)

	f.Score = score
	f.Summary = fmt.Sprintf("%d distinct %s. The most dangerous is %s.",
		len(actions), plural(len(actions), "action", "actions"), peakAction)

	// Name the handful that actually drove the score, highest first, rather
	// than dumping every action on the reviewer.
	type ar struct {
		a string
		r int
	}
	ranked := make([]ar, 0, len(actions))
	for a := range actions {
		ranked = append(ranked, ar{a, riskOfAction(a)})
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].r != ranked[j].r {
			return ranked[i].r > ranked[j].r
		}
		return ranked[i].a < ranked[j].a
	})
	for i, x := range ranked {
		if i >= 4 || x.r < 5 {
			break
		}
		f.Evidence = append(f.Evidence, fmt.Sprintf("%s (risk %d of 10)", x.a, x.r))
	}
	if len(f.Evidence) == 0 {
		f.Evidence = append(f.Evidence, "Read-mostly. No action on this role scores above 4 of 10.")
	}
	return score, f
}

// scoreBlastRadius rates how much of the estate the role's allow policies
// match. Returns the score, the factor, the number of resources reached, how
// many of those are marked sensitive, and whether every reached resource is
// JIT gated / always recorded.
func scoreBlastRadius(allow []models.Policy, resources []models.PAMResource) (int, CriticalityFactor, int, int, bool, bool) {
	f := CriticalityFactor{Key: "blast_radius", Label: "Blast radius", Max: maxBlastRadius}
	total := len(resources)

	patterns := map[string]bool{}
	wildcard := false
	for _, p := range allow {
		for _, r := range p.Resources {
			r = strings.TrimSpace(r)
			if r == "" {
				continue
			}
			if r == "*" {
				wildcard = true
			}
			patterns[r] = true
		}
	}

	if len(patterns) == 0 {
		f.Summary = "Reaches nothing. No allow policy on this role names a resource."
		return 0, f, 0, 0, false, false
	}

	if wildcard {
		f.Score = maxBlastRadius
		f.Summary = fmt.Sprintf("Every resource in the estate, all %d of them, plus anything added later.", total)
		f.Evidence = append(f.Evidence, "Allows resource \"*\" (every resource, present and future)")
		// A wildcard grant cannot be mitigated by the current estate's
		// posture, because it also covers resources that do not exist yet.
		return maxBlastRadius, f, total, countSensitive(resources), false, false
	}

	matched := make([]models.PAMResource, 0, total)
	for _, res := range resources {
		for pat := range patterns {
			if matchesResource(pat, res) {
				matched = append(matched, res)
				break
			}
		}
	}
	reach := len(matched)
	if reach == 0 {
		f.Summary = fmt.Sprintf("Names %d resource %s, none of which match an active resource today.",
			len(patterns), plural(len(patterns), "pattern", "patterns"))
		return 0, f, 0, 0, false, false
	}

	sensitive := countSensitive(matched)

	// Breadth carries 20 of the 30, concentration of sensitive resources the
	// other 10: reaching three production databases beats reaching thirty
	// dev boxes.
	breadth := 0
	if total > 0 {
		breadth = reach * 20 / total
	}
	sensitivePart := 0
	if reach > 0 {
		sensitivePart = sensitive * 10 / reach
	}
	score := clamp(breadth+sensitivePart, 0, maxBlastRadius)

	allJIT, allRecorded := true, true
	for _, m := range matched {
		if !m.RequiresJIT {
			allJIT = false
		}
		if !m.AlwaysRecord {
			allRecorded = false
		}
	}

	f.Score = score
	f.Summary = fmt.Sprintf("%d of %d active %s, %d of which %s marked sensitive.",
		reach, total, plural(total, "resource", "resources"), sensitive, plural(sensitive, "is", "are"))
	for i, m := range matched {
		if i >= 4 {
			f.Evidence = append(f.Evidence, fmt.Sprintf("and %d more", reach-i))
			break
		}
		tag := ""
		switch {
		case m.RequiresJIT && m.AlwaysRecord:
			tag = " (JIT gated, always recorded)"
		case m.RequiresJIT:
			tag = " (JIT gated)"
		case m.AlwaysRecord:
			tag = " (always recorded)"
		}
		f.Evidence = append(f.Evidence, m.Name+tag)
	}
	return score, f, reach, sensitive, allJIT, allRecorded
}

// scoreEscalation asks whether the role can increase privilege. A role that
// can hand out or read the credentials behind other roles is, in practice, as
// privileged as the most privileged thing it can reach.
func scoreEscalation(allow []models.Policy) (int, CriticalityFactor) {
	f := CriticalityFactor{Key: "escalation", Label: "Escalation path", Max: maxEscalation}

	hits := map[string]bool{}
	wildcard := false
	for _, p := range allow {
		for _, a := range p.Actions {
			a = strings.TrimSpace(a)
			if a == "*" {
				wildcard = true
				continue
			}
			if escalatingActions[a] || escalatingVerbs[strings.ToLower(verbOf(a))] {
				hits[a] = true
			}
		}
	}

	if wildcard {
		f.Score = maxEscalation
		f.Summary = "Can grant itself anything. A wildcard action grant includes every permission-changing call in the product."
		f.Evidence = append(f.Evidence, "Allows action \"*\"")
		return maxEscalation, f
	}
	if len(hits) == 0 {
		f.Summary = "No escalation path. Nothing this role can call hands out credentials or authority."
		return 0, f
	}

	// One escalating call already changes the risk category; further ones add
	// less. Ramp rather than multiply.
	score := clamp(6+3*(len(hits)-1), 0, maxEscalation)
	names := make([]string, 0, len(hits))
	for a := range hits {
		names = append(names, a)
	}
	sort.Strings(names)
	f.Score = score
	f.Summary = fmt.Sprintf("Holds %d %s that can hand out or expose credentials.",
		len(hits), plural(len(hits), "call", "calls"))
	f.Evidence = names
	return score, f
}

// scoreExposure rates how many people hold the role right now. Same
// permissions in more hands is a wider attack surface, and an unheld role is a
// latent risk rather than a live one.
func scoreExposure(members int) (int, CriticalityFactor) {
	f := CriticalityFactor{Key: "exposure", Label: "Standing exposure", Max: maxExposure}

	var score int
	var summary string
	switch {
	case members == 0:
		score = 0
		summary = "Held by nobody. The grant is latent: it carries no live exposure until somebody is assigned it."
	case members <= 2:
		score = 5
		summary = fmt.Sprintf("Held by %d %s.", members, plural(members, "account", "accounts"))
	case members <= 5:
		score = 9
		summary = fmt.Sprintf("Held by %d accounts.", members)
	case members <= 10:
		score = 12
		summary = fmt.Sprintf("Held by %d accounts, which is wide for a privileged grant.", members)
	default:
		score = maxExposure
		summary = fmt.Sprintf("Held by %d accounts. At this width the role is effectively standing access for a whole team.", members)
	}
	f.Score = score
	f.Summary = summary
	return score, f
}

// ── Override lifecycle ─────────────────────────────────────────────────────

// SetOverrideInput carries a reviewer's explicit classification.
type SetOverrideInput struct {
	RoleID    string
	Band      string
	Reason    string
	ActorID   string
	ActorName string
}

// SetOverride records a manual classification for a role. The override wins
// over the computed band until it is cleared, and the decision is written to
// the audit trail with the reason attached.
func (s *RoleCriticalityService) SetOverride(ctx context.Context, in SetOverrideInput) (*RoleCriticality, error) {
	band := models.CriticalityBand(strings.ToUpper(strings.TrimSpace(in.Band)))
	if !band.Valid() {
		return nil, ErrInvalidBand
	}
	if strings.TrimSpace(in.Reason) == "" {
		return nil, ErrReasonRequired
	}

	var role models.Role
	if err := s.db.Where("id = ?", in.RoleID).First(&role).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrCriticalityRoleNotFound
		}
		return nil, err
	}

	// What the engine says right now, captured before the override lands, so
	// the audit record shows what was overridden and not just what to.
	before, err := s.Get(role.ID)
	if err != nil {
		return nil, err
	}

	row := models.RoleCriticalityOverride{
		RoleID:        role.ID,
		Band:          string(band),
		Reason:        strings.TrimSpace(in.Reason),
		SetBy:         in.ActorID,
		SetByUsername: in.ActorName,
	}
	// Upsert: re-classifying a role that already carries an override replaces
	// it rather than failing, which is what a reviewer changing their mind
	// expects.
	var existing models.RoleCriticalityOverride
	err = s.db.Where("role_id = ?", role.ID).First(&existing).Error
	switch {
	case err == nil:
		if err := s.db.Model(&existing).Updates(map[string]interface{}{
			"band":            row.Band,
			"reason":          row.Reason,
			"set_by":          row.SetBy,
			"set_by_username": row.SetByUsername,
		}).Error; err != nil {
			return nil, err
		}
	case errors.Is(err, gorm.ErrRecordNotFound):
		if err := s.db.Create(&row).Error; err != nil {
			return nil, err
		}
	default:
		return nil, err
	}

	s.writeAudit(ctx, in.ActorID, in.ActorName, "pam.rbac.criticality.override.set", role, map[string]interface{}{
		"band":           string(band),
		"computed_band":  string(before.ComputedBand),
		"computed_score": before.ComputedScore,
		"reason":         row.Reason,
	})

	return s.Get(role.ID)
}

// ClearOverride removes a manual classification, returning the role to whatever
// the engine derives.
func (s *RoleCriticalityService) ClearOverride(ctx context.Context, roleID, actorID, actorName, reason string) (*RoleCriticality, error) {
	var role models.Role
	if err := s.db.Where("id = ?", roleID).First(&role).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrCriticalityRoleNotFound
		}
		return nil, err
	}

	var existing models.RoleCriticalityOverride
	if err := s.db.Where("role_id = ?", roleID).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrNoOverride
		}
		return nil, err
	}
	// Hard delete: the standing override is a current-state row, and its
	// history lives in the audit trail rather than in a tombstone here.
	if err := s.db.Unscoped().Delete(&existing).Error; err != nil {
		return nil, err
	}

	s.writeAudit(ctx, actorID, actorName, "pam.rbac.criticality.override.cleared", role, map[string]interface{}{
		"previous_band": existing.Band,
		"reason":        strings.TrimSpace(reason),
	})

	return s.Get(roleID)
}

func (s *RoleCriticalityService) writeAudit(ctx context.Context, actorID, actorName, action string, role models.Role, details map[string]interface{}) {
	if s.audit == nil {
		return
	}
	_, err := s.audit.Append(ctx, AuditEntry{
		ActorUserID:   actorID,
		ActorUsername: actorName,
		ActorType:     "USER",
		Action:        action,
		Outcome:       models.AuditOutcomeSuccess,
		Severity:      "WARN",
		ResourceType:  "ROLE",
		ResourceID:    role.ID,
		ResourceName:  role.Name,
		Details:       details,
	})
	if err != nil && s.logger != nil {
		s.logger.Error("rbac.criticality.audit.fail", zap.String("action", action), zap.Error(err))
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

func riskOfAction(a string) int {
	if r, ok := actionRisk[a]; ok {
		return r
	}
	if r, ok := verbRisk[strings.ToLower(verbOf(a))]; ok {
		return r
	}
	// An action nobody recognises is assumed to mutate something. Guessing
	// low here is how a custom admin action scores as read-only.
	return 5
}

// verbOf pulls the trailing segment off a pam:<domain>:<Verb> action.
func verbOf(a string) string {
	if i := strings.LastIndex(a, ":"); i >= 0 && i+1 < len(a) {
		return a[i+1:]
	}
	return a
}

// matchesResource decides whether a policy resource pattern covers a resource.
//
// The canonical resource string this system authorises against is
// "pam:resource/<id>", which is what middleware.RequirePermission builds (see
// cmd/pam-api/main.go), and the policy engine matches patterns against it with
// a single trailing wildcard (opa/engine.go, matchOne). This mirrors that, and
// additionally accepts the shorter forms an operator is likely to write by
// hand:
//
//	pam:resource/*              every resource, the canonical wildcard
//	pam:resource/res-01         one resource by id, canonical
//	resource:postgres-*         a namespaced prefix match
//	res-01                      a bare id
//	postgres-payments-prod-01   a bare name, case insensitive
//	type:postgres               every resource of one type
//
// A pattern in some other namespace, "safe:prod/*" for instance, names
// something that is not a PAM resource and correctly matches nothing here.
func matchesResource(pattern string, r models.PAMResource) bool {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return false
	}
	if pattern == "*" {
		return true
	}

	// Resource-type selector, before any namespace stripping so that a type
	// name containing a slash cannot be misread as a namespace.
	if lower := strings.ToLower(pattern); strings.HasPrefix(lower, "type:") {
		return strings.EqualFold(strings.TrimSpace(pattern[len("type:"):]), r.ResourceType)
	}

	// Strip a resource namespace if one is present. Anything left in another
	// namespace is not addressing a PAM resource at all.
	body := pattern
	switch {
	case strings.HasPrefix(body, "pam:resource/"):
		body = strings.TrimPrefix(body, "pam:resource/")
	case strings.HasPrefix(body, "resource:"):
		body = strings.TrimPrefix(body, "resource:")
	case strings.HasPrefix(body, "resource/"):
		body = strings.TrimPrefix(body, "resource/")
	case strings.Contains(body, ":"), strings.Contains(body, "/"):
		// A different namespace, for example "safe:prod/*".
		return false
	}
	if body == "" {
		return false
	}
	if body == "*" {
		return true
	}

	if strings.HasSuffix(body, "*") {
		prefix := strings.TrimSuffix(body, "*")
		return strings.HasPrefix(r.ID, prefix) ||
			strings.HasPrefix(strings.ToLower(r.Name), strings.ToLower(prefix))
	}
	return body == r.ID || strings.EqualFold(body, r.Name)
}

// countSensitive counts resources the operator has already marked as needing
// extra handling. These are the install's own declarations, not a guess: a
// resource behind JIT or forced recording is one somebody decided was worth
// protecting.
func countSensitive(rs []models.PAMResource) int {
	n := 0
	for _, r := range rs {
		if r.RequiresJIT || r.AlwaysRecord {
			n++
		}
	}
	return n
}

func bandForScore(score int) models.CriticalityBand {
	switch {
	case score >= thresholdCritical:
		return models.BandCritical
	case score >= thresholdHigh:
		return models.BandHigh
	case score >= thresholdModerate:
		return models.BandModerate
	default:
		return models.BandLow
	}
}

// representativeScore places an overridden role at the middle of its band, so
// a table sorted by score and a table grouped by band agree with each other.
func representativeScore(b models.CriticalityBand) int {
	switch b {
	case models.BandCritical:
		return 88
	case models.BandHigh:
		return 62
	case models.BandModerate:
		return 37
	default:
		return 12
	}
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
