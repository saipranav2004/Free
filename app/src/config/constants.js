// Central place for every enum/status the backend uses, kept in sync with
// internal/models/*.go. Importing these instead of hardcoding string
// literals in components is what prevents "PENDING" vs "Pending" vs
// "pending" typo bugs from silently breaking a status filter or badge color.
//
// Every *_BADGE map below carries BOTH a light-mode and a dark-mode class
// fragment (`dark:` variants), see src/index.css / themeStore.js for how
// the `dark` class gets toggled on <html>. A badge built from only the old
// dark-console shades (e.g. `text-emerald-300` with no light equivalent)
// reads as barely-visible pale text on a white card in light mode, so this
// is deliberate, not decorative.

// Where the API lives. Vite inlines this at BUILD time, so changing it needs a
// rebuild, not a restart.
//
// The fallback used to be a hard-coded third-party domain. That is a bad
// default for this console specifically: every request carries a Bearer token,
// so a build that forgot the variable would have shipped credentials to a host
// nobody on this project controls, and it would have looked like it was
// working right up until someone read the network tab.
//
// So an unset variable is now loud instead of silent. In development it falls
// back to the local API, which is what a developer means by omitting it. In a
// production build it throws at module load: a console that cannot possibly
// reach its backend should fail where the mistake is visible, not send tokens
// somewhere unintended.
const configuredApiBase = import.meta.env.VITE_API_BASE_URL

if (import.meta.env.PROD && !configuredApiBase) {
  throw new Error(
    'VITE_API_BASE_URL is not set. This is a production build of the PAM console, ' +
      'and it carries a bearer token on every request — it will not guess a backend. ' +
      'Set VITE_API_BASE_URL to your PAM API origin (e.g. https://dashboard-dev.adapid.link) and rebuild.'
  )
}

export const API_BASE_URL = configuredApiBase || 'http://localhost:8080'

// ---------------------------------------------------------------------------
// Developer Tools guard (deterrent, not a security boundary)
// ---------------------------------------------------------------------------
// The switch for src/lib/devtoolsGuard.js. Read that file's header before
// touching any of this: DevTools sits outside the page's security boundary, so
// everything the guard does is friction and attribution. It is not a control
// that prevents anything, and it must never be described as one.
//
// OFF unless VITE_DEVTOOLS_GUARD is explicitly "true". A guard that wipes the
// page on a bad signal is the kind of thing that should be opted into per
// deployment, never something a developer inherits by accident from a default.
// Vite inlines this at BUILD time, so flipping it needs a rebuild.
const devtoolsGuardFlag = String(import.meta.env.VITE_DEVTOOLS_GUARD ?? '')
  .trim()
  .toLowerCase()

export const DEVTOOLS_GUARD = {
  enabled: devtoolsGuardFlag === 'true' || devtoolsGuardFlag === '1',

  // Where a detection is reported, relative to API_BASE_URL. EMPTY BY DEFAULT,
  // because this frontend has no endpoint to report to: nothing in the PAM API
  // currently accepts a client-reported guard event. That is deliberate rather
  // than an oversight to paper over. The block screen prints "This event has
  // been recorded" ONLY when a report actually lands, and falls back to "This
  // session is monitored" otherwise, so the wording can never claim an audit
  // row that does not exist.
  //
  // Point this at a real endpoint (it receives POST {signal, path} with the
  // session's bearer token) and the guard starts recording, with no other
  // change needed here.
  reportPath: String(import.meta.env.VITE_DEVTOOLS_GUARD_REPORT_PATH ?? '').trim(),

  // Detection thresholds, exposed so a deployment that false-positives can be
  // tuned without a code change. Raising dockedDeltaPx makes the guard quieter,
  // lowering it makes it twitchier; confirmTicks is how many consecutive
  // positive checks are required before the page is actually blocked.
  dockedDeltaPx: 160,
  debuggerPauseMs: 100,
  checkIntervalMs: 1000,
  recoveryIntervalMs: 2000,
  confirmTicks: 2,
}

