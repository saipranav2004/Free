// pam/internal/services/role_criticality_service.go
//
// ROLE CRITICALITY CLASSIFICATION
// ═══════════════════════════════
//
// What this answers: "if this role were compromised tomorrow, how bad is it?"
// Ranked, banded, and explained, so an administrator reviewing 40 roles knows
// which 3 to protect first instead of reading 40 policy documents.
//
// WHY IT IS SHAPED LIKE THIS
// ──────────────────────────
// Every mature identity governance product converges on the same structure,
// and this implementation follows it rather than inventing a private one:
//
//   - CyberArk ranks privileged accounts with an "Account Criticality Matrix"
//     built from the LEVEL OF PRIVILEGE granted, the BLAST RADIUS or scope of
//     influence, and the EASE OF COMPROMISE (what compensating controls stand
//     in the way). Those are the scored axes here, with escalation split out
//     of privilege because it behaves differently, see the next point.
//
//   - Microsoft Entra ID's privileged role guidance makes the point that a
//     role which can reset another identity's credentials or mint new ones is
//     functionally equivalent to Global Administrator, and therefore Tier 0,
//     no matter how narrow it looks on paper. That is why "can this role
//     escalate itself" is its own scored factor rather than one more verb.
//
//   - SailPoint classifies entitlements into privilege bands and lets a
//     reviewer override the automatic result, with the override taking
//     precedence and suppressing further automatic reclassification. Classify
//     plus override plus audit is the contract implemented here.
//
//   - Saviynt's risk model is a weighted sum of factors against thresholds.
//     The weights here are fixed rather than configurable, but they sit in one
//     named block so retuning is a single visible edit, and ModelVersion
//     records which tuning produced a given classification.
//
// CRITICALITY IS INTRINSIC. EXPOSURE IS CONTEXTUAL. THEY ARE SCORED APART.
// ────────────────────────────────────────────────────────────────────────
// This is the correction that matters most, and it follows SailPoint, which
// keeps entitlement PRIVILEGE CLASSIFICATION (an intrinsic property of the
// entitlement) separate from an IDENTITY RISK SCORE (contextual, per user).
// FIPS 199 categorises the same way: by the POTENTIAL IMPACT of a compromise,
// which is a property of the thing, not of how many people currently touch it.
//
// A role granting wildcard access is exactly as dangerous whether nobody holds
// it or forty people do. Folding holder count into the criticality number made
// the classification move for reasons that have nothing to do with how
// dangerous the role is. So:
//
//	CRITICALITY (0..100)   what this role could do if compromised
//	  Privilege      0..45   how dangerous the verbs it can call are
//	  Blast radius   0..35   how much of the estate those verbs reach
//	  Escalation     0..20   can it grant itself or others more power
//	  minus compensating controls (JIT, forced recording, deny policies)
//
//	EXPOSURE (0..100)      how much live surface that danger currently has
//	  Holders        0..60   how many accounts hold it right now
//	  Recent use     0..40   whether the permissions are actually exercised
//
// Only CRITICALITY is banded. Exposure is reported beside it, because the two
// answer different questions and averaging them would hide both.
//
// USAGE, AND WHY IT IS HERE
// ─────────────────────────
// The dominant signal in modern access governance is whether a grant is
// actually used. AWS built IAM Access Analyzer's unused-access findings around
// exactly this, and the common governance rule is that a permission untouched
// for 90 days should be reviewed. A role that can reveal every credential in
// the estate but has not been exercised in six months is a different problem
// from one used daily, and the previous model could not tell them apart.
//
// Usage is derived from the audit trail: the most recent SUCCESS by any holder
// of an action this role grants. It is an approximation and says so, because
// when a user holds the same permission through two roles the trail cannot
// attribute the call to one of them. AWS's own last-accessed data carries the
// same caveat. An approximation that is labelled is useful; one presented as
// exact is not.
//
// ON THE ARITHMETIC, HONESTLY
// ───────────────────────────
// Adding weighted ordinal scores is not a measurement. Hubbard and Evans
// ("Problems with Scoring Methods and Ordinal Scales in Risk Assessment", IBM
// Journal of Research and Development) and Krisper's follow-up show that
// ordinal scoring suffers range compression, rank reversal and centering bias,
// and that summing or multiplying such scales is not mathematically valid.
//
// So this is deliberately NOT presented as a risk quantification. It is a
// PRIORITISATION RANKING: a repeatable, explainable way to sort roles so the
// ones needing attention first come to the top. Every factor carries the
// evidence that produced it, so a reviewer checks the reasoning rather than
// trusting the number. The UI makes the same claim in the same words.
//
// ModelVersion is stamped on every classification. Retuning the weights below
// changes what a band means, and without a version marker the old and new
// classifications would be silently incomparable.
//
// IMPORTANT, ON STALENESS: nothing here is stored or cached. The classification
// is recomputed from live rows on every call, so it cannot go stale behind a
// policy edit. Only the human override is persisted.
package services

