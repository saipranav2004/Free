import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { Ban, Copy, Download, KeyRound, Lock, Trash2, UserPlus, Users } from 'lucide-react'
import clsx from 'clsx'
import { toast } from 'sonner'
import { listUsers, getUser } from '../../api/identity'
import { rolesOfUser, rolesOfAccess } from '../../lib/roles'
import { listRoles } from '../../api/rbac'
import { normalizeApiError } from '../../lib/apiError'
import { Container, PageTitle, Stack } from '../../components/ui/layout'
import {
  DataTable,
  RowActions,
  RowCheckbox,
  SelectAll,
  SkeletonGrid,
  SortTh,
  Td,
  Th,
  Tr,
  Trunc,
} from '../../components/ui/grid'
import { MenuItem, RowMenu } from '../../components/ui/menu'
import { FilterChip, Meta, StatusDot } from '../../components/ui/bits'
import {
  ActiveFilters,
  BulkBar,
  CommandBar,
  ExportMenu,
  Pagination,
  PreferencesMenu,
  RefreshControl,
  SavedViewsMenu,
  SearchField,
} from '../../components/ui/chrome'
import { DeniedState, EmptyState, ErrorState, NoMatchState, OfflineState } from '../../components/ui/states'
import { Button } from '../../components/common/Button'
import { CreateUserModal } from '../../components/admin/CreateUserModal'
import { useSavedViews } from '../../components/common/TableControls'
import { useTableState } from '../../hooks/useTableState'
import { exportRowsToCsv, exportRowsToJson } from '../../lib/exportRows'
import { formatDateTime, formatRelativeToNow } from '../../lib/format'
import { isPrivilegedRoleName, normalizeRoleList, SEARCH_DEBOUNCE_MS } from '../../config/constants'

// Per-row state uses an indicator, not a filled pill, see Badge.jsx for why
// (a status column populated on every row turns a table into 25 glowing
// blocks in dark mode). Only genuinely exceptional values keep a badge.
// Up to two role names, then a count. Two is what fits without wrapping at
// the width this column gets, and the count is honest about the rest: hover
// or open the account to see them all.
function RoleCells({ roles, unknown }) {
  // "None" is a claim about the account. "-" is a claim about this screen.
  // The list payload does not always carry roles, so the two must not be
  // rendered the same way.
  if (unknown) return <span className="text-sm text-tertiary">Not loaded</span>
  if (!roles || roles.length === 0) return <span className="text-sm text-tertiary">None</span>
  const shown = roles.slice(0, 2)
  const rest = roles.length - shown.length
  return (
    <span className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden" title={roles.join(', ')}>
      {shown.map((r) => (
        <span
          key={r}
          className={clsx(
            'max-w-[7rem] flex-none truncate rounded px-1.5 py-0.5 text-xs font-medium',
            isPrivilegedRoleName(r) ? 'bg-warn-soft text-warn' : 'bg-subtle text-secondary'
          )}
        >
          {r}
        </span>
      ))}
      {rest > 0 && <span className="flex-none text-xs tabular text-tertiary">+{rest}</span>}
    </span>
  )
}

// Status appears twice on a row, and that is deliberate: as a dot beside the
// username where the eye already is, and as a word in its own sortable column.
// The dot carries the colour, the word carries the meaning, and neither is a
// filled pill.
const DOT_TONE = {
  ACTIVE: 'ok',
  DISABLED: 'muted',
  INACTIVE: 'muted',
  LOCKED: 'warn',
  SUSPENDED: 'danger',
  DELETED: 'danger',
}

const STATUS_TEXT = {
  ACTIVE: 'text-ok',
  LOCKED: 'text-warn',
  SUSPENDED: 'text-danger',
  DELETED: 'text-danger',
  DISABLED: 'text-tertiary',
  INACTIVE: 'text-tertiary',
}

// ---------------------------------------------------------------------------
// Admin Center, Identity
// ---------------------------------------------------------------------------
// The account inventory, built the way Okta's People list and Entra's Users
// blade are: one dense table with a status facet you can hit in one click, a
// role facet, saved views, column control, density, export and selection.
//
// SEARCH IS SERVER-SIDE and debounced, because listUsers(q) genuinely takes
// that parameter. Everything the endpoint does NOT support, status facet,
// role facet, sort, paging, is applied client-side over the returned
// collection, which is honest and stays correct. useTableState is shaped like
// a server pager so none of this has to be rewritten when paging lands.
//
// No bulk mutation is wired: /admin/identity exposes no batch route. The
// destructive bulk actions render disabled with the reason rather than fanning
// out N requests behind one innocuous click.

