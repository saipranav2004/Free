import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ScrollText,
  Video,
  ShieldCheck,
  ShieldAlert,
  FileSearch,
  Link2,
  XCircle,
  Users,
  PlayCircle,
  SearchX,
  Clock,
  Play,
  ChevronRight,
} from 'lucide-react'
import clsx from 'clsx'
import { listAudit, listRecordings, verifyAudit } from '../../api/admin'
import { PageHeader, Card, CardHeader, CardTitle, EmptyState } from '../../components/common/Layout'
import { KpiStrip } from '../../components/common/KpiStrip'
import { QueryState } from '../../components/common/QueryState'
import { Pagination } from '../../components/common/Pagination'
import { Badge } from '../../components/common/Badge'
import { Button, IconButton } from '../../components/common/Button'
import { TabBar } from '../../components/common/TabBar'
import { SearchField, RefreshControl } from '../../components/common/TableControls'
import { AuditFilterBar, EMPTY_AUDIT_FILTERS } from '../../components/audit/AuditFilterBar'
import { AuditTable } from '../../components/audit/AuditTable'
import { AuditEventDrawer } from '../../components/audit/AuditEventDrawer'
import { ReportBuilder } from '../../components/audit/ReportBuilder'
import { SessionRecordingViewer } from '../../components/audit/SessionRecordingViewer'
import { resolveRange, refineRows, isFailure, eventActor } from '../../components/audit/auditFields'
import { formatDateTime, formatDuration } from '../../lib/format'
import { apiErrorMessage } from '../../lib/apiError'
import { RECORDING_STATUS_BADGE, DEFAULT_PAGE_SIZE } from '../../config/constants'

// ---------------------------------------------------------------------------
// Admin Center, Audit & Compliance
// ---------------------------------------------------------------------------
// Same instrument as the self-service Audit page, pointed at the org-wide
// trail: identical filter bar, identical table, identical drawer. That is
// deliberate, an administrator who learns one audit screen has learned both,
// and the two can no longer drift apart in what they show or how they read.
// What differs is scope (everyone's events, not yours), the actor column's
// weight, and that chain verification lives here as a first-class tab.

// --- Events -----------------------------------------------------------------

