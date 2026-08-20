import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import clsx from 'clsx'
import {
  Plus,
  ShieldAlert,
  ArrowRight,
  Info,
  KeyRound,
  Lock,
  ChevronRight,
  Clock,
  CheckCircle2,
  XCircle,
  Hourglass,
  Ban,
  SearchX,
  Timer,
  UsersRound,
} from 'lucide-react'
import { listMyJitRequests, listMyGrants, cancelJitRequest } from '../../api/jit'
import { useAuthStore } from '../../store/authStore'
import { PageHeader, Card, ListPanel } from '../../components/common/Layout'
import { QueryState } from '../../components/common/QueryState'
import { Pagination } from '../../components/common/Pagination'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { SegmentedControl } from '../../components/common/SegmentedControl'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { CreateJitRequestModal } from '../../components/jit/CreateJitRequestModal'
import { useCountdown } from '../../hooks/useCountdown'
import { formatDateTime, formatDuration, formatRelativeToNow } from '../../lib/format'
import { apiErrorMessage } from '../../lib/apiError'
import {
  JIT_STATUS,
  JIT_STATUS_LABELS,
  JIT_STATUS_BADGE,
  GRANT_STATUS,
  GRANT_STATUS_BADGE,
  DEFAULT_PAGE_SIZE,
} from '../../config/constants'

// ---------------------------------------------------------------------------
// Just-in-Time Access, the user's own elevation
// ---------------------------------------------------------------------------
// WHAT WAS WRONG. The page opened on a paged list of REQUESTS, a log. The
// single most useful fact on it, "you have elevated access to prod-db-01 and
// it dies in 22 minutes", was three clicks away: switch tab, find the grant,
// open the detail page, read the countdown. The thing with a deadline was the
// thing buried deepest.
//
// HOW THE REFERENCE PRODUCTS SHAPE THIS, and what each one contributed:
//
//   · MICROSOFT ENTRA PIM opens on "My roles", what you can use and what is
// active right now, not on an activation history. The history is a
// secondary tab. We take the ORDERING: entitlement first, log second.
//   · GOOGLE CLOUD PRIVILEGED ACCESS MANAGER makes the grant a first-class
// object with its remaining lifetime rendered as a bar, because a grant
// is perishable and a timestamp doesn't communicate perishability. We
// take the LIFETIME BAR and the live countdown.
//   · CYBERARK's request view shows the workflow as explicit stages ,
// requested, decided, active, expired, instead of scattering two
// timestamps through a property sheet. We take the LIFECYCLE TIMELINE
//     (on the detail page).
//   · DELINEA and AWS both treat emergency/break-glass as a separate door
// with its own friction, never a checkbox on the standard form. We take
// the SPLIT (see CreateJitRequestModal).
//
// So the page is now three zones in descending order of "does this have a
// deadline":
//   1. ACTIVE ACCESS, grants usable this second, with a countdown. Collapses
// to one quiet line when there are none, because good news should be
// small.
//   2. IN FLIGHT, requests still awaiting a decision, surfaced as a count on
// the tab rather than requiring a filter change to find.
//   3. THE LOG, everything, paged and filterable, which is where the old
// page started.
//
// Every API call is unchanged: listMyJitRequests, listMyGrants,
// cancelJitRequest, and the two creation endpoints behind the modal.

// PARTIALLY_APPROVED belongs here. Under four-eyes a request with one of its
// two approvals is still open, still in flight, still withdrawable, still
// worth polling, and treating it as decided would drop it out of the "in
// flight" count at exactly the moment it is closest to granting access.
const CANCELLABLE_STATUSES = [JIT_STATUS.PENDING, JIT_STATUS.PARTIALLY_APPROVED, JIT_STATUS.WAITING]

// models.JITRequest records the raise time as `requested_at`; `created_at` is
// the row's own audit column and can differ. Read the semantic one first.
const raisedAt = (r) => r?.requested_at || r?.created_at || null

