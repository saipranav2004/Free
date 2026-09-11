// pam/internal/api/handlers/agent_handler.go
package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/pam/internal/middleware"
	"github.com/yourorg/pam/internal/response"
	"github.com/yourorg/pam/internal/services"
	"go.uber.org/zap"
)

// AgentHandler exposes the local-agent pairing and native-launch endpoints.
// Two very different trust levels live in this one file: the "browser side"
// endpoints (PairInit, ListDevices, RevokeDevice, CreateLaunch) sit behind
// the normal middleware.PAMAuth + middleware.RequirePermission chain like
// everything else in the API. The "agent side" endpoints (PairComplete,
// ResolveLaunch, EndLaunch) are deliberately registered WITHOUT PAMAuth in
// main.go — the agent is a short-lived CLI process with no PAM browser
// session, so it authenticates itself differently: a one-time pairing code
// for PairComplete, and an Ed25519 signature from its enrolled keypair for
// everything after that. Do not add PAMAuth to those three routes.
type AgentHandler struct {
	svc           *services.AgentService
	publicBaseURL string
	logger        *zap.Logger
}

func NewAgentHandler(svc *services.AgentService, publicBaseURL string, logger *zap.Logger) *AgentHandler {
	return &AgentHandler{svc: svc, publicBaseURL: publicBaseURL, logger: logger}
}

// requestOrigin reconstructs "scheme://host" for the backend as this
// specific request actually reached it — honoring X-Forwarded-Proto/-Host
// when present (reverse proxy / load balancer in front of the API), and
// c.Request.Host / c.Request.TLS otherwise. Returns "" only if the request
// has no Host header at all, which should not happen in practice.
func requestOrigin(c *gin.Context) string {
	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	}
	if proto := c.GetHeader("X-Forwarded-Proto"); proto != "" {
		scheme = strings.TrimSpace(strings.Split(proto, ",")[0])
	}

	host := c.Request.Host
	if fwdHost := c.GetHeader("X-Forwarded-Host"); fwdHost != "" {
		host = strings.TrimSpace(strings.Split(fwdHost, ",")[0])
	}
	if host == "" {
		return ""
	}

	return scheme + "://" + host
}

// resolveServerURL is requestOrigin() (the host/scheme this request actually
// arrived on — always correct, see requestOrigin's comment) plus, if
// configured, a fixed path suffix carried over from cfg.Server.PublicURL —
// e.g. set PAM_SERVER_PUBLIC_URL to "https://anything/api" when the backend
// only answers under a specific sub-path on the same domain the frontend is
// served from (a reverse proxy routing /api/* to this service and
// everything else to the SPA). Only the PATH is taken from that config
// value — the host/scheme portion of it is deliberately ignored, since a
// wrong host there is exactly the bug requestOrigin() exists to route
// around. Leave PAM_SERVER_PUBLIC_URL unset, or set it to a bare host with
// no path, to get plain requestOrigin() behavior.
func (h *AgentHandler) resolveServerURL(c *gin.Context) string {
	origin := requestOrigin(c)
	if origin == "" {
		return h.publicBaseURL
	}
	if h.publicBaseURL != "" {
		if u, err := url.Parse(h.publicBaseURL); err == nil && u.Path != "" && u.Path != "/" {
			return strings.TrimRight(origin, "/") + u.Path
		}
	}
	return origin
}

// ── Pairing: browser side (authenticated PAM user) ─────────────────────────

// pairInitRequest is entirely optional — a plain POST with no body still
// works and gets the default 5-minute code. TTLMinutes only exists for
// callers that need a longer-lived code, e.g. an installer embedding a
// one-time setup token; AgentService.InitPairing silently caps whatever is
// requested at its own maximum rather than rejecting an over-generous
// value outright.
type pairInitRequest struct {
	TTLMinutes int `json:"ttl_minutes"`
}

func (h *AgentHandler) PairInit(c *gin.Context) {
	userID, _ := c.Get("user_id")

	var req pairInitRequest
	// Body is optional — ignore a bind error (including an empty body) and
	// fall back to the zero value, which InitPairing treats as "use the
	// default TTL."
	_ = c.ShouldBindJSON(&req)
	ttl := time.Duration(req.TTLMinutes) * time.Minute

	code, expiresAt, err := h.svc.InitPairing(userID.(string), ttl)
	if err != nil {
		h.logger.Error("agent.pair_init.fail", zap.Error(err))
		response.Error(c, 500, "Failed to generate pairing code")
		return
	}
	// Same fix as CreateLaunch's launch_url below: don't hand back the
	// static (and, per the bug report, frequently wrong) cfg.Server.PublicURL
	// as the "--server" the user is told to pair with — hand back the
	// origin this very request landed on instead.
	serverURL := h.resolveServerURL(c)
	response.Success(c, gin.H{
		"pairing_code":       code,
		"server_url":         serverURL,
		"expires_at":         expiresAt,
		"expires_in_seconds": int(time.Until(expiresAt).Seconds()),
	}, fmt.Sprintf("Run: pam-agent pair --code %s --server %s", code, serverURL))
}

