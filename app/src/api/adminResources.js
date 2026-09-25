import { http } from '../lib/http'

// Admin Center resource management (/api/v1/pam/admin/resources/*) ,
// registering, deleting, and (re)credentialing a resource is admin/root
// only (middleware.RequireAdmin). Ordinary users keep read/browse/connect
// via api/resources.js. Both hit the SAME `http` client with the SAME
// Bearer token, there is no separate service-token trust boundary anymore,
// only the "roles" claim on the caller's own JWT.

export async function createResource(payload) {
  const { data } = await http.post('/api/v1/pam/admin/resources', payload)
  return data.data.resource
}

export async function deleteResource(id) {
  const { data } = await http.delete(`/api/v1/pam/admin/resources/${id}`)
  return data.data
}

// The "legacy" single-credential-per-resource path, distinct from the full
// Safes/Folders/Credentials vault model in api/vault.js. Both exist in the
// backend; this is the simple one attached directly to a resource record,
// and it's admin-only now (moved off the self-service routes).
export async function storeResourceCredential(id, payload) {
  const { data } = await http.post(`/api/v1/pam/admin/resources/${id}/credential`, payload)
  return data.data
}

export async function rotateResourceCredential(id, newCredential) {
  const { data } = await http.post(`/api/v1/pam/admin/resources/${id}/rotate`, {
    new_credential: newCredential,
  })
  return data.data
}
