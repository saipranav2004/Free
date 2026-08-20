import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, FileKey2, Link2, Lock, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { toast } from 'sonner'
import {
  listRoles,
  getRole,
  attachPolicyToRole,
  detachPolicyFromRole,
  deleteRole,
  listPolicies,
} from '../../api/rbac'
import { normalizeApiError, apiErrorMessage } from '../../lib/apiError'
import { Container, PageTitle, Stack } from '../../components/ui/layout'
import { DataTable, RowActions, SkeletonGrid, SortTh, Td, Th, Tr, Trunc } from '../../components/ui/grid'
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
import { Drawer } from '../../components/common/Drawer'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { CreateRoleModal } from '../../components/admin/CreateRoleModal'
import { useTableState } from '../../hooks/useTableState'
import { exportRowsToCsv, exportRowsToJson } from '../../lib/exportRows'
import { formatDateTime, formatRelativeToNow } from '../../lib/format'
import { Badge } from '../../components/common/Badge'
import { selectClass } from '../../components/common/FormFields'
import { isSystemRole, ROLE_BADGE, POLICY_EFFECT_BADGE } from '../../config/constants'

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
  { key: 'created_at', label: 'Created' },
  { key: 'id', label: 'Role ID' },
]

// --- detail drawer -----------------------------------------------------------

function RoleDrawer({ role, onClose, onDelete }) {
  const queryClient = useQueryClient()
  const [newPolicyId, setNewPolicyId] = useState('')

  const roleQuery = useQuery({
    queryKey: ['admin', 'roles', role?.id],
    queryFn: ({ signal }) => getRole(role.id, signal),
    enabled: !!role,
  })

  const policiesQuery = useQuery({
    queryKey: ['admin', 'policies'],
    queryFn: ({ signal }) => listPolicies(signal),
    enabled: !!role,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'roles', role.id] })
    queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] })
  }

  const attach = useMutation({
    mutationFn: (policyId) => attachPolicyToRole(role.id, policyId),
    onSuccess: () => {
      toast.success('Policy attached')
      invalidate()
      setNewPolicyId('')
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const detach = useMutation({
    mutationFn: (policyId) => detachPolicyFromRole(role.id, policyId),
    onSuccess: () => {
      toast.success('Policy detached')
      invalidate()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  if (!role) return null

  const attached = roleQuery.data?.policies || []
  const attachedIds = new Set(attached.map((p) => p.id))
  const available = (policiesQuery.data || []).filter((p) => !attachedIds.has(p.id))
  const system = isSystemRole(role)
  const hasDeny = attached.some((p) => p.effect === 'deny')

  return (
    <Drawer
      open={!!role}
      onClose={onClose}
      width="lg"
      icon={<Lock className="h-4 w-4 text-ink-400" strokeWidth={1.75} />}
      title={role.name}
      subtitle={role.id}
      footer={
        <>
          <Button
            size="sm"
            variant="dangerGhost"
            icon={Trash2}
            disabled={system}
            title={system ? 'Built-in system roles cannot be deleted' : undefined}
            onClick={() => onDelete(role)}
          >
            Delete role
          </Button>
          <span className="ml-auto text-2xs text-ink-500">
            {attached.length} polic{attached.length === 1 ? 'y' : 'ies'} attached
          </span>
        </>
      }
    >
      <div className="border-b border-surface-800 px-4 py-3.5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge className={ROLE_BADGE[role.name] || 'bg-surface-800 text-ink-300 ring-surface-700'}>
            {role.name}
          </Badge>
          {system ? (
            <span className="rounded border border-surface-700 bg-surface-850 px-1.5 py-0.5 text-xs font-semibold text-ink-400">
              System role
            </span>
          ) : (
            <span className="rounded border border-surface-700 bg-surface-850 px-1.5 py-0.5 text-xs font-semibold text-ink-500">
              Custom
            </span>
          )}
        </div>
        <p className="text-sm leading-relaxed text-ink-400">
          {role.description || 'No description recorded for this role.'}
        </p>
      </div>

      {system && (
        <div className="flex items-start gap-2.5 border-b border-surface-800 bg-surface-850/60 px-4 py-3">
          <ShieldCheck className="mt-px h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
          <p className="text-xs leading-relaxed text-ink-400">
            Built-in role, it ships with every install and the console&apos;s own route guards depend on it.
            Its policies can be changed; the role itself cannot be deleted.
          </p>
        </div>
      )}

      <section>
        <h3 className="flex items-center gap-2 border-b border-surface-800 bg-surface-850/60 px-4 py-2 text-xs font-semibold text-ink-500">
          <FileKey2 className="h-3.5 w-3.5" strokeWidth={1.75} /> Attached policies
        </h3>

        {roleQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-850" />
            ))}
          </div>
        ) : attached.length === 0 ? (
          <EmptyState
            icon={FileKey2}
            title="No policies attached"
            description="This role grants nothing on its own. Attach a policy below to give it meaning."
            className="py-10"
          />
        ) : (
          <ul className="divide-y divide-surface-800">
            {attached.map((p) => (
              <li key={p.id} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink-100">{p.name}</span>
                    <Badge className={POLICY_EFFECT_BADGE[p.effect]}>{p.effect || 'unknown'}</Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-500">
                    {p.description ||
                      `${(p.actions || []).length} action${(p.actions || []).length === 1 ? '' : 's'} · ${(p.resources || []).length} resource pattern${(p.resources || []).length === 1 ? '' : 's'}`}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  icon={X}
                  loading={detach.isPending && detach.variables === p.id}
                  onClick={() => detach.mutate(p.id)}
                >
                  Detach
                </Button>
              </li>
            ))}
          </ul>
        )}

        {hasDeny && (
          <div className="flex items-start gap-2.5 border-t border-surface-800 bg-amber-50 px-4 py-3 dark:bg-amber-950/25">
            <AlertTriangle
              className="mt-px h-3.5 w-3.5 flex-none text-amber-600 dark:text-amber-400"
              strokeWidth={1.75}
            />
            <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
              This role carries a <span className="font-semibold">deny</span> policy. Deny wins over every
              allow the account holds, from any role.
            </p>
          </div>
        )}

        {available.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-surface-800 px-4 py-3">
            <select
              className={clsx(selectClass(false), 'h-9 w-auto min-w-[13rem] py-0 text-sm')}
              value={newPolicyId}
              onChange={(e) => setNewPolicyId(e.target.value)}
              aria-label="Policy to attach"
            >
              <option value="">Attach a policy…</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.effect})
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="primary"
              icon={Link2}
              disabled={!newPolicyId}
              loading={attach.isPending}
              onClick={() => newPolicyId && attach.mutate(newPolicyId)}
            >
              Attach
            </Button>
          </div>
        )}
      </section>

      <dl className="divide-y divide-surface-800 border-t border-surface-800">
        <div className="grid grid-cols-[minmax(6.5rem,34%)_1fr] gap-3 px-4 py-2.5">
          <dt className="text-2xs font-medium uppercase tracking-[0.07em] text-ink-500">Created</dt>
          <dd className="text-sm text-ink-100">{role.created_at ? formatDateTime(role.created_at) : '-'}</dd>
        </div>
        <div className="grid grid-cols-[minmax(6.5rem,34%)_1fr] gap-3 px-4 py-2.5">
          <dt className="text-2xs font-medium uppercase tracking-[0.07em] text-ink-500">Role ID</dt>
          <dd className="break-all font-mono text-xs text-ink-300">{role.id}</dd>
        </div>
      </dl>
    </Drawer>
  )
}

