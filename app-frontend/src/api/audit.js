import { http, extractFilename, triggerBlobDownload } from '../lib/http'

export async function searchAudit(filters, signal) {
  const params = {}
  for (const [k, v] of Object.entries(filters || {})) {
    if (v !== undefined && v !== null && v !== '') params[k] = v
  }
  const { data } = await http.get('/api/v1/pam/audit', { params, signal })
  return data.data // SearchResult { total, limit, offset, items }
}

export async function auditByRequest(requestId, signal) {
  const { data } = await http.get(`/api/v1/pam/audit/request/${requestId}`, { signal })
  return data.data // array
}

export async function auditByUser(userId, limit, signal) {
  const { data } = await http.get(`/api/v1/pam/audit/user/${userId}`, {
    params: limit ? { limit } : undefined,
    signal,
  })
  return data.data // array
}

export async function auditByResource(resourcePath, limit, signal) {
  // resourcePath can itself contain slashes (route is /audit/resource/*resource)
  const { data } = await http.get(`/api/v1/pam/audit/resource/${resourcePath}`, {
    params: limit ? { limit } : undefined,
    signal,
  })
  return data.data // array
}

// There is deliberately no self-service GET /api/v1/pam/audit/verify route
// on the backend (confirmed against cmd/pam-api/main.go, chain
// verification is only ever registered under /api/v1/pam/admin/audit/verify,
// gated by RequireAdmin). An earlier version of this file called the
// self-service path anyway, which 404'd on every click. Chain verification
// is inherently an org-wide operation (it walks the whole hash chain, not
// a per-account slice of it), so there is no self-service equivalent to
// fall back to, AuditPage only renders that card for admin/root accounts
// and reuses api/admin.js's verifyAudit() for the real call. Keeping this
// comment here (rather than just deleting silently) so nobody re-adds a
// call to the nonexistent self-service route.

// Returns a raw PDF/CSV binary, not JSON, download it directly rather than
// trying to parse it as a normal API response.
//
// audit_handler.go's Generate() requires `from`/`to` as RFC3339 strings and
// 400s ("from must be RFC3339") if either is missing, an earlier version
// of this function forwarded only the category/action/outcome filters and
// never sent a date range at all, so every report generation attempt
// failed with a 400 despite the same backend endpoint working fine when
// called directly (e.g. via Postman) with a date range included. Callers
// must now pass `fromTime`/`toTime` as RFC3339 strings (see
// lib/format.js's dateInputToRFC3339).
export async function generateComplianceReport({ fromTime, toTime, ...filters }) {
  const response = await http.post(
    '/api/v1/pam/audit/report',
    { ...filters, from: fromTime, to: toTime },
    { responseType: 'blob' }
  )
  const ext = filters.format === 'csv' ? 'csv' : 'pdf'
  const filename = extractFilename(response.headers['content-disposition'], `pam-audit-report.${ext}`)
  triggerBlobDownload(response.data, filename)
  return { filename }
}

// Your own activity as counts, computed in the database. The self-service twin
// of admin.js's auditStats, and the reason "All events" is not capped on the
// personal dashboard either. Scope is taken from the token server-side; there
// is no user parameter to pass.
export async function myAuditStats(params = {}, signal) {
  const tz =
    params.tz ||
    (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '') ||
    'UTC'
  const { data } = await http.get('/api/v1/pam/audit/stats', { params: { ...params, tz }, signal })
  return data.data // { total, outcomes, buckets, heat, actors }
}
