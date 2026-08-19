import { useMemo, useState } from 'react'
import { ShieldAlert, Timer, UserCheck, X } from 'lucide-react'
import { useViewer } from '../state/viewer'
import { approvalsByRequest, grants, jitRequests } from '../fixtures'
import {
  AlarmBand, BreakglassTag, Button, DetailList, FilterChip, Meta, Panel,
  PageHeader, RuledLabel, Section, Segmented, StatusDot,
} from '../ui/primitives'
import { DataTable, COL, Td, Th, Tr, Trunc, RowActions } from '../ui/table'
import { DeniedState, EmptyState } from '../ui/states'
import { countdown, dateTime, GRANT_TONE, JIT_LABEL, JIT_TONE, relative } from '../lib/format'

// ===========================================================================
// Admin Center → Approvals    (was /admin/jit)
// ===========================================================================
// WHAT CHANGED
//
//  • It is a QUEUE, not a filtered table. Three bands in decision order:
//      1. One approval short  — needs one specific different person, clears fastest
//      2. New                 — needs anyone
//      3. Break-glass waiting — time-critical and different in kind
//    (Teleport's "Needs Review"; StrongDM's approve-in-the-row.)
//  • Four-eyes state is the organising principle, not a badge: the band a
//    request sits in IS its approval state, so no one has to decode a chip.
//  • Approve/Deny are inline. The drawer is for WHY (the trail, the reason,
//    the requester's justification) — the thing Teleport filed #48764 about.
//  • Root sees "Approve (final)" and a consequence line saying the grant
//    issues immediately. That label already comes from lib/fourEyes.js; the
//    redesign renders it, it does not invent it.
//  • Grants move to a sibling tab with revoke — the same object, later in life.
//
// EVERY ACTION MAPS TO AN ENDPOINT
//   Approve → POST /admin/actions/jit-requests/:id/approve   (RequireMFA)
//   Deny    → POST /admin/actions/jit-requests/:id/deny
//   Revoke  → POST /admin/actions/grants/:id/revoke
//   Trail   → GET  /admin/jit-requests/:id  (the ONLY source of `approvals`)
// There is no bulk approve endpoint, so there is no bulk approve control.

function ApprovalRow({ request, isRoot, viewerId, onOpen }) {
  const trail = approvalsByRequest[request.id] || null
  const approved = trail?.filter((a) => a.decision === 'approved') || []
  const alreadyMine = approved.some((a) => a.approver_user_id === viewerId)
  const isBg = request.request_type === 'BREAKGLASS'
  const label = isRoot ? 'Approve (final)' : approved.length >= 1 ? 'Approve (2 of 2)' : 'Approve'
  const blocked = !isRoot && alreadyMine ? 'You already approved this — the server rejects a duplicate approver' : null

  return (
    <div className="flex flex-col gap-3 border-b border-line px-4 py-3 last:border-b-0 lg:flex-row lg:items-center lg:justify-between">
      <button type="button" onClick={() => onOpen(request)} className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-primary">{request.resource_name}</span>
          {isBg && <BreakglassTag />}
          <Meta mono className="hidden sm:inline">{request.action}</Meta>
        </div>
        <p className="mt-1 truncate text-xs text-secondary">
          {request.requester_username} · {request.duration_minutes} min ·{' '}
          {request.ticket_ref ? <span className="font-mono">{request.ticket_ref}</span> : <span className="text-tertiary">no ticket</span>}
          {' · '}asked {relative(request.requested_at)}
        </p>
        <p className="mt-1 truncate text-xs text-tertiary">{request.reason}</p>
      </button>

      <div className="flex flex-none flex-wrap items-center gap-3">
        {/* Who is still needed, in words. */}
        <span className="text-xs text-tertiary">
          {isBg && request.available_at ? (
            <>available {relative(request.available_at)}</>
          ) : approved.length >= 1 ? (
            <>
              approved by <span className="text-primary">{approved[0].approver_username}</span> · needs 1 more
            </>
          ) : (
            <>needs 2 approvers</>
          )}
        </span>
        <span className="text-xs text-tertiary">
          expires {relative(request.request_expires_at)}
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={!!blocked} title={blocked || undefined}>
            {label}
          </Button>
          <Button size="sm" variant="dangerQuiet">Deny</Button>
        </div>
      </div>
    </div>
  )
}

function Band({ icon: Icon, title, hint, count, children }) {
  if (count === 0) return null
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          {Icon && <Icon className="h-4 w-4 text-tertiary" strokeWidth={1.75} />}
          {title}
          <span className="rounded-full bg-subtle px-2 text-xs tabular text-secondary">{count}</span>
        </span>
      }
      description={hint}
    >
      <Panel>{children}</Panel>
    </Section>
  )
}

