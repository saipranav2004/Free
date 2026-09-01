// pam/internal/services/vault_service.go
package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/pkg/crypto"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	ErrSafeNotFound       = errors.New("safe not found")
	ErrCredentialNotFound = errors.New("credential not found")
	ErrInvalidCredType    = errors.New("invalid credential type specified")
	ErrCredentialArchived = errors.New("cannot checkout or reveal archived credential")
)

type StoreCredentialRequest struct {
	SafeID               string                `json:"safe_id"`
	FolderID             *string               `json:"folder_id,omitempty"`
	ResourceID           string                `json:"resource_id"`
	Name                 string                `json:"name"`
	Description          string                `json:"description"`
	AccountName          string                `json:"account_name" binding:"required"`
	CredentialType       models.CredentialType `json:"credential_type" binding:"required"`
	SecretPlaintext      string                `json:"secret_plaintext" binding:"required"`
	MetadataJSON         string                `json:"metadata_json,omitempty"`
	RotationIntervalDays int                   `json:"rotation_interval_days"`
	CreatedBy            string                `json:"created_by"`
}

type CheckoutResult struct {
	EntryID        string `json:"entry_id"`
	AccountName    string `json:"account_name"`
	CredentialType string `json:"credential_type"`
	Plaintext      string `json:"plaintext"` // Transient plaintext; never log or persist
	ExpiresAt      string `json:"expires_at"`
}

