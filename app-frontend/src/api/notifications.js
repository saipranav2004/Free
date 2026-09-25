import { http } from '../lib/http'

// ---------------------------------------------------------------------------
// Notification centre
// ---------------------------------------------------------------------------
// These replace the client-side derivation the bell used to do. It ran three
// JIT queries every 60 seconds and turned the results into a list, which meant
// no read state, no history, and no memory: an approver could not tell a
// request they had already seen from one that had just arrived, and anything
// that stopped being pending vanished with no trace it was ever raised.
//
// Everything here is scoped to the caller on the server. There is no user
// parameter to pass and there must never be one.

// status: 'unread' for the bell, omitted for everything.
export async function listNotifications(params = {}, signal) {
  const { data } = await http.get('/api/v1/pam/notifications', { params, signal })
  return data.data // { items, total, unread_total, page, page_size, total_pages }
}

// Its own endpoint because the bell asks for the badge far more often than it
// opens the list, and a count is one indexed aggregate rather than a page.
export async function unreadNotificationCount(signal) {
  const { data } = await http.get('/api/v1/pam/notifications/unread-count', { signal })
  return data.data?.unread ?? 0
}

export async function markNotificationRead(id) {
  const { data } = await http.post(`/api/v1/pam/notifications/${id}/read`)
  return data.data
}

export async function markAllNotificationsRead() {
  const { data } = await http.post('/api/v1/pam/notifications/read-all')
  return data.data // { updated }
}