// THE IDENTITY COLUMN NOW CARRIES THE EMAIL, and this is the change that
// bought the table its width back.
//
// Username, Email and Full name were three separate columns, and all three
// truncated: "contractor.svc.ingestion-pip…", "ingestion-pipeline@contracto…",
// "Ingestion Pipeline …". Three clipped strings that together are one fact,
// who this account is. Okta's People list, Entra's Users blade and AWS IAM
// all fold the secondary identifier under the primary one in a single cell,
// because it is read as a unit and because one wide column truncates far
// later than three narrow ones.
//
// A ROLES COLUMN IS BACK, replacing the amber "Privileged" sub-label that
// used to sit under the username. That marker only ever answered yes or no,
// and it fired on half the rows, which is not an exception any more. The
// roles themselves answer the same question and several others, and there is
// now room to show them.
const COLUMNS = [
  { key: 'username', label: 'User', required: true },
  { key: 'full_name', label: 'Full name' },
  { key: 'roles', label: 'Roles' },
  { key: 'status', label: 'Status' },
  { key: 'created_at', label: 'Created', defaultHidden: true },
  { key: 'last_login_at', label: 'Last sign-in' },
]

const CSV_COLUMNS = [
  { key: 'username', label: 'Username' },
  { key: 'email', label: 'Email' },
  { key: 'full_name', label: 'Full name' },
  { key: 'status', label: 'Status' },
  { key: 'roles', label: 'Roles', value: (u) => rolesOf(u).join(' | ') },
  { key: 'created_at', label: 'Created' },
  { key: 'last_login_at', label: 'Last sign-in' },
  { key: 'user_id', label: 'User ID' },
]

const NO_BULK_ENDPOINT = 'Requires a backend batch endpoint, not available yet'

// Ceiling and batch size for filling in roles the list endpoint did not send.
// 120 accounts at 8 in flight is a handful of round trips; past that the Role
// facet is disabled with the reason rather than hammering the API.
const ROLE_HYDRATION_LIMIT = 120
const ROLE_HYDRATION_CHUNK = 8

// THE BUG THIS PAGE FIXES (bug sheet #34). The Roles column read `user.roles`
// and nothing else, so every row showed "None" and the Role facet matched
// nobody, while the SAME account, opened from that list, showed its role
// correctly. Two different causes hide behind that one symptom:
//
//   1. The list reports roles under another name. lib/roles.js reads every
// spelling, so that case is absorbed there.
//   2. The list genuinely carries no role data. No parsing invents it, so the
// page hydrates roles from the account endpoint, see the hydration query
// in the component below.
const rolesOf = rolesOfUser

function isPrivileged(user) {
  return rolesOf(user).some(isPrivilegedRoleName)
}

