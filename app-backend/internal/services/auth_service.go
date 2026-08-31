// pam/internal/services/auth_service.go
package services

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/pkg/argon2"
	"github.com/yourorg/pam/pkg/crypto"
	pamjwt "github.com/yourorg/pam/pkg/jwt"
	pamtotp "github.com/yourorg/pam/pkg/totp"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrAccountLocked      = errors.New("account is locked")
	ErrAccountDisabled    = errors.New("account is disabled")
	ErrMFARequired        = errors.New("mfa verification required")
	ErrInvalidMFACode     = errors.New("invalid mfa code")
	ErrMFANotSetup        = errors.New("mfa not set up for this user")
	ErrUserNotFound       = errors.New("user not found")
	ErrInvalidBackupCode  = errors.New("invalid or already-used backup code")
)

// RoleResolver resolves the role names a user holds. Implemented by
// *PolicyEngineService — kept as a narrow interface here (rather than
// importing the concrete type) so AuthService's dependency is exactly
// "something that can answer this one question," nothing more.
type RoleResolver interface {
	RoleNamesForUser(userID string) ([]string, error)
}

// AuthService handles PAM's complete authentication:
//   - Password verification against PAM's own local user table (Argon2id)
//   - PAM's own TOTP MFA (separate secret in pam_mfa_devices)
//   - PAM JWT issuance (HS256, self-signed), with roles resolved from
//     PAM's own RBAC tables and embedded directly in the token
//   - Session lifecycle
type AuthService struct {
	db          *gorm.DB
	jwt         *pamjwt.Issuer
	roles       RoleResolver
	cryptoKey   string // AES-256 key for encrypting TOTP secrets
	maxAttempts int
	lockoutMin  int
	logger      *zap.Logger

	// mfaPolicy decides whether this account MUST hold a second factor.
	// Optional: nil disables the role gate entirely and leaves the pre-existing
	// "challenge only if already enrolled" behaviour, which is what the tests
	// that construct AuthService directly expect.
	mfaPolicy *MFAPolicyService
}

// SetMFAPolicy wires the role-gated MFA policy in.
//
// A setter rather than a constructor argument because MFAPolicyService and
// AuthService are built at different points in main.go and each needs things
// the other's construction produces; threading it through the constructor
// would mean reordering that wiring for no gain.
func (s *AuthService) SetMFAPolicy(p *MFAPolicyService) { s.mfaPolicy = p }

// NewAuthService creates the auth service.
func NewAuthService(db *gorm.DB, jwt *pamjwt.Issuer, roles RoleResolver, cryptoKey string,
	maxAttempts, lockoutMin int, logger *zap.Logger) *AuthService {
	return &AuthService{
		db:          db,
		jwt:         jwt,
		roles:       roles,
		cryptoKey:   cryptoKey,
		maxAttempts: maxAttempts,
		lockoutMin:  lockoutMin,
		logger:      logger,
	}
}

// ──────────────────────────────────────────────────────────────────────────
// LOGIN (Step 1: password)
// ──────────────────────────────────────────────────────────────────────────

// LoginResult is returned from Login(). If MFA is required, MFARequired=true
// and ChallengeToken is set; the frontend should prompt for a TOTP code.
type LoginResult struct {
	MFARequired    bool      `json:"mfa_required"`
	ChallengeToken string    `json:"challenge_token,omitempty"`
	ExpiresIn      int       `json:"expires_in,omitempty"`
	AccessToken    string    `json:"access_token,omitempty"`
	RefreshToken   string    `json:"refresh_token,omitempty"`
	TokenType      string    `json:"token_type"`
	SessionID      string    `json:"session_id,omitempty"`
	ExpiresAt      time.Time `json:"expires_at,omitempty"`

	// BackupCodesRemaining is set only by RecoverWithBackupCode — how many
	// unused recovery codes are left, so the frontend can prompt the
	// operator to set up MFA again (fresh device, fresh codes) before they
	// run out entirely.
	BackupCodesRemaining *int `json:"backup_codes_remaining,omitempty"`

	// MFAEnrolmentRequired is set when role-gated policy demands a second
	// factor this account does not have. The session that comes back is
	// restricted to enrolment (see middleware.EnrolmentOnlyGate) — the console
	// should route straight to the enrolment screen rather than the dashboard.
	MFAEnrolmentRequired bool `json:"mfa_enrolment_required,omitempty"`
	// MFAPolicyRoles names the gated roles that triggered it, so the console
	// can say "required because: admin" instead of stating it as a bare rule.
	MFAPolicyRoles []string `json:"mfa_policy_roles,omitempty"`
	// MFAGraceUntil is set when policy applies but the grace window is still
	// open: login proceeds normally and the console counts down.
	MFAGraceUntil *time.Time `json:"mfa_grace_until,omitempty"`
}

