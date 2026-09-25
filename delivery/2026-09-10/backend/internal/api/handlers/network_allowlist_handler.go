// pam/internal/api/handlers/network_allowlist_handler.go
package handlers

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/yourorg/pam/internal/middleware"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
)

// NetworkAllowlistHandler exposes the source-address allowlist to the root
// operator. Every route here is behind middleware.RequireRoot: this is the
// control that decides who can reach the product at all, so an admin editing
// it could lock root out or open the console to a range root never approved.
type NetworkAllowlistHandler struct {
	svc *services.NetworkAllowlistService
}

func NewNetworkAllowlistHandler(svc *services.NetworkAllowlistService) *NetworkAllowlistHandler {
	return &NetworkAllowlistHandler{svc: svc}
}

// Get returns the switch, the ranges, and the caller's own address.
//
// The caller's address is part of the payload on purpose. The console needs
// it to show "this is you" next to a matching range and to warn before a
// change that would lock the operator out, and the browser has no other way
// to learn the address this API actually sees — which, behind a load
// balancer, is the only address that matters.
func (h *NetworkAllowlistHandler) Get(c *gin.Context) {
	snapshot, err := h.svc.Snapshot()
	if err != nil {
		response.Error(c, http.StatusInternalServerError, "Could not read the network allowlist")
		return
	}
	// your_ip_is_infrastructure and proxy_state are what let the console warn
	// BEFORE anything is enforced. Without them the panel's most inviting
	// control ("Use my address") is also the one that silently opens the
	// product to everyone, because behind an unconfigured proxy the address
	// it offers is the load balancer's and every request matches it.
	//
	// Both are properties of this deployment's own configuration, not of any
	// user or resource, so there is nothing here an operator could not
	// already learn by reading the environment of the service they run.
	response.Success(c, gin.H{
		"enabled":                   snapshot.Enabled,
		"entries":                   snapshot.Entries,
		"your_ip":                   c.ClientIP(),
		"your_ip_is_allowed":        allowedNow(h.svc, c.ClientIP()),
		"your_ip_is_infrastructure": services.IsInfrastructureAddress(c.ClientIP()),
		"proxy_state":               string(h.svc.ProxyState()),
	}, "")
}

func allowedNow(svc *services.NetworkAllowlistService, ip string) bool {
	ok, err := svc.IsAllowed(ip)
	return err == nil && ok
}

type addAllowlistEntryRequest struct {
	CIDR  string `json:"cidr" binding:"required"`
	Label string `json:"label"`
}

func (h *NetworkAllowlistHandler) Add(c *gin.Context) {
	var req addAllowlistEntryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, http.StatusBadRequest, "Enter an IP address or CIDR range")
		return
	}
	userID, username := middleware.AdminIdentityFromContext(c)

	entry, err := h.svc.AddEntry(req.CIDR, req.Label, userID, username)
	if err != nil {
		response.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	response.Created(c, entry, "Range added to the allowlist")
}

func (h *NetworkAllowlistHandler) Remove(c *gin.Context) {
	if err := h.svc.RemoveEntry(c.Param("id"), c.ClientIP()); err != nil {
		if errors.Is(err, services.ErrWouldLockOut) {
			response.Error(c, http.StatusConflict, err.Error())
			return
		}
		response.Error(c, http.StatusNotFound, "That allowlist entry no longer exists")
		return
	}
	response.Success(c, gin.H{"removed": true}, "Range removed from the allowlist")
}

type setAllowlistEnabledRequest struct {
	// Pointer, so "false" is distinguishable from "not sent". Binding a
	// plain bool would read a missing field as a request to turn
	// enforcement off, which is the wrong default for a security control.
	Enabled *bool `json:"enabled" binding:"required"`
}

func (h *NetworkAllowlistHandler) SetEnabled(c *gin.Context) {
	var req setAllowlistEnabledRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Enabled == nil {
		response.Error(c, http.StatusBadRequest, "Send enabled: true or enabled: false")
		return
	}
	userID, username := middleware.AdminIdentityFromContext(c)

	if err := h.svc.SetEnabled(*req.Enabled, c.ClientIP(), userID, username); err != nil {
		if errors.Is(err, services.ErrWouldLockOut) {
			response.Error(c, http.StatusConflict, err.Error())
			return
		}
		response.Error(c, http.StatusInternalServerError, "Could not save the setting")
		return
	}
	response.Success(c, gin.H{"enabled": *req.Enabled}, "Network allowlist updated")
}

// NginxSnippet serves the same ranges as nginx allow/deny directives, for
// the console container to include. Plain text rather than the JSON envelope
// every other route uses, because the consumer is `wget -O` inside an
// entrypoint script, not the browser.
func (h *NetworkAllowlistHandler) NginxSnippet(c *gin.Context) {
	snippet, err := h.svc.NginxSnippet()
	if err != nil {
		response.Error(c, http.StatusInternalServerError, "Could not render the allowlist")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.String(http.StatusOK, "%s", snippet)
}
