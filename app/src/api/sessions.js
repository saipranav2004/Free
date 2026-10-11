import { http } from '../lib/http'

// Self-service only, your own sessions (list/end). Org-wide visibility and
// killing someone else's session are Admin Center only now (see
// api/admin.js's listSessions/killSession, which hit
// /api/v1/pam/admin/sessions and /api/v1/pam/admin/actions/sessions/:id/kill).

export async function listMySessions({ page = 1, pageSize = 20, status, activeOnly, signal } = {}) {
  const { data } = await http.get('/api/v1/pam/sessions/mine', {
    params: {
      page,
      page_size: pageSize,
      status: status || undefined,
      active: activeOnly ? 'true' : undefined,
    },
    signal,
  })
  return data.data // { sessions, pagination }
}

export async function endSession(id) {
  const { data } = await http.post(`/api/v1/pam/sessions/${id}/end`)
  return data.data
}
