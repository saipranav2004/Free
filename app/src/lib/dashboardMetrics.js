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

/**
 * Categories, each carrying HOW MANY of its events were denied.
 *
 * This used to return a red tone on any category that contained at least one
 * denial, which is two problems in one: it said "there is a denial in here"
 * without saying whether that was one event out of ninety or ninety out of
 * ninety, and it said even that in colour alone, so it needed a "red = contains
 * a denial" caption beside the chart and was invisible to a colourblind reader.
 * A count turns the bar into a small stacked bar, which answers the question
 * the colour was gesturing at.
 */
export function categoryBreakdown(events, limit = 6) {
  const deniedBy = new Map()
  for (const e of (events || []).filter(isFailure)) {
    const k = e?.category
    deniedBy.set(k, (deniedBy.get(k) || 0) + 1)
  }
  return rank(events, (e) => e?.category, limit).map((r) => ({
    ...r,
    denied: deniedBy.get(r.label) || 0,
  }))
}

/**
 * Events counted into a day-of-week by hour grid.
 *
 * WHY THIS EXISTS. Volume over time answers "how much"; this answers "when",
 * and in a privileged access product when is most of the signal. Privileged
 * work has a shape: a team works weekday daytimes, a batch job runs at 02:00.
 * The cell that lights up at 03:00 on a Sunday is the one worth a question,
 * and no total can surface it, because the total is the same however the
 * events are distributed across the week.
 *
 * Aggregated over the WHOLE sample rather than the selected range, so the
 * shape it describes is stable enough to compare a single hour against.
 * Monday is row 0, because a week that starts on Sunday splits the working
 * week across both ends of the grid.
 */
export function heatmapCells(events) {
  const grid = new Map()
  for (const e of events || []) {
    const t = new Date(eventTime(e) || 0)
    const ms = t.getTime()
    if (!ms || Number.isNaN(ms)) continue
    const day = (t.getDay() + 6) % 7
    const hour = t.getHours()
    const k = `${day}:${hour}`
    grid.set(k, (grid.get(k) || 0) + 1)
  }
  return [...grid.entries()].map(([k, count]) => {
    const [day, hour] = k.split(':').map(Number)
    return { day, hour, count }
  })
}

/**
 * The share of the sample that happened outside weekday working hours.
 *
 * The one number the heatmap is for, stated in words so the card is not
 * asking the reader to count cells. "Outside hours" is Monday to Friday
 * before 07:00 or from 19:00, plus all of Saturday and Sunday: a convention,
 * and one the card names rather than assumes.
 */
