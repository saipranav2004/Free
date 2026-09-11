import { http } from '../lib/http'

// FOUR-EYES NOTE. Nothing on this file's routes changed shape, but the
// `status` these payloads carry now includes PARTIALLY_APPROVED, a request
// with one of its two required approvals and NO grant. It is an OPEN state:
// still pollable, still cancellable by its owner, and it must never be
// rendered as approved. The approvals trail itself is admin-only
// (GET /admin/jit-requests/:id), so nothing here can name the approvers.
//
// Self-service JIT workflow, request/view/cancel your own requests and
// grants. Approve, deny, and revoke are Admin Center only now (see
// api/admin.js), those self-service routes were removed from the backend
// entirely as part of the Admin Center restructuring (JIT approval "should
// be in the admin center only," per the original ask).

// Idempotency-Key: the backend honors this header on request creation
// (jit_handler.go's Create, "replaying the same key returns the original
// request instead of creating a duplicate"). Generating one client-side per
// form instance and reusing it across retries is what makes a double-click
// or a flaky-network double-submit safe: the SECOND POST with the same key
// returns the ORIGINAL request rather than creating two. See
// CreateJitRequestModal for where this key is generated and cleared.
export async function createJitRequest(payload, idempotencyKey) {
  const { data } = await http.post('/api/v1/pam/jit/requests', payload, {
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  })
  return data.data // { request, next }
}

export async function createBreakglassRequest(payload, idempotencyKey) {
  const { data } = await http.post('/api/v1/pam/jit/breakglass', payload, {
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  })
  return data.data // { request, available_at, waiting_period_min, ... }
}

export async function listMyJitRequests({
  page = 1,
  pageSize = 20,
  status,
  type,
  resourceId,
  q,
  signal,
} = {}) {
  const { data } = await http.get('/api/v1/pam/jit/requests', {
    params: {
      page,
      page_size: pageSize,
      status: status || undefined,
      type: type || undefined,
      resource_id: resourceId || undefined,
      q: q || undefined,
    },
    signal,
  })
  return data.data // { requests, pagination }
}

export async function getJitRequest(id, signal) {
  const { data } = await http.get(`/api/v1/pam/jit/requests/${id}`, { signal })
  return data.data.request
}

// Allowed while the request is open, PENDING or PARTIALLY_APPROVED. A 409
// means it reached a terminal state first (someone decided it, or it
// expired), which is a "refresh and look" outcome, not a retry.
export async function cancelJitRequest(id, reason) {
  const { data } = await http.post(`/api/v1/pam/jit/requests/${id}/cancel`, { reason })
  return data.data.request
}

export async function listMyGrants({ page = 1, pageSize = 20, status, resourceId, activeOnly, signal } = {}) {
  const { data } = await http.get('/api/v1/pam/jit/grants', {
    params: {
      page,
      page_size: pageSize,
      status: status || undefined,
      resource_id: resourceId || undefined,
      active: activeOnly ? 'true' : undefined,
    },
    signal,
  })
  return data.data // { grants, pagination }
}
