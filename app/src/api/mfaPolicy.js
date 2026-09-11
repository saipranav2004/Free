import { http } from '../lib/http'

// Role-gated MFA enforcement, Admin Center API.
// (internal/api/handlers/mfa_policy_handler.go)
//
// The role IS the group: a rule names an existing PAM role and every account
// holding that role falls under it.
//
// Reads AND writes are admin-or-root (services/mfa_policy.go#canManageMFAPolicy);
// the server returns 403 for anyone else, which is why MfaPolicyPage hides the
// editing controls from a viewer who is neither rather than letting them try.
// Writes were root-only before, if you see a 403 on an admin token, the two
// halves have drifted apart and the SERVER is the one to read.

const BASE = '/api/v1/pam/admin/mfa-policy'

// { rules: [...], modes: [...], summary: {...} }
export async function getMfaPolicy(signal) {
  const { data } = await http.get(BASE, { signal })
  const payload = data?.data ?? {}
  return {
    rules: Array.isArray(payload.rules) ? payload.rules : [],
    modes: Array.isArray(payload.modes) && payload.modes.length > 0 ? payload.modes : null,
    summary: payload.summary ?? null,
  }
}

// Per-account compliance: who is gated, who has enrolled, who would be locked
// out if every rule were switched to enforce right now.
export async function getMfaCompliance(signal) {
  const { data } = await http.get(`${BASE}/compliance`, { signal })
  const payload = data?.data ?? {}
  return {
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    totalUsers: payload.total_users ?? 0,
    gated: payload.gated ?? 0,
    enrolled: payload.enrolled ?? 0,
    nonCompliant: payload.non_compliant ?? 0,
    wouldBlock: payload.would_block ?? 0,
  }
}

// Create or update the rule for one role. `payload` is
// { mode, grace_hours?, reason? }. Root only, 403 otherwise.
//
// The role name travels in the PATH, so it is encoded: a custom role may
// legitimately contain characters (a space, a slash) that would otherwise
// split the route.
export async function upsertMfaRule(roleName, payload) {
  const { data } = await http.put(`${BASE}/rules/${encodeURIComponent(roleName)}`, payload)
  return data?.data?.rule ?? null
}

export async function deleteMfaRule(roleName) {
  const { data } = await http.delete(`${BASE}/rules/${encodeURIComponent(roleName)}`)
  return data?.data ?? null
}
