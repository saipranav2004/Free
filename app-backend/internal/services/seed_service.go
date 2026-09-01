// pam/internal/services/seed_service.go
//
// Startup seeding: the default RBAC/PBAC bundle (opa/policies/default_bundle.json)
// and the bootstrap root/superuser account. Runs once on every startup and is
// fully idempotent — safe to run against a database that already has these
// rows (an existing row is left alone; only missing rows are created).
package services

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/opa"
	"github.com/yourorg/pam/pkg/argon2"
	"go.uber.org/zap"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// SeedRBACDefaults upserts the roles and policies described in the embedded
// default bundle, and wires each policy's attach_to_roles. Existing rows
// (matched by name) are left untouched — an administrator's own edits to a
// system policy's actions/resources are never clobbered by a restart.
func SeedRBACDefaults(db *gorm.DB, logger *zap.Logger) error {
	bundle, err := opa.DefaultSeedBundle()
	if err != nil {
		return err
	}

	roleIDByName := map[string]string{}

	for _, r := range bundle.Roles {
		var existing models.Role
		err := db.Where("name = ?", r.Name).First(&existing).Error
		if err == nil {
			roleIDByName[r.Name] = existing.ID
			continue
		}
		if !isNotFound(err) {
			return fmt.Errorf("seed role %q: %w", r.Name, err)
		}
		row := models.Role{Name: r.Name, Description: r.Description, IsSystem: r.IsSystem}
		if err := db.Create(&row).Error; err != nil {
			return fmt.Errorf("seed role %q: %w", r.Name, err)
		}
		roleIDByName[r.Name] = row.ID
		logger.Info("seed.role.created", zap.String("name", r.Name))
	}

	for _, p := range bundle.Policies {
		var existing models.Policy
		err := db.Where("name = ?", p.Name).First(&existing).Error
		var policyID string
		if err == nil {
			policyID = existing.ID
		} else {
			if !isNotFound(err) {
				return fmt.Errorf("seed policy %q: %w", p.Name, err)
			}
			row := models.Policy{
				Name: p.Name, Description: p.Description, Effect: p.Effect,
				Actions: p.Actions, Resources: p.Resources, IsSystem: p.IsSystem,
			}
			if err := db.Create(&row).Error; err != nil {
				return fmt.Errorf("seed policy %q: %w", p.Name, err)
			}
			policyID = row.ID
			logger.Info("seed.policy.created", zap.String("name", p.Name))
		}

		for _, roleName := range p.AttachToRoles {
			roleID, ok := roleIDByName[roleName]
			if !ok {
				return fmt.Errorf("seed policy %q references unknown role %q", p.Name, roleName)
			}
			if err := db.Clauses(clause.OnConflict{DoNothing: true}).
				Create(&models.RolePolicy{RoleID: roleID, PolicyID: policyID}).Error; err != nil {
				return fmt.Errorf("attach seed policy %q to role %q: %w", p.Name, roleName, err)
			}
		}
	}

	return nil
}

// SeedRootAccount ensures exactly one protected superuser account exists,
// holding the "root" role. Configured via:
//
//	PAM_ROOT_USERNAME  (default "root")
//	PAM_ROOT_EMAIL     (default "root@pam.local")
//	PAM_ROOT_PASSWORD  (required in production; in development, if unset, a
//	                    random password is generated and written to a 0600
//	                    file, whose path is logged. See writeGeneratedPassword
//	                    for why it does not go into the log itself.)
//
// If a root-role account already exists, this is a no-op — it does NOT
// reset the password of an existing root account on every restart, which
// would silently invalidate whatever the operator set it to after first boot.
// SeedMFAPolicyDefaults writes the one rule this product should never have
// shipped without: administrators need a second factor.
//
// THE PROBLEM THIS FIXES. The MFA policy table started empty. Every account
// resolved to mode "off", nothing was ever required, and the compliance
// screen reported every user compliant, because they were: compliant with a
// policy that demanded nothing. A privileged access management system whose
// default posture is "a password is enough for root" is not a defensible
// default, and the number on the compliance page actively concealed it.
//
// MONITOR, NOT ENFORCE, and that is the important part. Enforce on first boot
// would lock the seeded root account out of its own console before anybody had
// a chance to enrol a device, turning a security default into an outage.
// Monitor requires nothing and blocks nobody; what it does is make the gap
// VISIBLE, so root and admin show as non-compliant on the MFA policy page from
// the first login, with a one-click path to enforce once devices are enrolled.
//
// Seeded once. An operator who deletes the rule, or moves it to off or
// enforce, keeps their choice across every restart: this only writes when the
// role has no rule at all.
func SeedMFAPolicyDefaults(db *gorm.DB, logger *zap.Logger) error {
	for _, roleName := range []string{"root", "admin"} {
		var count int64
		if err := db.Model(&MFAPolicyRule{}).Where("role_name = ?", roleName).Count(&count).Error; err != nil {
			return fmt.Errorf("seed mfa policy: check %s: %w", roleName, err)
		}
		if count > 0 {
			continue
		}
		rule := MFAPolicyRule{
			ID:       uuid.NewString(),
			RoleName: roleName,
			Mode:     MFAModeMonitor,
			Reason:   "Seeded default: privileged roles are expected to hold a second factor. Set to enforce once devices are enrolled.",
		}
		if err := db.Create(&rule).Error; err != nil {
			return fmt.Errorf("seed mfa policy: create %s: %w", roleName, err)
		}
		logger.Info("seed.mfa_policy.created",
			zap.String("role", roleName), zap.String("mode", MFAModeMonitor))
	}
	return nil
}