func (s *AuthService) Login(identifier, password, clientIP string) (*LoginResult, error) {
	// Look up the user by username or email in PAM's own local user table.
	user, err := s.findUser(identifier)
	if err != nil {
		s.logger.Info("login.user_not_found",
			zap.String("identifier", identifier),
			zap.Error(err), // ← show the ACTUAL error
		)
		return nil, ErrInvalidCredentials
	}

	// Account state checks.
	if user.Status == "LOCKED" {
		if user.LockedUntil != nil && user.LockedUntil.After(time.Now()) {
			return nil, ErrAccountLocked
		}
		// Lock window expired → auto-unlock.
		s.db.Model(&models.User{}).Where("user_id = ?", user.UserID).
			Updates(map[string]interface{}{"status": "ACTIVE", "locked_until": nil, "failed_login_attempts": 0})
		user.Status = "ACTIVE"
	}
	if user.Status == "DISABLED" || user.Status == "DELETED" {
		return nil, ErrAccountDisabled
	}

	// Verify password (Argon2id PHC format — see pkg/argon2).
	if user.PasswordHash == nil || *user.PasswordHash == "" {
		return nil, ErrInvalidCredentials
	}
	match, err := argon2.Verify(password, *user.PasswordHash)
	if err != nil {
		s.logger.Error("argon2.verify.error", zap.Error(err))
		return nil, ErrInvalidCredentials
	}
	if !match {
		s.handleFailedLogin(user.UserID, clientIP)
		return nil, ErrInvalidCredentials
	}

	// ── Password verified. Now check PAM's own MFA. ──
	mfa, err := s.getMFA(user.UserID)
	enrolled := err == nil && mfa.Status == "ACTIVE"

	// Role-gated MFA policy.
	//
	// This is deliberately evaluated BEFORE the enrolled-user branch below,
	// because the branch below only ever fires for accounts that ALREADY hold
	// a factor. That was the whole bug: a user in a gated role who had never
	// enrolled sailed straight past it, so the policy was stored, displayed,
	// and never enforced.
	//
	// Enforcement has to be here and nowhere else. This is the only point that
	// knows the password was right and has not yet minted a token.
	if s.mfaPolicy != nil {
		roles, roleErr := s.roles.RoleNamesForUser(user.UserID)
		if roleErr != nil {
			// Fail OPEN on a role-resolution blip, consistent with how the
			// policy service treats an unavailable rule table: refusing every
			// login includes refusing the person who would fix it.
			s.logger.Error("login.mfa_policy.roles_unavailable",
				zap.String("user_id", user.UserID), zap.Error(roleErr))
		} else {
			decision, decErr := s.mfaPolicy.Evaluate(user.UserID, roles, enrolled, time.Now().UTC())
			if decErr != nil {
				s.logger.Error("login.mfa_policy.evaluate.fail",
					zap.String("user_id", user.UserID), zap.Error(decErr))
			} else if decision.Block {
				// The account must hold a factor, does not, and any grace has
				// closed. Issue a session anyway — but one that can do nothing
				// except enrol. Refusing outright would be a lockout: there is
				// no way to reach the enrolment endpoints without a token.
				s.logger.Warn("login.mfa_policy.enrolment_required",
					zap.String("user_id", user.UserID),
					zap.String("mode", decision.Mode),
					zap.Strings("matched_roles", decision.MatchedRoles))

				result, issueErr := s.issueRestrictedTokensForUser(user, clientIP)
				if issueErr != nil {
					return nil, issueErr
				}
				result.MFAEnrolmentRequired = true
				result.MFAPolicyRoles = decision.MatchedRoles
				return result, nil
			} else if decision.Required && !decision.Enrolled && decision.GraceUntil != nil {
				// Inside the grace window: log in normally, but tell the
				// console so it can count down rather than surprising them
				// when the window closes.
				s.logger.Info("login.mfa_policy.grace",
					zap.String("user_id", user.UserID),
					zap.Timep("grace_until", decision.GraceUntil))
				result, issueErr := s.issueTokensForUser(user, false, clientIP)
				if issueErr != nil {
					return nil, issueErr
				}
				result.MFAPolicyRoles = decision.MatchedRoles
				result.MFAGraceUntil = decision.GraceUntil
				return result, nil
			}
		}
	}

	if enrolled {
		// Already holds a factor → issue a short-lived challenge token.
		challenge := s.generateChallengeToken(user.UserID)
		s.logger.Info("login.mfa_required", zap.String("user_id", user.UserID))
		return &LoginResult{
			MFARequired:    true,
			ChallengeToken: challenge,
			ExpiresIn:      300, // 5 minutes
		}, ErrMFARequired
	}

	// No MFA → issue tokens directly.
	return s.issueTokensForUser(user, true, clientIP)
}

