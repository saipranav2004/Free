import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import { toast } from 'sonner'
import clsx from 'clsx'
import {
  ArrowLeft,
  ShieldAlert,
  Clock,
  CheckCircle2,
  XCircle,
  Hourglass,
  Ban,
  Lock,
  FileText,
  Timer,
  ArrowRight,
  Copy,
  Check,
  KeyRound,
  RadioTower,
  UsersRound,
} from 'lucide-react'
import { getJitRequest, listMyGrants, cancelJitRequest } from '../../api/jit'
import { PageHeader, Card, CardHeader, CardTitle, DetailList } from '../../components/common/Layout'
import { QueryState } from '../../components/common/QueryState'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { useCountdown } from '../../hooks/useCountdown'
import { formatDateTime, formatDuration, formatRelativeToNow } from '../../lib/format'
import { apiErrorMessage } from '../../lib/apiError'
import { ApprovalProgress } from '../../components/jit/ApprovalTrail'
import { REQUIRED_APPROVALS } from '../../lib/fourEyes'
import { JIT_STATUS, JIT_STATUS_LABELS, JIT_STATUS_BADGE, GRANT_STATUS_BADGE } from '../../config/constants'

// ---------------------------------------------------------------------------
// JIT request detail
// ---------------------------------------------------------------------------
// THE BUG THIS FIXES: an APPROVED request showed a green "Approved, access
// granted" banner sitting directly above a lifecycle that said "Approved ,
// Awaiting an approver" and "Access active, Nothing granted yet". Two
// separate causes, both from guessing at the API instead of reading it:
//
//   1. WRONG FIELD NAMES. The timeline looked for `approved_at`, `denied_at`
// and `cancelled_at`. models.JITRequest has NONE of those. It records
// every decision, approve, deny AND cancel, in ONE nullable column:
//
//          DecidedAt        *time.Time `json:"decided_at,omitempty"`
//          ApproverUserID   *string    `json:"approver_user_id,omitempty"`
//          ApproverUsername *string    `json:"approver_username,omitempty"`
//          DecisionReason string     `json:"decision_reason,omitempty"`
//
//      Which one it was is carried by `status`, not by which timestamp is
// populated. So `approved_at` was always undefined and the stage was
// permanently stuck on "awaiting".
//
//   2. THE GRANT IS NOT NESTED. The old code looked for `request.grant` or
//      `request.grants[0]`. The API returns neither, GET /jit/requests/:id
// returns the bare JITRequest, whose only link to the grant is
//      `grant_id`. So the grant panel could never populate, and the "Access
// active" and "Expires" stages had nothing to read. The grant is now
// fetched from GET /jit/grants (the caller's own grants) and matched on
//      `grant_id`, falling back to `request_id`, both are on the model.
//
// Other field corrections made at the same time: `request_type` (not `type`)
// for STANDARD vs BREAKGLASS, `requested_at` as the authoritative raise time
// with `created_at` as fallback, `available_at` for the break-glass
// cooling-off deadline, and `approver_username` / `decision_reason` for the
// decision record.
//
// REAL-TIME. Both queries poll while the request can still change, and stop
// once it cannot, the pattern CyberArk's request view, Okta's admin task
// list and Linear all use for a workflow object that a *different* person
// advances. Specifically:
//
//   · PENDING / WAITING  → 10s. Someone else is deciding; the page must show
// it without the user thinking to reload.
//   · APPROVED + grant live → 30s, so the grant flips to expired on its own.
//   · Everything else    → no polling at all. A denied request from last week
// is not going to change, and hammering the API for
// terminal rows is how a console becomes expensive.
//
// `refetchOnWindowFocus` covers the common case of approving in another tab
// and switching back, an instant refresh with no polling cost.

// ---------------------------------------------------------------------------
// FOUR-EYES, from the requester's side
// ---------------------------------------------------------------------------
// The requester never approves anything, so this page shows dual control only
// as an explanation of the wait, but it has to show it, because without it
// PARTIALLY_APPROVED reads as "approved" and the obvious next question ("so
// where is my access?") has no answer on screen.
//
// Three consequences, all of them small:
//   · PARTIALLY_APPROVED is still withdrawable. Half-approved is not decided,
// and the requester keeps the right to pull it until it is.
//   · It still polls, the second approval is exactly the event this page
// exists to catch.
//   · The lifecycle gains an approvals stage that counts, instead of a single
//     "Approved" step that would tick over on the first of two decisions.
//
// The requester's own GET /jit/requests/:id does NOT return the approvals
// trail (that is admin-only), so nothing here names the approvers, only the
// count, which comes from `status`.
const CANCELLABLE_STATUSES = [JIT_STATUS.PENDING, JIT_STATUS.PARTIALLY_APPROVED, JIT_STATUS.WAITING]

