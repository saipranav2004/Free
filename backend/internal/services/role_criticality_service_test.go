// pam/internal/services/role_criticality_service_test.go
//
// The scorer is deliberately pure with respect to the database: evaluate()
// reads only the preloaded evaluationInput, so the whole model can be tested
// without a driver, a fixture database, or a running server. These tests pin
// the behaviour the UI depends on, and the boundaries somebody retuning the
// weights would otherwise break silently.
package services

import (
	"testing"

	"github.com/yourorg/pam/internal/models"
)

func policy(name, effect string, actions, resources []string) models.Policy {
	return models.Policy{
		ID: name, Name: name, Effect: effect,
		Actions: actions, Resources: resources,
	}
}

func resource(id, name, kind string, jit, record bool) models.PAMResource {
	return models.PAMResource{
		ID: id, Name: name, ResourceType: kind,
		RequiresJIT: jit, AlwaysRecord: record, IsActive: true,
	}
}

// estate is a small but realistic mix: two sensitive production resources and
// two ordinary ones.
func estate() []models.PAMResource {
	return []models.PAMResource{
		resource("res-01", "postgres-payments-prod-01", "postgres", true, true),
		resource("res-02", "clickhouse-analytics-prod-01", "clickhouse", true, false),
		resource("res-03", "redis-cache-staging", "redis", false, false),
		resource("res-04", "minio-artifacts-dev", "minio", false, false),
	}
}

func inputFor(roleID string, policies []models.Policy, members int, resources []models.PAMResource) *evaluationInput {
	return &evaluationInput{
		resources:      resources,
		policyByRole:   map[string][]models.Policy{roleID: policies},
		membersByRole:  map[string]int{roleID: members},
		overrideByRole: map[string]models.RoleCriticalityOverride{},
		actionVocab:    len(actionRisk),
	}
}

func evalRole(t *testing.T, name string, policies []models.Policy, members int) RoleCriticality {
	t.Helper()
	role := models.Role{ID: "role-" + name, Name: name}
	svc := &RoleCriticalityService{}
	return svc.evaluate(role, inputFor(role.ID, policies, members, estate()))
}

// A wildcard-on-wildcard role is the admin/root case and must land Critical.
// If this ever slips below Critical the feature is worse than not shipping it.
func TestWildcardRoleIsCritical(t *testing.T) {
	got := evalRole(t, "admin", []models.Policy{
		policy("full-access", "allow", []string{"*"}, []string{"*"}),
	}, 2)

	if got.Band != models.BandCritical {
		t.Fatalf("wildcard role band = %q, want CRITICAL (score %d)", got.Band, got.Score)
	}
	if got.Tier != 0 {
		t.Errorf("wildcard role tier = %d, want 0", got.Tier)
	}
	// 40 privilege + 30 blast + 15 escalation + 5 exposure = 90, and a
	// wildcard grant is explicitly not mitigated by the current estate's
	// posture because it also covers resources that do not exist yet.
	if got.Score != 90 {
		t.Errorf("wildcard role score = %d, want 90", got.Score)
	}
	if len(got.Mitigations) != 0 {
		t.Errorf("wildcard role picked up %d mitigations, want 0", len(got.Mitigations))
	}
}

// A read-only role over the whole estate is broad but harmless, and must not
// be inflated into a high band by breadth alone.
func TestReadOnlyRoleIsLow(t *testing.T) {
	got := evalRole(t, "auditor", []models.Policy{
		policy("read-only", "allow",
			[]string{"pam:resource:List", "pam:resource:Read", "pam:session:List", "pam:audit:Read"},
			[]string{"*"}),
	}, 1)

	if got.Band != models.BandLow && got.Band != models.BandModerate {
		t.Fatalf("read-only role band = %q score %d, want LOW or MODERATE", got.Band, got.Score)
	}
	for _, f := range got.Factors {
		if f.Key == "escalation" && f.Score != 0 {
			t.Errorf("read-only role scored %d on escalation, want 0", f.Score)
		}
	}
}

// Reveal is the single most dangerous call in the product. Holding it must
// register on both privilege and escalation.
func TestCredentialRevealDrivesEscalation(t *testing.T) {
	got := evalRole(t, "vault-operator", []models.Policy{
		policy("vault-ops", "allow",
			[]string{"pam:vault:Read", "pam:vault:Reveal", "pam:vault:Rotate"},
			[]string{"res-01"}),
	}, 3)

	var priv, esc int
	for _, f := range got.Factors {
		switch f.Key {
		case "privilege":
			priv = f.Score
		case "escalation":
			esc = f.Score
		}
	}
	if priv < 30 {
		t.Errorf("privilege = %d, want at least 30 for a role holding vault Reveal", priv)
	}
	if esc == 0 {
		t.Errorf("escalation = 0, want non-zero for a role holding Reveal and Rotate")
	}
}

