package handlers

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

// MFAPosture is the role-gated MFA decision for one account, as the console
// needs to read it. See Me below for why it has to travel on /auth/me and not
// only on the login response.
type MFAPosture struct {
	Required          bool       `json:"mfa_required"`
	Mode              string     `json:"mfa_policy_mode"`
	EnrolmentRequired bool       `json:"mfa_enrolment_required"`
	PolicyRoles       []string   `json:"mfa_policy_roles,omitempty"`
	GraceUntil        *time.Time `json:"mfa_grace_until,omitempty"`
}

// MFAPostureFunc resolves that decision for the signed-in account. Injected
// rather than reached for, so this handler keeps knowing nothing about how the
// policy is stored.
type MFAPostureFunc func(userID string, roles []string) (MFAPosture, error)

// DelegationScopeFunc answers "is this administrator confined to a set of
// resources". Optional: nil leaves the field off /auth/me entirely.
type DelegationScopeFunc func(userID string) ([]string, bool, error)

type AuthHandler struct {
	auth    *services.AuthService
	posture MFAPostureFunc
	scope   DelegationScopeFunc
	log     *zap.Logger
}

func NewAuthHandler(auth *services.AuthService, posture MFAPostureFunc, log *zap.Logger) *AuthHandler {
	return &AuthHandler{auth: auth, posture: posture, log: log}
}

// WithDelegationScope attaches the resolver so /auth/me can tell the console
// that this administrator's view is confined.
//
// A setter rather than a constructor argument because every existing caller
// and test builds this handler with three arguments, and a scoped delegation
// is an optional feature of an install, not a dependency of authentication.
func (h *AuthHandler) WithDelegationScope(fn DelegationScopeFunc) *AuthHandler {
	h.scope = fn
	return h
}

// ─── LOGIN (step 1: password) ──────────────────────────────────────────────

type loginRequest struct {
	Identifier string `json:"identifier" binding:"required"`
	Password   string `json:"password" binding:"required"`
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, 400, "identifier and password are required")
		return
	}

	result, err := h.auth.Login(req.Identifier, req.Password, c.ClientIP())
	if err != nil {
		switch {
		case errors.Is(err, services.ErrMFARequired):
			response.Success(c, result, "MFA verification required")
			return
		case errors.Is(err, services.ErrInvalidCredentials):
			response.Error(c, 401, "Invalid username or password")
			return
		case errors.Is(err, services.ErrAccountLocked):
			response.Error(c, 423, "Account is temporarily locked")
			return
		case errors.Is(err, services.ErrAccountDisabled):
			response.Error(c, 403, "Account is disabled")
			return
		default:
			h.log.Error("login.internal_error", zap.Error(err))
			response.Error(c, 500, "Login failed")
			return
		}
	}

	response.Success(c, result, "Login successful")
}

// ─── MFA VERIFY (step 2: TOTP code) ────────────────────────────────────────

type mfaVerifyRequest struct {
	ChallengeToken string `json:"challenge_token" binding:"required"`
	Code           string `json:"code" binding:"required"`
}

func (h *AuthHandler) MFAVerify(c *gin.Context) {
	var req mfaVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, 400, "challenge_token and code are required")
		return
	}

	result, err := h.auth.VerifyMFA(req.ChallengeToken, req.Code, c.ClientIP())
	if err != nil {
		if errors.Is(err, services.ErrInvalidMFACode) {
			response.Error(c, 401, "Invalid or expired MFA code")
			return
		}
		response.Error(c, 401, err.Error())
		return
	}

	response.Success(c, result, "MFA verified, login successful")
}

// ─── MFA RECOVER (step 2 alternative: backup code, TOTP device unavailable) ─

type mfaRecoverRequest struct {
	ChallengeToken string `json:"challenge_token" binding:"required"`
	BackupCode     string `json:"backup_code" binding:"required"`
}

func (h *AuthHandler) MFARecover(c *gin.Context) {
	var req mfaRecoverRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, 400, "challenge_token and backup_code are required")
		return
	}

	result, err := h.auth.RecoverWithBackupCode(req.ChallengeToken, req.BackupCode, c.ClientIP())
	if err != nil {
		switch {
		case errors.Is(err, services.ErrInvalidBackupCode):
			response.Error(c, 401, "Invalid or already-used backup code")
			return
		case errors.Is(err, services.ErrMFANotSetup), errors.Is(err, services.ErrUserNotFound):
			response.Error(c, 401, "Invalid or expired challenge token")
			return
		default:
			h.log.Error("mfa.recover.internal_error", zap.Error(err))
			response.Error(c, 500, "MFA recovery failed")
			return
		}
	}

	response.Success(c, result, "Recovered with backup code, login successful")
}

