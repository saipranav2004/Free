import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Plus, ShieldAlert } from 'lucide-react'
import { useViewer } from '../state/viewer'
import { grants, jitRequests, resources } from '../fixtures'
import {
  AlarmBand, BreakglassTag, Button, DetailList, FilterChip, Meta, PageHeader,
  Panel, RuledLabel, Section, StatusDot,
} from '../ui/primitives'
import { DeniedState, EmptyState } from '../ui/states'
import { countdown, dateTime, JIT_LABEL, JIT_TONE, relative } from '../lib/format'

// ===========================================================================
// JIT Access — self-service only
// ===========================================================================
// WHAT CHANGED
//
//  • The two tables (requests / grants) become ONE lifecycle list. A request
//    that was approved IS the grant — AccessGrant carries request_id and
//    JITRequest carries grant_id, so the join already exists in the payload
//    and the current UI simply ignores it, making the user correlate by
//    resource name across two paginated tables.
//        PENDING → 1 OF 2 → APPROVED (grant, counting down) → EXPIRED/REVOKED
//    (Okta Access Requests: an approved request becomes the access entry.)
//  • Every open item states WHO it is waiting on, not just that it is waiting.
//  • Break-glass is visually separate because it is a different promise: it
//    does not wait for an approver, it waits for a clock.
//
// ENDPOINTS
//   GET  /pam/jit/requests   ·  GET /pam/jit/grants
//   POST /pam/jit/requests   ·  POST /pam/jit/breakglass
//   POST /pam/jit/requests/:id/cancel
// A requester cannot approve, extend or revoke — no such endpoint exists for
// them — so no such control is drawn.

function LifecycleRow({ item }) {
  const { request, grant } = item
  const isBg = request?.request_type === 'BREAKGLASS'
  const c = grant && grant.status === 'ACTIVE' ? countdown(grant.expires_at) : null

  return (
    <div className="flex flex-col gap-3 border-b border-line px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={`/jit/requests/${request?.id || grant?.request_id}`}
            className="truncate text-sm font-semibold text-primary hover:text-accent"
          >
            {request?.resource_name || grant?.resource_name}
          </Link>
          {isBg && <BreakglassTag />}
        </div>
        <p className="mt-1 truncate text-xs text-secondary">
          {request ? (
            <>
              {request.duration_minutes} min ·{' '}
              {request.ticket_ref ? <span className="font-mono">{request.ticket_ref}</span> : <span className="text-tertiary">no ticket</span>}
              {' · asked '}{relative(request.requested_at)}
            </>
          ) : (
            <>granted {relative(grant.granted_at)}</>
          )}
        </p>
        {request?.reason && <p className="mt-1 truncate text-xs text-tertiary">{request.reason}</p>}
      </div>

      <div className="flex flex-none items-center gap-4">
        {/* One line that says exactly where this stands. */}
        {grant && grant.status === 'ACTIVE' ? (
          <StatusDot tone={c.tone === 'neutral' ? 'ok' : c.tone} label={c.text} live />
        ) : request?.status === 'PARTIALLY_APPROVED' ? (
          <span className="text-xs text-warn">1 of 2 approved · waiting on a different admin</span>
        ) : request?.status === 'WAITING' ? (
          <span className="text-xs text-warn">available {relative(request.available_at)}</span>
        ) : request?.status === 'PENDING' ? (
          <span className="text-xs text-warn">waiting on any approver</span>
        ) : (
          <StatusDot tone={JIT_TONE[request?.status] || 'neutral'} label={JIT_LABEL[request?.status] || grant?.status} />
        )}

        {grant?.status === 'ACTIVE' ? (
          <Button size="sm" variant="primary">Connect</Button>
        ) : ['PENDING', 'PARTIALLY_APPROVED', 'WAITING'].includes(request?.status) ? (
          <Button size="sm" variant="dangerQuiet">Cancel</Button>
        ) : null}
      </div>
    </div>
  )
}

