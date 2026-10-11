// ---------------------------------------------------------------------------
// What this console notifies you about, and what you can turn down
// ---------------------------------------------------------------------------
// TWO PROBLEMS THIS FIXES.
//
// First, Settings > Notifications listed five switches that did not correspond
// to anything the server emits. "Weekly access digest" was the clearest case:
// nothing has ever produced one, so the row was a promise the product could not
// keep. Meanwhile real notifications (break-glass raised, a grant revoked, a
// session terminated, a request that timed out) appeared in the bell and were
// described nowhere.
//
// Second, the switches wrote to localStorage and nothing read them back. A
// control that saves a value nobody consults is worse than no control: it
// teaches people that the setting does not work.
//
// So this module is the single list of what the backend actually delivers, and
// the mute state is read by the bell. Every entry below corresponds to a real
// Deliver() call in jit_handler.go, jit_service.go's sweeper, or
// admin_handler.go's KillSession, and the dedupe keys are named so the two
// halves can be checked against each other.

import { CATEGORY_LABEL } from './notificationDisplay'

export const NOTIFICATION_TYPES = [
  {
    category: 'APPROVAL',
    audience: 'admin',
    items: [
      { title: 'Access request awaiting your approval', when: 'Somebody raises a just-in-time request.', severity: 'WARNING' },
      { title: 'Access request needs a second approver', when: 'A request has one of its two approvals and is waiting on a different person.', severity: 'WARNING' },
      { title: 'Access request withdrawn', when: 'The requester cancels before anyone decides.', severity: 'INFO' },
    ],
  },
  {
    category: 'REQUEST',
    audience: 'all',
    items: [
      { title: 'Access request submitted', when: 'Your request is filed and waiting on an approver.', severity: 'INFO' },
      { title: 'One approval recorded on your access request', when: 'Half of a four-eyes approval is in.', severity: 'INFO' },
      { title: 'Access request denied', when: 'An approver refuses your request.', severity: 'WARNING' },
      { title: 'Access request expired', when: 'Nobody decided your request before it timed out.', severity: 'WARNING' },
      { title: 'Break-glass request raised', when: 'You raise emergency access; it activates after the waiting period.', severity: 'WARNING' },
    ],
  },
  {
    category: 'ACCESS',
    audience: 'all',
    items: [
      { title: 'Access approved', when: 'Your grant is issued and the clock starts.', severity: 'INFO' },
      { title: 'Access expired', when: 'A time-boxed grant of yours reaches its end.', severity: 'INFO' },
      { title: 'Access revoked', when: 'An administrator ends your grant early.', severity: 'WARNING' },
      { title: 'Break-glass access is now active', when: 'The emergency waiting period elapsed with no intervention.', severity: 'CRITICAL' },
    ],
  },
  {
    category: 'SECURITY',
    audience: 'all',
    items: [
      // Per-item audience, because this category is mixed: one row only ever
      // reaches approvers and the other only ever reaches the person who was
      // in the session. Listing an admin-only row on a standard user's page
      // promises them something they will never receive.
      { title: 'Break-glass access raised', audience: 'admin', when: 'Somebody raises emergency access. Every approver is told so it can still be stopped.', severity: 'CRITICAL' },
      { title: 'Your session was terminated', when: 'An administrator ends a session you have open.', severity: 'WARNING' },
    ],
  },
]

/**
 * The catalogue as this account will actually experience it.
 *
 * Drops admin-only groups and admin-only rows for a standard user, and drops
 * any group left with nothing in it.
 */
export function notificationTypesFor(isAdmin) {
  if (isAdmin) return NOTIFICATION_TYPES
  return NOTIFICATION_TYPES.filter((g) => g.audience !== 'admin')
    .map((g) => ({ ...g, items: g.items.filter((i) => i.audience !== 'admin') }))
    .filter((g) => g.items.length > 0)
}

const STORAGE_KEY = 'pam_notification_mutes'

// CRITICAL IS NEVER MUTED, and the Security category cannot be turned off at
// all. A console that lets somebody hide "break-glass access is now active"
// from their own bell is offering a setting whose best case is that nobody
// uses it. Everything else is a preference.
export const ALWAYS_ON_CATEGORIES = ['SECURITY']

export function mutableCategories() {
  return NOTIFICATION_TYPES.map((g) => g.category).filter((c) => !ALWAYS_ON_CATEGORIES.includes(c))
}

export function readMutes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((c) => mutableCategories().includes(c))
  } catch {
    // A private window, cleared site data, or storage the browser refuses to
    // hand over. Nothing muted is the right answer to all three.
    return []
  }
}

export function writeMutes(categories) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(categories.filter((c) => mutableCategories().includes(c))))
    return true
  } catch {
    return false
  }
}

/**
 * Should this item show in the bell's preview?
 *
 * The PAGE always shows everything: it is the archive, and an archive with a
 * hole in it is not one. Muting only quiets the panel, which is the surface
 * that interrupts.
 */
export function passesMutes(item, mutes) {
  const severity = String(item?.severity || '').toUpperCase()
  if (severity === 'CRITICAL') return true
  const category = String(item?.category || '').toUpperCase()
  if (ALWAYS_ON_CATEGORIES.includes(category)) return true
  return !mutes.includes(category)
}

export function categoryTitle(category) {
  return CATEGORY_LABEL[category] || category
}
