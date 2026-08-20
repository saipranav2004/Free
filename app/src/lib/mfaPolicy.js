// ---------------------------------------------------------------------------
// Role-gated MFA enforcement, the console's half
// ---------------------------------------------------------------------------
// WHAT THE FRONTEND CAN AND CANNOT DO HERE, stated once so nobody re-litigates
// it in a later change:
//
//   It CANNOT enforce. The decision belongs to POST /auth/login, which is the
// only place that knows the password was right and has not yet minted a
// token. By the time any of this code runs, a session already exists, and a
// session the console refuses to use is still a session curl will happily
// use. Enforcement lives in internal/services/mfa_policy.go.
//
//   It CAN and MUST do three things the server cannot: tell a user WHY they
// are being asked to enrol, walk them through it, and give an operator a
// screen to decide which roles are gated and see who a rule would lock out
// before switching it on.
//
// Everything below is presentation over the server's decision. `mfa_required`,
// `mfa_policy_mode` and `mfa_enrollment_required` all arrive from /auth/me and
// from the login response, they are never computed here, because a
// client-side re-derivation is exactly how a UI ends up disagreeing with the
// gate it is describing.

export const MFA_MODES = ['off', 'monitor', 'enforce']

export const MFA_MODE_LABELS = {
  off: 'Off',
  monitor: 'Monitor',
  enforce: 'Enforce',
}

export const MFA_MODE_BLURBS = {
  off: 'The rule is recorded but does nothing. Sign-in is unaffected.',
  monitor:
    'Sign-in is allowed and the breach is recorded. Members see a banner asking them to enrol. Use this first, it is how you find out who enforcement would lock out.',
  enforce:
    'A member without a second factor gets a restricted session that can do exactly one thing: enrol. Everything else is refused until they do.',
}

export const MFA_MODE_BADGE = {
  off: 'bg-slate-100 text-slate-600 ring-slate-600/20 dark:bg-ink-500/15 dark:text-ink-400 dark:ring-ink-500/30',
  monitor:
    'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  enforce:
    'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
}

export function mfaModeLabel(mode) {
  const key = String(mode || 'off').toLowerCase()
  return MFA_MODE_LABELS[key] || key
}

export function mfaModeBadgeClass(mode) {
  const key = String(mode || 'off').toLowerCase()
  return MFA_MODE_BADGE[key] || MFA_MODE_BADGE.off
}

// ---------------------------------------------------------------------------
// The signed-in user's own posture, read off /auth/me
// ---------------------------------------------------------------------------
// Deliberately tolerant about field names and about the whole block being
// absent: a deployment running the previous backend reports none of this, and
// the console must degrade to "no policy in play" rather than to a wall.

function boolish(value) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 'true') return true
  return false
}

function firstArray(...values) {
  for (const v of values) if (Array.isArray(v) && v.length > 0) return v
  return []
}

/**
 * @returns {{
 * known: boolean,            // did the server report policy fields at all
 * required: boolean,         // a role this user holds is gated
 * mode: string,              // 'off' | 'monitor' | 'enforce'
 * enrolled: boolean,         // account holds an active second factor
 * blocked: boolean,          // restricted session: enrol or nothing
 * compliant: boolean,
 * requiredByRoles: string[], // which roles produced the requirement
 * deadline: string|null,     // grace window end, RFC3339
 * }}
 */
export function readMfaPolicyPosture(me) {
  if (!me || typeof me !== 'object') {
    return {
      known: false,
      required: false,
      mode: 'off',
      enrolled: false,
      blocked: false,
      compliant: true,
      requiredByRoles: [],
      deadline: null,
    }
  }

  const hasPolicyFields = 'mfa_required' in me || 'mfa_policy_mode' in me || 'mfa_enrollment_required' in me

  const required = boolish(me.mfa_required)
  const blocked = boolish(me.mfa_enrollment_required)
  const enrolled = boolish(me.mfa_enabled ?? me.mfaEnabled)
  const mode = String(me.mfa_policy_mode || (required ? 'monitor' : 'off')).toLowerCase()

  return {
    known: hasPolicyFields,
    required,
    mode,
    enrolled,
    blocked,
    compliant: !required || enrolled,
    requiredByRoles: firstArray(me.mfa_required_by_roles, me.mfaRequiredByRoles),
    deadline: me.mfa_enrollment_deadline || me.mfaEnrollmentDeadline || null,
  }
}

// One sentence explaining the requirement, used by the banner and the
// interrupt screen so they cannot describe the same policy differently.
export function mfaRequirementSentence(posture) {
  const roles = posture?.requiredByRoles || []
  if (roles.length === 0) return 'Your account is required to have a second factor.'
  const list =
    roles.length === 1 ? roles[0] : `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}`
  return `Accounts holding ${list} are required to have a second factor.`
}

// A 403 body from the API carries `code` (see internal/middleware/auth.go).
// Two codes matter to the console, and they mean opposite things:
// mfa_enrollment_required, you have no second factor; go and enrol
// mfa_required           , you have one, this session did not use it
export function isEnrollmentRequiredError(err) {
  return err?.status === 403 && err?.code === 'mfa_enrollment_required'
}

export function isStepUpRequiredError(err) {
  return err?.status === 403 && err?.code === 'mfa_required'
}

// ---------------------------------------------------------------------------
// Phase-in: how a rule is rolled out
// ---------------------------------------------------------------------------
// A rule can bite immediately, after a per-account grace window, or on one
// fixed date for everybody, see internal/services/mfa_policy.go. Operators
// think in both units, so both exist:
//
// grace_hours relative, restarts for each account that joins the role
// enforce_from absolute, one instant for the whole role
//
// With both set the LATER deadline wins, so neither can quietly cancel a
// window the other promised.

export const PHASE_IN = {
  IMMEDIATE: 'immediate',
  GRACE: 'grace',
  DATE: 'date',
}

export const PHASE_IN_LABELS = {
  immediate: 'Immediately',
  grace: 'After a grace period',
  date: 'From a set date',
}

export const PHASE_IN_BLURBS = {
  immediate: 'Bites at the very next sign-in for anyone without a second factor.',
  grace:
    'Each account gets the same window, counted from when it first falls under the rule. Good for a standing rule that keeps catching new joiners.',
  date: 'One cutover instant for everybody, the date you put in the announcement email.',
}

// Which phase-in a stored rule is using. `grace` wins the label when both are
// set, because the per-account window is the one that keeps applying after the
// fixed date has passed.
export function phaseInOf(rule) {
  if (!rule) return PHASE_IN.IMMEDIATE
  if (Number(rule.grace_hours) > 0) return PHASE_IN.GRACE
  if (rule.enforce_from) return PHASE_IN.DATE
  return PHASE_IN.IMMEDIATE
}

// One short phrase for a rule's roll-out, for the rules list.
export function describePhaseIn(rule) {
  if (!rule || rule.mode === 'off') return '-'
  const parts = []
  const hours = Number(rule.grace_hours) || 0
  if (hours > 0) parts.push(hours % 24 === 0 ? `${hours / 24}d grace` : `${hours}h grace`)
  if (rule.enforce_from) {
    const d = new Date(rule.enforce_from)
    if (!Number.isNaN(d.getTime())) {
      parts.push(
        `from ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
      )
    }
  }
  return parts.length > 0 ? parts.join(' · ') : 'Immediate'
}

// `<input type="datetime-local">` speaks local wall-clock with no zone; the API
// wants RFC3339. Both directions live here so the page never does date maths.
export function toLocalInputValue(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromLocalInputValue(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
