import { http } from '../lib/http'

// Admin Center reads + attributable actions (/api/v1/pam/admin/*), gated
// server-side by middleware.RequireAdmin (the caller's own JWT "roles"
// claim must include "admin" or "root"). This used to go through a separate
// `adminHttp` client authenticated with a shared X-IAM-Service-Token; that
// entire model is gone. Every call below uses the SAME `http` client and
// the SAME Bearer token as every other authenticated request in the app ,
// there is no separate identity to attach, because the acting admin IS the
// logged-in user (see middleware/admin.go's AdminIdentityFromContext).

export async function listJitRequests(params, signal) {
  const { data } = await http.get('/api/v1/pam/admin/jit-requests', { params, signal })
  return data.data // { requests, pagination }
}

// The ONLY endpoint that returns the four-eyes decision trail. Neither the
// org-wide list nor the requester's own GET /jit/requests/:id carries
// `approvals`, so anything that needs to know WHO has already approved (the
// duplicate-approver guard, the trail, "you approved") has to come through
// here, one request at a time.
export async function getJitRequest(id, signal) {
  const { data } = await http.get(`/api/v1/pam/admin/jit-requests/${id}`, { signal })
  return data.data // { request, grant?, audit_trail?, approvals? }
}

export async function listGrants(params, signal) {
  const { data } = await http.get('/api/v1/pam/admin/grants', { params, signal })
  return data.data // { grants, pagination }
}

export async function listSessions(params, signal) {
  const { data } = await http.get('/api/v1/pam/admin/sessions', { params, signal })
  return data.data // { sessions, pagination }
}

export async function listRecordings(params, signal) {
  const { data } = await http.get('/api/v1/pam/admin/recordings', { params, signal })
  return data.data // { recordings, pagination }
}

export async function listAudit(params, signal) {
  const { data } = await http.get('/api/v1/pam/admin/audit', { params, signal })
  return data.data // { events, pagination }
}

// This is the ONLY chain-verification route the backend exposes, there is
// no self-service equivalent under /api/v1/pam/audit/* (confirmed against
// cmd/pam-api/main.go). AuditPage reuses this same function for its
// admin-gated "Chain integrity" card rather than calling a nonexistent
// self-service path. Always wraps its result in the normal envelope
// (verified against admin_handler.go, response.Success is called
// unconditionally, whether res.Valid is true or false), so no bare-response
// special case is needed here.
export async function verifyAudit(orgId, signal) {
  const { data } = await http.get('/api/v1/pam/admin/audit/verify', {
    params: orgId ? { org_id: orgId } : undefined,
    signal,
  })
  return data.data.verification
}

export async function listBreakglass(params, signal) {
  const { data } = await http.get('/api/v1/pam/admin/breakglass', { params, signal })
  return data.data // { requests, pagination, grants }
}

export async function getBreakglassReport(grantId, signal) {
  const { data } = await http.get(`/api/v1/pam/admin/breakglass/${grantId}/report`, { signal })
  return data.data.report
}

// Dashboard tiles. Since four-eyes, the queue is described by THREE numbers
// rather than one, and they nest:
//
// awaiting_first_approval   PENDING, nobody has approved yet
// awaiting_second_approval  PARTIALLY_APPROVED, one approval in, one to go
// pending_approvals both of the above PLUS break-glass WAITING
//
// So `pending_approvals` is not the sum of the other two, and showing it
// beside them without saying that reads as an arithmetic error.
export async function getStats(signal) {
  const { data } = await http.get('/api/v1/pam/admin/stats', { signal })
  return data.data
}

// ---------------------------------------------------------------------------
// Actions (attributable writes, automatically attributed to the logged-in
// admin/root, no header to forge and no separate identity to propagate)
// ---------------------------------------------------------------------------

// Requires an MFA-verified admin token (backend: RequireMFA on this route).
//
// FOUR-EYES: this call answers in one of TWO shapes and the caller cannot
// know which until it lands ,
//
//   { request, status: 'PARTIALLY_APPROVED', next } first approval, NO grant
//   { request, grant, expires_at } quorum, grant issued
//
// Do not assume the second. Pass the result through
// lib/fourEyes.js#readApproveResult, which is the one place that tells them
// apart, and let it choose the message.
//
// Two refusals are rules rather than faults and both have their own wording
// in lib/fourEyes.js#approvalErrorMessage:
//   403 self-approval, the requester may not decide their own request
//   409 duplicate approver, this admin already approved; the second
// approval has to come from a DIFFERENT admin, or from root
export async function approveJitRequest(id, reason) {
  const { data } = await http.post(`/api/v1/pam/admin/actions/jit-requests/${id}/approve`, { reason })
  return data.data // shape A or shape B, see above
}

// Deny never waits for a second person: one denial is the decision. `reason`
// is REQUIRED here (400 without it), unlike on approve.
export async function denyJitRequest(id, reason) {
  const { data } = await http.post(`/api/v1/pam/admin/actions/jit-requests/${id}/deny`, { reason })
  return data.data
}

// `reason` REQUIRED (400 without it).
export async function revokeGrant(id, reason) {
  const { data } = await http.post(`/api/v1/pam/admin/actions/grants/${id}/revoke`, { reason })
  return data.data // { grant, sessions_killed }
}

// `reason` REQUIRED (400 without it).
export async function killSession(id, reason) {
  const { data } = await http.post(`/api/v1/pam/admin/actions/sessions/${id}/kill`, { reason })
  return data.data
}
