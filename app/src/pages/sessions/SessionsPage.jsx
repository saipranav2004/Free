import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import clsx from 'clsx'
import { Copy, MonitorPlay, ShieldAlert, Square } from 'lucide-react'
import { listMySessions, endSession } from '../../api/sessions'
import { listSessions, killSession } from '../../api/admin'
import { useAuthStore } from '../../store/authStore'
import { Container, PageTitle, Stack } from '../../components/ui/layout'
import { DataTable, RowActions, SkeletonGrid, SortTh, Td, Th, Tr, Trunc } from '../../components/ui/grid'
import { MenuItem, RowMenu } from '../../components/ui/menu'
import { AlarmTag, FilterChip, Meta, StatusDot } from '../../components/ui/bits'
import {
  ActiveFilters,
  CommandBar,
  ExportMenu,
  Pagination,
  PreferencesMenu,
  RefreshControl,
  SearchField,
} from '../../components/ui/chrome'
import { DeniedState, EmptyState, ErrorState, NoMatchState, OfflineState } from '../../components/ui/states'
import { Button } from '../../components/common/Button'
import { Drawer } from '../../components/common/Drawer'
import { SegmentedControl, FilterToggle } from '../../components/common/SegmentedControl'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { DetailList } from '../../components/common/Layout'
import { ResourceTypeIcon } from '../../components/resources/ResourceTypeIcon'
import { useTableState } from '../../hooks/useTableState'
import { exportRowsToCsv, exportRowsToJson } from '../../lib/exportRows'
import { formatDateTime, formatDuration, formatRelativeToNow } from '../../lib/format'
import { SESSIONS_POLL_MS } from '../../config/constants'
import { apiErrorMessage, normalizeApiError } from '../../lib/apiError'

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

