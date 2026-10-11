import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  KeyRound,
  ShieldAlert,
  ShieldCheck,
  ScrollText,
  ArrowRight,
  Activity,
  UsersRound,
} from 'lucide-react'
import {
  listJitRequests,
  listBreakglass,
  listAudit,
  verifyAudit,
  approveJitRequest,
  denyJitRequest,
} from '../../api/admin'
import { PageHeader, Card, CardHeader, CardTitle, Section } from '../../components/common/Layout'
import { Button } from '../../components/common/Button'
import { QueryState } from '../../components/common/QueryState'
import { KpiStrip, KpiCell } from '../../components/common/KpiStrip'
import { Badge } from '../../components/common/Badge'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { Spinner } from '../../components/common/Spinner'
import { formatDateTime } from '../../lib/format'
import { apiErrorMessage } from '../../lib/apiError'
import { useAuthStore } from '../../store/authStore'
import {
  approveBlockedReason,
  approveButtonLabel,
  approveConsequence,
  readApproveResult,
  approveResultMessage,
  approvalErrorMessage,
  isStaleStateError,
  viewerIdOf, userFacingNext } from '../../lib/fourEyes'
import { ApprovalProgress } from '../../components/jit/ApprovalTrail'
import {
  JIT_STATUS,
  JIT_STATUS_BADGE,
  JIT_STATUS_LABELS,
  AUDIT_OUTCOME_BADGE,
  AUDIT_SEVERITY_BADGE,
} from '../../config/constants'

// Requester/resource field names on the admin JIT list aren't pinned down
// either, same defensive-lookup approach as AuditPage's actorLabel/targetLabel.
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

// FOUR-EYES. This row is a shortcut into the real queue, so it carries only
// the two things that change what the button means: how many of the two
// approvals exist, and whether this viewer is allowed to give the next one.
// The named trail lives on the JIT Approvals page, that is the surface for
// actually deciding.
function PendingRequestRow({ request, onApprove, onDeny, isMutating, viewer }) {
  const blocked = approveBlockedReason(request, null, viewer)
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink-100">
          {request?.resource_name || request?.resource_id || '-'}
          <span className="ml-2 text-xs font-normal text-ink-500">by {requesterLabel(request)}</span>
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-500">
          Requested {formatDateTime(request?.created_at)}
          {request?.reason ? ` · ${request.reason}` : ''}
        </p>
      </div>
      <div className="flex flex-none items-center gap-2">
        <ApprovalProgress request={request} approvals={null} showLabel={false} />
        <Badge className={JIT_STATUS_BADGE[request?.status] || 'bg-ink-500/15 text-ink-400 ring-ink-500/30'}>
          {JIT_STATUS_LABELS[request?.status] || request?.status || '-'}
        </Badge>
        <button
          onClick={() => onApprove(request)}
          disabled={isMutating || !!blocked}
          title={blocked || undefined}
          className="h-7 rounded-lg bg-blue-600 px-2.5 text-xs font-medium text-white shadow-sm ring-1 ring-inset ring-blue-500/50 transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:opacity-60"
        >
          {approveButtonLabel(request, null, viewer)}
        </button>
        <button
          onClick={() => onDeny(request)}
          disabled={isMutating}
          className="rounded-lg border border-red-300 transition-colors dark:border-red-900/50 px-2.5 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-60"
        >
          Deny
        </button>
      </div>
    </li>
  )
}

