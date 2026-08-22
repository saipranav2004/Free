import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import clsx from 'clsx'
import {
  KeyRound,
  Lock,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  SearchX,
  FileText,
  AlarmClock,
  UsersRound,
} from 'lucide-react'
import {
  listJitRequests,
  getJitRequest,
  approveJitRequest,
  denyJitRequest,
  listGrants,
  revokeGrant,
  listBreakglass,
  getBreakglassReport,
  getStats,
} from '../../api/admin'
import { PageHeader, Card, DetailList, ListPanel } from '../../components/common/Layout'
import { DataTable, RowActions, Td, Th, Tr, Trunc } from '../../components/ui/grid'
import { AlarmTag, StatusDot } from '../../components/ui/bits'
import { EmptyState } from '../../components/ui/states'
import { QueryState } from '../../components/common/QueryState'
import { Pagination } from '../../components/common/Pagination'
import { Badge, StatusIndicator, MetaTag } from '../../components/common/Badge'
import { cell, COL, TruncCell } from '../../components/common/tableStyles'
import { Button } from '../../components/common/Button'
import { Drawer } from '../../components/common/Drawer'
import { TabBar } from '../../components/common/TabBar'
import { SegmentedControl, FilterToggle } from '../../components/common/SegmentedControl'
import { SearchField, SortHeader, RefreshControl } from '../../components/common/TableControls'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { Spinner } from '../../components/common/Spinner'
import { Avatar } from '../../components/common/UserMenu'
import { useTableState } from '../../hooks/useTableState'
import { formatDateTime, formatDuration, formatRelativeToNow } from '../../lib/format'
import { apiErrorMessage } from '../../lib/apiError'
import { useAuthStore } from '../../store/authStore'
import {
  approvalsOf,
  approvalProgress,
  isApproval,
  approveBlockedReason,
  approveButtonLabel,
  approveConsequence,
  readApproveResult,
  approveResultMessage,
  approvalErrorMessage,
  isStaleStateError,
  viewerIdOf,
  userFacingNext,
} from '../../lib/fourEyes'
import { ApprovalProgress, ApprovalTrail } from '../../components/jit/ApprovalTrail'
import {
  JIT_STATUS,
  JIT_STATUS_LABELS,
  JIT_STATUS_BADGE,
  JIT_OPEN_STATUSES,
  GRANT_STATUS,
  GRANT_STATUS_BADGE,
} from '../../config/constants'

// ---------------------------------------------------------------------------
// JIT Approvals, a decision queue, not a list
// ---------------------------------------------------------------------------
// WHAT WAS WRONG. Every row was the same weight: a title, a grey subtitle, a
// status pill and two hand-rolled <button>s that didn't come from the button
// system (different height, different radius, different hover than every other
// action in the console). Nothing distinguished a break-glass request at 03:00
// from a routine one; the reason, the single most important field on the
// screen, the thing an approver is actually judging, was crammed into a
// truncated subtitle after a "·"; and there was no way to see how long someone
// had been waiting, which is the other half of every approval decision.
//
// WHAT IT IS NOW. The queue is modelled the way access-request queues are in
// ServiceNow/Okta: each pending request is a DECISION CARD carrying its own
// risk rail (red for break-glass, amber for waiting), the requester's identity,
// the full quoted justification, how long it has been waiting, and the two
// verdicts as first-class primary/danger actions, with the reason capture the
// audit record needs. Decided requests collapse to quiet rows, because they no
// longer need a decision.
//
// Grants and break-glass become real tables (sortable, searchable, with an
// "expiring soon" facet, since an expiring standing grant is the thing an
// admin needs to catch), and the break-glass report moves from a hand-rolled
// fixed-position div into the console's own Drawer.
//
// FOUR-EYES (dual control). A STANDARD request is no longer settled by one
// approval. The first admin's approval moves it to PARTIALLY_APPROVED and
// issues NOTHING; a second, DIFFERENT admin (or root, whose approval is final
// on its own) has to approve before a grant exists. That changes this screen
// in four concrete ways, all of them about not lying to the person deciding:
//
//   · PARTIALLY_APPROVED is an OPEN state. It stays in the queue, keeps its
// decision card, and keeps polling. Treating it as decided would hide
// exactly the requests that are waiting on someone.
//   · The card says how far along it is, "1 of 2 approvals", and who has
// already approved, so the second approver knows they are the second.
//   · Approve is DISABLED, with the reason in words, when the server would
// refuse: your own request (403) or your own second click (409).
//   · The approve response comes back in two shapes and the toast has to say
// which one happened; "Request approved" after a first approval would
// claim a grant that does not exist.
//
// The trail itself only exists on GET /admin/jit-requests/:id, so the queue
// hydrates it for the handful of partially-approved rows on the visible page
// rather than for everything.
//
// Every mutation, endpoint and confirm-dialog contract is otherwise unchanged.

const TABS = [
  { key: 'requests', label: 'Requests', icon: KeyRound },
  { key: 'grants', label: 'Grants', icon: Lock },
  { key: 'breakglass', label: 'Break-glass', icon: ShieldAlert },
]

// PENDING, PARTIALLY_APPROVED and WAITING, everything an approver can still
// act on. Shared with the rest of the console via config/constants.js so no
// screen can disagree about what "still open" means.
const PENDING_LIKE = JIT_OPEN_STATUSES
const PAGE_SIZE = 100

// The approvals trail is one HTTP call per request, so it is fetched only for
// the rows that actually need it: the partially-approved ones on the page you
// are looking at. A queue with 200 half-approved requests would otherwise open
// 200 connections to grey out a button.
const TRAIL_HYDRATION_LIMIT = 12

// Field names for "who requested this" aren't pinned down on the admin list
// endpoint's payload, probe the plausible candidates rather than assume one.
function requesterLabel(r) {
  return (
    r?.requester_username ||
    r?.username ||
    r?.requested_by ||
    r?.user_username ||
    r?.requester?.username ||
    r?.user_id ||
    '-'
  )
}

function isBreakglass(r) {
  return r?.type === 'BREAKGLASS' || r?.request_type === 'BREAKGLASS' || !!r?.is_breakglass
}

// models.JITRequest carries BOTH `requested_at` (the semantic "when was this
// raised") and `created_at` (the row's audit column). Everything the approver
// reads, waiting time, ordering, the timestamp on the card, must agree on
// which one it means, or the queue sorts by one and displays the other.
const raisedAt = (r) => r?.requested_at || r?.created_at || null

// AccessGrant's own start column is `granted_at`; `created_at` is the audit
// column. Same rule.
const grantedAt = (g) => g?.granted_at || g?.created_at || null

function waitedSeconds(iso) {
  const t = new Date(iso).getTime()
  if (!t) return 0
  return Math.max(0, (Date.now() - t) / 1000)
}

