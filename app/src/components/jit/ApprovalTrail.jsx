import clsx from 'clsx'
import { Check, X, Crown, ShieldCheck, Hourglass } from 'lucide-react'
import { Avatar } from '../common/UserMenu'
import { formatDateTime, formatRelativeToNow } from '../../lib/format'
import {
  approvalProgress,
  isApproval,
  isRootApproval,
  approverIdOf,
  REQUIRED_APPROVALS,
} from '../../lib/fourEyes'
import { approverRankLabel, JIT_STATUS } from '../../config/constants'

// ---------------------------------------------------------------------------
// The four-eyes trail
// ---------------------------------------------------------------------------
// Dual control only works if the second approver can SEE that they are the
// second one, and see who went first. Every enterprise implementation of this
// (SAP's dual control, CyberArk's multi-level workflow, GCP's multi-party
// approval) renders the same two things and so does this:
//
//   1. A PROGRESS INDICATOR, how many of the required approvals exist, and
// whether the one that exists came from root (which makes it final).
//   2. A NAMED TRAIL, who, at what rank, when, and what they wrote. The
// names matter: "1 of 2" tells the second approver nothing about whether
// the first was their own colleague or themselves an hour ago.
//
// Both are shared components rather than markup on one page, because the
// queue card, the queue's drawer, the requester's own detail page and the
// dashboard all show a version of this and they must not disagree.

// --- progress --------------------------------------------------------------

/**
 * Two-slot pill: filled for each approval given, hollow for each one still
 * needed. Root's approval fills both slots at once, it IS the quorum.
 */
export function ApprovalProgress({ request, approvals, className, showLabel = true }) {
  const progress = approvalProgress(request, approvals)

  // Break-glass has no approvers at all; a "0 of 2" pill on one would be a
  // straight lie about how that request gets granted.
  if (request?.status === JIT_STATUS.WAITING) return null

  const filled = progress.finalisedByRoot ? REQUIRED_APPROVALS : Math.min(progress.given, REQUIRED_APPROVALS)
  const complete = progress.quorum

  return (
    <span
      className={clsx('inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium', className)}
      title={
        progress.finalisedByRoot
          ? 'Approved by root, a root approval is final on its own'
          : `${progress.given} of ${REQUIRED_APPROVALS} required approvals`
      }
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        {Array.from({ length: REQUIRED_APPROVALS }, (_, i) => (
          <span
            key={i}
            className={clsx(
              'h-1.5 w-4 rounded-full transition-colors',
              i < filled ? (complete ? 'bg-emerald-500' : 'bg-blue-500') : 'bg-surface-700'
            )}
          />
        ))}
      </span>
      {showLabel && (
        <span className={clsx(complete ? 'text-emerald-700 dark:text-emerald-400' : 'text-ink-400')}>
          {progress.finalisedByRoot && progress.given <= 1
            ? 'root approval, final'
            : `${progress.given} of ${REQUIRED_APPROVALS} approvals`}
        </span>
      )}
    </span>
  )
}

// --- one row ---------------------------------------------------------------

function ApprovalRow({ row, isViewer }) {
  const approved = isApproval(row)
  const root = isRootApproval(row)
  const Icon = approved ? Check : X
  const name = row?.approver_username || approverIdOf(row) || 'Unknown approver'

  return (
    <li className="flex gap-3 px-4 py-3">
      <span
        className={clsx(
          'mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full ring-1 ring-inset',
          approved
            ? 'bg-emerald-50 text-emerald-600 ring-emerald-600/25 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25'
            : 'bg-red-50 text-red-600 ring-red-600/25 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25'
        )}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2.4} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-semibold text-ink-50">{name}</span>
          {isViewer && (
            <span className="rounded bg-surface-800 px-1.5 py-0.5 text-2xs font-medium text-ink-400">
              you
            </span>
          )}
          <span className="text-ink-500">{approved ? 'approved' : 'denied'}</span>
          <span
            className={clsx(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.04em] ring-1 ring-inset',
              root
                ? 'text-amber-700 ring-amber-600/25 dark:text-amber-300 dark:ring-amber-500/30'
                : 'text-ink-400 ring-surface-700'
            )}
            title={
              root ? 'A root approval satisfies four-eyes on its own' : 'Admin approval, two are required'
            }
          >
            {root ? (
              <Crown className="h-3 w-3" strokeWidth={2} />
            ) : (
              <ShieldCheck className="h-3 w-3" strokeWidth={2} />
            )}
            {approverRankLabel(row?.approver_rank)}
          </span>
        </p>

        {row?.reason && (
          <blockquote className="mt-1.5 border-l-2 border-surface-700 pl-2.5 text-sm leading-relaxed text-ink-300">
            {row.reason}
          </blockquote>
        )}

        <p className="mt-1 text-xs text-ink-500" title={formatDateTime(row?.created_at)}>
          {formatRelativeToNow(row?.created_at)}
          {row?.source_ip ? ` · from ${row.source_ip}` : ''}
        </p>
      </div>
    </li>
  )
}

