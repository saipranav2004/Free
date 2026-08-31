// pam/internal/services/auth_refresh.go
//
// Redeeming a refresh token for a new access token.
//
// Read models/refresh_token.go first for why the table exists and what
// rotation buys. This file is the write and redeem paths around it.
//
// WHAT THIS FIXES. Login returned a refresh_token that nothing stored and no
// endpoint accepted. With a thirty minute access token, every console session
// ended abruptly at the thirty minute mark on the sign-in page. The operator
// had done nothing wrong and there was no way to stay signed in short of
// raising the access token's lifetime, which is the wrong lever: a long access
// token cannot be revoked, and revocation is the whole point of a PAM.
package services

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	// ErrRefreshInvalid covers unknown, malformed, expired and revoked tokens
	// as ONE error on purpose. Telling a caller which of those it was tells an
	// attacker whether a guessed token ever existed.
	ErrRefreshInvalid = errors.New("refresh token is not valid")
	// ErrRefreshReused is separate internally so the reuse path can revoke the
	// chain and log at WARN. The HTTP layer still reports it as invalid.
	ErrRefreshReused = errors.New("refresh token has already been redeemed")
)

func hashRefreshToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// recordRefreshToken persists the hash of a freshly issued refresh token.
//
// Failures are logged and swallowed: a login that has otherwise succeeded must
// not be failed because the row that would have let it be EXTENDED could not be
// written. The session simply behaves the way it did before this existed, and
// ends when the access token does.
func (s *AuthService) recordRefreshToken(in models.RefreshToken) {
	if strings.TrimSpace(in.TokenHash) == "" {
		return
	}
	if in.ID == "" {
		in.ID = uuid.NewString()
	}
	if err := s.db.Create(&in).Error; err != nil {
		s.logger.Warn("refresh.persist.fail",
			zap.String("user_id", in.UserID), zap.Error(err))
	}
}

