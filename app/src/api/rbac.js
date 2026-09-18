import { http } from '../lib/http'

// RBAC (Roles) + PBAC (Policies), the Admin Center screens for defining
// what a role or policy IS (as opposed to identity.js, which assigns them
// to a specific user). Admin/root only
// (/api/v1/pam/admin/rbac/{roles,policies}). Brand new surface, see
// rbac_handler.go / opa/engine.go for the embedded policy engine these
// feed.

// ── Roles ────────────────────────────────────────────────────────────────

export async function listRoles(signal) {
  const { data } = await http.get('/api/v1/pam/admin/rbac/roles', { signal })
  return data.data.roles
}

export async function getRole(id, signal) {
  const { data } = await http.get(`/api/v1/pam/admin/rbac/roles/${id}`, { signal })
  return data.data // { role, policies }
}

export async function createRole(payload) {
  const { data } = await http.post('/api/v1/pam/admin/rbac/roles', payload)
  return data.data.role
}

export async function updateRole(id, description) {
  const { data } = await http.patch(`/api/v1/pam/admin/rbac/roles/${id}`, { description })
  return data.data.role
}

export async function deleteRole(id) {
  const { data } = await http.delete(`/api/v1/pam/admin/rbac/roles/${id}`)
  return data.data
}

export async function attachPolicyToRole(roleId, policyId) {
  const { data } = await http.post(`/api/v1/pam/admin/rbac/roles/${roleId}/policies`, {
    policy_id: policyId,
  })
  return data.data
}

export async function detachPolicyFromRole(roleId, policyId) {
  const { data } = await http.delete(`/api/v1/pam/admin/rbac/roles/${roleId}/policies/${policyId}`)
  return data.data
}

// ── Policies ─────────────────────────────────────────────────────────────

export async function listPolicies(signal) {
  const { data } = await http.get('/api/v1/pam/admin/rbac/policies', { signal })
  return data.data.policies
}

export async function getPolicy(id, signal) {
  const { data } = await http.get(`/api/v1/pam/admin/rbac/policies/${id}`, { signal })
  return data.data.policy
}

export async function createPolicy(payload) {
  const { data } = await http.post('/api/v1/pam/admin/rbac/policies', payload)
  return data.data.policy
}

export async function updatePolicy(id, payload) {
  const { data } = await http.patch(`/api/v1/pam/admin/rbac/policies/${id}`, payload)
  return data.data.policy
}

export async function deletePolicy(id) {
  const { data } = await http.delete(`/api/v1/pam/admin/rbac/policies/${id}`)
  return data.data
}