// The drawer answers "why", never "what" — the action already happened in the
// row. Level-2 elevation is the only shadow in the system and this is one of
// the four places it's allowed.
function RequestDrawer({ request, isRoot, onClose }) {
  if (!request) return null
  const trail = approvalsByRequest[request.id] || null
  const approved = trail?.filter((a) => a.decision === 'approved') || []
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="anim-overlay absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <aside className="anim-drawer relative flex h-full w-full max-w-[32rem] flex-col border-l border-line bg-surface shadow-overlay">
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line px-4">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-primary">{request.resource_name}</p>
            <p className="truncate font-mono text-xs text-tertiary">{request.id}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex h-9 w-9 flex-none items-center justify-center rounded text-tertiary hover:bg-hover"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <p className="max-w-prose rounded-lg bg-subtle px-3 py-2 text-base text-primary">{request.reason}</p>

          <RuledLabel className="mt-6">Request</RuledLabel>
          <DetailList
            columns={2}
            items={[
              { label: 'Requester', value: request.requester_username },
              { label: 'Type', value: request.request_type },
              { label: 'Action', value: request.action, mono: true },
              { label: 'Duration', value: `${request.duration_minutes} min` },
              { label: 'Ticket', value: request.ticket_ref || null, mono: true },
              { label: 'Source IP', value: request.source_ip, mono: true },
              { label: 'Asked at', value: dateTime(request.requested_at) },
              { label: 'Request expires', value: dateTime(request.request_expires_at) },
            ]}
          />

          <RuledLabel className="mt-6">Approval trail</RuledLabel>
          {trail ? (
            <ol className="space-y-3">
              {trail.map((a, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-ok" />
                  <div className="min-w-0">
                    <p className="text-sm text-primary">
                      <span className="font-semibold">{a.approver_username}</span> approved
                      {a.approver_rank >= 100 && <span className="ml-2 text-xs text-tertiary">(root — final)</span>}
                    </p>
                    <p className="text-xs text-tertiary">{dateTime(a.created_at)}</p>
                    {a.reason && <p className="mt-1 text-sm text-secondary">{a.reason}</p>}
                  </div>
                </li>
              ))}
              <li className="flex gap-3">
                <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-warn" />
                <p className="text-sm text-secondary">
                  Waiting on a second, different approver{isRoot ? ' — or your approval, which settles it alone.' : '.'}
                </p>
              </li>
            </ol>
          ) : (
            <p className="text-sm text-tertiary">
              No approvals recorded yet. The trail only exists on{' '}
              <span className="font-mono text-xs">GET /admin/jit-requests/:id</span> — list responses never carry it.
            </p>
          )}
        </div>

        <footer className="flex flex-none items-center gap-2 border-t border-line px-4 py-3">
          <Button variant="primary" size="lg">
            {isRoot ? 'Approve (final)' : approved.length >= 1 ? 'Approve (2 of 2)' : 'Approve'}
          </Button>
          <Button variant="dangerQuiet" size="lg">Deny</Button>
          <p className="ml-auto max-w-[16rem] text-right text-xs text-tertiary">
            {isRoot
              ? 'Your approval issues the grant immediately.'
              : approved.length >= 1
                ? 'This is the second approval — the grant issues immediately.'
                : 'First of two. No grant is issued yet.'}
          </p>
        </footer>
      </aside>
    </div>
  )
}

function GrantsTab() {
  const [status, setStatus] = useState('ACTIVE')
  const rows = grants.filter((g) => g.status === status)
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: 'ACTIVE', label: 'Active', count: grants.filter((g) => g.status === 'ACTIVE').length },
            { value: 'EXPIRED', label: 'Expired', count: grants.filter((g) => g.status === 'EXPIRED').length },
            { value: 'REVOKED', label: 'Revoked', count: grants.filter((g) => g.status === 'REVOKED').length },
          ]}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState variant="no-match" description="No grants in this state." />
      ) : (
        <DataTable minWidth="60rem">
          <thead>
            <tr>
              <Th width={COL.name} sticky edge>Resource</Th>
              <Th width={COL.medium}>Holder</Th>
              <Th width={COL.wide}>Action</Th>
              <Th width={COL.short} align="right">Expires</Th>
              <Th width={COL.short}>Recording</Th>
              <Th width={COL.short}>IAM sync</Th>
              <Th width={COL.actions} align="right"><span className="sr-only">Actions</span></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => {
              const c = countdown(g.expires_at)
              return (
                <Tr key={g.id}>
                  <Td sticky edge>
                    <div className="flex items-center gap-2">
                      <Trunc value={g.resource_name} />
                      {g.is_breakglass && <BreakglassTag />}
                    </div>
                  </Td>
                  <Td><Trunc value={g.username} /></Td>
                  <Td><Trunc value={g.action} mono /></Td>
                  <Td align="right">
                    {g.status === 'ACTIVE' ? (
                      <span className={c.tone === 'danger' ? 'text-danger' : c.tone === 'warn' ? 'text-warn' : ''}>{c.text}</span>
                    ) : (
                      <span className="text-tertiary">{relative(g.expires_at)}</span>
                    )}
                  </Td>
                  <Td><Trunc value={g.recording_required ? 'Required' : 'Not required'} muted={!g.recording_required} /></Td>
                  <Td><Trunc value={g.iam_sync_status} muted /></Td>
                  <Td align="right">
                    {g.status === 'ACTIVE' && (
                      <RowActions>
                        <Button size="sm" variant="dangerQuiet">Revoke</Button>
                      </RowActions>
                    )}
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </DataTable>
      )}
      <p className="mt-3 text-xs text-tertiary">
        Revoking a grant also kills its live sessions — the API returns{' '}
        <span className="font-mono">sessions_killed</span>, so the confirmation states the count before you commit.
      </p>
    </>
  )
}

