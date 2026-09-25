// ---------------------------------------------------------------------------
// Reading roles off an API payload
// ---------------------------------------------------------------------------
// One place, because two screens read roles from two different endpoints that
// do not agree on the shape:
//
//   GET /admin/identity/users the list, roles may be absent entirely
//   GET /admin/identity/users/:id the detail, access.roles, full Role
// objects ({id,name,description,is_system})
//
// THE BUG THIS EXISTS TO PREVENT (bug sheet #34). The identity list read
// `user.roles` and nothing else, so every row rendered "None" and the Role
// facet matched nobody, while the same account, opened from that list, showed
// its role correctly. Anything that renders or filters by role goes through
// here now, so a payload difference is absorbed once instead of per screen.
//
// Rendering a Role OBJECT as a React child throws ("Objects are not valid as a
// React child"), so everything returned here is a plain string.

// Every key a list row has been seen to carry roles under, most specific
// first. `role` (singular) is last: it is the most likely to hold something
// other than a role list on a payload that also has one of the others.
export const ROLE_KEYS = [
  'roles',
  'role_names',
  'roleNames',
  'assigned_roles',
  'user_roles',
  'effective_roles',
  'role',
]

// Accepts an array of strings, an array of Role objects, a single Role object,
// or a comma-separated string. Anything else yields an empty list rather than
// an exception, this runs on every row of every render.
export function toRoleNames(value) {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map((r) => (typeof r === 'string' ? r : r?.name))
      .filter((n) => typeof n === 'string' && n.trim().length > 0)
      .map((n) => n.trim())
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
  }
  if (typeof value === 'object' && typeof value.name === 'string') {
    return value.name.trim() ? [value.name.trim()] : []
  }
  return []
}

// The roles a USER-shaped payload carries, whichever key they arrived under.
// An empty result genuinely means "this payload said nothing about roles" ,
// the caller decides whether that reads as "none" or as "not known yet".
export function rolesOfUser(user) {
  for (const key of ROLE_KEYS) {
    const names = toRoleNames(user?.[key])
    if (names.length > 0) return names
  }
  return []
}

// The roles on a detail payload's effective-access block.
export function rolesOfAccess(detail) {
  return toRoleNames(detail?.access?.roles)
}