// ── Pairing: agent side (unauthenticated — the code IS the credential) ─────

type pairCompleteRequest struct {
	PairingCode     string `json:"pairing_code" binding:"required"`
	DeviceName      string `json:"device_name" binding:"required"`
	DevicePublicKey string `json:"device_public_key" binding:"required"`
}

func (h *AgentHandler) PairComplete(c *gin.Context) {
	var req pairCompleteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, 400, "pairing_code, device_name, and device_public_key are required")
		return
	}

	device, err := h.svc.CompletePairing(req.PairingCode, req.DeviceName, req.DevicePublicKey)
	if err != nil {
		if errors.Is(err, services.ErrPairingCodeInvalid) {
			response.Error(c, 401, "Pairing code is invalid, expired, or already used")
			return
		}
		h.logger.Error("agent.pair_complete.fail", zap.Error(err))
		response.Error(c, 500, "Failed to complete pairing")
		return
	}

	response.Created(c, gin.H{
		"agent_device_id": device.ID,
		"device_name":     device.DeviceName,
	}, "Agent paired successfully")
}

// ── Device management: browser side ─────────────────────────────────────────

func (h *AgentHandler) ListDevices(c *gin.Context) {
	userID, _ := c.Get("user_id")
	devices, err := h.svc.ListDevices(userID.(string))
	if err != nil {
		response.Error(c, 500, "Failed to fetch agent devices")
		return
	}
	response.Success(c, gin.H{"devices": devices, "count": len(devices)}, "Agent devices fetched")
}

func (h *AgentHandler) RevokeDevice(c *gin.Context) {
	userID, _ := c.Get("user_id")
	if err := h.svc.RevokeDevice(userID.(string), c.Param("id")); err != nil {
		if errors.Is(err, services.ErrDeviceNotFound) {
			response.Error(c, 404, "Agent device not found")
			return
		}
		response.Error(c, 500, "Failed to revoke agent device")
		return
	}
	response.Success(c, nil, "Agent device revoked")
}

// ── Launch: browser side (authenticated + pam:resource:Connect-gated) ──────

func (h *AgentHandler) CreateLaunch(c *gin.Context) {
	resourceID := c.Param("id")
	userID, _ := c.Get("user_id")
	authzDecisionID, _ := c.Get("authz_decision_id")
	uid := userID.(string)

	hasDevice, err := h.svc.HasActiveDevice(uid)
	if err != nil {
		h.logger.Error("agent.launch.device_check.fail", zap.Error(err))
		response.Error(c, 500, "Failed to check paired agent devices")
		return
	}
	if !hasDevice {
		// The console shows a pairing panel for this, so the code matters
		// more than the prose: a 409 alone is ambiguous (RequireActiveGrant
		// also answers 409 on this route), and a frontend branching on the
		// status code alone would eventually show "pair your device" to
		// someone whose real problem was an expired grant.
		c.JSON(http.StatusConflict, gin.H{
			"success": false,
			"code":    "agent_not_paired",
			"error":   "This device is not paired with your account yet",
			"hint":    "Call POST /api/v1/pam/agent/pair/init from an authenticated session, then run: pam-agent pair --code <code> --server <this PAM server>",
		})
		return
	}

	// Carry the grant context RequireActiveGrant already resolved for this
	// request into the launch token itself — see models.LaunchToken's doc
	// comment for why: by the time the agent redeems the token, there is no
	// gin.Context left to read it from. Zero value for a resource that
	// isn't JIT-gated (RequireActiveGrant didn't run, or ran and found
	// nothing required), which is exactly the "no grant to bind" case.
	grantCtx := middleware.GrantFromContext(c)

	token, launchID, expiresAt, err := h.svc.CreateLaunchToken(uid, resourceID, toString(authzDecisionID), services.LaunchGrantContext{
		GrantID:           grantCtx.GrantID,
		JITRequestID:      grantCtx.JITRequestID,
		IsBreakglass:      grantCtx.IsBreakglass,
		RecordingRequired: grantCtx.RecordingRequired,
	})
	if err != nil {
		h.logger.Error("agent.launch.create.fail", zap.Error(err))
		response.Error(c, 500, "Failed to create launch token")
		return
	}

	// Prefer the origin this very request actually arrived on over the
	// static cfg.Server.PublicURL: that config value is a common
	// misconfiguration point (easy to accidentally set to the frontend's
	// URL instead of the backend's, especially when both are fronted by
	// the same domain/reverse proxy), and it is exactly what breaks
	// pairing — the agent gets handed a "server" it can't reach or that
	// doesn't serve the PAM API. See resolveServerURL for how an optional
	// path suffix (e.g. "/api") from that same config value is still
	// honored on top of the auto-detected host.
	serverURL := h.resolveServerURL(c)

	launchURL := fmt.Sprintf("pam-agent://launch?token=%s&server=%s",
		url.QueryEscape(token), url.QueryEscape(serverURL))

	// launch_id is the handle the browser keeps so it can find out how the
	// launch went (GET .../agent/launch/:launch_id/status). It is the launch
	// row's id, NOT the secret inside launch_url: that one is stored only as
	// a hash and never leaves this response.
	response.Success(c, gin.H{
		"launch_id":          launchID,
		"launch_url":         launchURL,
		"expires_at":         expiresAt,
		"expires_in_seconds": int(time.Until(expiresAt).Seconds()),
	}, "Navigate the browser to launch_url to hand off to the local PAM agent")
}

