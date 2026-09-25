// Normalizes every possible shape the backend can return an error in, into
// one consistent object components can rely on without each having to know
// the backend's own internal inconsistency.
//
// The backend genuinely returns errors in more than one shape (confirmed by
// reading the actual Go source, not assumed):
//
// - internal/response.Error() -> { success:false, error: { message } }
// - internal/response.ValidationError() -> { success:false, error: { message, fields } }
// - most middleware (auth.go, authz.go) -> { success:false, error: "some string" }
// - middleware/grant.go's RequireActiveGrant -> { success:false, error: "string", code, hint }
// - middleware/authz.go's RequirePermission -> { success:false, error: "Permission denied", reason, action }
// - middleware/admin.go's IAMAdminIdentity -> { success:false, error: "string", code }
//
// A naive `err.response.data.error.message` will throw ("Cannot read
// properties of string") the moment it hits a middleware-shaped error, and a
// naive `err.response.data.error` (assuming string) will render
// "[object Object]" the moment it hits a handler-shaped one. This file is
// the one place that has to know about both.
export function normalizeApiError(error) {
  // Network-level failure: no response at all (offline, DNS failure, CORS
  // preflight rejected, request aborted). error.response is undefined here.
  if (!error?.response) {
    if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') {
      return { message: '', canceled: true, status: null }
    }
    return {
      message: 'Could not reach the PAM backend. Check your connection and try again.',
      status: null,
      code: 'network_error',
    }
  }

  const { status, data } = error.response

  // Some infra failures (a proxy timeout, a 502 from a load balancer) return
  // HTML or plain text, not the JSON envelope. Guard against that instead of
  // assuming `data` is always an object.
  if (!data || typeof data !== 'object') {
    return { message: genericMessageForStatus(status), status, code: 'non_json_response' }
  }

  const rawError = data.error

  if (typeof rawError === 'string') {
    return {
      message: rawError,
      status,
      code: data.code,
      hint: data.hint,
      reason: data.reason,
      action: data.action,
    }
  }

  if (rawError && typeof rawError === 'object') {
    return {
      message: rawError.message || genericMessageForStatus(status),
      fields: rawError.fields,
      status,
      code: data.code,
    }
  }

  // Some routes return raw, un-enveloped bodies on specific paths (e.g.
  // audit_handler.go's VerifyChain returns the bare VerificationResult with
  // HTTP 200 when the chain is broken, that's not an error response at all,
  // it's a successful call reporting bad news in its payload). If we get
  // here, there was no error/message field to read at all.
  return { message: data.message || genericMessageForStatus(status), status }
}

function genericMessageForStatus(status) {
  switch (status) {
    case 400:
      return 'That request was invalid.'
    case 401:
      return 'Your session has expired. Please log in again.'
    case 403:
      return "You don't have permission to do that."
    case 404:
      return 'Not found.'
    case 409:
      return 'That conflicts with the current state, refresh and try again.'
    case 422:
      return 'Some fields need attention.'
    case 423:
      return 'This account is temporarily locked.'
    case 429:
      return 'Too many requests, please slow down and try again shortly.'
    case 500:
    case 502:
    case 503:
    case 504:
      return 'The server hit an unexpected problem. Please try again.'
    default:
      return 'Something went wrong.'
  }
}

// Convenience for react-query's onError / mutation error handlers where you
// just want a string for a toast.
export function apiErrorMessage(error) {
  return normalizeApiError(error).message
}