// ---------------------------------------------------------------------------
// Roles (RBAC), the three system roles that ship with every install
// ---------------------------------------------------------------------------
// THE PRIVILEGE MODEL, in one place, because five screens depend on it:
//
// root one per company. Owns the install. Not grantable from this console.
// admin administrative access. Granted ONLY by root, and only through the
// delegation endpoints (POST/DELETE …/users/:id/delegate-admin), so
// every grant carries a reason and can be taken back as a unit.
// user the baseline every account is created with.
//
// Everything else is a CUSTOM role, defined in the Roles screen, and custom
// roles are the only thing the Access tab's assign control offers. A system
// role is decided when the account is created (or by delegation, for admin) ,
// it is never something you pick out of a dropdown afterwards.
//
// `subadmin` used to live here as a separate delegated-admin role. The backend
// dropped it: delegation now grants plain `admin` through the same endpoints,
// so the role list is back to three.
export const SYSTEM_ROLES = ['root', 'admin', 'user']

// The role the delegation endpoints hand out. Named rather than inlined so a
// future rename is one edit, not a grep.
export const DELEGATED_ADMIN_ROLE = 'admin'

export function isAdminRole(roles) {
  return Array.isArray(roles) && (roles.includes('admin') || roles.includes('root'))
}
export function isRootRole(roles) {
  return Array.isArray(roles) && roles.includes('root')
}

export const ROLE_BADGE = {
  root: 'bg-purple-100 text-purple-700 ring-purple-600/20 dark:bg-purple-500/15 dark:text-purple-300 dark:ring-purple-500/30',
  admin:
    'bg-blue-100 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30',
  user: 'bg-slate-100 text-slate-700 ring-slate-600/20 dark:bg-ink-500/15 dark:text-ink-400 dark:ring-ink-500/30',
}

// A custom role has no reserved colour, it gets the neutral chip, the same
// one the Roles table uses for its "Custom" marker. Centralised here because
// four screens render role chips and three of them used to inline this
// fallback string (and one of them forgot to, so a custom role rendered as
// an unstyled chip).
export const ROLE_BADGE_FALLBACK = 'bg-surface-800 text-ink-300 ring-surface-700'

export function roleBadgeClass(name) {
  return ROLE_BADGE[String(name || '').toLowerCase()] || ROLE_BADGE_FALLBACK
}

// ---------------------------------------------------------------------------
// Role identity helpers
// ---------------------------------------------------------------------------
// THE BUG THESE EXIST TO PREVENT. Several screens treated SYSTEM_ROLES as if
// it were "the roles that exist", when it is only "the roles that ship with
// every install". Anything that offers a role for ASSIGNMENT must read the
// live catalogue (GET /admin/rbac/roles via api/rbac.js listRoles), otherwise
// a custom role can be created, listed and edited but never actually given to
// anybody. SYSTEM_ROLES stays for what it genuinely answers: is this one of
// the built-ins that must not be deleted or re-created.

// Roles that carry administrative privilege, what the "Privileged" marker on
// the identity screens means.
export const PRIVILEGED_ROLES = ['root', 'admin']

export function isSystemRoleName(name) {
  return SYSTEM_ROLES.includes(String(name || '').toLowerCase())
}

export function isPrivilegedRoleName(name) {
  return PRIVILEGED_ROLES.includes(String(name || '').toLowerCase())
}

export function isAdminRoleName(name) {
  return String(name || '').toLowerCase() === DELEGATED_ADMIN_ROLE
}

export function isRootRoleName(name) {
  return String(name || '').toLowerCase() === 'root'
}

// ---------------------------------------------------------------------------
// Who may assign what (client-side gate)
// ---------------------------------------------------------------------------
// ONE RULE, so the Access tab and Create user cannot drift apart:
//
//   * The Access tab offers CUSTOM ROLES ONLY. No system role is pickable
// there, `user` is set at creation, `admin` comes from delegation by
// root, and `root` is not something a console hands out. A dropdown that
// lists options the model forbids is just a 403 waiting to happen.
//   * Create user offers `user` (the default baseline) plus custom roles.
//     Never `admin`, never `root`.
//
// Neither depends on who is looking: a non-root admin and root see the same
// custom-role list, because custom roles carry no administrative privilege.
// Administrative access has exactly one door, and it is the delegation panel.
export function isAssignableRoleName(name) {
  return !isSystemRoleName(name)
}