// Poll only while something can actually change, see JitRequestDetailPage
// for the full reasoning. A queue that never updates makes people reload; a
// queue that polls terminal rows forever makes the API expensive.
const POLL_PENDING_MS = 15_000

const STATUS_RAIL = {
  PENDING: 'bg-amber-400',
  // Blue, not green: one approval is progress, not access.
  PARTIALLY_APPROVED: 'bg-blue-500',
  WAITING: 'bg-orange-400',
  APPROVED: 'bg-emerald-500',
  DENIED: 'bg-red-500',
  CANCELLED: 'bg-transparent',
  EXPIRED: 'bg-transparent',
}

const STATUS_ICON = {
  PENDING: Hourglass,
  PARTIALLY_APPROVED: UsersRound,
  WAITING: Timer,
  APPROVED: CheckCircle2,
  DENIED: XCircle,
  CANCELLED: Ban,
  EXPIRED: Clock,
}

function isBreakglass(x) {
  return x?.type === 'BREAKGLASS' || x?.request_type === 'BREAKGLASS' || !!x?.is_breakglass
}

function BreakglassChip() {
  return (
    <span className="inline-flex flex-none items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-600/25 dark:text-red-300 dark:ring-red-500/30">
      <ShieldAlert className="h-3 w-3" strokeWidth={1.9} />
      break-glass
    </span>
  )
}

// ---------------------------------------------------------------------------
// Active access, the only thing on this page with a deadline
// ---------------------------------------------------------------------------

