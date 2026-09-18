// pam/internal/services/minio_native_agent_e2e_test.go
//
// End-to-end regression coverage for "MinIO as a PAM resource, opened via the
// native pam-agent" — the same pipeline PostgreSQL/MongoDB/Redis/SSH resources
// already use for their native-agent launch path (see agent_service.go's doc
// comment). Unlike those four, MinIO has no in-browser terminal protocol
// (internal/gateway.SupportedResourceTypes deliberately excludes it — there is
// no sensible interactive command language for raw object storage the way
// there is for SQL/RESP/mongosh), so native-agent (or the console link) is the
// ONLY way to open it. That path is entirely resource-type-agnostic already
// (ResourceService/AgentService never branch on ResourceType), so this test
// exists to prove that generic pipeline actually produces a correct,
// connectable result for a MinIO resource specifically — not just that it
// compiles.
//
// Runs against an in-memory sqlite DB rather than the project's real
// Postgres, so it needs no live database and is safe to run in any CI
// environment. This intentionally does NOT exercise AgentService.
// EndLaunchSession: that call chain ends in EndTrackedSession, which stamps
// duration_seconds with Postgres-only SQL (EXTRACT(EPOCH FROM ...), GREATEST)
// that sqlite does not implement — a real environment difference, not a bug
// in the code under test, and out of scope for what this test is verifying
// (the launch/open path, not session teardown).
//
// The final assertion optionally dials the REAL MinIO instance described in
// this repo's .env (PAM_S3_ENDPOINT/PAM_S3_ACCESS_KEY/PAM_S3_SECRET_KEY) using
// nothing but the ConnectionInfo this pipeline resolved — i.e. exactly the
// data pam-agent itself would receive over the wire and use to open `mc`/a
// native client. That step only runs when PAM_TEST_LIVE_MINIO=1 is set, so a
// sandboxed/offline CI run never fails on a network dependency; the DB-layer
// pipeline assertions above it always run unconditionally.
package services

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	miniogo "github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

const testCryptoKeyB64 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" // 32 bytes, test-only

func newTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file::memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open in-memory sqlite: %v", err)
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

