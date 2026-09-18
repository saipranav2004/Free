// pam-agent/internal/apiclient/client.go
//
// Package apiclient talks to the PAM server's agent-facing endpoints
// (POST /api/v1/pam/agent/pair/complete, /agent/launch/resolve,
// /agent/launch/:session_id/end). These three endpoints are deliberately
// NOT behind the PAM browser JWT — the agent authenticates with a one-time
// pairing code (PairComplete) or an Ed25519 signature from its enrolled
// keypair (everything after). See pam/internal/api/handlers/agent_handler.go
// for the server-side half of this contract; the two must stay in sync.
package apiclient

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"github.com/yourorg/pam-agent/internal/recorder"
)

type Client struct {
	ServerURL  string
	httpClient *http.Client
}

func New(serverURL string) *Client {
	return &Client{
		ServerURL:  serverURL,
		httpClient: &http.Client{Timeout: 15 * time.Second},
	}
}

type envelope struct {
	Success bool            `json:"success"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
	Error   json.RawMessage `json:"error"`
}

// doJSON POSTs body as JSON to path and decodes the response envelope's
// "data" field into out. Returns the envelope's message/error text on
// failure so callers can show the operator something meaningful.
func (c *Client) doJSON(path string, body interface{}, out interface{}) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("failed to encode request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, c.ServerURL+path, bytes.NewReader(buf))
	if err != nil {
		return fmt.Errorf("failed to build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach PAM server at %s: %w", c.ServerURL, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read PAM server response: %w", err)
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("unexpected response from PAM server (status %d): %s", resp.StatusCode, truncate(raw, 200))
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("PAM server rejected the request (status %d): %s", resp.StatusCode, extractErrorText(env))
	}

	if out != nil && len(env.Data) > 0 {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return fmt.Errorf("failed to parse PAM server response data: %w", err)
		}
	}
	return nil
}

func extractErrorText(env envelope) string {
	if len(env.Error) > 0 {
		var s string
		if json.Unmarshal(env.Error, &s) == nil && s != "" {
			return s
		}
		return string(env.Error)
	}
	if env.Message != "" {
		return env.Message
	}
	return "unknown error"
}

func truncate(b []byte, n int) string {
	s := string(b)
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

// ── Pairing ─────────────────────────────────────────────────────────────

type PairCompleteResult struct {
	AgentDeviceID string `json:"agent_device_id"`
	DeviceName    string `json:"device_name"`
}

func (c *Client) PairComplete(pairingCode, deviceName, publicKeyB64 string) (*PairCompleteResult, error) {
	body := map[string]string{
		"pairing_code":      pairingCode,
		"device_name":       deviceName,
		"device_public_key": publicKeyB64,
	}
	var out PairCompleteResult
	if err := c.doJSON("/api/v1/pam/agent/pair/complete", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ── Launch resolution ───────────────────────────────────────────────────

// ResolvedLaunch mirrors the JSON shape returned by POST
// /api/v1/pam/agent/launch/resolve. Password is present here — and ONLY
// here, in this one struct — because this is the one call in the whole API
// allowed to carry a raw credential; it never touches a browser.
type ResolvedLaunch struct {
	SessionID         string                 `json:"session_id"`
	ResourceType      string                 `json:"resource_type"`
	Host              string                 `json:"host"`
	Port              int                    `json:"port"`
	DatabaseName      string                 `json:"database_name"`
	AccountName       string                 `json:"account_name"`
	Password          string                 `json:"password"`
	ExtraConfig       map[string]interface{} `json:"extra_config"`
	ConsoleURL        string                 `json:"console_url"`
	RecordingRequired bool                   `json:"recording_required"`

	// DataProtection is the server's egress policy for this session. Enforced
	// by the ConPTY relay on Windows (internal/launcher/guard.go); the other
	// platforms hand off to an external terminal and cannot act on it, which
	// the agent reports honestly rather than silently ignoring.
	DataProtection AgentDataProtection `json:"data_protection"`
}

// ResolveLaunch signs token with the device's private key and redeems it.
// The signed message format ("<value>|<unix-seconds>") must exactly match
// services.signingMessage on the server — see the comment there.
func (c *Client) ResolveLaunch(token, agentDeviceID string, privateKey ed25519.PrivateKey) (*ResolvedLaunch, error) {
	timestamp := time.Now()
	signature := Sign(privateKey, token, timestamp)

	body := map[string]interface{}{
		"token":           token,
		"agent_device_id": agentDeviceID,
		"timestamp":       timestamp.Unix(),
		"signature":       signature,
	}
	var out ResolvedLaunch
	if err := c.doJSON("/api/v1/pam/agent/launch/resolve", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// LaunchFailure is why a launch could not proceed, in the shape the console
// renders it: a short statement of what went wrong, the guidance that
// resolves it, and a stable code to branch on.
//
// It exists because the agent's failures were previously invisible. The OS
// starts `pam-agent launch` with no terminal attached, so anything written
// to stderr is discarded; the operator saw a button that did nothing, and
// PAM saw a session that ended. Reason/Hint travel with the session-end
// report so the browser that started the launch can say what happened.
//
// Nothing here may carry a credential, a token, a full file path from the
// operator's machine, or any other detail of their environment: it is
// stored server-side and read by administrators, not only by the operator.
type LaunchFailure struct {
	Code   string `json:"code,omitempty"`
	Reason string `json:"reason,omitempty"`
	Hint   string `json:"hint,omitempty"`
}

// EndLaunch reports that the locally-launched process has exited, so the
// PAM audit record closes with a real duration instead of staying ACTIVE
// forever. Only called when the spawn mechanism could actually observe the
// process exit — see internal/launcher's per-OS notes on this.
//
// failure is nil for a normal end. For status "FAILED" it carries what the
// console should tell the operator; see LaunchFailure.
func (c *Client) EndLaunch(sessionID, agentDeviceID, status string, privateKey ed25519.PrivateKey,
	enforcement interface{}, failure *LaunchFailure) error {
	timestamp := time.Now()
	signature := Sign(privateKey, sessionID, timestamp)

	body := map[string]interface{}{
		"agent_device_id": agentDeviceID,
		"timestamp":       timestamp.Unix(),
		"signature":       signature,
		"status":          status,
	}
	if failure != nil {
		body["failure"] = failure
	}
	// Reported at session end rather than per event. The agent is a
	// short-lived process on someone's laptop: a chatty violation endpoint
	// would be both unreliable and a way for the operator's machine to drive
	// load on the API. Nil for a platform that enforced nothing, which PAM
	// records as "unenforced" rather than as "no violations".
	if enforcement != nil {
		body["enforcement"] = enforcement
	}
	return c.doJSON(fmt.Sprintf("/api/v1/pam/agent/launch/%s/end", sessionID), body, nil)
}

// UploadRecording reports the finished, gzip'd asciicast a ConPTY-backed
// launch (see internal/launcher/spawn_windows.go) captured locally,
// closing out the recording obligation PAM created when this launch was
// resolved — the native-launch counterpart to the browser session
// gateway's own recording finalize step. status is "COMPLETED" (gz is the
// finished cast) or "FAILED" (capture itself failed locally; gz may be
// empty, failureReason should say why). Only ever called when
// ResolvedLaunch.RecordingRequired was true for this session.
//
// commands is the best-effort, keystroke-reconstructed command list (see
// internal/launcher/keylog.go) — PAM stores each as a
// SessionRecordingCommand row, the structured/searchable counterpart to
// the raw cast replay. May be empty (e.g. the operator closed the window
// before typing anything); that's fine, not an error.
func (c *Client) UploadRecording(sessionID, agentDeviceID string, privateKey ed25519.PrivateKey, gz []byte, status, failureReason string, commands []recorder.Command) error {
	return c.UploadRecordingArtifact(sessionID, agentDeviceID, privateKey, gz, RecordingFormatAsciicast, "", status, failureReason, commands)
}

// Recording artifact formats PAM understands. The agent produces two, and
// which one it produces is decided by what it was able to capture, never by
// the file's own bytes: an MP4 parsed as an asciicast would fail loudly, but
// an asciicast mislabelled as video would play as a blank rectangle.
const (
	// RecordingFormatAsciicast is a terminal transcript, gzip'd.
	RecordingFormatAsciicast = "asciicast"

	// RecordingFormatVideo is an H.264/MP4 screen capture of a desktop
	// application session. Not gzip'd: an MP4 is already compressed, and
	// gzip'ing it would cost CPU on the operator's machine to make the file
	// very slightly larger while making it unplayable without a decompression
	// step the browser does not do for <video>.
	RecordingFormatVideo = "video"
)

// UploadRecordingArtifact is UploadRecording with the artifact's format
// stated. See the format constants for why the format travels as a field
// rather than being sniffed from the bytes.
func (c *Client) UploadRecordingArtifact(sessionID, agentDeviceID string, privateKey ed25519.PrivateKey, blob []byte, format, mediaType, status, failureReason string, commands []recorder.Command) error {
	return c.uploadRecording(sessionID, agentDeviceID, privateKey, blob, format, mediaType, status, failureReason, commands)
}

func (c *Client) uploadRecording(sessionID, agentDeviceID string, privateKey ed25519.PrivateKey, gz []byte, format, mediaType, status, failureReason string, commands []recorder.Command) error {
	timestamp := time.Now()
	signature := Sign(privateKey, sessionID, timestamp)

	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	_ = w.WriteField("agent_device_id", agentDeviceID)
	_ = w.WriteField("timestamp", fmt.Sprintf("%d", timestamp.Unix()))
	_ = w.WriteField("signature", signature)
	_ = w.WriteField("status", status)
	// Stated, never sniffed: PAM picks the player from this field, and an
	// asciicast mislabelled as video would replay as a blank rectangle.
	_ = w.WriteField("format", format)
	// The container the capture actually used. Reported rather than guessed:
	// the encoder is chosen from what the LOCAL ffmpeg supports, so PAM has
	// no way to know it, and serving a WebM as video/mp4 makes a browser
	// refuse a perfectly good recording.
	if mediaType != "" {
		_ = w.WriteField("media_type", mediaType)
	}
	if failureReason != "" {
		_ = w.WriteField("failure_reason", failureReason)
	}
	if len(commands) > 0 {
		if cmdsJSON, err := json.Marshal(commands); err == nil {
			_ = w.WriteField("commands", string(cmdsJSON))
		}
	}
	if len(gz) > 0 {
		// The field name stays "cast" because that is what the server reads
		// and what every deployed agent already sends. The FILENAME is only
		// ever seen by a person reading a proxy log, so it names the real
		// container rather than claiming a screen video is an asciicast.
		part, err := w.CreateFormFile("cast", uploadFilename(format, mediaType))
		if err != nil {
			return fmt.Errorf("failed to build upload: %w", err)
		}
		if _, err := part.Write(gz); err != nil {
			return fmt.Errorf("failed to build upload: %w", err)
		}
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("failed to build upload: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, c.ServerURL+fmt.Sprintf("/api/v1/pam/agent/launch/%s/recording", sessionID), &body)
	if err != nil {
		return fmt.Errorf("failed to build request: %w", err)
	}
	req.Header.Set("Content-Type", w.FormDataContentType())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach PAM server at %s: %w", c.ServerURL, err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		var env envelope
		if json.Unmarshal(raw, &env) == nil {
			return fmt.Errorf("PAM server rejected the recording upload (status %d): %s", resp.StatusCode, extractErrorText(env))
		}
		return fmt.Errorf("PAM server rejected the recording upload (status %d): %s", resp.StatusCode, truncate(raw, 200))
	}
	return nil
}

// Sign produces the base64-encoded Ed25519 signature over
// "<value>|<unix-seconds-timestamp>" — the exact construction the server
// verifies in services.verifySignature.
func Sign(privateKey ed25519.PrivateKey, value string, timestamp time.Time) string {
	message := fmt.Sprintf("%s|%d", value, timestamp.Unix())
	sig := ed25519.Sign(privateKey, []byte(message))
	return base64.StdEncoding.EncodeToString(sig)
}

// AgentDataProtection is the policy the server resolved for this session.
// DeniedCommands arrives as a concrete list — the server has already
// substituted its built-in defaults for a resource type where the
// administrator did not name patterns, so the agent never decides policy.
type AgentDataProtection struct {
	BlockClipboard bool     `json:"block_clipboard"`
	MaxEgressBytes int64    `json:"max_egress_bytes"`
	DeniedCommands []string `json:"denied_commands"`
}

// uploadFilename names the multipart file part after what it actually holds.
// Nothing on the server parses it: the server keys the artifact off the
// "format" and "media_type" fields, which are stated explicitly. This exists
// so a WebM does not travel through the network labelled session.cast.gz.
func uploadFilename(format, mediaType string) string {
	if format != RecordingFormatVideo {
		return "session.cast.gz"
	}
	if strings.Contains(mediaType, "mp4") {
		return "session.mp4"
	}
	return "session.webm"
}
