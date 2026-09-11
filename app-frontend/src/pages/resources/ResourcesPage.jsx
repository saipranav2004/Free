import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Server, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { listResourceGroups } from '../../api/resources'
import { deleteResource } from '../../api/adminResources'
import { apiErrorMessage } from '../../lib/apiError'
import { useAuthStore } from '../../store/authStore'
import { useTableState } from '../../hooks/useTableState'
import { RESOURCE_TYPES } from '../../config/constants'
import { PageTitle, Container, Stack } from '../../components/ui/layout'
import {
  ActiveFilters,
  CommandBar,
  ExportMenu,
  Pagination,
  PreferencesMenu,
  RefreshControl,
  SearchField,
} from '../../components/ui/chrome'
import { FilterChip } from '../../components/ui/bits'
import { DeniedState, EmptyState, ErrorState, NoMatchState, OfflineState } from '../../components/ui/states'
import { SkeletonGrid } from '../../components/ui/grid'
import { Button } from '../../components/common/Button'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { CreateResourceModal } from '../../components/resources/CreateResourceModal'
import { CreateJitRequestModal } from '../../components/jit/CreateJitRequestModal'
import { ResourceTable, resourceColumnsFor } from '../../components/resources/ResourceTable'
import { ConnectCliDialog } from '../../components/resources/ConnectCliDialog'
import { listMyGrants, listMyJitRequests } from '../../api/jit'
import { JIT_STATUS } from '../../config/constants'
import { resourceTypeLabel } from '../../components/resources/ResourceCard'
import { exportRowsToCsv, exportRowsToJson } from '../../lib/exportRows'
import { normalizeApiError } from '../../lib/apiError'

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------
// The catalogue. Rebuilt on the grid and the list chrome rather than on the
// old filter card plus table card pair.
//
// PAGE ANATOMY, in the order AWS uses it: breadcrumb (drawn by the shell),
// title with a live count, command bar, filter row, then ONE container that
// holds the grid and its pager. Nothing floats.
//
// FACETS INSTEAD OF FIVE DROPDOWNS. The previous build carried Type, Group,
// Status, Access and Credential as select elements on their own row, which is
// five controls, five labels and roughly 700px of chrome to answer questions
// that are almost always yes or no. Three of them are now one-click chips
// carrying a live count, which is what an operator actually reaches for. Type
// stays a select because it has ten values, and Group stays because it is
// deployment specific.
//
// EVERY CONTROL HERE RESOLVES TO A REAL CALL:
//   the grid          GET  /pam/resources/groups
//   Connect           GET  /pam/resources/:id/connect-info  (via the drawer)
//   Request access    POST /pam/jit/requests                (via the modal)
//   Register resource POST /pam/admin/resources
//   Store credential  POST /pam/admin/resources/:id/credential
//   Delete            DELETE /pam/admin/resources/:id
//   Export            client side, over the rows already loaded

const INITIAL_FILTERS = { type: 'all', group: 'all', jit: false, recorded: false, noCredential: false }

const CSV_COLUMNS = [
  { key: 'name', label: 'Resource' },
  { key: 'resource_type', label: 'Type' },
  { key: 'host', label: 'Host' },
  { key: 'port', label: 'Port' },
  { key: 'database_name', label: 'Database' },
  { key: 'group', label: 'Group' },
  { key: 'requires_jit', label: 'Requires JIT' },
  { key: 'always_record', label: 'Always recorded' },
  { key: 'is_active', label: 'Active' },
]

// An export is a copy of the table, so it carries the same columns the viewer
// is allowed to see. Exporting a field that was deliberately withheld from the
// screen would make the download the way around the rule.
function csvColumnsFor(isAdmin) {
  if (isAdmin) return CSV_COLUMNS
  return CSV_COLUMNS.filter((c) => c.key !== 'port')
}

// ---------------------------------------------------------------------------
// Where each resource stands for THIS user
// ---------------------------------------------------------------------------
// The row action has four possible truths and only one of them is "Request
// access". Deciding between them needs the caller's own requests and grants,
// which are two calls for the whole page rather than one per row.
//
// Statuses come from the backend's models.JITStatus*: PENDING, PARTIALLY_
// APPROVED, APPROVED, DENIED, EXPIRED, CANCELLED, WAITING (break-glass).
// Anything already decided leaves no trace here, which is correct: a denied
// request from last week must not stop somebody asking again today.
const OPEN_STATUSES = new Set([JIT_STATUS.PENDING, JIT_STATUS.WAITING])

