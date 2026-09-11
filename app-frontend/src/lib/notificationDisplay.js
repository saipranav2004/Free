// ---------------------------------------------------------------------------
// How a notification looks
// ---------------------------------------------------------------------------
// One module, used by the bell and by the full page, so the two can never
// describe the same item differently. A badge that says CRITICAL in the panel
// and INFO on the page is the kind of inconsistency that makes people stop
// trusting the feature.

import { AlertTriangle, CheckCircle2, Clock, Info, ShieldAlert, ShieldCheck } from 'lucide-react'

// Category drives the icon: what KIND of thing this is.
export const CATEGORY_ICON = {
  APPROVAL: ShieldCheck,
  REQUEST: Clock,
  ACCESS: CheckCircle2,
  SECURITY: ShieldAlert,
  SYSTEM: Info,
}

export const CATEGORY_LABEL = {
  APPROVAL: 'Approvals',
  REQUEST: 'My requests',
  ACCESS: 'Access',
  SECURITY: 'Security',
  SYSTEM: 'System',
}

// Severity drives the one spot of colour. Colour is spent once per row: the
// icon tile. Everything else is surface, hairline and text, because a list
// where every row shouts is a list nobody reads.
export const SEVERITY_TONE = {
  INFO: 'text-blue-600 dark:text-blue-400 bg-blue-500/10',
  WARNING: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
  CRITICAL: 'text-red-600 dark:text-red-400 bg-red-500/10',
}

export function categoryIcon(category) {
  return CATEGORY_ICON[String(category || '').toUpperCase()] || Info
}

export function severityTone(severity) {
  return SEVERITY_TONE[String(severity || '').toUpperCase()] || SEVERITY_TONE.INFO
}

export function categoryLabel(category) {
  const key = String(category || '').toUpperCase()
  return CATEGORY_LABEL[key] || 'System'
}

// Severity is also what an empty-handed reader sorts by, so keep the warning
// glyph available for the page's filter chips.
export const SEVERITY_ICON = { CRITICAL: ShieldAlert, WARNING: AlertTriangle, INFO: Info }

/**
 * "2m ago", "3h ago", "Yesterday", then a date.
 *
 * Takes `now` rather than reading the clock, for the same reason the bell's
 * countdown does: the caller ticks, and a function that reads Date.now() itself
 * would be correct only at the instant it was last rendered.
 */
export function timeAgo(iso, now = Date.now()) {
  const t = new Date(iso || 0).getTime()
  if (!t || Number.isNaN(t)) return ''
  const secs = Math.max(0, Math.round((now - t) / 1000))
  if (secs < 60) return 'Just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * Groups a list into Today / Yesterday / Earlier.
 *
 * Every console that does this well groups by day rather than paging a flat
 * list: "what happened today" is the question people actually arrive with, and
 * a date heading answers it without them reading a single timestamp.
 */
export function groupByDay(items, now = Date.now()) {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const startOfYesterday = startOfToday.getTime() - 86400000

  const groups = { Today: [], Yesterday: [], Earlier: [] }
  for (const item of items || []) {
    const t = new Date(item?.created_at || 0).getTime()
    if (t >= startOfToday.getTime()) groups.Today.push(item)
    else if (t >= startOfYesterday) groups.Yesterday.push(item)
    else groups.Earlier.push(item)
  }
  return Object.entries(groups).filter(([, rows]) => rows.length > 0)
}