export function JitPage() {
  const { isAdmin, viewer } = useViewer()
  const [showHistory, setShowHistory] = useState(false)

  const mine = useMemo(() => {
    const myGrants = grants.filter((g) => g.user_id === viewer.user_id)
    const myRequests = jitRequests.filter((r) => r.requester_user_id === viewer.user_id)
    const byRequestId = new Map(myGrants.map((g) => [g.request_id, g]))
    const seen = new Set()
    const merged = myRequests.map((r) => {
      const g = byRequestId.get(r.id)
      if (g) seen.add(g.id)
      return { request: r, grant: g || null }
    })
    // Grants whose request row isn't in this page of results still belong here.
    for (const g of myGrants) if (!seen.has(g.id)) merged.push({ request: null, grant: g })
    return merged
  }, [viewer.user_id])

  // Admins are redirected off this route by SelfServiceOnly — they decide
  // other people's requests, they don't raise them against themselves.
  // (Checked after the hooks, never inside a branch, so hook order is stable.)
  if (isAdmin) {
    return (
      <DeniedState
        title="This page is for raising your own requests"
        explanation="Your account holds admin, so JIT is the other side of the workflow for you: you decide other people's requests and revoke their grants, in Approvals. Following an old link or bookmark lands here."
        fallbackHref="/admin/jit"
        fallbackLabel="Go to Approvals"
      />
    )
  }

  const open = mine.filter(
    (m) => m.grant?.status === 'ACTIVE' || ['PENDING', 'PARTIALLY_APPROVED', 'WAITING'].includes(m.request?.status)
  )
  const history = mine.filter((m) => !open.includes(m))

  return (
    <>
      <PageHeader
        title="JIT Access"
        description="Request time-boxed access to a resource. A standard request needs two different approvers; break-glass waits out a mandatory period instead."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="primary" icon={Plus}>Request access</Button>
            <Button variant="dangerQuiet" icon={ShieldAlert}>Break-glass</Button>
          </div>
        }
      />

      <Section title="Open" description="Everything you hold or are waiting for, newest activity first.">
        {open.length === 0 ? (
          <EmptyState
            title="No access in flight"
            description="You hold no elevated access and have nothing waiting on an approver."
            action={<Button variant="primary" icon={Plus}>Request access</Button>}
          />
        ) : (
          <Panel>
            {open.map((m, i) => (
              <LifecycleRow key={m.request?.id || m.grant?.id || i} item={m} />
            ))}
          </Panel>
        )}
      </Section>

      <Section
        title="History"
        action={
          <FilterChip active={showHistory} onClick={() => setShowHistory(!showHistory)} count={history.length}>
            {showHistory ? 'Hide' : 'Show'}
          </FilterChip>
        }
      >
        {showHistory &&
          (history.length === 0 ? (
            <EmptyState title="No history yet" description="Decided, expired and cancelled requests land here." />
          ) : (
            <Panel>
              {history.map((m, i) => (
                <LifecycleRow key={m.request?.id || m.grant?.id || i} item={m} />
              ))}
            </Panel>
          ))}
      </Section>
    </>
  )
}

