import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Plus,
  ChevronRight,
  UserPlus,
  Users,
  ShieldAlert,
  SearchX,
  Download,
  Lock,
  Ban,
  Trash2,
  ShieldCheck,
  MoreHorizontal,
  Copy,
  KeyRound,
} from 'lucide-react'
import clsx from 'clsx'
import { toast } from 'sonner'
import { listUsers, getUser } from '../../api/identity'
import { rolesOfUser, rolesOfAccess } from '../../lib/roles'
import { listRoles } from '../../api/rbac'
import { PageHeader, Card, EmptyState, ListPanel } from '../../components/common/Layout'
import { QueryState } from '../../components/common/QueryState'
import { StatusIndicator } from '../../components/common/Badge'
import { stickyCell, stickyHeader, cell, COL, TruncCell } from '../../components/common/tableStyles'
import { Button } from '../../components/common/Button'
import { Checkbox } from '../../components/common/Checkbox'
import { Pagination } from '../../components/common/Pagination'
import { BulkActionBar } from '../../components/common/BulkActionBar'
import { SegmentedControl } from '../../components/common/SegmentedControl'
import {
  SearchField,
  SortHeader,
  ColumnChooser,
  ExportMenu,
  RefreshControl,
  ActiveFilters,
  SavedViewsMenu,
  useSavedViews,
} from '../../components/common/TableControls'
import { CreateUserModal } from '../../components/admin/CreateUserModal'
import { Avatar } from '../../components/common/UserMenu'
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
function RoleCells({ roles }) {
  if (!roles || roles.length === 0) return <span className="text-xs text-ink-600">-</span>
  const shown = roles.slice(0, 2)
  const rest = roles.length - shown.length
  return (
    <span className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden" title={roles.join(', ')}>
      {shown.map((r) => (
        <span
          key={r}
          className={clsx(
            'max-w-[7.5rem] flex-none truncate rounded border px-1.5 py-0.5 text-xs font-medium',
            isPrivilegedRoleName(r)
              ? 'border-warn/30 bg-warn-soft text-warn'
              : 'border-surface-700 bg-surface-850 text-ink-400'
          )}
        >
          {r}
        </span>
      ))}
      {rest > 0 && <span className="flex-none text-xs tabular-nums text-ink-500">+{rest}</span>}
    </span>
  )
}