// Status is a dot plus its word in one cell. A live session's dot pulses,
// which is the only ambient animation in the product and the one place it
// carries information rather than decorating.
const DOT_TONE = {
  ACTIVE: 'ok',
  COMPLETED: 'muted',
  KILLED: 'danger',
  FAILED: 'danger',
}

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
    live && secs >= 4 * 3600 ? 'text-danger' : live && secs >= 3600 ? 'text-warn' : 'text-secondary'
  return (
    <span className={clsx('font-mono text-sm tabular', tone)} title={live ? 'Still running' : undefined}>
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
      <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-3">
        <StatusDot tone={DOT_TONE[session.status] || 'muted'} label={session.status} live={isActive} />
        {session.is_breakglass && <AlarmTag />}
        {session.protocol && <Meta mono>{session.protocol}</Meta>}
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
    // View state in the address bar, so a filtered list is something you can
    // send to someone. See useTableState.
    urlSync: true,
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
      toast.success('Session ended', {
        description: 'The connection was terminated and the reason recorded to the audit log.',
      })
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

  const err = query.isError ? normalizeApiError(query.error) : null
  const colSpan = COLUMNS.length + 1
  const clearAll = () => {
    setSearch('')
    table.setFilters({ status: 'all', breakglass: false })
  }

  return (
    <Stack gap="lg">
      <PageTitle
        title="Sessions"
        counter={query.isSuccess ? rows.length : undefined}
        description={
          scope === 'mine'
            ? 'Connections opened in your name, live and historic.'
            : 'Every connection open across the organisation.'
        }
        actions={
          scopes.length > 1 && (
            <SegmentedControl
              size="sm"
              ariaLabel="Session scope"
              value={scope}
              onChange={setScope}
              options={scopes.map((sc) => ({ key: sc.key, label: sc.label }))}
            />
          )
        }
      />

      {/* Live posture as three facts on a rule, not a wall of KPI cards. Each
          is a count this page already holds, and none of them is a trend,
          because the API returns point in time state with no history. */}
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 border-y border-line-soft py-3">
        <span className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular text-primary">{activeRows.length}</span>
          <span className="text-sm text-secondary">active now</span>
        </span>
        {breakglassActive > 0 && (
          <span className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular text-danger">{breakglassActive}</span>
            <span className="text-sm text-secondary">under break glass</span>
          </span>
        )}
        {longest > 0 && (
          <span className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular text-primary">{formatDuration(longest)}</span>
            <span className="text-sm text-secondary">longest running</span>
          </span>
        )}
        {truncated && (
          <span className="text-sm text-warn">
            Showing the most recent {rows.length} of {serverTotal}. Narrow the filters to see the rest.
          </span>
        )}
      </div>

      <Stack gap="sm">
        <CommandBar
          summary={
            query.isSuccess && table.total !== rows.length
              ? `${table.total} of ${rows.length} shown`
              : undefined
          }
        >
          <FilterToggle checked={activeOnly} onChange={setActiveOnly} label="Active only" />
          <ExportMenu
            count={table.filteredRows.length}
            disabled={table.filteredRows.length === 0}
            onExportCsv={() => exportRowsToCsv(table.filteredRows, CSV_COLUMNS, 'sessions')}
            onExportJson={() => exportRowsToJson(table.filteredRows, CSV_COLUMNS, 'sessions')}
          />
          <RefreshControl
            onRefresh={() => query.refetch()}
            isFetching={query.isFetching}
            updatedAt={query.dataUpdatedAt}
          />
          <PreferencesMenu
            columns={COLUMNS}
            visible={table.visibleColumns}
            onVisibleChange={table.setVisibleColumns}
            pageSize={table.pageSize}
            onPageSize={table.setPageSize}
          />
        </CommandBar>

        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Search resource, user or protocol"
            label="Search sessions"
          />
          {statusFacets.length > 2 &&
            statusFacets.map((f) => (
              <FilterChip
                key={f.key}
                active={table.filters.status === f.key}
                count={f.count}
                onClick={() => table.setFilter('status', f.key)}
              >
                {f.label}
              </FilterChip>
            ))}
          <FilterChip
            active={table.filters.breakglass}
            count={rows.filter((r) => r.is_breakglass).length}
            onClick={() => table.setFilter('breakglass', !table.filters.breakglass)}
          >
            Break glass
          </FilterChip>
        </div>

        <ActiveFilters chips={chips} onClearAll={clearAll} />
      </Stack>

      <Container padded={false}>
        {query.isLoading ? (
          <table className="w-full">
            <tbody>
              <SkeletonGrid colSpan={colSpan} rows={8} />
            </tbody>
          </table>
        ) : err ? (
          err.status === 403 ? (
            <DeniedState description={err.message} />
          ) : err.code === 'network_error' ? (
            <OfflineState onRetry={() => query.refetch()} retrying={query.isFetching} />
          ) : (
            <ErrorState
              description={err.message}
              onRetry={() => query.refetch()}
              retrying={query.isFetching}
            />
          )
        ) : rows.length === 0 ? (
          <EmptyState
            icon={MonitorPlay}
            title={activeOnly ? 'No sessions are open' : 'No sessions yet'}
            description={
              activeOnly
                ? 'Nothing is connected right now. Turn off Active only to see completed sessions.'
                : 'A session appears here as soon as somebody connects to a resource.'
            }
            action={
              activeOnly ? (
                <Button variant="subtle" onClick={() => setActiveOnly(false)}>
                  Show all sessions
                </Button>
              ) : null
            }
          />
        ) : table.total === 0 ? (
          <NoMatchState description="No session matches the current search and filters." onClear={clearAll} />
        ) : (
          <>
            <DataTable minWidth="62rem">
              <colgroup>
                {show('resource_name') && <col className="w-[17rem] min-w-[13rem]" />}
                {show('username') && <col className="w-[11rem]" />}
                {show('protocol') && <col className="w-[6.5rem]" />}
                {show('started_at') && <col className="w-[11rem]" />}
                {show('duration') && <col className="w-[8rem]" />}
                {show('status') && <col className="w-[8.5rem]" />}
                <col className="w-[9rem]" />
              </colgroup>

              <thead>
                <tr>
                  {show('resource_name') && (
                    <SortTh columnKey="resource_name" sort={table.sort} onSort={table.toggleSort} sticky edge>
                      Resource
                    </SortTh>
                  )}
                  {show('username') && (
                    <SortTh columnKey="username" sort={table.sort} onSort={table.toggleSort}>
                      User
                    </SortTh>
                  )}
                  {show('protocol') && (
                    <SortTh columnKey="protocol" sort={table.sort} onSort={table.toggleSort}>
                      Protocol
                    </SortTh>
                  )}
                  {/* A timestamp is qualitative and stays left aligned. A
                      duration is a quantity, so it is right aligned and
                      tabular, and so is its header. */}
                  {show('started_at') && (
                    <SortTh columnKey="started_at" sort={table.sort} onSort={table.toggleSort}>
                      Started
                    </SortTh>
                  )}
                  {show('duration') && (
                    <SortTh columnKey="duration" sort={table.sort} onSort={table.toggleSort} align="right">
                      Duration
                    </SortTh>
                  )}
                  {show('status') && (
                    <SortTh columnKey="status" sort={table.sort} onSort={table.toggleSort}>
                      Status
                    </SortTh>
                  )}
                  <Th align="right">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>

              <tbody>
                {table.pageRows.map((sess) => {
                  const isActive = sess.status === 'ACTIVE'
                  const canKill = isAdmin && isActive
                  const isMine = scope === 'mine'
                  return (
                    <Tr key={sess.id}>
                      {show('resource_name') && (
                        <Td sticky edge>
                          <div className="flex min-w-0 items-center gap-2.5">
                            <ResourceTypeIcon
                              type={sess.resource_type}
                              className="h-4 w-4 flex-none text-tertiary"
                            />
                            <button
                              type="button"
                              onClick={() => setDetail(sess)}
                              title={sess.resource_name}
                              className="min-w-0 truncate text-sm font-medium text-primary transition-colors hover:text-accent hover:underline"
                            >
                              {sess.resource_name || sess.resource_id}
                            </button>
                            {sess.is_breakglass && <AlarmTag />}
                          </div>
                        </Td>
                      )}
                      {show('username') && (
                        <Td>
                          <Trunc value={sess.username} muted />
                        </Td>
                      )}
                      {show('protocol') && (
                        <Td>
                          <Trunc value={sess.protocol} mono muted />
                        </Td>
                      )}
                      {show('started_at') && (
                        <Td>
                          <span className="text-sm text-secondary" title={formatDateTime(sess.started_at)}>
                            {formatRelativeToNow(sess.started_at)}
                          </span>
                        </Td>
                      )}
                      {show('duration') && (
                        <Td align="right">
                          <DurationCell session={sess} />
                        </Td>
                      )}
                      {show('status') && (
                        <Td>
                          <StatusDot
                            tone={DOT_TONE[sess.status] || 'muted'}
                            label={
                              sess.status
                                ? sess.status.charAt(0) + sess.status.slice(1).toLowerCase()
                                : 'Unknown'
                            }
                            live={isActive}
                          />
                        </Td>
                      )}
                      <Td align="right">
                        <RowActions>
                          {isActive && isMine && (
                            <button
                              type="button"
                              onClick={() => setEndTarget(sess)}
                              className="whitespace-nowrap rounded px-1 py-0.5 text-sm font-semibold text-accent transition-colors hover:text-accent-hover hover:underline"
                            >
                              End
                            </button>
                          )}
                          <RowMenu label={`Actions for session on ${sess.resource_name || sess.resource_id}`}>
                            <MenuItem icon={MonitorPlay} onClick={() => setDetail(sess)}>
                              View details
                            </MenuItem>
                            <MenuItem
                              icon={Copy}
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(sess.id)
                                  toast.success('Session ID copied')
                                } catch {
                                  toast.error('Clipboard is not available in this browser')
                                }
                              }}
                            >
                              Copy session ID
                            </MenuItem>
                            {isActive && isMine && (
                              <MenuItem icon={Square} onClick={() => setEndTarget(sess)}>
                                End my session
                              </MenuItem>
                            )}
                            {canKill && (
                              <MenuItem icon={ShieldAlert} danger onClick={() => setKillTarget(sess)}>
                                Kill session
                              </MenuItem>
                            )}
                          </RowMenu>
                        </RowActions>
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </DataTable>

            <Pagination
              page={table.page}
              pageSize={table.pageSize}
              total={table.total}
              totalPages={table.totalPages}
              onPageChange={table.setPage}
              label="sessions"
            />
          </>
        )}
      </Container>

      <SessionDrawer
        session={detail}
        onClose={() => setDetail(null)}
        onEnd={setEndTarget}
        onKill={setKillTarget}
        canKill={isAdmin}
        isMutating={isMutating}
      />

      <ConfirmDialog
        open={!!endTarget}
        title={`End your session on ${endTarget?.resource_name || 'this resource'}?`}
        description="The session is closed and marked completed. Anything open in your own client stops being covered by it."
        confirmLabel="End session"
        destructive={false}
        isLoading={endMutation.isPending}
        onConfirm={() => endMutation.mutate(endTarget.id)}
        onCancel={() => setEndTarget(null)}
      />

      <ConfirmDialog
        open={!!killTarget}
        title={`Kill the session on ${killTarget?.resource_name || 'this resource'}?`}
        description="The session is terminated immediately for the person using it."
        confirmLabel="Kill session"
        destructive
        requireReason
        reasonLabel="Reason (written to the audit record)"
        isLoading={killMutation.isPending}
        onConfirm={(reason) => killMutation.mutate({ id: killTarget.id, reason })}
        onCancel={() => setKillTarget(null)}
      />
    </Stack>
  )
}
