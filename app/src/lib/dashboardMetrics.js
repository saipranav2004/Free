import { eventTime, eventActor, isFailure } from '../components/audit/auditFields'

// ---------------------------------------------------------------------------
// Dashboard metrics
// ---------------------------------------------------------------------------
// Every number and every series on the dashboard is computed HERE, from audit
// rows the console fetched itself. There is no analytics endpoint on this
// backend, no aggregates, no time-series, no counters, so the honest choice
// is either "no charts" or "charts derived from a stated sample". We take the
// second, and every caller prints the sample size next to the chart.
//
// What this deliberately does NOT do: extrapolate to a total, compare against
// a previous period, or draw a trend line. The sample is the most recent N
// events, not a statistically complete window, and a "+12% vs last week" on
// top of that would be an invented fact.

const HOUR = 3_600_000
const DAY = 24 * HOUR

function hourLabel(d) {
  return `${String(d.getHours()).padStart(2, '0')}:00`
}

function dayLabel(d) {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * Bucket events into a fixed number of equal time slots ending now.
 * Empty buckets are kept (as zero), dropping them would compress gaps and
 * make a quiet night look like continuous activity.
 *
 * Each slot carries BOTH the total and the denied/failed count, because the
 * only question worth asking of an activity curve in a security console is
 * whether the refusals are climbing with it. One series can't answer that.
 */
export function bucketByTime(events, { buckets = 24, span = 'hour' } = {}) {
  const width = span === 'day' ? DAY : HOUR
  const now = Date.now()
  // Align to the top of the current hour/day so bucket edges are readable
  // times rather than "37 minutes ago".
  const end =
    span === 'day'
      ? new Date(new Date(now).setHours(23, 59, 59, 999)).getTime()
      : new Date(new Date(now).setMinutes(59, 59, 999)).getTime()
  const start = end - buckets * width

  const slots = Array.from({ length: buckets }, (_, i) => {
    const at = new Date(start + i * width + width / 2)
    return { key: i, label: span === 'day' ? dayLabel(at) : hourLabel(at), value: 0, denied: 0 }
  })

  for (const e of events || []) {
    const t = new Date(eventTime(e) || 0).getTime()
    if (Number.isNaN(t) || t < start || t > end) continue
    const idx = Math.min(buckets - 1, Math.floor((t - start) / width))
    if (idx >= 0) {
      slots[idx].value += 1
      if (isFailure(e)) slots[idx].denied += 1
    }
  }

  return slots
}

/** Outcome split across the sample. */
export function outcomeBreakdown(events) {
  const rows = events || []
  let success = 0
  let denied = 0
  let other = 0
  for (const e of rows) {
    const o = String(e?.outcome || '').toUpperCase()
    if (o === 'SUCCESS' || o === 'ALLOWED') success += 1
    else if (isFailure(e)) denied += 1
    else other += 1
  }
  return [
    { key: 'success', label: 'Succeeded', value: success, tone: 'emerald' },
    { key: 'denied', label: 'Denied or failed', value: denied, tone: 'red' },
    ...(other > 0 ? [{ key: 'other', label: 'Other', value: other, tone: 'ink' }] : []),
  ]
}

function rank(events, keyFn, limit) {
  const counts = new Map()
  for (const e of events || []) {
    const k = keyFn(e)
    if (!k) continue
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ key: label, label, value }))
}

export function topActions(events, limit = 6) {
  return rank(events, (e) => e?.action, limit)
}

export function topActors(events, limit = 6) {
  return rank(events, (e) => eventActor(e), limit)
}

/** Categories, with a red tone on any category carrying a denial. */
export function categoryBreakdown(events, limit = 6) {
  const failedIn = new Set((events || []).filter(isFailure).map((e) => e?.category))
  return rank(events, (e) => e?.category, limit).map((r) => ({
    ...r,
    tone: failedIn.has(r.label) ? 'red' : 'blue',
  }))
}

/** Counts used by the "needs attention" tiles. */
export function attentionCounts(events) {
  const rows = events || []
  return {
    total: rows.length,
    failed: rows.filter(isFailure).length,
    actors: new Set(rows.map(eventActor).filter(Boolean)).size,
  }
}

/**
 * Grants sorted by how soon they expire, with a human "in 42m" and a tone
 * that escalates inside 30 minutes. Feeds the "expiring soon" list.
 */
export function expiringGrants(grants, { withinMs = 12 * HOUR } = {}) {
  const now = Date.now()
  return (grants || [])
    .map((g) => {
      const t = new Date(g?.expires_at || 0).getTime()
      if (Number.isNaN(t)) return null
      return { grant: g, msLeft: t - now }
    })
    .filter((x) => x && x.msLeft > 0 && x.msLeft <= withinMs)
    .sort((a, b) => a.msLeft - b.msLeft)
    .map(({ grant, msLeft }) => {
      const mins = Math.round(msLeft / 60000)
      return {
        grant,
        msLeft,
        label: mins < 60 ? `${mins}m left` : `${Math.floor(mins / 60)}h ${mins % 60}m left`,
        tone: mins <= 30 ? 'red' : mins <= 120 ? 'amber' : 'default',
      }
    })
}