function EventsTab() {
  const [filters, setFilters] = useState(EMPTY_AUDIT_FILTERS)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [reportOpen, setReportOpen] = useState(false)
  const [selected, setSelected] = useState(null)

  const set = useCallback((key, value) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }, [])
  const reset = useCallback(() => {
    setFilters(EMPTY_AUDIT_FILTERS)
    setPage(1)
  }, [])

  const { fromISO, toISO } = useMemo(
    () => resolveRange(filters.range, filters.from, filters.to),
    [filters.range, filters.from, filters.to]
  )

  const query = useQuery({
    queryKey: ['admin', 'audit', 'events', filters, page, pageSize],
    queryFn: ({ signal }) =>
      listAudit(
        {
          page,
          page_size: pageSize,
          q: filters.q || undefined,
          category: filters.category || undefined,
          outcome: filters.outcome || undefined,
          action: filters.action || undefined,
          actor: filters.actor || undefined,
          from: fromISO || undefined,
          to: toISO || undefined,
        },
        signal
      ),
    placeholderData: (prev) => prev,
  })

  const serverRows = useMemo(() => query.data?.events || [], [query.data])
  const rows = useMemo(
    () => refineRows(serverRows, filters, fromISO, toISO),
    [serverRows, filters, fromISO, toISO]
  )
  const trimmed = serverRows.length - rows.length
  const pagination = query.data?.pagination

  const failed = rows.filter(isFailure).length
  const actors = new Set(rows.map((e) => eventActor(e)).filter(Boolean)).size

  return (
    <>
      <KpiStrip
        className="mb-4"
        columns={3}
        loading={query.isLoading}
        items={[
          {
            key: 'matched',
            label: 'Events matched',
            value: (pagination?.total ?? rows.length).toLocaleString(),
            icon: ScrollText,
            description: 'Org-wide, across the current filters',
          },
          {
            key: 'actors',
            label: 'Distinct actors',
            value: actors,
            icon: Users,
            description: 'On this page',
          },
          {
            key: 'failed',
            label: 'Denied or failed',
            value: failed,
            icon: XCircle,
            tone: failed > 0 ? 'red' : 'default',
            description: 'On this page',
          },
        ]}
      />

      {/* THE REPORT CTA, PROMOTED OUT OF THE TOOLBAR.
          It used to be a small secondary button wedged between Export and
          Refresh in the filter strip, identical weight to the chrome around
 it, despite being the only thing on this page a compliance officer
 actually comes here to produce. Evidence generation is the page's
 headline job, so it now reads as one: its own plate, its own
 sentence explaining what it produces, and the console's largest
 button. Export (CSV/JSON of the rows on screen) is gone from this
 page entirely, it was the weaker, unsigned twin of this action, and
 having both invited people to send a hand-filtered CSV to an auditor
 when the server-generated report is the artefact that carries
 weight. The self-service Audit page keeps Export, because there the
 job genuinely is "grab my own rows". */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 rounded-xl border border-surface-700/70 bg-surface-900 px-4 py-4 ">
        <div className="min-w-0 max-w-2xl">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink-50">
            <FileSearch className="h-4 w-4 flex-none text-ink-400" strokeWidth={1.75} />
            Compliance report
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
            Generated server-side from the tamper-evident chain, not from the rows on this page , and scoped
            to the filters you have set. PDF for auditors, CSV for analysis.
          </p>
        </div>
        <Button
          size="xl"
          variant={reportOpen ? 'secondary' : 'primary'}
          icon={FileSearch}
          onClick={() => setReportOpen((v) => !v)}
          aria-expanded={reportOpen}
        >
          {reportOpen ? 'Close report builder' : 'Generate report'}
        </Button>
      </div>

      {reportOpen && <ReportBuilder filters={filters} onClose={() => setReportOpen(false)} />}

      <AuditFilterBar
        filters={filters}
        set={set}
        reset={reset}
        onRefresh={() => query.refetch()}
        isFetching={query.isFetching}
        updatedAt={query.dataUpdatedAt}
        resultLabel={`${(pagination?.total ?? rows.length).toLocaleString()} matching`}
      />

      {/* One container: the filter bar is this card's header strip. */}
      <Card className="overflow-hidden rounded-t-none">
        {query.isError ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-semibold text-red-700 dark:text-red-300">
              Couldn&apos;t load audit events
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
              emptyTitle="No audit events"
              emptyMessage="Nothing org-wide matches these filters. Widen the date range or clear a facet."
              onClearFilters={reset}
            />

            {trimmed > 0 && (
              <p className="border-t border-surface-800 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:bg-amber-950/25 dark:text-amber-200">
                {trimmed} event{trimmed === 1 ? '' : 's'} outside the selected range or actor were hidden on
                this page, this deployment&apos;s admin audit endpoint did not apply those filters
                server-side, so the total still counts them.
              </p>
            )}

            {pagination && (
              <Pagination
                page={pagination.page}
                pageSize={pagination.page_size}
                total={pagination.total}
                totalPages={pagination.total_pages}
                onPageChange={setPage}
                onPageSizeChange={(n) => {
                  setPageSize(n)
                  setPage(1)
                }}
                label="events"
              />
            )}
          </>
        )}
      </Card>

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
    </>
  )
}

// --- Recordings -------------------------------------------------------------

