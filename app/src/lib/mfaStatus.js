import { readMfaEvidenceForUser } from './mfaEvidence'

// ---------------------------------------------------------------------------
// MFA status
// ---------------------------------------------------------------------------
// Answers one question, "does this account have a second factor?", from the
// strongest evidence available, in a fixed order of trust:
//
//   1. An explicit enrolment field on /auth/me, if this deployment has one.
//      (It currently does not. Kept first so the moment a backend adds one,
// it wins with no further changes here.)
//   2. A real MFA device in an /auth/me device list, if present.
//   3. Login-flow evidence recorded by lib/mfaEvidence: the backend issued a
//      `challenge_token` for this account (= a device exists) or issued a
// full session with no challenge (= no device). This is a BACKEND fact
// about the account, observed at sign-in, not a client guess.
//   4. Nothing → `unknown`, and the UI says so instead of guessing.
//
// `mfa_verified` is deliberately NOT in that list. It is a property of the
// SESSION. Treating it as enrolment produced a false "you are protected" for
// accounts with no MFA at all, the worst of the failure modes, because it
// tells a security operator they have a second factor when they don't. It is
// still reported, separately, as session posture.
//
// See lib/mfaEvidence.js for the full history of both bugs.

const ENABLED_KEYS = [
  'mfa_enabled',
  'mfaEnabled',
  'mfa_configured',
  'mfaConfigured',
  'mfa_active',
  'has_mfa',
  'hasMfa',
  'totp_enabled',
  'is_mfa_enabled',
]

const ENABLED_AT_KEYS = ['mfa_enabled_at', 'mfa_enrolled_at', 'mfa_activated_at', 'mfaEnabledAt']

const DEVICE_LIST_KEYS = ['mfa_devices', 'mfaDevices', 'mfa_methods']

function firstBoolean(obj, keys) {
  for (const k of keys) {
    if (typeof obj?.[k] === 'boolean') return obj[k]
    if (obj?.[k] === 1 || obj?.[k] === 'true') return true
    if (obj?.[k] === 0 || obj?.[k] === 'false') return false
  }
  return undefined
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

// A device counts only when it is usable, an abandoned enrolment attempt or
// a revoked device is not a second factor.
function activeDeviceOf(me) {
  for (const k of DEVICE_LIST_KEYS) {
    const list = me?.[k]
    if (!Array.isArray(list) || list.length === 0) continue
    const active = list.find((d) => {
      if (!d || typeof d !== 'object') return false
      if (d.verified === false || d.is_verified === false || d.enabled === false) return false
      if (d.revoked === true || d.deleted_at) return false
      if (typeof d.status === 'string' && !/^(active|verified|enabled)$/i.test(d.status)) return false
      return true
    })
    if (active) return active
  }
  return null
}

const SOURCE_NOTES = {
  api: 'Reported by the account API',
  device: 'A registered authenticator is on this account',
  'login-challenge': 'This account was challenged for a code at sign-in',
  'enrolled-here': 'Enrolled from this console',
  'login-no-challenge': 'Sign-in completed without an MFA challenge',
  'setup-restarted': 'Enrolment was restarted, which removed the previous authenticator',
}

/**
 * @returns {{
 * enabled: boolean,             // account has a second factor
 * unknown: boolean,             // no evidence in either direction
 * verifiedThisSession: boolean, // session posture, never proof of enrolment
 * enabledAt: string|null,
 * method: string,
 * source: string|null,          // which signal decided `enabled`
 * sourceNote: string|null,      // human sentence for that signal
 * loaded: boolean,
 * }}
 */
export function readMfaStatus(me) {
  const empty = {
    enabled: false,
    unknown: true,
    verifiedThisSession: false,
    enabledAt: null,
    method: 'Authenticator app (TOTP)',
    source: null,
    sourceNote: null,
    loaded: false,
  }
  if (!me || typeof me !== 'object') return empty

  const verifiedThisSession = me.mfa_verified === true || me.mfaVerified === true
  const flag = firstBoolean(me, ENABLED_KEYS)
  const device = activeDeviceOf(me)
  const evidence = readMfaEvidenceForUser(me)

  let enabled
  let source = null
  if (flag !== undefined) {
    enabled = flag
    source = 'api'
  } else if (device) {
    enabled = true
    source = 'device'
  } else if (evidence) {
    enabled = evidence.enrolled
    source = evidence.source
  } else {
    enabled = false
    source = null
  }

  const unknown = source === null

  return {
    enabled: unknown ? false : enabled,
    unknown,
    verifiedThisSession,
    enabledAt: enabled
      ? firstString(me, ENABLED_AT_KEYS) ||
        firstString(device, ['verified_at', 'enrolled_at', 'activated_at', 'created_at', 'createdAt']) ||
        (evidence?.enrolled ? evidence.at : null)
      : null,
    method: (enabled && firstString(device, ['device_name', 'name', 'type'])) || 'Authenticator app (TOTP)',
    source,
    sourceNote: source ? SOURCE_NOTES[source] || null : null,
    loaded: true,
  }
}

export function formatEnabledAt(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// One label for every surface that mentions MFA (profile menu, settings
// header chip, security tab) so they can never disagree with each other.
export function mfaSummary(status) {
  if (!status?.loaded) return { tone: 'ink', label: 'Checking MFA…' }
  if (status.unknown) return { tone: 'ink', label: 'MFA status unavailable' }
  if (!status.enabled) return { tone: 'amber', label: 'MFA not enabled' }
  return {
    tone: 'emerald',
    label: status.verifiedThisSession ? 'MFA enabled · verified' : 'MFA enabled',
  }
}