// ─── MFA SETUP (initiate) ──────────────────────────────────────────────────

func (h *AuthHandler) MFASetupInitiate(c *gin.Context) {
	userID, _ := c.Get("user_id")
	email, _ := c.Get("email")

	result, err := h.auth.SetupMFAInitiate(userID.(string), email.(string))
	if err != nil {
		h.log.Error("mfa.setup.initiate.fail", zap.Error(err))
		response.Error(c, 500, "Failed to initiate MFA setup")
		return
	}

	response.Success(c, result, "Scan the QR code with your authenticator app")
}

// ─── MFA SETUP (verify + activate) ─────────────────────────────────────────

type mfaSetupVerifyRequest struct {
	MFADeviceID string `json:"mfa_device_id" binding:"required"`
	Code        string `json:"code" binding:"required"`
}

// MFABackupCodesRegenerate handles POST /api/v1/auth/mfa/backup-codes/regenerate
//
// The console's "New backup codes" button called this path and got 404,
// because the route never existed. Returns the plaintext codes ONCE: they are
// stored only as hashes, so this response is the single opportunity to record
// them and the UI must say so.
func (h *AuthHandler) MFABackupCodesRegenerate(c *gin.Context) {
	userID, ok := c.Get("user_id")
	if !ok {
		response.Error(c, 401, "Not authenticated")
		return
	}

	codes, err := h.auth.RegenerateBackupCodes(userID.(string))
	if err != nil {
		if errors.Is(err, services.ErrMFANotSetup) {
			response.Error(c, 409, "Set up an authenticator app before generating backup codes")
			return
		}
		h.log.Error("mfa.backup_codes.regenerate.fail", zap.Error(err))
		response.Error(c, 500, "Could not generate new backup codes")
		return
	}

	response.Success(c, gin.H{
		"backup_codes": codes,
		"count":        len(codes),
	}, "New backup codes generated. Your previous codes no longer work.")
}

func (h *AuthHandler) MFASetupVerify(c *gin.Context) {
	var req mfaSetupVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, 400, "mfa_device_id and code are required")
		return
	}

	userID, _ := c.Get("user_id")
	backupCodes, session, err := h.auth.SetupMFAVerify(userID.(string), req.MFADeviceID, req.Code, c.ClientIP())
	if err != nil {
		if errors.Is(err, services.ErrInvalidMFACode) {
			response.Error(c, 401, "Invalid MFA code")
			return
		}
		response.Error(c, 400, err.Error())
		return
	}

	body := gin.H{
		"backup_codes": backupCodes,
		"message":      "Save these backup codes — they will NOT be shown again",
	}
	// The replacement session, when one could be issued. Under an enforce rule
	// the caller is holding a restricted token that this enrolment has just
	// made obsolete; handing back a fresh one lets the console carry on
	// instead of sending them back to the sign-in screen. Absent on the
	// unrestricted path and on a reissue failure, and the console copes with
	// it being absent.
	if session != nil {
		body["access_token"] = session.AccessToken
		body["token_type"] = session.TokenType
		body["expires_at"] = session.ExpiresAt
		body["mfa_verified"] = true
	}

	response.Success(c, body, "MFA enabled successfully")
}

// ─── ME (current user) ─────────────────────────────────────────────────────