// A deny policy restricts. It must never raise privilege or blast radius, and
// it should register as a mitigation.
func TestDenyPolicyDoesNotInflateScore(t *testing.T) {
	allowOnly := evalRole(t, "scoped", []models.Policy{
		policy("connect", "allow", []string{"pam:resource:Connect"}, []string{"res-03"}),
	}, 1)

	withDeny := evalRole(t, "scoped", []models.Policy{
		policy("connect", "allow", []string{"pam:resource:Connect"}, []string{"res-03"}),
		policy("no-prod", "deny", []string{"*"}, []string{"*"}),
	}, 1)

	if withDeny.Score > allowOnly.Score {
		t.Fatalf("deny policy raised score from %d to %d", allowOnly.Score, withDeny.Score)
	}
	found := false
	for _, m := range withDeny.Mitigations {
		if m.Key == "deny_policy" {
			found = true
		}
	}
	if !found {
		t.Error("deny policy did not register as a mitigation")
	}
}

// Compensating controls must actually reduce the score. A role confined to
// JIT-gated, always-recorded resources is genuinely safer than the same role
// over open ones, and the model has to say so.
func TestCompensatingControlsReduceScore(t *testing.T) {
	// res-01 is JIT gated AND always recorded. res-03 is neither.
	gated := evalRole(t, "gated", []models.Policy{
		policy("p", "allow", []string{"pam:resource:Connect", "pam:session:Start"}, []string{"res-01"}),
	}, 2)
	open := evalRole(t, "open", []models.Policy{
		policy("p", "allow", []string{"pam:resource:Connect", "pam:session:Start"}, []string{"res-03"}),
	}, 2)

	var gotJIT, gotRecorded bool
	for _, m := range gated.Mitigations {
		switch m.Key {
		case "jit_gated":
			gotJIT = true
		case "always_recorded":
			gotRecorded = true
		}
	}
	if !gotJIT || !gotRecorded {
		t.Fatalf("JIT gated + always recorded resource produced mitigations jit=%v recorded=%v", gotJIT, gotRecorded)
	}
	if len(open.Mitigations) != 0 {
		t.Errorf("ungated resource produced %d mitigations, want 0", len(open.Mitigations))
	}
}

// Exposure has to move with how many people actually hold the role, and an
// unheld role must not score exposure at all.
func TestExposureTracksHolderCount(t *testing.T) {
	p := []models.Policy{policy("p", "allow", []string{"pam:resource:Connect"}, []string{"res-03"})}

	none := evalRole(t, "r", p, 0)
	few := evalRole(t, "r", p, 2)
	many := evalRole(t, "r", p, 40)

	get := func(c RoleCriticality) int {
		for _, f := range c.Factors {
			if f.Key == "exposure" {
				return f.Score
			}
		}
		return -1
	}
	if get(none) != 0 {
		t.Errorf("unheld role exposure = %d, want 0", get(none))
	}
	if !(get(none) < get(few) && get(few) < get(many)) {
		t.Errorf("exposure not monotonic: none=%d few=%d many=%d", get(none), get(few), get(many))
	}
	if get(many) != maxExposure {
		t.Errorf("widely held role exposure = %d, want %d", get(many), maxExposure)
	}
}

// A role with no policies reaches nothing and must score zero, not a default.
func TestEmptyRoleScoresZero(t *testing.T) {
	got := evalRole(t, "empty", nil, 0)
	if got.Score != 0 {
		t.Fatalf("empty role score = %d, want 0", got.Score)
	}
	if got.Band != models.BandLow {
		t.Errorf("empty role band = %q, want LOW", got.Band)
	}
	if got.ResourceReach != 0 {
		t.Errorf("empty role reach = %d, want 0", got.ResourceReach)
	}
}

// A standing override replaces the published band and tier, keeps the computed
// values visible, and keeps score and band consistent for sorting.
func TestOverrideWinsAndKeepsComputedVisible(t *testing.T) {
	role := models.Role{ID: "role-x", Name: "reporting"}
	in := inputFor(role.ID, []models.Policy{
		policy("read", "allow", []string{"pam:audit:Read"}, []string{"res-04"}),
	}, 1, estate())
	in.overrideByRole[role.ID] = models.RoleCriticalityOverride{
		RoleID: role.ID, Band: string(models.BandCritical),
		Reason: "Reaches the regulator export path.", SetBy: "u-root", SetByUsername: "root",
	}

	svc := &RoleCriticalityService{}
	got := svc.evaluate(role, in)

	if !got.IsOverridden || got.Override == nil {
		t.Fatal("override was not applied")
	}
	if got.Band != models.BandCritical || got.Tier != 0 {
		t.Errorf("published band = %q tier %d, want CRITICAL / 0", got.Band, got.Tier)
	}
	if got.ComputedBand != models.BandLow {
		t.Errorf("computed band = %q, want LOW to remain visible under the override", got.ComputedBand)
	}
	// Score must follow the published band, so sorting by score and grouping
	// by band cannot disagree.
	if bandForScore(got.Score) != models.BandCritical {
		t.Errorf("published score %d falls in band %q, want CRITICAL", got.Score, bandForScore(got.Score))
	}
}