// --- the trail -------------------------------------------------------------

/**
 * The ordered decision trail plus, while the request is still open, the empty
 * slot that is waiting to be filled. The empty slot is the point: it is what
 * tells the reader the request is not finished and what it is waiting for.
 *
 * `approvals === null` means the trail was not loaded (it only exists on the
 * admin detail endpoint), say so rather than rendering an empty list, which
 * would read as "nobody has approved".
 */
export function ApprovalTrail({ request, approvals, viewerId, className }) {
  if (request?.status === JIT_STATUS.WAITING) return null

  if (approvals === null || approvals === undefined) {
    return (
      <p className={clsx('px-4 py-5 text-sm leading-relaxed text-ink-500', className)}>
        The approval trail is only returned on the full request record, open this request from the approvals
        queue to see who has already decided.
      </p>
    )
  }

  const progress = approvalProgress(request, approvals)
  const open =
    !progress.quorum &&
    !progress.deniedBy &&
    (request?.status === JIT_STATUS.PENDING || request?.status === JIT_STATUS.PARTIALLY_APPROVED)

  if (approvals.length === 0 && !open) {
    return <p className={clsx('px-4 py-5 text-sm text-ink-500', className)}>Nobody acted on this request.</p>
  }

  return (
    <ul className={clsx('divide-y divide-surface-800', className)}>
      {approvals.map((row, i) => (
        <ApprovalRow key={row?.id || i} row={row} isViewer={!!viewerId && approverIdOf(row) === viewerId} />
      ))}

      {open && (
        <li className="flex gap-3 px-4 py-3">
          <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full border border-dashed border-surface-600 text-ink-600">
            <Hourglass className="h-3.5 w-3.5" strokeWidth={1.9} />
          </span>
          <div className="min-w-0 flex-1 pt-1">
            <p className="text-sm font-medium text-ink-400">
              {progress.given >= 1 ? 'Second approval outstanding' : 'No decision yet'}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
              {progress.given >= 1
                ? 'A different admin, or root, has to approve before any access is granted.'
                : 'Two different admins must approve, or one root approval, before a grant is issued.'}
            </p>
          </div>
        </li>
      )}
    </ul>
  )
}

/**
 * A compact stack of who has approved, for a queue row where the full trail
 * would not fit. Renders nothing when there is nothing to show, so a caller
 * can drop it in unconditionally.
 */
export function ApproverStack({ approvals, viewerId, className }) {
  const rows = (approvals || []).filter(isApproval)
  if (rows.length === 0) return null

  return (
    <span className={clsx('inline-flex items-center gap-1.5', className)}>
      <span className="flex -space-x-1.5">
        {rows.slice(0, 3).map((row, i) => (
          <Avatar
            key={row?.id || i}
            name={row?.approver_username || approverIdOf(row) || '?'}
            size="sm"
            className="h-6 w-6 rounded-md text-[0.6rem] ring-2 ring-surface-900"
          />
        ))}
      </span>
      <span className="truncate text-xs text-ink-500">
        {rows
          .map((row) =>
            viewerId && approverIdOf(row) === viewerId
              ? 'you'
              : row?.approver_username || approverIdOf(row) || 'unknown'
          )
          .join(', ')}
      </span>
    </span>
  )
}