export function offHoursShare(events) {
  const rows = events || []
  let off = 0
  let counted = 0
  for (const e of rows) {
    const t = new Date(eventTime(e) || 0)
    if (!t.getTime() || Number.isNaN(t.getTime())) continue
    counted += 1
    const day = (t.getDay() + 6) % 7
    const hour = t.getHours()
    if (day >= 5 || hour < 7 || hour >= 19) off += 1
  }
  return { off, counted, pct: counted ? (off / counted) * 100 : 0 }
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

// ---------------------------------------------------------------------------
// Posture findings
// ---------------------------------------------------------------------------
// THE THING THIS DASHBOARD WAS MISSING, AND WHY THE RANKED LISTS WENT.
//
// The dashboard used to lead its analysis with "most frequent actions", "most
// active accounts" and "by category". Those are aggregations of an audit log,
// not signals: `pam:jit:Request 17` and `p.raghavan 39` are true and there is
// nothing an administrator does differently for knowing them. The most active
// accounts card said so itself, in its own footer, "high volume is not itself
// suspicious".
//
// Look at what the products in this category actually put on a landing page.
// Entra PIM leads with alerts: too many global administrators, roles assigned
// outside PIM, accounts stale. CyberArk leads with accounts that failed
// verification or rotation and accounts out of policy. BeyondTrust leads with
// requests awaiting approval and assets discovered but unmanaged. AWS Security
// Hub leads with findings by severity. Not one of them ranks anything by event
// count, because the shape of the question is not "what happened most" but
// "what is wrong, how bad, and where do I go to fix it".
//
// So: findings. Each one is a condition that is either true or false about the
// estate right now, carries a count, a severity, and a link to the surface
// that can act on it. Every one is computed from data this console already
// holds. Nothing here is a score, a trend, or a prediction.

export const FINDING_SEVERITY = { critical: 0, high: 1, medium: 2, info: 3 }

/**
 * Build the findings list from whatever the dashboard managed to load.
 *
 * Every input is optional and a missing one simply produces no finding rather
 * than a wrong one: a dashboard that cannot reach the identity service should
 * say nothing about MFA, not report zero accounts without it.
 */
export function postureFindings({ users, criticality, stats, grants } = {}) {
  const out = []

  // 1. MFA. Everything else on this list rests on it, so it outranks
  //    everything else on this list.
  if (Array.isArray(users)) {
    const active = users.filter((u) => (u?.status || 'ACTIVE') === 'ACTIVE')
    const without = active.filter((u) => !u?.mfa_enabled)
    if (without.length > 0) {
      out.push({
        key: 'mfa',
        severity: 'critical',
        title: `${without.length} active ${without.length === 1 ? 'account has' : 'accounts have'} no MFA`,
        detail: `${without.map((u) => u.username).slice(0, 3).join(', ')}${without.length > 3 ? ` and ${without.length - 3} more` : ''}. Everything ${without.length === 1 ? 'this account' : 'these accounts'} can reach rests on a password alone.`,
        count: without.length,
        to: '/admin/identity',
        action: 'Review accounts',
      })
    }
  }

  // 2. Break glass in force. A live emergency elevation is the single most
  //    consequential state this product has.
  const bg = stats?.active_breakglass_grants ?? 0
  if (bg > 0) {
    out.push({
      key: 'breakglass',
      severity: 'critical',
      title: `${bg} break-glass ${bg === 1 ? 'grant is' : 'grants are'} active`,
      detail: 'Emergency access granted without a second approver. Every one should end with a written reason.',
      count: bg,
      to: '/admin/jit',
      action: 'Open break-glass',
    })
  }

  // 3. Privileged roles nobody is exercising. The standard candidate for
  //    removal, and the reason the criticality engine separates what a role
  //    COULD do from whether anyone is doing it.
  if (Array.isArray(criticality?.roles)) {
    const idle = criticality.roles.filter(
      (r) => (r?.tier ?? 9) <= 1 && (r?.exposure?.dormant || (r?.exposure?.holders ?? 0) === 0)
    )
    if (idle.length > 0) {
      out.push({
        key: 'idle-privileged',
        severity: 'high',
        title: `${idle.length} privileged ${idle.length === 1 ? 'role is' : 'roles are'} unused`,
        detail: `${idle.map((r) => r.role_name).slice(0, 3).join(', ')}${idle.length > 3 ? ` and ${idle.length - 3} more` : ''} classified Critical or High with no recent activity. Standing privilege nobody exercises is privilege worth removing.`,
        count: idle.length,
        to: '/admin/roles',
        action: 'Review roles',
      })
    }
  }

  // 4. How concentrated Critical access is. Not a defect on its own, which is
  //    why it is informational: it is the number a reviewer is asked for and
  //    currently has to go and count by hand.
  if (criticality?.by_band) {
    const criticalRoles = criticality.by_band.CRITICAL ?? 0
    if (criticalRoles > 0) {
      const holders = (criticality.roles || [])
        .filter((r) => r?.band === 'CRITICAL')
        .reduce((n, r) => n + (r?.exposure?.holders ?? 0), 0)
      out.push({
        key: 'critical-holders',
        severity: 'info',
        title: `${holders} ${holders === 1 ? 'account holds' : 'accounts hold'} a Critical role`,
        detail: `Across ${criticalRoles} ${criticalRoles === 1 ? 'role' : 'roles'} classified Critical. Treat a compromise of any of them as a control plane compromise.`,
        count: holders,
        to: '/admin/roles',
        action: 'Open roles',
      })
    }
  }

  // 5. Grants about to lapse. Work rather than a defect, but it belongs on the
  //    same list because it is the same question: what needs a decision.
  if (Array.isArray(grants)) {
    const soon = grants.filter((g) => {
      if (g?.status !== 'ACTIVE') return false
      const t = new Date(g?.expires_at || 0).getTime()
      return t && !Number.isNaN(t) && t - Date.now() <= HOUR && t > Date.now()
    })
    if (soon.length > 0) {
      out.push({
        key: 'expiring',
        severity: 'medium',
        title: `${soon.length} ${soon.length === 1 ? 'grant expires' : 'grants expire'} within the hour`,
        detail: 'Access ends on its own. Anyone still working will have to raise a new request.',
        count: soon.length,
        to: '/admin/jit',
        action: 'Open grants',
      })
    }
  }

  return out.sort((a, b) => FINDING_SEVERITY[a.severity] - FINDING_SEVERITY[b.severity])
}