import (
	"context"
	"errors"
	"fmt"
	"math"
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
// through the file. Bump ModelVersion with any change here.

const (
	// ModelVersion identifies the tuning that produced a classification. A band
	// computed under one version must never be compared against another.
	ModelVersion = "2.0"

	// CRITICALITY, intrinsic. These three sum to 100.
	maxPrivilege   = 45
	maxBlastRadius = 35
	maxEscalation  = 20

	// Band thresholds, inclusive lower bounds.
	thresholdCritical = 75
	thresholdHigh     = 50
	thresholdModerate = 25

	// Compensating controls, subtracted from the criticality subtotal.
	mitigationAllJIT      = 8
	mitigationAllRecorded = 5
	mitigationDenyPolicy  = 3

	// EXPOSURE, contextual. These two sum to 100 and are reported separately.
	maxHolderExposure = 60
	maxUsageExposure  = 40

	// The dormancy window governance teams conventionally review against. A
	// grant untouched for longer than this is treated as unexercised.
	dormantAfterDays = 90
)

// actionRisk scores a single action on 0..10 by how much damage one successful
// call can do. The vocabulary is PAM's own (pam:<domain>:<Verb>), and every
// action the running system actually guards is listed explicitly rather than
// pattern-matched, because "Reveal" and "Read" differ by seven points and a
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

// RoleExposure is the CONTEXTUAL half, kept apart from criticality on purpose.
// It answers "how much live surface does this danger currently have", which is
// a property of the deployment rather than of the role.
type RoleExposure struct {
	Score int `json:"score"` // 0..100
	// Level is a plain word for the score, deliberately NOT a criticality band:
	// mixing the two vocabularies is what made the previous model confusing.
	Level   string `json:"level"` // none | limited | broad | wide
	Summary string `json:"summary"`

	Holders int `json:"holders"`

	// LastUsedAt is the most recent SUCCESS by a holder of an action this role
	// grants. Nil means nothing in the retained trail matched.
	LastUsedAt   *time.Time `json:"last_used_at"`
	DaysSinceUse *int       `json:"days_since_use"`
	Dormant      bool       `json:"dormant"`
	// UsageKnown is false when the audit trail could not be read. The UI must
	// render that as "unknown", never as "never used".
	UsageKnown bool `json:"usage_known"`
	// UsageAttributable is always false today, and the UI says so. The trail
	// records the ACTION, not which of the caller's roles authorised it, so
	// when a holder has the same permission twice this cannot attribute the
	// call. AWS last-accessed data carries the same caveat.
	UsageAttributable bool                `json:"usage_attributable"`
	Factors           []CriticalityFactor `json:"factors"`
}

// RoleCriticality is the full classification for one role.
type RoleCriticality struct {
	RoleID   string `json:"role_id"`
	RoleName string `json:"role_name"`
	IsSystem bool   `json:"is_system"`

	// Band and Score are the published criticality: the override's band when
	// one is set, the computed values otherwise.
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

	// Exposure is reported alongside, never folded into Score.
	Exposure RoleExposure `json:"exposure"`

	// Counts an administrator wants without a second round trip.
	PolicyCount   int `json:"policy_count"`
	MemberCount   int `json:"member_count"`
	ResourceReach int `json:"resource_reach"`

	ModelVersion string    `json:"model_version"`
	EvaluatedAt  time.Time `json:"evaluated_at"`
}

// CriticalitySummary is the estate-wide roll-up behind the Roles page.
type CriticalitySummary struct {
	Total      int            `json:"total"`
	ByBand     map[string]int `json:"by_band"`
	Overridden int            `json:"overridden"`
	// Dormant counts roles nothing has exercised inside the review window, and
	// Unheld counts roles nobody holds. Both are on the summary because
	// "critical AND unused" is the most actionable combination this reports.
	Dormant      int               `json:"dormant"`
	Unheld       int               `json:"unheld"`
	Roles        []RoleCriticality `json:"roles"`
	ModelVersion string            `json:"model_version"`
	EvaluatedAt  time.Time         `json:"evaluated_at"`
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
	holdersByRole  map[string][]string
	overrideByRole map[string]models.RoleCriticalityOverride
	actionVocab    int

	// lastUseByUserAction is the most recent successful call per
	// (user_id, action), loaded once for every holder of every role being
	// scored, so usage costs one query rather than one per role.
	lastUseByUserAction map[string]time.Time
	// usageKnown is false when the audit table could not be read at all, which
	// must be reported as "unknown", never as "never used".
	usageKnown bool

	// now is injectable so tests are not clock-dependent.
	now time.Time
}

func usageKey(userID, action string) string { return userID + "\x00" + action }

func (in *evaluationInput) clock() time.Time {
	if in.now.IsZero() {
		return time.Now().UTC()
	}
	return in.now
}

// load reads every row the scorer needs in one pass.
func (s *RoleCriticalityService) load(roleIDs []string) (*evaluationInput, error) {
	in := &evaluationInput{
		policyByRole:        map[string][]models.Policy{},
		membersByRole:       map[string]int{},
		holdersByRole:       map[string][]string{},
		overrideByRole:      map[string]models.RoleCriticalityOverride{},
		actionVocab:         len(actionRisk),
		lastUseByUserAction: map[string]time.Time{},
	}

	// Active resources only. A soft-deleted or deactivated resource is not
	// reachable, so counting it would inflate every blast radius equally.
	if err := s.db.Where("is_active = ?", true).Find(&in.resources).Error; err != nil {
		return nil, fmt.Errorf("load resources: %w", err)
	}

	if len(roleIDs) == 0 {
		in.usageKnown = true
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

	// Holders.
	var holders []models.UserRole
	if err := s.db.Where("role_id IN ?", roleIDs).Find(&holders).Error; err != nil {
		return nil, fmt.Errorf("load role holders: %w", err)
	}
	holderIDs := map[string]bool{}
	for _, h := range holders {
		in.membersByRole[h.RoleID]++
		in.holdersByRole[h.RoleID] = append(in.holdersByRole[h.RoleID], h.UserID)
		holderIDs[h.UserID] = true
	}

	// Standing overrides.
	var overrides []models.RoleCriticalityOverride
	if err := s.db.Where("role_id IN ?", roleIDs).Find(&overrides).Error; err != nil {
		return nil, fmt.Errorf("load criticality overrides: %w", err)
	}
	for _, o := range overrides {
		in.overrideByRole[o.RoleID] = o
	}

	// USAGE. One grouped query over the audit trail covering every holder of
	// every role being scored, rather than a query per role. Only SUCCESS
	// counts: a denied attempt proves the permission was NOT usable.
	//
	// A failure here is not fatal. Usage is an enrichment and criticality does
	// not depend on it, so an unreadable audit table degrades to "usage
	// unknown" rather than failing the whole classification.
	if len(holderIDs) == 0 {
		in.usageKnown = true
		return in, nil
	}
	ids := make([]string, 0, len(holderIDs))
	for id := range holderIDs {
		ids = append(ids, id)
	}
	type usageRow struct {
		UserID string
		Action string
		LastAt time.Time
	}
	var rows []usageRow
	err := s.db.Model(&models.AuditLog{}).
		Select("user_id, action, MAX(occurred_at) AS last_at").
		Where("user_id IN ? AND outcome = ?", ids, models.OutcomeSuccess).
		Group("user_id, action").
		Scan(&rows).Error
	if err != nil {
		if s.logger != nil {
			s.logger.Warn("rbac.criticality.usage.unavailable", zap.Error(err))
		}
		return in, nil
	}
	in.usageKnown = true
	for _, r := range rows {
		in.lastUseByUserAction[usageKey(r.UserID, r.Action)] = r.LastAt
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

// Summary classifies every role, most critical first. This is what the Roles
// list reads: one call, so the table shows criticality without a request per
// row.
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
		Roles:        make([]RoleCriticality, 0, len(roles)),
		ModelVersion: ModelVersion,
		EvaluatedAt:  in.clock(),
	}
	for _, r := range roles {
		c := s.evaluate(r, in)
		out.ByBand[string(c.Band)]++
		if c.IsOverridden {
			out.Overridden++
		}
		if c.Exposure.Dormant {
			out.Dormant++
		}
		if c.Exposure.Holders == 0 {
			out.Unheld++
		}
		out.Roles = append(out.Roles, c)
	}
	sortByCriticality(out.Roles)
	return out, nil
}

// sortByCriticality orders most critical first, then by the COMPUTED score,
// then by name. Computed rather than published, because an overridden role has
// no published number of its own: the previous model invented one purely so
// this sort would work, which reported a calculation that never happened.
func sortByCriticality(rs []RoleCriticality) {
	sort.SliceStable(rs, func(i, j int) bool {
		a, b := rs[i], rs[j]
		if a.Tier != b.Tier {
			return a.Tier < b.Tier
		}
		if a.ComputedScore != b.ComputedScore {
			return a.ComputedScore > b.ComputedScore
		}
		return a.RoleName < b.RoleName
	})
}

// evaluate is the scorer. Pure with respect to the database: everything it
// reads comes from the preloaded input, so it is cheap to call in a loop and
// straightforward to test.
func (s *RoleCriticalityService) evaluate(role models.Role, in *evaluationInput) RoleCriticality {
	policies := in.policyByRole[role.ID]
	members := in.membersByRole[role.ID]

	// Only ALLOW policies grant anything. A deny policy cannot raise the blast
	// radius, and treating it as if it could would score the safest roles in
	// the install as the most dangerous ones.
	var allow, deny []models.Policy
	for _, p := range policies {
		if strings.EqualFold(p.Effect, string(models.PolicyEffectDeny)) {
			deny = append(deny, p)
			continue
		}
		allow = append(allow, p)
	}

	privFactor := scorePrivilege(allow)
	blastFactor, reach, allJIT, allRecorded := scoreBlastRadius(allow, in.resources)
	escFactor := scoreEscalation(allow)

	raw := privFactor.Score + blastFactor.Score + escFactor.Score

	// Compensating controls, CyberArk's ease-of-compromise axis. Only
	// meaningful when the role actually reaches something: a role that reaches
	// nothing gets no credit for the estate's JIT posture.
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
	total = clamp(total, 0, 100)
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
		Factors:       []CriticalityFactor{privFactor, blastFactor, escFactor},
		Mitigations:   mitigations,
		Exposure:      scoreExposure(allow, in, role.ID, members),
		PolicyCount:   len(policies),
		MemberCount:   members,
		ResourceReach: reach,
		ModelVersion:  ModelVersion,
		EvaluatedAt:   in.clock(),
	}

	// A standing override replaces the published band, and says so. The
	// computed values stay on the record so a reviewer sees exactly what they
	// are overriding. The published SCORE is deliberately left as the computed
	// one: an override asserts a BAND, not a number, and inventing a number to
	// match would report a calculation that never happened.
	if o, ok := in.overrideByRole[role.ID]; ok {
		band := models.CriticalityBand(o.Band)
		if band.Valid() {
			override := o
			result.Band = band
			result.Tier = band.Tier()
			result.IsOverridden = true
			result.Override = &override
		}
	}

	return result
}

// scorePrivilege rates the most dangerous verb the role can call, and how many
// distinct dangerous verbs it holds. Peak dominates breadth on purpose: one
// pam:vault:Reveal is worse than twelve read-only actions.
func scorePrivilege(allow []models.Policy) CriticalityFactor {
	f := CriticalityFactor{Key: "privilege", Label: "Privilege level", Max: maxPrivilege}

	if len(allow) == 0 {
		f.Summary = "Grants nothing. No allow policy is attached to this role."
		return f
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
		f.Evidence = append(f.Evidence, `Allows action "*" (every action)`)
		return f
	}

	peak, peakAction := 0, ""
	for a := range actions {
		if r := riskOfAction(a); r > peak {
			peak, peakAction = r, a
		}
	}

	// Peak carries 35 of the 45, breadth the remaining 10. Both are ROUNDED
	// rather than truncated: integer division silently swallowed the whole
	// breadth term until a role held three actions, which is range compression
	// introduced by the implementation rather than by the model.
	peakPart := scale(peak, 10, 35)
	breadthPart := scale(len(actions), maxInt(len(actionRisk), 1), 10)
	f.Score = clamp(peakPart+breadthPart, 0, maxPrivilege)
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
		f.Evidence = append(f.Evidence, "Read mostly. No action on this role scores above 4 of 10.")
	}
	return f
}

