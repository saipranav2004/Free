import { http } from '../lib/http'

// Local agent (pam-agent CLI) pairing + native-launch handoff.
//
// This is the "Open in Desktop App" feature: instead of the browser-tracked
// session in ConnectPanel (which never proxies a real connection, see that
// file's comment), createLaunch() gets a short-lived, single-use
// `pam-agent://launch?...` URL. Navigating the browser to it hands off to
// the OS's registered pam-agent:// protocol handler, which is the already-
// installed `pam-agent` CLI, it verifies the token, resolves the real
// connection details itself (over its own Ed25519-signed channel, never
// through this browser), and pops open a real client tool with the
// credential injected. The browser never sees the password.
//
// Everything here is the "browser side" of agent_handler.go, authenticated
// PAM-session calls. The "agent side" (pair/complete, launch/resolve,
// launch/:id/end) is a separate unauthenticated wire protocol the CLI
// speaks directly to the server; nothing in this frontend calls those.

export async function initAgentPairing(ttlMinutes) {
  const { data } = await http.post('/api/v1/pam/agent/pair/init', {
    ttl_minutes: ttlMinutes || undefined,
  })
  return data.data // { pairing_code, expires_at, expires_in_seconds }
}

export async function listAgentDevices(signal) {
  const { data } = await http.get('/api/v1/pam/agent/devices', { signal })
  return data.data // { devices, count }
}

export async function revokeAgentDevice(deviceId) {
  const { data } = await http.delete(`/api/v1/pam/agent/devices/${deviceId}`)
  return data.data
}

// May reject with a 409 when no agent device is paired yet, the backend's
// hint field (see agent_handler.go's CreateLaunch) carries the exact
// `pam-agent pair --code ... --server ...` command to run, but since the
// pairing code itself comes from a separate call (initAgentPairing), the UI
// should catch this and show the pairing flow inline rather than that raw
// hint string. See normalizeApiError(err).status === 409 in ConnectPanel.
export async function createLaunch(resourceId) {
  const { data } = await http.post(`/api/v1/pam/resources/${resourceId}/launch`)
  return data.data // { launch_id, launch_url, expires_at, expires_in_seconds }
}

// True for the one 409 that means "this browser has no agent to hand off to".
//
// Checking the status alone is not enough and used to be a latent bug: the
// same route also runs RequireActiveGrant, which answers 409 when a JIT grant
// has expired. A frontend branching on 409 would eventually tell someone whose
// grant lapsed to go and pair their laptop. The status stays as a fallback for
// a backend older than the code field.
export function isNotPairedError(normalized) {
  if (!normalized) return false
  if (normalized.code) return normalized.code === 'agent_not_paired'
  return normalized.status === 409
}

// How did that launch go?
//
// Everything after the pam-agent:// handoff happens on the operator's own
// machine, and the browser is not part of it. Without this the console cannot
// tell "psql opened" from "psql is not installed" from "no agent is running
// here": it showed the same nothing for all three, which is what made a
// missing tool look like a button that did nothing.
//
// state is one of:
//   waiting    handed off, no agent has picked it up yet
//   expired    the handoff window closed untouched, which in practice means
//              no agent is installed or running on this machine
//   opened     an agent took it and a session exists
//   completed  the tool ran and exited
//   failed     the launch could not proceed; failure_reason says why and
//              failure_hint says what to do about it
export async function getLaunchStatus(launchId, signal) {
  const { data } = await http.get(`/api/v1/pam/agent/launch/${launchId}/status`, { signal })
  return data.data
}

// ---------------------------------------------------------------------------
// One-click enrolment
// ---------------------------------------------------------------------------
// The console asks which platforms the server can actually hand out, then asks
// for an installer for one of them. The response carries a ready-to-run
// command and the script body itself, so offering a download needs no second
// request — and the browser never has to fetch the unauthenticated script URL
// just to save a file.

export async function listAgentInstallTargets(signal) {
  const { data } = await http.get('/api/v1/pam/agent/install/targets', { signal })
  return data.data // { enabled, targets: [{ os, arch, label, size_bytes, sha256, version }] }
}

// MFA-gated server-side, like pair/init: it mints a credential that enrols a
// new device against this account.
export async function createAgentInstaller({ os, arch }) {
  const { data } = await http.post('/api/v1/pam/agent/install/bootstrap', { os, arch })
  return data.data // { target, command, script_url, filename, script, expires_at, ttl_seconds }
}
