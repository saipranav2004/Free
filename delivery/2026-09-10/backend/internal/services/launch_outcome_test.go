// pam/internal/services/launch_outcome_test.go
//
// The return path for a native launch.
//
// A browser that clicks Connect navigates to a pam-agent:// URL and then has
// no further part in what happens: the agent redeems the token, finds a tool
// (or does not), opens it (or cannot) and reports back over its own signed
// channel. Before these columns existed there was nowhere for that report to
// land, so "psql opened", "psql is not installed" and "no agent is running on
// this machine" all looked identical from the console: nothing.
//
// These tests pin the three things that make the difference visible:
//
//	the launch is bound to the session it created, so an end-of-session
//	  report can be matched back to it,
//	a failure reported by the agent is stored with its reason and hint,
//	a launch is only ever readable by the user who started it.
//
// RUNS AGAINST REAL POSTGRES, not the in-memory sqlite the neighbouring
// agent test uses. Session teardown is where these paths end, and both
// EndTrackedSession and KillSession compute duration_seconds with
// Postgres-only SQL (EXTRACT(EPOCH FROM ...), GREATEST) that sqlite rejects
// outright. Asserting session teardown on sqlite would mean asserting a code
// path that cannot run, so this file asks for a database instead:
//
//	PAM_TEST_POSTGRES_DSN='postgres://user@host:5432/db?sslmode=disable' //	  go test ./internal/services/ -run Launch
//
// Skipped, not failed, when that is unset: a machine with no Postgres should
// not report a red suite for a dependency it was never given.
package services

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// newLaunchTestDB gives each test its own schema inside the configured
// database, so tests neither see each other's rows nor need tearing down in
// order. The schema is dropped when the test ends.
func newLaunchTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := os.Getenv("PAM_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set PAM_TEST_POSTGRES_DSN to run the launch-outcome tests against Postgres")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("connect to %s: %v", dsn, err)
	}

	schema := fmt.Sprintf("launch_test_%d", time.Now().UnixNano())
	if err := db.Exec("CREATE SCHEMA " + schema).Error; err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() { db.Exec("DROP SCHEMA " + schema + " CASCADE") })
	if err := db.Exec("SET search_path TO " + schema).Error; err != nil {
		t.Fatalf("set search_path: %v", err)
	}

	if err := db.AutoMigrate(
		&models.PAMResource{},
		&models.VaultEntry{},
		&models.ConnectionSession{},
		&models.SessionRecording{},
		&models.AgentDevice{},
		&models.AgentPairingCode{},
		&models.LaunchToken{},
		&models.User{},
	); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	return db
}

// launchFixture builds the whole chain a real launch needs: a resource with a
// credential, a paired device, and the keypair to sign as that device.
type launchFixture struct {
	db       *gorm.DB
	agentSvc *AgentService
	resource *models.PAMResource
	device   *models.AgentDevice
	priv     ed25519.PrivateKey
	userID   string
}

