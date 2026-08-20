import clsx from 'clsx'
import { ChevronRight, SearchX } from 'lucide-react'
import { Badge, StatusIndicator, MetaTag } from '../common/Badge'
import { Button } from '../common/Button'
import { EmptyState } from '../common/Layout'
import { SkeletonRows } from '../common/Spinner'
import { stickyCell, stickyHeader, cell, TruncCell } from '../common/tableStyles'
import { formatDateTime } from '../../lib/format'
import { eventTime, eventActor, eventTarget, eventIp, isFailure } from './auditFields'
import { AUDIT_OUTCOME_BADGE } from '../../config/constants'

// ---------------------------------------------------------------------------
// Audit table
// ---------------------------------------------------------------------------
// An audit trail is columnar data scanned down one axis, time first, then
// outcome, then actor. So: fixed column widths sized to what each column
// actually holds, a frozen time column that keeps its own opaque background
// while the rest scrolls sideways, and truncation with the full value on
// `title` rather than columns fighting each other for width.
//
// SEVERITY IS GONE, AND THAT IS THE RIGHT CALL. It was a second verdict
// column sitting next to Outcome, and on this backend the two are almost
// perfectly correlated, practically every row is INFO, and the ones that
// aren't are already the DENIED/ERROR rows Outcome flags. So it cost a full
// column of width on every screen to restate, in a second vocabulary, a
// judgement the row already made. CloudTrail doesn't carry one. Okta's System
// Log shows severity only inside the expanded event. What actually needs to
// pop, a refusal, now has the attention rail and the outcome badge to
// itself, with nothing competing.
//
// COLOUR IS RATIONED. Outcome is populated on every row, so as a filled chip
// it produced a saturated block per row, fifty per screen, glowing in dark
// mode, drowning the content. The rule: the ORDINARY value is a quiet
// dot-and-text indicator, and only the EXCEPTIONAL one keeps a filled badge.
// A page of successes is calm and a single denial is impossible to miss,
// which is the entire job.

const OUTCOME_TONE = {
  SUCCESS: 'emerald',
  ALLOWED: 'emerald',
  PENDING: 'amber',
}

