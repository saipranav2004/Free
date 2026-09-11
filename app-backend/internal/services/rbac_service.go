// pam/internal/services/rbac_service.go
//
// CRUD for Roles (RBAC) and Policies (PBAC) themselves — the Admin Center
// screens that let an administrator define what a role or policy IS. Who
// HOLDS a role/policy is identity_service.go's job (AssignRole/AttachPolicy);
// this file is about the roles/policies as first-class objects.
package services

import (
	"errors"
	"fmt"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ── ROLES ──────────────────────────────────────────────────────────────────

type RoleService struct {
	db     *gorm.DB
	logger *zap.Logger
}

func NewRoleService(db *gorm.DB, logger *zap.Logger) *RoleService {
	return &RoleService{db: db, logger: logger}
}

// List returns at most MaxUnpagedRows roles. See unpaged_limit.go.
func (s *RoleService) List() ([]models.Role, bool, error) {
	var roles []models.Role
	if err := s.db.Order("name asc").Limit(MaxUnpagedRows + 1).Find(&roles).Error; err != nil {
		return nil, false, fmt.Errorf("list roles: %w", err)
	}
	roles, truncated := capUnpaged(roles)
	return roles, truncated, nil
}

func (s *RoleService) Get(id string) (*models.Role, error) {
	var r models.Role
	if err := s.db.Where("id = ?", id).First(&r).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrRoleNotFound
		}
		return nil, err
	}
	return &r, nil
}

func (s *RoleService) Create(name, description string) (*models.Role, error) {
	var count int64
	s.db.Model(&models.Role{}).Where("name = ?", name).Count(&count)
	if count > 0 {
		return nil, fmt.Errorf("a role named %q already exists", name)
	}
	r := models.Role{Name: name, Description: description}
	if err := s.db.Create(&r).Error; err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *RoleService) Update(id, description string) (*models.Role, error) {
	if err := s.db.Model(&models.Role{}).Where("id = ?", id).Update("description", description).Error; err != nil {
		return nil, err
	}
	return s.Get(id)
}

// Delete refuses to remove a system role (root/admin/user) — see
// models.Role.IsSystem's doc comment for why.
func (s *RoleService) Delete(id string) error {
	role, err := s.Get(id)
	if err != nil {
		return err
	}
	if role.IsSystem {
		return ErrRoleIsSystem
	}
	return s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("role_id = ?", id).Delete(&models.UserRole{}).Error; err != nil {
			return err
		}
		if err := tx.Where("role_id = ?", id).Delete(&models.RolePolicy{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", id).Delete(&models.Role{}).Error
	})
}

// AttachPolicy / DetachPolicy manage which policies a role bundles.
func (s *RoleService) AttachPolicy(roleID, policyID string) error {
	return s.db.Clauses(clause.OnConflict{DoNothing: true}).
		Create(&models.RolePolicy{RoleID: roleID, PolicyID: policyID}).Error
}

func (s *RoleService) DetachPolicy(roleID, policyID string) error {
	return s.db.Where("role_id = ? AND policy_id = ?", roleID, policyID).Delete(&models.RolePolicy{}).Error
}

func (s *RoleService) ListPolicies(roleID string) ([]models.Policy, error) {
	var policies []models.Policy
	if err := s.db.
		Joins("JOIN pam_role_policies ON pam_role_policies.policy_id = pam_policies.id").
		Where("pam_role_policies.role_id = ?", roleID).
		Find(&policies).Error; err != nil {
		return nil, err
	}
	return policies, nil
}

// ── POLICIES ────────────────────────────────────────────────────────────────

type PolicyService struct {
	db     *gorm.DB
	logger *zap.Logger
}

func NewPolicyService(db *gorm.DB, logger *zap.Logger) *PolicyService {
	return &PolicyService{db: db, logger: logger}
}

// List returns at most MaxUnpagedRows policies. See unpaged_limit.go.
func (s *PolicyService) List() ([]models.Policy, bool, error) {
	var policies []models.Policy
	if err := s.db.Order("name asc").Limit(MaxUnpagedRows + 1).Find(&policies).Error; err != nil {
		return nil, false, fmt.Errorf("list policies: %w", err)
	}
	policies, truncated := capUnpaged(policies)
	return policies, truncated, nil
}

func (s *PolicyService) Get(id string) (*models.Policy, error) {
	var p models.Policy
	if err := s.db.Where("id = ?", id).First(&p).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPolicyNotFound
		}
		return nil, err
	}
	return &p, nil
}

type CreatePolicyInput struct {
	Name        string
	Description string
	Effect      string // "allow" | "deny"
	Actions     []string
	Resources   []string
}

func (in CreatePolicyInput) validate() error {
	if in.Effect != string(models.PolicyEffectAllow) && in.Effect != string(models.PolicyEffectDeny) {
		return fmt.Errorf("effect must be %q or %q", models.PolicyEffectAllow, models.PolicyEffectDeny)
	}
	if len(in.Actions) == 0 {
		return errors.New("at least one action pattern is required (use \"*\" for all actions)")
	}
	if len(in.Resources) == 0 {
		return errors.New("at least one resource pattern is required (use \"*\" for all resources)")
	}
	return nil
}

func (s *PolicyService) Create(in CreatePolicyInput) (*models.Policy, error) {
	if err := in.validate(); err != nil {
		return nil, err
	}
	var count int64
	s.db.Model(&models.Policy{}).Where("name = ?", in.Name).Count(&count)
	if count > 0 {
		return nil, fmt.Errorf("a policy named %q already exists", in.Name)
	}
	p := models.Policy{
		Name: in.Name, Description: in.Description, Effect: in.Effect,
		Actions: in.Actions, Resources: in.Resources,
	}
	if err := s.db.Create(&p).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

type UpdatePolicyInput struct {
	Description *string
	Effect      *string
	Actions     []string
	Resources   []string
}

func (s *PolicyService) Update(id string, in UpdatePolicyInput) (*models.Policy, error) {
	p, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if p.IsSystem {
		// System policies may be retuned (e.g. narrowing the default user
		// policy later) but their identity (name/effect shape) is left
		// alone here for simplicity — description/actions/resources are
		// the safe, expected knobs to turn.
	}
	if in.Description != nil {
		p.Description = *in.Description
	}
	if in.Effect != nil {
		if *in.Effect != string(models.PolicyEffectAllow) && *in.Effect != string(models.PolicyEffectDeny) {
			return nil, fmt.Errorf("effect must be %q or %q", models.PolicyEffectAllow, models.PolicyEffectDeny)
		}
		p.Effect = *in.Effect
	}
	if in.Actions != nil {
		p.Actions = in.Actions
	}
	if in.Resources != nil {
		p.Resources = in.Resources
	}
	if err := s.db.Save(p).Error; err != nil {
		return nil, err
	}
	return p, nil
}

func (s *PolicyService) Delete(id string) error {
	p, err := s.Get(id)
	if err != nil {
		return err
	}
	if p.IsSystem {
		return ErrPolicyIsSystem
	}
	return s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("policy_id = ?", id).Delete(&models.RolePolicy{}).Error; err != nil {
			return err
		}
		if err := tx.Where("policy_id = ?", id).Delete(&models.UserPolicy{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", id).Delete(&models.Policy{}).Error
	})
}
