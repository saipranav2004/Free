import { API_BASE_URL, DEVTOOLS_GUARD } from '../config/constants'
import { useAuthStore } from '../store/authStore'

// ---------------------------------------------------------------------------
// Client-side guard reporting
// ---------------------------------------------------------------------------
// One call, made once, at the moment the DevTools guard trips. It exists so the
// block screen's "This event has been recorded" is a statement of fact rather
// than a bluff: the overlay only prints that line after this resolves true.
//
// Deliberately plain fetch rather than the shared axios client. The guard fires
// while the document is being torn down, and the shared client carries response
// interceptors (401 handling, sign-out, toasts) that have no business running
// against a page that is already dead. keepalive lets the request outlive the
// teardown.
//
// The report is EVIDENCE OF AN ATTEMPT, never proof of a prevention. It comes
// from the operator's own browser, so its absence proves nothing at all: a
// browser with JavaScript disabled sends none of these and sees no block.
//
// Resolves false, and sends nothing, when no endpoint is configured. That is
// the normal state today, and it is what keeps the block screen from claiming
// an audit row nobody wrote. See DEVTOOLS_GUARD.reportPath in config.
export function reportDevToolsDetected(signal) {
  const path = DEVTOOLS_GUARD.reportPath
  if (!path) return Promise.resolve(false)

  const token = useAuthStore.getState().accessToken
  if (!token) return Promise.resolve(false)

  return fetch(`${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      signal: String(signal || 'unknown'),
      path: typeof window !== 'undefined' ? window.location.pathname : '',
    }),
  })
    .then((r) => r.ok)
    .catch(() => false)
}