export function canCreateWithRoleName(name) {
  const key = String(name || '').toLowerCase()
  return key === 'user' || !isSystemRoleName(key)
}

// Why a system role has no Remove button, said in the row itself so a missing
// control never reads as a broken one.
export function systemRoleLockReason(name) {
  if (isRootRoleName(name)) return 'Root owns the install and cannot be changed from the console.'
  if (isAdminRoleName(name))
    return 'Administrative access is granted and revoked by root, in Administrative access above.'
  return 'Set when the account was created.'
}

// Accepts either a Role object from the RBAC API (which carries `is_system`)
// or a bare name string (which does not, so the built-in list decides).
export function isSystemRole(role) {
  if (role && typeof role === 'object') return role.is_system === true || isSystemRoleName(role.name)
  return isSystemRoleName(role)
}

// What each built-in role means, in one line. Custom roles carry their own
// description from the API; these three do not always, because they are
// seeded by the backend.
export const SYSTEM_ROLE_NOTES = {
  root: 'Owns the install, full control, including other administrators',
  admin: 'Runs the Admin Center, granted by root through admin delegation',
  user: 'Self-service access only, the baseline every account starts with',
}

// One line describing a role, wherever it is shown. `role` may be the full
// object or undefined (when all we hold is the name off an access record).
export function roleBlurb(role, name) {
  const description = role && typeof role === 'object' ? role.description : null
  if (description && description.trim()) return description.trim()
  return (
    SYSTEM_ROLE_NOTES[String(name ?? (role && role.name) ?? role ?? '').toLowerCase()] ||
    'Custom role, grants exactly the policies attached to it'
  )
}

// Normalises whatever the API hands back (Role objects, or bare name strings
// on some access payloads) into a de-duplicated list of Role-shaped objects,
// ordered the way an administrator reads them: the built-ins first, in their
// privilege order, then custom roles alphabetically.
export function normalizeRoleList(roles) {
  const byName = new Map()
  for (const entry of Array.isArray(roles) ? roles : []) {
    const name = typeof entry === 'string' ? entry : entry?.name
    if (!name) continue
    const key = String(name).toLowerCase()
    if (byName.has(key)) continue
    byName.set(key, typeof entry === 'string' ? { name } : entry)
  }
  return [...byName.values()].sort((a, b) => {
    const ai = SYSTEM_ROLES.indexOf(String(a.name).toLowerCase())
    const bi = SYSTEM_ROLES.indexOf(String(b.name).toLowerCase())
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    }
    return String(a.name).localeCompare(String(b.name))
  })
}

// ---------------------------------------------------------------------------
// Admin delegation
// ---------------------------------------------------------------------------
// GET /admin/identity/users/:id/delegation reports one of four states. They
// are lowercase on the wire; everything here keys off the lowercased value so
// a backend that ever shouts "ACTIVE" still lands on the right chip.
export const DELEGATION_STATUS = {
  NONE: 'none',
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
}

export const DELEGATION_STATUS_LABELS = {
  none: 'Not delegated',
  active: 'Delegated admin',
  expired: 'Delegation expired',
  revoked: 'Delegation revoked',
}

export const DELEGATION_STATUS_BADGE = {
  none: 'bg-slate-100 text-slate-600 ring-slate-600/20 dark:bg-ink-500/15 dark:text-ink-400 dark:ring-ink-500/30',
  active:
    'bg-teal-100 text-teal-700 ring-teal-600/20 dark:bg-teal-500/15 dark:text-teal-300 dark:ring-teal-500/30',
  expired:
    'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  revoked:
    'bg-slate-100 text-slate-600 ring-slate-600/20 dark:bg-ink-500/15 dark:text-ink-400 dark:ring-ink-500/30',
}

export function delegationStatusLabel(status) {
  const key = String(status || DELEGATION_STATUS.NONE).toLowerCase()
  return DELEGATION_STATUS_LABELS[key] || key
}

export function delegationStatusBadgeClass(status) {
  const key = String(status || DELEGATION_STATUS.NONE).toLowerCase()
  return DELEGATION_STATUS_BADGE[key] || DELEGATION_STATUS_BADGE.none
}

