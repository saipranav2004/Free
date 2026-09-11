import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Lock,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { toast } from 'sonner'
import { listRoles, deleteRole } from '../../api/rbac'
import { normalizeApiError, apiErrorMessage } from '../../lib/apiError'
import { Container, PageTitle, Stack } from '../../components/ui/layout'
import { DataTable, RowActions, SkeletonGrid, SortTh, Td, Th, Tr } from '../../components/ui/grid'
import { MenuItem, MenuNote, RowMenu } from '../../components/ui/menu'
import { FilterChip } from '../../components/ui/bits'
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
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { CreateRoleModal } from '../../components/admin/CreateRoleModal'
import { useTableState } from '../../hooks/useTableState'
import { exportRowsToCsv, exportRowsToJson } from '../../lib/exportRows'
import { formatDateTime, formatRelativeToNow } from '../../lib/format'
import { isSystemRole } from '../../config/constants'
import { getCriticalitySummary } from '../../api/criticality'
import { bandMeta, needsAttention } from '../../lib/criticality'
import { CriticalityCell, ExposureCell } from '../../components/rbac/Criticality'
import { CriticalityBar } from '../../components/rbac/CriticalityBar'

// ---------------------------------------------------------------------------
// Admin Center, Roles
// ---------------------------------------------------------------------------
// Was an accordion: every role a soft row you expanded in place, which meant
// comparing two roles required collapsing one, and the list gave no answer to
// the only question that matters at a glance, what does this role actually
// grant?
//
// Now a table with a policy count and effect mix per row, and a side drawer
// for the detail. The drawer is the same pattern the Resources and Audit
// screens use: inspect without losing your place, act without a page change.
//
// System roles (root/admin/user) are marked and protected. They ship with
// every install and deleting one would lock the console out of itself.

const CSV_COLUMNS = [
  { key: 'name', label: 'Role' },
  { key: 'description', label: 'Description' },
  { key: 'type', label: 'Type', value: (r) => (isSystemRole(r) ? 'System' : 'Custom') },
  { key: 'criticality', label: 'Criticality', value: (r) => r.criticality?.band || 'UNCLASSIFIED' },
  { key: 'criticality_score', label: 'Criticality score', value: (r) => r.criticality?.score ?? '' },
  {
    key: 'criticality_source',
    label: 'Criticality source',
    value: (r) => (r.criticality ? (r.criticality.is_overridden ? 'Reviewer' : 'Computed') : ''),
  },
  { key: 'created_at', label: 'Created' },
  { key: 'id', label: 'Role ID' },
]

// --- detail drawer -----------------------------------------------------------

