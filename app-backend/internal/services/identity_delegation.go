package services

// pam/internal/services/identity_delegation.go
//
// Admin delegation — ADDITIVE methods on IdentityService.
// Drop next to identity_service.go.
//
// Only root (role rank 100) may grant or revoke the admin role via this API.
// Admins cannot mint further admins. Prefer this path over plain AssignRole
// for admin grants so every elevation is reasoned, audited, and revocable.

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ---------------------------------------------------------------------------
// Sentinel errors (used by identity_delegation_handler.go)
// ---------------------------------------------------------------------------

var (
	ErrDelegationForbidden = errors.New("actor is not permitted to delegate admin access")
	ErrDelegationConflict  = errors.New("user already has an active admin delegation")
	ErrDelegationNotFound  = errors.New("no active admin delegation for user")
	ErrInvalidScope        = errors.New("one or more scope_resource_ids are invalid")
)

// ---------------------------------------------------------------------------
// Role names + ranks
// ---------------------------------------------------------------------------

const (
	RoleRoot  = "root"
	RoleAdmin = "admin"
	RoleUser  = "user"
)

// RoleRank returns privilege rank. Unknown roles rank 0.
func RoleRank(role string) int {
	switch role {
	case RoleRoot:
		return 100
	case RoleAdmin:
		return 80
	case RoleUser:
		return 10
	default:
		return 0
	}
}

// MinRankToDelegateAdmin — root only. Only root may grant/revoke admin.
const MinRankToDelegateAdmin = 100

// DelegatedRoleName is the role granted by the admin-delegation API.
const DelegatedRoleName = RoleAdmin

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

type DelegateAdminInput struct {
	TargetUserID     string
	ActorID          string
	Reason           string
	ScopeResourceIDs []string
	ExpiresAt        *time.Time
}

type DelegationResult struct {
	UserID           string     `json:"user_id"`
	DelegatedRole    string     `json:"delegated_role"`
	DelegatedBy      string     `json:"delegated_by"`
	Reason           string     `json:"reason"`
	ScopeResourceIDs []string   `json:"scope_resource_ids,omitempty"`
	ExpiresAt        *time.Time `json:"expires_at,omitempty"`
	DelegatedAt      time.Time  `json:"delegated_at"`
}

type RevokeDelegationInput struct {
	TargetUserID string
	ActorID      string
	Reason       string
}

// AdminDelegation is the GET .../delegation response body.
//
// The *Username fields exist because the console renders this card to a human.
// The record stores actor UUIDs — correct for the data model, useless on a
// screen: "Granted by 8f14e45f-…" tells an administrator nothing about who
// actually did it. The IDs are still returned alongside, so anything that
// needs to link or correlate still can.
type AdminDelegation struct {
	UserID              string     `json:"user_id"`
	Active              bool       `json:"active"`
	DelegatedRole       string     `json:"delegated_role,omitempty"`
	DelegatedBy         string     `json:"delegated_by,omitempty"`
	DelegatedByUsername string     `json:"delegated_by_username,omitempty"`
	Reason              string     `json:"reason,omitempty"`
	ScopeResourceIDs    []string   `json:"scope_resource_ids,omitempty"`
	ExpiresAt           *time.Time `json:"expires_at,omitempty"`
	DelegatedAt         *time.Time `json:"delegated_at,omitempty"`
	RevokedAt           *time.Time `json:"revoked_at,omitempty"`
	RevokedBy           string     `json:"revoked_by,omitempty"`
	RevokedByUsername   string     `json:"revoked_by_username,omitempty"`
	RevokeReason        string     `json:"revoke_reason,omitempty"`
	Status              string     `json:"status"` // none | active | expired | revoked
}

