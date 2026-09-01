import { http } from '../lib/http'

// ---------------------------------------------------------------------------
// Machine identities: the vault's data plane, provisioned from the console
// ---------------------------------------------------------------------------
// These endpoints manage the principals that read secrets WITHOUT a human
// session: an application, a job, a sidecar. They authenticate with a service
// token against /api/v1/pam/svc, which this console never calls and never
// should. Everything here is the control plane: create the identity, mint a
// token for it, grant it a path scope, take any of that away.
//
// THE TOKEN IS RETURNED EXACTLY ONCE, by issueToken, and only the server has
// ever seen the secret half before that moment. It is never stored, never put
// in a query cache and never logged: the caller hands it straight to the
// person and forgets it. Every other call in this file returns metadata only,
// which is why listTokens is safe to cache and issueToken is not.

export async function listServiceIdentities(signal) {
  const { data } = await http.get('/api/v1/pam/admin/services', { signal })
  return data.data || []
}

export async function createServiceIdentity(payload) {
  const { data } = await http.post('/api/v1/pam/admin/services', payload)
  return data.data
}

export async function disableServiceIdentity(serviceId) {
  const { data } = await http.post(`/api/v1/pam/admin/services/${serviceId}/disable`)
  return data.data
}

export async function listServiceTokens(serviceId, signal) {
  const { data } = await http.get(`/api/v1/pam/admin/services/${serviceId}/tokens`, { signal })
  return data.data || []
}

/**
 * Mints a token. The response carries the only copy that will ever exist.
 *
 * Deliberately not a query: it is a one-shot side effect whose result must not
 * be cached, retried or replayed by anything.
 */
export async function issueServiceToken(serviceId, { description, ttlDays } = {}) {
  const { data } = await http.post(`/api/v1/pam/admin/services/${serviceId}/tokens`, {
    description,
    ttl_days: ttlDays,
  })
  return data.data
}

export async function revokeServiceToken(tokenId) {
  const { data } = await http.delete(`/api/v1/pam/admin/service-tokens/${tokenId}`)
  return data.data
}

export async function listServiceGrants(serviceId, signal) {
  const { data } = await http.get(`/api/v1/pam/admin/services/${serviceId}/grants`, { signal })
  return data.data || []
}

export async function grantServiceScope(serviceId, payload) {
  const { data } = await http.post(`/api/v1/pam/admin/services/${serviceId}/grants`, {
    scope: payload.scope,
    reason: payload.reason,
    max_ttl_seconds: payload.maxTtlSeconds,
    expires_in_days: payload.expiresInDays,
  })
  return data.data
}

export async function revokeServiceGrant(grantId) {
  const { data } = await http.delete(`/api/v1/pam/admin/service-grants/${grantId}`)
  return data.data
}