func newLaunchFixture(t *testing.T, userID string) *launchFixture {
	t.Helper()
	logger := zap.NewNop()
	db := newLaunchTestDB(t)
	resourceSvc := NewResourceService(db, testCryptoKeyB64, logger)
	agentSvc := NewAgentService(db, resourceSvc, nil, nil, logger)

	resource := &models.PAMResource{
		Name: "payments-primary", ResourceType: "postgresql",
		Host: "pg.internal", Port: 5432, ConnectMode: "native_agent",
		IsActive: true, CreatedBy: userID,
	}
	if err := resourceSvc.CreateResource(resource); err != nil {
		t.Fatalf("CreateResource: %v", err)
	}
	if _, err := resourceSvc.StoreCredential(resource.ID, "svc_payments", "password", "s3cr3t"); err != nil {
		t.Fatalf("StoreCredential: %v", err)
	}

	pairCode, _, err := agentSvc.InitPairing(userID, 0)
	if err != nil {
		t.Fatalf("InitPairing: %v", err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate keypair: %v", err)
	}
	device, err := agentSvc.CompletePairing(pairCode, "test-laptop", base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("CompletePairing: %v", err)
	}

	return &launchFixture{db: db, agentSvc: agentSvc, resource: resource, device: device, priv: priv, userID: userID}
}

// resolve redeems a launch the way the agent does, and returns the launch id
// the browser is holding alongside the session that redemption created.
func (f *launchFixture) resolve(t *testing.T) (launchID, sessionID string) {
	t.Helper()
	token, launchID, _, err := f.agentSvc.CreateLaunchToken(f.userID, f.resource.ID, "decision-1", LaunchGrantContext{})
	if err != nil {
		t.Fatalf("CreateLaunchToken: %v", err)
	}
	ts := time.Now()
	sig := ed25519.Sign(f.priv, []byte(fmt.Sprintf("%s|%d", token, ts.Unix())))
	resolved, err := f.agentSvc.ResolveLaunchToken(token, f.device.ID, base64.StdEncoding.EncodeToString(sig), ts, "127.0.0.1")
	if err != nil {
		t.Fatalf("ResolveLaunchToken: %v", err)
	}
	return launchID, resolved.SessionID
}

// Until an agent redeems it, a launch reads as "waiting". This is the state
// the console shows a spinner for, and the one that becomes "expired" if no
// agent is installed on the machine at all.
func TestLaunchStartsWaitingAndBindsItsSessionOnResolve(t *testing.T) {
	f := newLaunchFixture(t, "u-1")

	token, launchID, _, err := f.agentSvc.CreateLaunchToken(f.userID, f.resource.ID, "decision-1", LaunchGrantContext{})
	if err != nil {
		t.Fatalf("CreateLaunchToken: %v", err)
	}
	if launchID == "" {
		t.Fatal("CreateLaunchToken returned no launch id — the browser has nothing to poll with")
	}
	if launchID == token {
		t.Fatal("launch id must not be the launch secret: the id is handed back to the browser, the secret is only ever stored hashed")
	}

	before, err := f.agentSvc.GetLaunchStatus(f.userID, launchID)
	if err != nil {
		t.Fatalf("GetLaunchStatus: %v", err)
	}
	if before.State != "waiting" {
		t.Fatalf("state before redemption = %q, want waiting", before.State)
	}
	if before.SessionID != "" {
		t.Fatalf("a launch nobody has redeemed reported session %q", before.SessionID)
	}

	ts := time.Now()
	sig := ed25519.Sign(f.priv, []byte(fmt.Sprintf("%s|%d", token, ts.Unix())))
	resolved, err := f.agentSvc.ResolveLaunchToken(token, f.device.ID, base64.StdEncoding.EncodeToString(sig), ts, "127.0.0.1")
	if err != nil {
		t.Fatalf("ResolveLaunchToken: %v", err)
	}

	after, err := f.agentSvc.GetLaunchStatus(f.userID, launchID)
	if err != nil {
		t.Fatalf("GetLaunchStatus after resolve: %v", err)
	}
	if after.State != "opened" {
		t.Fatalf("state after redemption = %q, want opened", after.State)
	}
	if after.SessionID != resolved.SessionID {
		t.Fatalf("launch bound to session %q, want %q — without this binding the end-of-launch report can never be matched back", after.SessionID, resolved.SessionID)
	}
	if after.ResolvedAt == nil {
		t.Fatal("resolved_at was not stamped")
	}
}

// The whole point of the round: a tool that is not installed becomes text the
// operator can read in the console, not a silent no-op.
func TestAgentFailureReachesTheLaunchStatus(t *testing.T) {
	f := newLaunchFixture(t, "u-1")
	launchID, sessionID := f.resolve(t)

	err := f.agentSvc.EndLaunchSession(sessionID, f.device.ID, "FAILED", &LaunchFailure{
		Code:   "tool_not_installed",
		Reason: "psql is not installed on this machine.",
		Hint:   "macOS 'brew install libpq', Debian/Ubuntu 'sudo apt install postgresql-client'.",
	})
	if err != nil {
		t.Fatalf("EndLaunchSession: %v", err)
	}

	got, err := f.agentSvc.GetLaunchStatus(f.userID, launchID)
	if err != nil {
		t.Fatalf("GetLaunchStatus: %v", err)
	}
	if got.State != "failed" {
		t.Fatalf("state = %q, want failed", got.State)
	}
	if got.FailureCode != "tool_not_installed" {
		t.Fatalf("failure_code = %q", got.FailureCode)
	}
	if !strings.Contains(got.FailureReason, "psql is not installed") {
		t.Fatalf("failure_reason = %q, want the agent's own sentence", got.FailureReason)
	}
	if !strings.Contains(got.FailureHint, "brew install libpq") {
		t.Fatalf("failure_hint = %q, want the install guidance", got.FailureHint)
	}
	if got.EndedAt == nil {
		t.Fatal("ended_at was not stamped on a failed launch")
	}

	// The same explanation has to land in the audit trail, not only in the
	// operator's browser: an administrator asking why a session died should
	// not have to ask the operator what their laptop said.
	var session models.ConnectionSession
	if err := f.db.Where("id = ?", sessionID).First(&session).Error; err != nil {
		t.Fatalf("load session: %v", err)
	}
	if !strings.Contains(session.KillReason, "psql is not installed") {
		t.Fatalf("session kill_reason = %q, want the agent's reason", session.KillReason)
	}
}

// An agent reports over a channel it authenticates with its own key, but the
// contents are composed on someone's laptop. Length is bounded on arrival so
// a runaway error string cannot become an unbounded row or an unreadable
// panel.
func TestAgentFailureTextIsBounded(t *testing.T) {
	f := newLaunchFixture(t, "u-1")
	launchID, sessionID := f.resolve(t)

	if err := f.agentSvc.EndLaunchSession(sessionID, f.device.ID, "FAILED", &LaunchFailure{
		Code:   strings.Repeat("c", 500),
		Reason: strings.Repeat("r", 5000),
		Hint:   strings.Repeat("h", 5000),
	}); err != nil {
		t.Fatalf("EndLaunchSession: %v", err)
	}

	got, err := f.agentSvc.GetLaunchStatus(f.userID, launchID)
	if err != nil {
		t.Fatalf("GetLaunchStatus: %v", err)
	}
	if len(got.FailureCode) > launchCodeMax {
		t.Fatalf("failure_code length %d exceeds %d", len(got.FailureCode), launchCodeMax)
	}
	if len(got.FailureReason) > launchReasonMax {
		t.Fatalf("failure_reason length %d exceeds %d", len(got.FailureReason), launchReasonMax)
	}
	if len(got.FailureHint) > launchHintMax {
		t.Fatalf("failure_hint length %d exceeds %d", len(got.FailureHint), launchHintMax)
	}
}

// A launch id is a handle the browser holds. Reading someone else's must be
// indistinguishable from reading one that does not exist, or the endpoint
// becomes a way to probe for other people's launches.
func TestLaunchStatusIsScopedToItsOwner(t *testing.T) {
	f := newLaunchFixture(t, "u-1")
	launchID, _ := f.resolve(t)

	if _, err := f.agentSvc.GetLaunchStatus("u-someone-else", launchID); err != ErrLaunchTokenInvalid {
		t.Fatalf("reading another user's launch returned %v, want ErrLaunchTokenInvalid (the same answer as a launch that does not exist)", err)
	}
	if _, err := f.agentSvc.GetLaunchStatus(f.userID, "no-such-launch"); err != ErrLaunchTokenInvalid {
		t.Fatalf("reading a missing launch returned %v, want ErrLaunchTokenInvalid", err)
	}
}

// Only the device that redeemed a launch may say how it went. Anything else
// is one operator's agent writing an outcome onto another operator's launch.
func TestOnlyTheRedeemingDeviceCanRecordAnOutcome(t *testing.T) {
	f := newLaunchFixture(t, "u-1")
	launchID, sessionID := f.resolve(t)

	// A second device, paired to the same account, that never touched this
	// launch. Even that one must not be able to write its outcome.
	pairCode, _, err := f.agentSvc.InitPairing(f.userID, 0)
	if err != nil {
		t.Fatalf("InitPairing: %v", err)
	}
	otherPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate keypair: %v", err)
	}
	other, err := f.agentSvc.CompletePairing(pairCode, "other-laptop", base64.StdEncoding.EncodeToString(otherPub))
	if err != nil {
		t.Fatalf("CompletePairing: %v", err)
	}

	if err := f.agentSvc.EndLaunchSession(sessionID, other.ID, "FAILED", &LaunchFailure{
		Code: "tool_not_installed", Reason: "written by a device that never opened this launch",
	}); err != nil {
		t.Fatalf("EndLaunchSession: %v", err)
	}

	got, err := f.agentSvc.GetLaunchStatus(f.userID, launchID)
	if err != nil {
		t.Fatalf("GetLaunchStatus: %v", err)
	}
	if got.FailureReason != "" {
		t.Fatalf("a device that did not redeem this launch wrote %q onto it", got.FailureReason)
	}
	if got.State != "opened" {
		t.Fatalf("state = %q, want it unchanged at opened", got.State)
	}
}

