// pam/internal/services/identity_service.go
//
// Identity Management: full lifecycle CRUD for PAM's own local user
// accounts, plus RBAC role assignment and PBAC direct-policy attachment.
// This is what the Admin Center's "Identity Management" screens call.
//
// PAM previously never created or modified users at all (an external IAM
// service owned that). This service is the whole reason that dependency
// could be removed.
package services

import (
	"errors"
	"fmt"
	"strings"

	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/pkg/argon2"
	"go.uber.org/zap"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrUsernameTaken  = errors.New("username is already taken")
	ErrEmailTaken     = errors.New("email is already registered")
	ErrUserProtected  = errors.New("this account is protected and cannot be modified this way")
	ErrRoleNotFound   = errors.New("role not found")
	ErrPolicyNotFound = errors.New("policy not found")
	ErrRoleIsSystem   = errors.New("system roles cannot be deleted")
	ErrPolicyIsSystem = errors.New("system policies cannot be deleted")
	ErrWeakPassword   = errors.New("password must be at least 10 characters")
)

type IdentityService struct {
	db     *gorm.DB
	logger *zap.Logger
}

func NewIdentityService(db *gorm.DB, logger *zap.Logger) *IdentityService {
	return &IdentityService{db: db, logger: logger}
}

// ── USER CRUD ────────────────────────────────────────────────────────────

type CreateUserInput struct {
	Username string
	Email    string
	FullName string
	Password string
	// RoleNames, if non-empty, are assigned immediately on creation (e.g.
	// ["user"]). Unknown role names are rejected — this creates the user
	// and its role assignments in one transaction so a caller can never end
	// up with a brand-new account that holds no role at all by accident.
	RoleNames []string
	CreatedBy string
}

func (s *IdentityService) ListUsers(search string) ([]models.User, error) {
	q := s.db.Order("created_at desc")
	if search != "" {
		like := "%" + strings.ToLower(search) + "%"
		q = q.Where("LOWER(username) LIKE ? OR LOWER(email) LIKE ? OR LOWER(full_name) LIKE ?", like, like, like)
	}
	var users []models.User
	if err := q.Find(&users).Error; err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	return users, nil
}

func (s *IdentityService) GetUser(userID string) (*models.User, error) {
	var u models.User
	if err := s.db.Where("user_id = ?", userID).First(&u).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrUserNotFound
		}
		return nil, err
	}
	return &u, nil
}

func (s *IdentityService) RoleNamesForUser(userID string) ([]string, error) {
	var roles []models.Role
	if err := s.db.
		Joins("JOIN pam_user_roles ON pam_user_roles.role_id = pam_roles.id").
		Where("pam_user_roles.user_id = ?", userID).
		Find(&roles).Error; err != nil {
		return nil, err
	}
	names := make([]string, 0, len(roles))
	for _, r := range roles {
		names = append(names, r.Name)
	}
	return names, nil
}

// AccountStatusForUser returns the account's current status, for
// middleware.LiveAccountStatus.
//
// Selects one indexed column rather than loading the row: this runs on every
// request that misses the middleware's short cache, and a full User has a
// password hash and MFA columns on it that have no business being read here.
//
// A missing row is reported as DELETED rather than as an error. A token whose
// subject no longer exists is exactly the case this check is for, and treating
// it as a lookup failure would fail open.
// ApproverUserIDs returns the accounts that can decide a JIT request, for the
// notification centre's fan-out.
//
// Active accounts holding root or admin. Filtering by status here rather than
// at the call site matters: notifying a disabled account puts work in a queue
// nobody is watching, and the request then looks attended to when it is not.
func (s *IdentityService) ApproverUserIDs() ([]string, error) {
	var ids []string
	err := s.db.Model(&models.User{}).
		Joins("JOIN pam_user_roles ON pam_user_roles.user_id = pam_users.id").
		Joins("JOIN pam_roles ON pam_roles.id = pam_user_roles.role_id").
		Where("pam_users.status = ?", "ACTIVE").
		Where("LOWER(pam_roles.name) IN (?)", []string{"root", "admin"}).
		Distinct().
		Pluck("pam_users.id", &ids).Error
	if err != nil {
		return nil, err
	}
	return ids, nil
}

