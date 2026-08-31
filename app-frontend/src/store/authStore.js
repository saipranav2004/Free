import { create } from 'zustand'
import { recordMfaChallenge, recordMfaNoChallenge } from '../lib/mfaEvidence'

// ---------------------------------------------------------------------------
// Token storage strategy (read this before changing it)
// ---------------------------------------------------------------------------
// The backend has no httpOnly-cookie session, it returns a bearer JWT in the
// JSON login response, full stop (see auth_service.go's LoginResult). That
// leaves two realistic options for a pure SPA:
//
//   1. Keep it ONLY in memory (this zustand store), safest against XSS
//      (nothing durable for an injected script to read), but a hard page
// refresh silently logs the user out, which is a bad experience for a
// console people keep open all day.
//   2. Persist to Web Storage so a refresh survives.
//
// We use option 2, but sessionStorage (not localStorage): it survives a
// refresh/back-forward navigation within the same tab, but is cleared the
// moment the tab/browser closes, meaningfully smaller exposure window than
// localStorage, which persists indefinitely until explicitly cleared. This
// is a real trade-off, not a solved problem: if an attacker achieves script
// injection on this origin, either storage is readable. Defending against
// that is the Content-Security-Policy's job, not this store's.
//
// THE REFRESH TOKEN IS NOW STORED, and it was not before. The note that used
// to sit here said the backend issued a refresh_token with no endpoint to
// redeem it, so wiring half a flow would only produce a 404 loop. That was
// accurate: nothing persisted the token server-side either. POST
// /api/v1/auth/refresh now exists and redeems it, so the console keeps it and
// lib/http.js spends it on the first 401.
//
// It lives beside the access token in sessionStorage, under the same trade-off
// argued above and with the same conclusion: an injected script on this origin
// reads either one, and defending against that is the CSP's job. What the
// refresh token adds to the exposure is bounded deliberately on the server: it
// is single-use, rotated on every redemption, and replaying a spent one kills
// the whole session's chain.
const STORAGE_KEY = 'pam_session'

function readPersisted() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // Defensive: a corrupted/old-shape value should never crash the app on
    // load, treat it as "no session" rather than throwing during init.
    if (!parsed || typeof parsed !== 'object' || !parsed.accessToken) return null
    return parsed
  } catch {
    return null
  }
}

function persist(session) {
  try {
    if (session) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    } else {
      sessionStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // sessionStorage can throw in locked-down/private-browsing contexts ,
    // the app still works, it just won't survive a refresh. Not fatal.
  }
}

const persisted = readPersisted()

export const useAuthStore = create((set, get) => ({
  accessToken: persisted?.accessToken ?? null,
  refreshToken: persisted?.refreshToken ?? null,
  expiresAt: persisted?.expiresAt ?? null,
  user: persisted?.user ?? null,
  // Set true only while the user is in the "enter your MFA code" step ,
  // distinct from "fully logged in", so route guards can tell the two apart.
  mfaChallenge: null, // { challengeToken, identifier } | null
  // True from a deliberate sign-out until the next successful sign-in.
  signedOut: false,

  isAuthenticated: () => {
    const { accessToken, refreshToken, expiresAt } = get()
    if (!accessToken) return false
    // AN EXPIRED ACCESS TOKEN IS NO LONGER THE END OF THE SESSION when a
    // refresh token is held. Without this clause the route guard signs the
    // operator out at the thirty minute mark before any request has been
    // made, so the interceptor's silent refresh would never get the chance to
    // run and the endpoint would be dead code.
    //
    // The session still ends promptly if the renewal fails: the first API call
    // returns 401, lib/http.js tries once, and a failed refresh calls logout()
    // for real.
    if (expiresAt && Date.now() >= new Date(expiresAt).getTime()) {
      return !!refreshToken
    }
    return true
  },

  // `identifier` is what the user typed at sign-in. It is passed here purely
  // so the login OUTCOME can be recorded as MFA evidence, see
  // lib/mfaEvidence.js. A session issued with no challenge is the backend
  // telling us this account has no enrolled device; that is the only reliable
  // "MFA is off" signal this API provides.
  setSession: ({ accessToken, refreshToken, expiresAt, user, identifier, viaMfaChallenge = false }) => {
    const session = { accessToken, refreshToken, expiresAt, user }
    persist(session)
    if (identifier && !viaMfaChallenge) recordMfaNoChallenge(identifier)
    set({ accessToken, refreshToken, expiresAt, user, mfaChallenge: null, signedOut: false })
  },

  // Called by the refresh interceptor. Keeps `user` as it is: a refresh
  // extends the session, it does not re-fetch the profile, and clearing the
  // user here would blank the sidebar for a tick on every renewal.
  applyRefreshedTokens: ({ accessToken, refreshToken, expiresAt }) => {
    const current = readPersisted() || {}
    persist({ ...current, accessToken, refreshToken, expiresAt })
    set({ accessToken, refreshToken, expiresAt })
  },

  // A challenge_token can only be issued for an account that HAS an enrolled
  // MFA device, so reaching this point is proof of enrolment.
  setMfaChallenge: (challenge) => {
    if (challenge?.identifier) recordMfaChallenge(challenge.identifier)
    set({ mfaChallenge: challenge })
  },
  clearMfaChallenge: () => set({ mfaChallenge: null }),

  setUser: (user) => {
    const current = readPersisted()
    if (current) persist({ ...current, user })
    set({ user })
  },

  logout: () => {
    persist(null)
    // MFA evidence is deliberately NOT cleared on logout: it describes the
    // ACCOUNT, not the session, and the next sign-in needs it to render the
    // correct state before /auth/me has even resolved.
    //
    // `signedOut` marks this as a DELIBERATE sign-out, which is what
    // ProtectedRoute reads to decide whether to remember where the user was.
    // Without it, clearing the session re-renders ProtectedRoute, which
    // captures the current location as `state.from`, so signing out of
    // /admin/policies and signing back in dropped you on /admin/policies
    // instead of the dashboard. Deep-link preservation is for INTERRUPTED
    // navigation (expired token, direct URL), never for "I chose to leave".
    set({
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      user: null,
      mfaChallenge: null,
      signedOut: true,
    })
  },

  // Roles come back on both GET /me and the login response's decoded JWT ,
  // this app only ever reads them off `user` (populated by /me, see
  // AppLayout), never decodes the JWT client-side itself. There is no
  // separate "admin login", see ADMIN_CENTER.md, an account's roles are
  // what route it into the Admin Center vs the normal console.
  isAdmin: () => {
    const roles = get().user?.roles
    return Array.isArray(roles) && (roles.includes('admin') || roles.includes('root'))
  },
  isRoot: () => {
    const roles = get().user?.roles
    return Array.isArray(roles) && roles.includes('root')
  },
}))

// Non-hook accessor for use outside React components (the axios interceptor
// needs the current token on every request without being able to call a hook).
export function getAccessToken() {
  return useAuthStore.getState().accessToken
}