export default function RolesPage() {
  const queryClient = useQueryClient()
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

  const [deleteTarget, setDeleteTarget] = useState(null)

  const rolesQuery = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: ({ signal }) => listRoles(signal),
  })

  // Criticality for the whole estate in ONE call, not one per row. The
  // endpoint returns every role already classified and sorted, so the column
  // below costs a single request no matter how many roles exist.
  const criticalityQuery = useQuery({
    queryKey: ['admin', 'rbac', 'criticality'],
    queryFn: ({ signal }) => getCriticalitySummary(signal),
  })

  const deleteMutation = useMutation({
    mutationFn: (roleId) => deleteRole(roleId),
    onSuccess: () => {
      toast.success('Role deleted', {
        description: 'Accounts that held it lose the policies it granted.',
      })
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] })
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setDeleteTarget(null)
    },
  })

  // Classification is joined onto the role rows so the column, the band
  // facet, the sort and the export all read one field. Roles the classifier
  // has not returned yet keep `criticality: null`, and the cell says
  // "Not classified" rather than inventing a band.
  const roles = useMemo(() => {
    const rows = rolesQuery.data || []
    const byId = new Map((criticalityQuery.data?.roles || []).map((c) => [c.role_id, c]))
    if (byId.size === 0) return rows.map((r) => ({ ...r, criticality: null, criticality_band: null }))
    return rows.map((r) => {
      const c = byId.get(r.id) || null
      return { ...r, criticality: c, criticality_band: c?.band || null }
    })
  }, [rolesQuery.data, criticalityQuery.data])

  const table = useTableState({
    rows: roles,
    storageKey: 'roles',
    // View state in the address bar, so a filtered list is something you can
    // send to someone. See useTableState.
    urlSync: true,
    rowId: (r) => r.id,
    initialSort: { key: 'name', dir: 'asc' },
    initialPageSize: 25,
    initialFilters: { type: 'all', band: 'all' },
    // Free text is owned BY the hook (table.query), not by a local useState:
    // the hook already clears selection and resets paging when the query
    // changes, and duplicating it here would let the two drift.
    searchFields: ['name', 'description'],
    // Criticality sorts by TIER, never by the band string: alphabetical order
    // would read CRITICAL, HIGH, LOW, MODERATE, putting Low above Moderate
    // and making the column actively misleading. Unclassified rows sort last.
    sortAccessor: (r, key) =>
      key === 'criticality_band'
        ? r.criticality
          ? bandMeta(r.criticality.band).tier
          : 99
        : r[key],
    filterFn: (r, f) => {
      if (f.type === 'system' && !isSystemRole(r)) return false
      if (f.type === 'custom' && isSystemRole(r)) return false
      if (f.band !== 'all' && r.criticality_band !== f.band) return false
      return true
    },
  })

  const systemCount = roles.filter(isSystemRole).length
  // The rows worth acting on: enough privilege to matter, and no evidence
  // anybody is using it.
  const attentionCount = useMemo(
    () => (criticalityQuery.data?.roles || []).filter(needsAttention).length,
    [criticalityQuery.data]
  )

  const chips = []
  if (table.query) {
    chips.push({ key: 'q', label: 'Search', value: table.query, onClear: () => table.setQuery('') })
  }
  if (table.filters.type !== 'all') {
    chips.push({
      key: 'type',
      label: 'Type',
      value: table.filters.type,
      onClear: () => table.setFilter('type', 'all'),
    })
  }
  if (table.filters.band !== 'all') {
    chips.push({
      key: 'band',
      label: 'Criticality',
      value: bandMeta(table.filters.band).label,
      onClear: () => table.setFilter('band', 'all'),
    })
  }

  const err = rolesQuery.isError ? normalizeApiError(rolesQuery.error) : null

  return (
    <Stack gap="lg">
      <PageTitle
        title="Roles"
        counter={rolesQuery.isSuccess ? roles.length : undefined}
        description="A role bundles policies into one assignable unit. Accounts are given roles; roles carry the permissions the policy engine evaluates."
      />

      {/* Estate posture, before the row-by-row view. The bar is the shape of
          the estate and doubles as the band filter; the counts beside it name
          the combination worth acting on, which is a dangerous role nobody is
          exercising. */}
      {criticalityQuery.isError && (
        <Container className="!py-3">
          <div className="flex flex-wrap items-center gap-3">
            <AlertTriangle className="h-4 w-4 flex-none text-warn" strokeWidth={1.9} />
            <p className="min-w-0 flex-1 text-sm leading-relaxed text-secondary">
              <span className="font-semibold text-primary">Criticality is unavailable.</span>{' '}
              {apiErrorMessage(criticalityQuery.error)} The roles below are listed without their
              classification.
            </p>
            <Button
              size="sm"
              variant="secondary"
              icon={RotateCcw}
              loading={criticalityQuery.isFetching}
              onClick={() => criticalityQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        </Container>
      )}

      {criticalityQuery.isSuccess && criticalityQuery.data?.total > 0 && (
        <Container className="!py-4">
          <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-4">
            <div className="min-w-[16rem] flex-1">
              <h2 className="text-sm font-semibold text-primary">Criticality across the estate</h2>
              <CriticalityBar
                className="mt-3"
                byBand={criticalityQuery.data.by_band}
                total={criticalityQuery.data.total}
                active={table.filters.band}
                onSelect={(b) => table.setFilter('band', b)}
              />
            </div>

            <dl className="flex flex-none flex-wrap gap-x-8 gap-y-3">
              {[
                {
                  label: 'Needs attention',
                  value: attentionCount,
                  hint: 'Critical or High, and unused',
                  strong: attentionCount > 0,
                },
                {
                  label: 'Unused',
                  value: criticalityQuery.data.dormant,
                  hint: `No activity in ${90} days`,
                },
                {
                  label: 'Held by nobody',
                  value: criticalityQuery.data.unheld,
                  hint: 'Latent grants',
                },
                {
                  label: 'Reviewer set',
                  value: criticalityQuery.data.overridden,
                  hint: 'Band set by hand',
                },
              ].map((s) => (
                // The hint moved INSIDE the <dd>. A <div> in a <dl> may hold
                // only dt/dd pairs, so a sibling <p> broke the list's
                // structure and a screen reader lost the term/definition
                // pairing for the whole group. It is a description of the
                // value, so the definition is where it belonged anyway.
                <div key={s.label}>
                  <dt className="text-xs text-tertiary">{s.label}</dt>
                  <dd className="mt-0.5">
                    <span
                      className={clsx(
                        'block tabular text-2xl font-bold leading-none',
                        s.strong ? 'text-warn' : 'text-primary'
                      )}
                    >
                      {s.value}
                    </span>
                    <span className="mt-1 block text-2xs text-tertiary">{s.hint}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Container>
      )}

      <Stack gap="sm">
        <CommandBar
          primary={
            <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
              Create role
            </Button>
          }
          summary={
            rolesQuery.isSuccess && table.total !== roles.length
              ? `${table.total} of ${roles.length} shown`
              : undefined
          }
        >
          <ExportMenu
            count={table.total}
            disabled={table.total === 0}
            onExportCsv={() => exportRowsToCsv(table.filteredRows, CSV_COLUMNS, 'roles')}
            onExportJson={() => exportRowsToJson(table.filteredRows, CSV_COLUMNS, 'roles')}
          />
          <RefreshControl
            onRefresh={() => rolesQuery.refetch()}
            isFetching={rolesQuery.isFetching}
            updatedAt={rolesQuery.dataUpdatedAt}
          />
          <PreferencesMenu pageSize={table.pageSize} onPageSize={table.setPageSize} />
        </CommandBar>

        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            value={table.query}
            onChange={table.setQuery}
            placeholder="Search roles"
            label="Search roles"
          />
          {[
            { key: 'all', label: 'All', count: roles.length },
            { key: 'system', label: 'Built in', count: systemCount },
            { key: 'custom', label: 'Custom', count: roles.length - systemCount },
          ].map((f) => (
            <FilterChip
              key={f.key}
              active={table.filters.type === f.key}
              count={f.count}
              onClick={() => table.setFilter('type', f.key)}
            >
              {f.label}
            </FilterChip>
          ))}

        </div>

        <ActiveFilters chips={chips} onClearAll={table.resetFilters} />
      </Stack>

      <Container padded={false}>
        {rolesQuery.isLoading ? (
          <table className="w-full">
            <tbody>
              <SkeletonGrid colSpan={5} rows={6} />
            </tbody>
          </table>
        ) : err ? (
          err.status === 403 ? (
            <DeniedState description={err.message} />
          ) : err.code === 'network_error' ? (
            <OfflineState onRetry={() => rolesQuery.refetch()} retrying={rolesQuery.isFetching} />
          ) : (
            <ErrorState
              description={err.message}
              onRetry={() => rolesQuery.refetch()}
              retrying={rolesQuery.isFetching}
            />
          )
        ) : roles.length === 0 ? (
          <EmptyState
            icon={Lock}
            title="No roles defined"
            description="Create a role to bundle policies and assign them to accounts."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
                Create the first role
              </Button>
            }
          />
        ) : table.total === 0 ? (
          <NoMatchState
            description="Nothing matches the current search or type filter."
            onClear={table.resetFilters}
          />
        ) : (
          <>
            <DataTable minWidth="58rem" label="Roles">
              <colgroup>
                <col className="w-auto min-w-[16rem]" />
                <col className="w-[10rem]" />
                <col className="w-[11rem]" />
                <col className="w-[7rem]" />
                <col className="w-[8rem]" />
                <col className="w-[9rem]" />
                <col className="w-[4rem]" />
              </colgroup>
              <thead>
                <tr>
                  <SortTh columnKey="name" sort={table.sort} onSort={table.toggleSort} sticky edge>
                    Role
                  </SortTh>
                  <SortTh columnKey="criticality_band" sort={table.sort} onSort={table.toggleSort}>
                    Criticality
                  </SortTh>
                  <Th>Exposure</Th>
                  <SortTh columnKey="is_system" sort={table.sort} onSort={table.toggleSort}>
                    Type
                  </SortTh>
                  <SortTh columnKey="user_count" sort={table.sort} onSort={table.toggleSort} align="right">
                    Accounts
                  </SortTh>
                  <SortTh columnKey="created_at" sort={table.sort} onSort={table.toggleSort}>
                    Created
                  </SortTh>
                  <Th align="right">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {table.pageRows.map((role) => {
                  const system = isSystemRole(role)
                  return (
                    <Tr key={role.id}>
                      <Td sticky edge>
                        <div className="min-w-0">
                          <Link
                            to={`/admin/roles/${role.id}`}
                            title={role.name}
                            className="block max-w-full truncate text-left text-sm font-medium text-primary transition-colors hover:text-accent hover:underline"
                          >
                            {role.name}
                          </Link>
                          {role.description && (
                            <span
                              className="mt-0.5 block truncate text-xs text-tertiary"
                              title={role.description}
                            >
                              {role.description}
                            </span>
                          )}
                        </div>
                      </Td>
                      <Td>
                        {criticalityQuery.isLoading ? (
                          <span className="skeleton block h-4 w-16 rounded" />
                        ) : criticalityQuery.isError ? (
                          <span className="text-sm text-tertiary">Unavailable</span>
                        ) : (
                          <CriticalityCell classification={role.criticality} />
                        )}
                      </Td>
                      <Td>
                        {criticalityQuery.isLoading ? (
                          <span className="skeleton block h-4 w-14 rounded" />
                        ) : criticalityQuery.isError ? (
                          <span className="text-sm text-tertiary">-</span>
                        ) : (
                          <ExposureCell classification={role.criticality} />
                        )}
                      </Td>
                      <Td>
                        {/* Built in versus custom is the one thing here that
                            changes what you may do to a row, so it is a word
                            rather than a coloured chip: a chip on every row is
                            a column of colour that says nothing. */}
                        <span className="text-sm text-secondary">{system ? 'Built in' : 'Custom'}</span>
                      </Td>
                      <Td align="right">
                        <span className="text-sm tabular text-primary">{role.user_count ?? '-'}</span>
                      </Td>
                      <Td>
                        <span className="text-sm text-secondary" title={formatDateTime(role.created_at)}>
                          {formatRelativeToNow(role.created_at)}
                        </span>
                      </Td>
                      <Td align="right">
                        <RowActions>
                          <RowMenu label={`Actions for ${role.name}`}>
                            <MenuItem icon={Lock}>
                              <Link to={`/admin/roles/${role.id}`} className="block">
                                Open role
                              </Link>
                            </MenuItem>
                            {!system && (
                              <MenuItem icon={Trash2} danger onClick={() => setDeleteTarget(role)}>
                                Delete role
                              </MenuItem>
                            )}
                            {system && <MenuNote>Built in roles cannot be deleted.</MenuNote>}
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
              label="roles"
            />
          </>
        )}
      </Container>


      <CreateRoleModal open={createOpen} onClose={() => setCreateOpen(false)} />

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete role “${deleteTarget?.name}”?`}
        description="Every account holding this role immediately loses the policies it granted. Accounts themselves are not affected."
        confirmLabel="Delete role"
        destructive
        requireReason
        reasonLabel="Reason for deletion"
        isLoading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </Stack>
  )
}
