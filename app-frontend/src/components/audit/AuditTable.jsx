import clsx from 'clsx'
import { DataTable, SkeletonGrid, Td, Th, Tr, Trunc } from '../ui/grid'
import { Meta, StatusDot } from '../ui/bits'
import { NoMatchState } from '../ui/states'
import { formatDateTime } from '../../lib/format'
import { eventTime, eventActor, eventTarget, eventIp, isFailure } from './auditFields'

// ---------------------------------------------------------------------------
// Audit table
// ---------------------------------------------------------------------------
// An audit trail is columnar data scanned down one axis: time first, then
// outcome, then actor. So the time column is frozen and paints its own
// background, widths are sized to what each column actually holds, and every
// cell truncates with the full value on `title` rather than columns fighting
// each other for room.
//
// SEVERITY IS NOT A COLUMN. It was a second verdict sitting next to Outcome,
// and on this backend the two are almost perfectly correlated: nearly every
// row is INFO, and the ones that are not are already the DENIED and ERROR
// rows that Outcome flags. It cost a full column on every screen to restate a
// judgement the row had already made. CloudTrail carries none; Okta's System
// Log shows severity only inside the expanded event.
//
// COLOUR IS RATIONED. Outcome is populated on every row, so as a filled chip
// it produced one saturated block per row and fifty per screen. The ordinary
// value is a quiet dot and its word; a refusal additionally gets a red rail
// on the frozen column, so one denial in a page of successes is findable
// without reading across to the outcome column.

const OUTCOME_TONE = {
  SUCCESS: 'ok',
  ALLOWED: 'ok',
  PENDING: 'warn',
  DENIED: 'danger',
  ERROR: 'danger',
  FAILURE: 'danger',
}

export function AuditTable({
  rows,
  loading,
  onSelect,
  emptyTitle = 'No audit entries',
  emptyMessage = 'Nothing matches these filters.',
  onClearFilters,
  showActor = true,
}) {
  const cols = showActor ? 7 : 6

  if (loading) {
    return (
      <table className="w-full">
        <tbody>
          <SkeletonGrid colSpan={cols} rows={10} />
        </tbody>
      </table>
    )
  }

  if (!rows || rows.length === 0) {
    return <NoMatchState title={emptyTitle} description={emptyMessage} onClear={onClearFilters} />
  }

  return (
    <DataTable minWidth="56rem" label="Audit events">
      <colgroup>
        <col className="w-[13rem]" />
        <col className="w-[18rem]" />
        {showActor && <col className="w-[9rem]" />}
        <col className="w-[13rem]" />
        <col className="w-[8rem]" />
        <col className="w-[8rem]" />
      </colgroup>

      <thead>
        <tr>
          <Th sticky edge>
            Time
          </Th>
          <Th>Action</Th>
          {showActor && <Th>Actor</Th>}
          <Th>Target</Th>
          <Th>Outcome</Th>
          <Th>Source IP</Th>
        </tr>
      </thead>

      <tbody>
        {rows.map((e, i) => {
          const failed = isFailure(e)
          const outcome = String(e?.outcome || '').toUpperCase()
          return (
            <Tr key={e?.id ?? e?.sequence_number ?? i} onClick={() => onSelect?.(e)}>
              <Td
                sticky
                edge
                className={clsx('relative', failed && 'shadow-[inset_3px_0_0_0_rgb(var(--danger))]')}
              >
                <span
                  className="block truncate text-sm tabular text-primary"
                  title={formatDateTime(eventTime(e))}
                >
                  {formatDateTime(eventTime(e))}
                </span>
              </Td>

              <Td>
                <div className="flex min-w-0 items-center gap-2">
                  <Meta className="flex-none">{e?.category || 'OTHER'}</Meta>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs text-primary"
                    title={e?.action || undefined}
                  >
                    {e?.action || '-'}
                  </span>
                </div>
              </Td>

              {showActor && (
                <Td>
                  <Trunc value={eventActor(e)} muted />
                </Td>
              )}

              <Td>
                <Trunc value={eventTarget(e)} mono muted />
              </Td>

              <Td>
                <StatusDot
                  tone={OUTCOME_TONE[outcome] || 'muted'}
                  label={outcome ? outcome.charAt(0) + outcome.slice(1).toLowerCase() : 'Unknown'}
                />
              </Td>

              <Td>
                <Trunc value={eventIp(e)} mono muted />
              </Td>
            </Tr>
          )
        })}
      </tbody>
    </DataTable>
  )
}