function RecordingsTab() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  // Clicking a row used to do nothing at all. It now opens the session
  // recording viewer; the play button on the row opens it already running,
  // which is the difference between "inspect this session" and "watch it".
  const [selected, setSelected] = useState(null)
  const [autoplay, setAutoplay] = useState(false)

  const open = (rec, play = false) => {
    setAutoplay(play)
    setSelected(rec)
  }

  const query = useQuery({
    queryKey: ['admin', 'recordings', page, pageSize],
    queryFn: ({ signal }) => listRecordings({ page, page_size: pageSize }, signal),
    placeholderData: (prev) => prev,
  })

  const all = useMemo(() => query.data?.recordings || [], [query.data])
  // listRecordings takes no search/status params, so both are applied over
  // the page in hand, labelled as such rather than implying a server query.
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((r) => {
      if (status && String(r?.status || '').toUpperCase() !== status) return false
      if (!needle) return true
      return [r?.resource_name, r?.resource_id, r?.session_id, r?.username]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    })
  }, [all, q, status])

  const pagination = query.data?.pagination
  const statuses = useMemo(
    () => [...new Set(all.map((r) => String(r?.status || '').toUpperCase()).filter(Boolean))].sort(),
    [all]
  )

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader className="flex-wrap gap-2">
          <CardTitle icon={Video}>Session recordings</CardTitle>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <SearchField
              value={q}
              onChange={setQ}
              placeholder="Filter this page…"
              className="min-w-[12rem] sm:max-w-[16rem]"
            />
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter by status"
              className="h-9 cursor-pointer rounded-lg border border-surface-700 bg-surface-900 pl-2.5 pr-7 text-xs font-medium text-ink-100 shadow-sm transition-colors hover:border-surface-600 focus:border-blue-500 focus:outline-none"
            >
              <option value="">Any status</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <RefreshControl
              onRefresh={() => query.refetch()}
              isFetching={query.isFetching}
              updatedAt={query.dataUpdatedAt}
            />
          </span>
        </CardHeader>

        <QueryState
          query={query}
          empty={(d) => !d?.recordings || d.recordings.length === 0}
          emptyTitle="No session recordings"
          emptyMessage="Recordings appear here once a resource with recording enabled has been connected to."
          skeletonRows={6}
        >
          {() =>
            rows.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title="Nothing on this page matches"
                description="Clear the filter, or move to another page, filtering here applies to the loaded page only."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQ('')
                      setStatus('')
                    }}
                  >
                    Clear filter
                  </Button>
                }
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[52rem] border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr>
                        {['Resource', 'Session', 'Started', 'Duration', 'Size', 'Status'].map((h) => (
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
                          className="sticky top-0 z-10 w-24 border-b border-surface-800 bg-surface-850 px-4 py-2.5"
                        >
                          <span className="sr-only">Open recording</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr
                          key={r?.id ?? i}
                          role="button"
                          tabIndex={0}
                          aria-label={`Open recording for ${r?.resource_name || r?.resource_id || 'this session'}`}
                          onClick={() => open(r)}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter' || ev.key === ' ') {
                              ev.preventDefault()
                              open(r)
                            }
                          }}
                          className="group cursor-pointer transition-colors hover:bg-surface-850 focus-visible:bg-surface-850 focus-visible:outline-none"
                        >
                          <td className="border-b border-surface-800 px-4 py-2.5">
                            <div className="flex min-w-0 items-center gap-3">
                              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-850 text-ink-400">
                                <PlayCircle className="h-4 w-4" strokeWidth={1.5} />
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate font-medium text-ink-50">
                                  {r?.resource_name || r?.resource_id || '-'}
                                </span>
                                {r?.username && (
                                  <span className="mt-0.5 block truncate text-xs text-ink-500">
                                    {r.username}
                                  </span>
                                )}
                              </span>
                            </div>
                          </td>
                          <td className="max-w-[12rem] border-b border-surface-800 px-4 py-2.5 font-mono text-xs text-ink-400">
                            <span className="block truncate">{r?.session_id || '-'}</span>
                          </td>
                          <td className="whitespace-nowrap border-b border-surface-800 px-4 py-2.5 text-xs tabular-nums text-ink-300">
                            {formatDateTime(r?.started_at || r?.created_at)}
                          </td>
                          <td className="whitespace-nowrap border-b border-surface-800 px-4 py-2.5 text-xs tabular-nums text-ink-400">
                            {r?.duration_seconds != null ? formatDuration(r.duration_seconds) : '-'}
                          </td>
                          <td className="whitespace-nowrap border-b border-surface-800 px-4 py-2.5 text-xs tabular-nums text-ink-400">
                            {r?.size_bytes != null
                              ? `${Math.round(r.size_bytes / 1024).toLocaleString()} KB`
                              : '-'}
                          </td>
                          <td className="whitespace-nowrap border-b border-surface-800 px-4 py-2.5">
                            <Badge className={RECORDING_STATUS_BADGE[r?.status]}>
                              {r?.status || 'UNKNOWN'}
                            </Badge>
                          </td>
                          <td className="whitespace-nowrap border-b border-surface-800 px-4 py-2.5 text-right">
                            <span className="flex items-center justify-end gap-1">
                              <IconButton
                                icon={Play}
                                variant="secondary"
                                size="sm"
                                aria-label="Play recording"
                                title="Play from the start"
                                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                                onClick={(ev) => {
                                  ev.stopPropagation()
                                  open(r, true)
                                }}
                              />
                              <ChevronRight className="h-4 w-4 flex-none text-ink-600" strokeWidth={1.6} />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {(q || status) && (
                  <p className="border-t border-surface-800 bg-surface-850/50 px-4 py-2 text-2xs text-ink-500">
                    Showing {rows.length} of {all.length} recordings on this page, the recordings endpoint
                    takes no search parameter, so filtering applies to the loaded page only.
                  </p>
                )}

                {pagination && (
                  <Pagination
                    page={pagination.page}
                    pageSize={pagination.page_size}
                    total={pagination.total}
                    totalPages={pagination.total_pages}
                    onPageChange={setPage}
                    onPageSizeChange={(n) => {
                      setPageSize(n)
                      setPage(1)
                    }}
                    label="recordings"
                  />
                )}
              </>
            )
          }
        </QueryState>
      </Card>

      <SessionRecordingViewer recording={selected} autoplay={autoplay} onClose={() => setSelected(null)} />
    </>
  )
}