// --- page --------------------------------------------------------------------

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

  const [peeked, setPeeked] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)

  const rolesQuery = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: ({ signal }) => listRoles(signal),
  })

  // Same query key the drawer uses, so react-query serves both from one cache
  // entry, this is a read of already-fetched data, not a second request.
  const policiesQuery = useQuery({
    queryKey: ['admin', 'policies'],
    queryFn: ({ signal }) => listPolicies(signal),
  })

  const deleteMutation = useMutation({
    mutationFn: (roleId) => deleteRole(roleId),
    onSuccess: () => {
      toast.success('Role deleted', {
        description: 'Accounts that held it lose the policies it granted.',
      })
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] })
      setDeleteTarget(null)
      setPeeked(null)
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setDeleteTarget(null)
    },
  })

  const roles = useMemo(() => rolesQuery.data || [], [rolesQuery.data])

  const table = useTableState({
    rows: roles,
    storageKey: 'roles',
    rowId: (r) => r.id,
    initialSort: { key: 'name', dir: 'asc' },
    initialPageSize: 25,
    initialFilters: { type: 'all' },
    // Free text is owned BY the hook (table.query), not by a local useState:
    // the hook already clears selection and resets paging when the query
    // changes, and duplicating it here would let the two drift.
    searchFields: ['name', 'description'],
    filterFn: (r, f) => {
      if (f.type === 'system' && !isSystemRole(r)) return false
      if (f.type === 'custom' && isSystemRole(r)) return false
      return true
    },
  })

  const systemCount = roles.filter(isSystemRole).length

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

  const err = rolesQuery.isError ? normalizeApiError(rolesQuery.error) : null

  return (
    <Stack gap="lg">
      <PageTitle
        title="Roles"
        counter={rolesQuery.isSuccess ? roles.length : undefined}
        description="A role bundles policies into one assignable unit. Accounts are given roles; roles carry the permissions the policy engine evaluates."
      />

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
            <DataTable minWidth="48rem">
              <colgroup>
                <col className="w-[15rem] min-w-[12rem]" />
                <col className="w-auto" />
                <col className="w-[8rem]" />
                <col className="w-[9rem]" />
                <col className="w-[9rem]" />
                <col className="w-[4rem]" />
              </colgroup>
              <thead>
                <tr>
                  <SortTh columnKey="name" sort={table.sort} onSort={table.toggleSort} sticky edge>
                    Role
                  </SortTh>
                  <Th>Description</Th>
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
                        <button
                          type="button"
                          onClick={() => setPeeked(role)}
                          title={role.name}
                          className="block max-w-full truncate text-left text-sm font-medium text-primary transition-colors hover:text-accent hover:underline"
                        >
                          {role.name}
                        </button>
                      </Td>
                      <Td>
                        <Trunc value={role.description} muted />
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
                            <MenuItem icon={Lock} onClick={() => setPeeked(role)}>
                              Open role
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

      <RoleDrawer role={peeked} onClose={() => setPeeked(null)} onDelete={setDeleteTarget} />

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
