// pam/internal/models/refresh_token.go
package models

import "time"

// RefreshToken is the redemption record for one issued refresh token.
//
// WHY THIS TABLE EXISTS. Login has always returned a refresh_token, and it was
// a random string that was handed to the browser and then forgotten: nothing
// stored it, no endpoint accepted it, and no code path could turn it back into
// a session. The access token lives thirty minutes, so every console session
// ended at the thirty minute mark by dumping the operator on the sign-in page,
// mid-task, with whatever they were typing lost.
//
// THE TOKEN ITSELF IS NEVER STORED. Only its SHA-256 hash is, for the same
// reason a password is hashed: a leaked database must not hand out live
// sessions. Lookup is by hash, which is why TokenHash carries the unique index.
//
// ROTATION AND REUSE DETECTION. Every redemption issues a NEW refresh token and
// marks the old one replaced. A refresh token therefore has exactly one valid
// use. If a token that was already replaced comes back, that is either a client
// bug or a stolen token being replayed, and the two are indistinguishable from
// here, so the whole session's chain is revoked and the account has to sign in
// again. This is the standard OAuth 2.1 treatment of public clients and it is
// what makes a long-lived refresh token acceptable in a browser at all.
type RefreshToken struct {
	ID string `gorm:"primaryKey;type:varchar(36)" json:"id"`

	// TokenHash is hex-encoded SHA-256 of the token that was issued.
	TokenHash string `gorm:"column:token_hash;type:varchar(64);uniqueIndex;not null" json:"-"`

	UserID    string `gorm:"column:user_id;type:varchar(36);index;not null" json:"user_id"`
	SessionID string `gorm:"column:session_id;type:varchar(64);index;not null" json:"session_id"`

	// The two claims a refreshed access token must not silently change.
	// Without them a refresh could promote a session that never passed MFA, or
	// release one that was deliberately restricted to enrolment only.
	MFAVerified   bool `gorm:"column:mfa_verified;not null;default:false" json:"mfa_verified"`
	EnrolmentOnly bool `gorm:"column:enrolment_only;not null;default:false" json:"enrolment_only"`

	ExpiresAt time.Time  `gorm:"column:expires_at;index;not null" json:"expires_at"`
	RevokedAt *time.Time `gorm:"column:revoked_at" json:"revoked_at,omitempty"`

	// ReplacedByID is set when this token has been redeemed. Its presence is
	// what makes a second redemption detectable.
	ReplacedByID *string `gorm:"column:replaced_by_id;type:varchar(36)" json:"replaced_by_id,omitempty"`

	CreatedIP string    `gorm:"column:created_ip;type:varchar(45)" json:"created_ip,omitempty"`
	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime" json:"created_at"`
}

func (RefreshToken) TableName() string { return "pam_refresh_tokens" }

// Usable reports whether this row may still be redeemed.
func (t *RefreshToken) Usable(now time.Time) bool {
	if t == nil || t.RevokedAt != nil || t.ReplacedByID != nil {
		return false
	}
	return t.ExpiresAt.After(now)
}