// ---------------------------------------------------------------------------
// Identity Management (users)
// ---------------------------------------------------------------------------
export const USER_STATUS_BADGE = {
  ACTIVE:
    'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
  DISABLED:
    'bg-slate-100 text-slate-600 ring-slate-600/20 dark:bg-ink-500/15 dark:text-ink-400 dark:ring-ink-500/30',
  LOCKED:
    'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  DELETED:
    'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
}

// ---------------------------------------------------------------------------
// PBAC (policies)
// ---------------------------------------------------------------------------
export const POLICY_EFFECTS = [
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
]

export const POLICY_EFFECT_BADGE = {
  allow:
    'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
  deny: 'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
}

// Common action vocabulary (pam:<module>:<Verb>) shown as suggestions when
// building a policy, not exhaustive/enforced client-side, the server is
// the source of truth for what's a valid action string.
export const COMMON_ACTIONS = [
  'pam:resource:List',
  'pam:resource:Read',
  'pam:resource:Connect',
  'pam:session:Start',
  'pam:session:End',
  'pam:vault:List',
  'pam:vault:Read',
  'pam:vault:Create',
  'pam:vault:Store',
  'pam:vault:Reveal',
  'pam:vault:Rotate',
  'pam:jit:Request',
  'pam:jit:Cancel',
  'pam:breakglass:Use',
  'pam:audit:Read',
  'pam:report:Generate',
  '*',
]

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const RESOURCE_TYPES = [
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'mongodb', label: 'MongoDB' },
  { value: 'redis', label: 'Redis' },
  { value: 'clickhouse', label: 'ClickHouse' },
  { value: 'minio', label: 'MinIO' },
  { value: 'qdrant', label: 'Qdrant' },
  { value: 'metabase', label: 'Metabase' },
  { value: 'langfuse', label: 'Langfuse' },
  { value: 'web', label: 'Web Application' },
  { value: 'oracle', label: 'Oracle' },
]

export const CONNECT_MODES = [
  { value: 'web_terminal', label: 'Web terminal (host/port shown, connect with your own client)' },
  { value: 'embed_redirect', label: 'Embed / redirect to console URL' },
]

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export const CREDENTIAL_TYPES = [
  { value: 'password', label: 'Password' },
  { value: 'ssh_key', label: 'SSH Private Key' },
  { value: 'x509_cert', label: 'X.509 Certificate' },
  { value: 'api_key', label: 'API Key / Bearer Token' },
  { value: 'token', label: 'OAuth / OIDC Token' },
  { value: 'connection_string', label: 'Connection String' },
  { value: 'kerberos_keytab', label: 'Kerberos Keytab' },
]

// ---------------------------------------------------------------------------
// JIT
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JIT request lifecycle, now four-eyes (dual control)
// ---------------------------------------------------------------------------
// PARTIALLY_APPROVED is the state that makes dual control visible. A STANDARD
// request approved by ONE admin does not produce a grant: it lands here and
// waits for a SECOND, DIFFERENT admin (or for root, whose single approval is
// final). Anything that treated "not PENDING" as "decided" is wrong now ,
// a partially-approved request is still open, still cancellable by its owner,
// and still expires on the request TTL if the second approver never comes.
//
// WAITING is unrelated to any of this: it is the break-glass cooling-off
// period, which has no approvers at all. Keep the two apart.
export const JIT_STATUS = {
  PENDING: 'PENDING',
  PARTIALLY_APPROVED: 'PARTIALLY_APPROVED',
  WAITING: 'WAITING',
  APPROVED: 'APPROVED',
  DENIED: 'DENIED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
}

export const JIT_STATUS_LABELS = {
  PENDING: 'Pending approval',
  PARTIALLY_APPROVED: 'Awaiting second approver',
  WAITING: 'Cooling-off period',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
}

export const JIT_STATUS_BADGE = {
  PENDING:
    'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  // Deliberately NOT green. One approval is progress, not a decision, and a
  // green pill on a request that has granted nothing is the single most
  // misleading thing this screen could show.
  PARTIALLY_APPROVED:
    'bg-blue-100 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30',
  WAITING:
    'bg-orange-100 text-orange-700 ring-orange-600/20 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-500/30',
  APPROVED:
    'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
  DENIED: 'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
  CANCELLED:
    'bg-slate-100 text-slate-600 ring-slate-600/20 dark:bg-ink-500/15 dark:text-ink-400 dark:ring-ink-500/30',
  EXPIRED:
    'bg-slate-100 text-slate-600 ring-slate-600/20 dark:bg-ink-500/15 dark:text-ink-400 dark:ring-ink-500/30',
}