// AdminDelegationRecord is the lifecycle table (AutoMigrate on first use).
type AdminDelegationRecord struct {
	ID               string `gorm:"type:uuid;primaryKey" json:"id"`
	UserID           string `gorm:"type:uuid;index;not null" json:"user_id"`
	DelegatedBy      string `gorm:"type:uuid;not null" json:"delegated_by"`
	Reason           string `gorm:"type:text;not null" json:"reason"`
	ScopeResourceIDs string `gorm:"type:text" json:"scope_resource_ids"` // comma-separated
	ExpiresAt        *time.Time
	DelegatedAt      time.Time `gorm:"not null"`
	RevokedAt        *time.Time
	RevokedBy        *string `gorm:"type:uuid"`
	RevokeReason     string  `gorm:"type:text"`
	Status           string  `gorm:"type:varchar(32);not null;index"`
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

func (AdminDelegationRecord) TableName() string { return "pam_admin_delegations" }

// ---------------------------------------------------------------------------
// DelegateAdmin — root only → grants role "admin"
// ---------------------------------------------------------------------------

func (s *IdentityService) DelegateAdmin(in DelegateAdminInput) (*DelegationResult, error) {
	if strings.TrimSpace(in.TargetUserID) == "" || strings.TrimSpace(in.ActorID) == "" {
		return nil, fmt.Errorf("target and actor are required")
	}
	if strings.TrimSpace(in.Reason) == "" {
		return nil, fmt.Errorf("reason is required")
	}
	if err := s.ensureDelegationTable(); err != nil {
		return nil, err
	}

	// Target must exist and must not be protected (root).
	target, err := s.GetUser(in.TargetUserID)
	if err != nil {
		return nil, err
	}
	if target.IsProtected {
		return nil, fmt.Errorf("%w: cannot delegate over a protected account", ErrUserProtected)
	}

	// Actor must be root.
	actorRank, err := s.maxRoleRank(in.ActorID)
	if err != nil {
		return nil, err
	}
	if actorRank < MinRankToDelegateAdmin {
		return nil, fmt.Errorf("%w: requires root (rank >= %d), actor rank=%d",
			ErrDelegationForbidden, MinRankToDelegateAdmin, actorRank)
	}

	if len(in.ScopeResourceIDs) > 0 {
		if err := s.validateResourceIDs(in.ScopeResourceIDs); err != nil {
			return nil, err
		}
	}

	roles, err := s.RoleNamesForUser(in.TargetUserID)
	if err != nil {
		return nil, err
	}
	hasAdmin := containsStr(roles, RoleAdmin)

	// Already admin with an active delegation record → conflict.
	// Already admin without going through this API → still conflict (use revoke first if re-delegating).
	if hasAdmin {
		return nil, fmt.Errorf("%w: user already has the admin role", ErrDelegationConflict)
	}

	// Active delegation row without role (inconsistent) → conflict.
	if active, _ := s.hasActiveDelegation(in.TargetUserID); active {
		return nil, ErrDelegationConflict
	}

	// Ensure system admin role exists.
	if _, err := s.ensureAdminRole(); err != nil {
		return nil, err
	}

	now := time.Now().UTC()

	err = s.db.Transaction(func(tx *gorm.DB) error {
		// Baseline user role — admin still needs standard self-service paths.
		if !containsStr(roles, RoleUser) {
			if err := s.assignRoleTx(tx, in.TargetUserID, RoleUser, in.ActorID); err != nil {
				return err
			}
		}
		if err := s.assignRoleTx(tx, in.TargetUserID, RoleAdmin, in.ActorID); err != nil {
			return err
		}

		// Supersede any leftover active rows.
		_ = tx.Model(&AdminDelegationRecord{}).
			Where("user_id = ? AND status = ?", in.TargetUserID, "active").
			Updates(map[string]interface{}{
				"status":        "revoked",
				"revoked_at":    now,
				"revoke_reason": "superseded",
				"updated_at":    now,
			}).Error

		rec := AdminDelegationRecord{
			ID:               uuid.New().String(),
			UserID:           in.TargetUserID,
			DelegatedBy:      in.ActorID,
			Reason:           in.Reason,
			ScopeResourceIDs: strings.Join(in.ScopeResourceIDs, ","),
			ExpiresAt:        in.ExpiresAt,
			DelegatedAt:      now,
			Status:           "active",
			CreatedAt:        now,
			UpdatedAt:        now,
		}
		return tx.Create(&rec).Error
	})
	if err != nil {
		return nil, err
	}

	s.logger.Info("identity.admin_delegated",
		zap.String("actor_id", in.ActorID),
		zap.String("target_user_id", in.TargetUserID),
		zap.String("delegated_role", DelegatedRoleName),
	)

	return &DelegationResult{
		UserID:           in.TargetUserID,
		DelegatedRole:    DelegatedRoleName,
		DelegatedBy:      in.ActorID,
		Reason:           in.Reason,
		ScopeResourceIDs: in.ScopeResourceIDs,
		ExpiresAt:        in.ExpiresAt,
		DelegatedAt:      now,
	}, nil
}

// ---------------------------------------------------------------------------
// RevokeAdminDelegation — root only → removes role "admin"
// ---------------------------------------------------------------------------

func (s *IdentityService) RevokeAdminDelegation(in RevokeDelegationInput) error {
	if strings.TrimSpace(in.Reason) == "" {
		return fmt.Errorf("reason is required")
	}
	if err := s.ensureDelegationTable(); err != nil {
		return err
	}

	target, err := s.GetUser(in.TargetUserID)
	if err != nil {
		return err
	}
	if target.IsProtected {
		return ErrUserProtected
	}

	actorRank, err := s.maxRoleRank(in.ActorID)
	if err != nil {
		return err
	}
	if actorRank < MinRankToDelegateAdmin {
		return fmt.Errorf("%w: requires root (rank >= %d)", ErrDelegationForbidden, MinRankToDelegateAdmin)
	}

	roles, err := s.RoleNamesForUser(in.TargetUserID)
	if err != nil {
		return err
	}
	hasAdmin := containsStr(roles, RoleAdmin)
	active, _ := s.hasActiveDelegation(in.TargetUserID)
	if !hasAdmin && !active {
		return ErrDelegationNotFound
	}

	now := time.Now().UTC()
	actor := in.ActorID

	return s.db.Transaction(func(tx *gorm.DB) error {
		if hasAdmin {
			if err := s.removeRoleTx(tx, in.TargetUserID, RoleAdmin); err != nil {
				return err
			}
		}
		return tx.Model(&AdminDelegationRecord{}).
			Where("user_id = ? AND status = ?", in.TargetUserID, "active").
			Updates(map[string]interface{}{
				"status":        "revoked",
				"revoked_at":    now,
				"revoked_by":    actor,
				"revoke_reason": in.Reason,
				"updated_at":    now,
			}).Error
	})
}

// ---------------------------------------------------------------------------
// GetAdminDelegation
// ---------------------------------------------------------------------------

// DelegationScopeFor answers the one question the enforcement layer asks:
// "is this administrator confined to a set of resources, and which?"
//
// WHY THIS EXISTS. scope_resource_ids was accepted by the API, validated
// against the resource table, stored, echoed back and rendered in the console,
// and then read by nothing. A delegation created as "admin, but only for these
// three databases" produced an administrator with the whole estate. The field
// was a promise the system did not keep, which is worse than not offering it:
// somebody scoping a delegation believes they have limited a blast radius.
//
// Returns (nil, false) for an account that is not a scoped delegate, which is
// every root, every seeded admin, and every delegation created without a
// scope. Those callers are unaffected: an empty scope means "the role default
// resource set", exactly as the API has always documented.
func (s *IdentityService) DelegationScopeFor(userID string) ([]string, bool, error) {
	if strings.TrimSpace(userID) == "" {
		return nil, false, nil
	}
	if err := s.ensureDelegationTable(); err != nil {
		return nil, false, err
	}

	var rec AdminDelegationRecord
	err := s.db.Where("user_id = ? AND status = ?", userID, "active").
		Order("delegated_at DESC").
		First(&rec).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, false, nil
		}
		return nil, false, err
	}

	// An expired delegation is not a scope, it is an absence of one. The row
	// is left for GetAdminDelegation to transition and record.
	if rec.ExpiresAt != nil && !rec.ExpiresAt.After(time.Now().UTC()) {
		return nil, false, nil
	}
	if strings.TrimSpace(rec.ScopeResourceIDs) == "" {
		return nil, false, nil
	}

	ids := make([]string, 0, 4)
	for _, id := range strings.Split(rec.ScopeResourceIDs, ",") {
		if id = strings.TrimSpace(id); id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil, false, nil
	}
	return ids, true, nil
}