function buildAccessIndex({ requests, grants }) {
  const byResource = new Map()

  for (const g of grants || []) {
    if (!g?.resource_id) continue
    byResource.set(g.resource_id, {
      state: 'granted',
      canConnect: true,
      title: g.expires_at ? `Access is active until ${new Date(g.expires_at).toLocaleString()}` : 'Access is active',
    })
  }

  for (const r of requests || []) {
    if (!r?.resource_id) continue
    // A live grant outranks a request record: the grant is the thing that
    // decides whether Connect works.
    if (byResource.get(r.resource_id)?.canConnect) continue
    if (OPEN_STATUSES.has(r.status)) {
      byResource.set(r.resource_id, {
        state: 'pending',
        canConnect: false,
        requestId: r.id,
        title: 'Submitted and waiting on an approver',
      })
    } else if (r.status === JIT_STATUS.PARTIALLY_APPROVED) {
      byResource.set(r.resource_id, {
        state: 'partial',
        canConnect: false,
        requestId: r.id,
        title: 'One approval recorded, waiting on a second, different approver',
      })
    }
  }

  return byResource
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="flex min-w-0 flex-none items-center gap-2">
      <span className="whitespace-nowrap text-sm text-secondary">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 min-w-0 cursor-pointer rounded-lg border border-line-strong bg-surface pl-2.5 pr-7 text-sm text-primary transition-colors hover:border-primary/40 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export default function ResourcesPage() {
  const isAdmin = useAuthStore((s) => s.isAdmin())
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [createOpen, setCreateOpen] = useState(false)
  const [jitTarget, setJitTarget] = useState(null)
  const [cliTarget, setCliTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)

  const groupsQuery = useQuery({
    queryKey: ['resources', 'groups'],
    queryFn: ({ signal }) => listResourceGroups(signal),
  })

  // Only a standard user has a JIT ladder to be on. Root and admin are not
  // gated by grants at all, so fetching their requests here would be two calls
  // whose answer can never change what the row shows.
  const myRequestsQuery = useQuery({
    queryKey: ['jit', 'requests', 'mine', { forResources: true }],
    queryFn: ({ signal }) => listMyJitRequests({ pageSize: 100, signal }),
    enabled: !isAdmin,
    retry: false,
  })
  const myGrantsQuery = useQuery({
    queryKey: ['jit', 'grants', 'mine', { forResources: true }],
    queryFn: ({ signal }) => listMyGrants({ activeOnly: true, pageSize: 100, signal }),
    enabled: !isAdmin,
    retry: false,
  })

  const accessIndex = useMemo(
    () =>
      buildAccessIndex({
        requests: myRequestsQuery.data?.requests,
        grants: myGrantsQuery.data?.grants,
      }),
    [myRequestsQuery.data, myGrantsQuery.data]
  )
  const accessFor = useCallback(
    (r) => (isAdmin ? { state: 'granted', canConnect: true } : accessIndex.get(r.id)),
    [isAdmin, accessIndex]
  )

  // The endpoint nests resources under their platform group. Every view here
  // wants one flat list with the group carried along as a filterable field.
  const resources = useMemo(
    () => (groupsQuery.data || []).flatMap((g) => (g.resources || []).map((r) => ({ ...r, group: g.name }))),
    [groupsQuery.data]
  )
  const groupNames = useMemo(
    () => [...new Set((groupsQuery.data || []).map((g) => g.name))].sort(),
    [groupsQuery.data]
  )

  const table = useTableState({
    rows: resources,
    storageKey: 'resources',
    // View state in the address bar, so a filtered list is something you can
    // send to someone. See useTableState.
    urlSync: true,
    initialSort: { key: 'name', dir: 'asc' },
    initialPageSize: 25,
    initialFilters: INITIAL_FILTERS,
    // Port is off by default: it is folded into the host cell, and a separate
    // column for it cost the resource name 80px it needed more. For a standard
    // user it is not in the set at all, along with Credential.
    initialColumns: resourceColumnsFor(isAdmin)
      .filter((c) => !c.defaultHidden)
      .map((c) => c.key),
    // Database and group are not columns any more, but they are still matched
    // by search: dropping a column must never make a system unfindable by the
    // one fact somebody happens to remember about it.
    searchFields: ['name', 'host', 'description', 'database_name', 'group', 'resource_type'],
    filterFn: (r, f) => {
      if (f.type !== 'all' && r.resource_type !== f.type) return false
      if (f.group !== 'all' && r.group !== f.group) return false
      if (f.jit && !r.requires_jit) return false
      if (f.recorded && !r.always_record && !r.recording_required) return false
      if (f.noCredential && r.vault_entry_id) return false
      return true
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteResource(id),
    onSuccess: (_data, id) => {
      const name = deleteTarget?.name || 'The resource'
      setDeleteTarget(null)
      queryClient.invalidateQueries({ queryKey: ['resources'] })
      toast.success(`${name} was removed from the catalogue`)
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  // Connect opens the panel that actually calls
  // GET /pam/resources/:id/connect-info and can start a tracked session. It
  // used to open the summary drawer, which meant a button labelled Connect
  // did not connect: it showed a read only summary and made no request at
  // all. That is the exact failure mode this pass exists to remove.
  // ONE OVERLAY, NOT TWO.
  //
  // Connect used to open a second Drawer holding ConnectPanel, on top of a
  // page that already opens a peek Drawer when a row is clicked. So the list
  // had two different overlays describing the same resource, and reaching the
  // second one from the first meant a panel over a panel.
  //
  // The resource page is where the connect flow already lives, and it is the
  // only place that can host all of its states: an active session, a JIT gate
  // with no grant, and the pairing panel a 409 demands, which is precisely the
  // case the drawer could not host and bounced to this page for anyway.
  // Sending Connect straight there removes an overlay and a duplicate
  // implementation, and every route to connecting now ends up on the same
  // screen instead of two that behave slightly differently.
  // Clicking a resource opens its DETAIL PAGE, not a peek drawer.
  //
  // The drawer showed a read-only summary of a subset of the resource and had
  // no route of its own, so it could not be linked, bookmarked, refreshed or
  // opened in a new tab, and anything it did not carry (credential, sessions,
  // policies, audit, the data-protection settings) meant closing it and
  // navigating anyway. Every action on the row already went to the page.
  // A whole page is also the only surface with room for the Edit dialog's Data
  // protection section, which is where an administrator turns these controls on
  // per resource.
  //
  // FOR A STANDARD USER THESE NEVER FIRE. /resources/:id redirects them
  // straight back here, so sending them there is a click that visibly does
  // nothing: the reported "the resource page does not open". Their Connect is
  // a dropdown on the row itself, built from connect-info; see ResourceTable.
  const onOpen = useCallback((r) => navigate(`/resources/${r.id}`), [navigate])
  const onConnect = onOpen
  const onRequestAccess = useCallback((r) => setJitTarget(r), [])
  const onStoreCredential = useCallback((r) => navigate(`/resources/${r.id}?tab=credential`), [navigate])

  const counts = useMemo(
    () => ({
      jit: resources.filter((r) => r.requires_jit).length,
      recorded: resources.filter((r) => r.always_record || r.recording_required).length,
      noCredential: resources.filter((r) => !r.vault_entry_id).length,
    }),
    [resources]
  )

  const chips = useMemo(() => {
    const out = []
    if (table.query.trim())
      out.push({ key: 'q', label: 'Search', value: table.query.trim(), onClear: () => table.setQuery('') })
    if (table.filters.type !== 'all')
      out.push({
        key: 'type',
        label: 'Type',
        value: resourceTypeLabel(table.filters.type),
        onClear: () => table.setFilter('type', 'all'),
      })
    if (table.filters.group !== 'all')
      out.push({
        key: 'group',
        label: 'Group',
        value: table.filters.group,
        onClear: () => table.setFilter('group', 'all'),
      })
    if (table.filters.jit)
      out.push({ key: 'jit', label: 'JIT required', onClear: () => table.setFilter('jit', false) })
    if (table.filters.recorded)
      out.push({ key: 'rec', label: 'Always recorded', onClear: () => table.setFilter('recorded', false) })
    if (table.filters.noCredential)
      out.push({ key: 'cred', label: 'No credential', onClear: () => table.setFilter('noCredential', false) })
    return out
  }, [table])

  const clearAll = () => {
    table.setQuery('')
    table.setFilters(INITIAL_FILTERS)
  }

  const err = groupsQuery.isError ? normalizeApiError(groupsQuery.error) : null
  const colSpan = resourceColumnsFor(isAdmin).length + 1

  return (
    <Stack gap="lg">
      <PageTitle
        title="Resources"
        counter={groupsQuery.isSuccess ? resources.length : undefined}
        description="Every system this install can broker access to."
      />

      <Stack gap="sm">
        <CommandBar
          primary={
            isAdmin && (
              <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
                Register resource
              </Button>
            )
          }
          summary={
            groupsQuery.isSuccess && table.total !== resources.length
              ? `${table.total} of ${resources.length} shown`
              : undefined
          }
        >
          <ExportMenu
            count={table.filteredRows.length}
            disabled={table.filteredRows.length === 0}
            onExportCsv={() => exportRowsToCsv(table.filteredRows, csvColumnsFor(isAdmin), 'resources')}
            onExportJson={() => exportRowsToJson(table.filteredRows, csvColumnsFor(isAdmin), 'resources')}
          />
          <RefreshControl
            onRefresh={() => groupsQuery.refetch()}
            isFetching={groupsQuery.isFetching}
            updatedAt={groupsQuery.dataUpdatedAt}
          />
          <PreferencesMenu
            columns={resourceColumnsFor(isAdmin)}
            visible={table.visibleColumns}
            onVisibleChange={table.setVisibleColumns}
            pageSize={table.pageSize}
            onPageSize={table.setPageSize}
          />
        </CommandBar>

        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            value={table.query}
            onChange={table.setQuery}
            placeholder="Search name, host, database or group"
            label="Search resources"
          />
          <Select
            label="Type"
            value={table.filters.type}
            onChange={(v) => table.setFilter('type', v)}
            options={[{ value: 'all', label: 'All types' }, ...RESOURCE_TYPES]}
          />
          {groupNames.length > 1 && (
            <Select
              label="Group"
              value={table.filters.group}
              onChange={(v) => table.setFilter('group', v)}
              options={[
                { value: 'all', label: 'All groups' },
                ...groupNames.map((g) => ({ value: g, label: g })),
              ]}
            />
          )}
          <FilterChip
            active={table.filters.jit}
            count={counts.jit}
            onClick={() => table.setFilter('jit', !table.filters.jit)}
          >
            JIT required
          </FilterChip>
          <FilterChip
            active={table.filters.recorded}
            count={counts.recorded}
            onClick={() => table.setFilter('recorded', !table.filters.recorded)}
          >
            Always recorded
          </FilterChip>
          {isAdmin && (
            <FilterChip
              active={table.filters.noCredential}
              count={counts.noCredential}
              onClick={() => table.setFilter('noCredential', !table.filters.noCredential)}
            >
              No credential
            </FilterChip>
          )}
        </div>

        <ActiveFilters chips={chips} onClearAll={clearAll} />
      </Stack>

      <Container padded={false}>
        {groupsQuery.isLoading ? (
          <table className="w-full">
            <tbody>
              <SkeletonGrid colSpan={colSpan} rows={10} />
            </tbody>
          </table>
        ) : err ? (
          err.status === 403 ? (
            <DeniedState description={err.message} />
          ) : err.code === 'network_error' ? (
            <OfflineState onRetry={() => groupsQuery.refetch()} retrying={groupsQuery.isFetching} />
          ) : (
            <ErrorState
              description={err.message}
              onRetry={() => groupsQuery.refetch()}
              retrying={groupsQuery.isFetching}
            />
          )
        ) : resources.length === 0 ? (
          <EmptyState
            icon={Server}
            title="No resources are registered"
            description="Once a system is registered it appears here with its connection details and access requirements."
            action={
              isAdmin ? (
                <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
                  Register the first resource
                </Button>
              ) : null
            }
          />
        ) : table.total === 0 ? (
          <NoMatchState
            title="No resources match"
            description="Nothing in the catalogue matches the current search and filters."
            onClear={clearAll}
          />
        ) : (
          <>
            <ResourceTable
              rows={table.pageRows}
              sort={table.sort}
              onSort={table.toggleSort}
              visibleColumns={table.visibleColumns}
              onPeek={onOpen}
              onConnect={onConnect}
              onRequestAccess={onRequestAccess}
              onStoreCredential={onStoreCredential}
              onOpenCli={setCliTarget}
              onDelete={setDeleteTarget}
              isAdmin={isAdmin}
              accessFor={accessFor}
            />
            <Pagination
              page={table.page}
              pageSize={table.pageSize}
              total={table.total}
              totalPages={table.totalPages}
              onPageChange={table.setPage}
              label="resources"
            />
          </>
        )}
      </Container>

      {/* Admins are refused this path by the server (jit_not_applicable), so
          the modal is not theirs to open. They reach every resource their
          policies allow without a grant. */}
      {!isAdmin && jitTarget && (
        <CreateJitRequestModal
          open={!!jitTarget}
          onClose={() => setJitTarget(null)}
          defaultResourceId={jitTarget.id}
        />
      )}

      {cliTarget && <ConnectCliDialog target={cliTarget} onClose={() => setCliTarget(null)} />}

      {isAdmin && <CreateResourceModal open={createOpen} onClose={() => setCreateOpen(false)} />}

      {isAdmin && (
        <ConfirmDialog
          open={!!deleteTarget}
          title={`Delete ${deleteTarget?.name || 'this resource'}?`}
          description="The resource is removed from the catalogue. Existing grants and audit history are kept, but nobody can request or connect to it again."
          confirmLabel="Delete resource"
          destructive
          isLoading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </Stack>
  )
}