// Requests an approver can still act on. PARTIALLY_APPROVED belongs here:
// it is half-decided, not decided.
export const JIT_OPEN_STATUSES = [JIT_STATUS.PENDING, JIT_STATUS.PARTIALLY_APPROVED, JIT_STATUS.WAITING]

// Nothing will ever change these again, so no polling, no action buttons.
export const JIT_TERMINAL_STATUSES = [
  JIT_STATUS.APPROVED,
  JIT_STATUS.DENIED,
  JIT_STATUS.CANCELLED,
  JIT_STATUS.EXPIRED,
]

export function isOpenJitStatus(status) {
  return JIT_OPEN_STATUSES.includes(status)
}

export function isTerminalJitStatus(status) {
  return JIT_TERMINAL_STATUSES.includes(status)
}

// Approver seniority, as the API reports it on each approval row
// (`approver_rank`). Root's 100 is why a single approval can be final ,
// without showing it, a one-approval APPROVED request looks like a bug.
export const APPROVER_RANK = {
  ROOT: 100,
  ADMIN: 80,
}

export function approverRankLabel(rank) {
  const n = Number(rank)
  if (n >= APPROVER_RANK.ROOT) return 'root'
  if (n >= APPROVER_RANK.ADMIN) return 'admin'
  return 'approver'
}

export const JIT_TYPE = {
  STANDARD: 'STANDARD',
  BREAKGLASS: 'BREAKGLASS',
}

export const GRANT_STATUS = {
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
}

export const GRANT_STATUS_BADGE = {
  ACTIVE:
    'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
  EXPIRED:
    'bg-slate-100 text-slate-600 ring-slate-600/20 dark:bg-ink-500/15 dark:text-ink-400 dark:ring-ink-500/30',
  REVOKED:
    'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
}

// Server-configured defaults (internal/config/config.go's viper defaults).
// These are HINTS ONLY for the UI (placeholders, helper text), the server
// is always the source of truth and its own validation error is what's
// shown when a submission actually violates the real configured policy,
// which may differ per deployment.
export const JIT_DEFAULTS = {
  DEFAULT_DURATION_MIN: 60,
  MAX_DURATION_MIN: 480,
  MIN_REASON_LENGTH: 10,
  BREAKGLASS_WAIT_MIN: 15,
  BREAKGLASS_MAX_DURATION_MIN: 60,
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_STATUS_BADGE = {
  ACTIVE:
    'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
  COMPLETED:
    'bg-slate-100 text-slate-600 ring-slate-600/20 dark:bg-ink-500/15 dark:text-ink-400 dark:ring-ink-500/30',
  KILLED: 'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
  FAILED: 'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const AUDIT_CATEGORIES = [
  'AUTH',
  'AUTHZ',
  'VAULT',
  'SESSION',
  'RESOURCE',
  'BREAK_GLASS',
  'JIT',
  'ADMIN',
  'REPORT',
  'OTHER',
]

export const AUDIT_OUTCOMES = ['SUCCESS', 'DENIED', 'ERROR', 'PENDING', 'FAILURE']

export const AUDIT_OUTCOME_BADGE = {
  SUCCESS:
    'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
  DENIED: 'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
  ERROR: 'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
  PENDING:
    'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  FAILURE:
    'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
}

export const AUDIT_SEVERITY_BADGE = {
  INFO: 'bg-blue-100 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30',
  WARN: 'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  CRITICAL:
    'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
}

export const AUDIT_SORT_OPTIONS = [
  { value: 'occurred_at_desc', label: 'Newest first' },
  { value: 'occurred_at_asc', label: 'Oldest first' },
  { value: 'sequence_desc', label: 'Sequence (desc)' },
]

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export const RECORDING_STATUS_BADGE = {
  PENDING:
    'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  RECORDING:
    'bg-blue-100 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30',
  COMPLETED:
    'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
  FAILED: 'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20
export const SESSIONS_POLL_MS = 15000 // no push channel on the backend yet
export const SEARCH_DEBOUNCE_MS = 350