func (s *IdentityService) GetAdminDelegation(userID string) (*AdminDelegation, error) {
	if err := s.ensureDelegationTable(); err != nil {
		return nil, err
	}
	if _, err := s.GetUser(userID); err != nil {
		return nil, err
	}

	var rec AdminDelegationRecord
	err := s.db.Where("user_id = ?", userID).Order("delegated_at DESC").First(&rec).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &AdminDelegation{UserID: userID, Active: false, Status: "none"}, nil
		}
		return nil, err
	}

	status := rec.Status
	active := status == "active"
	if active && rec.ExpiresAt != nil && !rec.ExpiresAt.After(time.Now().UTC()) {
		status = "expired"
		active = false
		_ = s.db.Model(&rec).Updates(map[string]interface{}{
			"status":     "expired",
			"updated_at": time.Now().UTC(),
		}).Error
	}

	da := rec.DelegatedAt
	var scope []string
	if rec.ScopeResourceIDs != "" {
		scope = strings.Split(rec.ScopeResourceIDs, ",")
	}

	revokedBy := ""
	if rec.RevokedBy != nil {
		revokedBy = *rec.RevokedBy
	}
	// One query for both actors rather than two lookups, and a miss is not an
	// error: an operator whose account was deleted since should still leave a
	// readable record behind — the ID is returned either way.
	names := s.usernamesByID(rec.DelegatedBy, revokedBy)

	return &AdminDelegation{
		UserID:              userID,
		Active:              active,
		DelegatedRole:       DelegatedRoleName,
		DelegatedBy:         rec.DelegatedBy,
		DelegatedByUsername: names[rec.DelegatedBy],
		Reason:              rec.Reason,
		ScopeResourceIDs:    scope,
		ExpiresAt:           rec.ExpiresAt,
		DelegatedAt:         &da,
		RevokedAt:           rec.RevokedAt,
		RevokedBy:           revokedBy,
		RevokedByUsername:   names[revokedBy],
		RevokeReason:        rec.RevokeReason,
		Status:              status,
	}, nil
}

