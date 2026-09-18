// pam/internal/api/handlers/vault_handler.go
package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/config"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

type VaultHandler struct {
	vaultSvc    *services.VaultService
	rotationSvc *services.RotationService
	backupSvc   *services.VaultBackupService
	logger      *zap.Logger
}

// NewVaultHandler takes the deployment's real object-storage settings.
//
// THEY USED TO BE HARDCODED HERE: bucket "pam-recordings", endpoint
// "localhost:9000", TLS off, whatever PAM_S3_* said. Every whole-vault backup
// therefore went to a plaintext connection to localhost, so on any real
// deployment the feature either failed outright or wrote the export somewhere
// nobody had configured, while the console offered the button as though it
// worked. An encrypted archive of every credential in the product is the last
// thing that should ignore where it was told to go.
func NewVaultHandler(
	vaultSvc *services.VaultService,
	rotationSvc *services.RotationService,
	s3Cfg config.S3Config,
	logger *zap.Logger,
) *VaultHandler {
	backupSvc := services.NewVaultBackupService(vaultSvc.DB(), vaultSvc.KMS(), s3Cfg, logger)
	return &VaultHandler{
		vaultSvc:    vaultSvc,
		rotationSvc: rotationSvc,
		backupSvc:   backupSvc,
		logger:      logger,
	}
}

// ── 1. CREDENTIAL TYPES (Feature 13) ──────────────────────────────────────────
func (h *VaultHandler) ListCredentialTypes(c *gin.Context) {
	types, err := h.vaultSvc.ListCredentialTypes(c.Request.Context())
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, types, "Credential types retrieved successfully")
}

// ── 2. SAFES (Feature 14) ─────────────────────────────────────────────────────
func (h *VaultHandler) ListSafes(c *gin.Context) {
	safes, err := h.vaultSvc.ListSafes(c.Request.Context())
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, safes, "Safes retrieved successfully")
}

func (h *VaultHandler) CreateSafe(c *gin.Context) {
	var req struct {
		Name          string `json:"name" binding:"required"`
		Description   string `json:"description"`
		RetentionDays int    `json:"retention_days"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}

	userID := c.GetString("user_id")
	safe, err := h.vaultSvc.CreateSafe(c.Request.Context(), req.Name, req.Description, userID, req.RetentionDays)
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Created(c, safe, "Safe created successfully")
}

func (h *VaultHandler) GetSafe(c *gin.Context) {
	safeID := c.Param("safe_id")
	safe, err := h.vaultSvc.GetSafe(c.Request.Context(), safeID)
	if err != nil {
		if errors.Is(err, services.ErrSafeNotFound) {
			response.Error(c, http.StatusNotFound, err.Error())
			return
		}
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, safe, "Safe retrieved successfully")
}

// ── 3. FOLDERS (Feature 14) ───────────────────────────────────────────────────
func (h *VaultHandler) ListFolders(c *gin.Context) {
	safeID := c.Param("safe_id")
	folders, err := h.vaultSvc.ListFolders(c.Request.Context(), safeID)
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, folders, "Folders retrieved successfully")
}

func (h *VaultHandler) CreateFolder(c *gin.Context) {
	safeID := c.Param("safe_id")
	var req struct {
		Name           string  `json:"name" binding:"required"`
		Path           string  `json:"path" binding:"required"`
		ParentFolderID *string `json:"parent_folder_id,omitempty"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}

	folder, err := h.vaultSvc.CreateFolder(c.Request.Context(), safeID, req.Name, req.Path, req.ParentFolderID)
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Created(c, folder, "Folder created successfully")
}

// ── 4. CREDENTIALS & ENVELOPE ENCRYPTION (Features 10 & 13) ────────────────────
func (h *VaultHandler) ListCredentials(c *gin.Context) {
	safeID := c.Param("safe_id")
	entries, err := h.vaultSvc.ListCredentials(c.Request.Context(), safeID)
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, entries, "Credentials retrieved successfully")
}

func (h *VaultHandler) CreateCredential(c *gin.Context) {
	safeID := c.Param("safe_id")
	var req services.StoreCredentialRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	req.SafeID = safeID
	req.CreatedBy = c.GetString("user_id")

	cred, err := h.vaultSvc.StoreCredential(c.Request.Context(), req)
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Created(c, cred, "Credential encrypted and stored successfully")
}

func (h *VaultHandler) GetCredential(c *gin.Context) {
	credID := c.Param("credential_id")
	cred, err := h.vaultSvc.GetCredential(c.Request.Context(), credID)
	if err != nil {
		if errors.Is(err, services.ErrCredentialNotFound) {
			response.Error(c, http.StatusNotFound, err.Error())
			return
		}
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, cred, "Credential metadata retrieved successfully")
}

