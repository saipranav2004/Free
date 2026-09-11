import axios from 'axios'
import { API_BASE_URL } from '../config/constants'
import { useAuthStore, getAccessToken } from '../store/authStore'

// ONE client for the whole app. The backend's Admin Center
// (/api/v1/pam/admin/*) used to be a separate service-token-authenticated
// surface; it is now reached with the exact same PAM-issued JWT as every
// other route (see middleware/admin.go, RequireAdmin reads the "roles"
// claim already embedded in the token by PAMAuth, no separate credential
// exists anymore). That is why there is only one axios instance here where
// an earlier version of this frontend had two (`http` + `adminHttp`).
export const http = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
})

// Endpoints where a 401 means "bad credentials/expired code", NOT "your
// previously-valid session died", these must never trigger the global
// logout-and-redirect below, or a wrong password would boot the user to a
// confusing "session expired" toast instead of a normal "wrong password"
// field error.
const AUTH_ENTRY_POINTS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/mfa/verify',
  // MFA ENROLMENT belongs on this list too. Typing a wrong code while turning
  // MFA on is a rejected CODE, not a dead session, but the backend answers it
  // with a 401, which the handler below read as "your token expired" and
  // signed the user out mid-enrolment. That is the reported "enable MFA, enter
  // a wrong pin, dashboard says session expired" bug: nothing was actually
  // wrong with the session, the wrong code just needed to be re-typed.
  '/api/v1/auth/mfa/setup/verify',
  '/api/v1/auth/mfa/setup/initiate',
  // A 401 from the refresh endpoint means the refresh token itself is dead.
  // Trying to recover from that by refreshing again is the loop this list
  // exists to prevent.
  '/api/v1/auth/refresh',
])

http.interceptors.request.use((config) => {
  const token = getAccessToken()
  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// ---------------------------------------------------------------------------
// Silent refresh
// ---------------------------------------------------------------------------
// The access token lives thirty minutes. Until POST /api/v1/auth/refresh
// existed there was nothing to do at the end of it but sign the operator out,
// so a console people keep open all day threw them back to the sign-in page
// every half hour, mid-task, losing whatever was on screen.
//
// SINGLE FLIGHT. A dashboard with six widgets in flight produces six 401s at
// once. Six refreshes would spend six tokens against a single-use, rotating
// credential, and the server treats a spent token coming back as theft and
// kills the whole session. So the first 401 starts one refresh and every other
// waits on that same promise.
//
// ONE ATTEMPT PER REQUEST. `__isRetry` marks a replay, so a request that 401s
// again after a successful refresh is a genuine authorization failure and ends
// as one instead of refreshing forever.
let refreshInFlight = null

async function refreshSession() {
  const refreshToken = useAuthStore.getState().refreshToken
  if (!refreshToken) return null

  // A bare axios call, not `http`: going back through this instance would put
  // the refresh request through the very interceptor that is handling a 401.
  const { data } = await axios.post(
    `${API_BASE_URL}/api/v1/auth/refresh`,
    { refresh_token: refreshToken },
    { timeout: 20000 }
  )
  const next = data?.data
  if (!next?.access_token) return null

  useAuthStore.getState().applyRefreshedTokens({
    accessToken: next.access_token,
    refreshToken: next.refresh_token,
    expiresAt: next.expires_at,
  })
  return next.access_token
}

function refreshOnce() {
  if (!refreshInFlight) {
    refreshInFlight = refreshSession()
      .catch(() => null)
      .finally(() => {
        // Cleared on the next tick rather than immediately, so callers that
        // are still attaching their .then to this promise get the result
        // instead of racing a fresh attempt.
        setTimeout(() => {
          refreshInFlight = null
        }, 0)
      })
  }
  return refreshInFlight
}

// ---------------------------------------------------------------------------
// Global 401 handling
// ---------------------------------------------------------------------------
// Concurrency bug this guards against: a user's token expires while 4
// widgets on a dashboard are all mid-fetch. Without a guard, all 4 would
// independently detect the 401, each call logout()+navigate() and each pop
// its own "session expired" toast, 4 redirects racing each other and a
// wall of duplicate toasts. sessionExpiredHandled below makes it fire once
// per expiry, and resets the next time a fresh login succeeds.
let sessionExpiredHandled = false

export function resetSessionExpiredGuard() {
  sessionExpiredHandled = false
}

// The app root wires this in (see App.jsx) so this module doesn't need to
// import react-router directly (keeps this a plain lib file, easily unit
// testable without a router context).
let onSessionExpired = () => {}
export function registerSessionExpiredHandler(fn) {
  onSessionExpired = fn
}

http.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error?.response?.status
    const config = error?.config
    const url = config?.url || ''
    const isAuthEntryPoint = [...AUTH_ENTRY_POINTS].some((p) => url.includes(p))

    if (status !== 401 || isAuthEntryPoint) {
      return Promise.reject(error)
    }

    // Try to renew before giving up. Only once per request, and only when
    // there is a refresh token to spend.
    if (!config?.__isRetry && useAuthStore.getState().refreshToken) {
      const token = await refreshOnce()
      if (token) {
        config.__isRetry = true
        config.headers = { ...(config.headers || {}), Authorization: `Bearer ${token}` }
        return http(config)
      }
    }

    // The refresh failed, or there was nothing to refresh with. This is a real
    // session end.
    const wasAuthenticated = useAuthStore.getState().isAuthenticated()
    useAuthStore.getState().logout()
    if (wasAuthenticated && !sessionExpiredHandled) {
      sessionExpiredHandled = true
      onSessionExpired()
    }
    return Promise.reject(error)
  }
)

// ---------------------------------------------------------------------------
// Binary download helper (audit compliance reports, PDF/CSV)
// ---------------------------------------------------------------------------
// audit_handler.go's Generate() returns a raw binary body with a
// Content-Disposition header, not the usual { success, data } JSON envelope
//, a fundamentally different response shape from every other endpoint, so
// it needs its own handling rather than going through the normal JSON path.
export function extractFilename(contentDisposition, fallback) {
  if (!contentDisposition) return fallback
  const match = /filename="?([^"]+)"?/.exec(contentDisposition)
  return match?.[1] || fallback
}

export function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // Revoke on a delay, not immediately, some browsers cancel the download
  // if the object URL is revoked synchronously right after click().
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
