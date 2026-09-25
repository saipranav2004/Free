import { AUDIT_CATEGORIES, AUDIT_OUTCOMES } from '../../config/constants'

// ---------------------------------------------------------------------------
// Audit field access + range helpers
// ---------------------------------------------------------------------------
// Both audit screens (self-service /pam/audit and org-wide
// /pam/admin/audit) render rows from two different handlers whose exact
// field names for "when / who / what" are not pinned down anywhere we have
// access to. Rather than let each page invent its own guesses, which is how
// the two screens drifted apart in the first place, every reader lives here
// and both pages import them.

export function eventTime(e) {
  return e?.occurred_at || e?.created_at || e?.timestamp || null
}

export function eventActor(e) {
  return (
    e?.actor_username ||
    e?.username ||
    e?.actor?.username ||
    e?.user_email ||
    e?.actor_id ||
    e?.user_id ||
    null
  )
}

export function eventTarget(e) {
  return e?.resource_name || e?.resource || e?.target || e?.resource_id || null
}

export function eventIp(e) {
  return e?.source_ip || e?.ip_address || e?.client_ip || null
}

export function eventId(e) {
  return e?.id || e?.event_id || e?.entry_id || null
}

export function isFailure(e) {
  const o = String(e?.outcome || '').toUpperCase()
  return o === 'DENIED' || o === 'ERROR' || o === 'FAILURE' || o.includes('FAIL')
}

// isCritical() used to live here and is gone along with every severity
// surface in the console. On this backend severity is INFO on the
// overwhelming majority of rows, and non-INFO tracks the DENIED/ERROR rows
// that `isFailure` already identifies, so it was a second, weaker verdict
// competing with the real one. The audit record still carries the field; the
// console simply stopped presenting it as if it were an independent signal.

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------
// Presets cover the windows an investigator actually asks for; "custom" hands
// over two date inputs. `toParams` produces RFC3339 strings, the same format
// audit_handler.go's report endpoint demands, so one representation serves
// both the list filter and the report builder.

export const RANGE_PRESETS = [
  { key: '1h', label: 'Last hour', hours: 1 },
  { key: '24h', label: 'Last 24 hours', hours: 24 },
  { key: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { key: '30d', label: 'Last 30 days', hours: 24 * 30 },
  { key: '90d', label: 'Last 90 days', hours: 24 * 90 },
  { key: 'all', label: 'All time', hours: null },
  { key: 'custom', label: 'Custom range…', hours: null },
]

export function rangeLabel(key) {
  return RANGE_PRESETS.find((p) => p.key === key)?.label || 'All time'
}

// Returns { fromISO, toISO } or nulls. `customFrom`/`customTo` are plain
// <input type="date"> values interpreted in the viewer's own timezone, which
// is what the picker showed them, never UTC midnight, which would shift the
// window by the viewer's offset.
export function resolveRange(key, customFrom, customTo) {
  if (key === 'custom') {
    const from = customFrom ? new Date(`${customFrom}T00:00:00`) : null
    const to = customTo ? new Date(`${customTo}T23:59:59.999`) : null
    return {
      fromISO: from && !Number.isNaN(from.getTime()) ? from.toISOString() : null,
      toISO: to && !Number.isNaN(to.getTime()) ? to.toISOString() : null,
    }
  }
  const preset = RANGE_PRESETS.find((p) => p.key === key)
  if (!preset?.hours) return { fromISO: null, toISO: null }
  return {
    fromISO: new Date(Date.now() - preset.hours * 3_600_000).toISOString(),
    toISO: null, // open-ended: "last 24 hours" means up to and including now
  }
}

// THE HONEST BIT ABOUT DATE FILTERING: `from`/`to` are sent to the server as
// query params, because a date filter that only trims the page you already
// fetched is a lie about how many results exist. But this backend's audit
// search is not documented to accept them, and an endpoint that ignores an
// unknown param would silently return unfiltered rows, a date filter that
// visibly does nothing. So the same predicate is ALSO applied to the rows
// that come back. If the server honours the params this is a no-op; if it
// doesn't, the operator still only sees events inside the window they asked
// for, and the page says so rather than pretending the count is exact.
export function withinRange(event, fromISO, toISO) {
  if (!fromISO && !toISO) return true
  const t = new Date(eventTime(event) || 0).getTime()
  if (Number.isNaN(t)) return true // never hide a row just because its stamp is unreadable
  if (fromISO && t < new Date(fromISO).getTime()) return false
  if (toISO && t > new Date(toISO).getTime()) return false
  return true
}

// The one client-side pass, used by BOTH audit screens so they can't apply
// different rules to the same data. Returns the surviving rows.
export function refineRows(rows, filters, fromISO, toISO) {
  if (!Array.isArray(rows)) return []
  const actor = filters.actor?.trim().toLowerCase()
  const action = filters.action?.trim().toLowerCase()

  return rows.filter((e) => {
    if (!withinRange(e, fromISO, toISO)) return false
    if (action && String(e?.action || '').toLowerCase() !== action) return false
    if (actor) {
      const hay = [eventActor(e), e?.user_id, e?.actor_id, e?.email]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase())
      if (!hay.some((v) => v.includes(actor))) return false
    }
    return true
  })
}

export const CATEGORIES = AUDIT_CATEGORIES
export const OUTCOMES = AUDIT_OUTCOMES

export const AUDIT_CSV_COLUMNS = [
  { key: 'occurred_at', label: 'Time', value: eventTime },
  { key: 'category', label: 'Category' },
  { key: 'action', label: 'Action' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'actor', label: 'Actor', value: eventActor },
  { key: 'target', label: 'Target', value: eventTarget },
  { key: 'source_ip', label: 'Source IP', value: eventIp },
  { key: 'sequence_number', label: 'Sequence' },
  { key: 'id', label: 'Event ID', value: eventId },
]