export default function AdminApprovals() {
  const { isAdmin, isRoot, viewer } = useViewer()
  const [tab, setTab] = useState('queue')
  const [open, setOpen] = useState(null)
  const [onlyBreakglass, setOnlyBreakglass] = useState(false)

  if (!isAdmin) {
    return <DeniedState requires="admin" what="the approvals queue" fallbackHref="/jit" fallbackLabel="Go to your own requests" />
  }

  const all = onlyBreakglass ? jitRequests.filter((r) => r.request_type === 'BREAKGLASS') : jitRequests
  const oneShort = all.filter((r) => r.status === 'PARTIALLY_APPROVED')
  const fresh = all.filter((r) => r.status === 'PENDING')
  const waiting = all.filter((r) => r.status === 'WAITING')
  const total = oneShort.length + fresh.length + waiting.length

  return (
    <>
      <PageHeader
        eyebrow="Admin Center"
        title="Approvals"
        description="Standard requests need two different approvers. Root settles alone. A denial ends a request on its own — it never waits for a second person."
        actions={
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'queue', label: 'Queue', count: total },
              { value: 'grants', label: 'Grants', count: grants.filter((g) => g.status === 'ACTIVE').length },
            ]}
          />
        }
      />

      {tab === 'queue' ? (
        <>
          {waiting.length > 0 && (
            <AlarmBand tone="warn" icon={ShieldAlert}>
              {waiting.length} break-glass request in its mandatory waiting period. It becomes available without
              an approval when the period elapses.
            </AlarmBand>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <FilterChip active={onlyBreakglass} onClick={() => setOnlyBreakglass(!onlyBreakglass)}>
              Break-glass only
            </FilterChip>
            <span className="ml-auto text-xs text-tertiary">
              You are approving as <span className="font-semibold text-primary">{viewer.username}</span>
              {isRoot && ' — root: your approval is final'}
            </span>
          </div>

          {total === 0 ? (
            <div className="mt-6">
              <EmptyState
                variant={onlyBreakglass ? 'no-match' : 'none-yet'}
                title="Queue clear"
                description="No JIT or break-glass request is waiting on a decision."
                onClearFilters={() => setOnlyBreakglass(false)}
              />
            </div>
          ) : (
            <>
              <Band
                icon={UserCheck}
                title="One approval short"
                hint="Already approved by someone else. Needs one different admin — or root. These clear fastest."
                count={oneShort.length}
              >
                {oneShort.map((r) => (
                  <ApprovalRow key={r.id} request={r} isRoot={isRoot} viewerId={viewer.user_id} onOpen={setOpen} />
                ))}
              </Band>

              <Band icon={Timer} title="New" hint="No approvals yet. Two different people must approve." count={fresh.length}>
                {fresh.map((r) => (
                  <ApprovalRow key={r.id} request={r} isRoot={isRoot} viewerId={viewer.user_id} onOpen={setOpen} />
                ))}
              </Band>

              <Band
                icon={ShieldAlert}
                title="Break-glass — waiting period"
                hint="Emergency elevation. Denying now is the only way to stop it before the period elapses."
                count={waiting.length}
              >
                {waiting.map((r) => (
                  <ApprovalRow key={r.id} request={r} isRoot={isRoot} viewerId={viewer.user_id} onOpen={setOpen} />
                ))}
              </Band>
            </>
          )}

          <Section title="Recently decided" description="Read-only. A decided request cannot be reopened — the requester raises a new one.">
            <ul className="divide-y divide-line">
              {jitRequests
                .filter((r) => ['APPROVED', 'DENIED', 'EXPIRED'].includes(r.status))
                .map((r) => (
                  <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-primary">
                        <span className="font-semibold">{r.resource_name}</span> · {r.requester_username}
                      </p>
                      {r.decision_reason && <p className="mt-1 max-w-prose text-xs text-tertiary">{r.decision_reason}</p>}
                    </div>
                    <div className="flex flex-none items-center gap-4">
                      <StatusDot tone={JIT_TONE[r.status]} label={JIT_LABEL[r.status]} />
                      <Meta>{r.approver_username ? `by ${r.approver_username}` : 'no decision'}</Meta>
                      <Meta>{relative(r.decided_at || r.request_expires_at)}</Meta>
                    </div>
                  </li>
                ))}
            </ul>
          </Section>
        </>
      ) : (
        <div className="mt-6">
          <GrantsTab />
        </div>
      )}

      <RequestDrawer request={open} isRoot={isRoot} onClose={() => setOpen(null)} />
    </>
  )
}