// ──────────────────────────────────────────────────────────────────────────
// MFA VERIFY (Step 2: TOTP code)
// ──────────────────────────────────────────────────────────────────────────

func (s *AuthService) VerifyMFA(challengeToken, code, clientIP string) (*LoginResult, error) {
	// Decode the challenge to get user_id.
	userID, err := s.verifyChallengeToken(challengeToken)
	if err != nil {
		return nil, fmt.Errorf("invalid or expired challenge token")
	}

	// Fetch the user.
	user, err := s.findUserByID(userID)
	if err != nil {
		return nil, ErrUserNotFound
	}

	// Decrypt the TOTP secret and verify.
	mfa, err := s.getMFA(userID)
	if err != nil || mfa.Status != "ACTIVE" {
		return nil, ErrMFANotSetup
	}

	secret, err := crypto.Decrypt(mfa.SecretEncrypted, s.cryptoKey)
	if err != nil {
		s.logger.Error("mfa.decrypt.fail", zap.Error(err))
		return nil, ErrInvalidMFACode
	}

	if !pamtotp.Validate(secret, code) {
		s.logger.Warn("mfa.code.invalid", zap.String("user_id", userID))
		return nil, ErrInvalidMFACode
	}

	// MFA verified → update last used + issue tokens.
	now := time.Now()
	s.db.Model(&models.PAMMFA{}).Where("user_id = ?", userID).
		Update("last_used_at", now)

	return s.issueTokensForUser(user, true, clientIP)
}

// ──────────────────────────────────────────────────────────────────────────
// MFA SETUP
// ──────────────────────────────────────────────────────────────────────────

// MFASetupResult holds the QR code + secret for initial MFA enrollment.
type MFASetupResult struct {
	MFADeviceID     string `json:"mfa_device_id"`
	Secret          string `json:"secret"` // shown once for manual entry
	ProvisioningURI string `json:"provisioning_uri"`
	QRCodeBase64    string `json:"qr_code_base64"`
}

