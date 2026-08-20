import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import clsx from 'clsx'
import {
  Radio,
  ShieldAlert,
  Square,
  Timer,
  Users,
  MonitorPlay,
  SearchX,
  Download,
  ChevronRight,
  Copy,
  Hourglass,
  CircleSlash,
} from 'lucide-react'
import { listMySessions, endSession } from '../../api/sessions'
import { listSessions, killSession } from '../../api/admin'
import { useAuthStore } from '../../store/authStore'
import { PageHeader, Card, EmptyState, DetailList, ListPanel } from '../../components/common/Layout'
import { QueryState } from '../../components/common/QueryState'
import { KpiStrip } from '../../components/common/KpiStrip'
import { Pagination } from '../../components/common/Pagination'
import { Badge, StatusIndicator, MetaTag } from '../../components/common/Badge'
import { stickyCell, stickyHeader, cell, COL, TruncCell } from '../../components/common/tableStyles'
import { Button } from '../../components/common/Button'
import { Checkbox } from '../../components/common/Checkbox'
import { Drawer } from '../../components/common/Drawer'
import { BulkActionBar } from '../../components/common/BulkActionBar'
import { SegmentedControl, FilterToggle } from '../../components/common/SegmentedControl'
import {
  SearchField,
  SortHeader,
  ColumnChooser,
  ExportMenu,
  RefreshControl,
  ActiveFilters,
} from '../../components/common/TableControls'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { ResourceTypeIcon } from '../../components/resources/ResourceTypeIcon'
import { useTableState } from '../../hooks/useTableState'
import { exportRowsToCsv, exportRowsToJson } from '../../lib/exportRows'
import { formatDateTime, formatDuration, formatRelativeToNow } from '../../lib/format'
import { SESSIONS_POLL_MS } from '../../config/constants'
import { apiErrorMessage } from '../../lib/apiError'

// ---------------------------------------------------------------------------
// Sessions, the live-operations surface
// ---------------------------------------------------------------------------
// WHAT WAS WRONG. This page was a stack of list rows: one line per session,
// duration buried in prose, no search, no sort, no way to see twenty sessions
// at once, and a four-cell KPI strip whose numbers described "this page"
// rather than the estate. A session list is the closest thing this product has
// to a NOC screen, the questions asked of it are "what is connected right
// now", "who has been in there for three hours", "is anything break-glass" ,
// and none of those are answerable by scanning prose rows.
//
// WHAT IT IS NOW. The same dense-grid treatment as Identity: frozen identity
// column, sortable columns, server-shaped client paging, status facets with
// live counts, search, density, column control, export, and an explicit
// last-updated/refresh control (a stale "no active sessions" is dangerous in a
// way a stale user list is not). Row click opens a detail drawer instead of
// navigating away from a screen the operator is watching.
//
// THE KPI BAND IS KEPT HERE, DELIBERATELY, AND ONLY HERE-ISH: unlike an
// inventory page, "active now / break-glass / longest running" are not row
// counts, they are the state of the estate, and they change while you watch.
// It only renders in the live view, reading session HISTORY, the strip would
// be summarising an arbitrary time slice, so it is suppressed.
//
// HONESTY: both endpoints return their whole page in one response. We ask for
// up to MAX_ROWS and say so when there are more, rather than implying the
// figures cover everything.

const MAX_ROWS = 200

const SCOPES = [
  { key: 'mine', label: 'My sessions' },
  { key: 'all', label: 'Org-wide' },
]

const COLUMNS = [
  { key: 'resource_name', label: 'Resource', required: true },
  { key: 'username', label: 'User' },
  { key: 'protocol', label: 'Protocol' },
  { key: 'started_at', label: 'Started' },
  { key: 'duration', label: 'Duration' },
  { key: 'status', label: 'Status' },
]

const CSV_COLUMNS = [
  { key: 'id', label: 'Session ID' },
  { key: 'resource_name', label: 'Resource' },
  { key: 'resource_type', label: 'Type' },
  { key: 'username', label: 'User' },
  { key: 'protocol', label: 'Protocol' },
  { key: 'status', label: 'Status' },
  { key: 'started_at', label: 'Started' },
  { key: 'ended_at', label: 'Ended' },
  { key: 'duration_seconds', label: 'Duration (s)' },
  { key: 'is_breakglass', label: 'Break-glass', value: (s) => (s.is_breakglass ? 'yes' : 'no') },
]