// Row menu, per-row actions that don't need the detail page. Deliberately
// short: everything destructive lives on the account's own page behind a
// confirm, never one click from a list.
export default function IdentityListPage() {
  const [createOpen, setCreateOpen] = useState(false)

  // Deep link from the dashboard's Administration shortcuts: /…?new=1 opens
  // the create form directly. The param is stripped immediately so a reload
  // or a back-navigation doesn't reopen a dialog the user already dismissed.
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    if (params.get('new') === null) return
    setCreateOpen(true)
    const next = new URLSearchParams(params)
    next.delete('new')
    setParams(next, { replace: true })
  }, [params, setParams])

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [focusedId, setFocusedId] = useState(null)

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  const usersQuery = useQuery({
    queryKey: ['admin', 'users', search],
    queryFn: ({ signal }) => listUsers(search || undefined, signal),
  })

  const rawUsers = useMemo(() => usersQuery.data?.users || [], [usersQuery.data])

  // Does the list payload carry roles at all? One row with a role is enough ,
  // an install where genuinely nobody has a role would hydrate once, find
  // nothing, and cache that.
  const listHasRoles = useMemo(() => rawUsers.some((u) => rolesOf(u).length > 0), [rawUsers])

  const hydrationIds = useMemo(() => rawUsers.map((u) => u.user_id).filter(Boolean), [rawUsers])
  // Only hydrate when it is both NEEDED and BOUNDED. Past the cap the Role
  // facet says why it is unavailable instead of firing hundreds of requests at
  // the identity endpoint behind one page load.
  const canHydrate = !listHasRoles && hydrationIds.length > 0 && hydrationIds.length <= ROLE_HYDRATION_LIMIT

  const rolesHydration = useQuery({
    queryKey: ['admin', 'users', 'role-hydration', hydrationIds.join(',')],
    enabled: canHydrate,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const byId = {}
      // Chunked rather than one Promise.all over every account: a hundred
      // simultaneous requests is a self-inflicted thundering herd, and a
      // strictly sequential loop would take a minute on a large directory.
      for (let i = 0; i < hydrationIds.length; i += ROLE_HYDRATION_CHUNK) {
        const chunk = hydrationIds.slice(i, i + ROLE_HYDRATION_CHUNK)
        // eslint-disable-next-line no-await-in-loop
        const results = await Promise.all(
          chunk.map((id) =>
            getUser(id, signal)
              .then((d) => ({ id, roles: rolesOfAccess(d) }))
              // One unreadable account must not blank the whole column.
              .catch(() => ({ id, roles: [] }))
          )
        )
        for (const r of results) byId[r.id] = r.roles
      }
      return byId
    },
  })

  // The rows every other part of this screen sees, column, facet counts,
  // filter, sort and export all read `roles`, so filling it in here fixes all
  // five at once rather than special-casing each.
  const users = useMemo(() => {
    const hydrated = rolesHydration.data
    if (!hydrated) return rawUsers
    return rawUsers.map((u) => {
      const names = hydrated[u.user_id]
      return names && names.length > 0 ? { ...u, roles: names } : u
    })
  }, [rawUsers, rolesHydration.data])

  // Roles are unknown, not absent, while the fill-in is still running or when
  // the directory was too large to hydrate. The difference matters: "None" is
  // a claim about the account, "-" is a claim about this screen.
  const rolesUnknown = !listHasRoles && !rolesHydration.data
  const rolesPending = canHydrate && rolesHydration.isFetching && !rolesHydration.data
  const roleFilterDisabled = rolesUnknown

  // The role facet reads the live catalogue, not the three built-ins it used
  // to hard-code, a custom role you cannot filter by is as invisible here as
  // one you cannot assign. Shares its cache entry with the Roles screen.
  const rolesQuery = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: ({ signal }) => listRoles(signal),
  })

  // Union of "roles that exist" and "roles actually held by a row", so a role
  // deleted from the catalogue while still attached to an account stays
  // filterable instead of stranding those rows behind no facet at all.
  const roleFacets = useMemo(() => {
    const held = new Map()
    for (const u of users) {
      for (const r of rolesOf(u)) {
        if (!held.has(String(r).toLowerCase())) held.set(String(r).toLowerCase(), String(r))
      }
    }
    // Catalogue entries go first so normalizeRoleList (which keeps the first
    // occurrence of each name) uses the catalogue's own casing.
    const names = normalizeRoleList([
      ...(rolesQuery.data || []),
      ...[...held.values()].map((name) => ({ name })),
    ])
    return names.map((r) => {
      const value = String(r.name).toLowerCase()
      return {
        value,
        label: r.name,
        count: users.filter((u) => rolesOf(u).some((x) => String(x).toLowerCase() === value)).length,
      }
    })
  }, [rolesQuery.data, users])

  const table = useTableState({
    rows: users,
    storageKey: 'identity',
    rowId: (u) => u.user_id,
    initialSort: { key: 'username', dir: 'asc' },
    initialPageSize: 25,
    initialFilters: { status: 'all', role: 'all' },
    // Created is off by default. Seven columns at readable widths do not fit a
    // 1080px panel, and of the seven this is the one nobody scans: an account
    // list is read for who is active and who signed in recently, not for when
    // a row was inserted. It is one click away in Columns, and it is always in
    // the export.
    initialColumns: COLUMNS.filter((c) => !c.defaultHidden).map((c) => c.key),
    filterFn: (u, f) => {
      if (f.status !== 'all' && (u.status || 'UNKNOWN') !== f.status) return false
      if (f.role !== 'all' && !rolesOf(u).some((r) => r.toLowerCase() === f.role)) return false
      return true
    },
    sortAccessor: (u, key) => (key === 'roles' ? rolesOf(u).join(', ') : u[key]),
  })

  const savedViews = useSavedViews('identity')
  const [activeView, setActiveView] = useState(null)

  const counts = useMemo(
    () => ({
      total: users.length,
      active: users.filter((u) => u.status === 'ACTIVE').length,
      disabled: users.filter((u) => u.status === 'DISABLED' || u.status === 'INACTIVE').length,
      locked: users.filter((u) => u.status === 'LOCKED').length,
      privileged: users.filter(isPrivileged).length,
      neverSignedIn: users.filter((u) => !u.last_login_at).length,
    }),
    [users]
  )

  const statusFacets = useMemo(() => {
    const seen = [...new Set(users.map((u) => u.status || 'UNKNOWN'))].sort()
    return [
      { key: 'all', label: 'All', count: users.length },
      ...seen.map((s) => ({
        key: s,
        label: s.charAt(0) + s.slice(1).toLowerCase(),
        count: users.filter((u) => (u.status || 'UNKNOWN') === s).length,
      })),
    ]
  }, [users])

  // j/k row focus and x to select, the keyboard grammar every dense admin
  // table in this class of product uses. Never fires while typing in a field.
  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      )
        return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const rows = table.pageRows
      if (rows.length === 0) return
      const idx = rows.findIndex((r) => r.user_id === focusedId)
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedId(rows[Math.min(idx + 1, rows.length - 1)]?.user_id ?? rows[0].user_id)
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedId(rows[Math.max(idx - 1, 0)]?.user_id ?? rows[0].user_id)
      } else if (e.key === 'x' && idx >= 0) {
        e.preventDefault()
        table.toggleRow(rows[idx])
      } else if (e.key === 'Escape') {
        setFocusedId(null)
        table.clearSelection()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [focusedId, table])

  const show = (key) => !table.visibleColumns || table.visibleColumns.includes(key)

  const chips = []
  if (search) chips.push({ key: 'q', label: 'Search', value: search, onClear: () => setSearchInput('') })
  if (table.filters.status !== 'all') {
    chips.push({
      key: 'status',
      label: 'Status',
      value: table.filters.status,
      onClear: () => table.setFilter('status', 'all'),
    })
  }
  if (table.filters.role !== 'all') {
    chips.push({
      key: 'role',
      label: 'Role',
      value: table.filters.role,
      onClear: () => table.setFilter('role', 'all'),
    })
  }

  const bulkActions = [
    {
      key: 'export',
      label: 'Export',
      icon: Download,
      onClick: () => {
        exportRowsToCsv(table.selectedRows, CSV_COLUMNS, 'identity-selection')
        toast.success(`Exported ${table.selectedCount} accounts`)
      },
    },
    { key: 'disable', label: 'Disable', icon: Ban, disabled: true, disabledReason: NO_BULK_ENDPOINT },
    { key: 'unlock', label: 'Unlock', icon: Lock, disabled: true, disabledReason: NO_BULK_ENDPOINT },
    {
      key: 'delete',
      label: 'Delete',
      icon: Trash2,
      variant: 'dangerGhost',
      disabled: true,
      disabledReason: NO_BULK_ENDPOINT,
    },
  ]

  const err = usersQuery.isError ? normalizeApiError(usersQuery.error) : null
  const colSpan = COLUMNS.length + 2

  const clearAll = () => {
    setSearchInput('')
    table.setFilters({ status: 'all', role: 'all' })
    setActiveView(null)
  }

  return (
    <Stack gap="lg">
      <PageTitle
        title="Identity"
        counter={usersQuery.isSuccess ? counts.total : undefined}
        description="Every account in this install, and the roles and policies that decide what it can reach."
      />

      <Stack gap="sm">
        <CommandBar
          primary={
            <Button variant="primary" icon={UserPlus} onClick={() => setCreateOpen(true)}>
              Create user
            </Button>
          }
          summary={
            usersQuery.isSuccess && table.total !== counts.total
              ? `${table.total} of ${counts.total} shown`
              : undefined
          }
        >
          <SavedViewsMenu
            views={savedViews.views}
            activeName={activeView}
            canSave={table.activeFilterCount > 0 || !!search}
            onApply={(v) => {
              setSearchInput(v.state.query || '')
              table.setFilters({ status: 'all', role: 'all', ...(v.state.filters || {}) })
              setActiveView(v.name)
            }}
            onSave={(name) => {
              savedViews.saveView(name, { query: search, filters: table.filters })
              setActiveView(name)
              toast.success(`Saved view "${name}"`)
            }}
            onRemove={(name) => {
              savedViews.removeView(name)
              if (activeView === name) setActiveView(null)
            }}
          />
          <ExportMenu
            count={table.filteredRows.length}
            disabled={table.filteredRows.length === 0}
            onExportCsv={() => exportRowsToCsv(table.filteredRows, CSV_COLUMNS, 'identity')}
            onExportJson={() => exportRowsToJson(table.filteredRows, CSV_COLUMNS, 'identity')}
          />
          <RefreshControl
            onRefresh={() => usersQuery.refetch()}
            isFetching={usersQuery.isFetching}
            updatedAt={usersQuery.dataUpdatedAt}
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
          {/* Search is SERVER SIDE and debounced, because listUsers(q) genuinely
              takes the parameter. Everything the endpoint does not support,
              status, role, sort and paging, is applied over the returned
              collection, which is honest and stays correct. */}
          <SearchField
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search username or email"
            label="Search accounts"
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
          <label className="flex flex-none items-center gap-2">
            <span className="whitespace-nowrap text-sm text-secondary">Role</span>
            <select
              value={table.filters.role}
              disabled={roleFilterDisabled}
              onChange={(e) => table.setFilter('role', e.target.value)}
              title={roleFilterDisabled ? 'Roles are not on the list payload for this directory' : undefined}
              className="h-9 cursor-pointer rounded-lg border border-line-strong bg-surface pl-2.5 pr-7 text-sm text-primary transition-colors hover:border-primary/40 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:bg-subtle disabled:text-disabled"
            >
              <option value="all">Any role</option>
              {roleFacets.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label} ({r.count})
                </option>
              ))}
            </select>
          </label>
          {rolesPending && <span className="text-xs text-tertiary">Loading roles</span>}
        </div>

        <ActiveFilters chips={chips} onClearAll={clearAll} />

        <BulkBar count={table.selectedCount} onClear={table.clearSelection}>
          {bulkActions.map((a) => (
            <Button
              key={a.key}
              size="sm"
              variant={a.key === 'delete' ? 'dangerGhost' : 'subtle'}
              icon={a.icon}
              disabled={a.disabled}
              title={a.disabledReason}
              onClick={a.onClick}
            >
              {a.label}
            </Button>
          ))}
        </BulkBar>
      </Stack>

      <Container padded={false}>
        {usersQuery.isLoading ? (
          <table className="w-full">
            <tbody>
              <SkeletonGrid colSpan={colSpan} rows={10} />
            </tbody>
          </table>
        ) : err ? (
          err.status === 403 ? (
            <DeniedState description={err.message} />
          ) : err.code === 'network_error' ? (
            <OfflineState onRetry={() => usersQuery.refetch()} retrying={usersQuery.isFetching} />
          ) : (
            <ErrorState
              description={err.message}
              onRetry={() => usersQuery.refetch()}
              retrying={usersQuery.isFetching}
            />
          )
        ) : counts.total === 0 ? (
          <EmptyState
            icon={Users}
            title="No accounts yet"
            description="Create the first account and it will appear here with its roles and sign-in history."
            action={
              <Button variant="primary" icon={UserPlus} onClick={() => setCreateOpen(true)}>
                Create the first user
              </Button>
            }
          />
        ) : table.total === 0 ? (
          <NoMatchState description="No account matches the current search and filters." onClear={clearAll} />
        ) : (
          <>
            <DataTable minWidth="62rem">
              {/* Budgeted to fit without clipping: 44 + 288 + 176 + 208 + 128
                  + 160 + 60 = 1064 inside a ~1130px panel. */}
              <colgroup>
                <col className="w-11" />
                {show('username') && <col className="w-[18rem] min-w-[14rem]" />}
                {show('full_name') && <col className="w-[11rem]" />}
                {show('roles') && <col className="w-[13rem]" />}
                {show('status') && <col className="w-[8rem]" />}
                {show('created_at') && <col className="w-[10rem]" />}
                {show('last_login_at') && <col className="w-[10rem]" />}
                <col className="w-[3.75rem]" />
              </colgroup>

              <thead>
                <tr>
                  <Th sticky left="left-0">
                    <SelectAll
                      total={table.pageRows.length}
                      selected={table.pageRows.filter((u) => table.isSelected(u)).length}
                      onChange={(all) => (all ? table.clearSelection() : table.selectPage())}
                    />
                  </Th>
                  {show('username') && (
                    <SortTh
                      columnKey="username"
                      sort={table.sort}
                      onSort={table.toggleSort}
                      sticky
                      left="left-11"
                      edge
                    >
                      User
                    </SortTh>
                  )}
                  {show('full_name') && (
                    <SortTh columnKey="full_name" sort={table.sort} onSort={table.toggleSort}>
                      Full name
                    </SortTh>
                  )}
                  {show('roles') && <Th>Roles</Th>}
                  {show('status') && (
                    <SortTh columnKey="status" sort={table.sort} onSort={table.toggleSort}>
                      Status
                    </SortTh>
                  )}
                  {show('created_at') && (
                    <SortTh columnKey="created_at" sort={table.sort} onSort={table.toggleSort}>
                      Created
                    </SortTh>
                  )}
                  {show('last_login_at') && (
                    <SortTh columnKey="last_login_at" sort={table.sort} onSort={table.toggleSort}>
                      Last sign-in
                    </SortTh>
                  )}
                  <Th align="right">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>

              <tbody>
                {table.pageRows.map((u) => {
                  const selected = table.isSelected(u)
                  return (
                    <Tr key={u.user_id} selected={selected}>
                      <Td sticky left="left-0" selected={selected}>
                        <RowCheckbox
                          checked={selected}
                          onChange={() => table.toggleRow(u)}
                          label={`Select ${u.username}`}
                        />
                      </Td>
                      {show('username') && (
                        <Td sticky left="left-11" edge selected={selected}>
                          {/* Status rides as a dot next to the name instead of
                              taking its own column: the eye is already here,
                              and a populated status column spends 8rem on a
                              word the colour has already said. The word is
                              still in the Status column for scanning and in
                              the title for screen readers. */}
                          <div className="flex min-w-0 items-center gap-2.5">
                            <StatusDot
                              tone={DOT_TONE[u.status] || 'muted'}
                              title={u.status || 'Unknown'}
                              className="flex-none"
                            />
                            <div className="min-w-0">
                              <Link
                                to={`/admin/identity/${u.user_id}`}
                                title={u.username}
                                className="block truncate text-sm font-medium text-primary transition-colors hover:text-accent hover:underline"
                              >
                                {u.username}
                              </Link>
                              {u.email && (
                                <span
                                  className="block truncate font-mono text-xs text-tertiary"
                                  title={u.email}
                                >
                                  {u.email}
                                </span>
                              )}
                            </div>
                            {u.is_protected && <Meta>protected</Meta>}
                          </div>
                        </Td>
                      )}
                      {show('full_name') && (
                        <Td selected={selected}>
                          <Trunc value={u.full_name} muted />
                        </Td>
                      )}
                      {show('roles') && (
                        <Td selected={selected}>
                          <RoleCells roles={rolesOf(u)} unknown={rolesUnknown} />
                        </Td>
                      )}
                      {show('status') && (
                        <Td selected={selected}>
                          <span className={clsx('text-sm', STATUS_TEXT[u.status] || 'text-secondary')}>
                            {u.status ? u.status.charAt(0) + u.status.slice(1).toLowerCase() : 'Unknown'}
                          </span>
                        </Td>
                      )}
                      {show('created_at') && (
                        <Td selected={selected}>
                          <Trunc value={u.created_at ? formatDateTime(u.created_at) : null} muted />
                        </Td>
                      )}
                      {show('last_login_at') && (
                        <Td selected={selected}>
                          {u.last_login_at ? (
                            <span className="text-sm text-secondary" title={formatDateTime(u.last_login_at)}>
                              {formatRelativeToNow(u.last_login_at)}
                            </span>
                          ) : (
                            <span className="text-sm text-tertiary">Never</span>
                          )}
                        </Td>
                      )}
                      <Td align="right" selected={selected}>
                        <RowActions>
                          <RowMenu label={`Actions for ${u.username}`}>
                            <MenuItem icon={Users}>
                              <Link to={`/admin/identity/${u.user_id}`} className="block">
                                Open account
                              </Link>
                            </MenuItem>
                            <MenuItem icon={KeyRound}>
                              <Link to={`/admin/identity/${u.user_id}?tab=security`} className="block">
                                Reset password
                              </Link>
                            </MenuItem>
                            <MenuItem
                              icon={Copy}
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(u.user_id)
                                  toast.success('User ID copied')
                                } catch {
                                  toast.error('Clipboard is not available in this browser')
                                }
                              }}
                            >
                              Copy user ID
                            </MenuItem>
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
              label="accounts"
            />
          </>
        )}
      </Container>

      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </Stack>
  )
}