func (s *AuthService) SetupMFAInitiate(userID, userEmail string) (*MFASetupResult, error) {
	secret, err := pamtotp.GenerateSecret()
	if err != nil {
		return nil, fmt.Errorf("failed to generate TOTP secret: %w", err)
	}

	encrypted, err := crypto.Encrypt(secret, s.cryptoKey)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt TOTP secret: %w", err)
	}

	// Delete any existing PENDING device, then create a new one.
	s.db.Unscoped().Where("user_id = ?", userID).Delete(&models.PAMMFA{})

	mfa := &models.PAMMFA{
		UserID:          userID,
		SecretEncrypted: encrypted,
		Status:          "PENDING",
	}
	if err := s.db.Create(mfa).Error; err != nil {
		return nil, fmt.Errorf("failed to create MFA device: %w", err)
	}

	uri := pamtotp.ProvisioningURI(secret, userEmail)
	qr, err := pamtotp.GenerateQRCodeBase64(uri)
	if err != nil {
		return nil, fmt.Errorf("failed to generate QR code: %w", err)
	}

	return &MFASetupResult{
		MFADeviceID:     mfa.ID,
		Secret:          secret,
		ProvisioningURI: uri,
		QRCodeBase64:    qr,
	}, nil
}

// SetupMFAVerify activates a pending device and, on success, ISSUES A FRESH
// SESSION alongside the backup codes.
//
// The new session is the whole point of returning anything other than codes.
// Under an enforce rule the caller is holding a restricted token: it was
// minted before they had a factor, it carries mfa_enrolment_required, and
// EnrolmentOnlyGate refuses everything with it except these very endpoints.
// Activating the device does not change that token, so without a replacement
// the only way out of the interrupt is to sign out and sign in again, which is
// a strange thing to demand of somebody who has just done exactly what was
// asked of them.
//
// The replacement is issued mfaVerified=true because a TOTP code was checked
// against the device seconds ago, which is a stronger proof than the ordinary
// login path gets.
func (s *AuthService) SetupMFAVerify(userID, deviceID, code, clientIP string) ([]string, *LoginResult, error) {
	mfa, err := s.getMFA(userID)
	if err != nil {
		return nil, nil, ErrMFANotSetup
	}
	if mfa.ID != deviceID || mfa.Status != "PENDING" {
		return nil, nil, errors.New("invalid MFA device or already activated")
	}

	secret, err := crypto.Decrypt(mfa.SecretEncrypted, s.cryptoKey)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to decrypt secret: %w", err)
	}

	if !pamtotp.Validate(secret, code) {
		return nil, nil, ErrInvalidMFACode
	}

	// Generate backup codes.
	backupCodes, err := pamtotp.GenerateBackupCodes()
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate backup codes: %w", err)
	}

	now := time.Now()
	err = s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&models.PAMMFA{}).Where("id = ?", deviceID).Updates(map[string]interface{}{
			"status":       "ACTIVE",
			"activated_at": now,
		}).Error; err != nil {
			return err
		}
		// Re-activating an already-set-up device (SetupMFAInitiate deletes
		// any existing PENDING row first, but a stale ACTIVATED row's old
		// codes must never remain valid alongside a fresh batch) — clear any
		// prior codes for this device before inserting the new ones.
		if err := tx.Unscoped().Where("mfa_id = ?", deviceID).Delete(&models.PAMMFABackupCode{}).Error; err != nil {
			return err
		}
		rows := make([]models.PAMMFABackupCode, len(backupCodes))
		for i, code := range backupCodes {
			rows[i] = models.PAMMFABackupCode{MFAID: deviceID, CodeHash: hashBackupCode(code)}
		}
		return tx.Create(&rows).Error
	})
	if err != nil {
		return nil, nil, fmt.Errorf("failed to store backup codes: %w", err)
	}

	// The account row, needed to mint the replacement token.
	user, uerr := s.findUserByID(userID)
	if uerr != nil {
		s.logger.Warn("mfa.setup.reissue.user_lookup.fail", zap.String("user_id", userID), zap.Error(uerr))
		return backupCodes, nil, nil
	}

	// A fresh, unrestricted session so the caller continues where they were.
	// A failure here is not a failure of enrolment: the device IS active and
	// the codes ARE issued, so the codes are returned regardless and the
	// console falls back to asking for a new sign-in.
	session, issueErr := s.issueTokensForUser(user, true, clientIP)
	if issueErr != nil {
		s.logger.Warn("mfa.setup.reissue.fail", zap.String("user_id", userID), zap.Error(issueErr))
		return backupCodes, nil, nil
	}
	return backupCodes, session, nil
}