// scoreBlastRadius rates how much of the estate the role's allow policies
// match. Returns the factor, the number of resources reached, and whether
// every reached resource is JIT gated / always recorded.
func scoreBlastRadius(allow []models.Policy, resources []models.PAMResource) (CriticalityFactor, int, bool, bool) {
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
		return f, 0, false, false
	}

	if wildcard {
		f.Score = maxBlastRadius
		f.Summary = fmt.Sprintf("Every resource in the estate, all %d of them, plus anything added later.", total)
		f.Evidence = append(f.Evidence, `Allows resource "*" (every resource, present and future)`)
		// A wildcard grant cannot be mitigated by the current estate's posture,
		// because it also covers resources that do not exist yet.
		return f, total, false, false
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
		return f, 0, false, false
	}

	sensitive := countSensitive(matched)

	// Breadth carries 25 of the 35, concentration of sensitive resources the
	// other 10: reaching three production databases beats reaching thirty dev
	// boxes.
	breadth := scale(reach, maxInt(total, 1), 25)
	sensitivePart := scale(sensitive, maxInt(reach, 1), 10)
	f.Score = clamp(breadth+sensitivePart, 0, maxBlastRadius)

	allJIT, allRecorded := true, true
	for _, m := range matched {
		if !m.RequiresJIT {
			allJIT = false
		}
		if !m.AlwaysRecord {
			allRecorded = false
		}
	}

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
	return f, reach, allJIT, allRecorded
}