function VerifyChainBanner({ result, isPending }) {
  if (isPending) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-surface-700/70 bg-surface-850/60 p-4 text-sm text-ink-400">
        <Spinner size="h-4 w-4" /> Verifying audit chain…
      </div>
    )
  }
  if (!result) return null

  const knownField =
    'valid' in result
      ? 'valid'
      : 'chain_valid' in result
        ? 'chain_valid'
        : 'intact' in result
          ? 'intact'
          : 'success' in result
            ? 'success'
            : null
  const isValid = knownField ? Boolean(result[knownField]) : null

  return (
    <div
      className={
        'flex items-start gap-3 rounded-lg border p-4 ' +
        (isValid === false
          ? 'border-red-400 dark:border-red-600/60 bg-red-50 dark:bg-red-950/40'
          : isValid === true
            ? 'border-emerald-300 dark:border-emerald-600/40 bg-emerald-50 dark:bg-emerald-950/20'
            : 'border-surface-800 bg-surface-900')
      }
    >
      {isValid === false && (
        <ShieldAlert className="mt-0.5 h-5 w-5 flex-none text-red-600 dark:text-red-400" />
      )}
      {isValid === true && (
        <ShieldCheck className="mt-0.5 h-5 w-5 flex-none text-emerald-600 dark:text-emerald-400" />
      )}
      <div className="min-w-0">
        {isValid === true && (
          <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
            Audit chain intact, no tampering detected.
          </p>
        )}
        {isValid === false && (
          <p className="text-sm font-semibold text-red-700 dark:text-red-300">
            Audit chain broken, investigate immediately. Notify a security administrator.
          </p>
        )}
        {isValid === null && (
          <>
            <p className="mb-1 text-sm font-medium text-ink-100">Verification result</p>
            <pre className="max-w-full overflow-x-auto text-xs text-ink-400">
              {JSON.stringify(result, null, 2)}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}

export default function AdminOverviewPage() {
  const queryClient = useQueryClient()
  const [approveTarget, setApproveTarget] = useState(null)
  const [denyTarget, setDenyTarget] = useState(null)

  const user = useAuthStore((s) => s.user)
  const isRoot = useAuthStore((s) => s.isRoot())
  const viewer = useMemo(() => ({ id: viewerIdOf(user), isRoot }), [user, isRoot])

  const pendingCountQuery = useQuery({
    queryKey: ['admin', 'jit-requests', 'pending-count'],
    queryFn: ({ signal }) => listJitRequests({ page: 1, page_size: 1, status: 'PENDING' }, signal),
  })

  // The half-approved ones are counted and listed separately: since four-eyes
  // they are a different kind of work, one click from live access, waiting on
  // a specific second person, and folding them into "pending" would make the
  // "needs attention" number describe two unlike things.
  const secondApprovalCountQuery = useQuery({
    queryKey: ['admin', 'jit-requests', 'second-approval-count'],
    queryFn: ({ signal }) =>
      listJitRequests({ page: 1, page_size: 1, status: JIT_STATUS.PARTIALLY_APPROVED }, signal),
    retry: false,
  })

  const secondApprovalListQuery = useQuery({
    queryKey: ['admin', 'jit-requests', 'second-approval-list'],
    queryFn: ({ signal }) =>
      listJitRequests({ page: 1, page_size: 5, status: JIT_STATUS.PARTIALLY_APPROVED }, signal),
    retry: false,
  })

  const breakglassCountQuery = useQuery({
    queryKey: ['admin', 'breakglass', 'count'],
    queryFn: ({ signal }) => listBreakglass({ page: 1, page_size: 1 }, signal),
  })

  const pendingListQuery = useQuery({
    queryKey: ['admin', 'jit-requests', 'pending-list'],
    queryFn: ({ signal }) => listJitRequests({ page: 1, page_size: 5, status: 'PENDING' }, signal),
  })

  const deniedAuditQuery = useQuery({
    queryKey: ['admin', 'audit', 'denied-feed'],
    queryFn: ({ signal }) => listAudit({ page: 1, page_size: 5, outcome: 'DENIED' }, signal),
  })

  const verifyMutation = useMutation({
    mutationFn: () => verifyAudit(),
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const invalidatePending = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'jit-requests'] })
  }

  const approveMutation = useMutation({
    mutationFn: ({ id, reason }) => approveJitRequest(id, reason),
    onSuccess: (data) => {
      const result = readApproveResult(data)
      toast.success(approveResultMessage(result), {
        description: result.partial
          ? userFacingNext(result.next) ||
            'A second, different admin, or root, must approve to issue the grant.'
          : undefined,
      })
      setApproveTarget(null)
      invalidatePending()
    },
    onError: (err) => {
      toast.error(approvalErrorMessage(err, apiErrorMessage(err)))
      setApproveTarget(null)
      if (isStaleStateError(err)) invalidatePending()
    },
  })

  const denyMutation = useMutation({
    mutationFn: ({ id, reason }) => denyJitRequest(id, reason),
    onSuccess: () => {
      toast.success('Request denied')
      setDenyTarget(null)
      invalidatePending()
    },
    onError: (err) => {
      toast.error(approvalErrorMessage(err, apiErrorMessage(err)))
      setDenyTarget(null)
      if (isStaleStateError(err)) invalidatePending()
    },
  })

  const pendingApprovalsTotal = pendingCountQuery.data?.pagination?.total ?? 0
  const secondApprovalTotal = secondApprovalCountQuery.data?.pagination?.total ?? 0

  // listBreakglass returns { requests, pagination, grants }, "active
  // break-glass" most plausibly means live break-glass grants, so prefer
  // counting the `grants` array (filtered to ACTIVE where a status field
  // exists) and fall back to the request pagination total if `grants`
  // isn't present in this deployment's response.
  const bgData = breakglassCountQuery.data
  const activeBreakglassCount = Array.isArray(bgData?.grants)
    ? bgData.grants.filter((g) => !g?.status || g.status === 'ACTIVE').length
    : (bgData?.pagination?.total ?? 0)

  const isMutatingJit = approveMutation.isPending || denyMutation.isPending

  const approvalQueue = useMemo(
    () => [...(secondApprovalListQuery.data?.requests || []), ...(pendingListQuery.data?.requests || [])],
    [secondApprovalListQuery.data, pendingListQuery.data]
  )

  return (
    <div>
      <PageHeader
        eyebrow="Admin Center"
        title="Needs attention"
        description="What's waiting on you right now, pending approvals, break-glass activity, and audit chain integrity. For overall org stats, see the main Dashboard."
      />

      <KpiStrip columns={4}>
        <KpiCell
          label="Pending approvals"
          icon={KeyRound}
          tone="amber"
          loading={pendingCountQuery.isLoading}
          value={pendingApprovalsTotal}
          description="Nobody has approved these yet"
          to="/admin/jit"
        />
        {/* Its own tile, not folded into the one above. A request one approval
 short is the cheapest work on this page, a single different admin
 clears it, and burying it in a combined total is how it sits for a
 day next to requests that nobody has looked at. */}
        <KpiCell
          label="Needs 2nd approval"
          icon={UsersRound}
          tone={secondApprovalTotal > 0 ? 'blue' : 'default'}
          loading={secondApprovalCountQuery.isLoading}
          value={secondApprovalTotal}
          description="One approval in, waiting on a different admin"
          to="/admin/jit"
        />
        <KpiCell
          label="Active break-glass"
          icon={ShieldAlert}
          tone="red"
          loading={breakglassCountQuery.isLoading}
          value={activeBreakglassCount}
          description="Emergency access in use"
          to="/admin/jit"
        />
        <KpiCell
          label="Chain status"
          icon={ShieldCheck}
          tone={verifyMutation.data ? (chainToneFor(verifyMutation.data) ?? 'default') : 'default'}
          loading={verifyMutation.isPending}
          value={verifyMutation.data ? chainLabelFor(verifyMutation.data) : 'Not checked'}
          description="Run the check below"
        />
      </KpiStrip>

      <Section label="Queues" className="mt-9">
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader className="justify-between">
              <CardTitle icon={KeyRound}>JIT approvals</CardTitle>
              <Link
                to="/admin/jit"
                className="group inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
              >
                View all
                <ArrowRight
                  className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
                  strokeWidth={2}
                />
              </Link>
            </CardHeader>
            <QueryState
              query={pendingListQuery}
              empty={() => approvalQueue.length === 0}
              emptyTitle="Queue clear"
              emptyMessage="No JIT requests are waiting on a decision."
            >
              {() => (
                <ul className="divide-y divide-surface-800">
                  {/* Half-approved first: closest to done, and the one an admin
 can finish in a single click. */}
                  {approvalQueue.map((r) => (
                    <PendingRequestRow
                      key={r.id}
                      request={r}
                      viewer={viewer}
                      isMutating={isMutatingJit}
                      onApprove={setApproveTarget}
                      onDeny={setDenyTarget}
                    />
                  ))}
                </ul>
              )}
            </QueryState>
          </Card>

          <Card>
            <CardHeader className="justify-between">
              <CardTitle icon={ScrollText}>Recently denied activity</CardTitle>
              <Link
                to="/admin/audit"
                className="group inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
              >
                View all
                <ArrowRight
                  className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
                  strokeWidth={2}
                />
              </Link>
            </CardHeader>
            <QueryState
              query={deniedAuditQuery}
              empty={(d) => !d?.events || d.events.length === 0}
              emptyTitle="Nothing denied recently"
              emptyMessage="Denied and blocked actions surface here as soon as they are recorded."
            >
              {(data) => (
                <ul className="divide-y divide-surface-800">
                  {data.events.map((e, idx) => (
                    <li key={e?.id ?? idx} className="px-4 py-3.5 transition-colors hover:bg-surface-850">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-100">
                        <span className="rounded border border-surface-700 bg-surface-850 px-1.5 py-0.5 text-xs font-semibold text-ink-500">
                          {e?.category || 'OTHER'}
                        </span>
                        <span className="font-mono text-xs">{e?.action || '-'}</span>
                        {e?.outcome && (
                          <Badge
                            className={
                              AUDIT_OUTCOME_BADGE[e.outcome] || 'bg-ink-500/15 text-ink-400 ring-ink-500/30'
                            }
                          >
                            {e.outcome}
                          </Badge>
                        )}
                        {e?.severity && (
                          <Badge
                            className={
                              AUDIT_SEVERITY_BADGE[e.severity] || 'bg-ink-500/15 text-ink-400 ring-ink-500/30'
                            }
                          >
                            {e.severity}
                          </Badge>
                        )}
                      </p>
                      <p className="mt-1 truncate text-xs text-ink-500">
                        {formatDateTime(e?.occurred_at || e?.created_at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </QueryState>
          </Card>
        </div>
      </Section>

      <Section label="Integrity">
        <Card>
          <CardHeader className="justify-between">
            <CardTitle icon={Activity}>Audit chain integrity</CardTitle>
            <Button
              size="sm"
              variant="secondary"
              icon={ShieldCheck}
              loading={verifyMutation.isPending}
              onClick={() => verifyMutation.mutate()}
            >
              Verify audit chain
            </Button>
          </CardHeader>
          <div className="p-4">
            {verifyMutation.isSuccess || verifyMutation.isPending ? (
              <VerifyChainBanner result={verifyMutation.data} isPending={verifyMutation.isPending} />
            ) : (
              <p className="text-xs leading-relaxed text-ink-500">
                Checks that org-wide audit entries form an unbroken, tamper-evident chain. Not run
                automatically , trigger it explicitly.
              </p>
            )}
          </div>
        </Card>
      </Section>

      <ConfirmDialog
        open={!!approveTarget}
        title={`Approve request for "${approveTarget?.resource_name || approveTarget?.resource_id || 'this resource'}"?`}
        description={approveConsequence(approveTarget, null, viewer)}
        confirmLabel={approveButtonLabel(approveTarget, null, viewer)}
        destructive={false}
        reasonLabel="Reason (optional)"
        isLoading={approveMutation.isPending}
        onConfirm={(reason) => approveMutation.mutate({ id: approveTarget.id, reason })}
        onCancel={() => setApproveTarget(null)}
      />

      <ConfirmDialog
        open={!!denyTarget}
        title={`Deny request for "${denyTarget?.resource_name || denyTarget?.resource_id || 'this resource'}"?`}
        description="One denial ends this request, unlike approval, it does not wait for a second person. The requester will need to submit a new one if access is still needed."
        confirmLabel="Deny"
        destructive
        requireReason
        reasonLabel="Reason for denial (required for the audit record)"
        isLoading={denyMutation.isPending}
        onConfirm={(reason) => denyMutation.mutate({ id: denyTarget.id, reason })}
        onCancel={() => setDenyTarget(null)}
      />
    </div>
  )
}

// Same defensive field-name probing as VerifyChainBanner, reused for the
// KPI cell so the tone/label agree with the banner underneath it.
function chainKnownField(result) {
  if (!result) return null
  if ('valid' in result) return 'valid'
  if ('chain_valid' in result) return 'chain_valid'
  if ('intact' in result) return 'intact'
  if ('success' in result) return 'success'
  return null
}
function chainToneFor(result) {
  const field = chainKnownField(result)
  if (!field) return 'default'
  return result[field] ? 'emerald' : 'red'
}
function chainLabelFor(result) {
  const field = chainKnownField(result)
  if (!field) return 'Checked'
  return result[field] ? 'Intact' : 'Broken'
}