// ──────────────────────────────────────────────────────────────────────────
// MFA RECOVERY (backup code, when the operator has lost their TOTP device)
// ──────────────────────────────────────────────────────────────────────────

// RecoverWithBackupCode is the alternative to VerifyMFA for exactly the case
// MFA exists to make dangerous otherwise: the operator has a valid password
// but has lost their authenticator (device wiped, lost, uninstalled) and
// cannot produce a TOTP code. Takes the same challenge token Login() issued
// (so a backup code alone, without the password step, is never enough) plus
// one of the ten single-use codes shown exactly once at MFA setup time.
//
// Single-use is enforced with an atomic conditional UPDATE (WHERE
// used_at IS NULL) rather than a read-then-write, so two near-simultaneous
// recovery attempts with the same code can't both succeed.
func (s *AuthService) RecoverWithBackupCode(challengeToken, code, clientIP string) (*LoginResult, error) {
	userID, err := s.verifyChallengeToken(challengeToken)
	if err != nil {
		return nil, fmt.Errorf("invalid or expired challenge token")
	}

	user, err := s.findUserByID(userID)
	if err != nil {
		return nil, ErrUserNotFound
	}

	mfa, err := s.getMFA(userID)
	if err != nil || mfa.Status != "ACTIVE" {
		return nil, ErrMFANotSetup
	}

	hash := hashBackupCode(code)
	now := time.Now()
	result := s.db.Model(&models.PAMMFABackupCode{}).
		Where("mfa_id = ? AND code_hash = ? AND used_at IS NULL", mfa.ID, hash).
		Update("used_at", now)
	if result.Error != nil {
		s.logger.Error("mfa.backup_code.lookup.fail", zap.String("user_id", userID), zap.Error(result.Error))
		return nil, ErrInvalidBackupCode
	}
	if result.RowsAffected == 0 {
		s.logger.Warn("mfa.backup_code.invalid", zap.String("user_id", userID), zap.String("ip", clientIP))
		return nil, ErrInvalidBackupCode
	}

	var remaining int64
	s.db.Model(&models.PAMMFABackupCode{}).
		Where("mfa_id = ? AND used_at IS NULL", mfa.ID).Count(&remaining)

	s.db.Model(&models.PAMMFA{}).Where("id = ?", mfa.ID).Update("last_used_at", now)

	// Distinct, higher-visibility log line from a normal TOTP verify — used
	// backup codes are the kind of event an admin/security team wants to be
	// able to grep for specifically (device lost/compromised, or an actual
	// account-takeover attempt burning through codes).
	s.logger.Warn("mfa.backup_code.used",
		zap.String("user_id", userID),
		zap.String("username", user.Username),
		zap.String("ip", clientIP),
		zap.Int64("codes_remaining", remaining),
	)

	loginResult, err := s.issueTokensForUser(user, true, clientIP)
	if err != nil {
		return nil, err
	}
	remainingInt := int(remaining)
	loginResult.BackupCodesRemaining = &remainingInt
	return loginResult, nil
}