// scoreEscalation asks whether the role can increase privilege. A role that can
// hand out or read the credentials behind other roles is, in practice, as
// privileged as the most privileged thing it can reach.
func scoreEscalation(allow []models.Policy) CriticalityFactor {
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
		f.Evidence = append(f.Evidence, `Allows action "*"`)
		return f
	}
	if len(hits) == 0 {
		f.Summary = "No escalation path. Nothing this role can call hands out credentials or authority."
		return f
	}

	// One escalating call already changes the risk category; further ones add
	// less. Ramp rather than multiply.
	f.Score = clamp(9+4*(len(hits)-1), 0, maxEscalation)
	names := make([]string, 0, len(hits))
	for a := range hits {
		names = append(names, a)
	}
	sort.Strings(names)
	f.Summary = fmt.Sprintf("Holds %d %s that can hand out or expose credentials.",
		len(hits), plural(len(hits), "call", "calls"))
	f.Evidence = names
	return f
}

// ── Exposure, the contextual half ──────────────────────────────────────────

// scoreExposure rates how much live surface the role's danger currently has:
// how many accounts hold it, and whether anybody actually exercises it.
//
// This is reported BESIDE criticality, never folded into it. A role is exactly
// as dangerous whether nobody holds it or forty people do; what changes is how
// much of that danger is live right now.
func scoreExposure(allow []models.Policy, in *evaluationInput, roleID string, members int) RoleExposure {
	e := RoleExposure{
		Holders:           members,
		UsageKnown:        in.usageKnown,
		UsageAttributable: false,
	}

	holderFactor := CriticalityFactor{Key: "holders", Label: "Accounts holding it", Max: maxHolderExposure}
	switch {
	case members == 0:
		holderFactor.Score = 0
		holderFactor.Summary = "Held by nobody. The grant is latent: it carries no live exposure until somebody is assigned it."
	case members <= 2:
		holderFactor.Score = 20
		holderFactor.Summary = fmt.Sprintf("Held by %d %s.", members, plural(members, "account", "accounts"))
	case members <= 5:
		holderFactor.Score = 35
		holderFactor.Summary = fmt.Sprintf("Held by %d accounts.", members)
	case members <= 10:
		holderFactor.Score = 48
		holderFactor.Summary = fmt.Sprintf("Held by %d accounts, which is wide for a privileged grant.", members)
	default:
		holderFactor.Score = maxHolderExposure
		holderFactor.Summary = fmt.Sprintf("Held by %d accounts. At this width the role is effectively standing access for a whole team.", members)
	}

	usageFactor := CriticalityFactor{Key: "recent_use", Label: "Recent use", Max: maxUsageExposure}
	last := lastUsed(allow, in, roleID)
	now := in.clock()

	switch {
	case !in.usageKnown:
		// Unknown is not zero. Scoring an unreadable trail as "never used"
		// would quietly reward an install whose audit table is broken.
		usageFactor.Score = maxUsageExposure / 2
		usageFactor.Summary = "Usage is unknown. The audit trail could not be read, so this is neither confirmed active nor confirmed dormant."
	case members == 0:
		usageFactor.Score = 0
		usageFactor.Summary = "Nobody holds this role, so there is nothing to exercise."
	case last == nil:
		usageFactor.Score = 0
		e.Dormant = true
		usageFactor.Summary = fmt.Sprintf("No holder has successfully used a permission this role grants in the retained trail, so it is past the %d day review window.", dormantAfterDays)
		usageFactor.Evidence = append(usageFactor.Evidence,
			"Unused access is the usual candidate for removal.")
	default:
		days := int(now.Sub(*last).Hours() / 24)
		if days < 0 {
			days = 0
		}
		e.LastUsedAt = last
		e.DaysSinceUse = &days
		e.Dormant = days > dormantAfterDays
		switch {
		case days <= 7:
			usageFactor.Score = maxUsageExposure
			usageFactor.Summary = fmt.Sprintf("Exercised %s. This role is in active use.", humanDays(days))
		case days <= 30:
			usageFactor.Score = 30
			usageFactor.Summary = fmt.Sprintf("Last exercised %s.", humanDays(days))
		case days <= dormantAfterDays:
			usageFactor.Score = 18
			usageFactor.Summary = fmt.Sprintf("Last exercised %s, inside the %d day review window.", humanDays(days), dormantAfterDays)
		default:
			usageFactor.Score = 5
			usageFactor.Summary = fmt.Sprintf("Last exercised %s, past the %d day review window.", humanDays(days), dormantAfterDays)
			usageFactor.Evidence = append(usageFactor.Evidence,
				"Dormant privileged access is the usual candidate for removal.")
		}
	}

	e.Factors = []CriticalityFactor{holderFactor, usageFactor}
	e.Score = clamp(holderFactor.Score+usageFactor.Score, 0, 100)

	switch {
	case members == 0:
		e.Level = "none"
		e.Summary = "Nobody holds this role, so it has no live exposure today."
	case e.Score >= 70:
		e.Level = "wide"
		e.Summary = fmt.Sprintf("Held by %d %s and actively used.", members, plural(members, "account", "accounts"))
	case e.Score >= 40:
		e.Level = "broad"
		e.Summary = fmt.Sprintf("Held by %d %s.", members, plural(members, "account", "accounts"))
	default:
		e.Level = "limited"
		if e.Dormant {
			e.Summary = fmt.Sprintf("Held by %d %s, but nothing has exercised it recently.", members, plural(members, "account", "accounts"))
		} else {
			e.Summary = fmt.Sprintf("Held by %d %s.", members, plural(members, "account", "accounts"))
		}
	}
	return e
}