const POLL_PENDING_MS = 10_000
const POLL_ACTIVE_MS = 30_000

const raisedAt = (r) => r?.requested_at || r?.created_at || null
const isBreakglassRequest = (r) =>
  r?.request_type === 'BREAKGLASS' || r?.type === 'BREAKGLASS' || !!r?.is_breakglass

function CopyableId({ value }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          toast.error('Clipboard unavailable in this browser')
        }
      }}
      className="group inline-flex max-w-full items-center gap-1.5 rounded px-1 font-mono text-xs text-ink-500 transition-colors hover:bg-surface-800 hover:text-ink-200"
      title="Copy request ID"
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <Check className="h-3 w-3 flex-none text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
      ) : (
        <Copy
          className="h-3 w-3 flex-none opacity-0 transition-opacity group-hover:opacity-100"
          strokeWidth={2}
        />
      )}
    </button>
  )
}

function LiveCountdown({ targetIso, className }) {
  const remainingMs = useCountdown(targetIso)
  const remaining = Math.max(0, remainingMs / 1000)
  if (!targetIso) return <span className="text-ink-500">-</span>
  if (remaining <= 0) return <span className="text-ink-500">Expired</span>
  const tone =
    remaining < 300
      ? 'text-red-700 dark:text-red-300'
      : remaining < 1800
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-emerald-700 dark:text-emerald-300'
  return (
    <span className={clsx('font-semibold tabular-nums', tone, className)}>{formatDuration(remaining)}</span>
  )
}

// A quiet "this page is watching" marker. Without it, polling is invisible
// and users reload anyway, which defeats the point of polling.
function LiveTicker({ active, isFetching }) {
  if (!active) return null
  return (
    <span className="flex items-center gap-1.5 text-2xs font-medium text-ink-500">
      <span className="relative flex h-1.5 w-1.5 flex-none rounded-full bg-emerald-500" aria-hidden="true">
        <span className="dot-live absolute inset-0 rounded-full bg-emerald-500" />
      </span>
      {isFetching ? 'Checking…' : 'Live'}
    </span>
  )
}

// --- state banner ----------------------------------------------------------

const BANNERS = {
  PENDING: {
    tone: 'amber',
    icon: Hourglass,
    title: 'Waiting for an approver',
    body: 'An administrator has to decide this before any access exists. This page updates itself the moment they do, you can withdraw it while it is still undecided.',
  },
  PARTIALLY_APPROVED: {
    tone: 'blue',
    icon: UsersRound,
    title: 'One approval in, waiting for a second',
    body: 'This kind of access needs two different administrators to agree (or one root approval). The first has approved; nothing is granted until the second does. You can still withdraw it.',
  },
  WAITING: {
    tone: 'orange',
    icon: Timer,
    title: 'In the cooling-off period',
    body: 'Break-glass access does not activate immediately. It becomes usable when the mandatory waiting period elapses, unless an administrator revokes it first.',
  },
  APPROVED: {
    tone: 'emerald',
    icon: CheckCircle2,
    title: 'Approved, access granted',
    body: 'The grant below is what you actually hold. It is time-boxed and stops working the moment it expires.',
  },
  DENIED: {
    tone: 'red',
    icon: XCircle,
    title: 'Denied',
    body: 'No access was granted. The approver’s reason is recorded below. Raise a new request if the need still stands.',
  },
  CANCELLED: {
    tone: 'neutral',
    icon: Ban,
    title: 'Withdrawn',
    body: 'You withdrew this request before it was decided. Nothing was granted.',
  },
  EXPIRED: {
    tone: 'neutral',
    icon: Clock,
    title: 'Expired',
    body: 'This request is no longer actionable. Any access it granted has already ended.',
  },
}