func (s *IdentityService) AccountStatusForUser(userID string) (string, error) {
	var status string
	err := s.db.Model(&models.User{}).
		Where("id = ?", userID).
		Limit(1).
		Pluck("status", &status).Error
	if err != nil {
		return "", err
	}
	if status == "" {
		return "DELETED", nil
	}
	return status, nil
}

func (s *IdentityService) CreateUser(in CreateUserInput) (*models.User, error) {
	if len(in.Password) < 10 {
		return nil, ErrWeakPassword
	}
	hash, err := argon2.Hash(in.Password)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}

	var created models.User
	err = s.db.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&models.User{}).
			Where("username = ? OR email = ?", in.Username, in.Email).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			var existing models.User
			tx.Where("username = ?", in.Username).First(&existing)
			if existing.Username == in.Username {
				return ErrUsernameTaken
			}
			return ErrEmailTaken
		}

		u := models.User{
			Username:     in.Username,
			Email:        in.Email,
			FullName:     in.FullName,
			PasswordHash: &hash,
			Status:       "ACTIVE",
			CreatedBy:    in.CreatedBy,
		}
		if err := tx.Create(&u).Error; err != nil {
			return err
		}

		for _, roleName := range in.RoleNames {
			var role models.Role
			if err := tx.Where("name = ?", roleName).First(&role).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return fmt.Errorf("%w: %s", ErrRoleNotFound, roleName)
				}
				return err
			}
			if err := tx.Create(&models.UserRole{
				UserID: u.UserID, RoleID: role.ID, AssignedBy: in.CreatedBy,
			}).Error; err != nil {
				return err
			}
		}

		created = u
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.logger.Info("identity.user.created", zap.String("user_id", created.UserID), zap.String("username", created.Username))
	return &created, nil
}

type UpdateUserInput struct {
	FullName *string
	Email    *string
}

func (s *IdentityService) UpdateUser(userID string, in UpdateUserInput) (*models.User, error) {
	updates := map[string]interface{}{}
	if in.FullName != nil {
		updates["full_name"] = *in.FullName
	}
	if in.Email != nil {
		var count int64
		s.db.Model(&models.User{}).Where("email = ? AND user_id <> ?", *in.Email, userID).Count(&count)
		if count > 0 {
			return nil, ErrEmailTaken
		}
		updates["email"] = *in.Email
	}
	if len(updates) > 0 {
		if err := s.db.Model(&models.User{}).Where("user_id = ?", userID).Updates(updates).Error; err != nil {
			return nil, err
		}
	}
	return s.GetUser(userID)
}

// SetStatus drives the lifecycle: ACTIVE, DISABLED, or (rarely, manual
// unlock) ACTIVE from LOCKED. Refuses to touch a protected (root) account.
func (s *IdentityService) SetStatus(userID, status string) error {
	u, err := s.GetUser(userID)
	if err != nil {
		return err
	}
	if u.IsProtected && status != "ACTIVE" {
		return ErrUserProtected
	}
	updates := map[string]interface{}{"status": status}
	if status == "ACTIVE" {
		updates["locked_until"] = nil
		updates["failed_login_attempts"] = 0
	}
	return s.db.Model(&models.User{}).Where("user_id = ?", userID).Updates(updates).Error
}

// DeleteUser soft-deletes the account (GORM's DeletedAt) — the row (and its
// audit trail correlation via user_id) is preserved, it simply stops
// resolving as a valid login. Refuses to delete a protected account.
func (s *IdentityService) DeleteUser(userID string) error {
	u, err := s.GetUser(userID)
	if err != nil {
		return err
	}
	if u.IsProtected {
		return ErrUserProtected
	}
	return s.db.Where("user_id = ?", userID).Delete(&models.User{}).Error
}