// RefreshSession redeems a refresh token for a new access token and a new
// refresh token.
//
// The account is re-read on every redemption rather than trusted from the old
// token, so a suspended, deleted or locked account cannot extend its own
// session, and role changes take effect on the next refresh rather than at the
// next sign-in.
func (s *AuthService) RefreshSession(rawToken, clientIP string) (*LoginResult, error) {
	rawToken = strings.TrimSpace(rawToken)
	if rawToken == "" {
		return nil, ErrRefreshInvalid
	}

	var row models.RefreshToken
	err := s.db.Where("token_hash = ?", hashRefreshToken(rawToken)).First(&row).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrRefreshInvalid
		}
		return nil, fmt.Errorf("refresh.lookup: %w", err)
	}

	now := time.Now().UTC()

	// REUSE DETECTION. A token that has already been replaced coming back is
	// either a buggy client racing itself or a stolen token being replayed,
	// and nothing here can tell those apart. Both are answered the same way:
	// kill every refresh token for the session, so the legitimate holder is
	// signed out too and has to prove who they are again.
	if row.ReplacedByID != nil {
		s.logger.Warn("refresh.reuse.detected",
			zap.String("user_id", row.UserID),
			zap.String("session_id", row.SessionID),
			zap.String("ip", clientIP),
		)
		s.RevokeRefreshTokensForSession(row.SessionID, "refresh token reuse detected")
		return nil, ErrRefreshReused
	}

	if !row.Usable(now) {
		return nil, ErrRefreshInvalid
	}

	var user models.User
	if err := s.db.Where("user_id = ?", row.UserID).First(&user).Error; err != nil {
		return nil, ErrRefreshInvalid
	}
	// Re-checked on every refresh, not just at sign-in. A refresh is a new
	// session decision, so an account that has since been suspended, deleted
	// or locked must not be able to extend itself.
	if user.Status != "ACTIVE" {
		s.RevokeRefreshTokensForSession(row.SessionID, "account is no longer active")
		return nil, ErrRefreshInvalid
	}
	if user.LockedUntil != nil && user.LockedUntil.After(now) {
		return nil, ErrRefreshInvalid
	}

	// Roles are re-resolved, so a role removed five minutes ago is gone from
	// the next access token rather than surviving until the operator signs out.
	roles, rerr := s.roles.RoleNamesForUser(user.UserID)
	if rerr != nil {
		s.logger.Error("refresh.resolve_roles.fail", zap.String("user_id", user.UserID), zap.Error(rerr))
		roles = []string{}
	}

	accountID := ""
	if user.AccountID != nil {
		accountID = *user.AccountID
	}

	// The session id is CARRIED, not minted. Everything hung off a session
	// (recordings, brokered web sessions, the audit trail) stays one session
	// across a refresh, which is what makes a refreshed session still killable
	// as the same thing an administrator was looking at.
	accessToken, _, expiresAt, err := s.jwt.IssueAccessToken(
		user.UserID, user.Username, user.Email, accountID,
		row.MFAVerified, roles, row.SessionID, row.EnrolmentOnly,
	)
	if err != nil {
		return nil, fmt.Errorf("refresh.issue_access: %w", err)
	}

	next := s.jwt.IssueRefreshToken()
	nextRow := models.RefreshToken{
		ID:            uuid.NewString(),
		TokenHash:     hashRefreshToken(next),
		UserID:        user.UserID,
		SessionID:     row.SessionID,
		MFAVerified:   row.MFAVerified,
		EnrolmentOnly: row.EnrolmentOnly,
		// The window does NOT slide forever: the new token inherits the
		// original chain's expiry, so a session cannot be kept alive
		// indefinitely by refreshing just before each deadline. Signing in
		// again is what starts a new window.
		ExpiresAt: row.ExpiresAt,
		CreatedIP: clientIP,
	}

	// One transaction: the old token is only spent if the new one exists.
	txErr := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&nextRow).Error; err != nil {
			return err
		}
		// Conditional on replaced_by_id still being NULL, so two concurrent
		// redemptions of the same token cannot both succeed: the loser updates
		// zero rows and is rolled back into a reuse.
		res := tx.Model(&models.RefreshToken{}).
			Where("id = ? AND replaced_by_id IS NULL", row.ID).
			Update("replaced_by_id", nextRow.ID)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrRefreshReused
		}
		return nil
	})
	if txErr != nil {
		if errors.Is(txErr, ErrRefreshReused) {
			s.RevokeRefreshTokensForSession(row.SessionID, "concurrent refresh token redemption")
			return nil, ErrRefreshReused
		}
		return nil, fmt.Errorf("refresh.rotate: %w", txErr)
	}

	s.logger.Info("refresh.success",
		zap.String("user_id", user.UserID),
		zap.String("session_id", row.SessionID),
		zap.String("ip", clientIP),
	)

	return &LoginResult{
		AccessToken:  accessToken,
		RefreshToken: next,
		TokenType:    "Bearer",
		SessionID:    row.SessionID,
		ExpiresAt:    expiresAt,
	}, nil
}

// RevokeRefreshTokensForSession ends a session's ability to extend itself.
// Called on sign-out and on reuse detection.
func (s *AuthService) RevokeRefreshTokensForSession(sessionID, reason string) {
	if strings.TrimSpace(sessionID) == "" {
		return
	}
	now := time.Now().UTC()
	err := s.db.Model(&models.RefreshToken{}).
		Where("session_id = ? AND revoked_at IS NULL", sessionID).
		Update("revoked_at", now).Error
	if err != nil {
		s.logger.Warn("refresh.revoke.fail",
			zap.String("session_id", sessionID), zap.String("reason", reason), zap.Error(err))
		return
	}
	s.logger.Info("refresh.revoked",
		zap.String("session_id", sessionID), zap.String("reason", reason))
}

// RevokeRefreshTokensForUser ends every session an account can extend. Used
// when an account is suspended, deleted or has its password reset.
func (s *AuthService) RevokeRefreshTokensForUser(userID, reason string) {
	if strings.TrimSpace(userID) == "" {
		return
	}
	now := time.Now().UTC()
	if err := s.db.Model(&models.RefreshToken{}).
		Where("user_id = ? AND revoked_at IS NULL", userID).
		Update("revoked_at", now).Error; err != nil {
		s.logger.Warn("refresh.revoke_user.fail",
			zap.String("user_id", userID), zap.Error(err))
		return
	}
	s.logger.Info("refresh.revoked_user",
		zap.String("user_id", userID), zap.String("reason", reason))
}
