// pam/internal/services/mfa_admin.go
//
// ADMINISTRATIVE MFA RESET — the recovery path for a lost authenticator.
//
// Methods on MFAPolicyService (same package, split by concern): mfa_policy.go
// decides who MUST have a second factor, this file deals with removing one
// that can no longer be used.
//
// WHY THIS HAS TO EXIST BEFORE ENFORCEMENT IS SWITCHED ON. A user whose phone
// is lost or wiped cannot sign in: login sees an ACTIVE device and demands a
// code they can no longer produce, and every self-service route is behind that
// same login. Backup codes cover the case where the user kept them; this
// covers the case where they did not. Without both, "enforce" means "one lost
// phone is a permanent lockout" — Entra ("Require re-register MFA") and Okta
// ("Reset multifactor") both ship this for exactly that reason.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not enrol a new factor, and it
// does not hand the operator anything they could use to sign in as the target.
// It removes the device and nothing else: the user's next sign-in is
// password-only, and if a policy rule gates their role they land straight in
// the enrolment interrupt. The operator never touches a secret, which is what
// keeps this from being an account-takeover primitive.
package services

import (
	"errors"
	"fmt"
	"strings"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	// ErrMFAResetForbidden — the actor may not reset THIS target.
	ErrMFAResetForbidden = errors.New("not permitted to reset multi-factor authentication for this account")
	// ErrMFAResetNoDevice — nothing to reset.
	ErrMFAResetNoDevice = errors.New("this account has no multi-factor device to reset")
	// ErrMFAResetReason — reason is mandatory.
	ErrMFAResetReason = errors.New("a reason is required")
)

// ErrPasswordResetForbidden, the actor may not reset THIS target's password.
var ErrPasswordResetForbidden = errors.New("not permitted to reset the password for this account")

// CanResetPassword answers the same question as CanResetMFA, for the same
// reason, and deliberately shares its body.
//
// SETTING SOMEONE'S PASSWORD IS TAKING THEIR ACCOUNT. That was true here in
// the most literal sense: the reset endpoint checked only that the new password
// was ten characters long and then wrote it, so any administrator could set
// root's password and sign in as root. On a fresh install, where root has not
// enrolled a second factor yet, that is a complete takeover of the product by
// anyone holding admin, and it defeated every other rule in the codebase that
// carefully keeps root above admin: root-only vault export, root-only wildcard
// grants, only root delegates admin.
//
// Resetting a second factor was already guarded this way. Nothing about a
// password makes it less of a credential, so it now goes through the same rule
// rather than a weaker one that happens to sit on a different route.
func CanResetPassword(actorRoles, targetRoles []string, targetProtected bool) bool {
	return CanResetMFA(actorRoles, targetRoles, targetProtected)
}

// CanResetMFA is the authorisation rule, kept pure and separate because it is
// the entire risk surface of this endpoint — see the table on ResetUserMFA.
//
//	target holds root / admin, or is protected → root only
//	anyone else                                → admin or root
//
// The caller is already behind RequireAdmin, so "not root and not admin" does
// not arise in production; it is still answered correctly here rather than
// assumed, because a helper that is only correct in context is a trap for the
// next caller.
func CanResetMFA(actorRoles, targetRoles []string, targetProtected bool) bool {
	actorIsRoot := hasRoleNamed(actorRoles, RoleRoot)
	actorIsAdmin := hasRoleNamed(actorRoles, RoleAdmin)
	if !actorIsRoot && !actorIsAdmin {
		return false
	}
	targetPrivileged := targetProtected ||
		hasRoleNamed(targetRoles, RoleRoot) ||
		hasRoleNamed(targetRoles, RoleAdmin)
	if targetPrivileged {
		return actorIsRoot
	}
	return true
}

type ResetMFAInput struct {
	TargetUserID string
	ActorID      string
	ActorRoles   []string
	Reason       string
}

type ResetMFAResult struct {
	UserID          string   `json:"user_id"`
	Username        string   `json:"username"`
	DevicesRemoved  int      `json:"devices_removed"`
	EnrollmentDue   bool     `json:"enrollment_due"`
	GatedByRoles    []string `json:"gated_by_roles,omitempty"`
	ReloginRequired bool     `json:"relogin_required"`
}