// usernamesByID maps actor IDs to usernames for display. Unknown or empty IDs
// simply do not appear in the result.
func (s *IdentityService) usernamesByID(ids ...string) map[string]string {
	out := map[string]string{}
	wanted := make([]string, 0, len(ids))
	for _, id := range ids {
		if strings.TrimSpace(id) != "" {
			wanted = append(wanted, id)
		}
	}
	if len(wanted) == 0 {
		return out
	}
	var rows []models.User
	if err := s.db.Select("user_id", "username").Where("user_id IN ?", wanted).Find(&rows).Error; err != nil {
		s.logger.Warn("identity.delegation.resolve_usernames.fail", zap.Error(err))
		return out
	}
	for _, u := range rows {
		out[u.UserID] = u.Username
	}
	return out
}

// AssertCanAssignRole blocks granting admin/root via plain AssignRole.
// Admin must be granted through POST .../delegate-admin (root only).
func (s *IdentityService) AssertCanAssignRole(actorID, roleName string) error {
	rank := RoleRank(roleName)
	if rank < RoleRank(RoleAdmin) {
		return nil // user / custom roles — OK under normal admin flows
	}
	actorRank, err := s.maxRoleRank(actorID)
	if err != nil {
		return err
	}
	if actorRank <= rank {
		return fmt.Errorf("%w: cannot assign %q (role rank %d, actor rank %d)",
			ErrDelegationForbidden, roleName, rank, actorRank)
	}
	if roleName == RoleAdmin {
		return fmt.Errorf("%w: assign admin via POST .../delegate-admin", ErrDelegationForbidden)
	}
	if roleName == RoleRoot {
		return fmt.Errorf("%w: the root role cannot be assigned through this API", ErrDelegationForbidden)
	}
	return nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func (s *IdentityService) ensureDelegationTable() error {
	return s.db.AutoMigrate(&AdminDelegationRecord{})
}

func (s *IdentityService) hasActiveDelegation(userID string) (bool, error) {
	var n int64
	err := s.db.Model(&AdminDelegationRecord{}).
		Where("user_id = ? AND status = ?", userID, "active").
		Count(&n).Error
	return n > 0, err
}

func (s *IdentityService) maxRoleRank(userID string) (int, error) {
	names, err := s.RoleNamesForUser(userID)
	if err != nil {
		return 0, err
	}
	max := 0
	for _, n := range names {
		if v := RoleRank(n); v > max {
			max = v
		}
	}
	return max, nil
}

func (s *IdentityService) ensureAdminRole() (*models.Role, error) {
	var role models.Role
	err := s.db.Where("name = ?", RoleAdmin).First(&role).Error
	if err == nil {
		return &role, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	role = models.Role{
		Name:        RoleAdmin,
		Description: "Administrative access to the PAM Admin Center. Granted by root via the admin delegation API (or bootstrap seed).",
		IsSystem:    true,
	}
	if role.ID == "" {
		role.ID = uuid.New().String()
	}
	if err := s.db.Create(&role).Error; err != nil {
		if err2 := s.db.Where("name = ?", RoleAdmin).First(&role).Error; err2 == nil {
			return &role, nil
		}
		return nil, fmt.Errorf("%w: failed to ensure admin role: %v", ErrRoleNotFound, err)
	}
	s.logger.Info("identity.admin_role.ensured", zap.String("role_id", role.ID))
	return &role, nil
}

func (s *IdentityService) assignRoleTx(tx *gorm.DB, userID, roleName, assignedBy string) error {
	var role models.Role
	if err := tx.Where("name = ?", roleName).First(&role).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return fmt.Errorf("%w: %s", ErrRoleNotFound, roleName)
		}
		return err
	}
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&models.UserRole{
		UserID: userID, RoleID: role.ID, AssignedBy: assignedBy,
	}).Error
}

func (s *IdentityService) removeRoleTx(tx *gorm.DB, userID, roleName string) error {
	var role models.Role
	if err := tx.Where("name = ?", roleName).First(&role).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	return tx.Where("user_id = ? AND role_id = ?", userID, role.ID).Delete(&models.UserRole{}).Error
}

func (s *IdentityService) validateResourceIDs(ids []string) error {
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		var n int64
		if err := s.db.Table("pam_resources").Where("id = ?", id).Count(&n).Error; err != nil {
			return fmt.Errorf("%w: %s", ErrInvalidScope, id)
		}
		if n == 0 {
			return fmt.Errorf("%w: %s", ErrInvalidScope, id)
		}
	}
	return nil
}

func containsStr(ss []string, v string) bool {
	for _, s := range ss {
		if s == v {
			return true
		}
	}
	return false
}