func SeedRootAccount(db *gorm.DB, isProduction bool, logger *zap.Logger) error {
	var rootRole models.Role
	if err := db.Where("name = ?", "root").First(&rootRole).Error; err != nil {
		return fmt.Errorf("seed root account: root role not found (seed RBAC defaults first): %w", err)
	}

	var existingCount int64
	if err := db.Model(&models.UserRole{}).Where("role_id = ?", rootRole.ID).Count(&existingCount).Error; err != nil {
		return fmt.Errorf("seed root account: check existing: %w", err)
	}
	if existingCount > 0 {
		return nil // a root-role account already exists — never re-seed over it
	}

	username := envOrDefault("PAM_ROOT_USERNAME", "root")
	email := envOrDefault("PAM_ROOT_EMAIL", "root@pam.local")
	password := os.Getenv("PAM_ROOT_PASSWORD")

	generated := false
	if password == "" {
		if isProduction {
			return fmt.Errorf("PAM_ROOT_PASSWORD is required in production. Refusing to seed a root account with no configured password")
		}
		var err error
		password, err = randomPassword()
		if err != nil {
			return fmt.Errorf("generate dev root password: %w", err)
		}
		generated = true
	}

	hash, err := argon2.Hash(password)
	if err != nil {
		return fmt.Errorf("hash root password: %w", err)
	}

	return db.Transaction(func(tx *gorm.DB) error {
		u := models.User{
			Username: username, Email: email, FullName: "Root",
			PasswordHash: &hash, Status: "ACTIVE", IsProtected: true,
		}
		if err := tx.Create(&u).Error; err != nil {
			return fmt.Errorf("create root user: %w", err)
		}
		if err := tx.Create(&models.UserRole{UserID: u.UserID, RoleID: rootRole.ID}).Error; err != nil {
			return fmt.Errorf("assign root role: %w", err)
		}

		if generated {
			writeGeneratedPassword(username, password, logger)
		} else {
			logger.Info("seed.root_account.created", zap.String("username", username))
		}
		return nil
	})
}

func isNotFound(err error) bool {
	return err == gorm.ErrRecordNotFound
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func randomPassword() (string, error) {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// writeGeneratedPassword puts a generated root password somewhere a developer
// can read it and a log pipeline cannot.
//
// It used to go straight into the structured log as zap.String("password",
// ...). Application logs are shipped, retained and searchable, and the people
// who can read them are not the same set as the people who should hold root on
// a privileged-access system, so the one credential that opens everything was
// ending up in the least controlled place in the stack. Production already
// refuses to seed without PAM_ROOT_PASSWORD, so this only ever fired in
// development, but development installs are shared too.
//
// A 0600 file, and only its path in the log. If the file cannot be written the
// password still reaches the log, because a developer locked out of a fresh
// install is a worse outcome than a noisy log line, and the line says plainly
// that it happened.
func writeGeneratedPassword(username, password string, logger *zap.Logger) {
	path := envOrDefault("PAM_ROOT_PASSWORD_FILE", "pam-root-password.txt")
	body := fmt.Sprintf("username: %s\npassword: %s\n\nGenerated because PAM_ROOT_PASSWORD was unset.\nSign in, rotate it, then delete this file.\n", username, password)

	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		logger.Warn("seed.root_account.generated_password",
			zap.String("username", username),
			zap.String("password", password),
			zap.String("note", "could not write the password file, so it is in this log line instead"),
			zap.String("path_attempted", path),
			zap.Error(err),
		)
		return
	}

	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	logger.Warn("seed.root_account.generated_password",
		zap.String("username", username),
		zap.String("password_file", path),
		zap.String("action_required", "read the file, sign in, rotate the password, delete the file, and set PAM_ROOT_PASSWORD on future deployments"),
	)
}
