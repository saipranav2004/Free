// pam/internal/api/handlers/secret_access_handler.go
//
// Machine data-plane HTTP surface.
//
// Routes (mounted under a group carrying ONLY middleware.ServiceAuth):
//
//	GET  /api/v1/pam/svc/secrets/*path            → one secret by canonical path or UUID
//	GET  /api/v1/pam/svc/resources/:id/secrets    → every readable secret for a resource
package handlers

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/middleware"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

type SecretAccessHandler struct {
	secretSvc *services.SecretAccessService
	logger    *zap.Logger
}

func NewSecretAccessHandler(secretSvc *services.SecretAccessService, logger *zap.Logger) *SecretAccessHandler {
	return &SecretAccessHandler{secretSvc: secretSvc, logger: logger}
}

// GetSecret serves one secret.
//
// GET rather than POST: a secret read is a read, and making it a GET is what
// lets the client, and any HTTP tooling in between, treat it with normal
// semantics. The `purpose` that goes into the audit record travels as a query
// parameter (or the X-Secret-Purpose header) instead of a request body, a
// GET with a body is the kind of thing proxies quietly drop.
func (h *SecretAccessHandler) GetSecret(c *gin.Context) {
	noStore(c)

	principal, ok := middleware.ServicePrincipalFrom(c)
	if !ok {
		response.Error(c, http.StatusUnauthorized, "Service authentication required")
		return
	}

	// gin's wildcard param always arrives with a leading slash.
	ref := strings.Trim(c.Param("path"), "/")
	if ref == "" {
		response.Error(c, http.StatusBadRequest, "Secret path is required")
		return
	}

	purpose := secretPurpose(c)
	if purpose == "" {
		// Mandatory, not decorative: the purpose is what makes the audit trail
		// answerable to "why did billing-api read the DB root password at 3am".
		response.Error(c, http.StatusBadRequest,
			"A purpose is required (query parameter `purpose` or header X-Secret-Purpose)")
		return
	}

	secret, err := h.secretSvc.GetSecret(c.Request.Context(), principal, ref, purpose, c.ClientIP())
	if err != nil {
		h.writeError(c, err)
		return
	}
	response.Success(c, secret, "Secret retrieved successfully")
}

// GetResourceSecrets serves every secret attached to a resource that this
// principal is allowed to read.
func (h *SecretAccessHandler) GetResourceSecrets(c *gin.Context) {
	noStore(c)

	principal, ok := middleware.ServicePrincipalFrom(c)
	if !ok {
		response.Error(c, http.StatusUnauthorized, "Service authentication required")
		return
	}

	resourceID := strings.TrimSpace(c.Param("resource_id"))
	if resourceID == "" {
		response.Error(c, http.StatusBadRequest, "Resource id is required")
		return
	}

	purpose := secretPurpose(c)
	if purpose == "" {
		response.Error(c, http.StatusBadRequest,
			"A purpose is required (query parameter `purpose` or header X-Secret-Purpose)")
		return
	}

	secrets, err := h.secretSvc.GetSecretsByResource(c.Request.Context(), principal, resourceID, purpose, c.ClientIP())
	if err != nil {
		h.writeError(c, err)
		return
	}
	response.Success(c, secrets, "Resource secrets retrieved successfully")
}

func (h *SecretAccessHandler) writeError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, services.ErrSecretNotFound):
		response.Error(c, http.StatusNotFound, "Secret not found")
	case errors.Is(err, services.ErrSecretAmbiguous):
		// Actionable on purpose: the fix is for the caller to qualify the path,
		// and this leaks nothing they were not already asking for.
		response.Error(c, http.StatusConflict,
			"Secret name is ambiguous across safes. Use the fully qualified path <safe>/<folder>/<name>.")
	case errors.Is(err, services.ErrServiceUnauthorized), errors.Is(err, services.ErrScopeNotGranted):
		response.Error(c, http.StatusForbidden, "Service not authorized to access this secret")
	default:
		// Never surface err.Error() here: on the decrypt path it carries KMS
		// key references and envelope internals.
		h.logger.Error("vault.secret.read.failed", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to retrieve secret")
	}
}

// noStore keeps plaintext out of every cache between here and the client.
// Without it a reverse proxy or client HTTP cache is entitled to retain a
// 200 response body containing a privileged credential.
func noStore(c *gin.Context) {
	c.Header("Cache-Control", "no-store, no-cache, must-revalidate, private")
	c.Header("Pragma", "no-cache")
	c.Header("Expires", "0")
	// Keep the secret path out of the Referer of any page the response feeds.
	c.Header("Referrer-Policy", "no-referrer")
}

func secretPurpose(c *gin.Context) string {
	if p := strings.TrimSpace(c.Query("purpose")); p != "" {
		return truncatePurpose(p)
	}
	return truncatePurpose(strings.TrimSpace(c.GetHeader("X-Secret-Purpose")))
}

func truncatePurpose(p string) string {
	const max = 256
	if len(p) > max {
		return p[:max]
	}
	return p
}
