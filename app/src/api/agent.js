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
  return data.data // { launch_url, expires_at, expires_in_seconds }
}