export function AuditTable({
  rows,
  loading,
  density = 'comfortable',
  onSelect,
  emptyTitle = 'No audit entries',
  emptyMessage = 'Nothing matches these filters.',
  onClearFilters,
  showActor = true,
}) {
  if (loading) {
    return (
      <div className="p-4" role="status" aria-label="Loading audit entries">
        <SkeletonRows rows={8} />
      </div>
    )
  }

  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title={emptyTitle}
        description={emptyMessage}
        action={
          onClearFilters && (
            <Button variant="secondary" onClick={onClearFilters}>
              Clear filters
            </Button>
          )
        }
      />
    )
  }

  const pad = density === 'compact' ? 'py-2' : 'py-3'

  return (
    <div className="relative overflow-x-auto overscroll-x-contain">
      <table className="w-full min-w-[54rem] table-fixed border-separate border-spacing-0 text-sm">
        <colgroup>
          <col className="w-[13.5rem]" />
          <col className="w-[21rem]" />
          {showActor && <col className="w-[11rem]" />}
          <col className="w-[14rem]" />
          <col className="w-[8.5rem]" />
          <col className="w-[9.5rem]" />
          <col className="w-12" />
        </colgroup>

        <thead>
          <tr>
            <th
              scope="col"
              className={clsx(
                stickyHeader({ left: 'left-0', edge: true }),
                'px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-ink-400'
              )}
            >
              Time
            </th>
            {['Action', showActor && 'Actor', 'Target', 'Outcome', 'Source IP'].filter(Boolean).map((h) => (
              <th
                key={h}
                scope="col"
                className="sticky top-0 z-10 whitespace-nowrap border-b border-surface-800 bg-surface-850 px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-ink-400"
              >
                {h}
              </th>
            ))}
            <th
              scope="col"
              className="sticky top-0 z-10 border-b border-surface-800 bg-surface-850 px-2 py-2.5"
            >
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>

        <tbody>
          {rows.map((e, i) => {
            const failed = isFailure(e)
            const outcome = String(e?.outcome || '').toUpperCase()
            const flagged = failed

            return (
              <tr
                key={e?.id ?? e?.sequence_number ?? i}
                onClick={() => onSelect?.(e)}
                className="group cursor-pointer"
              >
                {/* Frozen time column. Paints its own background per state , 
 the previous bg-inherit left it transparent, so columns
 scrolled visibly underneath it. */}
                <td
                  className={clsx(
                    stickyCell({ left: 'left-0', edge: true }),
                    'relative px-4',
                    pad,
                    flagged && 'group-hover:bg-red-50/70 dark:group-hover:bg-red-950/25'
                  )}
                >
                  {/* Attention rail: one denial in a page of successes must be
 findable without reading across to the outcome column. */}
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'absolute inset-y-0 left-0 w-[3px]',
                      failed ? 'bg-red-500' : 'bg-transparent'
                    )}
                  />
                  <span
                    className="block truncate text-xs tabular-nums text-ink-200"
                    title={formatDateTime(eventTime(e))}
                  >
                    {formatDateTime(eventTime(e))}
                  </span>
                  {e?.sequence_number != null && (
                    <span className="mt-0.5 block font-mono text-2xs text-ink-600">#{e.sequence_number}</span>
                  )}
                </td>

                <td
                  className={clsx(
                    cell({}),
                    'px-4',
                    pad,
                    flagged && 'group-hover:bg-red-50/70 dark:group-hover:bg-red-950/25'
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <MetaTag className="flex-none">{e?.category || 'OTHER'}</MetaTag>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-ink-100"
                      title={e?.action || undefined}
                    >
                      {e?.action || '-'}
                    </span>
                  </div>
                </td>

                {showActor && (
                  <td
                    className={clsx(
                      cell({}),
                      'px-4',
                      pad,
                      flagged && 'group-hover:bg-red-50/70 dark:group-hover:bg-red-950/25'
                    )}
                  >
                    <TruncCell value={eventActor(e)} className="text-xs text-ink-300" />
                  </td>
                )}

                <td
                  className={clsx(
                    cell({}),
                    'px-4',
                    pad,
                    flagged && 'group-hover:bg-red-50/70 dark:group-hover:bg-red-950/25'
                  )}
                >
                  <TruncCell value={eventTarget(e)} muted className="text-xs" />
                </td>

                {/* Ordinary outcomes read as indicators; refusals keep the
 badge, because they are what you are looking for. */}
                <td
                  className={clsx(
                    cell({}),
                    'px-4',
                    pad,
                    flagged && 'group-hover:bg-red-50/70 dark:group-hover:bg-red-950/25'
                  )}
                >
                  {!outcome ? (
                    <span className="text-xs text-ink-600">-</span>
                  ) : failed ? (
                    <Badge className={AUDIT_OUTCOME_BADGE[outcome]}>{outcome}</Badge>
                  ) : (
                    <StatusIndicator tone={OUTCOME_TONE[outcome] || 'neutral'}>
                      {outcome.charAt(0) + outcome.slice(1).toLowerCase()}
                    </StatusIndicator>
                  )}
                </td>

                <td
                  className={clsx(
                    cell({}),
                    'px-4',
                    pad,
                    flagged && 'group-hover:bg-red-50/70 dark:group-hover:bg-red-950/25'
                  )}
                >
                  <TruncCell value={eventIp(e)} mono muted />
                </td>

                <td
                  className={clsx(
                    cell({}),
                    'px-2',
                    pad,
                    flagged && 'group-hover:bg-red-50/70 dark:group-hover:bg-red-950/25'
                  )}
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-md text-ink-600 transition-colors group-hover:bg-surface-800 group-hover:text-ink-100">
                    <ChevronRight className="h-4 w-4" strokeWidth={2} />
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