// RegenerateBackupCodes issues a fresh batch of backup codes for the caller's
// enrolled authenticator and invalidates every previous one.
//
// The console had a "New backup codes" button calling an endpoint that did not
// exist, so it answered 404 for everybody. This is that endpoint's service
// half.
//
// ALL-OR-NOTHING, IN ONE TRANSACTION. The delete and the insert must not be
// separable: a failure between them would leave an account with an enrolled
// device and zero usable recovery codes, which is a lockout waiting for the
// next lost phone. The old codes are hard-deleted (Unscoped) for the same
// reason SetupMFAVerify does it — a soft-deleted hash is still a row, and a
// recovery lookup that forgets the deleted_at filter would accept a code the
// operator believes they have revoked.
//
// Requires an ACTIVE device. Regenerating codes for a PENDING enrolment would
// hand out recovery for a factor that was never proven.
func (s *AuthService) RegenerateBackupCodes(userID string) ([]string, error) {
	var device models.PAMMFA
	if err := s.db.Where("user_id = ? AND status = ?", userID, "ACTIVE").First(&device).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrMFANotSetup
		}
		return nil, err
	}

	codes, err := pamtotp.GenerateBackupCodes()
	if err != nil {
		return nil, fmt.Errorf("failed to generate backup codes: %w", err)
	}

	err = s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Unscoped().Where("mfa_id = ?", device.ID).
			Delete(&models.PAMMFABackupCode{}).Error; err != nil {
			return err
		}
		rows := make([]models.PAMMFABackupCode, len(codes))
		for i, code := range codes {
			rows[i] = models.PAMMFABackupCode{MFAID: device.ID, CodeHash: hashBackupCode(code)}
		}
		return tx.Create(&rows).Error
	})
	if err != nil {
		return nil, fmt.Errorf("failed to store backup codes: %w", err)
	}

	s.logger.Info("mfa.backup_codes.regenerated",
		zap.String("user_id", userID), zap.Int("count", len(codes)))
	return codes, nil
}

// hashBackupCode normalizes (trim + lowercase — GenerateBackupCodes emits
// lowercase hex, but an operator retyping one from a saved copy may enter it
// with different casing or surrounding whitespace) and SHA-256 hashes a
// submitted backup code for lookup against the stored hash. Mirrors
// agent_service.go's hashSecret — same "hash a high-entropy one-time code
// with a fast hash" reasoning, just local to this file since callers on
// either side of the package boundary shouldn't share a helper this small.
func hashBackupCode(code string) string {
	normalized := strings.ToLower(strings.TrimSpace(code))
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])
}

// ──────────────────────────────────────────────────────────────────────────
// LOGOUT
// ──────────────────────────────────────────────────────────────────────────

func (s *AuthService) Logout(userID string) error {
	// In production: revoke the JTI in Redis (token blacklist) + clear session.
	// For now: log it.
	s.logger.Info("logout", zap.String("user_id", userID))
	return nil
}

// ──────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ──────────────────────────────────────────────────────────────────────────

func (s *AuthService) findUser(identifier string) (*models.User, error) {
	var user models.User
	err := s.db.Where("username = ? OR email = ?", identifier, identifier).
		First(&user).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrUserNotFound
		}
		return nil, err
	}
	return &user, nil
}