// --- Chain integrity --------------------------------------------------------

function ChainTab() {
  const verify = useMutation({
    mutationFn: () => verifyAudit(),
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const r = verify.data
  const field =
    r &&
    ('valid' in r
      ? 'valid'
      : 'chain_valid' in r
        ? 'chain_valid'
        : 'intact' in r
          ? 'intact'
          : 'success' in r
            ? 'success'
            : null)
  const isValid = field ? Boolean(r[field]) : null

  // Numeric facts the payload may carry. Rendered only when present, never
  // invented, and never a placeholder zero.
  const stats = r
    ? [
        { label: 'Entries checked', value: r.entries_checked ?? r.total_entries ?? r.count },
        { label: 'First sequence', value: r.first_sequence ?? r.start_sequence },
        { label: 'Last sequence', value: r.last_sequence ?? r.end_sequence },
        { label: 'Broken at', value: r.broken_at_sequence ?? r.invalid_sequence },
      ].filter((s) => s.value !== undefined && s.value !== null)
    : []

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle icon={Link2}>Tamper-evident chain</CardTitle>
          <Button
            size="sm"
            variant="primary"
            icon={ShieldCheck}
            className="ml-auto"
            loading={verify.isPending}
            onClick={() => verify.mutate()}
          >
            Run verification
          </Button>
        </CardHeader>

        {verify.isSuccess ? (
          <>
            <div
              className={clsx(
                'flex items-start gap-3.5 px-4 py-5',
                isValid === false
                  ? 'bg-red-50 dark:bg-red-950/25'
                  : isValid === true
                    ? 'bg-emerald-50 dark:bg-emerald-950/20'
                    : ''
              )}
            >
              <span
                className={clsx(
                  'flex h-11 w-11 flex-none items-center justify-center rounded-xl ring-1 ring-inset',
                  isValid === false
                    ? 'bg-red-100 text-red-600 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25'
                    : isValid === true
                      ? 'bg-emerald-100 text-emerald-600 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25'
                      : 'border border-surface-700 bg-surface-850 text-ink-400 ring-transparent'
                )}
              >
                {isValid === false ? (
                  <ShieldAlert className="h-5 w-5" strokeWidth={1.75} />
                ) : (
                  <ShieldCheck className="h-5 w-5" strokeWidth={1.75} />
                )}
              </span>
              <div className="min-w-0">
                {isValid === true && (
                  <>
                    <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
                      Audit chain intact, no tampering detected
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-emerald-700/90 dark:text-emerald-300/80">
                      Every entry&apos;s hash matches its predecessor. Verified{' '}
                      {formatDateTime(new Date().toISOString())}.
                    </p>
                  </>
                )}
                {isValid === false && (
                  <>
                    <p className="text-sm font-semibold text-red-800 dark:text-red-300">
                      Audit chain broken, possible tampering
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-red-700/90 dark:text-red-300/80">
                      At least one entry&apos;s hash does not match its predecessor. Notify a security
                      administrator and preserve the database before any further writes.
                    </p>
                  </>
                )}
                {isValid === null && (
                  <>
                    <p className="mb-1.5 text-sm font-semibold text-ink-100">
                      Verification returned an unrecognised shape
                    </p>
                    <pre className="max-w-full overflow-x-auto rounded-lg border border-surface-700 bg-surface-850 p-2.5 font-mono text-xs text-ink-400">
                      {JSON.stringify(r, null, 2)}
                    </pre>
                  </>
                )}
              </div>
            </div>

            {stats.length > 0 && (
              <dl className="grid gap-px border-t border-surface-800 bg-surface-800 sm:grid-cols-2 lg:grid-cols-4">
                {stats.map((s) => (
                  <div key={s.label} className="bg-surface-900 px-4 py-3">
                    <dt className="text-2xs font-semibold uppercase tracking-[0.09em] text-ink-500">
                      {s.label}
                    </dt>
                    <dd className="mt-1 font-mono text-sm tabular-nums text-ink-100">{String(s.value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        ) : (
          <EmptyState
            icon={Link2}
            title="Chain not verified in this session"
            description="Verification walks every audit entry in the organization and re-computes its hash against the previous one. It runs only when you ask for it."
            action={
              <Button
                variant="primary"
                icon={ShieldCheck}
                loading={verify.isPending}
                onClick={() => verify.mutate()}
              >
                Run verification
              </Button>
            }
          />
        )}
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle icon={Clock}>What this proves</CardTitle>
        </CardHeader>
        <div className="space-y-3 p-4 text-xs leading-relaxed text-ink-400">
          <p>
            Each audit entry stores the hash of the entry before it. Editing or deleting any row breaks every
            hash that follows, which is what this check detects.
          </p>
          <p>
            It does <span className="font-medium text-ink-200">not</span> prove the contents are correct, only
            that nothing has been altered since it was written.
          </p>
          <p>
            The check is org-wide by design and has no per-account equivalent, which is why it lives in the
            Admin Center.
          </p>
        </div>
      </Card>
    </div>
  )
}

const TABS = [
  { key: 'events', label: 'Events', icon: ScrollText },
  { key: 'recordings', label: 'Recordings', icon: Video },
  { key: 'chain', label: 'Chain integrity', icon: ShieldCheck },
]

export default function AdminAuditPage() {
  const [tab, setTab] = useState('events')

  return (
    <div>
      <PageHeader
        eyebrow="Admin Center"
        title="Audit & Compliance"
        description="The organization's complete audit trail, session recordings, and tamper-evident chain verification. Entries are append-only, nothing here can be edited or deleted, by anyone."
      />

      <TabBar tabs={TABS} active={tab} onChange={setTab} className="mb-5" />

      {tab === 'events' && <EventsTab />}
      {tab === 'recordings' && <RecordingsTab />}
      {tab === 'chain' && <ChainTab />}
    </div>
  )
}