// LaunchStatus handles GET /api/v1/pam/resources/launch/:launch_id/status
//
// Browser side (authenticated PAM user). This is the return path for a
// handoff: the browser navigates to a pam-agent:// URL and then has no idea
// what happened, because everything after that runs on the operator's own
// machine. Polling this tells it whether an agent ever picked the launch up,
// and if the launch failed, why, in words the operator can act on.
//
// Scoped to the caller inside the service (see GetLaunchStatus): a launch
// belonging to someone else is reported as not found, so this cannot be used
// to enumerate launch ids.
func (h *AgentHandler) LaunchStatus(c *gin.Context) {
	userID, _ := c.Get("user_id")
	uid, _ := userID.(string)

	status, err := h.svc.GetLaunchStatus(uid, c.Param("launch_id"))
	if err != nil {
		if errors.Is(err, services.ErrLaunchTokenInvalid) {
			response.Error(c, http.StatusNotFound, "That launch does not exist")
			return
		}
		h.logger.Error("agent.launch.status.fail", zap.Error(err))
		response.Error(c, http.StatusInternalServerError, "Failed to read the launch status")
		return
	}
	response.Success(c, status, "")
}

// ── Launch resolution: agent side (unauthenticated — signature IS the auth) ─

type launchResolveRequest struct {
	Token         string `json:"token" binding:"required"`
	AgentDeviceID string `json:"agent_device_id" binding:"required"`
	Timestamp     int64  `json:"timestamp" binding:"required"`
	Signature     string `json:"signature" binding:"required"`
}

func (h *AgentHandler) ResolveLaunch(c *gin.Context) {
	var req launchResolveRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, 400, "token, agent_device_id, timestamp, and signature are required")
		return
	}

	resolved, err := h.svc.ResolveLaunchToken(
		req.Token, req.AgentDeviceID, req.Signature, time.Unix(req.Timestamp, 0), c.ClientIP(),
	)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrDeviceNotFound), errors.Is(err, services.ErrDeviceRevoked):
			response.Error(c, 401, "Agent device is not recognized or has been revoked")
		case errors.Is(err, services.ErrSignatureInvalid):
			response.Error(c, 401, "Signature verification failed")
		case errors.Is(err, services.ErrLaunchTokenInvalid):
			response.Error(c, 401, "Launch token is invalid, expired, or already used")
		case errors.Is(err, services.ErrConnectMethodNotAllowed):
			// 403, not 401: the device and signature are fine and the token
			// was valid — the resource's policy closed this route. Saying so
			// distinctly is what stops an operator re-pairing their agent to
			// chase what looks like an auth problem.
			response.Error(c, 403,
				"This resource does not permit the native agent — open it from the PAM console instead")
		default:
			h.logger.Error("agent.launch.resolve.fail", zap.Error(err))
			response.Error(c, 500, "Failed to resolve launch")
		}
		return
	}

	// Deliberately the ONE response in this entire API allowed to carry a
	// raw credential: ConnectionInfo.Password is tagged json:"-" precisely
	// so marshaling the struct directly (as every other handler does) can
	// never leak it. Building the response as an explicit map here bypasses
	// that tag on purpose — this response goes agent-to-server over a
	// channel the browser never touches.
	response.Success(c, gin.H{
		"session_id":         resolved.SessionID,
		"resource_type":      resolved.ResourceType,
		"host":               resolved.Host,
		"port":               resolved.Port,
		"database_name":      resolved.DatabaseName,
		"account_name":       resolved.AccountName,
		"password":           resolved.Password,
		"extra_config":       resolved.ExtraConfig,
		"console_url":        resolved.ConsoleURL,
		"recording_required": resolved.RecordingRequired,

		// Enforced by the agent's ConPTY relay on Windows (pam-agent's
		// internal/launcher/guard.go). Sent on every platform even though only
		// Windows can act on it: the agent reports back whether it enforced,
		// so PAM records the difference rather than assuming.
		"data_protection": resolved.DataProtection,
	}, "Launch resolved")
}

