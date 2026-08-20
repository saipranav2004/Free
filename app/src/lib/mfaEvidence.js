// ---------------------------------------------------------------------------
// MFA enrolment evidence
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS, read before changing anything here.
//
// This bug has now been reported twice, in OPPOSITE directions:
//   • "MFA is enabled but the UI says Enable MFA"
//   • "MFA is NOT enabled but the UI says MFA verified and enabled"
//
// Both symptoms have one cause: **this backend's GET /auth/me does not
// report MFA enrolment.** There is no `mfa_enabled` field and no device
// list in the payload, only `mfa_verified`, which describes the SESSION,
// not the account. Every attempt to answer "is MFA on?" from /auth/me alone
// is therefore a guess, and a guess is wrong in one direction or the other:
//
// guess from mfa_verified -> false "you're protected"  (bug #2)
// refuse to guess -> enrolled users see "Enable MFA" (bug #1)
//
// So stop guessing and use a signal the backend actually gives us.
//
// THE SIGNAL: the login response shape. auth_service.go's LoginResult returns
// `access_token` for an account without MFA, and `challenge_token` for an
// account WITH an enrolled MFA device, the server cannot issue a challenge
// for an account that has no device to challenge. A challenge at sign-in is
// therefore *proof of enrolment*, produced by the backend, not inferred.
//
// The other hard signal is local and equally certain: completing enrolment
// in this console (POST /auth/mfa/setup/verify succeeded) means MFA is on.
//
// Evidence is recorded per username so one browser shared by two accounts
// can't leak one's posture onto the other, and persisted in localStorage ,
// it must outlive the tab (sessionStorage) because the whole point is to
// still know the answer on a later visit. Nothing secret is stored: the
// value is a username and a boolean "this account has MFA", which is not
// sensitive and is not a credential.
//
// If a future backend adds a real enrolment field to /auth/me, readMfaStatus
// prefers it automatically and this becomes a fallback. That is the intended
// end state, see mfaStatus.js.

const STORAGE_KEY = 'pam_mfa_evidence'

// ---------------------------------------------------------------------------
// LIVE UPDATES: why this file has a subscription in it
// ---------------------------------------------------------------------------
// Reported bug: enabling MFA works, disabling MFA works, but the Settings page
// keeps showing the old card until you reload the whole console.
//
// The cause was NOT a missing invalidate. MfaEnrollment and SettingsPage both
// already invalidated ['me'] on success. The cause is that the MFA answer is
// computed from TWO inputs and only one of them was reactive:
//
// readMfaStatus(me)  = fields on the /auth/me payload  + this evidence map
//
// Invalidating ['me'] refetches /auth/me, and this deployment's /auth/me does
// not report MFA enrolment at all, so the payload comes back byte-identical.
// React Query's structural sharing then deliberately hands back the PREVIOUS
// data object (same reference, so consumers don't re-render for an unchanged
// payload). No new reference, no re-render, so nothing re-read localStorage
// and the UI kept the pre-change answer until a full page load recomputed it.
//
// So the evidence map publishes changes itself. Every write bumps a version
// counter and notifies subscribers; hooks/useMfaStatus.js subscribes through
// useSyncExternalStore and recomputes the status the moment enrolment or
// removal is recorded, in the same tick, with no refetch involved. The
// 'storage' listener extends the same behaviour across tabs.

let version = 0
const listeners = new Set()

function emit() {
  version += 1
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      // A broken subscriber must not stop the others from being told.
    }
  })
}

/** Subscribe to evidence changes. Returns an unsubscribe function. */
export function subscribeMfaEvidence(onChange) {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

/** Monotonic version of the evidence map, for useSyncExternalStore. */
export function getMfaEvidenceVersion() {
  return version
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) emit()
  })
}

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Locked-down/private profile, the console still works, it just falls
    // back to "status unavailable" instead of a confident answer.
  }
  // Emitted even when persistence failed: the in-memory answer for THIS tab
  // still changed, and the UI must reflect what just happened.
  emit()
}

