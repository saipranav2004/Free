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
  Clock3,
  Hourglass,
  SearchX,
  FileText,
  ChevronRight,
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
import { PageHeader, Card, EmptyState, DetailList, ListPanel } from '../../components/common/Layout'
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
  approveBlockedReason,
  approveButtonLabel,
  approveConsequence,
  readApproveResult,
  approveResultMessage,
  approvalErrorMessage,
  isStaleStateError,
  viewerIdOf,
} from '../../lib/fourEyes'
import { ApprovalProgress, ApprovalTrail, ApproverStack } from '../../components/jit/ApprovalTrail'
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
  return mins >= 60 ? `${(mins / 60).toFixed(mins % 60 === 0 ? 0 : 1)}h access` : `${mins}m access`
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
              <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.11em] text-ink-500">
                Justification
              </p>
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
              <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.11em] text-ink-500">
                Resulting grant
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={GRANT_STATUS_BADGE[grant.status]}>{grant.status}</Badge>
                {grant.expires_at && <MetaTag>Expires {formatDateTime(grant.expires_at)}</MetaTag>}
              </div>
            </div>
          )}
          {!isBreakglass(request) && (
            <div className="border-t border-surface-800 py-4">
              <div className="mb-1 flex flex-wrap items-center gap-3 px-4">
                <p className="text-2xs font-semibold uppercase tracking-[0.11em] text-ink-500">
                  Four-eyes approvals
                </p>
                <ApprovalProgress request={request} approvals={approvals} className="ml-auto" />
              </div>
              <ApprovalTrail request={request} approvals={approvals} viewerId={viewerId} />
            </div>
          )}

          {Array.isArray(trail) && trail.length > 0 && (
            <div className="border-t border-surface-800 px-4 py-4">
              <p className="mb-3 text-2xs font-semibold uppercase tracking-[0.11em] text-ink-500">
                Audit trail
              </p>
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
function DecisionCard({ request, approvals, viewer, onApprove, onDeny, onOpen, busy }) {
  const bg = isBreakglass(request)
  const waited = waitedSeconds(raisedAt(request))
  const stale = waited >= 24 * 3600
  const duration = durationLabel(request)
  const partial = request.status === JIT_STATUS.PARTIALLY_APPROVED
  const progress = approvalProgress(request, approvals)

  // Break-glass has no approvers, it is granted by waiting it out, not by
  // deciding it, so none of the four-eyes chrome applies to it.
  const fourEyes = !bg
  const blockedReason = fourEyes ? approveBlockedReason(request, approvals, viewer) : null

  return (
    <li
      className={clsx(
        'relative flex flex-col gap-4 border-b border-surface-800 px-4 py-4 pl-5 transition-colors last:border-b-0 hover:bg-surface-850/60 lg:flex-row lg:items-start',
        bg && 'bg-red-50/40 dark:bg-red-950/10'
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'absolute inset-y-0 left-0 w-[3px]',
          bg ? 'bg-red-500' : partial ? 'bg-blue-500' : stale ? 'bg-amber-500' : 'bg-blue-500/50'
        )}
      />

      <div className="flex min-w-0 flex-1 gap-3.5">
        <Avatar name={requesterLabel(request)} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-semibold text-ink-50">{requesterLabel(request)}</span>
            <span className="text-ink-500">requests access to</span>
            <button
              type="button"
              onClick={onOpen}
              className="max-w-full truncate font-semibold text-ink-50 underline decoration-surface-600 underline-offset-4 transition-colors hover:text-blue-600 dark:hover:text-blue-300"
            >
              {request.resource_name || request.resource_id || 'a resource'}
            </button>
            {bg && (
              <Badge
                className="bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30"
                dot
              >
                Break-glass
              </Badge>
            )}
            {partial && (
              <Badge className={JIT_STATUS_BADGE.PARTIALLY_APPROVED} dot>
                Needs 2nd approval
              </Badge>
            )}
          </p>

          {request.reason ? (
            <blockquote className="mt-2.5 border-l-2 border-surface-700 pl-3 text-sm leading-relaxed text-ink-300">
              {request.reason}
            </blockquote>
          ) : (
            <p className="mt-2.5 text-sm italic text-ink-500">No justification given.</p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-500">
            <span className="inline-flex items-center gap-1.5" title={formatDateTime(raisedAt(request))}>
              <Clock3 className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
              Requested {formatRelativeToNow(raisedAt(request))}
            </span>
            <span
              className={clsx(
                'inline-flex items-center gap-1.5 font-medium tabular-nums',
                stale ? 'text-amber-600 dark:text-amber-400' : 'text-ink-400'
              )}
            >
              <Hourglass className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
              Waiting {formatDuration(waited)}
            </span>
            {duration && <MetaTag>{duration}</MetaTag>}
            {request.status === JIT_STATUS.WAITING && (
              <StatusIndicator tone="amber">Cooling-off period</StatusIndicator>
            )}
            {fourEyes && <ApprovalProgress request={request} approvals={approvals} />}
            <ApproverStack approvals={approvals} viewerId={viewer?.id} />
          </div>

          {/* Said in words, not only in a disabled button: an approver who
 cannot see WHY the button is dead will click it, get a 409, and
 conclude the console is broken. */}
          {blockedReason && (
            <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-md bg-surface-850 px-2.5 py-1.5 text-xs text-ink-400 ring-1 ring-inset ring-surface-700">
              <UsersRound className="h-3.5 w-3.5 flex-none" strokeWidth={1.9} />
              {blockedReason}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-none items-center gap-2 lg:pt-1">
        <Button
          variant="primary"
          size="sm"
          icon={CheckCircle2}
          onClick={onApprove}
          disabled={busy || !!blockedReason}
          title={blockedReason || undefined}
        >
          {fourEyes ? approveButtonLabel(request, progress, viewer) : 'Approve'}
        </Button>
        <Button variant="dangerGhost" size="sm" icon={XCircle} onClick={onDeny} disabled={busy}>
          Deny
        </Button>
        <button
          type="button"
          onClick={onOpen}
          aria-label="Open request details"
          className="flex h-8 w-8 flex-none items-center justify-center rounded-md text-ink-600 transition-colors hover:bg-surface-800 hover:text-ink-100"
        >
          <ChevronRight className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </li>
  )
}

// A decided request needs no decision, so it gets none of that weight.
function DecidedRow({ request, onOpen }) {
  return (
    <li className="flex items-center justify-between gap-4 border-b border-surface-800 px-4 py-3 last:border-b-0 hover:bg-surface-850/60">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={requesterLabel(request)} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm text-ink-200">
            <span className="font-medium text-ink-100">{requesterLabel(request)}</span> ·{' '}
            {request.resource_name || request.resource_id || '-'}
          </p>
          <p className="mt-0.5 truncate text-xs text-ink-500" title={request.reason || undefined}>
            {formatRelativeToNow(raisedAt(request))}
            {request.reason ? ` · ${request.reason}` : ''}
          </p>
        </div>
      </div>
      <div className="flex flex-none items-center gap-2">
        <Badge className={JIT_STATUS_BADGE[request.status] || 'bg-ink-500/10 text-ink-400 ring-ink-500/25'}>
          {JIT_STATUS_LABELS[request.status] || request.status}
        </Badge>
        <button
          type="button"
          onClick={onOpen}
          aria-label="Open request details"
          className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-ink-600 transition-colors hover:bg-surface-800 hover:text-ink-100"
        >
          <ChevronRight className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </li>
  )
}

function RequestsTab() {
  const [search, setSearch] = useState('')
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

  // The three queue numbers, straight from the server rather than counted off
  // whatever page happens to be loaded. Cheap, and the only honest source for
  // a total that spans pages.
  const statsQuery = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: ({ signal }) => getStats(signal),
    staleTime: 30_000,
    retry: false,
  })

  const table = useTableState({
    rows,
    storageKey: 'jit-approvals',
    rowId: (r) => r.id,
    // `requested_at` is models.JITRequest's own "when was this raised"
    // column; `created_at` is the row's audit column and is only a fallback.
    initialSort: { key: 'requested_at', dir: 'asc' }, // oldest first: a queue, not a feed
    initialPageSize: 25,
    initialFilters: { status: 'all' },
    searchFields: ['resource_name', 'reason', requesterLabel],
    filterFn: (r, f) => {
      if (f.status === 'pending') return PENDING_LIKE.includes(r.status)
      if (f.status === 'all') return true
      return r.status === f.status
    },
    // THE ORDERING FIX. Two things were wrong and both are handled here.
    //
    //   1. Time was compared as TEXT. Go emits RFC3339 with variable-length
    // fractional seconds, and the string comparator's `numeric: true`
    // option read ".123456789" and ".5" as the numbers 123456789 and 5
    //     , so same-second rows came out backwards. Returning an epoch
    // number makes the comparator take its numeric path instead.
    //   2. The key could miss the field. A stored preference from before
    // this change still says `created_at`, so BOTH time keys resolve to
    // the same value rather than one of them silently returning
    // undefined for every row (which sorts everything equal, exactly
    // the "nothing happens when I click it" symptom).
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

  // ---- four-eyes trail hydration -----------------------------------------
  // Only PARTIALLY_APPROVED rows have a trail worth reading, and only the ones
  // on the visible page are worth a request. A PENDING row has no approvals by
  // definition, so fetching one would buy nothing.
  const trailIds = useMemo(
    () =>
      table.pageRows
        .filter((r) => r.status === JIT_STATUS.PARTIALLY_APPROVED)
        .slice(0, TRAIL_HYDRATION_LIMIT)
        .map((r) => r.id),
    [table.pageRows]
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
          description: result.next || 'A second, different admin, or root, must approve to issue the grant.',
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

  const pending = rows.filter((r) => PENDING_LIKE.includes(r.status))
  const pendingBreakglass = pending.filter(isBreakglass).length
  const oldest = pending.reduce((max, r) => Math.max(max, waitedSeconds(raisedAt(r))), 0)
  const awaitingSecond = rows.filter((r) => r.status === JIT_STATUS.PARTIALLY_APPROVED).length

  // Server-side totals where we have them, page-derived counts where we don't.
  // The stats endpoint spans every page; the loaded rows do not.
  const stats = statsQuery.data
  const awaitingFirstTotal = stats?.awaiting_first_approval
  const awaitingSecondTotal = stats?.awaiting_second_approval

  const facets = useMemo(() => {
    const decided = rows.filter((r) => !PENDING_LIKE.includes(r.status))
    const seen = [...new Set(decided.map((r) => r.status))].sort()
    return [
      { key: 'all', label: 'All', count: rows.length },
      { key: 'pending', label: 'Awaiting decision', count: pending.length },
      // Its own facet, not folded into "awaiting decision": a request that
      // already has one approval is one click from live access, and it is the
      // fastest thing in the queue to clear.
      ...(awaitingSecond > 0
        ? [{ key: JIT_STATUS.PARTIALLY_APPROVED, label: 'Needs 2nd approval', count: awaitingSecond }]
        : []),
      ...seen.map((s) => ({
        key: s,
        label: JIT_STATUS_LABELS[s] || s,
        count: decided.filter((r) => r.status === s).length,
      })),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  const queueView = table.filters.status === 'pending'

  return (
    <>
      {/* NO KPI STRIP HERE. It carried three figures, awaiting decision,
 longest wait, break-glass pending, and every one of them is now
 restated more usefully further down the page: the facet row counts
 them, the decision cards each carry their own waiting time, and
 break-glass rows are red-railed and impossible to miss. Three hero
 numbers on top of a queue that is usually one screen long is exactly
 the pattern that makes a console read as unfinished.

          The default view is ALL requests, not just the pending ones: an
 approver arriving here wants to see what the queue looks like
 including what has just been decided, and a screen that opens on
          "nothing to do" tells them nothing about whether the system is
 working. Awaiting-decision is one click away and always first-sorted
 to the top. */}
      <ListPanel
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="Search requester, resource or reason…"
              className="min-w-[15rem] sm:max-w-sm"
            />
            <SegmentedControl
              size="sm"
              ariaLabel="Filter requests"
              value={table.filters.status}
              onChange={(v) => table.setFilter('status', v)}
              options={facets}
            />

            {/* ORDER CONTROL. The queue sorts oldest-first by default, correct
 for working through a backlog, wrong when you want to see what
 just came in, and previously not changeable at all: the newest
 request was always at the bottom of the list with no way to flip
 it. Two explicit options rather than a click-cycling sort header,
 because there is only one thing here worth ordering by (time) and
 a card list has no header row to put a sort control in. */}
            <SegmentedControl
              size="sm"
              ariaLabel="Sort by request time"
              value={table.sort?.dir === 'desc' ? 'desc' : 'asc'}
              onChange={(dir) => {
                table.setSort({ key: 'requested_at', dir })
                table.setPage(1)
              }}
              options={[
                { key: 'asc', label: 'Oldest first' },
                { key: 'desc', label: 'Newest first' },
              ]}
            />
            <span className="ml-auto flex items-center gap-3">
              {/* The two facts the strip used to carry, as one honest line of
 chrome instead of three hero cards. They only appear when they
 mean something. */}
              {/* Org-wide, from GET /admin/stats, the counts above are only what
 this page has loaded. Rendered as "3 → 2" because the two numbers
 are stages of one queue, not two unrelated totals. */}
              {(awaitingFirstTotal > 0 || awaitingSecondTotal > 0) && (
                <span
                  className="hidden items-center gap-1.5 text-xs font-medium text-ink-400 sm:flex"
                  title="Org-wide: awaiting a first approval → awaiting a second"
                >
                  <UsersRound className="h-3.5 w-3.5 flex-none" strokeWidth={1.9} />
                  <span className="tabular-nums">{awaitingFirstTotal ?? 0}</span>
                  <span className="text-ink-600">→</span>
                  <span className="tabular-nums text-blue-600 dark:text-blue-400">
                    {awaitingSecondTotal ?? 0}
                  </span>
                  <span className="text-ink-500">awaiting approval</span>
                </span>
              )}
              {pending.length > 0 && (
                <span className="hidden items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 sm:flex">
                  <AlarmClock className="h-3.5 w-3.5 flex-none" strokeWidth={1.9} />
                  longest wait {formatDuration(oldest)}
                </span>
              )}
              {pendingBreakglass > 0 && (
                <span className="hidden items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400 sm:flex">
                  <ShieldAlert className="h-3.5 w-3.5 flex-none" strokeWidth={1.9} />
                  <span className="tabular-nums">{pendingBreakglass}</span> break-glass pending
                </span>
              )}
              <RefreshControl
                onRefresh={() => requestsQuery.refetch()}
                isFetching={requestsQuery.isFetching}
                updatedAt={requestsQuery.dataUpdatedAt}
              />
            </span>
          </div>
        }
      >
        <QueryState
          query={requestsQuery}
          empty={(d) => !d?.requests || d.requests.length === 0}
          emptyTitle="No JIT requests"
          emptyMessage="Access requests from across the org land here for approval."
        >
          {() =>
            table.total === 0 ? (
              <Card>
                <EmptyState
                  icon={queueView ? CheckCircle2 : SearchX}
                  title={
                    queueView ? 'Queue clear, nothing awaiting a decision' : 'Nothing matches these filters'
                  }
                  description={
                    queueView
                      ? 'Every access request has been decided. New requests appear here the moment they are raised.'
                      : 'No request matches the current search or status selection.'
                  }
                  action={
                    !queueView && (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setSearch('')
                          table.setFilter('status', 'all')
                        }}
                      >
                        Show all requests
                      </Button>
                    )
                  }
                />
              </Card>
            ) : (
              <>
                <ul>
                  {table.pageRows.map((r) =>
                    PENDING_LIKE.includes(r.status) ? (
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
                    ) : (
                      <DecidedRow key={r.id} request={r} onOpen={() => setDetailId(r.id)} />
                    )
                  )}
                </ul>
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
            )
          }
        </QueryState>
      </ListPanel>

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