// A handoff nothing ever redeemed is how "the agent is not installed or not
// running on this machine" actually looks from the server: the token simply
// expires untouched. The console needs that distinguished from "waiting", or
// it spins forever.
func TestAnUnredeemedLaunchReadsAsExpired(t *testing.T) {
	f := newLaunchFixture(t, "u-1")
	_, launchID, _, err := f.agentSvc.CreateLaunchToken(f.userID, f.resource.ID, "decision-1", LaunchGrantContext{})
	if err != nil {
		t.Fatalf("CreateLaunchToken: %v", err)
	}
	if err := f.db.Model(&models.LaunchToken{}).Where("id = ?", launchID).
		Update("expires_at", time.Now().Add(-time.Minute)).Error; err != nil {
		t.Fatalf("age the token: %v", err)
	}

	got, err := f.agentSvc.GetLaunchStatus(f.userID, launchID)
	if err != nil {
		t.Fatalf("GetLaunchStatus: %v", err)
	}
	if got.State != "expired" {
		t.Fatalf("state = %q, want expired", got.State)
	}
}

// Closing the tool must actually close the PAM session.
//
// This is the server half of "closing the app ends the session": the agent
// reports the end (the client half lives in the per-OS spawn implementations),
// and this asserts what that report does. The session has to leave ACTIVE,
// carry a real ended_at and a computed duration, and the launch the browser is
// still polling has to read as completed rather than as still open.
//
// It runs on Postgres for a reason worth stating: duration_seconds is written
// with EXTRACT(EPOCH FROM ...) and GREATEST, so on sqlite this whole path
// errors out and the assertion below would be vacuous.
func TestClosingTheToolCompletesTheSession(t *testing.T) {
	f := newLaunchFixture(t, "u-1")
	launchID, sessionID := f.resolve(t)

	var opened models.ConnectionSession
	if err := f.db.Where("id = ?", sessionID).First(&opened).Error; err != nil {
		t.Fatalf("load session: %v", err)
	}
	if opened.Status != "ACTIVE" {
		t.Fatalf("session status right after launch = %q, want ACTIVE", opened.Status)
	}

	// Backdate the start so a duration of at least one second is computable;
	// the tool exiting within the same wall-clock second is not the case
	// under test.
	if err := f.db.Model(&models.ConnectionSession{}).Where("id = ?", sessionID).
		Update("started_at", time.Now().Add(-90*time.Second)).Error; err != nil {
		t.Fatalf("backdate started_at: %v", err)
	}

	// What the agent sends when the terminal window or the desktop
	// application is closed: a clean end, no failure.
	if err := f.agentSvc.EndLaunchSession(sessionID, f.device.ID, "COMPLETED", nil); err != nil {
		t.Fatalf("EndLaunchSession: %v", err)
	}

	var closed models.ConnectionSession
	if err := f.db.Where("id = ?", sessionID).First(&closed).Error; err != nil {
		t.Fatalf("reload session: %v", err)
	}
	if closed.Status != "COMPLETED" {
		t.Fatalf("session status after the tool closed = %q, want COMPLETED — a session left ACTIVE needs an administrator to end it by hand", closed.Status)
	}
	if closed.EndedAt == nil {
		t.Fatal("ended_at was not stamped, so the session has no duration in the audit trail")
	}
	if closed.DurationSeconds < 1 {
		t.Fatalf("duration_seconds = %d, want the real elapsed time", closed.DurationSeconds)
	}

	status, err := f.agentSvc.GetLaunchStatus(f.userID, launchID)
	if err != nil {
		t.Fatalf("GetLaunchStatus: %v", err)
	}
	if status.State != "completed" {
		t.Fatalf("launch state = %q, want completed", status.State)
	}
	if status.FailureReason != "" {
		t.Fatalf("a clean close recorded a failure: %q", status.FailureReason)
	}
	if status.EndedAt == nil {
		t.Fatal("the launch was not stamped as ended")
	}
}
