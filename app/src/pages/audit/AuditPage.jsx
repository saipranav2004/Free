import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, ShieldCheck, FileSearch } from 'lucide-react'
import { searchAudit } from '../../api/audit'
import { verifyAudit } from '../../api/admin'
import { useAuthStore } from '../../store/authStore'
import { Container, PageTitle, Stack } from '../../components/ui/layout'
import { StatusDot } from '../../components/ui/bits'
import { Button } from '../../components/common/Button'
import { AuditFilterBar, EMPTY_AUDIT_FILTERS } from '../../components/audit/AuditFilterBar'
import { AuditTable } from '../../components/audit/AuditTable'
import { AuditEventDrawer } from '../../components/audit/AuditEventDrawer'
import { ReportBuilder } from '../../components/audit/ReportBuilder'
import { resolveRange, refineRows, isFailure, AUDIT_CSV_COLUMNS } from '../../components/audit/auditFields'
import { exportRowsToCsv, exportRowsToJson } from '../../lib/exportRows'
import { apiErrorMessage } from '../../lib/apiError'

const PAGE_SIZES = [20, 50, 100]

// ---------------------------------------------------------------------------
// Audit, your own trail
// ---------------------------------------------------------------------------
// Rebuilt as an investigation surface rather than a feed. The three things
// that make it one: a real date range, a columnar table, and a detail drawer
// that doesn't blank the list behind it.
//
// SEARCH SEMANTICS (this was a genuine bug, kept fixed here): the box is
// wired to `q`, audit_query_service.go's full-text search, NOT to `action`,
// which is an EXACT match on strings like "pam:vault:Reveal". Typing anything
// other than a perfectly-formed action string into an `action` param returns
// zero rows regardless of what you typed, which is what "search doesn't work"
// meant. Exact-action matching is still available, but as its own labelled
// field under More.
export default function AuditPage() {
  const isAdmin = useAuthStore((s) => s.isAdmin())
  const user = useAuthStore((s) => s.user)
  // THIS PAGE IS SCOPED TO YOU, and until now it was not.
  //
  // GET /pam/audit accepts a user_id parameter and the console never sent it,
  // while the seeded `user` role holds pam:audit:Read on `*`. The result was
  // a page titled "your activity" that rendered the whole organisation's
  // trail. Sending the caller's own id is the client half of the fix; the
  // server not scoping by caller is the other half and is item 1 on the
  // backend list in design/05-redesigns.md.
  //
  // An administrator keeps the unscoped view here, because for them this
  // screen and Admin Center, Audit and Compliance are the same data and the
  // scoped one would be the surprising default.
  const viewerId = user?.user_id || user?.id || null
  const scopeToViewer = !isAdmin && !!viewerId
  const [filters, setFilters] = useState(EMPTY_AUDIT_FILTERS)
  const [offset, setOffset] = useState(0)
  const [limit, setLimit] = useState(20)
  const [reportOpen, setReportOpen] = useState(false)
  const [selected, setSelected] = useState(null)

  // Any filter change invalidates the current offset, "offset 60" inside a
  // freshly-filtered set of 10 rows renders an empty page.
  const set = useCallback((key, value) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setOffset(0)
  }, [])

  const reset = useCallback(() => {
    setFilters(EMPTY_AUDIT_FILTERS)
    setOffset(0)
  }, [])

  const { fromISO, toISO } = useMemo(
    () => resolveRange(filters.range, filters.from, filters.to),
    [filters.range, filters.from, filters.to]
  )

  const query = useQuery({
    queryKey: ['audit', 'search', filters, offset, limit, scopeToViewer ? viewerId : 'org'],
    queryFn: ({ signal }) =>
      searchAudit(
        {
          user_id: scopeToViewer ? viewerId : undefined,
          q: filters.q || undefined,
          category: filters.category || undefined,
          outcome: filters.outcome || undefined,
          action: filters.action || undefined,
          actor: filters.actor || undefined,
          from: fromISO || undefined,
          to: toISO || undefined,
          limit,
          offset,
        },
        signal
      ),
    placeholderData: (prev) => prev,
  })

  const serverRows = useMemo(() => query.data?.items || [], [query.data])

  // Client backstop for the params this backend isn't confirmed to accept ,
  // see auditFields.refineRows for exactly why it exists even though every
  // filter is also sent to the server.
  const rows = useMemo(
    () => refineRows(serverRows, filters, fromISO, toISO),
    [serverRows, filters, fromISO, toISO]
  )
  const trimmed = serverRows.length - rows.length

  const total = query.data?.total ?? 0
  const pageLimit = query.data?.limit ?? limit
  const rangeStart = total === 0 ? 0 : offset + 1
  const rangeEnd = Math.min(offset + pageLimit, total)
  const canPrev = offset > 0
  const canNext = offset + pageLimit < total

  const failedOnPage = rows.filter(isFailure).length

  const verifyMutation = useMutation({
    mutationFn: () => verifyAudit(),
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  // The verification payload's field naming isn't pinned down anywhere we
  // have access to, probe the plausible booleans, and show the raw JSON
  // rather than silently dropping a security signal we couldn't parse.
  const vr = verifyMutation.data
  const vField =
    vr &&
    ('valid' in vr
      ? 'valid'
      : 'chain_valid' in vr
        ? 'chain_valid'
        : 'intact' in vr
          ? 'intact'
          : 'success' in vr
            ? 'success'
            : null)
  const vIsValid = vField ? Boolean(vr[vField]) : null

  return (
    <Stack gap="lg">
      <PageTitle
        title={scopeToViewer ? 'My activity' : 'Activity'}
        counter={query.isSuccess ? total : undefined}
        description={
          scopeToViewer
            ? 'Everything recorded against your account: sign-ins, connections, reveals and requests. Entries are written to a tamper evident hash chain and can never be edited or deleted.'
            : 'Every action recorded in this organisation, written to a tamper evident hash chain.'
        }
        actions={
          <Button
            variant={reportOpen ? 'subtle' : 'secondary'}
            icon={FileSearch}
            onClick={() => setReportOpen((v) => !v)}
            aria-expanded={reportOpen}
          >
            Generate report
          </Button>
        }
      />

      {/* THE KPI STRIP IS GONE. It carried three plates: events matched,
          denied on this page, and chain integrity. The first restates the
          count already beside the title, the second is a filter away, and the
          third read "Not checked" for every non-administrator because the
          verification route is admin only, so a third of the page was spent
          telling most readers about a control they cannot run.
          What survives is one line: the two numbers worth glancing at, and
          the verify control, only for the account that can use it. */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-y border-line-soft py-3">
        <span className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular text-primary">{total.toLocaleString()}</span>
          <span className="text-sm text-secondary">events match</span>
        </span>
        {failedOnPage > 0 && (
          <span className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular text-danger">{failedOnPage}</span>
            <span className="text-sm text-secondary">denied or failed on this page</span>
          </span>
        )}
        {isAdmin && (
          <span className="ml-auto flex items-center gap-3">
            {verifyMutation.isSuccess && (
              <StatusDot
                tone={vIsValid === true ? 'ok' : vIsValid === false ? 'danger' : 'warn'}
                label={
                  vIsValid === true
                    ? 'Chain intact, no tampering detected'
                    : vIsValid === false
                      ? 'Chain broken, notify a security administrator'
                      : 'Verification returned an unexpected shape'
                }
              />
            )}
            <Button
              size="sm"
              variant="subtle"
              icon={ShieldCheck}
              loading={verifyMutation.isPending}
              onClick={() => verifyMutation.mutate()}
              title="Walks the whole organisation chain and confirms every entry links to the one before it"
            >
              Verify chain
            </Button>
          </span>
        )}
      </div>

      {reportOpen && <ReportBuilder filters={filters} onClose={() => setReportOpen(false)} />}

      <AuditFilterBar
        filters={filters}
        set={set}
        reset={reset}
        onRefresh={() => query.refetch()}
        isFetching={query.isFetching}
        updatedAt={query.dataUpdatedAt}
        exportCount={rows.length}
        onExportCsv={() => exportRowsToCsv(rows, AUDIT_CSV_COLUMNS, 'audit-events')}
        onExportJson={() => exportRowsToJson(rows, AUDIT_CSV_COLUMNS, 'audit-events')}
        resultLabel={`${total.toLocaleString()} matching`}
      />

      {/* The filter bar is the top of THIS container, not a card of its own , 
 two stacked bordered panels made the filters look heavier than the
 data they filter. */}
      <Container padded={false} className="rounded-t-none border-t-0">
        {query.isError ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-semibold text-red-700 dark:text-red-300">
              Couldn&apos;t load the audit trail
            </p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-ink-400">
              {apiErrorMessage(query.error)}
            </p>
            <Button size="sm" variant="secondary" className="mt-4" onClick={() => query.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <AuditTable
              rows={rows}
              loading={query.isLoading}
              onSelect={setSelected}
              emptyTitle="No audit entries"
              emptyMessage="Nothing matches these filters. Widen the date range, or clear the category and outcome."
              onClearFilters={reset}
            />

            {trimmed > 0 && (
              <p className="border-t border-surface-800 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:bg-amber-950/25 dark:text-amber-200">
                {trimmed} event{trimmed === 1 ? '' : 's'} on this page didn&apos;t match the date range or
                actor filter and were hidden here, this deployment&apos;s search endpoint did not apply those
                itself, so the total above still counts them.
              </p>
            )}

            {/* Offset/limit pager: this endpoint returns {items,total,limit,
 offset}, not the {page,total_pages} shape the shared
                Pagination component consumes, so the control is local, but
 styled to match it exactly. */}
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-surface-800 bg-surface-850/50 px-4 py-2.5">
              <p className="text-xs tabular-nums text-ink-400">
                Showing <span className="font-semibold text-ink-100">{rangeStart.toLocaleString()}</span>–
                <span className="font-semibold text-ink-100">{rangeEnd.toLocaleString()}</span> of{' '}
                <span className="font-semibold text-ink-100">{total.toLocaleString()}</span> events
              </p>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <label className="flex items-center gap-2 text-xs text-ink-400">
                  <span className="whitespace-nowrap">Rows per page</span>
                  <select
                    value={limit}
                    onChange={(e) => {
                      setLimit(Number(e.target.value))
                      setOffset(0)
                    }}
                    className="h-7 cursor-pointer rounded-md border border-surface-700 bg-surface-900 pl-2 pr-6 text-xs font-medium text-ink-100 transition-colors hover:border-surface-600 focus:border-blue-500 focus:outline-none"
                  >
                    {PAGE_SIZES.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-2">
                  <Button
                    size="xs"
                    variant="secondary"
                    icon={ChevronLeft}
                    disabled={!canPrev}
                    onClick={() => setOffset((o) => Math.max(0, o - pageLimit))}
                  >
                    Prev
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    iconRight={ChevronRight}
                    disabled={!canNext}
                    onClick={() => setOffset((o) => o + pageLimit)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </Container>

      <AuditEventDrawer
        event={selected}
        onClose={() => setSelected(null)}
        onFilterActor={(actor) => {
          set('actor', String(actor))
          setSelected(null)
        }}
        onFilterAction={(action) => {
          set('action', String(action))
          setSelected(null)
        }}
      />
    </Stack>
  )
}