const BANNER_STYLE = {
  amber: {
    wrap: 'border-amber-500 bg-amber-50/60 dark:bg-amber-950/15',
    tile: 'bg-amber-100 text-amber-600 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25',
    head: 'text-amber-900 dark:text-amber-200',
    body: 'text-amber-800/90 dark:text-amber-300/85',
  },
  blue: {
    wrap: 'border-blue-500 bg-blue-50/60 dark:bg-blue-950/15',
    tile: 'bg-blue-100 text-blue-600 ring-blue-600/20 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/25',
    head: 'text-blue-900 dark:text-blue-200',
    body: 'text-blue-800/90 dark:text-blue-300/85',
  },
  orange: {
    wrap: 'border-orange-500 bg-orange-50/60 dark:bg-orange-950/15',
    tile: 'bg-orange-100 text-orange-600 ring-orange-600/20 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-500/25',
    head: 'text-orange-900 dark:text-orange-200',
    body: 'text-orange-800/90 dark:text-orange-300/85',
  },
  emerald: {
    wrap: 'border-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/15',
    tile: 'bg-emerald-100 text-emerald-600 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25',
    head: 'text-emerald-900 dark:text-emerald-200',
    body: 'text-emerald-800/90 dark:text-emerald-300/85',
  },
  red: {
    wrap: 'border-red-500 bg-red-50/60 dark:bg-red-950/15',
    tile: 'bg-red-100 text-red-600 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25',
    head: 'text-red-900 dark:text-red-200',
    body: 'text-red-800/90 dark:text-red-300/85',
  },
  neutral: {
    wrap: 'border-surface-600 bg-surface-850',
    tile: 'bg-surface-800 text-ink-400 ring-surface-700',
    head: 'text-ink-100',
    body: 'text-ink-400',
  },
}

function StateBanner({ request, grant, grantExpired, onWithdraw }) {
  let spec = BANNERS[request.status] || BANNERS.EXPIRED
  const canWithdraw = CANCELLABLE_STATUSES.includes(request.status)
  const activeGrant = !!grant && !grantExpired

  // An APPROVED request whose grant has since run out is not "access
  // granted" any more, and saying so would be the same class of lie the
  // lifecycle bug was. The banner follows the grant, not just the status.
  if (request.status === JIT_STATUS.APPROVED && grant && grantExpired) {
    spec = {
      tone: 'neutral',
      icon: Clock,
      title: 'Access has expired',
      body: 'This request was approved and the grant it produced has since run out. Raise a new request if you need access again.',
    }
  }

  const s = BANNER_STYLE[spec.tone]
  const Icon = spec.icon

  return (
    <div
      className={clsx(
        'mb-6 flex flex-col gap-4 rounded-xl border border-l-[3px] px-4 py-4 sm:flex-row sm:items-center',
        s.wrap
      )}
    >
      <span
        className={clsx(
          'flex h-10 w-10 flex-none items-center justify-center rounded-xl ring-1 ring-inset',
          s.tile
        )}
      >
        <Icon className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.75} />
      </span>

      <div className="min-w-0 flex-1">
        <p className={clsx('text-sm font-semibold', s.head)}>{spec.title}</p>
        <p className={clsx('mt-1 text-sm leading-relaxed', s.body)}>{spec.body}</p>
      </div>

      {/* Exactly one action, chosen by state, a banner offering three
 buttons is a toolbar, and a toolbar has no opinion. */}
      <div className="flex flex-none items-center gap-3">
        {activeGrant && (
          <span className={clsx('hidden text-sm sm:block', s.body)}>
            <LiveCountdown targetIso={grant.expires_at} /> left
          </span>
        )}
        {canWithdraw ? (
          <Button variant="dangerGhost" onClick={onWithdraw}>
            Withdraw request
          </Button>
        ) : activeGrant && request.resource_id ? (
          <Link to={`/resources/${request.resource_id}`}>
            <Button variant="primary" iconRight={ArrowRight}>
              Open resource
            </Button>
          </Link>
        ) : null}
      </div>
    </div>
  )
}

// --- lifecycle timeline ----------------------------------------------------