// ResetPassword is an admin-triggered password reset (as distinct from a
// user's own self-service password change, which does not exist yet — see
// IMPLEMENTED_FEATURES.md's known-limitations section).
func (s *IdentityService) ResetPassword(userID, newPassword string) error {
	if len(newPassword) < 10 {
		return ErrWeakPassword
	}
	hash, err := argon2.Hash(newPassword)
	if err != nil {
		return err
	}
	return s.db.Model(&models.User{}).Where("user_id = ?", userID).Updates(map[string]interface{}{
		"password_hash":         hash,
		"failed_login_attempts": 0,
		"locked_until":          nil,
	}).Error
}

// ── ROLE ASSIGNMENT (RBAC) ───────────────────────────────────────────────

func (s *IdentityService) AssignRole(userID, roleName, assignedBy string) error {
	var role models.Role
	if err := s.db.Where("name = ?", roleName).First(&role).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrRoleNotFound
		}
		return err
	}
	// Idempotent: assigning a role the user already holds is a no-op success,
	// not a 409 — the caller almost always wants "make sure this is true",
	// not "tell me if it was already true."
	return s.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&models.UserRole{
		UserID: userID, RoleID: role.ID, AssignedBy: assignedBy,
	}).Error
}

func (s *IdentityService) RemoveRole(userID, roleName string) error {
	var role models.Role
	if err := s.db.Where("name = ?", roleName).First(&role).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrRoleNotFound
		}
		return err
	}
	return s.db.Where("user_id = ? AND role_id = ?", userID, role.ID).Delete(&models.UserRole{}).Error
}

// ── DIRECT POLICY ATTACHMENT (PBAC) ──────────────────────────────────────

func (s *IdentityService) AttachPolicy(userID, policyID, attachedBy string) error {
	var policy models.Policy
	if err := s.db.Where("id = ?", policyID).First(&policy).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPolicyNotFound
		}
		return err
	}
	return s.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&models.UserPolicy{
		UserID: userID, PolicyID: policyID, AttachedBy: attachedBy,
	}).Error
}

func (s *IdentityService) DetachPolicy(userID, policyID string) error {
	return s.db.Where("user_id = ? AND policy_id = ?", userID, policyID).Delete(&models.UserPolicy{}).Error
}

// EffectiveAccess is the read-model the Identity Management "user detail"
// screen renders: which roles, which policies came from where.
type EffectiveAccess struct {
	Roles          []models.Role   `json:"roles"`
	DirectPolicies []models.Policy `json:"direct_policies"`
	// RolePolicies maps role name -> policies that role grants, so the UI
	// can show provenance ("this action is allowed because of the 'admin'
	// role") instead of just a flattened, unexplained list.
	RolePolicies map[string][]models.Policy `json:"role_policies"`
}

func (s *IdentityService) GetEffectiveAccess(userID string) (*EffectiveAccess, error) {
	var roles []models.Role
	if err := s.db.
		Joins("JOIN pam_user_roles ON pam_user_roles.role_id = pam_roles.id").
		Where("pam_user_roles.user_id = ?", userID).
		Find(&roles).Error; err != nil {
		return nil, err
	}

	var direct []models.Policy
	if err := s.db.
		Joins("JOIN pam_user_policies ON pam_user_policies.policy_id = pam_policies.id").
		Where("pam_user_policies.user_id = ?", userID).
		Find(&direct).Error; err != nil {
		return nil, err
	}

	rolePolicies := make(map[string][]models.Policy, len(roles))
	for _, r := range roles {
		var policies []models.Policy
		if err := s.db.
			Joins("JOIN pam_role_policies ON pam_role_policies.policy_id = pam_policies.id").
			Where("pam_role_policies.role_id = ?", r.ID).
			Find(&policies).Error; err != nil {
			return nil, err
		}
		rolePolicies[r.Name] = policies
	}

	return &EffectiveAccess{Roles: roles, DirectPolicies: direct, RolePolicies: rolePolicies}, nil
}