// ── 5. REVEAL / CHECKOUT (Feature 10 & 14) ───────────────────────────────────
func (h *VaultHandler) RevealCredential(c *gin.Context) {
	credID := c.Param("credential_id")
	var req struct {
		Reason string `json:"reason" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}

	operator := c.GetString("username")
	if operator == "" {
		operator = c.GetString("user_id")
	}

	result, err := h.vaultSvc.RevealCredential(c.Request.Context(), credID, operator, req.Reason)
	if err != nil {
		if errors.Is(err, services.ErrCredentialArchived) {
			response.Error(c, http.StatusForbidden, err.Error())
			return
		}
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, result, "Credential revealed successfully")
}

// ── 6. VERSIONS & MANUAL PASSWORD CHANGE (Features 10 & 15) ───────────────────
func (h *VaultHandler) CreateVersion(c *gin.Context) {
	credID := c.Param("credential_id")
	var req struct {
		SecretPlaintext string `json:"secret_plaintext" binding:"required"`
		Reason          string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}

	operator := c.GetString("username")
	if operator == "" {
		operator = c.GetString("user_id")
	}

	ver, err := h.vaultSvc.CreateVersion(c.Request.Context(), credID, req.SecretPlaintext, req.Reason, operator)
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Created(c, ver, "Credential version created successfully")
}

func (h *VaultHandler) PasswordChange(c *gin.Context) {
	credID := c.Param("credential_id")
	var req struct {
		SecretPlaintext string `json:"secret_plaintext" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}

	operator := c.GetString("username")
	if operator == "" {
		operator = c.GetString("user_id")
	}

	ver, err := h.vaultSvc.PasswordChange(c.Request.Context(), credID, req.SecretPlaintext, operator)
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, ver, "Credential password updated successfully")
}

// ── 7. ROTATION REQUEST (Features 15, 16 & 17) ────────────────────────────────
func (h *VaultHandler) RequestRotation(c *gin.Context) {
	credID := c.Param("credential_id")
	operator := c.GetString("username")
	if operator == "" {
		operator = c.GetString("user_id")
	}

	job, err := h.rotationSvc.RequestRotation(c.Request.Context(), credID, operator)
	if err != nil {
		if errors.Is(err, services.ErrRotationInProgress) {
			response.Error(c, http.StatusConflict, err.Error())
			return
		}
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, job, "Credential rotation job started successfully")
}

// ── 8. BACKUP & RESTORE (Feature 119) ─────────────────────────────────────────
// vaultOpMinReason is the floor for the justification on a whole-vault
// operation. Ten characters is the same floor the JIT flow applies to a
// request for a single resource, and these two are considerably larger than
// that: one exports every secret, the other overwrites all of them.
const vaultOpMinReason = 10

// CreateBackup exports the entire vault. Root only, MFA-verified, and it will
// not run without a written justification, because the audit row for "somebody
// took a copy of every credential" is worth nothing if it does not say why.
// AuditMiddleware records the body, so the reason reaches the trail from here.
func (h *VaultHandler) CreateBackup(c *gin.Context) {
	var req struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&req)
	if len(strings.TrimSpace(req.Reason)) < vaultOpMinReason {
		response.Error(c, http.StatusBadRequest,
			fmt.Sprintf("A reason of at least %d characters is required to export the vault.", vaultOpMinReason))
		return
	}

	meta, err := h.backupSvc.CreateEncryptedBackup(c.Request.Context())
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Created(c, meta, "Encrypted Vault backup archive created successfully")
}

// RestoreBackup overwrites the live vault from a backup the caller names.
// Root only, MFA-verified, and it refuses without a justification.
//
// The audit row comes from middleware.AuditMiddleware, which is mounted on the
// whole admin group and stores the request body as the entry's details. The
// reason and the object key therefore both land in the trail without this
// handler writing anything itself, which is also why the reason is validated
// here rather than being an optional field the caller may leave blank.
func (h *VaultHandler) RestoreBackup(c *gin.Context) {
	var req struct {
		S3ObjectKey string `json:"s3_object_key" binding:"required"`
		Reason      string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Invalid request: "+err.Error())
		return
	}
	if len(strings.TrimSpace(req.Reason)) < vaultOpMinReason {
		response.Error(c, http.StatusBadRequest,
			fmt.Sprintf("A reason of at least %d characters is required to restore the vault.", vaultOpMinReason))
		return
	}

	if err := h.backupSvc.RestoreFromBackup(c.Request.Context(), req.S3ObjectKey); err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, gin.H{"status": "ok"}, "Vault backup restored successfully")
}

// ── 9. BACKWARD-COMPATIBILITY / EXTENSION HANDLERS ────────────────────────────
func (h *VaultHandler) Checkout(c *gin.Context) {
	h.RevealCredential(c)
}

func (h *VaultHandler) StoreEntry(c *gin.Context) {
	h.CreateCredential(c)
}

func (h *VaultHandler) ListEntries(c *gin.Context) {
	safeID := c.Query("safe_id")
	entries, err := h.vaultSvc.ListCredentials(c.Request.Context(), safeID)
	if err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	response.Success(c, entries, "Vault entries retrieved successfully")
}

func (h *VaultHandler) Rotate(c *gin.Context) {
	h.RequestRotation(c)
}