// Me is where the console learns its own MFA posture.
//
// THE POLICY DECISION HAS TO TRAVEL HERE, not only on the login response. The
// console re-reads /auth/me on an interval and on tab focus, and it renders
// the enrolment interrupt and the monitor banner from what this returns. While
// this endpoint answered with five fields and none of them said anything about
// the policy, readMfaPolicyPosture saw no policy fields at all and reported
// "no policy in play" for every account. So the gate rendered nothing, in
// monitor mode AND in enforce mode: a rule could be configured, shown on the
// policy screen and counted in the compliance table while being invisible to
// the person it applied to.
//
// It also has to be re-evaluated per request rather than read from the token.
// A rule attached to a role five minutes ago must reach a session already
// open; that is the same reason middleware.LiveRoles exists, and the roles
// used here are the live ones it put on the context.
func (h *AuthHandler) Me(c *gin.Context) {
	userID, _ := c.Get("user_id")
	username, _ := c.Get("username")
	email, _ := c.Get("email")
	mfa, _ := c.Get("mfa_verified")
	rolesRaw, _ := c.Get("roles")
	roles, _ := rolesRaw.([]string)

	body := gin.H{
		"user_id":      userID,
		"username":     username,
		"email":        email,
		"mfa_verified": mfa,
		"roles":        rolesRaw,
	}

	if h.posture != nil {
		uid, _ := userID.(string)
		if p, err := h.posture(uid, roles); err != nil {
			// Not fatal. Losing the whole identity call because a policy table
			// was unreadable would sign the console out over a blip; the
			// console treats absent policy fields as "not reported".
			h.log.Warn("auth.me.mfa_posture.fail", zap.Error(err))
		} else {
			body["mfa_required"] = p.Required
			body["mfa_policy_mode"] = p.Mode
			body["mfa_enrolment_required"] = p.EnrolmentRequired
			if len(p.PolicyRoles) > 0 {
				body["mfa_policy_roles"] = p.PolicyRoles
			}
			if p.GraceUntil != nil {
				body["mfa_grace_until"] = p.GraceUntil
			}
		}
	}

	// A SCOPED DELEGATE HAS TO BE TOLD, or the console is simply wrong at them.
	// The server confines what they can list and act on, so without this an
	// administrator opens the JIT queue, sees it empty, and concludes the queue
	// is clear rather than that they are looking at one slice of it. Hiding the
	// confinement is not a security measure, it is a way to make a correct
	// refusal look like a bug.
	if h.scope != nil {
		if uid, _ := userID.(string); uid != "" {
			if ids, scoped, err := h.scope(uid); err != nil {
				h.log.Warn("auth.me.delegation_scope.fail", zap.Error(err))
			} else if scoped {
				body["delegation_scoped"] = true
				body["delegation_scope_size"] = len(ids)
			}
		}
	}

	response.Success(c, body, "Identity retrieved")
}

// ─── LOGOUT ────────────────────────────────────────────────────────────────

func (h *AuthHandler) Logout(c *gin.Context) {
	userID, _ := c.Get("user_id")
	uid, _ := userID.(string)
	h.auth.Logout(uid)
	// Signing out must also end the session's ability to EXTEND itself.
	// Without this the access token stops being used but its refresh token
	// stays live for days, so anything holding a copy could resurrect the
	// session after the operator believed they had signed out.
	if sid, ok := c.Get("session_id"); ok {
		if s, _ := sid.(string); s != "" {
			h.auth.RevokeRefreshTokensForSession(s, "user signed out")
		}
	}
	response.Success(c, nil, "Logged out")
}

// ─── REFRESH ───────────────────────────────────────────────────────────────

type refreshRequest struct {
	RefreshToken string `json:"refresh_token" binding:"required"`
}

// Refresh handles POST /api/v1/auth/refresh
//
// UNAUTHENTICATED BY DESIGN. The access token is expired by the time anyone
// needs this, so requiring one would make the endpoint unreachable exactly
// when it is needed. The refresh token IS the credential, which is why it is
// single-use, hashed at rest, and rotated on every redemption.
//
// Every failure is the same 401 with the same body. Distinguishing "unknown"
// from "expired" from "already used" would let a caller probe the token space.
func (h *AuthHandler) Refresh(c *gin.Context) {
	var req refreshRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "refresh_token is required")
		return
	}

	result, err := h.auth.RefreshSession(req.RefreshToken, c.ClientIP())
	if err != nil {
		h.log.Info("auth.refresh.rejected", zap.String("ip", c.ClientIP()), zap.Error(err))
		response.Error(c, http.StatusUnauthorized, "Your session has ended. Please sign in again.")
		return
	}

	response.Success(c, gin.H{
		"access_token":  result.AccessToken,
		"refresh_token": result.RefreshToken,
		"token_type":    result.TokenType,
		"session_id":    result.SessionID,
		"expires_at":    result.ExpiresAt,
	}, "Session extended")
}

// ─── HEALTH ────────────────────────────────────────────────────────────────

func (h *AuthHandler) Health(c *gin.Context) {
	userID, _ := c.Get("user_id")
	response.Success(c, gin.H{"status": "ok", "user_id": userID}, "PAM auth is healthy")
}