function keyFor(identifier) {
  return String(identifier || '')
    .trim()
    .toLowerCase()
}

/**
 * Record that the backend issued an MFA challenge for this identifier at
 * sign-in. Proof of enrolment.
 * @param {string} identifier username or email as typed at the login screen
 */
export function recordMfaChallenge(identifier) {
  const k = keyFor(identifier)
  if (!k) return
  const all = readAll()
  all[k] = { enrolled: true, at: new Date().toISOString(), source: 'login-challenge' }
  writeAll(all)
}

/**
 * Record that the backend issued a full session with NO challenge. Proof the
 * account had no enrolled device at that moment.
 */
export function recordMfaNoChallenge(identifier) {
  const k = keyFor(identifier)
  if (!k) return
  const all = readAll()
  // Never downgrade an in-console enrolment recorded after this login: if the
  // user enrolled during this very session, that is newer and more correct.
  // 'setup-restarted' is NOT protected the same way, it already means "not
  // enrolled", and a later no-challenge login simply confirms it.
  const existing = all[k]
  if (existing?.source === 'enrolled-here') return
  all[k] = { enrolled: false, at: new Date().toISOString(), source: 'login-no-challenge' }
  writeAll(all)
}

/** Record a completed enrolment performed in this console. */
export function recordMfaEnrolled(identifier) {
  const k = keyFor(identifier)
  if (!k) return
  const all = readAll()
  all[k] = { enrolled: true, at: new Date().toISOString(), source: 'enrolled-here' }
  writeAll(all)
}

/**
 * Record that POST /auth/mfa/setup/initiate succeeded, which, on this
 * backend, means the account NO LONGER HAS AN ACTIVE SECOND FACTOR.
 *
 * That is not a guess. auth_service.go's SetupMFAInitiate runs:
 *
 *     // Delete any existing PENDING device, then create a new one.
 * s.db.Unscoped().Where("user_id = ?", userID).Delete(&models.PAMMFA{})
 *
 * The comment says PENDING; the query has NO status filter, so it hard-
 * deletes whatever device the user had, ACTIVE included, and replaces it
 * with a fresh PENDING row. Login only challenges when `mfa.Status ==
 * "ACTIVE"`, so from the instant initiate returns, the account is unprotected
 * until a code is confirmed.
 *
 * This is the single most consequential fact about MFA on this deployment and
 * it was invisible in the UI: someone clicking "replace authenticator" and
 * then closing the dialog silently lost their second factor, while the
 * console kept showing "MFA enabled" from the previous login's evidence.
 * Recording it here is what keeps the console's answer true.
 */
export function recordMfaSetupRestarted(identifier) {
  const k = keyFor(identifier)
  if (!k) return
  const all = readAll()
  all[k] = { enrolled: false, at: new Date().toISOString(), source: 'setup-restarted' }
  writeAll(all)
}

/**
 * @returns {{enrolled: boolean, at: string|null, source: string}|null}
 * null when this browser has never observed a sign-in for this account.
 */
export function readMfaEvidence(identifier) {
  const k = keyFor(identifier)
  if (!k) return null
  const rec = readAll()[k]
  if (!rec || typeof rec.enrolled !== 'boolean') return null
  return { enrolled: rec.enrolled, at: rec.at || null, source: rec.source || 'unknown' }
}

// The login screen only knows what was TYPED (which may be an email while
// /auth/me returns a username, or vice versa). Checking both keys means the
// evidence is found regardless of which form was used to sign in.
export function readMfaEvidenceForUser(user) {
  if (!user) return null
  return readMfaEvidence(user.username) || readMfaEvidence(user.email)
}

export function clearMfaEvidence(identifier) {
  const k = keyFor(identifier)
  if (!k) return
  const all = readAll()
  delete all[k]
  writeAll(all)
}
