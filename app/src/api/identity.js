import { http } from '../lib/http'

// Identity Management, the Admin Center's user lifecycle screens
// (/api/v1/pam/admin/identity/*). Admin/root only. Brand new surface: PAM
// now owns user accounts end to end (no external IAM service), so this is
// full user CRUD + lifecycle + RBAC role assignment + PBAC direct policy
// attachment, see identity_handler.go.

export async function listUsers(q, signal) {
  const { data } = await http.get('/api/v1/pam/admin/identity/users', {
    params: q ? { q } : undefined,
    signal,
  })
  return data.data // { users, count }
}

export async function getUser(id, signal) {
  const { data } = await http.get(`/api/v1/pam/admin/identity/users/${id}`, { signal })
  return data.data // { user, access: { roles, policies } }
}

export async function createUser(payload) {
  const { data } = await http.post('/api/v1/pam/admin/identity/users', payload)
  return data.data.user
}

export async function updateUser(id, payload) {
  const { data } = await http.patch(`/api/v1/pam/admin/identity/users/${id}`, payload)
  return data.data.user
}

export async function setUserStatus(id, status) {
  const { data } = await http.post(`/api/v1/pam/admin/identity/users/${id}/status`, { status })
  return data.data
}

export async function deleteUser(id) {
  const { data } = await http.delete(`/api/v1/pam/admin/identity/users/${id}`)
  return data.data
}

export async function resetUserPassword(id, newPassword) {
  const { data } = await http.post(`/api/v1/pam/admin/identity/users/${id}/reset-password`, {
    new_password: newPassword,
  })
  return data.data
}

export async function assignRole(userId, roleName) {
  const { data } = await http.post(`/api/v1/pam/admin/identity/users/${userId}/roles`, {
    role_name: roleName,
  })
  return data.data
}

export async function removeRole(userId, roleName) {
  const { data } = await http.delete(
    `/api/v1/pam/admin/identity/users/${userId}/roles/${encodeURIComponent(roleName)}`
  )
  return data.data
}

// ---------------------------------------------------------------------------
// Admin delegation, /users/:id/delegate-admin, /users/:id/delegation
// ---------------------------------------------------------------------------
// Administrative access is NOT handed out with assignRole() any more. It is
// delegated: root grants the `admin` role with a recorded reason, an optional
// expiry and an optional resource scope, and can take it back. Only a root
// caller succeeds on grant/revoke, everyone else gets 403, which is why
// every caller of these three is gated on authStore.isRoot() as well.
//
// The read (delegation status) is open to admin and root alike, so an ordinary
// admin can still SEE that an account holds delegated admin without being able
// to change it.

// Grant. `payload` is { reason (required), expires_at?, scope_resource_ids?,
// replace_admin? }. Returns { delegated_role, replaced_admin, ... }.
export async function delegateAdmin(userId, payload) {
  const { data } = await http.post(`/api/v1/pam/admin/identity/users/${userId}/delegate-admin`, payload)
  return data.data ?? null
}

// Revoke. The reason travels in the BODY of a DELETE, which axios only sends
// when it is passed as `config.data`, `http.delete(url, payload)` would send
// the payload as the request config and drop the reason silently.
export async function revokeAdminDelegation(userId, payload) {
  const { data } = await http.delete(`/api/v1/pam/admin/identity/users/${userId}/delegate-admin`, {
    data: payload,
  })
  return data.data ?? null
}

export async function getDelegationStatus(userId, signal) {
  const { data } = await http.get(`/api/v1/pam/admin/identity/users/${userId}/delegation`, { signal })
  return normalizeDelegation(data?.data)
}

