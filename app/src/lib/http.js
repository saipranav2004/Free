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
])

http.interceptors.request.use((config) => {
  const token = getAccessToken()
  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

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
  (error) => {
    const status = error?.response?.status
    const url = error?.config?.url || ''
    const isAuthEntryPoint = [...AUTH_ENTRY_POINTS].some((p) => url.includes(p))

    if (status === 401 && !isAuthEntryPoint) {
      const wasAuthenticated = useAuthStore.getState().isAuthenticated()
      useAuthStore.getState().logout()
      if (wasAuthenticated && !sessionExpiredHandled) {
        sessionExpiredHandled = true
        onSessionExpired()
      }
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
