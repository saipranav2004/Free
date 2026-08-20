import { http } from '../lib/http'

// Self-service only (/api/v1/pam/resources/*), every authenticated user can
// browse and connect. Registering, deleting, or (re)credentialing a resource
// moved to the Admin Center (see api/adminResources.js) as part of the
// backend's Admin Center restructuring, those routes no longer exist here.

export async function listResourceGroups(signal) {
  const { data } = await http.get('/api/v1/pam/resources/groups', { signal })
  return data.data.groups
}

export async function listResources({ type, signal } = {}) {
  const { data } = await http.get('/api/v1/pam/resources', {
    params: type ? { type } : undefined,
    signal,
  })
  return data.data // { resources, count }
}

export async function getResource(id, signal) {
  const { data } = await http.get(`/api/v1/pam/resources/${id}`, { signal })
  return data.data.resource
}

// Returns metadata only (host/port/console_url/has_credential), NEVER a
// decrypted password. See resource_handler.go's ConnectInfo doc comment.
// May reject with a 403 whose `code` is "jit_grant_required" if the
// resource is JIT-gated and the caller has no active grant, components
// calling this should special-case that via normalizeApiError(err).code.
export async function getConnectInfo(id, signal) {
  const { data } = await http.get(`/api/v1/pam/resources/${id}/connect-info`, { signal })
  return data.data
}

export async function startSession(resourceId, protocol) {
  const { data } = await http.post(`/api/v1/pam/resources/${resourceId}/sessions`, {
    resource_id: resourceId,
    protocol,
  })
  return data.data // { session, recording?, notice? }
}
