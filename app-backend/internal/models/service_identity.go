// pam/internal/models/service_identity.go
//
// Machine-identity plane for the vault's DATA path.
//
// The human control plane (JWT + MFA + OPA) creates and rotates credentials.
// Applications never use that plane: they authenticate as a ServiceIdentity
// with a ServiceToken and read secrets through path-scoped ServiceGrants.
//
// Three design decisions worth stating, because they are the difference
// between this and "a token column in a table":
//
//  1. ServiceToken stores ONLY HMAC-SHA256(secret), never the secret. A DB
//     dump, a stray SELECT, or a replica leak yields nothing usable. The
//     public TokenID is the lookup key, so verification is a single
//     primary-key hit followed by a constant-time compare.
//
//  2. A ServiceIdentity may hold MANY live tokens. That is what makes
//     zero-downtime token rotation possible: mint the new one, roll the
//     fleet, revoke the old one. One-token-per-service forces a downtime
//     window on every rotation.
//
//  3. Authorization is PATH-SCOPED (`prod-db/*`), not row-per-credential.
//     One grant covers a whole safe/folder subtree, so adding a credential
//     does not mean touching every consumer's grant list, the same reason
//     IAM policies use ARN patterns instead of resource-ID lists.
package models

import (
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// ── ServiceIdentity ──────────────────────────────────────────────────────────

// ServiceIdentity is a non-human principal (an application, a job, a sidecar)
// that consumes secrets. It is the stable subject of audit records and of
// grants; the tokens beneath it are disposable.
type ServiceIdentity struct {
	ID          string `gorm:"primaryKey;type:varchar(36)" json:"id"`
	Name        string `gorm:"type:varchar(255);not null;uniqueIndex" json:"name"` // e.g. "billing-api-prod"
	Description string `gorm:"type:text" json:"description,omitempty"`
	Environment string `gorm:"type:varchar(50);index" json:"environment,omitempty"`

	// OwnerID is the human accountable for this identity, required so every
	// machine principal has a named owner to escalate to during an incident.
	OwnerID string `gorm:"type:varchar(36);index" json:"owner_id,omitempty"`

	// Status: active | disabled. Disabling kills every token at once without
	// having to enumerate them.
	Status string `gorm:"type:varchar(30);not null;default:'active';index" json:"status"`

	// MaxSecretsPerMinute caps this identity's read rate. A leaked token is
	// contained by how fast it can drain the vault, so this is a security
	// control, not just capacity management. 0 uses the server default.
	MaxSecretsPerMinute int `gorm:"default:0" json:"max_secrets_per_minute"`

	CreatedBy string         `gorm:"type:varchar(36)" json:"created_by,omitempty"`
	CreatedAt time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

func (ServiceIdentity) TableName() string { return "pam_service_identities" }

func (s *ServiceIdentity) BeforeCreate(tx *gorm.DB) error {
	if s.ID == "" {
		s.ID = uuid.NewString()
	}
	if s.Status == "" {
		s.Status = "active"
	}
	return nil
}

func (s *ServiceIdentity) IsUsable() bool { return s.Status == "active" }

// ── ServiceToken ─────────────────────────────────────────────────────────────

// ServiceToken is one credential belonging to a ServiceIdentity.
//
// Wire format, handed to the application exactly once at mint time:
//
//	pamsvc.<TokenID>.<secret>
//
// TokenID is public (it is the lookup key and appears in audit records). The
// secret half is never persisted in any form other than TokenHash.
type ServiceToken struct {
	// TokenID is the public half and the primary key: verification is a
	// single primary-key lookup, so authentication cost does not grow with
	// the number of tokens in the system.
	TokenID string `gorm:"primaryKey;type:varchar(64)" json:"token_id"`

	ServiceID   string `gorm:"type:varchar(36);not null;index" json:"service_id"`
	ServiceName string `gorm:"type:varchar(255);not null" json:"service_name"`

	// TokenHash is hex(HMAC-SHA256(pepper, secret)). HMAC rather than a bare
	// SHA-256 so a stolen database alone cannot be attacked offline without
	// also stealing the server-side pepper. A password KDF (argon2) is
	// deliberately NOT used here: the secret is 256 bits of CSPRNG output, so
	// there is nothing to slow down, and this sits on the request hot path.
	TokenHash string `gorm:"type:varchar(128);not null" json:"-"`

	Description string `gorm:"type:varchar(255)" json:"description,omitempty"`

	CreatedBy  string     `gorm:"type:varchar(36)" json:"created_by,omitempty"`
	CreatedAt  time.Time  `gorm:"autoCreateTime" json:"created_at"`
	ExpiresAt  *time.Time `gorm:"index" json:"expires_at,omitempty"`
	RevokedAt  *time.Time `gorm:"index" json:"revoked_at,omitempty"`
	RevokedBy  string     `gorm:"type:varchar(36)" json:"revoked_by,omitempty"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	LastUsedIP string     `gorm:"type:varchar(64)" json:"last_used_ip,omitempty"`
}

func (ServiceToken) TableName() string { return "pam_service_tokens" }

// IsUsable reports whether the token is neither revoked nor expired.
func (t *ServiceToken) IsUsable(now time.Time) bool {
	if t.RevokedAt != nil {
		return false
	}
	if t.ExpiresAt != nil && !t.ExpiresAt.After(now) {
		return false
	}
	return true
}

// ── ServiceGrant ─────────────────────────────────────────────────────────────

// ServiceGrant authorizes a ServiceIdentity to read secrets whose canonical
// path matches Scope.
//
// A canonical secret path is "<safe>/<folder path>/<credential name>", e.g.
// "prod-db/postgres/pg-app-writer". Scope supports:
//
//	`*`                            → every secret (reserve for break-glass tooling)
//	`prod-db/**`                    → the whole subtree
//	`prod-db/*`                     → direct children of prod-db only
//	`prod-db/postgres/pg-*`         → prefix match within one folder
//	`prod-db/postgres/pg-app-writer` → one exact secret
//
// The `*` vs `**` distinction is the same as every CI/ACL glob dialect: `*`
// stops at a separator, `**` crosses them. It matters because "everything
// directly in prod-db" and "everything anywhere under prod-db" are very
// different blast radii, and an operator granting the former should not
// silently get the latter.
type ServiceGrant struct {
	ID          string `gorm:"primaryKey;type:varchar(36)" json:"id"`
	ServiceID   string `gorm:"type:varchar(36);not null;uniqueIndex:ux_service_grant_scope" json:"service_id"`
	ServiceName string `gorm:"type:varchar(255);not null" json:"service_name"`

	// Scope is the path pattern this grant authorizes. Unique per service, so
	// the same scope cannot be granted twice and then only half-revoked.
	Scope string `gorm:"type:varchar(512);not null;uniqueIndex:ux_service_grant_scope" json:"scope"`

	// MaxTTLSeconds caps how long a client may cache secrets matched by this
	// grant. 0 means "use the server default". A tight cap is how you bound
	// the window in which a revoked grant is still effective on a client that
	// already holds the plaintext.
	MaxTTLSeconds int `json:"max_ttl_seconds"`

	GrantedBy string     `gorm:"type:varchar(36)" json:"granted_by,omitempty"`
	Reason    string     `gorm:"type:text" json:"reason,omitempty"`
	CreatedAt time.Time  `gorm:"autoCreateTime" json:"created_at"`
	ExpiresAt *time.Time `gorm:"index" json:"expires_at,omitempty"`
	RevokedAt *time.Time `gorm:"index" json:"revoked_at,omitempty"`
	RevokedBy string     `gorm:"type:varchar(36)" json:"revoked_by,omitempty"`
}

func (ServiceGrant) TableName() string { return "pam_service_grants" }

func (g *ServiceGrant) BeforeCreate(tx *gorm.DB) error {
	if g.ID == "" {
		g.ID = uuid.NewString()
	}
	return nil
}

// IsUsable reports whether the grant is neither revoked nor expired.
func (g *ServiceGrant) IsUsable(now time.Time) bool {
	if g.RevokedAt != nil {
		return false
	}
	if g.ExpiresAt != nil && !g.ExpiresAt.After(now) {
		return false
	}
	return true
}

// Matches reports whether secretPath falls inside this grant's scope.
//
// Matching happens in Go rather than SQL on purpose: a service holds a
// handful of grants, they are cached in memory, and pattern matching in the
// database would mean either a LIKE scan per request or a denormalised path
// column that has to be kept in sync on every safe/folder move.
func (g *ServiceGrant) Matches(secretPath string) bool {
	return ScopeMatches(g.Scope, secretPath)
}

// ScopeMatches implements the glob dialect documented on ServiceGrant.
func ScopeMatches(scope, secretPath string) bool {
	scope = strings.Trim(strings.TrimSpace(scope), "/")
	secretPath = strings.Trim(strings.TrimSpace(secretPath), "/")
	if scope == "" || secretPath == "" {
		return false
	}
	if scope == "*" || scope == "**" {
		return true
	}

	// "prefix/**" crosses separators: match the subtree and the node itself.
	if rest, ok := strings.CutSuffix(scope, "/**"); ok {
		return secretPath == rest || strings.HasPrefix(secretPath, rest+"/")
	}

	// Everything else is segment-wise: path.Match's `*` never spans a "/",
	// which is exactly the semantics wanted for "prod-db/*".
	ok, err := path.Match(scope, secretPath)
	return err == nil && ok
}

// CanonicalSecretPath builds the addressable path for a credential from its
// safe name, folder path and credential name. This is the single definition
// of a secret's identity on the data plane, every other layer (grants,
// audit records, client cache keys) derives from it, so it must not drift.
func CanonicalSecretPath(safeName, folderPath, credentialName string) string {
	segs := make([]string, 0, 4)
	add := func(raw string) {
		for _, s := range strings.Split(strings.Trim(strings.TrimSpace(raw), "/"), "/") {
			if s != "" {
				segs = append(segs, s)
			}
		}
	}
	add(safeName)
	add(folderPath)
	add(credentialName)
	return strings.Join(segs, "/")
}
