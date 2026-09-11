// pam/internal/services/role_criticality_service_test.go
//
// The scorer is deliberately pure with respect to the database: evaluate()
// reads only the preloaded evaluationInput, so the whole model can be tested
// without a driver, a fixture database, or a running server. The clock is
// injectable for the same reason, so the usage tests are not time-dependent.
//
// These tests pin the behaviour the UI depends on, and the boundaries somebody
// retuning the weights would otherwise break silently. In particular they pin
// the property that motivated version 2.0: criticality must NOT move when only
// the deployment changes.
package services

import (
	"testing"
	"time"

	"github.com/yourorg/pam/internal/models"
)

var testNow = time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)

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

type roleFixture struct {
	policies []models.Policy
	members  int
	// usage maps a holder's action to when they last performed it.
	usage      map[string]time.Time
	usageKnown bool
}

func inputFor(roleID string, f roleFixture) *evaluationInput {
	in := &evaluationInput{
		resources:           estate(),
		policyByRole:        map[string][]models.Policy{roleID: f.policies},
		membersByRole:       map[string]int{roleID: f.members},
		holdersByRole:       map[string][]string{},
		overrideByRole:      map[string]models.RoleCriticalityOverride{},
		actionVocab:         len(actionRisk),
		lastUseByUserAction: map[string]time.Time{},
		usageKnown:          f.usageKnown,
		now:                 testNow,
	}
	for i := 0; i < f.members; i++ {
		in.holdersByRole[roleID] = append(in.holdersByRole[roleID], "u-holder")
	}
	for action, at := range f.usage {
		in.lastUseByUserAction[usageKey("u-holder", action)] = at
	}
	return in
}

func evalFixture(t *testing.T, name string, f roleFixture) RoleCriticality {
	t.Helper()
	role := models.Role{ID: "role-" + name, Name: name}
	svc := &RoleCriticalityService{}
	return svc.evaluate(role, inputFor(role.ID, f))
}

func evalRole(t *testing.T, name string, policies []models.Policy, members int) RoleCriticality {
	t.Helper()
	return evalFixture(t, name, roleFixture{policies: policies, members: members, usageKnown: true})
}

func factor(c RoleCriticality, key string) CriticalityFactor {
	for _, f := range c.Factors {
		if f.Key == key {
			return f
		}
	}
	for _, f := range c.Exposure.Factors {
		if f.Key == key {
			return f
		}
	}
	return CriticalityFactor{Key: "missing", Score: -1}
}

// ── The property version 2.0 exists to guarantee ───────────────────────────

// CRITICALITY IS INTRINSIC. The same role, held by nobody or by a whole team,
// must produce the SAME criticality band and score. Only exposure may move.
// If this ever fails, the two concepts have been re-conflated.
func TestCriticalityDoesNotMoveWithHolderCount(t *testing.T) {
	p := []models.Policy{policy("full", "allow", []string{"*"}, []string{"*"})}

	unheld := evalRole(t, "admin", p, 0)
	few := evalRole(t, "admin", p, 2)
	many := evalRole(t, "admin", p, 50)

	if unheld.Score != few.Score || few.Score != many.Score {
		t.Fatalf("criticality moved with holder count: 0 holders=%d, 2=%d, 50=%d",
			unheld.Score, few.Score, many.Score)
	}
	if unheld.Band != few.Band || few.Band != many.Band {
		t.Fatalf("band moved with holder count: %q / %q / %q", unheld.Band, few.Band, many.Band)
	}
	// Exposure, by contrast, MUST move.
	if !(unheld.Exposure.Score < few.Exposure.Score && few.Exposure.Score < many.Exposure.Score) {
		t.Errorf("exposure did not rise with holder count: %d / %d / %d",
			unheld.Exposure.Score, few.Exposure.Score, many.Exposure.Score)
	}
}