func TestMinIOResourceNativeAgentEndToEnd(t *testing.T) {
	logger := zap.NewNop()
	db := newTestDB(t)

	// The vault is attached here for the same reason main.go attaches it:
	// credentials live in one store now, and the connection path reads them
	// back through it.
	vaultSvc, err := NewVaultService(db, testCryptoKeyB64, logger)
	if err != nil {
		t.Fatalf("vault init: %v", err)
	}
	resourceSvc := NewResourceService(db, logger).WithVault(vaultSvc)
	agentSvc := NewAgentService(db, resourceSvc, nil, nil, logger)

	const userID = "e2e-test-user"
	const accessKey = "minioadmin"
	const secretKey = "DasAdmin@123"
	const host = "13.206.221.6"
	const port = 9000
	const consoleURL = "http://13.206.221.6:9001"
	const extraConfig = `{"use_ssl":false,"region":"ap-south-1"}`

	// ── 1. Register the resource, exactly as the admin-only POST
	// /api/v1/pam/admin/resources handler does (resource_handler.go's Create,
	// which now rejects invalid extra_config before this point is ever
	// reached). ────────────────────────────────────────────────────────────
	if err := ValidateExtraConfigJSON(extraConfig); err != nil {
		t.Fatalf("extra_config should be valid JSON: %v", err)
	}
	resource := &models.PAMResource{
		Name:         "Prod MinIO",
		ResourceType: "minio",
		Host:         host,
		Port:         port,
		ConnectMode:  "native_agent",
		ConsoleURL:   consoleURL,
		ExtraConfig:  extraConfig,
		IsActive:     true,
		CreatedBy:    userID,
	}
	if err := resourceSvc.CreateResource(resource); err != nil {
		t.Fatalf("CreateResource: %v", err)
	}

	// ── 2. Store the vaulted credential — access key as the account name,
	// secret key as the encrypted secret, same shape Postgres/Mongo/Redis
	// resources already use (username/password). ─────────────────────────
	if _, err := resourceSvc.StoreCredential(resource.ID, accessKey, "api_key", secretKey); err != nil {
		t.Fatalf("StoreCredential: %v", err)
	}

	// ── 3. ResolveConnection — what gateway.go and AgentService both call.
	// Confirms the round trip (encrypt -> store -> decrypt) and the
	// extra_config JSON parse are both intact for this resource type. ─────
	info, err := resourceSvc.ResolveConnection(resource.ID)
	if err != nil {
		t.Fatalf("ResolveConnection: %v", err)
	}
	if info.Host != host || info.Port != port {
		t.Fatalf("host/port mismatch: got %s:%d", info.Host, info.Port)
	}
	if info.AccountName != accessKey || info.Password != secretKey {
		t.Fatalf("credential mismatch: got account=%q", info.AccountName)
	}
	if info.ConsoleURL != consoleURL {
		t.Fatalf("console_url mismatch: got %q", info.ConsoleURL)
	}
	if useSSL, ok := info.ExtraConfig["use_ssl"].(bool); !ok || useSSL {
		t.Fatalf("expected extra_config.use_ssl=false, got %#v", info.ExtraConfig["use_ssl"])
	}
	if region, _ := info.ExtraConfig["region"].(string); region != "ap-south-1" {
		t.Fatalf("expected extra_config.region=ap-south-1, got %q", region)
	}

	// ── 4. Pair a fake desktop agent — mirrors what `pam-agent pair --code
	// ...` does: generate an Ed25519 keypair locally, send only the public
	// half plus the human-typed code. ─────────────────────────────────────
	pairCode, _, err := agentSvc.InitPairing(userID, 0)
	if err != nil {
		t.Fatalf("InitPairing: %v", err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate agent keypair: %v", err)
	}
	device, err := agentSvc.CompletePairing(pairCode, "test-desktop", base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("CompletePairing: %v", err)
	}
	if hasDevice, err := agentSvc.HasActiveDevice(userID); err != nil || !hasDevice {
		t.Fatalf("HasActiveDevice: got (%v, %v), want (true, nil)", hasDevice, err)
	}

	// ── 5. Browser side: issue a one-time launch token — what CreateLaunch
	// does once RBAC/PBAC and (for a JIT-gated resource) RequireActiveGrant
	// have already allowed the connect. ───────────────────────────────────
	token, _, err := agentSvc.CreateLaunchToken(userID, resource.ID, "decision-1", LaunchGrantContext{})
	if err != nil {
		t.Fatalf("CreateLaunchToken: %v", err)
	}

	// ── 6. Agent side: redeem the token with a real Ed25519 signature over
	// "<token>|<unix-ts>" — exactly what pam-agent's redeem call does after
	// the OS hands it the pam-agent://launch?... URL. ─────────────────────
	ts := time.Now()
	sig := ed25519.Sign(priv, []byte(fmt.Sprintf("%s|%d", token, ts.Unix())))
	resolved, err := agentSvc.ResolveLaunchToken(token, device.ID, base64.StdEncoding.EncodeToString(sig), ts, "127.0.0.1")
	if err != nil {
		t.Fatalf("ResolveLaunchToken: %v", err)
	}
	if resolved.ResourceType != "minio" {
		t.Fatalf("expected resource_type=minio, got %q", resolved.ResourceType)
	}
	if resolved.Host != host || resolved.Port != port || resolved.AccountName != accessKey || resolved.Password != secretKey {
		t.Fatalf("resolved launch connection info does not match the stored resource: %+v", resolved.ConnectionInfo)
	}
	useSSL, _ := resolved.ExtraConfig["use_ssl"].(bool)

	// A second redemption of the same token must fail — single-use, exactly
	// like every other credential-bearing token in this codebase.
	if _, err := agentSvc.ResolveLaunchToken(token, device.ID, base64.StdEncoding.EncodeToString(sig), ts, "127.0.0.1"); err == nil {
		t.Fatalf("expected replaying a consumed launch token to fail, it succeeded")
	}

	t.Logf("native-agent launch resolved for MinIO resource %s: host=%s port=%d account=%s use_ssl=%v session_id=%s",
		resource.ID, resolved.Host, resolved.Port, resolved.AccountName, useSSL, resolved.SessionID)

	// ── 7. Optional: prove the resolved ConnectionInfo actually authenticates
	// against the real, live MinIO instance this repo's .env points at — the
	// exact step pam-agent itself would perform (e.g. `mc alias set` or the
	// SDK call an embedded native client makes) before opening a shell/GUI.
	// Gated behind an explicit opt-in so this test never depends on outbound
	// network access by default. ───────────────────────────────────────────
	if os.Getenv("PAM_TEST_LIVE_MINIO") != "1" {
		t.Skip("set PAM_TEST_LIVE_MINIO=1 to also verify the resolved credential against the real MinIO server")
	}
	client, err := miniogo.New(fmt.Sprintf("%s:%d", resolved.Host, resolved.Port), &miniogo.Options{
		Creds:  credentials.NewStaticV4(resolved.AccountName, resolved.Password, ""),
		Secure: useSSL,
	})
	if err != nil {
		t.Fatalf("construct minio client from resolved launch info: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	buckets, err := client.ListBuckets(ctx)
	if err != nil {
		t.Fatalf("resolved MinIO credential failed to authenticate against the live server: %v", err)
	}
	t.Logf("live MinIO auth succeeded using the resolved native-agent connection info — %d bucket(s) visible", len(buckets))
}
