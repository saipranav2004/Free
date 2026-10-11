// Every timestamp the backend sends is a Go time.Time serialized as RFC3339
// UTC (e.g. "2026-08-06T14:30:00Z" or with fractional seconds). `new Date()`
// parses that correctly as long as the string carries its own zone (the "Z"
// or a +HH:MM offset), the bug to avoid is ever treating the string as if
// it were already in the viewer's local time (e.g. slicing off the "Z" and
// re-parsing) or building a Date from separate numeric fields, either of
// which silently shifts every displayed time by the viewer's UTC offset.
// Passing the raw string straight to `new Date(iso)` and letting
// Intl.DateTimeFormat render it in the browser's local zone (the default,
// with no explicit `timeZone` option) is the one correct path, that's all
// these helpers do.

// THE ZONE IS PART OF THE TIMESTAMP, and leaving it off was a real gap on an
// audit trail. Two people in two offices reading the same event saw two
// different times with nothing on screen to reconcile them, and an exported CSV
// carried no zone at all. Splunk, CloudTrail and Okta's System Log all either
// label the zone or let you switch to UTC; this does the first, which needs no
// setting and no state.
//
// `timeZoneName: 'short'` renders whatever the viewer's browser is set to
// ("GMT+5:30", "PDT", "UTC"), so it stays correct when they travel and it never
// asserts a zone the app has guessed.
export function formatDateTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

/**
 * The same instant in UTC, for the places where two readers have to agree:
 * an audit row's detail panel, an exported file, a value someone will paste
 * into a ticket. Always suffixed so it cannot be mistaken for local time.
 */
export function formatDateTimeUTC(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return (
    d.toLocaleString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'UTC',
    }) + ' UTC'
  )
}

/** The viewer's zone, named once for a column header or a caption. */
export function localZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'
  } catch {
    return 'local time'
  }
}

export function formatDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// "in 3m 12s" / "3m 12s ago", used for grant expiry countdowns and
// break-glass cooling-off timers. Deliberately NOT memoized/cached across
// renders, the whole point is that it changes every time the caller
// re-renders on a tick (see useCountdown hook).
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

// A RELATIVE AGE ROLLS UP. formatDuration is built for elapsed session time
// and tops out at hours and minutes, which is right for "this session has run
// 2h 14m" and wrong the moment it is pointed at a creation date: a role
// created a year ago rendered as "8760h 54m ago", which is technically true
// and completely unreadable.
//
// Rolling up loses precision on purpose. Nobody reading a list needs the
// minute a role was created; they need "a year ago" and the exact timestamp
// on hover, which every caller already puts on the title attribute.
export function formatRelativeToNow(iso) {
  if (!iso) return '-'
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) return '-'

  const diffMs = target - Date.now()
  const future = diffMs >= 0
  const secs = Math.abs(diffMs) / 1000

  let label
  if (secs < 45) label = 'moments'
  else if (secs < 3600) label = `${Math.round(secs / 60)}m`
  else if (secs < 86400) label = `${Math.round(secs / 3600)}h`
  else if (secs < 7 * 86400) label = `${Math.round(secs / 86400)}d`
  else if (secs < 60 * 86400) label = `${Math.round(secs / (7 * 86400))}w`
  else if (secs < 365 * 86400) label = `${Math.round(secs / (30 * 86400))}mo`
  else {
    const years = secs / (365 * 86400)
    label = `${years < 10 ? years.toFixed(1).replace(/\.0$/, '') : Math.round(years)}y`
  }

  if (label === 'moments') return future ? 'in a moment' : 'moments ago'
  return future ? `in ${label}` : `${label} ago`
}

// Converts a plain `<input type="date">` value ("2026-08-07") into an
// RFC3339 UTC timestamp at either the start or end of that calendar day, in
// the viewer's LOCAL timezone (matching what the date picker actually shows
// them), not UTC midnight, which would silently shift the range by the
// viewer's UTC offset. audit_handler.go's Generate() requires `from`/`to`
// to be RFC3339-parseable and rejects the request with a 400 otherwise, so
// this is the one place responsible for turning a human-picked date range
// into something the backend will accept.
export function dateInputToRFC3339(dateStr, endOfDay = false) {
  if (!dateStr) return null
  const [year, month, day] = dateStr.split('-').map(Number)
  if (!year || !month || !day) return null
  const d = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0)
  return d.toISOString()
}

// Today and "N days ago" as `<input type="date">` values, in the viewer's
// local timezone, used to default the compliance-report range to a
// sensible last-30-days window rather than making the user pick dates just
// to generate a report at all.
export function todayDateInputValue() {
  return toDateInputValue(new Date())
}

export function daysAgoDateInputValue(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return toDateInputValue(d)
}

function toDateInputValue(d) {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '-'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const idx = Math.min(i, units.length - 1)
  return `${(bytes / 1024 ** idx).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`
}