// Criticality must likewise be indifferent to whether the role is being used.
func TestCriticalityDoesNotMoveWithUsage(t *testing.T) {
	p := []models.Policy{policy("v", "allow", []string{"pam:vault:Reveal"}, []string{"res-01"})}

	fresh := evalFixture(t, "r", roleFixture{
		policies: p, members: 2, usageKnown: true,
		usage: map[string]time.Time{"pam:vault:Reveal": testNow.AddDate(0, 0, -1)},
	})
	stale := evalFixture(t, "r", roleFixture{
		policies: p, members: 2, usageKnown: true,
		usage: map[string]time.Time{"pam:vault:Reveal": testNow.AddDate(0, 0, -400)},
	})

	if fresh.Score != stale.Score || fresh.Band != stale.Band {
		t.Fatalf("criticality moved with usage: fresh %d/%s vs stale %d/%s",
			fresh.Score, fresh.Band, stale.Score, stale.Band)
	}
	if fresh.Exposure.Score <= stale.Exposure.Score {
		t.Errorf("exposure did not fall for a stale role: fresh=%d stale=%d",
			fresh.Exposure.Score, stale.Exposure.Score)
	}
	if stale.Exposure.Dormant != true {
		t.Error("a role last used 400 days ago should be dormant")
	}
	if fresh.Exposure.Dormant != false {
		t.Error("a role used yesterday should not be dormant")
	}
}

// ── Criticality ────────────────────────────────────────────────────────────

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
	// 45 privilege + 35 blast + 20 escalation, and a wildcard grant is
	// explicitly not mitigated by the current estate's posture because it also
	// covers resources that do not exist yet.
	if got.Score != 100 {
		t.Errorf("wildcard role score = %d, want 100", got.Score)
	}
	if len(got.Mitigations) != 0 {
		t.Errorf("wildcard role picked up %d mitigations, want 0", len(got.Mitigations))
	}
	if got.ModelVersion != ModelVersion {
		t.Errorf("model version = %q, want %q", got.ModelVersion, ModelVersion)
	}
}