// ---------------------------------------------------------------------------
// Delegation payload normalisation
// ---------------------------------------------------------------------------
// The delegation payload is read by three different bits of UI, so it is
// flattened to one shape HERE rather than each of them guessing.
//
// WHY THIS IS ALIAS-DRIVEN RATHER THAN A FIXED FIELD LIST. The first version
// read `granted_by` / `granted_at` literally, and against the real backend both
// rendered as "-" while reason, scope and status came through: the actor and
// timestamp are recorded under different names (`delegated_by`, `delegated_at`,
// `created_at`, and the *_username / *_user_id variants of each). Rather than
// bet on one spelling, each logical field lists every name it is plausibly
// sent under, most specific first, a display name beats an email beats a raw
// UUID, and the first one actually present wins.
//
// It also absorbs three other real shape differences: the object arrives either
// bare (`data: { status, … }`) or wrapped (`data: { delegation: { … } }`); an
// account that was never delegated can come back as `data: null` rather than
// `{ status: "none" }`; and an actor can be a string OR an object. React Query
// treats an `undefined` queryFn return as an error, so this never returns
// undefined.

// Candidate key names per logical field, in priority order.
const GRANTED_BY_KEYS = [
  'granted_by_username',
  'granted_by_name',
  'granted_by_full_name',
  'granted_by_email',
  'delegated_by_username',
  'delegated_by_name',
  'delegated_by_email',
  'created_by_username',
  'created_by_name',
  'assigned_by_username',
  'granter_username',
  'granter',
  'actor_username',
  'actor',
  // The bare/id forms come last: a UUID on screen is better than nothing, but
  // only once every human-readable spelling has been ruled out.
  'granted_by',
  'delegated_by',
  'created_by',
  'assigned_by',
  'granted_by_user',
  'delegated_by_user',
  'granted_by_user_id',
  'delegated_by_user_id',
  'created_by_user_id',
]

const GRANTED_AT_KEYS = [
  'granted_at',
  'delegated_at',
  'delegation_granted_at',
  'granted_on',
  'issued_at',
  'assigned_at',
  'started_at',
  'starts_at',
  'effective_from',
  'created_at',
]

const REVOKED_BY_KEYS = [
  'revoked_by_username',
  'revoked_by_name',
  'revoked_by_full_name',
  'revoked_by_email',
  'revoker_username',
  'revoker',
  'revoked_by',
  'revoked_by_user',
  'revoked_by_user_id',
]

const REVOKED_AT_KEYS = ['revoked_at', 'revocation_at', 'revoked_on', 'ended_at']

const EXPIRES_AT_KEYS = ['expires_at', 'expiry_at', 'expires_on', 'expiration', 'valid_until', 'ends_at']

const REASON_KEYS = ['reason', 'grant_reason', 'delegation_reason', 'justification', 'note']

const REVOKE_REASON_KEYS = ['revoke_reason', 'revocation_reason', 'revoked_reason']

const SCOPE_KEYS = ['scope_resource_ids', 'scope_resources', 'resource_ids', 'scoped_resource_ids']

// An actor may be a plain string or a nested user object, either way the UI
// needs one printable line, never an object (React throws on those).
function toDisplayName(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number') return String(value)
  if (typeof value === 'object') {
    return (
      toDisplayName(value.username) ||
      toDisplayName(value.full_name) ||
      toDisplayName(value.name) ||
      toDisplayName(value.email) ||
      toDisplayName(value.user_id) ||
      toDisplayName(value.id)
    )
  }
  return null
}

// Timestamps are normalised to something `new Date()` reads correctly. A Unix
// epoch in SECONDS is the trap here: passed through untouched it renders as
// January 1970 rather than failing visibly.
function toTimestamp(value) {
  if (value === undefined || value === null || value === '') return null
  let candidate = value
  if (typeof candidate === 'string' && /^\d+$/.test(candidate)) candidate = Number(candidate)
  if (typeof candidate === 'number') {
    if (!Number.isFinite(candidate) || candidate <= 0) return null
    const ms = candidate < 1e12 ? candidate * 1000 : candidate
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof candidate !== 'string') return null
  return Number.isNaN(new Date(candidate).getTime()) ? null : candidate
}