// lastUsed finds the most recent successful call, by any holder of the role, of
// an action the role grants.
//
// A wildcard action grant matches every action the holder performed, which is
// correct: the role does authorise all of them. This cannot attribute the call
// to THIS role when the holder also has the permission elsewhere, which is why
// UsageAttributable is false and the UI labels the figure as indicative.
func lastUsed(allow []models.Policy, in *evaluationInput, roleID string) *time.Time {
	holders := in.holdersByRole[roleID]
	if len(holders) == 0 || len(in.lastUseByUserAction) == 0 {
		return nil
	}

	granted := map[string]bool{}
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
			granted[a] = true
		}
	}
	if len(granted) == 0 {
		return nil
	}

	holderSet := make(map[string]bool, len(holders))
	for _, h := range holders {
		holderSet[h] = true
	}

	var best time.Time
	for key, at := range in.lastUseByUserAction {
		i := strings.IndexByte(key, 0)
		if i < 0 {
			continue
		}
		user, action := key[:i], key[i+1:]
		if !holderSet[user] {
			continue
		}
		if !wildcard && !granted[action] {
			continue
		}
		if at.After(best) {
			best = at
		}
	}
	if best.IsZero() {
		return nil
	}
	out := best.UTC()
	return &out
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
		"model_version":  ModelVersion,
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
	// An action nobody recognises is assumed to mutate something. Guessing low
	// here is how a custom admin action scores as read-only.
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

// scale maps part/whole onto 0..max, ROUNDED rather than truncated. Integer
// division here is what silently swallowed the breadth term in the previous
// model until a role held three actions.
func scale(part, whole, max int) int {
	if whole <= 0 {
		return 0
	}
	v := int(math.Round(float64(part) / float64(whole) * float64(max)))
	return clamp(v, 0, max)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
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

// humanDays renders a day count the way the console does elsewhere.
func humanDays(days int) string {
	switch {
	case days <= 0:
		return "today"
	case days == 1:
		return "yesterday"
	case days < 30:
		return fmt.Sprintf("%d days ago", days)
	case days < 365:
		m := days / 30
		return fmt.Sprintf("%d %s ago", m, plural(m, "month", "months"))
	default:
		y := days / 365
		return fmt.Sprintf("%d %s ago", y, plural(y, "year", "years"))
	}
}