function durationLabel(r) {
  const mins = r?.duration_minutes ?? r?.requested_duration_min ?? r?.duration_min
  if (!mins) return null
  return mins >= 60 ? `${(mins / 60).toFixed(mins % 60 === 0 ? 0 : 1)}h` : `${mins}m`
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function RequestDetailDrawer({ id, onClose, viewerId }) {
  const detail = useQuery({
    queryKey: ['admin', 'jit-request', id],
    queryFn: ({ signal }) => getJitRequest(id, signal),
    enabled: !!id,
    // An open drawer on an undecided request is the one place someone sits
    // and watches for the second approval to land.
    refetchInterval: (query) => {
      const st = query.state.data?.request?.status
      return PENDING_LIKE.includes(st) ? 15_000 : false
    },
    refetchOnWindowFocus: true,
  })

  const request = detail.data?.request || detail.data
  const grant = detail.data?.grant
  const trail = detail.data?.audit_trail
  const approvals = approvalsOf(detail.data)
  const progress = request ? approvalProgress(request, approvals) : null

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      title={request?.resource_name || 'Access request'}
      subtitle={
        request
          ? [
              requesterLabel(request),
              JIT_STATUS_LABELS[request.status] || request.status,
              request.status === JIT_STATUS.PARTIALLY_APPROVED && progress
                ? `${progress.given} of ${progress.required} approvals`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : 'Loading…'
      }
      icon={KeyRound}
    >
      {detail.isLoading && (
        <div className="flex items-center justify-center gap-2 py-12 text-ink-400">
          <Spinner /> <span className="text-sm">Loading request…</span>
        </div>
      )}
      {detail.isError && (
        <p className="px-4 py-6 text-sm text-red-700 dark:text-red-300">{apiErrorMessage(detail.error)}</p>
      )}
      {request && (
        <>
          {request.reason && (
            <div className="border-b border-surface-800 px-4 py-4">
              <p className="mb-2 text-xs font-semibold text-ink-500">Justification</p>
              <blockquote className="border-l-2 border-surface-700 pl-3 text-sm leading-relaxed text-ink-200">
                {request.reason}
              </blockquote>
            </div>
          )}
          <DetailList
            items={[
              { label: 'Requester', value: requesterLabel(request) },
              { label: 'Resource', value: request.resource_name || request.resource_id || '-' },
              { label: 'Type', value: isBreakglass(request) ? 'Break-glass' : 'Standard' },
              { label: 'Requested', value: formatDateTime(raisedAt(request)) },
              {
                label: 'Waiting',
                value: PENDING_LIKE.includes(request.status)
                  ? formatDuration(waitedSeconds(raisedAt(request)))
                  : '-',
              },
              { label: 'Duration asked', value: durationLabel(request) || '-' },
              // "Decided by" is the LAST approver, the one who finalised.
              // The full trail is the section below, and with four-eyes the
              // difference between the two matters.
              { label: 'Finalised by', value: request.approver_username || request.decided_by || '-' },
              { label: 'Decision note', value: request.decision_reason || request.approval_reason || '-' },
              { label: 'Request ID', value: <span className="font-mono text-xs">{request.id}</span> },
            ]}
          />
          {grant && (
            <div className="border-t border-surface-800 px-4 py-4">
              <p className="mb-2 text-xs font-semibold text-ink-500">Resulting grant</p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={GRANT_STATUS_BADGE[grant.status]}>{grant.status}</Badge>
                {grant.expires_at && <MetaTag>Expires {formatDateTime(grant.expires_at)}</MetaTag>}
              </div>
            </div>
          )}
          {!isBreakglass(request) && (
            <div className="border-t border-surface-800 py-4">
              <div className="mb-1 flex flex-wrap items-center gap-3 px-4">
                <p className="text-xs font-semibold text-ink-500">Four-eyes approvals</p>
                <ApprovalProgress request={request} approvals={approvals} className="ml-auto" />
              </div>
              <ApprovalTrail request={request} approvals={approvals} viewerId={viewerId} />
            </div>
          )}

          {Array.isArray(trail) && trail.length > 0 && (
            <div className="border-t border-surface-800 px-4 py-4">
              <p className="mb-3 text-xs font-semibold text-ink-500">Audit trail</p>
              <ol className="space-y-3">
                {trail.map((e, i) => (
                  <li key={e.id || i} className="flex gap-3">
                    <span
                      className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-surface-600"
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink-200">{e.action || e.event_type || 'Event'}</p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {formatDateTime(e.occurred_at || e.created_at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </Drawer>
  )
}

// A pending request is a decision to make, so it is presented as one: risk rail,
// identity, quoted justification, waiting time, four-eyes progress, and two
// verdicts.
//
// `approvals` is null whenever the trail has not been fetched for this row ,
// which is most of them, and always the case for a PENDING one (nothing to
// fetch). Null means "not told", so the duplicate-approver guard simply does
// not fire and the server stays the authority.
// ---------------------------------------------------------------------------
// The approval queue is a GRID, not a stack of cards
// ---------------------------------------------------------------------------
// This replaces a 120px card per request. A card carried an avatar, a
// sentence, a quoted justification block, a metadata row and three buttons,
// which meant an approver with thirty requests scrolled through 3,600px to
// see the queue. The information an approver actually compares across
// requests is: who, what, how long they want it for, how long it has been
// waiting, and how far through dual control it is. Those are columns.
//
// The justification stays on the row, as its second line, because an approver
// cannot decide without it and making them open thirty drawers is worse than
// a 56px row. The full text is one click away in the detail drawer, and on
// the title attribute.
//
// ServiceNow's approval queue and Okta's Access Requests both land here for
// the same reason: a queue you work through is a worklist, and a worklist is
// a table with actions on the row.
function ApprovalMeter({ progress }) {
  // Two segments, not a percentage bar. Dual control is discrete: one of two
  // is a state, not fifty percent of anything.
  //
  // Root is the exception the meter has to be honest about: a root approval
  // reaches quorum on its own, so the second segment fills even though only
  // one approval exists.
  const { given = 0, required = 2, quorum, finalisedByRoot } = progress || {}
  const filled = quorum ? required : Math.min(given, required)
  const label = finalisedByRoot ? 'root, final' : `${Math.min(given, required)} of ${required}`
  return (
    <span className="inline-flex items-center gap-2" title={`${given} of ${required} approvals given`}>
      <span className="flex gap-0.5" aria-hidden="true">
        {Array.from({ length: required }).map((_, i) => (
          <span key={i} className={clsx('h-1.5 w-4 rounded-full', i < filled ? 'bg-accent' : 'bg-line')} />
        ))}
      </span>
      <span className="whitespace-nowrap tabular text-xs text-secondary">{label}</span>
    </span>
  )
}

// ── The decision card ──────────────────────────────────────────────────────
//
// WHY A CARD AND NOT A TABLE ROW.
//
// A table is right for scanning many similar things and wrong for deciding.
// Approving standing access to production is the most consequential click in
// this console, and to make it responsibly an approver needs, at once: who
// asked, for what, WHY in full, for how long, how long they have waited, who
// has already approved, and what pressing the button will actually do. A row
// gives a truncated justification and a 12px text link.
//
// Every product that does approvals well, Entra PIM's Approve requests view,
// ServiceNow's approval records, presents one request as one readable block
// with the decision attached to it. So the queue is cards, and only the queue:
// decided requests go back to a compact table below, because those are a log
// to scan, not a decision to make.
function DecisionCard({ request, approvals, viewer, onApprove, onDeny, onOpen, busy }) {
  const bg = isBreakglass(request)
  const cooling = request.status === JIT_STATUS.WAITING
  const waited = waitedSeconds(raisedAt(request))
  const stale = waited >= 24 * 3600
  const duration = durationLabel(request)
  const progress = approvalProgress(request, approvals)

  // Break glass has no approvers: it is granted by waiting out a cooling off
  // period, so none of the dual control chrome applies to it and pretending
  // otherwise would misrepresent the mechanism.
  const fourEyes = !bg

  // COMPUTED FOR EVERY REQUEST, INCLUDING BREAK GLASS, and that is a fix
  // rather than a tidy-up. JITService.Approve accepts only PENDING and
  // PARTIALLY_APPROVED; a break-glass request sitting in WAITING is rejected
  // with a 409. Skipping the guard for break-glass put a live-looking Approve
  // button on the one request on this page it can never work on. Deny, by
  // contrast, DOES accept WAITING, and is the only way to stop an emergency
  // elevation before its timer runs out, so it stays enabled.
  const blockedReason = approveBlockedReason(request, approvals, viewer)
  const consequence = fourEyes ? approveConsequence(request, progress, viewer) : null

  const viewerId = viewer?.id || viewer?.user_id
  // isApproval, not a hand-rolled string compare. models.JITApproval writes
  // the decision lower case ("approved" / "denied"); comparing against
  // "APPROVE" matched nothing on the wire, so a request the viewer had
  // already approved still offered them an Approve button that the server
  // answers with a 409.
  const approverNames = (approvals || [])
    .filter(isApproval)
    .map((a) =>
      viewerId && (a.approver_user_id === viewerId || a.approver_id === viewerId)
        ? 'you'
        : a.approver_username || a.approver_user_id || 'unknown'
    )

  // The cooling-off readout has two tenses, and using one for both produced
  // "Access opens 26m ago" on any request whose window had already elapsed
  // while it sat in the queue. Whether the timer is still running is the whole
  // point of the line, so it is decided here rather than left to a relative
  // formatter that is happy to phrase the past as the future.
  const availableAt = cooling && request.available_at ? new Date(request.available_at) : null
  const availableMs = availableAt && !Number.isNaN(availableAt.getTime()) ? availableAt.getTime() : null
  const coolingOver = availableMs != null && availableMs <= Date.now()
  const coolingLabel =
    availableMs == null
      ? null
      : coolingOver
        ? `Cooling off ended ${formatRelativeToNow(request.available_at)}`
        : `Access opens ${formatRelativeToNow(request.available_at)}`

  return (
    <article
      className={clsx(
        'overflow-hidden rounded-xl border bg-surface transition-shadow hover:shadow-card',
        bg ? 'border-danger/45' : 'border-line'
      )}
    >
      {/* Break glass is the one thing on this page that is always an
          emergency, so it is the one thing that gets a filled header. */}
      {bg && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-danger/30 bg-danger-soft px-4 py-2">
          <ShieldAlert className="h-3.5 w-3.5 flex-none text-danger" strokeWidth={2} />
          <span className="text-xs font-bold uppercase tracking-wide text-danger">Break glass</span>
          <span className="text-xs text-secondary">
            {cooling
              ? 'Cooling off. Access opens on its own unless it is denied first.'
              : 'Emergency elevation, granted without a second approver.'}
          </span>
        </div>
      )}

      <div className="px-4 py-3.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-semibold text-primary">{requesterLabel(request)}</span>
          <span className="text-sm text-tertiary">requests</span>
          <button
            type="button"
            onClick={onOpen}
            title={request.resource_name || request.resource_id}
            className="min-w-0 truncate font-semibold text-primary transition-colors hover:text-accent hover:underline"
          >
            {request.resource_name || request.resource_id || 'a resource'}
          </button>
        </div>

        {/* THE JUSTIFICATION IS NOT TRUNCATED. It is the single thing an
            approver is supposed to weigh, and a clipped one line forces them
            to either open every request or approve without reading it. */}
        <p className="mt-1.5 max-w-prose whitespace-pre-line text-sm leading-relaxed text-secondary">
          {request.reason || request.justification || 'No justification was given.'}
        </p>

        {bg && request.breakglass_note && (
          <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-secondary">
            <span className="font-medium text-primary">Incident note.</span>{' '}
            {request.breakglass_note}
          </p>
        )}

        {/* The qualifying facts, one line, in the order an approver reads
            them: how much access, for how long, how long it has been sitting,
            and what ticket it hangs off. */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <span className="text-secondary">
            Window <span className="font-semibold text-primary">{duration}</span>
          </span>
          <span
            className={clsx(
              'inline-flex items-center gap-1.5',
              stale ? 'font-semibold text-warn' : 'text-secondary'
            )}
            title={formatDateTime(raisedAt(request))}
          >
            <AlarmClock className="h-3 w-3 flex-none" strokeWidth={1.9} />
            Waiting {formatDuration(waited)}
          </span>
          {coolingLabel && (
            <span className="inline-flex items-center gap-1.5 font-semibold text-danger">
              <ShieldAlert className="h-3 w-3 flex-none" strokeWidth={1.9} />
              {coolingLabel}
            </span>
          )}
          {request.ticket_ref && <span className="font-mono text-tertiary">{request.ticket_ref}</span>}
        </div>
      </div>

      {/* THE DECISION BAR.
          A footer rather than a right hand column. The column version made
          every card as tall as its tallest element and left a block of dead
          space beside two lines of justification; a footer keeps the card the
          height of its content and puts the two buttons in the one place a
          reader's eye already ends up. State on the left, action on the
          right, which is the arrangement every review surface converges on. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-t border-line-soft bg-subtle/50 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          {/* The dual control meter, but only where dual control exists. A
              break-glass request has no approvers to count, and a two segment
              meter reading "0 of 2" beside it would describe a rule that does
              not apply to it. */}
          {fourEyes && <ApprovalMeter progress={progress} />}
          {fourEyes && approverNames.length > 0 && (
            <span className="text-xs text-secondary">
              by <span className="font-medium text-primary">{approverNames.join(', ')}</span>
            </span>
          )}
          {/* What the click does, or why it cannot. Either way the approver is
              never guessing at the consequence of a one-way action. */}
          <p
            className={clsx(
              'min-w-0 flex-1 basis-full text-xs leading-relaxed sm:basis-auto',
              blockedReason ? 'text-warn' : 'text-tertiary'
            )}
          >
            {blockedReason || consequence}
          </p>
        </div>

        <div className="flex flex-none items-center gap-2">
          {/* Subtle, not ghost. A borderless ghost sitting between two bordered
              buttons reads as a caption rather than as a control. */}
          <Button size="sm" variant="subtle" onClick={onOpen}>
            Details
          </Button>
          {/* Deny stays live on a cooling-off break-glass request: the server
              accepts it, and it is the only thing that stops the elevation
              before the timer runs out. */}
          <Button size="sm" variant="dangerGhost" icon={XCircle} disabled={busy} onClick={onDeny}>
            Deny
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={CheckCircle2}
            disabled={busy || !!blockedReason}
            title={blockedReason || undefined}
            onClick={onApprove}
          >
            {fourEyes ? approveButtonLabel(request, progress, viewer) : 'Approve'}
          </Button>
        </div>
      </div>
    </article>
  )
}

// A decided request needs no decision, so it carries none of that weight: the
// same columns, with the outcome where the actions were.
function DecidedRow({ request, onOpen }) {
  const tone =
    request.status === JIT_STATUS.APPROVED ? 'ok' : request.status === JIT_STATUS.DENIED ? 'danger' : 'muted'
  return (
    <Tr>
      <Td sticky edge>
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="flex-none font-medium text-primary">{requesterLabel(request)}</span>
            <span className="flex-none text-tertiary">to</span>
            <button
              type="button"
              onClick={onOpen}
              title={request.resource_name || request.resource_id}
              className="min-w-0 truncate font-medium text-primary transition-colors hover:text-accent hover:underline"
            >
              {request.resource_name || request.resource_id || 'a resource'}
            </button>
            {isBreakglass(request) && <AlarmTag />}
          </p>
          <p
            className="mt-0.5 truncate text-xs text-tertiary"
            title={request.reason || request.justification || undefined}
          >
            {request.reason || request.justification || 'No justification given'}
          </p>
        </div>
      </Td>
      <Td>
        <Trunc value={durationLabel(request)} muted />
      </Td>
      <Td>
        <span className="text-sm text-secondary" title={formatDateTime(raisedAt(request))}>
          {formatRelativeToNow(raisedAt(request))}
        </span>
      </Td>
      <Td>
        <StatusDot tone={tone} label={JIT_STATUS_LABELS[request.status] || request.status} />
      </Td>
      <Td align="right">
        <RowActions>
          <button
            type="button"
            onClick={onOpen}
            className="whitespace-nowrap rounded px-1 py-0.5 text-sm font-semibold text-accent transition-colors hover:text-accent-hover hover:underline"
          >
            Open
          </button>
        </RowActions>
      </Td>
    </Tr>
  )
}

// ---------------------------------------------------------------------------
// The approval queue
// ---------------------------------------------------------------------------
// THE SHAPE OF THIS PAGE, AND WHY IT CHANGED.
//
// It used to be one table holding everything: three requests that needed a
// decision mixed in among expired, cancelled, denied and approved ones, sorted
// oldest first, so the rows that actually needed a human were at the BOTTOM.
// That is a log with buttons in it, not an approval surface.
//
// The page now separates the two jobs it was conflating, because they are not
// the same job and they do not want the same layout:
//
//   THE QUEUE      work to do. Cards, one request each, nothing truncated,
//                  the decision attached to the request it belongs to.
//                  Break glass pinned to the top, always.
//   THE HISTORY    a record to scan. A dense table, searchable, paginated,
//                  with no decision controls on it because there is no
//                  decision left to make.
//
// This is the same split Entra PIM draws between "Approve requests" and
// "Request history", and the same one ServiceNow draws between an approval
// record and the activity log. It is not decoration: an approver who opens
// this page should be able to answer "what needs me?" without reading, and a
// reviewer looking for last Tuesday's grant should not be scrolling past
// live decisions to find it.
const QUEUE_BATCH = 6

/** Search that works the same way over both halves of the page. */
function requestMatches(request, query) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [
    request.resource_name,
    request.resource_id,
    request.reason,
    request.justification,
    request.ticket_ref,
    requesterLabel(request),
  ].some((v) => String(v || '').toLowerCase().includes(needle))
}

// The one line of status the page leads with. It is a sentence rather than a
// row of hero numbers because there are only ever two or three facts worth
// carrying here, and three big tiles above a queue that is usually shorter
// than the tiles themselves is the pattern that makes a console read as
// unfinished.
function QueueHeadline({ count, oldest, breakglass, awaitingFirst, awaitingSecond }) {
  if (count === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <h2 className="text-sm font-semibold text-primary">
        <span className="tabular">{count}</span>{' '}
        {count === 1 ? 'request needs a decision' : 'requests need a decision'}
      </h2>
      {breakglass > 0 && (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-danger">
          <ShieldAlert className="h-3.5 w-3.5 flex-none" strokeWidth={1.9} />
          <span className="tabular">{breakglass}</span> break glass
        </span>
      )}
      {oldest > 0 && (
        <span
          className={clsx(
            'inline-flex items-center gap-1.5 text-xs',
            oldest >= 24 * 3600 ? 'font-semibold text-warn' : 'text-secondary'
          )}
        >
          <AlarmClock className="h-3.5 w-3.5 flex-none" strokeWidth={1.9} />
          longest wait {formatDuration(oldest)}
        </span>
      )}
      {/* Org-wide, from GET /admin/stats. The counts to its left are only what
          this page has loaded, so the two are labelled differently on purpose
          and never presented as the same number. */}
      {(awaitingFirst > 0 || awaitingSecond > 0) && (
        <span
          className="inline-flex items-center gap-1.5 text-xs text-tertiary"
          title="Across the whole org: awaiting a first approval, then awaiting a second"
        >
          <UsersRound className="h-3.5 w-3.5 flex-none" strokeWidth={1.9} />
          org wide <span className="tabular font-semibold text-secondary">{awaitingFirst ?? 0}</span>
          <span aria-hidden="true">›</span>
          <span className="tabular font-semibold text-accent">{awaitingSecond ?? 0}</span>
        </span>
      )}
    </div>
  )
}

function RequestsTab() {
  const [search, setSearch] = useState('')
  const [queueFilter, setQueueFilter] = useState('all')
  const [queueOrder, setQueueOrder] = useState('asc')
  const [queueShown, setQueueShown] = useState(QUEUE_BATCH)
  const [approveTarget, setApproveTarget] = useState(null)
  const [denyTarget, setDenyTarget] = useState(null)
  const [detailId, setDetailId] = useState(null)
  const queryClient = useQueryClient()

  // Who is deciding. Both halves matter: the id drives the "you already
  // approved" and "this is your own request" guards, and root changes what
  // pressing Approve will do (one click, final), which the button says.
  const user = useAuthStore((s) => s.user)
  const isRoot = useAuthStore((s) => s.isRoot())
  const viewer = useMemo(() => ({ id: viewerIdOf(user), isRoot }), [user, isRoot])

  const requestsQuery = useQuery({
    queryKey: ['admin', 'jit-requests'],
    queryFn: ({ signal }) => listJitRequests({ page: 1, page_size: PAGE_SIZE }, signal),
    // An approval queue that only moves when you reload is a queue two people
    // will double-decide. Polls while anything is undecided, stops when the
    // queue is clear.
    refetchInterval: (query) => {
      const list = query.state.data?.requests || []
      return list.some((r) => PENDING_LIKE.includes(r.status)) ? 15_000 : false
    },
    refetchOnWindowFocus: true,
  })

  const rows = useMemo(() => requestsQuery.data?.requests || [], [requestsQuery.data])

  // The org-wide queue numbers, straight from the server rather than counted
  // off whatever page happens to be loaded. Cheap, and the only honest source
  // for a total that spans pages.
  const statsQuery = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: ({ signal }) => getStats(signal),
    staleTime: 30_000,
    retry: false,
  })

  const pendingAll = useMemo(() => rows.filter((r) => PENDING_LIKE.includes(r.status)), [rows])
  const decided = useMemo(() => rows.filter((r) => !PENDING_LIKE.includes(r.status)), [rows])

  const pendingBreakglass = pendingAll.filter(isBreakglass).length
  const oldest = pendingAll.reduce((max, r) => Math.max(max, waitedSeconds(raisedAt(r))), 0)
  const awaitingSecond = pendingAll.filter((r) => r.status === JIT_STATUS.PARTIALLY_APPROVED).length

  const stats = statsQuery.data
  const awaitingFirstTotal = stats?.awaiting_first_approval
  const awaitingSecondTotal = stats?.awaiting_second_approval

  // ---- four-eyes trail hydration -----------------------------------------
  // Only PARTIALLY_APPROVED requests have a trail worth reading. A PENDING
  // one has no approvals by definition, so fetching it would buy nothing.
  //
  // Hydrated from the WHOLE pending set rather than from the cards currently
  // on screen, and that ordering is deliberate: the "needs my decision"
  // filter and its count both have to know whether this viewer is already on
  // a request's trail, and deriving the trails from the visible slice would
  // make the filter depend on the very list the filter produces. Bounded by
  // TRAIL_HYDRATION_LIMIT, and the partially-approved set is small by nature,
  // so this is a handful of requests, not one per row.
  const trailIds = useMemo(
    () =>
      pendingAll
        .filter((r) => r.status === JIT_STATUS.PARTIALLY_APPROVED)
        .slice(0, TRAIL_HYDRATION_LIMIT)
        .map((r) => r.id),
    [pendingAll]
  )

  const trailQueries = useQueries({
    queries: trailIds.map((id) => ({
      queryKey: ['admin', 'jit-request', id],
      queryFn: ({ signal }) => getJitRequest(id, signal),
      staleTime: 15_000,
      // A failed hydration must not break the queue: no trail simply means
      // the guards stay off and the server answers instead.
      retry: false,
    })),
  })

  const trailsById = useMemo(() => {
    const out = {}
    trailIds.forEach((id, i) => {
      const data = trailQueries[i]?.data
      if (data) out[id] = approvalsOf(data)
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trailIds, trailQueries.map((q) => q.dataUpdatedAt).join(',')])

  /**
   * Can this viewer act on this request right now.
   *
   * The trail is passed in wherever it has loaded, so the guard catches all
   * three blocking cases rather than two: a request the viewer raised, one
   * they have already approved, and a break-glass request still cooling off
   * (JITService.Approve rejects WAITING outright). The server stays the
   * authority; this only decides what is worth showing.
   */
  const actionable = (request) => !approveBlockedReason(request, trailsById[request.id] ?? null, viewer)

  // ---- the queue ----------------------------------------------------------
  // Break glass is pinned to the top regardless of the order control. It is
  // an emergency grant that is already ticking through its cooling off
  // period, so burying it under an hour of ordinary requests is the one
  // ordering this page must never produce.
  const queueSorted = useMemo(() => {
    const list = pendingAll.filter((r) => requestMatches(r, search))
    return list.sort((a, b) => {
      const emergency = Number(isBreakglass(b)) - Number(isBreakglass(a))
      if (emergency !== 0) return emergency
      const ta = new Date(raisedAt(a) || 0).getTime() || 0
      const tb = new Date(raisedAt(b) || 0).getTime() || 0
      return queueOrder === 'desc' ? tb - ta : ta - tb
    })
  }, [pendingAll, search, queueOrder])

  const mineCount = queueSorted.filter(actionable).length

  const queue = useMemo(() => {
    if (queueFilter === 'second') return queueSorted.filter((r) => r.status === JIT_STATUS.PARTIALLY_APPROVED)
    if (queueFilter === 'mine') return queueSorted.filter(actionable)
    return queueSorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueSorted, queueFilter, viewer, trailsById])

  const queueVisible = queue.slice(0, queueShown)
  const queueRemaining = Math.max(0, queue.length - queueVisible.length)

  // Reset the reveal whenever the queue is re-cut, otherwise a filter that
  // returns four results still claims to be hiding some.
  useEffect(() => {
    setQueueShown(QUEUE_BATCH)
  }, [queueFilter, queueOrder, search])

  const queueFacets = useMemo(
    () => [
      { key: 'all', label: 'All', count: queueSorted.length },
      { key: 'mine', label: 'Needs my decision', count: mineCount },
      // Its own facet, not folded into the rest: a request that already has
      // one approval is a single click from live access, which makes it the
      // fastest thing in the queue to clear.
      ...(awaitingSecond > 0
        ? [
            {
              key: 'second',
              label: 'Needs 2nd approval',
              count: queueSorted.filter((r) => r.status === JIT_STATUS.PARTIALLY_APPROVED).length,
            },
          ]
        : []),
    ],
    [queueSorted, mineCount, awaitingSecond]
  )


  // ---- the history --------------------------------------------------------
  const table = useTableState({
    rows: decided,
    storageKey: 'jit-approvals',
    rowId: (r) => r.id,
    // `requested_at` is models.JITRequest's own "when was this raised"
    // column; `created_at` is the row's audit column and is only a fallback.
    initialSort: { key: 'requested_at', dir: 'desc' }, // a log reads newest first
    initialPageSize: 25,
    initialFilters: { status: 'all' },
    searchFields: ['resource_name', 'reason', requesterLabel],
    filterFn: (r, f) => (f.status === 'all' ? true : r.status === f.status),
    // THE ORDERING FIX. Two things were wrong and both are handled here.
    //
    //   1. Time was compared as TEXT. Go emits RFC3339 with variable-length
    //      fractional seconds, and the string comparator's `numeric: true`
    //      option read ".123456789" and ".5" as the numbers 123456789 and 5,
    //      so same-second rows came out backwards. Returning an epoch number
    //      makes the comparator take its numeric path instead.
    //   2. The key could miss the field. A stored preference from before this
    //      change still says `created_at`, so BOTH time keys resolve to the
    //      same value rather than one of them silently returning undefined
    //      for every row (which sorts everything equal, exactly the "nothing
    //      happens when I click it" symptom).
    sortAccessor: (r, key) => {
      if (key === 'requester') return requesterLabel(r)
      if (key === 'requested_at' || key === 'created_at') {
        const t = new Date(raisedAt(r) || 0).getTime()
        return Number.isNaN(t) ? null : t
      }
      return r[key]
    },
  })

  useEffect(() => {
    table.setQuery(search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const historyFacets = useMemo(() => {
    const seen = [...new Set(decided.map((r) => r.status))].sort()
    return [
      { key: 'all', label: 'All', count: decided.length },
      ...seen.map((s) => ({
        key: s,
        label: JIT_STATUS_LABELS[s] || s,
        count: decided.filter((r) => r.status === s).length,
      })),
    ]
  }, [decided])

  // A stored filter from the old single-table layout can name a status that
  // no longer exists in this control ("pending", or a decided status that is
  // not on this page). Left alone it shows an empty history with no selected
  // segment and no way back.
  useEffect(() => {
    if (!historyFacets.some((f) => f.key === table.filters.status)) table.setFilter('status', 'all')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyFacets])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'jit-requests'] })
    queryClient.invalidateQueries({ queryKey: ['admin', 'jit-request'] })
    queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] })
  }

  const approveMutation = useMutation({
    mutationFn: ({ id, reason }) => approveJitRequest(id, reason),
    // TWO SHAPES, TWO MESSAGES. A first approval issues nothing; saying
    // "Request approved" there would tell an approver access exists when it
    // does not, the exact failure four-eyes is meant to prevent.
    onSuccess: (data) => {
      const result = readApproveResult(data)
      if (result.partial) {
        toast.success(approveResultMessage(result), {
          description:
            userFacingNext(result.next) ||
            'A second, different admin, or root, must approve to issue the grant.',
        })
      } else {
        toast.success(approveResultMessage(result), {
          description: result.expiresAt ? `Access expires ${formatDateTime(result.expiresAt)}` : undefined,
        })
        queryClient.invalidateQueries({ queryKey: ['admin', 'grants'] })
      }
      setApproveTarget(null)
      invalidate()
    },
    onError: (err) => {
      toast.error(approvalErrorMessage(err, apiErrorMessage(err)))
      setApproveTarget(null)
      // A 409 means someone else moved first. Re-read rather than leaving a
      // stale card on screen inviting the same click again.
      if (isStaleStateError(err)) invalidate()
    },
  })

  const denyMutation = useMutation({
    mutationFn: ({ id, reason }) => denyJitRequest(id, reason),
    // Deny is single-person by design, one denial ends the request, no
    // second opinion required.
    onSuccess: () => {
      toast.success('Request denied')
      setDenyTarget(null)
      invalidate()
    },
    onError: (err) => {
      toast.error(approvalErrorMessage(err, apiErrorMessage(err)))
      setDenyTarget(null)
      if (isStaleStateError(err)) invalidate()
    },
  })

  const busy = approveMutation.isPending || denyMutation.isPending

  const searching = search.trim().length > 0

  return (
    <>
      <div className="space-y-5">
        {/* ---- the queue ---------------------------------------------- */}
        <section aria-label="Requests awaiting a decision" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <QueueHeadline
              count={pendingAll.length}
              oldest={oldest}
              breakglass={pendingBreakglass}
              awaitingFirst={awaitingFirstTotal}
              awaitingSecond={awaitingSecondTotal}
            />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder="Search requester, resource or reason"
                className="min-w-[14rem] sm:max-w-xs"
              />
              <RefreshControl
                onRefresh={() => requestsQuery.refetch()}
                isFetching={requestsQuery.isFetching}
                updatedAt={requestsQuery.dataUpdatedAt}
              />
            </div>
          </div>

          {pendingAll.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                size="sm"
                ariaLabel="Filter the queue"
                value={queueFilter}
                onChange={setQueueFilter}
                options={queueFacets}
              />
              {/* ORDER CONTROL. Oldest first is right for working through a
                  backlog and wrong for seeing what just came in, and it was
                  previously not changeable at all. Two explicit options
                  rather than a click-cycling header, because a card list has
                  no header row and there is only one thing here worth
                  ordering by. */}
              <SegmentedControl
                size="sm"
                ariaLabel="Order the queue"
                value={queueOrder}
                onChange={setQueueOrder}
                options={[
                  { key: 'asc', label: 'Oldest first' },
                  { key: 'desc', label: 'Newest first' },
                ]}
              />
            </div>
          )}

          <QueryState
            query={requestsQuery}
            empty={() => false}
            emptyTitle="No JIT requests"
            emptyMessage="Access requests from across the org land here for approval."
          >
            {() =>
              queue.length === 0 ? (
                <Card className="!p-0">
                  <EmptyState
                    icon={pendingAll.length === 0 ? CheckCircle2 : SearchX}
                    title={
                      pendingAll.length === 0
                        ? 'Queue clear, nothing awaiting a decision'
                        : 'Nothing in the queue matches'
                    }
                    description={
                      pendingAll.length === 0
                        ? 'Every access request has been decided. New requests appear here the moment they are raised.'
                        : `${pendingAll.length} ${pendingAll.length === 1 ? 'request is' : 'requests are'} awaiting a decision, but none match the current search or filter.`
                    }
                    action={
                      pendingAll.length > 0 && (
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setSearch('')
                            setQueueFilter('all')
                          }}
                        >
                          Show the whole queue
                        </Button>
                      )
                    }
                  />
                </Card>
              ) : (
                <div className="space-y-3">
                  {queueVisible.map((r) => (
                    <DecisionCard
                      key={r.id}
                      request={r}
                      approvals={trailsById[r.id] ?? null}
                      viewer={viewer}
                      busy={busy}
                      onApprove={() => setApproveTarget(r)}
                      onDeny={() => setDenyTarget(r)}
                      onOpen={() => setDetailId(r.id)}
                    />
                  ))}
                  {/* Revealed in batches rather than paginated. A queue is
                      worked from the top down, and a page control would let
                      an approver leave page two undecided without ever
                      seeing it. The count says exactly what is still
                      hidden. */}
                  {queueRemaining > 0 && (
                    <Button
                      variant="secondary"
                      className="w-full"
                      onClick={() => setQueueShown((n) => n + QUEUE_BATCH)}
                    >
                      Show {Math.min(QUEUE_BATCH, queueRemaining)} more, {queueRemaining} still hidden
                    </Button>
                  )}
                </div>
              )
            }
          </QueryState>
        </section>

        {/* ---- the history -------------------------------------------- */}
        {decided.length > 0 && (
          <section aria-label="Decided requests" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-t border-line-soft pt-5">
              <div>
                <h2 className="text-sm font-semibold text-primary">Decided</h2>
                <p className="mt-0.5 text-xs text-secondary">
                  Approved, denied, cancelled and expired requests. Nothing here needs a decision.
                </p>
              </div>
              <SegmentedControl
                size="sm"
                ariaLabel="Filter decided requests"
                value={table.filters.status}
                onChange={(v) => {
                  table.setFilter('status', v)
                  table.setPage(1)
                }}
                options={historyFacets}
              />
            </div>

            <ListPanel>
              {table.total === 0 ? (
                <EmptyState
                  icon={SearchX}
                  title="Nothing matches these filters"
                  description={
                    searching
                      ? `No decided request matches "${search.trim()}".`
                      : 'No decided request matches the current status selection.'
                  }
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSearch('')
                        table.setFilter('status', 'all')
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <>
                  <DataTable minWidth="52rem">
                    <colgroup>
                      <col className="w-[26rem] min-w-[16rem]" />
                      <col className="w-[8rem]" />
                      <col className="w-[9rem]" />
                      <col className="w-[11rem]" />
                      <col className="w-[7rem]" />
                    </colgroup>
                    <thead>
                      <tr>
                        <Th sticky edge>
                          Request
                        </Th>
                        <Th>Window</Th>
                        {/* SortHeader renders its own th. */}
                        <SortHeader
                          label="Raised"
                          columnKey="requested_at"
                          sort={table.sort}
                          onSort={(key) => {
                            table.toggleSort(key)
                            table.setPage(1)
                          }}
                        />
                        <Th>Outcome</Th>
                        <Th align="right">
                          <span className="sr-only">Actions</span>
                        </Th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.pageRows.map((r) => (
                        <DecidedRow key={r.id} request={r} onOpen={() => setDetailId(r.id)} />
                      ))}
                    </tbody>
                  </DataTable>
                  <Pagination
                    page={table.page}
                    pageSize={table.pageSize}
                    total={table.total}
                    totalPages={table.totalPages}
                    onPageChange={table.setPage}
                    onPageSizeChange={table.setPageSize}
                    label="requests"
                  />
                </>
              )}
            </ListPanel>
          </section>
        )}
      </div>

      <RequestDetailDrawer id={detailId} onClose={() => setDetailId(null)} viewerId={viewer.id} />

      <ConfirmDialog
        open={!!approveTarget}
        title={`Approve access to "${approveTarget?.resource_name || approveTarget?.resource_id || 'this resource'}"?`}
        // Says what THIS click does, which is now one of two different things.
        // A dialog that promised a grant before the second approval would be
        // the most expensive sentence on the screen.
        description={
          approveTarget && isBreakglass(approveTarget)
            ? 'This is a break-glass request: approving grants emergency privileged access immediately and raises a critical audit event. Separation-of-duty rules apply, you cannot approve your own request.'
            : approveConsequence(
                approveTarget,
                approvalProgress(approveTarget, trailsById[approveTarget?.id] ?? null),
                viewer
              )
        }
        confirmLabel={
          approveTarget && isBreakglass(approveTarget)
            ? 'Approve request'
            : approveButtonLabel(
                approveTarget,
                approvalProgress(approveTarget, trailsById[approveTarget?.id] ?? null),
                viewer
              )
        }
        reasonLabel="Approval note (optional, stored on the audit record)"
        isLoading={approveMutation.isPending}
        onConfirm={(reason) => approveMutation.mutate({ id: approveTarget.id, reason })}
        onCancel={() => setApproveTarget(null)}
      />

      <ConfirmDialog
        open={!!denyTarget}
        title={`Deny access to "${denyTarget?.resource_name || denyTarget?.resource_id || 'this resource'}"?`}
        description="One denial ends this request, unlike approval, it does not wait for a second person. The requester will need to raise a new one if access is still needed."
        confirmLabel="Deny request"
        destructive
        requireReason
        reasonLabel="Reason for denial (required for the audit record)"
        isLoading={denyMutation.isPending}
        onConfirm={(reason) => denyMutation.mutate({ id: denyTarget.id, reason })}
        onCancel={() => setDenyTarget(null)}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

const EXPIRING_SOON_SEC = 60 * 60

function expiresInSeconds(g) {
  if (!g?.expires_at) return null
  return (new Date(g.expires_at).getTime() - Date.now()) / 1000
}

function GrantsTab() {
  const [search, setSearch] = useState('')
  const [revokeTarget, setRevokeTarget] = useState(null)
  const queryClient = useQueryClient()

  const grantsQuery = useQuery({
    queryKey: ['admin', 'grants'],
    queryFn: ({ signal }) => listGrants({ page: 1, page_size: PAGE_SIZE }, signal),
  })

  const rows = useMemo(() => grantsQuery.data?.grants || [], [grantsQuery.data])

  const table = useTableState({
    rows,
    storageKey: 'jit-grants',
    rowId: (g) => g.id,
    initialSort: { key: 'expires_at', dir: 'asc' },
    initialPageSize: 25,
    initialFilters: { status: GRANT_STATUS.ACTIVE, expiring: false },
    searchFields: ['resource_name', requesterLabel],
    filterFn: (g, f) => {
      if (f.status !== 'all' && g.status !== f.status) return false
      if (f.expiring) {
        const secs = expiresInSeconds(g)
        if (secs === null || secs > EXPIRING_SOON_SEC || secs < 0) return false
      }
      return true
    },
    sortAccessor: (g, key) => {
      if (key === 'holder') return requesterLabel(g)
      if (key === 'granted_at' || key === 'created_at') {
        const t = new Date(grantedAt(g) || 0).getTime()
        return Number.isNaN(t) ? null : t
      }
      return g[key]
    },
  })

  useEffect(() => {
    table.setQuery(search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const revokeMutation = useMutation({
    mutationFn: ({ id, reason }) => revokeGrant(id, reason),
    onSuccess: (result) => {
      const killed = result?.sessions_killed
      toast.success(
        typeof killed === 'number'
          ? `Grant revoked, ${killed} session${killed === 1 ? '' : 's'} killed`
          : 'Grant revoked'
      )
      setRevokeTarget(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'grants'] })
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setRevokeTarget(null)
    },
  })

  const facets = useMemo(() => {
    const seen = [...new Set(rows.map((g) => g.status))].sort()
    return [
      ...seen.map((s) => ({
        key: s,
        label: s.charAt(0) + s.slice(1).toLowerCase(),
        count: rows.filter((g) => g.status === s).length,
      })),
      { key: 'all', label: 'All', count: rows.length },
    ]
  }, [rows])

  const pad = table.density === 'compact' ? 'py-2' : 'py-3'

  return (
    <>
      <ListPanel
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="Search holder or resource…"
              className="min-w-[14rem] sm:max-w-xs"
            />
            {facets.length > 1 && (
              <SegmentedControl
                size="sm"
                ariaLabel="Filter grants by status"
                value={table.filters.status}
                onChange={(v) => table.setFilter('status', v)}
                options={facets}
              />
            )}
            {/* An elevation about to lapse is the one thing on this tab worth a
 dedicated control, everything else can wait for a sort. */}
            <FilterToggle
              checked={table.filters.expiring}
              onChange={(v) => table.setFilter('expiring', v)}
              label="Expiring within an hour"
            />
            <span className="ml-auto">
              <RefreshControl
                onRefresh={() => grantsQuery.refetch()}
                isFetching={grantsQuery.isFetching}
                updatedAt={grantsQuery.dataUpdatedAt}
              />
            </span>
          </div>
        }
      >
        <QueryState
          query={grantsQuery}
          empty={(d) => !d?.grants || d.grants.length === 0}
          emptyTitle="No grants"
          emptyMessage="Approved requests become grants, time-boxed elevation that expires on its own."
        >
          {() =>
            table.total === 0 ? (
              <Card>
                <EmptyState
                  icon={SearchX}
                  title="No grants match these filters"
                  description="Try clearing the status facet or the expiry filter."
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSearch('')
                        table.resetFilters()
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              </Card>
            ) : (
              <>
                <div className="relative overflow-x-auto overscroll-x-contain">
                  <table className="w-full min-w-[52rem] table-fixed border-separate border-spacing-0 text-sm">
                    <colgroup>
                      <col className={COL.name} />
                      <col className={COL.medium} />
                      <col className={COL.timestamp} />
                      <col className={COL.medium} />
                      <col className={COL.status} />
                      <col className={COL.actions} />
                    </colgroup>
                    <thead>
                      <tr>
                        <SortHeader
                          label="Resource"
                          columnKey="resource_name"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="sticky top-0 z-20 border-b border-surface-800 bg-surface-850"
                        />
                        <SortHeader
                          label="Holder"
                          columnKey="holder"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="sticky top-0 z-20 border-b border-surface-800 bg-surface-850"
                        />
                        <SortHeader
                          label="Granted"
                          columnKey="granted_at"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="sticky top-0 z-20 border-b border-surface-800 bg-surface-850"
                        />
                        <SortHeader
                          label="Expires"
                          columnKey="expires_at"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="sticky top-0 z-20 border-b border-surface-800 bg-surface-850"
                        />
                        <SortHeader
                          label="Status"
                          columnKey="status"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="sticky top-0 z-20 border-b border-surface-800 bg-surface-850"
                        />
                        <SortHeader
                          label="Actions"
                          columnKey="_actions"
                          srOnly
                          className="sticky top-0 z-20 border-b border-surface-800 bg-surface-850"
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {table.pageRows.map((g) => {
                        const secs = expiresInSeconds(g)
                        const soon =
                          g.status === GRANT_STATUS.ACTIVE &&
                          secs !== null &&
                          secs > 0 &&
                          secs <= EXPIRING_SOON_SEC
                        return (
                          <tr key={g.id} className="group">
                            <td className={clsx(cell({}), 'px-4', pad)}>
                              <div className="flex min-w-0 items-center gap-2.5">
                                <Lock className="h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
                                <TruncCell
                                  value={g.resource_name || g.resource_id}
                                  className="font-medium text-ink-50"
                                />
                              </div>
                            </td>
                            <td className={clsx(cell({}), 'px-4', pad)}>
                              <TruncCell value={requesterLabel(g)} className="text-ink-300" />
                            </td>
                            <td className={clsx(cell({}), 'px-4 text-xs tabular-nums text-ink-400', pad)}>
                              <span title={formatDateTime(grantedAt(g))}>
                                {formatRelativeToNow(grantedAt(g))}
                              </span>
                            </td>
                            <td className={clsx(cell({}), 'px-4 text-xs tabular-nums', pad)}>
                              {g.expires_at ? (
                                <span
                                  className={clsx(
                                    soon ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-ink-400'
                                  )}
                                  title={formatDateTime(g.expires_at)}
                                >
                                  {secs > 0
                                    ? `in ${formatDuration(secs)}`
                                    : formatRelativeToNow(g.expires_at)}
                                </span>
                              ) : (
                                <span className="text-ink-500">-</span>
                              )}
                            </td>
                            <td className={clsx(cell({}), 'px-4', pad)}>
                              {g.status === GRANT_STATUS.REVOKED ? (
                                <Badge className={GRANT_STATUS_BADGE.REVOKED}>Revoked</Badge>
                              ) : (
                                <StatusIndicator
                                  tone={g.status === GRANT_STATUS.ACTIVE ? 'emerald' : 'neutral'}
                                >
                                  {g.status.charAt(0) + g.status.slice(1).toLowerCase()}
                                </StatusIndicator>
                              )}
                            </td>
                            <td className={clsx(cell({}), 'px-2', pad)}>
                              <div className="flex items-center justify-end">
                                {g.status === GRANT_STATUS.ACTIVE && (
                                  <Button
                                    size="xs"
                                    variant="dangerGhost"
                                    onClick={() => setRevokeTarget(g)}
                                    disabled={revokeMutation.isPending}
                                  >
                                    Revoke
                                  </Button>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  page={table.page}
                  pageSize={table.pageSize}
                  total={table.total}
                  totalPages={table.totalPages}
                  onPageChange={table.setPage}
                  onPageSizeChange={table.setPageSize}
                  label="grants"
                />
              </>
            )
          }
        </QueryState>
      </ListPanel>

      <ConfirmDialog
        open={!!revokeTarget}
        title={`Revoke grant on "${revokeTarget?.resource_name || revokeTarget?.resource_id || 'this resource'}"?`}
        description="This immediately revokes access and kills any active session using this grant."
        confirmLabel="Revoke grant"
        destructive
        requireReason
        reasonLabel="Reason (required for the audit record)"
        isLoading={revokeMutation.isPending}
        onConfirm={(reason) => revokeMutation.mutate({ id: revokeTarget.id, reason })}
        onCancel={() => setRevokeTarget(null)}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Break-glass
// ---------------------------------------------------------------------------

function BreakglassReportDrawer({ grantId, onClose }) {
  const reportQuery = useQuery({
    queryKey: ['admin', 'breakglass', 'report', grantId],
    queryFn: ({ signal }) => getBreakglassReport(grantId, signal),
    enabled: !!grantId,
  })

  const report = reportQuery.data

  // The report's exact field set isn't pinned down on this endpoint, so it is
  // rendered defensively: keys become readable labels, objects fall back to
  // JSON rather than crashing on a React child that isn't a string.
  const items = report
    ? Object.entries(report).map(([key, value]) => ({
        label: key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        value:
          value === null || value === undefined ? (
            '-'
          ) : typeof value === 'object' ? (
            <span className="font-mono text-xs">{JSON.stringify(value)}</span>
          ) : (
            String(value)
          ),
      }))
    : []

  return (
    <Drawer
      open={!!grantId}
      onClose={onClose}
      title="Break-glass report"
      subtitle="Post-incident record for an emergency elevation"
      icon={FileText}
    >
      {reportQuery.isLoading && (
        <div className="flex items-center justify-center gap-2 py-12 text-ink-400">
          <Spinner /> <span className="text-sm">Loading report…</span>
        </div>
      )}
      {reportQuery.isError && (
        <p className="px-4 py-6 text-sm text-red-700 dark:text-red-300">
          {apiErrorMessage(reportQuery.error)}
        </p>
      )}
      {reportQuery.isSuccess && items.length > 0 && <DetailList items={items} />}
      {reportQuery.isSuccess && items.length === 0 && (
        <EmptyState
          icon={FileText}
          title="No report data"
          description="The server returned no report for this grant."
        />
      )}
    </Drawer>
  )
}

function BreakglassTab() {
  const [reportTarget, setReportTarget] = useState(null)

  const query = useQuery({
    queryKey: ['admin', 'breakglass'],
    queryFn: ({ signal }) => listBreakglass({ page: 1, page_size: PAGE_SIZE }, signal),
  })

  const rows = query.data?.requests || []

  return (
    <>
      <div className="mb-5 flex items-start gap-3 rounded-xl border border-red-300/60 bg-red-50/70 px-4 py-3 dark:border-red-900/40 dark:bg-red-950/20">
        <ShieldAlert className="mt-0.5 h-4 w-4 flex-none text-red-600 dark:text-red-400" strokeWidth={1.75} />
        <p className="text-sm leading-relaxed text-red-800 dark:text-red-200">
          Break-glass bypasses the normal approval path after a waiting period. Every use is expected to be
          reviewed , open each report and confirm the justification matches what actually happened.
        </p>
      </div>

      <QueryState
        query={query}
        empty={(d) => !d?.requests || d.requests.length === 0}
        emptyTitle="No break-glass requests"
        emptyMessage="Emergency access has never been invoked in this install."
      >
        {() => (
          <Card className="overflow-hidden">
            <ul>
              {rows.map((r) => (
                <li
                  key={r.id}
                  className="relative flex items-center justify-between gap-4 border-b border-surface-800 px-4 py-3.5 pl-5 last:border-b-0 hover:bg-surface-850/60"
                >
                  <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-red-500" />
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar name={requesterLabel(r)} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate text-sm">
                        <span className="font-semibold text-ink-50">{requesterLabel(r)}</span>
                        <span className="text-ink-500"> invoked emergency access to </span>
                        <span className="font-medium text-ink-100">
                          {r.resource_name || r.resource_id || '-'}
                        </span>
                      </p>
                      <p className="mt-0.5 truncate text-xs text-ink-500" title={r.reason || undefined}>
                        {formatRelativeToNow(raisedAt(r))}
                        {r.reason ? ` · ${r.reason}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-none items-center gap-2">
                    <Badge
                      className={JIT_STATUS_BADGE[r.status] || 'bg-ink-500/10 text-ink-400 ring-ink-500/25'}
                    >
                      {JIT_STATUS_LABELS[r.status] || r.status}
                    </Badge>
                    <Button
                      size="xs"
                      variant="secondary"
                      icon={FileText}
                      onClick={() => setReportTarget(r.grant_id || r.id)}
                    >
                      Report
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </QueryState>

      <BreakglassReportDrawer grantId={reportTarget} onClose={() => setReportTarget(null)} />
    </>
  )
}

export default function AdminJitPage() {
  const [tab, setTab] = useState('requests')

  return (
    <div>
      <PageHeader
        eyebrow="Admin Center"
        title="JIT Approvals"
        description="Decide access requests from across the org, manage the grants they produce, and review every break-glass elevation."
      />

      <div className="mb-5">
        <TabBar tabs={TABS} active={tab} onChange={setTab} />
      </div>

      {tab === 'requests' && <RequestsTab />}
      {tab === 'grants' && <GrantsTab />}
      {tab === 'breakglass' && <BreakglassTab />}
    </div>
  )
}