// ── Launch teardown: agent side (unauthenticated — signature IS the auth) ──

type launchEndRequest struct {
	AgentDeviceID string `json:"agent_device_id" binding:"required"`
	Timestamp     int64  `json:"timestamp" binding:"required"`
	Signature     string `json:"signature" binding:"required"`
	Status        string `json:"status"` // COMPLETED | FAILED — defaults to COMPLETED

	// Failure is why a FAILED launch failed, composed by the agent for the
	// operator to read. Optional: an older agent sends none, and a normal end
	// has none. Bounded and stored as data by the service, never interpreted
	// here — see services.LaunchFailure on why this is a trust boundary.
	Failure *services.LaunchFailure `json:"failure"`
}

func (h *AgentHandler) EndLaunch(c *gin.Context) {
	sessionID := c.Param("session_id")
	var req launchEndRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Error(c, 400, "agent_device_id, timestamp, and signature are required")
		return
	}
	status := req.Status
	if status == "" {
		status = "COMPLETED"
	}

	if err := h.svc.VerifyDeviceSignature(req.AgentDeviceID, sessionID, req.Signature, time.Unix(req.Timestamp, 0)); err != nil {
		response.Error(c, 401, "Signature verification failed")
		return
	}

	if err := h.svc.EndLaunchSession(sessionID, req.AgentDeviceID, status, req.Failure); err != nil {
		response.Error(c, 500, "Failed to end session")
		return
	}
	response.Success(c, nil, "Session ended")
}

// UploadLaunchRecording handles POST /api/v1/pam/agent/launch/:session_id/recording
//
// Agent side (unauthenticated — signature IS the auth, same as EndLaunch):
// the native-launch counterpart to gateway.go's finalizeRecording. A
// ConPTY-capable agent that captured this session locally uploads the
// finished asciicast here once the local process has exited; the recording
// obligation StartTrackedSession created when the launch was resolved gets
// closed out exactly the way a browser-terminal recording does.
func (h *AgentHandler) UploadLaunchRecording(c *gin.Context) {
	sessionID := c.Param("session_id")

	agentDeviceID := c.PostForm("agent_device_id")
	signature := c.PostForm("signature")
	timestampStr := c.PostForm("timestamp")
	status := c.PostForm("status")
	failureReason := c.PostForm("failure_reason")
	format := c.PostForm("format")
	mediaType := c.PostForm("media_type")

	if agentDeviceID == "" || signature == "" || timestampStr == "" {
		response.Error(c, 400, "agent_device_id, timestamp, and signature are required")
		return
	}
	timestampUnix, err := strconv.ParseInt(timestampStr, 10, 64)
	if err != nil {
		response.Error(c, 400, "timestamp must be a unix seconds integer")
		return
	}

	if err := h.svc.VerifyDeviceSignature(agentDeviceID, sessionID, signature, time.Unix(timestampUnix, 0)); err != nil {
		response.Error(c, 401, "Signature verification failed")
		return
	}

	var gz []byte
	if status != "FAILED" {
		file, _, err := c.Request.FormFile("cast")
		if err != nil {
			response.Error(c, 400, "cast file is required unless status is FAILED")
			return
		}
		defer file.Close()
		gz, err = io.ReadAll(file)
		if err != nil {
			response.Error(c, 400, "failed to read uploaded cast file")
			return
		}
	}

	// commands is optional — a browser-launched session has no equivalent
	// upload at all, and even an agent one may have captured zero lines
	// (e.g. the operator closed the window before typing anything).
	var commands []services.CapturedCommand
	if raw := c.PostForm("commands"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &commands); err != nil {
			h.logger.Warn("agent.recording.upload.commands_parse_fail", zap.String("session_id", sessionID), zap.Error(err))
			commands = nil // malformed commands payload shouldn't fail the whole upload
		}
	}

	if err := h.svc.UploadLaunchRecording(sessionID, agentDeviceID, gz, format, mediaType, status, failureReason, commands); err != nil {
		h.logger.Error("agent.recording.upload.fail", zap.String("session_id", sessionID), zap.Error(err))
		response.Error(c, 500, "Failed to store uploaded recording")
		return
	}
	response.Success(c, nil, "Recording uploaded")
}

// toString is a tiny defensive helper for pulling a string back out of a
// gin.Context value that might be nil (context key never set) or already a
// string — used wherever a context value's presence is optional but its
// type, if present, is always string (see authz_decision_id above).
func toString(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