function Timeline({ request, grant, grantExpired }) {
  const status = request.status
  const denied = status === JIT_STATUS.DENIED
  const cancelled = status === JIT_STATUS.CANCELLED
  const approved = status === JIT_STATUS.APPROVED
  const waiting = status === JIT_STATUS.WAITING
  const pending = status === JIT_STATUS.PENDING
  const partial = status === JIT_STATUS.PARTIALLY_APPROVED
  const breakglass = isBreakglassRequest(request)

  // ONE column for every decision, see the header comment. Which decision it
  // was comes from `status`.
  const decidedAt = request.decided_at || null
  const decidedBy = request.approver_username || null

  const grantStart = grant?.granted_at || decidedAt
  const expiresAt = grant?.expires_at || null
  const accessLive = !!grant && !grantExpired

  // How many of the two approvals exist. Derived from `status` because the
  // requester's endpoint returns no trail, see the header note.
  const approvalsGiven = approved ? REQUIRED_APPROVALS : partial ? 1 : 0

  const stages = [
    {
      key: 'requested',
      label: 'Requested',
      at: raisedAt(request),
      state: 'done',
      note: raisedAt(request) ? formatRelativeToNow(raisedAt(request)) : null,
      icon: KeyRound,
    },
    // FOUR-EYES STAGE. Only for standard requests: break-glass has no
    // approvers, so on one of those this stage would be a step that never
    // completes no matter what happens.
    ...(breakglass
      ? []
      : [
          {
            key: 'approvals',
            label:
              denied || cancelled
                ? 'Approvals'
                : approved
                  ? 'Approved by two'
                  : `Approvals · ${approvalsGiven} of ${REQUIRED_APPROVALS}`,
            at: null,
            state: denied || cancelled ? 'skipped' : approved ? 'done' : 'live',
            note: denied
              ? 'Denied before quorum, one denial is enough'
              : cancelled
                ? 'Withdrawn before quorum'
                : approved
                  ? 'Two different admins agreed, or root approved alone'
                  : partial
                    ? 'One approval in, a different admin, or root, must give the second'
                    : 'Two different admins must approve, or one root approval',
            icon: UsersRound,
          },
        ]),
    {
      key: 'decided',
      label: cancelled ? 'Withdrawn' : denied ? 'Denied' : 'Approved',
      at: decidedAt,
      state: decidedAt ? (denied || cancelled ? 'failed' : 'done') : 'live',
      // With four-eyes, `approver_username` is the approver who FINALISED it,
      // not the only one who approved.
      note: decidedAt
        ? decidedBy
          ? `finalised by ${decidedBy}`
          : null
        : partial
          ? 'One approval short'
          : 'Awaiting an approver',
      icon: cancelled ? Ban : denied ? XCircle : CheckCircle2,
    },
    {
      key: 'active',
      label: 'Access active',
      // Break-glass sits in WAITING until `available_at`; a standard request
      // activates the moment it is approved.
      at: waiting ? request.available_at : grantStart,
      state:
        denied || cancelled ? 'skipped' : accessLive ? 'live' : grant ? 'done' : waiting ? 'live' : 'pending',
      note:
        denied || cancelled
          ? 'Never activated'
          : waiting
            ? 'Cooling-off period, becomes usable at'
            : grant
              ? null
              : approved
                ? 'Approved, locating the grant'
                : partial
                  ? 'Nothing granted yet, a second approval is still needed'
                  : 'Nothing granted yet',
      icon: Lock,
    },
    {
      key: 'expires',
      label: grantExpired ? 'Expired' : 'Expires',
      at: expiresAt,
      state: denied || cancelled ? 'skipped' : grantExpired ? 'done' : expiresAt ? 'pending' : 'pending',
      note: denied || cancelled ? '-' : expiresAt ? null : 'Set when access starts',
      icon: Clock,
    },
  ]

  const TILE = {
    done: 'border-emerald-600/25 bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300',
    live: 'border-amber-600/25 bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300',
    failed: 'border-red-600/25 bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300',
    pending: 'border-surface-700 bg-surface-850 text-ink-600',
    skipped: 'border-surface-700 bg-surface-850 text-ink-600',
  }

  return (
    <ol className="px-4 py-4">
      {stages.map((st, i) => {
        const Icon = st.icon
        const last = i === stages.length - 1
        const muted = st.state === 'pending' || st.state === 'skipped'
        return (
          <li key={st.key} className="relative flex gap-3.5 pb-5 last:pb-0">
            {!last && (
              <span
                aria-hidden="true"
                className={clsx(
                  'absolute left-[0.9375rem] top-8 bottom-1 w-px',
                  muted ? 'bg-surface-800' : 'bg-surface-700'
                )}
              />
            )}
            <span
              className={clsx(
                'relative z-10 flex h-[1.875rem] w-[1.875rem] flex-none items-center justify-center rounded-full border',
                TILE[st.state]
              )}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
              {st.state === 'live' && (
                <span className="dot-live absolute inset-0 rounded-full bg-amber-500/40" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <p className={clsx('text-sm font-medium', muted ? 'text-ink-500' : 'text-ink-100')}>
                {st.label}
              </p>
              <p className="mt-0.5 text-xs text-ink-500">
                {st.at ? formatDateTime(st.at) : st.note || 'Not reached'}
                {st.at && st.note ? ` · ${st.note}` : ''}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ---------------------------------------------------------------------------

export default function JitRequestDetailPage() {
  const { id } = useParams()
  const queryClient = useQueryClient()
  const [cancelOpen, setCancelOpen] = useState(false)

  const requestQuery = useQuery({
    queryKey: ['jit', 'requests', id],
    queryFn: ({ signal }) => getJitRequest(id, signal),
    // Poll only while the request can still change state.
    refetchInterval: (query) => {
      const s = query.state.data?.status
      // PARTIALLY_APPROVED polls at the same cadence as PENDING: the second
      // approval is the event this page exists to catch.
      if (s === JIT_STATUS.PENDING || s === JIT_STATUS.PARTIALLY_APPROVED || s === JIT_STATUS.WAITING) {
        return POLL_PENDING_MS
      }
      if (s === JIT_STATUS.APPROVED) return POLL_ACTIVE_MS
      return false
    },
    refetchOnWindowFocus: true,
  })

  const request = requestQuery.data
  const status = request?.status
  const nonTerminal =
    status === JIT_STATUS.PENDING || status === JIT_STATUS.PARTIALLY_APPROVED || status === JIT_STATUS.WAITING
  const approved = status === JIT_STATUS.APPROVED

  // The grant lives on its own endpoint, the request only carries grant_id.
  // Only fetched once the request could plausibly have produced one.
  const grantsQuery = useQuery({
    queryKey: ['jit', 'grants', 'mine', { forRequest: id }],
    queryFn: ({ signal }) => listMyGrants({ pageSize: 100, signal }),
    enabled: !!request && (approved || !!request.grant_id),
    refetchInterval: approved ? POLL_ACTIVE_MS : false,
    refetchOnWindowFocus: true,
  })

  const grant =
    (grantsQuery.data?.grants || []).find(
      (g) => (request?.grant_id && g.id === request.grant_id) || g.request_id === id
    ) || null

  const grantExpired = grant?.expires_at ? new Date(grant.expires_at).getTime() <= Date.now() : false

  const cancelMutation = useMutation({
    mutationFn: (reason) => cancelJitRequest(id, reason),
    onSuccess: () => {
      toast.success('Request withdrawn')
      setCancelOpen(false)
      queryClient.invalidateQueries({ queryKey: ['jit'] })
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setCancelOpen(false)
    },
  })

  return (
    <div>
      <Link
        to="/jit"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-400 transition-colors hover:text-ink-100"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Just-in-Time Access
      </Link>

      <QueryState query={requestQuery} skeletonRows={5}>
        {(req) => {
          const breakglass = isBreakglassRequest(req)

          return (
            <>
              <PageHeader
                eyebrow={breakglass ? 'Break-glass request' : 'Access request'}
                title={
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={clsx(
                        'flex h-8 w-8 flex-none items-center justify-center rounded-lg border',
                        breakglass
                          ? 'border-red-600/30 bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300'
                          : 'border-surface-700 bg-surface-850 text-ink-400'
                      )}
                    >
                      {breakglass ? (
                        <ShieldAlert className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.75} />
                      ) : (
                        <KeyRound className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.75} />
                      )}
                    </span>
                    <span className="truncate">
                      {req?.resource_name || req?.resource_id || 'Access request'}
                    </span>
                  </span>
                }
                description={
                  breakglass
                    ? 'Emergency elevation, recorded, alerted on, and reviewable after the fact.'
                    : 'Time-boxed elevation requested through the approval workflow.'
                }
                meta={
                  <>
                    <Badge
                      className={
                        JIT_STATUS_BADGE[req?.status] || 'bg-ink-500/15 text-ink-400 ring-ink-500/30'
                      }
                    >
                      {JIT_STATUS_LABELS[req?.status] || req?.status || '-'}
                    </Badge>
                    {/* Trail is admin-only, so this counts from status alone , 
 enough to say how far along, never who. */}
                    {!breakglass && <ApprovalProgress request={req} approvals={null} />}
                    <CopyableId value={req?.id} />
                  </>
                }
                actions={
                  <LiveTicker
                    active={nonTerminal || (approved && !grantExpired)}
                    isFetching={requestQuery.isFetching || grantsQuery.isFetching}
                  />
                }
              />

              <StateBanner
                request={req}
                grant={grant}
                grantExpired={grantExpired}
                onWithdraw={() => setCancelOpen(true)}
              />

              <div className="grid gap-5 lg:grid-cols-[1fr_1.15fr]">
                <Card className="h-fit overflow-hidden">
                  <CardHeader>
                    <CardTitle icon={Timer}>Lifecycle</CardTitle>
                    {nonTerminal && (
                      <span className="ml-auto flex items-center gap-1.5 text-2xs text-ink-500">
                        <RadioTower className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                        updates automatically
                      </span>
                    )}
                  </CardHeader>
                  <Timeline request={req} grant={grant} grantExpired={grantExpired} />
                </Card>

                <div className="space-y-5">
                  <Card className="overflow-hidden">
                    <CardHeader>
                      <CardTitle icon={FileText}>Request</CardTitle>
                    </CardHeader>
                    <DetailList
                      items={[
                        { label: 'Resource', value: req?.resource_name || req?.resource_id || '-' },
                        { label: 'Type', value: breakglass ? 'Break-glass (emergency)' : 'Standard' },
                        { label: 'Action', value: req?.action || 'Any permitted action' },
                        {
                          label: 'Duration',
                          value: req?.duration_minutes ? `${req.duration_minutes} minutes` : '-',
                        },
                        {
                          label: 'Justification',
                          value: req?.reason ? (
                            <span className="block whitespace-pre-line leading-relaxed">{req.reason}</span>
                          ) : (
                            '-'
                          ),
                        },
                        { label: 'Ticket', value: req?.ticket_ref || '-' },
                        { label: 'Requested', value: formatDateTime(raisedAt(req)) },
                        ...(breakglass
                          ? []
                          : [
                              {
                                label: 'Approvals required',
                                value: 'Two different administrators, or one root approval',
                              },
                            ]),
                        ...(req?.approver_username
                          ? [{ label: 'Finalised by', value: req.approver_username }]
                          : []),
                        ...(req?.decided_at
                          ? [{ label: 'Decided', value: formatDateTime(req.decided_at) }]
                          : []),
                        ...(req?.decision_reason
                          ? [
                              {
                                label: 'Decision note',
                                value: (
                                  <span className="block whitespace-pre-line leading-relaxed">
                                    {req.decision_reason}
                                  </span>
                                ),
                              },
                            ]
                          : []),
                      ]}
                    />
                  </Card>

                  <Card className="overflow-hidden">
                    <CardHeader>
                      <CardTitle icon={Lock}>Resulting grant</CardTitle>
                      {grant?.status && (
                        <span className="ml-auto">
                          <Badge
                            className={
                              GRANT_STATUS_BADGE[grant.status] || 'bg-ink-500/15 text-ink-400 ring-ink-500/30'
                            }
                          >
                            {grant.status}
                          </Badge>
                        </span>
                      )}
                    </CardHeader>

                    {grant ? (
                      <DetailList
                        items={[
                          { label: 'Granted', value: formatDateTime(grant.granted_at) },
                          { label: 'Expires', value: formatDateTime(grant.expires_at) },
                          { label: 'Time left', value: <LiveCountdown targetIso={grant.expires_at} /> },
                          ...(grant.recording_required
                            ? [{ label: 'Recording', value: 'Sessions under this grant are recorded' }]
                            : []),
                          ...(grant.revoked_at
                            ? [
                                { label: 'Revoked', value: formatDateTime(grant.revoked_at) },
                                ...(grant.revoke_reason
                                  ? [{ label: 'Revoke reason', value: grant.revoke_reason }]
                                  : []),
                              ]
                            : []),
                        ]}
                      />
                    ) : approved && grantsQuery.isLoading ? (
                      <div className="space-y-2 p-4">
                        {[0, 1, 2].map((i) => (
                          <div key={i} className="skeleton h-8 rounded-lg" />
                        ))}
                      </div>
                    ) : (
                      <p className="px-4 py-6 text-sm leading-relaxed text-ink-500">
                        Nothing is granted yet. A grant appears here the moment this request is approved, it
                        is the object that actually carries your access, and it is what expires.
                      </p>
                    )}
                  </Card>
                </div>
              </div>

              <ConfirmDialog
                open={cancelOpen}
                title="Withdraw this request?"
                description="This withdraws the request before a decision is made. You can raise a new one later if you still need access."
                confirmLabel="Withdraw request"
                destructive
                requireReason
                reasonLabel="Reason (required for the audit record)"
                isLoading={cancelMutation.isPending}
                onConfirm={(reason) => cancelMutation.mutate(reason)}
                onCancel={() => setCancelOpen(false)}
              />
            </>
          )
        }}
      </QueryState>
    </div>
  )
}
