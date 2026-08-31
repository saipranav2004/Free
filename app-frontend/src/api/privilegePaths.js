import { http } from '../lib/http'

// ---------------------------------------------------------------------------
// Privilege-path analysis
// ---------------------------------------------------------------------------
// Eight endpoints that have existed, been tested, and rebuilt their snapshot on
// every boot since the analyzer was written, with no client of any kind. This
// file is the first one.
//
// Read internal/api/handlers/privpath_handler.go for what each returns. The one
// thing worth repeating here: every read is served from an in-memory SNAPSHOT,
// never from a live query, so an entitlement change is invisible until a
// rebuild runs. That is why every response carries built_at and age_seconds,
// and why the page shows them rather than filing them away.

export async function privPathSummary(signal) {
  const { data } = await http.get('/api/v1/pam/admin/privilege-paths', { signal })
  return data.data // { summary, built_at, age_seconds }
}

export async function privPathTargets(signal) {
  const { data } = await http.get('/api/v1/pam/admin/privilege-paths/targets', { signal })
  return data.data?.targets || []
}

export async function privPathsTo({ target, limit = 50 } = {}, signal) {
  const { data } = await http.get('/api/v1/pam/admin/privilege-paths/to', {
    params: { target: target || undefined, limit },
    signal,
  })
  return data.data // { target, count, paths, built_at, age_seconds }
}

export async function privPathsForUser(userId, signal) {
  const { data } = await http.get(`/api/v1/pam/admin/privilege-paths/user/${userId}`, { signal })
  return data.data // { user_id, count, standing_paths, paths }
}

export async function privPathChokepoints({ limit = 20 } = {}, signal) {
  const { data } = await http.get('/api/v1/pam/admin/privilege-paths/chokepoints', {
    params: { limit },
    signal,
  })
  return data.data // { chokepoints, built_at, age_seconds }
}

// Counterfactual only. The handler clones the snapshot in memory and writes
// nothing, which is why the page can offer it as a one-click action with no
// confirmation: there is nothing to undo.
export async function privPathSimulate({ from, to, kind }) {
  const { data } = await http.post('/api/v1/pam/admin/privilege-paths/simulate', { from, to, kind })
  return data.data // { removed, before, after, users_remediated }
}

// A rebuild that lands while one is already running is COALESCED, and the
// backend says so with 202 and performed=false rather than a bare success. The
// distinction matters: a green "rebuilt" over pre-change data is exactly the
// failure this endpoint exists to prevent, so the caller gets the flag.
export async function privPathRebuild() {
  const res = await http.post('/api/v1/pam/admin/privilege-paths/rebuild')
  return {
    performed: res.data?.performed ?? res.data?.data?.performed ?? res.status !== 202,
    coalesced: res.status === 202,
  }
}

export async function privPathStatus(signal) {
  const { data } = await http.get('/api/v1/pam/admin/privilege-paths/status', { signal })
  return data.data // { has_snapshot, building, built_at, age_seconds }
}