// ===========================================================================
// One request
// ===========================================================================
// WHAT CHANGED
//  • The timeline IS the page — status, who is next, and how long is left.
//    It was one card among nine, none of which had more weight than the others.
//  • The decision reason is shown when there is one. Teleport filed a bug
//    (#48764) asking for exactly this; our API already returns
//    `decision_reason` and the current UI shows it only in passing.
export function JitRequestDetail() {
  const { id } = useParams()
  const { isAdmin } = useViewer()
  if (isAdmin) {
    return (
      <DeniedState
        title="This page is for raising your own requests"
        explanation="Your account holds admin. Open this request from the approvals queue instead, where you can act on it."
        fallbackHref="/admin/jit"
        fallbackLabel="Go to Approvals"
      />
    )
  }

  const request = jitRequests.find((r) => r.id === id) || jitRequests[0]
  const grant = grants.find((g) => g.request_id === request.id)
  const resource = resources.find((r) => r.id === request.resource_id)
  const c = grant && grant.status === 'ACTIVE' ? countdown(grant.expires_at) : null

  const steps = [
    { label: 'Requested', done: true, at: request.requested_at, note: `${request.duration_minutes} min on ${request.resource_name}` },
    {
      label: request.request_type === 'BREAKGLASS' ? 'Waiting period' : 'First approval',
      done: ['PARTIALLY_APPROVED', 'APPROVED'].includes(request.status),
      at: request.status === 'PARTIALLY_APPROVED' ? request.requested_at : request.decided_at,
      note:
        request.request_type === 'BREAKGLASS'
          ? `Becomes available ${relative(request.available_at)} without an approval`
          : request.status === 'PENDING'
            ? 'Waiting on any approver'
            : 'Approved by one admin',
    },
    {
      label: 'Second approval',
      done: request.status === 'APPROVED',
      at: request.decided_at,
      note:
        request.status === 'PARTIALLY_APPROVED'
          ? 'Needs a different admin — or root, whose approval settles it alone'
          : request.status === 'APPROVED'
            ? `Approved by ${request.approver_username}`
            : request.status === 'DENIED'
              ? 'Denied — one denial ends a request on its own'
              : 'Not reached',
      failed: request.status === 'DENIED',
    },
    {
      label: 'Access',
      done: !!grant,
      at: grant?.granted_at,
      note: grant ? (grant.status === 'ACTIVE' ? c.text : `${grant.status.toLowerCase()}`) : 'No grant issued',
    },
  ]

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/jit" className="hover:text-accent">JIT Access</Link>}
        title={request.resource_name}
        description={request.reason}
        actions={
          grant?.status === 'ACTIVE' ? (
            <Button variant="primary" size="lg">Connect</Button>
          ) : ['PENDING', 'PARTIALLY_APPROVED', 'WAITING'].includes(request.status) ? (
            <Button variant="dangerQuiet" size="lg">Cancel request</Button>
          ) : null
        }
      />

      {grant?.status === 'ACTIVE' && (
        <AlarmBand tone={c.tone === 'danger' ? 'danger' : c.tone === 'warn' ? 'warn' : 'ok'}>
          Access is live — {c.text}
          {grant.recording_required && '. This session is recorded.'}
        </AlarmBand>
      )}

      <Section title="Progress">
        <ol className="space-y-4">
          {steps.map((s) => (
            <li key={s.label} className="flex gap-3">
              <span
                className={
                  'mt-2 h-2 w-2 flex-none rounded-full ' +
                  (s.failed ? 'bg-danger' : s.done ? 'bg-ok' : 'bg-line-strong')
                }
              />
              <div className="min-w-0">
                <p className="text-base font-semibold text-primary">{s.label}</p>
                <p className="mt-1 text-sm text-secondary">{s.note}</p>
                {s.at && <p className="mt-0.5 text-xs text-tertiary">{dateTime(s.at)}</p>}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {request.decision_reason && (
        <Section title={request.status === 'DENIED' ? 'Why it was denied' : 'Approver’s note'}>
          <p className="max-w-prose rounded-lg bg-subtle px-3 py-2 text-base text-primary">{request.decision_reason}</p>
          <p className="mt-2 text-xs text-tertiary">
            {request.approver_username} · {dateTime(request.decided_at)}
          </p>
        </Section>
      )}

      <Section title="Request">
        <DetailList
          columns={2}
          items={[
            { label: 'Request ID', value: request.id, mono: true },
            { label: 'Type', value: request.request_type },
            { label: 'Resource', value: <Link to={`/resources/${resource?.id}`} className="text-accent hover:underline">{request.resource_name}</Link> },
            { label: 'Action', value: request.action, mono: true },
            { label: 'Duration', value: `${request.duration_minutes} minutes` },
            { label: 'Ticket', value: request.ticket_ref || null, mono: true },
            { label: 'Source IP', value: request.source_ip, mono: true },
            { label: 'Undecided requests expire', value: dateTime(request.request_expires_at) },
          ]}
        />
      </Section>

      {grant && (
        <Section title="Grant">
          <DetailList
            columns={2}
            items={[
              { label: 'Grant ID', value: grant.id, mono: true },
              { label: 'Status', value: grant.status },
              { label: 'Granted', value: dateTime(grant.granted_at) },
              { label: 'Expires', value: dateTime(grant.expires_at) },
              { label: 'Recording', value: grant.recording_required ? 'Required' : 'Not required' },
              { label: 'IAM sync', value: grant.iam_sync_status, mono: true },
            ]}
          />
        </Section>
      )}
    </>
  )
}