type CredentialTypeMetadata struct {
	Type        string `json:"type"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type VaultService struct {
	db  *gorm.DB
	kms crypto.KMSProvider
	log *zap.Logger
}

// NewVaultService initializes the VaultService and sets up the KMS provider.
//
// THE KEY COMES FROM CONFIGURATION AND HAS NO FALLBACK. It used to read the
// environment directly and, when PAM_VAULT_ENCRYPTION_KEY was unset, fall back
// to a base64 master key written as a literal in this file. A deployment that
// forgot the variable therefore started cleanly, said nothing, and encrypted
// every credential in the product under a key published in the source tree.
// Nothing in the logs would have flagged it and everything would have appeared
// to work.
//
// Refusing to start is the only correct behaviour here: a vault that cannot
// prove which key it is using is not a vault. config.validate() already
// requires the key, so this returns an error rather than silently choosing one.
func NewVaultService(db *gorm.DB, keyB64 string, log *zap.Logger) (*VaultService, error) {
	if strings.TrimSpace(keyB64) == "" {
		return nil, errors.New("vault encryption key is required (PAM_VAULT_ENCRYPTION_KEY): refusing to start with no key rather than choosing one")
	}

	kms, err := crypto.NewLocalKMSProvider(keyB64)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize KMS provider: %w", err)
	}

	return &VaultService{
		db:  db,
		kms: kms,
		log: log,
	}, nil
}

func (s *VaultService) DB() *gorm.DB {
	return s.db
}

func (s *VaultService) KMS() crypto.KMSProvider {
	return s.kms
}

func (s *VaultService) ListCredentialTypes(ctx context.Context) ([]CredentialTypeMetadata, error) {
	return []CredentialTypeMetadata{
		{"password", "Password", "Traditional alphanumeric username and password"},
		{"ssh_key", "SSH Private Key", "RSA or Ed25519 SSH private key with public key metadata"},
		{"x509_cert", "X.509 Certificate", "SSL/TLS client certificate and private key"},
		{"api_key", "API Key / Bearer Token", "REST API authentication key"},
		{"token", "OAuth / OIDC Token", "OAuth refresh token or identity token"},
		{"connection_string", "Connection String", "Database or service URI connection string"},
		{"kerberos_keytab", "Kerberos Keytab", "Domain authentication keytab"},
	}, nil
}

func (s *VaultService) CreateSafe(ctx context.Context, name, description, ownerID string, retention int) (*models.Safe, error) {
	safe := &models.Safe{
		Name:          name,
		Description:   description,
		OwnerID:       ownerID,
		RetentionDays: retention,
	}
	if err := s.db.Create(safe).Error; err != nil {
		return nil, fmt.Errorf("failed to create safe '%s': %w", name, err)
	}
	s.log.Info("vault.safe.created", zap.String("safe", name), zap.String("arn", safe.ResourceARN()))
	return safe, nil
}

func (s *VaultService) ListSafes(ctx context.Context) ([]models.Safe, error) {
	var safes []models.Safe
	err := s.db.Order("name ASC").Find(&safes).Error
	return safes, err
}

func (s *VaultService) GetSafe(ctx context.Context, safeID string) (*models.Safe, error) {
	var safe models.Safe
	if err := s.db.Where("id = ? OR name = ?", safeID, safeID).First(&safe).Error; err != nil {
		return nil, ErrSafeNotFound
	}
	return &safe, nil
}

func (s *VaultService) CreateFolder(ctx context.Context, safeID, name, path string, parentID *string) (*models.Folder, error) {
	folder := &models.Folder{
		SafeID:         safeID,
		ParentFolderID: parentID,
		Name:           name,
		Path:           path,
	}
	if err := s.db.Create(folder).Error; err != nil {
		return nil, fmt.Errorf("failed to create folder: %w", err)
	}
	return folder, nil
}

func (s *VaultService) ListFolders(ctx context.Context, safeID string) ([]models.Folder, error) {
	var folders []models.Folder
	err := s.db.Where("safe_id = ?", safeID).Order("path ASC").Find(&folders).Error
	return folders, err
}

func (s *VaultService) StoreCredential(ctx context.Context, req StoreCredentialRequest) (*models.Credential, error) {
	if !models.IsValidCredentialType(string(req.CredentialType)) {
		return nil, ErrInvalidCredType
	}

	var nextRotation *time.Time
	if req.RotationIntervalDays > 0 {
		t := time.Now().AddDate(0, 0, req.RotationIntervalDays)
		nextRotation = &t
	}

	// THE ROW IS BUILT BEFORE THE SECRET IS SEALED, and the order matters.
	// This used to encrypt straight from the request and construct the row
	// afterwards, so the AAD came from `req` on the way in and from `entry` on
	// every read after that. Those are not the same values: SafeID carries a
	// column default, so a request with no safe_id sealed with no safe_id in
	// the binding and was then read back against safe_id "default", and the
	// credential could never be decrypted again. Sealing from the row that is
	// about to be written makes the two sides the same object.
	entry := &models.Credential{
		SafeID:               req.SafeID,
		FolderID:             req.FolderID,
		ResourceID:           req.ResourceID,
		Name:                 req.Name,
		Description:          req.Description,
		AccountName:          req.AccountName,
		CredentialType:       string(req.CredentialType),
		MetadataJSON:         req.MetadataJSON,
		Status:               "active",
		Version:              1,
		RotationIntervalDays: req.RotationIntervalDays,
		NextRotationAt:       nextRotation,
		CreatedBy:            req.CreatedBy,
	}

	if entry.Name == "" {
		entry.Name = fmt.Sprintf("%s (%s)", req.AccountName, req.CredentialType)
	}

	// Mirror the column default in Go so the value sealed into the binding is
	// the value that will be in the row, not the empty string GORM omits.
	if entry.SafeID == "" {
		entry.SafeID = "default"
	}

	encryptedSecret, err := crypto.EnvelopeEncryptor(ctx, s.kms, req.SecretPlaintext, entry.EncryptionAAD())
	if err != nil {
		return nil, fmt.Errorf("envelope encryption failed: %w", err)
	}
	entry.CredentialEnc = encryptedSecret

	if err := s.db.Create(entry).Error; err != nil {
		return nil, fmt.Errorf("failed to save credential: %w", err)
	}

	versionRow := models.CredentialVersion{
		CredentialID:  entry.ID,
		Version:       1,
		CredentialEnc: encryptedSecret,
		Reason:        "Initial credential intake",
		CreatedBy:     req.CreatedBy,
	}
	_ = s.db.Create(&versionRow)

	if req.ResourceID != "" {
		s.db.Model(&models.PAMResource{}).Where("id = ?", req.ResourceID).
			Update("vault_entry_id", entry.ID)
	}

	s.log.Info("vault.credential.stored",
		zap.String("credential_id", entry.ID),
		zap.String("type", string(req.CredentialType)),
		zap.String("account", req.AccountName),
	)
	return entry, nil
}

func (s *VaultService) ListCredentials(ctx context.Context, safeID string) ([]models.Credential, error) {
	query := s.db.Model(&models.Credential{}).Where("status != 'archived'")
	if safeID != "" {
		query = query.Where("safe_id = ?", safeID)
	}
	var entries []models.Credential
	err := query.Order("created_at DESC").Find(&entries).Error
	return entries, err
}

func (s *VaultService) GetCredential(ctx context.Context, credID string) (*models.Credential, error) {
	var cred models.Credential
	if err := s.db.First(&cred, "id = ?", credID).Error; err != nil {
		return nil, ErrCredentialNotFound
	}
	return &cred, nil
}

func (s *VaultService) RevealCredential(ctx context.Context, credID, operator, reason string) (*CheckoutResult, error) {
	var entry models.Credential
	if err := s.db.First(&entry, "id = ?", credID).Error; err != nil {
		return nil, ErrCredentialNotFound
	}
	if entry.Status == "archived" {
		return nil, ErrCredentialArchived
	}

	plaintext, err := crypto.EnvelopeDecryptor(ctx, s.kms, entry.CredentialEnc, entry.EncryptionAAD())
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt envelope: %w", err)
	}

	expiresAt := time.Now().Add(60 * time.Minute).Format(time.RFC3339)
	s.log.Info("vault.credential.reveal",
		zap.String("credential_id", entry.ID),
		zap.String("operator", operator),
		zap.String("reason", reason),
	)

	return &CheckoutResult{
		EntryID:        entry.ID,
		AccountName:    entry.AccountName,
		CredentialType: entry.CredentialType,
		Plaintext:      plaintext,
		ExpiresAt:      expiresAt,
	}, nil
}

func (s *VaultService) CreateVersion(ctx context.Context, credID, plaintext, reason, operator string) (*models.CredentialVersion, error) {
	var entry models.Credential
	if err := s.db.First(&entry, "id = ?", credID).Error; err != nil {
		return nil, ErrCredentialNotFound
	}

	encryptedSecret, err := crypto.EnvelopeEncryptor(ctx, s.kms, plaintext, entry.EncryptionAAD())
	if err != nil {
		return nil, fmt.Errorf("envelope encryption failed: %w", err)
	}

	newVersion := entry.Version + 1
	versionRow := &models.CredentialVersion{
		CredentialID:  credID,
		Version:       newVersion,
		CredentialEnc: encryptedSecret,
		Reason:        reason,
		CreatedBy:     operator,
	}

	err = s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(versionRow).Error; err != nil {
			return err
		}
		entry.CredentialEnc = encryptedSecret
		entry.Version = newVersion
		entry.UpdatedBy = operator
		return tx.Save(&entry).Error
	})
	if err != nil {
		return nil, err
	}

	s.log.Info("vault.credential.version_created",
		zap.String("credential_id", credID),
		zap.Int("new_version", newVersion),
		zap.String("operator", operator),
	)
	return versionRow, nil
}

// PasswordChange updates the secret of a credential (manual or target rotation change).
func (s *VaultService) PasswordChange(ctx context.Context, credID, newPlaintext, operator string) (*models.CredentialVersion, error) {
	return s.CreateVersion(ctx, credID, newPlaintext, "Manual password change", operator)
}

func (s *VaultService) CheckoutCredential(ctx context.Context, entryID, operator, reason string) (*CheckoutResult, error) {
	return s.RevealCredential(ctx, entryID, operator, reason)
}

func (s *VaultService) ListVaultEntries(ctx context.Context, safeID string) ([]models.Credential, error) {
	return s.ListCredentials(ctx, safeID)
}

func (s *VaultService) GetDecryptedCredential(ctx context.Context, entryID string) (string, error) {
	var entry models.Credential
	if err := s.db.First(&entry, "id = ?", entryID).Error; err != nil {
		return "", err
	}
	return crypto.EnvelopeDecryptor(ctx, s.kms, entry.CredentialEnc, entry.EncryptionAAD())
}