const STATUS_TONE = {
  ACTIVE: 'emerald',
  DISABLED: 'neutral',
  INACTIVE: 'neutral',
  LOCKED: 'amber',
  SUSPENDED: 'red',
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
function RowMenu({ user }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const item =
    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink-200 transition-colors hover:bg-surface-800 hover:text-ink-50'

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Actions for ${user.username}`}
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-surface-800 hover:text-ink-100"
      >
        <MoreHorizontal className="h-4 w-4" strokeWidth={2} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="animate-menu-in absolute right-0 z-40 mt-1 w-52 overflow-hidden rounded-xl border border-surface-700 bg-surface-900 p-1.5 shadow-overlay">
            <Link to={`/admin/identity/${user.user_id}`} className={item} onClick={() => setOpen(false)}>
              <Users className="h-3.5 w-3.5 text-ink-500" strokeWidth={1.75} /> Open account
            </Link>
            <Link
              to={`/admin/identity/${user.user_id}?tab=security`}
              className={item}
              onClick={() => setOpen(false)}
            >
              <KeyRound className="h-3.5 w-3.5 text-ink-500" strokeWidth={1.75} /> Reset password
            </Link>
            <button
              type="button"
              className={item}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(user.user_id)
                  toast.success('User ID copied')
                } catch {
                  toast.error('Clipboard unavailable in this browser')
                }
                setOpen(false)
              }}
            >
              <Copy className="h-3.5 w-3.5 text-ink-500" strokeWidth={1.75} /> Copy user ID
            </button>
          </div>
        </>
      )}
    </div>
  )
}

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
  const pad = table.density === 'compact' ? 'py-1.5' : 'py-2'

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

  return (
    <div className="pb-24">
      <PageHeader
        eyebrow="Admin Center"
        title="Identity"
        description="Every account in this install, and the roles and policies that decide what it can reach."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Create user
          </Button>
        }
      />

      {/* THE KPI STRIP THAT USED TO SIT HERE IS GONE, see CHANGES.md. On an
 inventory screen those five figures restated three things the page
 already says: the status facet counts one row below, the pagination
 total under the table, and the role column itself. What is genuinely
 worth pulling out is the exceptions, so they are one line of
 clickable facts rather than five hero numbers. */}
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-500">
        <span>
          <span className="font-semibold tabular-nums text-ink-100">{counts.total}</span> accounts
        </span>
        <span aria-hidden="true" className="h-3 w-px bg-surface-700" />
        <span>
          <span className="font-semibold tabular-nums text-ink-200">{counts.active}</span> active
        </span>
        {counts.locked > 0 && (
          <button
            type="button"
            onClick={() => table.setFilter('status', 'LOCKED')}
            className="inline-flex items-center gap-1.5 font-medium text-amber-600 transition-colors hover:text-amber-500 dark:text-amber-400"
          >
            <ShieldAlert className="h-3 w-3" strokeWidth={2} />
            <span className="tabular-nums">{counts.locked}</span> locked
          </button>
        )}
        {counts.privileged > 0 && (
          <button
            type="button"
            onClick={() => table.setFilter('role', 'admin')}
            className="inline-flex items-center gap-1.5 font-medium text-red-600 transition-colors hover:text-red-500 dark:text-red-400"
          >
            <ShieldCheck className="h-3 w-3" strokeWidth={2} />
            <span className="tabular-nums">{counts.privileged}</span> privileged
          </button>
        )}
        {counts.neverSignedIn > 0 && (
          <span>
            <span className="tabular-nums text-ink-300">{counts.neverSignedIn}</span> never signed in
          </span>
        )}
      </div>

      <ListPanel
        toolbar={
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <SearchField
                value={searchInput}
                onChange={setSearchInput}
                placeholder="Search username or email…"
                className="min-w-[15rem] sm:max-w-sm"
              />

              {/* Status as a one-click facet with live counts, the single most
 used filter on an account list, so it doesn't hide in a select. */}
              {statusFacets.length > 1 && (
                <SegmentedControl
                  size="sm"
                  ariaLabel="Filter by status"
                  value={table.filters.status}
                  onChange={(v) => table.setFilter('status', v)}
                  options={statusFacets}
                />
              )}

              <label className="flex items-center gap-2">
                <span className="whitespace-nowrap text-xs font-medium text-ink-400">Role</span>
                <select
                  value={table.filters.role}
                  disabled={roleFilterDisabled}
                  title={
                    roleFilterDisabled
                      ? rolesPending
                        ? 'Reading each account’s roles…'
                        : 'This directory is too large to read roles for every account here, open an account to see its roles.'
                      : undefined
                  }
                  onChange={(e) => table.setFilter('role', e.target.value)}
                  className="h-9 cursor-pointer rounded-lg border border-surface-700 bg-surface-900 pl-2.5 pr-7 text-xs font-medium text-ink-100 shadow-sm transition-colors hover:border-surface-600 focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <option value="all">{rolesPending ? 'Loading roles…' : 'Any'}</option>
                  {roleFacets.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label} ({r.count})
                    </option>
                  ))}
                </select>
              </label>

              <span className="ml-auto flex flex-wrap items-center gap-2">
                <SavedViewsMenu
                  views={savedViews.views}
                  activeName={activeView}
                  canSave={table.activeFilterCount > 0 || !!search}
                  onApply={(v) => {
                    setActiveView(v.name)
                    setSearchInput(v.state.search || '')
                    table.setFilters(v.state.filters || { status: 'all', role: 'all' })
                  }}
                  onSave={(name) => {
                    savedViews.saveView(name, { search, filters: table.filters })
                    setActiveView(name)
                    toast.success(`View “${name}” saved`)
                  }}
                  onRemove={(name) => {
                    savedViews.removeView(name)
                    if (activeView === name) setActiveView(null)
                  }}
                />
                <ColumnChooser
                  columns={COLUMNS}
                  visible={table.visibleColumns}
                  onChange={table.setVisibleColumns}
                />
                <ExportMenu
                  count={table.total}
                  disabled={table.total === 0}
                  onExportCsv={() => exportRowsToCsv(table.filteredRows, CSV_COLUMNS, 'identity')}
                  onExportJson={() => exportRowsToJson(table.filteredRows, CSV_COLUMNS, 'identity')}
                />
                <RefreshControl
                  onRefresh={() => usersQuery.refetch()}
                  isFetching={usersQuery.isFetching}
                  updatedAt={usersQuery.dataUpdatedAt}
                />
              </span>
            </div>

            {chips.length > 0 && (
              <div className="border-t border-surface-800 pt-3">
                <ActiveFilters
                  chips={chips}
                  onClearAll={() => {
                    setSearchInput('')
                    table.resetFilters()
                    setActiveView(null)
                  }}
                />
              </div>
            )}
          </div>
        }
      >
        <QueryState
          query={usersQuery}
          empty={(data) => !data?.users || data.users.length === 0}
          emptyTitle={search ? 'No matching accounts' : 'No user accounts yet'}
          emptyMessage={
            search
              ? 'No account matches that username or email. Try a broader term.'
              : 'Create the first account to start assigning roles and policies.'
          }
          emptyAction={
            !search && (
              <Button variant="primary" icon={UserPlus} onClick={() => setCreateOpen(true)}>
                Create user
              </Button>
            )
          }
        >
          {() =>
            table.total === 0 ? (
              <Card>
                <EmptyState
                  icon={SearchX}
                  title="No accounts match these filters"
                  description="Every returned account was filtered out by the current status or role selection."
                  action={
                    <Button variant="secondary" onClick={() => table.resetFilters()}>
                      Clear filters
                    </Button>
                  }
                />
              </Card>
            ) : (
              <>
                <div className="relative overflow-x-auto overscroll-x-contain">
                  <table className="w-full min-w-[62rem] table-fixed border-separate border-spacing-0 text-sm">
                    <colgroup>
                      <col className={COL.select} />
                      {show('username') && <col className="w-[19rem] min-w-[15rem]" />}
                      {show('full_name') && <col className={COL.medium} />}
                      {show('roles') && <col className="w-[13rem]" />}
                      {show('status') && <col className={COL.status} />}
                      {show('created_at') && <col className={COL.timestamp} />}
                      {show('last_login_at') && <col className={COL.short} />}
                      <col className={COL.actions} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th
                          scope="col"
                          className={clsx(
                            stickyHeader({ left: 'left-0', edge: !show('username') }),
                            'px-4 py-2.5'
                          )}
                        >
                          <Checkbox
                            checked={table.allOnPageSelected}
                            indeterminate={table.someOnPageSelected}
                            onChange={table.toggleAllOnPage}
                            srLabel="Select all accounts on this page"
                          />
                        </th>
                        {show('username') && (
                          <SortHeader
                            label="User"
                            columnKey="username"
                            sort={table.sort}
                            onSort={table.toggleSort}
                            className={clsx(stickyHeader({ left: 'left-12', edge: true }), 'z-30')}
                          />
                        )}
                        {show('full_name') && (
                          <SortHeader
                            label="Full name"
                            columnKey="full_name"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                        )}
                        {show('roles') && <SortHeader label="Roles" columnKey="_roles" srOnly={false} />}
                        {show('status') && (
                          <SortHeader
                            label="Status"
                            columnKey="status"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                        )}
                        {show('created_at') && (
                          <SortHeader
                            label="Created"
                            columnKey="created_at"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                        )}
                        {show('last_login_at') && (
                          <SortHeader
                            label="Last sign-in"
                            columnKey="last_login_at"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                        )}
                        <SortHeader label="Actions" columnKey="_actions" srOnly />
                      </tr>
                    </thead>
                    <tbody>
                      {table.pageRows.map((u) => {
                        const selected = table.isSelected(u)
                        return (
                          <tr
                            key={u.user_id}
                            className={clsx(
                              'group',
                              focusedId === u.user_id &&
                                'outline outline-1 -outline-offset-1 outline-blue-500/40'
                            )}
                          >
                            <td
                              className={clsx(
                                stickyCell({ left: 'left-0', selected, edge: !show('username') }),
                                'px-3',
                                pad
                              )}
                            >
                              <Checkbox
                                checked={selected}
                                onChange={() => table.toggleRow(u)}
                                srLabel={`Select ${u.username}`}
                              />
                            </td>
                            {show('username') && (
                              <td
                                className={clsx(
                                  stickyCell({ left: 'left-10', selected, edge: true }),
                                  'px-3',
                                  pad
                                )}
                              >
                                {/* No avatar tile. Six rows of the same blue
 circle with two initials in it is colour
 spent on nothing: it identifies no one that
 the username next to it does not already
 identify, and it sets the row height. */}
                                <Link
                                  to={`/admin/identity/${u.user_id}`}
                                  title={u.username}
                                  className="block truncate text-sm font-medium text-ink-50 transition-colors hover:text-accent hover:underline hover:underline-offset-2"
                                >
                                  {u.username}
                                </Link>
                                {u.email && (
                                  <span
                                    className="mt-0.5 block truncate text-xs text-ink-500"
                                    title={u.email}
                                  >
                                    {u.email}
                                  </span>
                                )}
                              </td>
                            )}
                            {show('full_name') && (
                              <td className={clsx(cell({ selected }), 'px-3', pad)}>
                                <TruncCell value={u.full_name} muted />
                              </td>
                            )}
                            {show('roles') && (
                              <td className={clsx(cell({ selected }), 'px-3', pad)}>
                                <RoleCells roles={rolesOfUser(u)} />
                              </td>
                            )}
                            {show('status') && (
                              <td className={clsx(cell({ selected }), 'px-3', pad)}>
                                <StatusIndicator tone={STATUS_TONE[u.status] || 'neutral'}>
                                  {u.status
                                    ? u.status.charAt(0) + u.status.slice(1).toLowerCase()
                                    : 'Unknown'}
                                </StatusIndicator>
                              </td>
                            )}
                            {show('created_at') && (
                              <td className={clsx(cell({ selected }), 'px-3', pad)}>
                                <TruncCell
                                  value={u.created_at ? formatDateTime(u.created_at) : null}
                                  className="text-xs tabular-nums text-ink-400"
                                />
                              </td>
                            )}
                            {show('last_login_at') && (
                              <td className={clsx(cell({ selected }), 'px-3 text-xs tabular-nums', pad)}>
                                {u.last_login_at ? (
                                  <span className="text-ink-400" title={formatDateTime(u.last_login_at)}>
                                    {formatRelativeToNow(u.last_login_at)}
                                  </span>
                                ) : (
                                  <span className="text-ink-500">Never</span>
                                )}
                              </td>
                            )}
                            <td className={clsx(cell({ selected }), 'px-2', pad)}>
                              <div className="flex items-center justify-end gap-0.5">
                                <RowMenu user={u} />
                                <Link
                                  to={`/admin/identity/${u.user_id}`}
                                  aria-label={`Open ${u.username}`}
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-surface-800 hover:text-ink-50"
                                >
                                  <ChevronRight className="h-4 w-4" strokeWidth={2} />
                                </Link>
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
                  label="accounts"
                />
              </>
            )
          }
        </QueryState>
      </ListPanel>

      <BulkActionBar
        count={table.selectedCount}
        total={table.total}
        noun="account"
        actions={bulkActions}
        allMatchingSelected={table.allMatchingSelected}
        onSelectAllMatching={table.selectAllMatching}
        onClear={table.clearSelection}
      />

      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  )
}
