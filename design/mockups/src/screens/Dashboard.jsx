import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowRight, Clock, KeyRound, ShieldAlert } from 'lucide-react'
import { useViewer } from '../state/viewer'
import { adminStats, auditEvents, grants, jitRequests, sessions, approvalsByRequest } from '../fixtures'
import { Button, HeroMetric, Meta, Panel, RuledLabel, Section, StatRail, StatusDot, AlarmBand, BreakglassTag } from '../ui/primitives'
import { ConfirmDialog, useToast } from '../ui/overlay'
import { FreshnessMarker } from '../ui/states'
import { countdown, JIT_LABEL, JIT_TONE, relative } from '../lib/format'

// ===========================================================================
// Dashboard
// ===========================================================================
// WHAT CHANGED (vs. the current DashboardPage)
//
//  • The 5-cell / 4-cell KPI strip is gone. Exactly ONE number is rendered at
//    text-display: the one that represents a decision the viewer has to make.
//    For an admin that is `pending_approvals`; for a normal user it is the
//    grant that expires soonest. Everything else drops to a flat stat rail.
//  • The greeting ("Good to see you, root") is deleted. It occupied the most
//    authoritative position on the page and carried no information.
//  • The approval queue is rendered INLINE under the hero, not in a card
//    beside another card — the number and the work it refers to are one object
//    (Okta's task-first admin home; Teleport's "Needs Review").
//  • Break-glass gets an alarm band that renders ONLY when non-zero. A
//    permanent "0 break-glass" tile trains people to stop reading the row.
//  • No card borders anywhere. Sections are a heading plus 32px of air.
//
// API HONESTY
//  GET /admin/stats returns point-in-time counts and no history, so there is
//  no trend arrow, delta or sparkline on any number here. The one derived
//  visual (denials per hour) is computed from audit rows the API actually
//  returned, and says so, with its sample size.

function hourBuckets(events, hours = 12) {
  const now = Date.now()
  const buckets = Array.from({ length: hours }, () => ({ total: 0, denied: 0 }))
  for (const e of events) {
    const age = now - new Date(e.occurred_at).getTime()
    const idx = hours - 1 - Math.floor(age / 3_600_000)
    if (idx < 0 || idx >= hours) continue
    buckets[idx].total += 1
    if (e.outcome === 'DENIED' || e.outcome === 'ERROR' || e.outcome === 'FAILURE') buckets[idx].denied += 1
  }
  return buckets
}

