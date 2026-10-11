import { http } from '../lib/http'

// Role criticality classification. Admin/root only, mounted inside the same
// /admin/rbac group as roles and policies, so it inherits that group's
// PAMAuth + RequireAdmin guards.
//
// See internal/services/role_criticality_service.go for the scoring model.
// The short version: four factors (privilege, blast radius, escalation path,
// standing exposure) sum to 100, compensating controls subtract, and the total
// is cut into four bands. Nothing is cached server side, every read is a fresh
// evaluation against live policy and resource rows, so a classification can
// never be stale behind a policy edit.

// Estate-wide classification, sorted most critical first, with band counts.
// One call backs the whole Roles table, so the criticality column costs a
// single request rather than one per row.
export async function getCriticalitySummary(signal) {
  const { data } = await http.get('/api/v1/pam/admin/rbac/criticality', { signal })
  return data.data // { total, by_band, overridden, roles[], evaluated_at }
}

// One role, carrying the per-factor evidence the drawer renders.
export async function getRoleCriticality(roleId, signal) {
  const { data } = await http.get(`/api/v1/pam/admin/rbac/roles/${roleId}/criticality`, { signal })
  return data.data
}

// Record a reviewer's explicit classification. Both fields are required by the
// server: an override with no reason is indistinguishable from a mistake once
// the reviewer has moved on.
export async function setRoleCriticality(roleId, { band, reason }) {
  const { data } = await http.put(`/api/v1/pam/admin/rbac/roles/${roleId}/criticality`, {
    band,
    reason,
  })
  return data.data
}

// Hand the role back to the engine.
export async function clearRoleCriticality(roleId, reason) {
  const { data } = await http.delete(`/api/v1/pam/admin/rbac/roles/${roleId}/criticality`, {
    data: reason ? { reason } : undefined,
  })
  return data.data
}