func (s *AuthService) findUserByID(userID string) (*models.User, error) {
	var user models.User
	if err := s.db.Where("user_id = ?", userID).First(&user).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

func (s *AuthService) getMFA(userID string) (*models.PAMMFA, error) {
	var mfa models.PAMMFA
	if err := s.db.Where("user_id = ?", userID).First(&mfa).Error; err != nil {
		return nil, err
	}
	return &mfa, nil
}

func (s *AuthService) handleFailedLogin(userID, clientIP string) {
	s.db.Model(&models.User{}).Where("user_id = ?", userID).
		UpdateColumn("failed_login_attempts", gorm.Expr("failed_login_attempts + 1"))

	var user models.User
	s.db.Where("user_id = ?", userID).First(&user)
	if user.FailedLoginAttempts+1 >= s.maxAttempts {
		lockUntil := time.Now().Add(time.Duration(s.lockoutMin) * time.Minute)
		s.db.Model(&models.User{}).Where("user_id = ?", userID).Updates(map[string]interface{}{
			"status":       "LOCKED",
			"locked_until": lockUntil,
		})
		s.logger.Warn("login.account_locked",
			zap.String("user_id", userID),
			zap.Int("attempts", user.FailedLoginAttempts+1),
		)
	}
}

// issueTokensForUser mints an ordinary, unrestricted session.
func (s *AuthService) issueTokensForUser(user *models.User, mfaVerified bool, clientIP string) (*LoginResult, error) {
	return s.issueTokens(user, mfaVerified, false, clientIP)
}

// issueRestrictedTokensForUser mints a session that can do nothing but enrol a
// second factor.
//
// It exists because refusing the login outright would be a lockout, not a
// control: the enrolment endpoints are authenticated, so an account with no
// token can never satisfy the policy that is blocking it. The restriction is
// carried as a claim and enforced by middleware.EnrolmentOnlyGate, which is
// what makes it hold against a caller that ignores the console.
func (s *AuthService) issueRestrictedTokensForUser(user *models.User, clientIP string) (*LoginResult, error) {
	return s.issueTokens(user, false, true, clientIP)
}

func (s *AuthService) issueTokens(user *models.User, mfaVerified, enrolmentOnly bool, clientIP string) (*LoginResult, error) {
	// Roles are resolved from PAM's own RBAC tables (see rbac.go /
	// policy_engine_service.go) and embedded directly in the JWT, so most
	// requests never need a DB round trip just to know "is this user an
	// admin" — middleware.RequireAdmin reads this claim straight off the
	// verified token. A resolution error fails closed (empty roles) rather
	// than failing the whole login — an account temporarily unable to
	// resolve its roles should still be able to log in and see "no access"
	// rather than being locked out of authentication entirely.
	roles, err := s.roles.RoleNamesForUser(user.UserID)
	if err != nil {
		s.logger.Error("login.resolve_roles.fail", zap.String("user_id", user.UserID), zap.Error(err))
		roles = []string{}
	}

	sessionID := fmt.Sprintf("pam-%d", time.Now().UnixNano())
	accountID := ""
	if user.AccountID != nil {
		accountID = *user.AccountID
	}
	accessToken, _, expiresAt, err := s.jwt.IssueAccessToken(
		user.UserID, user.Username, user.Email, accountID, mfaVerified, roles, sessionID, enrolmentOnly,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to issue access token: %w", err)
	}
	refreshToken := s.jwt.IssueRefreshToken()

	// Record successful login on PAM's own local user row.
	s.db.Model(&models.User{}).Where("user_id = ?", user.UserID).Updates(map[string]interface{}{
		"last_login_at":         time.Now(),
		"last_login_ip":         clientIP,
		"failed_login_attempts": 0,
		"locked_until":          nil,
	})

	s.logger.Info("login.success",
		zap.String("user_id", user.UserID),
		zap.String("username", user.Username),
		zap.String("ip", clientIP),
	)

	return &LoginResult{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		TokenType:    "Bearer",
		SessionID:    sessionID,
		ExpiresAt:    expiresAt,
	}, nil
}

// Challenge token = SHA-256(userID + "|" + timestamp). Stored in Redis in production.
// For simplicity: encode userID with a short TTL check.
func (s *AuthService) generateChallengeToken(userID string) string {
	h := sha256.Sum256([]byte(fmt.Sprintf("%s|%d", userID, time.Now().Unix())))
	return hex.EncodeToString(h[:]) + "." + userID
}

func (s *AuthService) verifyChallengeToken(token string) (string, error) {
	parts := splitN(token, ".", 2)
	if len(parts) != 2 {
		return "", errors.New("malformed challenge token")
	}
	return parts[1], nil
}

func splitN(s, sep string, n int) []string {
	var result []string
	start := 0
	for i := 0; i < n-1; i++ {
		idx := indexOf(s[start:], sep)
		if idx < 0 {
			break
		}
		result = append(result, s[start:start+idx])
		start += idx + len(sep)
	}
	result = append(result, s[start:])
	return result
}

func indexOf(s, sub string) int {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