// A real chart, not a decoration: one bar per hour, denials stacked in the
// semantic danger colour. Height is the only encoding; no gridlines, no axis
// chrome, because the question is "is anything spiking", not "exactly how many".
function ActivityBars({ events, hours = 12 }) {
  const buckets = useMemo(() => hourBuckets(events, hours), [events, hours])
  const max = Math.max(1, ...buckets.map((b) => b.total))
  return (
    <div>
      <div className="flex h-16 items-end gap-1" role="img" aria-label={`Audit events per hour for the last ${hours} hours`}>
        {buckets.map((b, i) => (
          <div key={i} className="flex h-full flex-1 flex-col justify-end gap-px" title={`${b.total} events, ${b.denied} denied`}>
            {b.denied > 0 && (
              <div className="w-full rounded-t-sm bg-danger" style={{ height: `${(b.denied / max) * 100}%` }} />
            )}
            <div
              className={clsx('w-full bg-line-strong', b.denied === 0 && 'rounded-t-sm')}
              style={{ height: `${((b.total - b.denied) / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-micro uppercase text-tertiary">
        <span>{hours}h ago</span>
        <span>now</span>
      </div>
    </div>
  )
}

// ── The approval queue row ────────────────────────────────────────────────
// Approve/deny live in the row (StrongDM's model). The four-eyes state is the
// row's organising fact, not a badge parked at the end: a request that already
// carries one approval needs ONE specific different person, and that is what
// makes it the fastest thing in the queue to clear.
function QueueRow({ request, isRoot, viewerId, onApprove, onDeny }) {
  const trail = approvalsByRequest[request.id] || null
  const approvedCount = trail ? trail.filter((a) => a.decision === 'approved').length : request.status === 'PARTIALLY_APPROVED' ? 1 : 0
  const alreadyApprovedByViewer = !!trail?.some((a) => a.approver_user_id === viewerId)
  const isBreakglass = request.request_type === 'BREAKGLASS'

  // Mirrors lib/fourEyes.js: root settles alone; an admin who already approved
  // is blocked by the server's duplicate-approver guard, so the button says so
  // rather than offering an action that will 409.
  const label = isRoot ? 'Approve (final)' : approvedCount >= 1 ? 'Approve (2 of 2)' : 'Approve'
  const blocked = !isRoot && alreadyApprovedByViewer ? 'You already approved this' : null

  return (
    <div className="flex flex-col gap-3 border-b border-line px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <Link to="/admin/jit" className="truncate text-sm font-semibold text-primary hover:text-accent">
            {request.resource_name}
          </Link>
          {isBreakglass && <BreakglassTag />}
          <Meta mono>{request.action}</Meta>
        </div>
        <p className="mt-1 truncate text-xs text-secondary">
          {request.requester_username} · {request.duration_minutes}m ·{' '}
          {request.ticket_ref ? <span className="font-mono">{request.ticket_ref}</span> : 'no ticket'} ·{' '}
          {relative(request.requested_at)}
        </p>
        <p className="mt-1 truncate text-xs text-tertiary">{request.reason}</p>
      </div>

      <div className="flex flex-none items-center gap-3">
        <StatusDot
          tone={JIT_TONE[request.status]}
          label={
            isBreakglass && request.available_at
              ? `available ${relative(request.available_at)}`
              : JIT_LABEL[request.status]
          }
        />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={!!blocked} title={blocked || undefined} onClick={() => onApprove(request)}>
            {label}
          </Button>
          <Button size="sm" variant="dangerQuiet" onClick={() => onDeny(request)}>
            Deny
          </Button>
        </div>
      </div>
    </div>
  )
}

// ===========================================================================
// Admin / Root
// ===========================================================================
function AdminDashboard({ isRoot, viewerId }) {
  const s = adminStats
  const toast = useToast()
  const [approveTarget, setApproveTarget] = useState(null)
  const [denyTarget, setDenyTarget] = useState(null)
  const approvedCountOf = (r) => (approvalsByRequest[r?.id] || []).filter((a) => a.decision === 'approved').length
  const willIssue = (r) => isRoot || approvedCountOf(r) >= 1
  const queue = useMemo(() => {
    const open = jitRequests.filter((r) => ['PARTIALLY_APPROVED', 'PENDING', 'WAITING'].includes(r.status))
    // Order is the design: one-approval-short first (clears fastest), then new,
    // then break-glass in its waiting period.
    const rank = { PARTIALLY_APPROVED: 0, PENDING: 1, WAITING: 2 }
    return [...open].sort((a, b) => rank[a.status] - rank[b.status] || new Date(a.requested_at) - new Date(b.requested_at)).slice(0, 5)
  }, [])

  const denials = useMemo(
    () => auditEvents.filter((e) => e.outcome === 'DENIED' || e.outcome === 'ERROR').slice(0, 6),
    []
  )

  const topActors = useMemo(() => {
    const counts = new Map()
    for (const e of auditEvents) counts.set(e.username, (counts.get(e.username) || 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [])
  const actorMax = topActors[0]?.[1] || 1

  return (
    <div>
      {/* The alarm renders only when there is something to alarm about. */}
      {s.active_breakglass_grants > 0 && (
        <AlarmBand
          icon={ShieldAlert}
          action={
            <Link to="/admin/jit" className="flex-none text-sm font-semibold underline">
              Review
            </Link>
          }
        >
          {s.active_breakglass_grants} break-glass grant in force — emergency elevation is live right now.
        </AlarmBand>
      )}

      <div className={clsx(s.active_breakglass_grants > 0 && 'mt-6')}>
        <HeroMetric
          label="Waiting on your decision"
          value={s.pending_approvals}
          tone={s.pending_approvals > 0 ? 'warn' : 'neutral'}
          caption={`${s.awaiting_first_approval} new · ${s.awaiting_second_approval} need a second approver · includes break-glass in its waiting period`}
          action={
            <Button variant="primary" size="lg" iconRight={ArrowRight} to="/admin/jit">
              Open the queue
            </Button>
          }
        />

        {/* Inventory. Present, subordinate, one line. */}
        <StatRail
          className="mt-6"
          items={[
            { label: 'Active sessions', value: s.active_sessions, to: '/sessions' },
            { label: 'Active grants', value: s.active_grants, to: '/admin/jit' },
            { label: 'Resources', value: s.active_resources, to: '/resources' },
            { label: 'Break-glass', value: s.active_breakglass_grants, tone: s.active_breakglass_grants > 0 ? 'danger' : undefined },
          ]}
        />
      </div>

      <Section
        title="The queue"
        description="Oldest first, with the requests that already carry one approval at the top — those need one specific different person and clear fastest."
        action={
          <Link to="/admin/jit" className="text-sm font-semibold text-accent hover:underline">
            All {s.pending_approvals} →
          </Link>
        }
      >
        <Panel>
          {queue.map((r) => (
            <QueueRow key={r.id} request={r} isRoot={isRoot} viewerId={viewerId} onApprove={setApproveTarget} onDeny={setDenyTarget} />
          ))}
        </Panel>
      </Section>

      <Section title="Activity">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <RuledLabel>Events per hour</RuledLabel>
            <ActivityBars events={auditEvents} />
            <p className="mt-3 text-xs text-tertiary">
              Computed from the {auditEvents.length} most recent audit entries. Denials in red. The API
              returns events, not aggregates — this is the sample, not the whole trail.
            </p>
          </div>

          <div>
            <RuledLabel action={<Link to="/admin/audit" className="text-xs font-semibold text-accent hover:underline">Open audit</Link>}>
              Recent denials
            </RuledLabel>
            <ul className="divide-y divide-line">
              {denials.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-4 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-primary">{e.action}</p>
                    <p className="truncate text-xs text-tertiary">
                      {e.username} · {e.resource}
                    </p>
                  </div>
                  <Meta className="flex-none">{relative(e.occurred_at)}</Meta>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-8">
          <RuledLabel>Most active accounts</RuledLabel>
          <ul className="space-y-2">
            {topActors.map(([name, count]) => (
              <li key={name} className="flex items-center gap-3">
                <span className="w-40 flex-none truncate text-sm text-primary">{name}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
                  <span className="block h-full rounded-full bg-line-strong" style={{ width: `${(count / actorMax) * 100}%` }} />
                </span>
                <span className="w-10 flex-none text-right text-xs tabular text-tertiary">{count}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-tertiary">
            High volume is not itself suspicious — an automation account belongs here.
          </p>
        </div>
      </Section>

      <ConfirmDialog
        open={!!approveTarget}
        onClose={() => setApproveTarget(null)}
        title={`Approve access to ${approveTarget?.resource_name}?`}
        consequence={
          willIssue(approveTarget)
            ? isRoot
              ? 'You are root — your approval settles this alone. The grant is issued immediately.'
              : 'This is the second of two approvals. The grant is issued immediately.'
            : 'This is the FIRST of two approvals. No grant is issued yet — a second, different administrator (or root) must also approve.'
        }
        confirmLabel={isRoot ? 'Approve (final)' : willIssue(approveTarget) ? 'Approve (2 of 2)' : 'Approve (1 of 2)'}
        reasonLabel="Reason (optional)"
        onConfirm={() => {
          const r = approveTarget
          setApproveTarget(null)
          toast({
            title: willIssue(r) ? 'Grant issued' : 'Approved — one of two',
            description: willIssue(r)
              ? `${r.requester_username} can now connect to ${r.resource_name}.`
              : 'A second, different administrator — or root — must approve before any access exists.',
          })
        }}
      />

      <ConfirmDialog
        open={!!denyTarget}
        onClose={() => setDenyTarget(null)}
        title={`Deny access to ${denyTarget?.resource_name}?`}
        consequence="One denial ends this request on its own — unlike approval, it does not wait for a second person."
        confirmLabel="Deny request"
        destructive
        requireReason
        reasonLabel="Reason for denial"
        onConfirm={() => { setDenyTarget(null); toast({ title: 'Request denied', tone: 'warning' }) }}
      />
    </div>
  )
}

// ===========================================================================
// Normal user
// ===========================================================================
function UserDashboard({ viewer }) {
  const myGrants = grants.filter((g) => g.user_id === viewer.user_id && g.status === 'ACTIVE')
  const mySessions = sessions.filter((s) => s.user_id === viewer.user_id && s.status === 'ACTIVE')
  const myRequests = jitRequests.filter(
    (r) => r.requester_user_id === viewer.user_id && ['PENDING', 'PARTIALLY_APPROVED', 'WAITING'].includes(r.status)
  )
  // Self-scoped: GET /pam/audit?user_id=<me>. The endpoint takes user_id and
  // the current build never sends it, which is why "your activity" today shows
  // the whole org (audit finding F-03).
  const myEvents = auditEvents.filter((e) => e.user_id === viewer.user_id).slice(0, 6)

  const soonest = [...myGrants].sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at))[0]
  const cd = soonest ? countdown(soonest.expires_at) : null

  return (
    <div>
      {soonest ? (
        <HeroMetric
          label="Access expiring soonest"
          value={cd.text}
          tone={cd.tone}
          caption={`${soonest.resource_name} · granted ${relative(soonest.granted_at)}${soonest.recording_required ? ' · session recorded' : ''}`}
          action={
            <Button variant="primary" size="lg" to="/jit">
              Request an extension
            </Button>
          }
        />
      ) : (
        <HeroMetric label="Active access" value="None" caption="You hold no elevated access right now." />
      )}

      <StatRail
        className="mt-6"
        items={[
          { label: 'Active grants', value: myGrants.length, to: '/jit' },
          { label: 'Requests in flight', value: myRequests.length, to: '/jit' },
          { label: 'Open sessions', value: mySessions.length, to: '/sessions' },
        ]}
      />

      {myGrants.length > 0 && (
        <Section title="Your active access" action={<Link to="/jit" className="text-sm font-semibold text-accent hover:underline">All grants →</Link>}>
          <Panel>
            {myGrants.map((g) => {
              const c = countdown(g.expires_at)
              return (
                <div key={g.id} className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 last:border-b-0">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-primary">{g.resource_name}</span>
                      {g.is_breakglass && <BreakglassTag />}
                    </div>
                    <p className="mt-1 truncate text-xs text-tertiary">
                      <span className="font-mono">{g.action}</span> · granted {relative(g.granted_at)}
                      {g.recording_required && ' · recorded'}
                    </p>
                  </div>
                  <div className="flex flex-none items-center gap-4">
                    <StatusDot tone={c.tone === 'neutral' ? 'ok' : c.tone} label={c.text} />
                    <Button size="sm">Connect</Button>
                  </div>
                </div>
              )
            })}
          </Panel>
        </Section>
      )}

      {myRequests.length > 0 && (
        <Section title="Waiting on an approver">
          <Panel>
            {myRequests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 last:border-b-0">
                <div className="min-w-0">
                  <span className="truncate text-sm font-semibold text-primary">{r.resource_name}</span>
                  <p className="mt-1 truncate text-xs text-tertiary">
                    asked {relative(r.requested_at)} · expires if undecided {relative(r.request_expires_at)}
                  </p>
                </div>
                <StatusDot tone={JIT_TONE[r.status]} label={JIT_LABEL[r.status]} />
              </div>
            ))}
          </Panel>
        </Section>
      )}

      <Section
        title="Your recent activity"
        description="Only your own events. The audit endpoint accepts user_id — this view sends it."
        action={<Link to="/activity" className="text-sm font-semibold text-accent hover:underline">Full trail →</Link>}
      >
        <ul className="divide-y divide-line">
          {myEvents.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-4 py-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-primary">{e.action}</p>
                <p className="truncate text-xs text-tertiary">{e.resource}</p>
              </div>
              <div className="flex flex-none items-center gap-4">
                <StatusDot tone={e.outcome === 'SUCCESS' ? 'ok' : 'danger'} label={e.outcome} />
                <Meta>{relative(e.occurred_at)}</Meta>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}

export default function Dashboard() {
  const { isAdmin, isRoot, viewer } = useViewer()
  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-primary">{isAdmin ? 'Control plane' : 'Your access'}</h1>
          <p className="mt-1 text-base text-secondary">
            {isAdmin
              ? 'What is waiting on a decision, and what is live right now.'
              : 'What you hold, what you have asked for, and what you have done.'}
          </p>
        </div>
        <FreshnessMarker className="hidden flex-none sm:inline-flex" />
      </div>
      {isAdmin ? <AdminDashboard isRoot={isRoot} viewerId={viewer.user_id} /> : <UserDashboard viewer={viewer} />}
    </>
  )
}