// ResetUserMFA removes every MFA device on the target account.
//
// AUTHORISATION, which is the whole risk surface of this endpoint:
//
//	target holds root   → root only
//	target holds admin  → root only
//	target is protected → root only
//	anyone else         → admin or root
//
// The asymmetry is the point. Resetting an administrator's second factor
// downgrades a privileged account's protection, so it sits at the same
// privilege level as granting that account admin in the first place — root.
// (It is not a full takeover on its own: the password is still required. But
// "attacker with a stolen admin password" is precisely the scenario the second
// factor exists for, and an ordinary admin should not be able to strip it.)
func (s *MFAPolicyService) ResetUserMFA(in ResetMFAInput) (*ResetMFAResult, error) {
	if strings.TrimSpace(in.Reason) == "" {
		return nil, ErrMFAResetReason
	}
	if strings.TrimSpace(in.TargetUserID) == "" {
		return nil, ErrUserNotFound
	}

	var target models.User
	if err := s.db.Where("user_id = ?", in.TargetUserID).First(&target).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrUserNotFound
		}
		return nil, err
	}

	targetRoles, err := s.roles.RoleNamesForUser(target.UserID)
	if err != nil {
		// FAIL CLOSED. If the target's roles cannot be resolved we cannot know
		// whether this is a privileged account, and "assume it is ordinary"
		// would be the wrong guess to make with a security control.
		s.logger.Error("mfa_reset.resolve_target_roles.fail",
			zap.String("target", target.UserID), zap.Error(err))
		return nil, fmt.Errorf("could not resolve the account's roles: %w", err)
	}

	if !CanResetMFA(in.ActorRoles, targetRoles, target.IsProtected) {
		s.logger.Warn("mfa_reset.denied",
			zap.String("actor", in.ActorID),
			zap.String("target", target.UserID),
			zap.Strings("target_roles", targetRoles))
		return nil, ErrMFAResetForbidden
	}

	// Delete unconditionally, not just ACTIVE ones: a half-finished PENDING
	// enrolment left behind would be adopted by the next SetupMFAVerify call,
	// so clearing "the account's MFA" has to mean all of it.
	res := s.db.Unscoped().Where("user_id = ?", target.UserID).Delete(&models.PAMMFA{})
	if res.Error != nil {
		return nil, res.Error
	}
	removed := int(res.RowsAffected)
	if removed == 0 {
		return nil, ErrMFAResetNoDevice
	}

	if err := s.db.Model(&models.User{}).Where("user_id = ?", target.UserID).
		Update("mfa_enabled", false).Error; err != nil {
		// The devices are already gone, so this is a reporting inconsistency,
		// not a failed reset — log it and carry on rather than telling the
		// operator the reset failed when it did not.
		s.logger.Error("mfa_reset.flag_update.fail",
			zap.String("target", target.UserID), zap.Error(err))
	}

	// Will they be forced to re-enrol at the next sign-in? That is the policy
	// question, and the operator wants the answer in the confirmation rather
	// than having to reason about it.
	gatedBy := []string{}
	if rules, rErr := s.rulesByRole(); rErr == nil {
		for _, role := range targetRoles {
			if rule, ok := rules[strings.ToLower(role)]; ok && rule.Mode != MFAModeOff {
				gatedBy = append(gatedBy, role)
			}
		}
	}

	// Logged at Warn: an MFA reset is a security-relevant downgrade and should
	// stand out in the log even when it is entirely routine. The reason is
	// carried so the audit trail answers "why" without a second lookup.
	s.logger.Warn("mfa_reset.performed",
		zap.String("actor", in.ActorID),
		zap.String("target", target.UserID),
		zap.String("target_username", target.Username),
		zap.Int("devices_removed", removed),
		zap.Strings("gated_by", gatedBy),
		zap.String("reason", in.Reason))

	return &ResetMFAResult{
		UserID:          target.UserID,
		Username:        target.Username,
		DevicesRemoved:  removed,
		EnrollmentDue:   len(gatedBy) > 0,
		GatedByRoles:    gatedBy,
		ReloginRequired: true,
	}, nil
}
