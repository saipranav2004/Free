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
  })
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

export function formatRelativeToNow(iso) {
  if (!iso) return '-'
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) return '-'
  const diffMs = target - Date.now()
  const future = diffMs >= 0
  const label = formatDuration(Math.abs(diffMs) / 1000)
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