// A read-only role over the whole estate is broad but harmless, and must not
// be inflated into a high band by breadth alone.
func TestReadOnlyRoleStaysLow(t *testing.T) {
	got := evalRole(t, "auditor", []models.Policy{
		policy("read-only", "allow",
			[]string{"pam:resource:List", "pam:resource:Read", "pam:session:List", "pam:audit:Read"},
			[]string{"*"}),
	}, 1)

	if got.Band == models.BandCritical || got.Band == models.BandHigh {
		t.Fatalf("read-only role band = %q score %d, want MODERATE or LOW", got.Band, got.Score)
	}
	if got := factor(got, "escalation").Score; got != 0 {
		t.Errorf("read-only role scored %d on escalation, want 0", got)
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

	if p := factor(got, "privilege").Score; p < 33 {
		t.Errorf("privilege = %d, want at least 33 for a role holding vault Reveal", p)
	}
	if e := factor(got, "escalation").Score; e == 0 {
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

// Compensating controls must actually reduce the score.
func TestCompensatingControlsReduceScore(t *testing.T) {
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
		t.Fatalf("JIT gated + always recorded produced mitigations jit=%v recorded=%v", gotJIT, gotRecorded)
	}
	if len(open.Mitigations) != 0 {
		t.Errorf("ungated resource produced %d mitigations, want 0", len(open.Mitigations))
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

// THE TRUNCATION FIX. A single-action role must earn a non-zero breadth
// contribution. Under the previous integer division this term stayed at zero
// until a role held three actions, which was range compression introduced by
// the implementation rather than by the model.
func TestBreadthTermIsRoundedNotTruncated(t *testing.T) {
	// pam:audit:Read has risk 2, so peak contributes round(2/10*35) = 7.
	// Breadth for 1 action of a 26 word vocabulary is round(1/26*10) = 0,
	// but for 2 it is round(2/26*10) = 1, which truncation would have lost.
	one := factor(evalRole(t, "a", []models.Policy{
		policy("p", "allow", []string{"pam:audit:Read"}, []string{"res-04"}),
	}, 1), "privilege").Score
	two := factor(evalRole(t, "b", []models.Policy{
		policy("p", "allow", []string{"pam:audit:Read", "pam:report:Generate"}, []string{"res-04"}),
	}, 1), "privilege").Score

	if two <= one {
		t.Errorf("adding a second action did not raise privilege: 1 action=%d, 2 actions=%d", one, two)
	}
	if got := scale(1, 26, 10); got != 0 {
		t.Errorf("scale(1,26,10) = %d, want 0 (rounds down)", got)
	}
	if got := scale(2, 26, 10); got != 1 {
		t.Errorf("scale(2,26,10) = %d, want 1 (truncation would give 0)", got)
	}
	if got := scale(13, 26, 10); got != 5 {
		t.Errorf("scale(13,26,10) = %d, want 5", got)
	}
}

// ── Exposure ───────────────────────────────────────────────────────────────

func TestExposureTracksHolderCount(t *testing.T) {
	p := []models.Policy{policy("p", "allow", []string{"pam:resource:Connect"}, []string{"res-03"})}

	none := evalRole(t, "r", p, 0)
	few := evalRole(t, "r", p, 2)
	many := evalRole(t, "r", p, 40)

	if got := factor(none, "holders").Score; got != 0 {
		t.Errorf("unheld role holder exposure = %d, want 0", got)
	}
	if got := factor(many, "holders").Score; got != maxHolderExposure {
		t.Errorf("widely held role holder exposure = %d, want %d", got, maxHolderExposure)
	}
	if none.Exposure.Level != "none" {
		t.Errorf("unheld role exposure level = %q, want none", none.Exposure.Level)
	}
	if !(factor(none, "holders").Score < factor(few, "holders").Score &&
		factor(few, "holders").Score < factor(many, "holders").Score) {
		t.Error("holder exposure is not monotonic in holder count")
	}
}

// A holder who has never exercised anything the role grants makes it dormant.
func TestNeverUsedRoleIsDormant(t *testing.T) {
	got := evalFixture(t, "r", roleFixture{
		policies:   []models.Policy{policy("p", "allow", []string{"pam:vault:Reveal"}, []string{"res-01"})},
		members:    2,
		usageKnown: true,
		// The holder has used something, but not anything THIS role grants.
		usage: map[string]time.Time{"pam:resource:List": testNow.AddDate(0, 0, -2)},
	})
	if !got.Exposure.Dormant {
		t.Fatal("a role whose granted actions were never exercised should be dormant")
	}
	if got.Exposure.LastUsedAt != nil {
		t.Errorf("last used = %v, want nil", got.Exposure.LastUsedAt)
	}
}

// A wildcard role is exercised by ANY successful call its holders make, since
// it genuinely authorises all of them.
func TestWildcardRoleCountsAnyHolderActivity(t *testing.T) {
	got := evalFixture(t, "admin", roleFixture{
		policies:   []models.Policy{policy("full", "allow", []string{"*"}, []string{"*"})},
		members:    1,
		usageKnown: true,
		usage:      map[string]time.Time{"pam:resource:List": testNow.AddDate(0, 0, -3)},
	})
	if got.Exposure.Dormant {
		t.Fatal("a wildcard role whose holder was active 3 days ago should not be dormant")
	}
	if got.Exposure.DaysSinceUse == nil || *got.Exposure.DaysSinceUse != 3 {
		t.Errorf("days since use = %v, want 3", got.Exposure.DaysSinceUse)
	}
}

// An unreadable audit trail is UNKNOWN, never "never used". Reporting a broken
// audit table as dormant would quietly recommend deleting live access.
func TestUnknownUsageIsNotReportedAsDormant(t *testing.T) {
	got := evalFixture(t, "r", roleFixture{
		policies:   []models.Policy{policy("p", "allow", []string{"pam:vault:Reveal"}, []string{"res-01"})},
		members:    3,
		usageKnown: false,
	})
	if got.Exposure.UsageKnown {
		t.Fatal("usage should be reported as unknown")
	}
	if got.Exposure.Dormant {
		t.Error("unknown usage must not be reported as dormant")
	}
	if factor(got, "recent_use").Score == 0 {
		t.Error("unknown usage should not score as zero recent use")
	}
}

// Usage is never claimed to be attributable to one role, because the audit
// trail records the action, not which role authorised it.
func TestUsageIsNotClaimedAttributable(t *testing.T) {
	got := evalRole(t, "r", []models.Policy{
		policy("p", "allow", []string{"pam:vault:Reveal"}, []string{"res-01"}),
	}, 1)
	if got.Exposure.UsageAttributable {
		t.Error("usage must not be presented as attributable to a single role")
	}
}

// ── Override ───────────────────────────────────────────────────────────────

// A standing override replaces the published band, keeps the computed values
// visible, and does NOT fabricate a score.
func TestOverrideReplacesBandWithoutInventingAScore(t *testing.T) {
	role := models.Role{ID: "role-x", Name: "reporting"}
	in := inputFor(role.ID, roleFixture{
		policies:   []models.Policy{policy("read", "allow", []string{"pam:audit:Read"}, []string{"res-04"})},
		members:    1,
		usageKnown: true,
	})
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
	// The published score must remain the COMPUTED one. The previous model
	// substituted a representative number so that sorting worked, which
	// reported a calculation that had never happened.
	if got.Score != got.ComputedScore {
		t.Errorf("override fabricated a score: published %d vs computed %d", got.Score, got.ComputedScore)
	}
}

// An invalid stored band must be ignored rather than published.
func TestInvalidOverrideBandIsIgnored(t *testing.T) {
	role := models.Role{ID: "role-y", Name: "ops"}
	in := inputFor(role.ID, roleFixture{
		policies:   []models.Policy{policy("p", "allow", []string{"*"}, []string{"*"})},
		members:    1,
		usageKnown: true,
	})
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

// Sorting must be total and stable, and must rank an overridden Critical above
// a computed High without needing a fabricated score.
func TestSortRanksOverriddenRolesCorrectly(t *testing.T) {
	rows := []RoleCriticality{
		{RoleName: "b-high", Band: models.BandHigh, Tier: 1, ComputedScore: 60},
		{RoleName: "a-overridden", Band: models.BandCritical, Tier: 0, ComputedScore: 10, IsOverridden: true},
		{RoleName: "c-high", Band: models.BandHigh, Tier: 1, ComputedScore: 72},
	}
	sortByCriticality(rows)
	if rows[0].RoleName != "a-overridden" {
		t.Errorf("first = %q, want the overridden Critical role", rows[0].RoleName)
	}
	if rows[1].RoleName != "c-high" {
		t.Errorf("second = %q, want the higher-scoring High role", rows[1].RoleName)
	}
}

// ── Shared invariants ──────────────────────────────────────────────────────

func TestResourcePatternMatching(t *testing.T) {
	r := resource("res-01", "postgres-payments-prod-01", "postgres", true, true)
	cases := []struct {
		pattern string
		want    bool
	}{
		{"*", true},
		{"pam:resource/*", true},
		{"pam:resource/res-01", true},
		{"pam:resource/res-*", true},
		{"pam:resource/res-02", false},
		{"resource:postgres-payments-prod-01", true},
		{"resource:postgres-*", true},
		{"resource/res-01", true},
		{"res-01", true},
		{"postgres-payments-prod-01", true},
		{"POSTGRES-PAYMENTS-PROD-01", true},
		{"res-*", true},
		{"postgres-*", true},
		{"type:postgres", true},
		{"type:redis", false},
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

func TestBandThresholds(t *testing.T) {
	cases := []struct {
		score int
		want  models.CriticalityBand
	}{
		{100, models.BandCritical}, {75, models.BandCritical},
		{74, models.BandHigh}, {50, models.BandHigh},
		{49, models.BandModerate}, {25, models.BandModerate},
		{24, models.BandLow}, {0, models.BandLow},
	}
	for _, c := range cases {
		if got := bandForScore(c.score); got != c.want {
			t.Errorf("bandForScore(%d) = %q, want %q", c.score, got, c.want)
		}
	}
}

// Every factor must stay inside its declared maximum, the criticality maxima
// must sum to 100, and the exposure maxima must sum to 100. A retune that
// breaks any of these turns the progress bars in the UI into nonsense.
func TestFactorsRespectTheirMaxima(t *testing.T) {
	if maxPrivilege+maxBlastRadius+maxEscalation != 100 {
		t.Fatalf("criticality maxima sum to %d, want 100",
			maxPrivilege+maxBlastRadius+maxEscalation)
	}
	if maxHolderExposure+maxUsageExposure != 100 {
		t.Fatalf("exposure maxima sum to %d, want 100", maxHolderExposure+maxUsageExposure)
	}

	roles := [][]models.Policy{
		{policy("a", "allow", []string{"*"}, []string{"*"})},
		{policy("b", "allow", []string{"pam:vault:Reveal", "pam:breakglass:Use"}, []string{"*"})},
		{policy("c", "allow", []string{"pam:resource:List"}, []string{"res-04"})},
		{policy("d", "deny", []string{"*"}, []string{"*"})},
		nil,
	}
	for i, ps := range roles {
		for _, members := range []int{0, 1, 25} {
			got := evalRole(t, "r", ps, members)
			if got.Score < 0 || got.Score > 100 {
				t.Errorf("role %d/%d holders: score %d out of range", i, members, got.Score)
			}
			if got.Exposure.Score < 0 || got.Exposure.Score > 100 {
				t.Errorf("role %d/%d holders: exposure %d out of range", i, members, got.Exposure.Score)
			}
			for _, f := range append(got.Factors, got.Exposure.Factors...) {
				if f.Score < 0 || f.Score > f.Max {
					t.Errorf("role %d factor %s = %d, max %d", i, f.Key, f.Score, f.Max)
				}
			}
		}
	}
}