// The objects a field may live on: the payload itself, its `delegation`
// wrapper, and any nested object whose KEY looks delegation-related. That last
// rule is deliberately narrow, scanning every nested object would happily read
// `user.created_at` and label the account's creation date "Granted at".
function delegationScopes(raw) {
  const scopes = [raw]
  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue
    if (!/deleg|grant|subadmin|admin_access/i.test(key)) continue
    scopes.push(value)
    // One more level, same rule, covers `{ delegation: { grant: {…} } }`.
    for (const [innerKey, innerValue] of Object.entries(value)) {
      if (isPlainObject(innerValue) && /deleg|grant|subadmin|admin_access/i.test(innerKey)) {
        scopes.push(innerValue)
      }
    }
  }
  return scopes
}

function pickField(scopes, keys, transform = (v) => v) {
  for (const key of keys) {
    for (const scope of scopes) {
      const value = scope[key]
      if (value === undefined || value === null || value === '') continue
      const out = transform(value)
      if (out !== undefined && out !== null && out !== '') return out
    }
  }
  return null
}

export function normalizeDelegation(payload) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const scopes = delegationScopes(raw)
  const first = (...values) => values.find((v) => v !== undefined && v !== null) ?? null

  const status = String(pickField(scopes, ['status', 'delegation_status', 'state']) ?? 'none').toLowerCase()
  const scope = pickField(scopes, SCOPE_KEYS, (v) => (Array.isArray(v) ? v : null))

  return {
    status,
    isActive: status === 'active',
    reason: pickField(scopes, REASON_KEYS, (v) => (typeof v === 'string' ? v : null)),
    // Whatever the backend says it granted, falling back to the role the
    // delegation endpoints hand out today. (It used to mint `subadmin`; that
    // role was dropped and delegation now grants plain `admin`. Reading the
    // reported value first means a future rename needs no frontend change.)
    delegated_role: first(
      pickField(scopes, ['delegated_role', 'role_name', 'role'], (v) =>
        typeof v === 'string' ? v : (v?.name ?? null)
      ),
      'admin'
    ),
    granted_at: pickField(scopes, GRANTED_AT_KEYS, toTimestamp),
    granted_by: pickField(scopes, GRANTED_BY_KEYS, toDisplayName),
    expires_at: pickField(scopes, EXPIRES_AT_KEYS, toTimestamp),
    revoked_at: pickField(scopes, REVOKED_AT_KEYS, toTimestamp),
    revoked_by: pickField(scopes, REVOKED_BY_KEYS, toDisplayName),
    revoke_reason: pickField(scopes, REVOKE_REASON_KEYS, (v) => (typeof v === 'string' ? v : null)),
    scope_resource_ids: Array.isArray(scope) ? scope : [],
    // Kept so a field this normaliser does not know about is still reachable
    // rather than silently dropped.
    raw,
  }
}

// Administrative MFA reset, the recovery path when a user loses their
// authenticator. Removes every MFA device on the account; the user is
// password-only until they enrol again (and is forced to, at the next
// sign-in, if a policy rule gates one of their roles).
//
// Root-only when the target holds admin or root, enforced server-side ,
// resetting a privileged account's second factor is the same privilege level
// as granting that account admin in the first place.
export async function resetUserMfa(userId, reason) {
  const { data } = await http.post(`/api/v1/pam/admin/identity/users/${userId}/reset-mfa`, {
    reason,
  })
  return data.data
}

export async function attachPolicy(userId, policyId) {
  const { data } = await http.post(`/api/v1/pam/admin/identity/users/${userId}/policies`, {
    policy_id: policyId,
  })
  return data.data
}

export async function detachPolicy(userId, policyId) {
  const { data } = await http.delete(`/api/v1/pam/admin/identity/users/${userId}/policies/${policyId}`)
  return data.data
}
