// pam/internal/services/mfa_backup_code_test.go
//
// Coverage for MFA account recovery via backup code — the path an operator
// uses when they've lost their TOTP device but still have one of the ten
// single-use codes shown exactly once at MFA setup time. Also guards against
// the bug this replaces: SetupMFAVerify used to store backup codes as a
// PLAINTEXT JSON blob (the "backup_codes_hash" field name was aspirational,
// not real — see git history) — TestSetupMFAVerifyStoresCodesHashedNotPlaintext
// fails immediately if that regresses.
package services

import (
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	pamjwt "github.com/yourorg/pam/pkg/jwt"
	pamtotp "github.com/yourorg/pam/pkg/totp"

	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/pkg/argon2"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// noopRoleResolver satisfies the RoleResolver interface AuthService needs,
// without dragging PolicyEngineService/RBAC tables into a test that isn't
// about authorization.
type noopRoleResolver struct{}

func (noopRoleResolver) RoleNamesForUser(userID string) ([]string, error) { return nil, nil }

func newAuthTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file::memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open in-memory sqlite: %v", err)
	}
	if err := db.AutoMigrate(&models.User{}, &models.PAMMFA{}, &models.PAMMFABackupCode{}); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	return db
}

// newActivatedMFAUser creates a user with PAM MFA already ACTIVE and returns
// the AuthService, the user, and the ten plaintext backup codes generated
// during setup (the only time they're ever available in plaintext).
func newActivatedMFAUser(t *testing.T, db *gorm.DB) (*AuthService, *models.User, []string) {
	t.Helper()
	logger := zap.NewNop()
	issuer := pamjwt.New("test-secret-key-at-least-this-long", "pam-test", 30, 7)
	auth := NewAuthService(db, issuer, noopRoleResolver{}, testCryptoKeyB64, 5, 30, logger)

	hash, err := argon2.Hash("correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	user := &models.User{Username: "alice", Email: "alice@example.com", PasswordHash: &hash, Status: "ACTIVE"}
	if err := db.Create(user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}

	setup, err := auth.SetupMFAInitiate(user.UserID, user.Email)
	if err != nil {
		t.Fatalf("SetupMFAInitiate: %v", err)
	}
	// The secret was encrypted+stored server-side; decrypt it back out the
	// same way VerifyMFA/RecoverWithBackupCode would, to generate a valid
	// current code for activation — mirrors what a real authenticator app
	// does against the QR/secret shown once at setup.
	var mfa models.PAMMFA
	if err := db.Where("id = ?", setup.MFADeviceID).First(&mfa).Error; err != nil {
		t.Fatalf("load pending mfa row: %v", err)
	}
	code, err := pamtotp.GenerateCode(setup.Secret)
	if err != nil {
		t.Fatalf("generate activation code: %v", err)
	}

	backupCodes, session, err := auth.SetupMFAVerify(user.UserID, setup.MFADeviceID, code, "127.0.0.1")
	if err != nil {
		t.Fatalf("SetupMFAVerify: %v", err)
	}
	if len(backupCodes) != 10 {
		t.Fatalf("expected 10 backup codes, got %d", len(backupCodes))
	}
	// Enrolment hands back a replacement session, which is what lets a
	// restricted session carry on instead of being sent back to sign-in.
	if session == nil || session.AccessToken == "" {
		t.Fatal("expected a fresh session to be issued alongside the backup codes")
	}
	return auth, user, backupCodes
}

func TestSetupMFAVerifyStoresCodesHashedNotPlaintext(t *testing.T) {
	db := newAuthTestDB(t)
	_, _, backupCodes := newActivatedMFAUser(t, db)

	var rows []models.PAMMFABackupCode
	if err := db.Find(&rows).Error; err != nil {
		t.Fatalf("query backup code rows: %v", err)
	}
	if len(rows) != 10 {
		t.Fatalf("expected 10 stored rows, got %d", len(rows))
	}
	for _, row := range rows {
		if len(row.CodeHash) != 64 {
			t.Fatalf("expected a 64-hex-char SHA-256 hash, got %q (len %d)", row.CodeHash, len(row.CodeHash))
		}
		for _, plain := range backupCodes {
			if row.CodeHash == plain {
				t.Fatalf("backup code stored in PLAINTEXT: %q", plain)
			}
		}
	}
}

func TestRecoverWithBackupCodeSucceedsAndIsSingleUse(t *testing.T) {
	db := newAuthTestDB(t)
	auth, user, backupCodes := newActivatedMFAUser(t, db)

	challenge := auth.generateChallengeToken(user.UserID)
	code := backupCodes[0]

	result, err := auth.RecoverWithBackupCode(challenge, code, "127.0.0.1")
	if err != nil {
		t.Fatalf("first use of a valid backup code should succeed: %v", err)
	}
	if result.AccessToken == "" {
		t.Fatal("expected an access token to be issued")
	}
	if result.BackupCodesRemaining == nil || *result.BackupCodesRemaining != 9 {
		t.Fatalf("expected 9 remaining codes, got %v", result.BackupCodesRemaining)
	}

	// Same code again must fail — single-use.
	_, err = auth.RecoverWithBackupCode(challenge, code, "127.0.0.1")
	if err == nil {
		t.Fatal("expected reusing an already-consumed backup code to fail")
	}
}

func TestRecoverWithBackupCodeRejectsUnknownCode(t *testing.T) {
	db := newAuthTestDB(t)
	auth, user, _ := newActivatedMFAUser(t, db)

	challenge := auth.generateChallengeToken(user.UserID)
	if _, err := auth.RecoverWithBackupCode(challenge, "not-a-real-code", "127.0.0.1"); err == nil {
		t.Fatal("expected an unknown backup code to be rejected")
	}
}

func TestRecoverWithBackupCodeNormalizesCasingAndWhitespace(t *testing.T) {
	db := newAuthTestDB(t)
	auth, user, backupCodes := newActivatedMFAUser(t, db)

	challenge := auth.generateChallengeToken(user.UserID)
	// Operator retyping from a saved note: different case, stray whitespace.
	mangled := "  " + strings.ToUpper(backupCodes[3]) + "  "

	if _, err := auth.RecoverWithBackupCode(challenge, mangled, "127.0.0.1"); err != nil {
		t.Fatalf("expected a case/whitespace-mangled but otherwise valid code to be accepted: %v", err)
	}
}