// An invalid stored band must be ignored rather than published, so a bad row
// cannot blank out a role's classification.
func TestInvalidOverrideBandIsIgnored(t *testing.T) {
	role := models.Role{ID: "role-y", Name: "ops"}
	in := inputFor(role.ID, []models.Policy{
		policy("p", "allow", []string{"*"}, []string{"*"}),
	}, 1, estate())
	in.overrideByRole[role.ID] = models.RoleCriticalityOverride{RoleID: role.ID, Band: "SEVERE"}

	svc := &RoleCriticalityService{}
	got := svc.evaluate(role, in)

	if got.IsOverridden {
		t.Fatal("an invalid band was accepted as an override")
	}
	if got.Band != models.BandCritical {
		t.Errorf("band = %q, want the computed CRITICAL", got.Band)
	}
}

// Resource pattern matching is what blast radius is built on, so its forms are
// pinned here.
func TestResourcePatternMatching(t *testing.T) {
	r := resource("res-01", "postgres-payments-prod-01", "postgres", true, true)
	cases := []struct {
		pattern string
		want    bool
	}{
		// Canonical form, the one middleware.RequirePermission builds.
		{"*", true},
		{"pam:resource/*", true},
		{"pam:resource/res-01", true},
		{"pam:resource/res-*", true},
		{"pam:resource/res-02", false},
		// Namespaced and bare shorthands.
		{"resource:postgres-payments-prod-01", true},
		{"resource:postgres-*", true},
		{"resource/res-01", true},
		{"res-01", true},
		{"postgres-payments-prod-01", true},
		{"POSTGRES-PAYMENTS-PROD-01", true},
		{"res-*", true},
		{"postgres-*", true},
		// Type selector.
		{"type:postgres", true},
		{"type:redis", false},
		// Non-matches, including a pattern in another namespace entirely.
		{"res-02", false},
		{"redis-*", false},
		{"safe:prod/*", false},
		{"safe:prod/db", false},
		{"", false},
		{"   ", false},
	}
	for _, c := range cases {
		if got := matchesResource(c.pattern, r); got != c.want {
			t.Errorf("matchesResource(%q) = %v, want %v", c.pattern, got, c.want)
		}
	}
}

// Band thresholds are a published contract: the UI colours and the tier
// numbering both depend on them.
func TestBandThresholds(t *testing.T) {
	cases := []struct {
		score int
		want  models.CriticalityBand
	}{
		{100, models.BandCritical},
		{75, models.BandCritical},
		{74, models.BandHigh},
		{50, models.BandHigh},
		{49, models.BandModerate},
		{25, models.BandModerate},
		{24, models.BandLow},
		{0, models.BandLow},
	}
	for _, c := range cases {
		if got := bandForScore(c.score); got != c.want {
			t.Errorf("bandForScore(%d) = %q, want %q", c.score, got, c.want)
		}
	}
}

// Every factor must stay inside its declared maximum, and the four maxima must
// still sum to 100. A retune that breaks either turns the progress bars in the
// UI into nonsense.
func TestFactorsRespectTheirMaxima(t *testing.T) {
	if maxPrivilege+maxBlastRadius+maxEscalation+maxExposure != 100 {
		t.Fatalf("factor maxima sum to %d, want 100",
			maxPrivilege+maxBlastRadius+maxEscalation+maxExposure)
	}

	roles := [][]models.Policy{
		{policy("a", "allow", []string{"*"}, []string{"*"})},
		{policy("b", "allow", []string{"pam:vault:Reveal", "pam:breakglass:Use"}, []string{"*"})},
		{policy("c", "allow", []string{"pam:resource:List"}, []string{"res-04"})},
		nil,
	}
	for i, ps := range roles {
		got := evalRole(t, "r", ps, 25)
		if got.Score < 0 || got.Score > 100 {
			t.Errorf("role %d score %d out of range", i, got.Score)
		}
		for _, f := range got.Factors {
			if f.Score < 0 || f.Score > f.Max {
				t.Errorf("role %d factor %s = %d, max %d", i, f.Key, f.Score, f.Max)
			}
		}
	}
}