const STATUS_TONE = {
  ACTIVE: 'emerald',
  COMPLETED: 'neutral',
  KILLED: 'red',
  FAILED: 'red',
}

// A killed or failed session is an exception worth a filled chip; ACTIVE and
// COMPLETED are on every row, so they stay quiet indicators. See Badge.jsx.
const EXCEPTION_STATUSES = ['KILLED', 'FAILED']

const NO_BULK_ENDPOINT = 'Requires a backend batch endpoint, not available yet'

// Elapsed time for a still-running session. The backend only populates
// duration_seconds once a session ends (session.go's End()), so an ACTIVE
// row's own value is permanently 0, computing from started_at is the only way
// to show the truth. useTick re-renders once a second so the number moves,
// which is what makes the screen read as live rather than as a snapshot.
function useTick(enabled, ms = 1000) {
  const [, force] = useState(0)
  useEffect(() => {
    if (!enabled) return undefined
    const t = setInterval(() => force((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [enabled, ms])
}

function elapsedSeconds(session) {
  if (session.status !== 'ACTIVE') return session.duration_seconds || 0
  const started = new Date(session.started_at).getTime()
  if (!started) return 0
  return Math.max(0, (Date.now() - started) / 1000)
}

// A long-running privileged session is the single most useful anomaly on this
// screen, so duration is instrumented: monospace, tabular, and tinted once it
// crosses the thresholds an operator would actually want flagged.
function DurationCell({ session }) {
  const secs = elapsedSeconds(session)
  const live = session.status === 'ACTIVE'
  const tone =
    live && secs >= 4 * 3600
      ? 'text-red-600 dark:text-red-400'
      : live && secs >= 1 * 3600
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-ink-300'
  return (
    <span className={clsx('inline-flex items-center gap-1.5 font-mono text-xs tabular-nums', tone)}>
      <Timer className="h-3 w-3 flex-none opacity-70" strokeWidth={1.75} />
      {formatDuration(secs)}
    </span>
  )
}

function SessionDrawer({ session, onClose, onEnd, onKill, canKill, isMutating }) {
  useTick(!!session && session.status === 'ACTIVE')
  if (!session) return null
  const isActive = session.status === 'ACTIVE'
  return (
    <Drawer
      open={!!session}
      onClose={onClose}
      title={session.resource_name || 'Session'}
      subtitle={`${session.username ? `${session.username} · ` : ''}${session.status}`}
      icon={MonitorPlay}
      footer={
        isActive && (
          <div className="flex w-full items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => onEnd(session)} disabled={isMutating}>
              End session
            </Button>
            {canKill && (
              <Button variant="danger" icon={Square} onClick={() => onKill(session)} disabled={isMutating}>
                Kill session
              </Button>
            )}
          </div>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
        <StatusIndicator tone={STATUS_TONE[session.status] || 'neutral'} pulse={isActive}>
          {session.status}
        </StatusIndicator>
        {session.is_breakglass && (
          <Badge
            className="bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30"
            dot
          >
            Break-glass
          </Badge>
        )}
        {session.protocol && <MetaTag mono>{session.protocol}</MetaTag>}
      </div>

      <DetailList
        items={[
          { label: 'Resource', value: session.resource_name || session.resource_id || '-' },
          { label: 'Type', value: session.resource_type || '-' },
          { label: 'User', value: session.username || session.user_id || '-' },
          { label: 'Started', value: formatDateTime(session.started_at) },
          { label: 'Ended', value: session.ended_at ? formatDateTime(session.ended_at) : 'Still open' },
          { label: 'Duration', value: <DurationCell session={session} /> },
          { label: 'Client IP', value: session.client_ip || session.source_ip || '-' },
          { label: 'Grant', value: session.grant_id || '-' },
          {
            label: 'Session ID',
            value: (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(session.id)
                    toast.success('Session ID copied')
                  } catch {
                    toast.error('Clipboard unavailable in this browser')
                  }
                }}
                className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-300 transition-colors hover:text-ink-50"
              >
                {session.id}
                <Copy className="h-3 w-3 flex-none" strokeWidth={1.75} />
              </button>
            ),
          },
        ]}
      />
    </Drawer>
  )
}

export default function SessionsPage() {
  const isAdmin = useAuthStore((s) => s.isAdmin())
  const [scope, setScope] = useState('mine')
  const [activeOnly, setActiveOnly] = useState(true)
  const [search, setSearch] = useState('')
  const [killTarget, setKillTarget] = useState(null)
  const [endTarget, setEndTarget] = useState(null)
  const [detail, setDetail] = useState(null)
  const queryClient = useQueryClient()

  const mineQuery = useQuery({
    queryKey: ['sessions', 'mine', { activeOnly }],
    queryFn: ({ signal }) => listMySessions({ page: 1, pageSize: MAX_ROWS, activeOnly, signal }),
    enabled: scope === 'mine',
    refetchInterval: scope === 'mine' && activeOnly ? SESSIONS_POLL_MS : false,
  })

  const allQuery = useQuery({
    queryKey: ['sessions', 'all', { activeOnly }],
    queryFn: ({ signal }) =>
      listSessions({ page: 1, page_size: MAX_ROWS, active: activeOnly ? 'true' : undefined }, signal),
    enabled: scope === 'all' && isAdmin,
    refetchInterval: scope === 'all' && activeOnly ? SESSIONS_POLL_MS : false,
  })

  const query = scope === 'mine' ? mineQuery : allQuery
  const rows = useMemo(() => query.data?.sessions || [], [query.data])
  const serverTotal = query.data?.pagination?.total

  const anyActive = rows.some((s) => s.status === 'ACTIVE')
  useTick(anyActive)

  const table = useTableState({
    rows,
    storageKey: 'sessions',
    rowId: (s) => s.id,
    initialSort: { key: 'started_at', dir: 'desc' },
    initialPageSize: 25,
    initialFilters: { status: 'all', breakglass: false },
    searchFields: ['resource_name', 'username', 'protocol', 'resource_type', 'id'],
    filterFn: (s, f) => {
      if (f.status !== 'all' && (s.status || 'UNKNOWN') !== f.status) return false
      if (f.breakglass && !s.is_breakglass) return false
      return true
    },
    sortAccessor: (s, key) => (key === 'duration' ? elapsedSeconds(s) : s[key]),
  })

  // The table hook owns the search box so search, facets and selection stay in
  // one place; this mirror keeps the input controlled without a second source
  // of truth.
  useEffect(() => {
    table.setQuery(search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const invalidateAll = () => queryClient.invalidateQueries({ queryKey: ['sessions'] })

  const endMutation = useMutation({
    mutationFn: (id) => endSession(id),
    onSuccess: () => {
      toast.success('Session ended')
      setEndTarget(null)
      setDetail(null)
      invalidateAll()
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setEndTarget(null)
    },
  })

  const killMutation = useMutation({
    mutationFn: ({ id, reason }) => killSession(id, reason),
    onSuccess: () => {
      toast.success('Session killed')
      setKillTarget(null)
      setDetail(null)
      invalidateAll()
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setKillTarget(null)
    },
  })

  const isMutating = endMutation.isPending || killMutation.isPending

  const activeRows = rows.filter((s) => s.status === 'ACTIVE')
  const breakglassActive = activeRows.filter((s) => s.is_breakglass).length
  const longest = activeRows.reduce((max, s) => Math.max(max, elapsedSeconds(s)), 0)
  const truncated = typeof serverTotal === 'number' && serverTotal > rows.length

  const statusFacets = useMemo(() => {
    const seen = [...new Set(rows.map((s) => s.status || 'UNKNOWN'))].sort()
    return [
      { key: 'all', label: 'All', count: rows.length },
      ...seen.map((s) => ({
        key: s,
        label: s.charAt(0) + s.slice(1).toLowerCase(),
        count: rows.filter((r) => (r.status || 'UNKNOWN') === s).length,
      })),
    ]
  }, [rows])

  const show = (key) => !table.visibleColumns || table.visibleColumns.includes(key)
  const pad = table.density === 'compact' ? 'py-1.5' : 'py-2'

  const chips = []
  if (search) chips.push({ key: 'q', label: 'Search', value: search, onClear: () => setSearch('') })
  if (table.filters.status !== 'all') {
    chips.push({
      key: 'status',
      label: 'Status',
      value: table.filters.status,
      onClear: () => table.setFilter('status', 'all'),
    })
  }
  if (table.filters.breakglass) {
    chips.push({
      key: 'bg',
      label: 'Flag',
      value: 'Break-glass only',
      onClear: () => table.setFilter('breakglass', false),
    })
  }

  const scopes = SCOPES.filter((s) => s.key !== 'all' || isAdmin)

  return (
    <div className="pb-24">
      <PageHeader
        eyebrow="Access"
        title="Sessions"
        description="Tracked connection sessions the start/end lifecycle used for audit and JIT grant expiry, not a live terminal."
        meta={
          <>
            {activeOnly && (
              <span className="inline-flex items-center gap-2 rounded-md border border-surface-700 bg-surface-900 px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.08em] text-ink-400">
                <span className="relative flex h-1.5 w-1.5 flex-none rounded-full bg-emerald-500">
                  <span className="dot-live absolute inset-0 rounded-full bg-emerald-500" />
                </span>
                Auto-refreshing every {Math.round(SESSIONS_POLL_MS / 1000)}s
              </span>
            )}
            {truncated && (
              <span className="text-2xs font-medium text-ink-500">
                Showing the {rows.length} most recent of {serverTotal}
              </span>
            )}
          </>
        }
      />

      {/* Live band. Estate state, not row counts, and only while watching the
 live view; over history these figures would describe an arbitrary
 slice of the past. */}
      {activeOnly && (
        <KpiStrip
          className="mb-5"
          columns={3}
          loading={query.isLoading}
          items={[
            {
              key: 'active',
              label: scope === 'mine' ? 'Your active sessions' : 'Active across the org',
              value: activeRows.length,
              icon: scope === 'mine' ? Radio : Users,
              tone: 'emerald',
              live: activeRows.length > 0,
              description:
                activeRows.length === 0 ? 'Nothing is connected right now' : 'Connected at this moment',
            },
            {
              key: 'breakglass',
              label: 'Break-glass in use',
              value: breakglassActive,
              icon: ShieldAlert,
              tone: breakglassActive > 0 ? 'red' : 'default',
              description: breakglassActive > 0 ? 'Emergency access is open' : 'No emergency access open',
            },
            {
              key: 'longest',
              label: 'Longest running',
              value: activeRows.length ? formatDuration(longest) : '-',
              icon: Hourglass,
              tone: longest >= 4 * 3600 ? 'amber' : 'default',
              description: 'Oldest session still open',
            },
          ]}
        />
      )}

      <ListPanel
        toolbar={
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {scopes.length > 1 && (
                <SegmentedControl
                  options={scopes}
                  value={scope}
                  onChange={setScope}
                  ariaLabel="Session scope"
                />
              )}

              <SearchField
                value={search}
                onChange={setSearch}
                placeholder="Search resource, user or protocol…"
                className="min-w-[14rem] sm:max-w-xs"
              />

              {statusFacets.length > 1 && (
                <SegmentedControl
                  size="sm"
                  ariaLabel="Filter by status"
                  value={table.filters.status}
                  onChange={(v) => table.setFilter('status', v)}
                  options={statusFacets}
                />
              )}

              <FilterToggle checked={activeOnly} onChange={setActiveOnly} label="Active only" />
              <FilterToggle
                checked={table.filters.breakglass}
                onChange={(v) => table.setFilter('breakglass', v)}
                label="Break-glass"
              />

              <span className="ml-auto flex flex-wrap items-center gap-2">
                <ColumnChooser
                  columns={COLUMNS}
                  visible={table.visibleColumns}
                  onChange={table.setVisibleColumns}
                />
                <ExportMenu
                  count={table.total}
                  disabled={table.total === 0}
                  onExportCsv={() => exportRowsToCsv(table.filteredRows, CSV_COLUMNS, 'sessions')}
                  onExportJson={() => exportRowsToJson(table.filteredRows, CSV_COLUMNS, 'sessions')}
                />
                <RefreshControl
                  onRefresh={() => query.refetch()}
                  isFetching={query.isFetching}
                  updatedAt={query.dataUpdatedAt}
                />
              </span>
            </div>

            {chips.length > 0 && (
              <div className="border-t border-surface-800 pt-3">
                <ActiveFilters
                  chips={chips}
                  onClearAll={() => {
                    setSearch('')
                    table.resetFilters()
                  }}
                />
              </div>
            )}
          </div>
        }
      >
        <QueryState
          query={query}
          empty={(d) => !d?.sessions || d.sessions.length === 0}
          emptyTitle={activeOnly ? 'No active sessions' : 'No sessions found'}
          emptyMessage={
            activeOnly
              ? 'Nothing is connected right now. Sessions appear here the moment a brokered connection opens.'
              : 'No session history matches this view.'
          }
        >
          {() =>
            table.total === 0 ? (
              <Card>
                <EmptyState
                  icon={SearchX}
                  title="No sessions match these filters"
                  description="Every returned session was filtered out by the current search or status selection."
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
                  <table className="w-full min-w-[58rem] table-fixed border-separate border-spacing-0 text-sm">
                    <colgroup>
                      <col className={COL.select} />
                      <col className={COL.name} />
                      {show('username') && <col className={COL.medium} />}
                      {show('protocol') && <col className={COL.short} />}
                      {show('started_at') && <col className={COL.timestamp} />}
                      {show('duration') && <col className={COL.short} />}
                      {show('status') && <col className={COL.status} />}
                      <col className={COL.actions} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col" className={clsx(stickyHeader({ left: 'left-0' }), 'px-4 py-2.5')}>
                          <Checkbox
                            checked={table.allOnPageSelected}
                            indeterminate={table.someOnPageSelected}
                            onChange={table.toggleAllOnPage}
                            srLabel="Select all sessions on this page"
                          />
                        </th>
                        <SortHeader
                          label="Resource"
                          columnKey="resource_name"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className={clsx(stickyHeader({ left: 'left-12', edge: true }), 'z-30')}
                        />
                        {show('username') && (
                          <SortHeader
                            label="User"
                            columnKey="username"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                        )}
                        {show('protocol') && (
                          <SortHeader
                            label="Protocol"
                            columnKey="protocol"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                        )}
                        {show('started_at') && (
                          <SortHeader
                            label="Started"
                            columnKey="started_at"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                        )}
                        {show('duration') && (
                          <SortHeader
                            label="Duration"
                            columnKey="duration"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                        )}
                        {show('status') && (
                          <SortHeader
                            label="Status"
                            columnKey="status"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                        )}
                        <SortHeader label="Actions" columnKey="_actions" srOnly />
                      </tr>
                    </thead>
                    <tbody>
                      {table.pageRows.map((s) => {
                        const selected = table.isSelected(s)
                        const isActive = s.status === 'ACTIVE'
                        return (
                          <tr key={s.id} className="group">
                            <td className={clsx(stickyCell({ left: 'left-0', selected }), 'px-4', pad)}>
                              <Checkbox
                                checked={selected}
                                onChange={() => table.toggleRow(s)}
                                srLabel={`Select session on ${s.resource_name}`}
                              />
                            </td>
                            <td
                              className={clsx(
                                stickyCell({ left: 'left-12', selected, edge: true }),
                                'px-4',
                                pad
                              )}
                            >
                              <div className="flex min-w-0 items-center gap-3">
                                <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-850 text-ink-400">
                                  <ResourceTypeIcon type={s.resource_type} className="h-4 w-4" />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <button
                                    type="button"
                                    onClick={() => setDetail(s)}
                                    title={s.resource_name}
                                    className="block max-w-full truncate text-left font-medium text-ink-50 transition-colors hover:text-blue-600 dark:hover:text-blue-300"
                                  >
                                    {s.resource_name || s.resource_id || '-'}
                                  </button>
                                  {s.is_breakglass && (
                                    <span className="mt-0.5 flex items-center gap-1 text-2xs font-semibold uppercase tracking-[0.04em] text-red-600 dark:text-red-400">
                                      <ShieldAlert className="h-2.5 w-2.5" strokeWidth={2.5} /> Break-glass
                                    </span>
                                  )}
                                </span>
                              </div>
                            </td>
                            {show('username') && (
                              <td className={clsx(cell({ selected }), 'px-4', pad)}>
                                <TruncCell value={s.username} className="text-ink-300" />
                              </td>
                            )}
                            {show('protocol') && (
                              <td className={clsx(cell({ selected }), 'px-4', pad)}>
                                {s.protocol ? (
                                  <MetaTag mono>{s.protocol}</MetaTag>
                                ) : (
                                  <span className="text-xs text-ink-500">-</span>
                                )}
                              </td>
                            )}
                            {show('started_at') && (
                              <td className={clsx(cell({ selected }), 'px-4 text-xs tabular-nums', pad)}>
                                <span className="text-ink-400" title={formatDateTime(s.started_at)}>
                                  {formatRelativeToNow(s.started_at)}
                                </span>
                              </td>
                            )}
                            {show('duration') && (
                              <td className={clsx(cell({ selected }), 'px-4', pad)}>
                                <DurationCell session={s} />
                              </td>
                            )}
                            {show('status') && (
                              <td className={clsx(cell({ selected }), 'px-4', pad)}>
                                {EXCEPTION_STATUSES.includes(s.status) ? (
                                  <Badge className="bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30">
                                    {s.status}
                                  </Badge>
                                ) : (
                                  <StatusIndicator tone={STATUS_TONE[s.status] || 'neutral'} pulse={isActive}>
                                    {s.status
                                      ? s.status.charAt(0) + s.status.slice(1).toLowerCase()
                                      : 'Unknown'}
                                  </StatusIndicator>
                                )}
                              </td>
                            )}
                            <td className={clsx(cell({ selected }), 'px-2', pad)}>
                              <div className="flex items-center justify-end gap-1">
                                {isActive && (
                                  <Button
                                    size="xs"
                                    variant="secondary"
                                    onClick={() => setEndTarget(s)}
                                    disabled={isMutating}
                                  >
                                    End
                                  </Button>
                                )}
                                {isActive && scope === 'all' && (
                                  <Button
                                    size="xs"
                                    variant="dangerGhost"
                                    onClick={() => setKillTarget(s)}
                                    disabled={isMutating}
                                    aria-label={`Kill session on ${s.resource_name}`}
                                  >
                                    Kill
                                  </Button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => setDetail(s)}
                                  aria-label={`Open session on ${s.resource_name}`}
                                  className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-ink-600 transition-colors hover:bg-surface-800 hover:text-ink-100"
                                >
                                  <ChevronRight className="h-4 w-4" strokeWidth={2} />
                                </button>
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
                  label="sessions"
                />
              </>
            )
          }
        </QueryState>
      </ListPanel>

      <BulkActionBar
        count={table.selectedCount}
        total={table.total}
        noun="session"
        allMatchingSelected={table.allMatchingSelected}
        onSelectAllMatching={table.selectAllMatching}
        onClear={table.clearSelection}
        actions={[
          {
            key: 'export',
            label: 'Export',
            icon: Download,
            onClick: () => {
              exportRowsToCsv(table.selectedRows, CSV_COLUMNS, 'sessions-selection')
              toast.success(`Exported ${table.selectedCount} sessions`)
            },
          },
          {
            key: 'end',
            label: 'End sessions',
            icon: CircleSlash,
            variant: 'dangerGhost',
            disabled: true,
            disabledReason: NO_BULK_ENDPOINT,
          },
        ]}
      />

      <SessionDrawer
        session={detail}
        onClose={() => setDetail(null)}
        onEnd={(s) => setEndTarget(s)}
        onKill={(s) => setKillTarget(s)}
        canKill={scope === 'all'}
        isMutating={isMutating}
      />

      <ConfirmDialog
        open={!!endTarget}
        title={`End your session on "${endTarget?.resource_name}"?`}
        description="The connection is closed and the session is recorded as completed in the audit log."
        confirmLabel="End session"
        isLoading={endMutation.isPending}
        onConfirm={() => endMutation.mutate(endTarget.id)}
        onCancel={() => setEndTarget(null)}
      />

      <ConfirmDialog
        open={!!killTarget}
        title={`Kill session on "${killTarget?.resource_name}"?`}
        description="This immediately terminates another user's tracked session and is recorded in the audit log."
        confirmLabel="Kill session"
        destructive
        requireReason
        reasonLabel="Reason (required for the audit record)"
        isLoading={killMutation.isPending}
        onConfirm={(reason) => killMutation.mutate({ id: killTarget.id, reason })}
        onCancel={() => setKillTarget(null)}
      />
    </div>
  )
}