function GrantCard({ grant }) {
  const remainingMs = useCountdown(grant.expires_at)
  const remaining = Math.max(0, remainingMs / 1000)

  // Elapsed share of the grant's whole life. Shown as a bar because "expires
  // at 16:40" tells you nothing about urgency without doing arithmetic, and
  // urgency is the entire point of a time-boxed grant.
  const startMs = new Date(grant.granted_at || grant.created_at || 0).getTime()
  const endMs = new Date(grant.expires_at || 0).getTime()
  const totalMs = endMs - startMs
  const usedPct = totalMs > 0 ? Math.min(100, Math.max(0, ((Date.now() - startMs) / totalMs) * 100)) : 0

  // Thresholds are absolute, not proportional: five minutes left is urgent
  // whether the grant was an hour long or eight.
  const tone = remaining <= 0 ? 'dead' : remaining < 300 ? 'red' : remaining < 1800 ? 'amber' : 'emerald'
  const bar = { emerald: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', dead: 'bg-ink-500' }[
    tone
  ]
  const text = {
    emerald: 'text-emerald-700 dark:text-emerald-300',
    amber: 'text-amber-700 dark:text-amber-300',
    red: 'text-red-700 dark:text-red-300',
    dead: 'text-ink-500',
  }[tone]

  return (
    <div className="flex flex-col rounded-xl border border-surface-700/70 bg-surface-900 p-4 transition-[border-color,box-shadow] duration-200 hover:border-surface-600">
      <div className="flex items-start gap-2.5">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-emerald-600/25 bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300">
          <Lock className="h-[0.95rem] w-[0.95rem]" strokeWidth={1.85} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-semibold text-ink-50"
            title={grant.resource_name || grant.resource_id}
          >
            {grant.resource_name || grant.resource_id || '-'}
          </p>
          <p className="mt-0.5 truncate text-2xs text-ink-500">
            {grant.action ? `${grant.action} · ` : ''}until {formatDateTime(grant.expires_at)}
          </p>
        </div>
        {isBreakglass(grant) && <BreakglassChip />}
      </div>

      <div className="mt-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <span
            className={clsx('text-[1.35rem] font-semibold leading-none tracking-tight tabular-nums', text)}
          >
            {remaining > 0 ? formatDuration(remaining) : 'Expired'}
          </span>
          <span className="text-2xs font-medium uppercase tracking-[0.08em] text-ink-500">
            {remaining > 0 ? 'remaining' : ''}
          </span>
        </div>
        <span aria-hidden="true" className="mt-2 block h-1 overflow-hidden rounded-full bg-surface-800">
          <span
            className={clsx('block h-full rounded-full transition-[width] duration-1000 ease-linear', bar)}
            style={{ width: `${usedPct}%` }}
          />
        </span>
      </div>

      {grant.resource_id && (
        <Link
          to={`/resources/${grant.resource_id}`}
          className="group mt-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
        >
          Open resource
          <ArrowRight
            className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
            strokeWidth={2}
          />
        </Link>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function RequestRow({ request, onCancel, cancelling }) {
  const Icon = STATUS_ICON[request.status] || KeyRound
  const canCancel = CANCELLABLE_STATUSES.includes(request.status)
  const pendingish = canCancel

  return (
    <li className="group relative">
      {/* Left rail carries the verdict, so a column of rows can be read
 vertically by colour without parsing a badge on each one. */}
      <span
        aria-hidden="true"
        className={clsx('absolute inset-y-0 left-0 w-[3px]', STATUS_RAIL[request.status] || 'bg-transparent')}
      />
      <div className="flex flex-col gap-3 py-3.5 pl-5 pr-4 transition-colors hover:bg-surface-850 sm:flex-row sm:items-center">
        <span
          className={clsx(
            'flex h-9 w-9 flex-none items-center justify-center rounded-lg border transition-colors',
            pendingish
              ? 'border-amber-600/25 bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300'
              : 'border-surface-700 bg-surface-850 text-ink-400 group-hover:border-surface-600'
          )}
        >
          <Icon className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.6} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link
              to={`/jit/requests/${request.id}`}
              className="truncate text-sm font-semibold text-ink-100 outline-none transition-colors hover:text-blue-600 dark:hover:text-blue-300"
            >
              {request.resource_name || request.resource_id || '-'}
            </Link>
            {isBreakglass(request) && <BreakglassChip />}
            {request.action && (
              <span className="rounded border border-surface-700 bg-surface-850 px-1.5 py-0.5 font-mono text-2xs text-ink-400">
                {request.action}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-ink-500" title={request.reason || undefined}>
            {pendingish
              ? `Waiting ${formatRelativeToNow(raisedAt(request))}`
              : `Requested ${formatDateTime(raisedAt(request))}`}
            {request.duration_minutes ? ` · ${request.duration_minutes} min` : ''}
            {request.reason ? ` · ${request.reason}` : ''}
          </p>
        </div>

        <div className="flex flex-none items-center gap-2.5">
          <Badge className={JIT_STATUS_BADGE[request.status] || 'bg-ink-500/15 text-ink-400 ring-ink-500/30'}>
            {JIT_STATUS_LABELS[request.status] || request.status}
          </Badge>
          {canCancel && (
            <Button size="xs" variant="dangerGhost" disabled={cancelling} onClick={() => onCancel(request)}>
              Withdraw
            </Button>
          )}
          <Link
            to={`/jit/requests/${request.id}`}
            aria-label="Open request"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-600 transition-all duration-200 hover:bg-surface-800 hover:text-ink-100 group-hover:translate-x-0.5"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </Link>
        </div>
      </div>
    </li>
  )
}

function GrantRow({ grant }) {
  const remainingMs = useCountdown(grant.status === GRANT_STATUS.ACTIVE ? grant.expires_at : null)
  const remaining = Math.max(0, remainingMs / 1000)
  const active = grant.status === GRANT_STATUS.ACTIVE && remaining > 0

  return (
    <li className="group relative">
      <span
        aria-hidden="true"
        className={clsx('absolute inset-y-0 left-0 w-[3px]', active ? 'bg-emerald-500' : 'bg-transparent')}
      />
      <Link
        to={grant.resource_id ? `/resources/${grant.resource_id}` : '/jit'}
        className="flex flex-col gap-3 py-3.5 pl-5 pr-4 outline-none transition-colors hover:bg-surface-850 sm:flex-row sm:items-center"
      >
        <span
          className={clsx(
            'flex h-9 w-9 flex-none items-center justify-center rounded-lg border transition-colors',
            active
              ? 'border-emerald-600/25 bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'border-surface-700 bg-surface-850 text-ink-400 group-hover:border-surface-600'
          )}
        >
          <Lock className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.6} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink-100">
              {grant.resource_name || grant.resource_id || '-'}
            </span>
            {isBreakglass(grant) && <BreakglassChip />}
          </div>
          <p className="mt-1 truncate text-xs text-ink-500">
            Granted {formatDateTime(grant.granted_at || grant.created_at)}
            {grant.expires_at
              ? ` · ${active ? 'expires' : 'expired'} ${formatDateTime(grant.expires_at)}`
              : ''}
          </p>
        </div>

        <div className="flex flex-none items-center gap-2.5">
          {active && (
            <span className="text-xs font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
              {formatDuration(remaining)} left
            </span>
          )}
          <Badge className={GRANT_STATUS_BADGE[grant.status] || 'bg-ink-500/15 text-ink-400 ring-ink-500/30'}>
            {grant.status}
          </Badge>
          <ChevronRight
            className="h-4 w-4 text-ink-600 transition-transform duration-200 group-hover:translate-x-0.5"
            strokeWidth={2}
          />
        </div>
      </Link>
    </li>
  )
}

// ---------------------------------------------------------------------------

export default function JitPage() {
  const isAdmin = useAuthStore((s) => s.isAdmin())
  const queryClient = useQueryClient()

  const [tab, setTab] = useState('requests')
  const [requestStatus, setRequestStatus] = useState('')
  const [grantStatus, setGrantStatus] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalBreakglass, setModalBreakglass] = useState(false)
  const [cancelTarget, setCancelTarget] = useState(null)

  // Reset paging whenever the tab or its filter changes, a stale page number
  // from one combination lands on an empty page in another.
  const changeTab = (next) => {
    setTab(next)
    setPage(1)
  }

  // Its own small query, independent of the paged tabs below: the active-access
  // rail must not change when someone pages through their history, and
  // `active=true` is a parameter the backend genuinely honours.
  const activeGrantsQuery = useQuery({
    queryKey: ['jit', 'grants', 'mine', { activeOnly: true, rail: true }],
    queryFn: ({ signal }) => listMyGrants({ activeOnly: true, pageSize: 12, signal }),
    // A grant expiring is a server-side event, so the rail re-reads on a slow
    // cadence as well as on focus, the per-second countdown is local, but
    // whether the row still exists is not.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })

  const requestsQuery = useQuery({
    queryKey: ['jit', 'requests', { page, pageSize, status: requestStatus }],
    queryFn: ({ signal }) =>
      listMyJitRequests({ page, pageSize, status: requestStatus || undefined, signal }),
    enabled: tab === 'requests',
    // Someone else decides these, so the list must move on its own, but only
    // while at least one row on the page is still undecided.
    refetchInterval: (query) => {
      const rows = query.state.data?.requests || []
      return rows.some((r) => CANCELLABLE_STATUSES.includes(r.status)) ? POLL_PENDING_MS : false
    },
    refetchOnWindowFocus: true,
  })

  const grantsQuery = useQuery({
    queryKey: ['jit', 'grants', { page, pageSize, status: grantStatus }],
    queryFn: ({ signal }) => listMyGrants({ page, pageSize, status: grantStatus || undefined, signal }),
    enabled: tab === 'grants',
  })

  const cancelMutation = useMutation({
    mutationFn: ({ id, reason }) => cancelJitRequest(id, reason),
    onSuccess: () => {
      toast.success('Request withdrawn')
      setCancelTarget(null)
      queryClient.invalidateQueries({ queryKey: ['jit'] })
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setCancelTarget(null)
    },
  })

  const openNewRequest = () => {
    setModalBreakglass(false)
    setModalOpen(true)
  }
  const openBreakglass = () => {
    setModalBreakglass(true)
    setModalOpen(true)
  }

  const activeGrants = useMemo(
    () =>
      (activeGrantsQuery.data?.grants || [])
        .filter((g) => g.status === GRANT_STATUS.ACTIVE)
        // Soonest to die, first. A wall of grants sorted by creation date
        // buries the one that is about to strand you mid-task.
        .sort((a, b) => new Date(a.expires_at || 0) - new Date(b.expires_at || 0)),
    [activeGrantsQuery.data]
  )

  const requests = requestsQuery.data?.requests || []
  const grants = grantsQuery.data?.grants || []
  const pagination = (tab === 'requests' ? requestsQuery : grantsQuery).data?.pagination
  const inFlight = requests.filter((r) => CANCELLABLE_STATUSES.includes(r.status)).length

  return (
    <div>
      <PageHeader
        eyebrow="Access"
        title="Just-in-Time Access"
        description="Elevation you hold right now, requests in flight, and the full history of both scoped to you."
        actions={
          <>
            <Button variant="dangerGhost" icon={ShieldAlert} onClick={openBreakglass}>
              Emergency access
            </Button>
            <Button variant="primary" icon={Plus} onClick={openNewRequest}>
              Request access
            </Button>
          </>
        }
      />

      {/* ZONE 1, what you can use this second. Top of the page because it is
 the only thing here that expires while you are looking at it. */}
      <section className="mb-7">
        <div className="mb-3.5 flex items-center gap-2.5">
          <h2 className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-ink-50">Active access</h2>
          {activeGrants.length > 0 && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-2xs font-bold tabular-nums text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              {activeGrants.length}
            </span>
          )}
        </div>

        {activeGrantsQuery.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-[9.5rem] rounded-xl" />
            ))}
          </div>
        ) : activeGrants.length === 0 ? (
          // Good news is one line, not an empty card the size of the fold.
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-surface-700/70 bg-surface-900 px-4 py-3">
            <Lock className="h-4 w-4 flex-none text-ink-500" strokeWidth={1.75} />
            <p className="text-sm text-ink-400">
              No elevated access is active right now, you are running with standing permissions only.
            </p>
            {/* <Button size="sm" variant="secondary" icon={Plus} className="ml-auto" onClick={openNewRequest}>
              Request access
            </Button> */}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {activeGrants.map((g) => (
              <GrantCard key={g.id} grant={g} />
            ))}
          </div>
        )}
      </section>

      {isAdmin && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-300/60 bg-blue-50/70 px-4 py-3 dark:border-blue-800/40 dark:bg-blue-950/20">
          <p className="flex items-start gap-2.5 text-sm leading-relaxed text-blue-800 dark:text-blue-200">
            <Info className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
            <span>
              This page shows only the requests and grants{' '}
              <strong className="font-semibold">you personally</strong> made. To review and decide requests
              from across the org, use JIT Approvals.
            </span>
          </p>
          <Link
            to="/admin/jit"
            className="group inline-flex flex-none items-center gap-1 text-sm font-semibold text-blue-700 transition-colors hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
          >
            JIT Approvals
            <ArrowRight
              className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
              strokeWidth={2}
            />
          </Link>
        </div>
      )}

      {/* ZONE 2/3, the log. Tab labels carry their own live counts so you
 never have to switch to find out whether there is anything there. */}
      <ListPanel
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              size="sm"
              ariaLabel="JIT view"
              value={tab}
              onChange={changeTab}
              options={[
                {
                  key: 'requests',
                  label: inFlight > 0 ? `Requests · ${inFlight} in flight` : 'Requests',
                  icon: KeyRound,
                },
                { key: 'grants', label: 'Grants', icon: Lock },
              ]}
            />

            <span className="ml-auto flex items-center gap-2">
              <span className="text-xs font-medium text-ink-500">Status</span>
              {tab === 'requests' ? (
                <select
                  value={requestStatus}
                  onChange={(e) => {
                    setRequestStatus(e.target.value)
                    setPage(1)
                  }}
                  aria-label="Filter requests by status"
                  className="h-9 cursor-pointer rounded-lg border border-surface-700 bg-surface-900 pl-2.5 pr-7 text-xs font-medium text-ink-100 shadow-sm transition-colors hover:border-surface-600 focus:border-blue-500 focus:outline-none"
                >
                  <option value="">All statuses</option>
                  {Object.values(JIT_STATUS).map((s) => (
                    <option key={s} value={s}>
                      {JIT_STATUS_LABELS[s] || s}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={grantStatus}
                  onChange={(e) => {
                    setGrantStatus(e.target.value)
                    setPage(1)
                  }}
                  aria-label="Filter grants by status"
                  className="h-9 cursor-pointer rounded-lg border border-surface-700 bg-surface-900 pl-2.5 pr-7 text-xs font-medium text-ink-100 shadow-sm transition-colors hover:border-surface-600 focus:border-blue-500 focus:outline-none"
                >
                  <option value="">All statuses</option>
                  {Object.values(GRANT_STATUS).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
            </span>
          </div>
        }
      >
        {tab === 'requests' ? (
          <QueryState
            query={requestsQuery}
            empty={(d) => !d?.requests || d.requests.length === 0}
            emptyTitle={requestStatus ? 'No requests with that status' : 'No access requests yet'}
            emptyMessage={
              requestStatus
                ? 'Nothing you have raised is in that state. Clear the status filter to see everything.'
                : 'Request time-boxed access to a JIT-gated resource and it appears here with its approval state.'
            }
            emptyAction={
              requestStatus ? (
                <Button variant="secondary" icon={SearchX} onClick={() => setRequestStatus('')}>
                  Clear filter
                </Button>
              ) : (
                <Button variant="primary" icon={Plus} onClick={openNewRequest}>
                  Request access
                </Button>
              )
            }
          >
            {() => (
              <>
                <ul className="divide-y divide-surface-800">
                  {requests.map((r) => (
                    <RequestRow
                      key={r.id}
                      request={r}
                      onCancel={setCancelTarget}
                      cancelling={cancelMutation.isPending}
                    />
                  ))}
                </ul>
                {pagination && (
                  <Pagination
                    page={pagination.page}
                    pageSize={pagination.page_size}
                    total={pagination.total}
                    totalPages={pagination.total_pages}
                    onPageChange={setPage}
                    onPageSizeChange={(size) => {
                      setPageSize(size)
                      setPage(1)
                    }}
                    label="requests"
                  />
                )}
              </>
            )}
          </QueryState>
        ) : (
          <QueryState
            query={grantsQuery}
            empty={(d) => !d?.grants || d.grants.length === 0}
            emptyTitle={grantStatus ? 'No grants with that status' : 'No grants yet'}
            emptyMessage={
              grantStatus
                ? 'No grant of yours is in that state. Clear the status filter to see everything.'
                : 'Approved requests become grants - time-boxed elevation you can use until it expires.'
            }
            emptyAction={
              grantStatus && (
                <Button variant="secondary" icon={SearchX} onClick={() => setGrantStatus('')}>
                  Clear filter
                </Button>
              )
            }
          >
            {() => (
              <>
                <ul className="divide-y divide-surface-800">
                  {grants.map((g) => (
                    <GrantRow key={g.id} grant={g} />
                  ))}
                </ul>
                {pagination && (
                  <Pagination
                    page={pagination.page}
                    pageSize={pagination.page_size}
                    total={pagination.total}
                    totalPages={pagination.total_pages}
                    onPageChange={setPage}
                    onPageSizeChange={(size) => {
                      setPageSize(size)
                      setPage(1)
                    }}
                    label="grants"
                  />
                )}
              </>
            )}
          </QueryState>
        )}
      </ListPanel>

      <CreateJitRequestModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        defaultBreakglass={modalBreakglass}
      />

      <ConfirmDialog
        open={!!cancelTarget}
        title={`Withdraw request for “${cancelTarget?.resource_name || cancelTarget?.resource_id || 'this resource'}”?`}
        description="This withdraws the request before a decision is made. You can raise a new one later if you still need access."
        confirmLabel="Withdraw request"
        destructive
        requireReason
        reasonLabel="Reason (required for the audit record)"
        isLoading={cancelMutation.isPending}
        onConfirm={(reason) => cancelMutation.mutate({ id: cancelTarget.id, reason })}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  )
}
