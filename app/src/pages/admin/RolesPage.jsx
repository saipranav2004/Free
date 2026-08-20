import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Plus,
  Lock,
  Link2,
  Trash2,
  ShieldCheck,
  X,
  SearchX,
  FileKey2,
  AlertTriangle,
  ChevronRight,
  Layers,
} from 'lucide-react'
import clsx from 'clsx'
import {
  listRoles,
  getRole,
  attachPolicyToRole,
  detachPolicyFromRole,
  deleteRole,
  listPolicies,
} from '../../api/rbac'
import { PageHeader, Card, CardFooter, EmptyState, ListPanel } from '../../components/common/Layout'
import { QueryState } from '../../components/common/QueryState'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { Drawer } from '../../components/common/Drawer'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { SegmentedControl } from '../../components/common/SegmentedControl'
import {
  SearchField,
  SortHeader,
  RefreshControl,
  ExportMenu,
  ActiveFilters,
} from '../../components/common/TableControls'
import { selectClass } from '../../components/common/FormFields'
import { CreateRoleModal } from '../../components/admin/CreateRoleModal'
import { useTableState } from '../../hooks/useTableState'
import { exportRowsToCsv, exportRowsToJson } from '../../lib/exportRows'
import { apiErrorMessage } from '../../lib/apiError'
import { formatDateTime } from '../../lib/format'
import { POLICY_EFFECT_BADGE, ROLE_BADGE, SYSTEM_ROLES } from '../../config/constants'

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

function isSystemRole(role) {
  return role?.is_system === true || SYSTEM_ROLES.includes(String(role?.name || '').toLowerCase())
}

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
            <span className="rounded border border-surface-700 bg-surface-850 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-ink-400">
              System role
            </span>
          ) : (
            <span className="rounded border border-surface-700 bg-surface-850 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-ink-500">
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
        <h3 className="flex items-center gap-2 border-b border-surface-800 bg-surface-850/60 px-4 py-2 text-2xs font-semibold uppercase tracking-[0.09em] text-ink-500">
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
      toast.success('Role deleted')
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

  const pad = table.density === 'compact' ? 'py-1.5' : 'py-2'

  return (
    <div>
      <PageHeader
        eyebrow="Admin Center"
        title="Roles"
        description="A role bundles policies into one assignable unit. Accounts are given roles; roles carry the permissions the policy engine evaluates."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Create role
          </Button>
        }
      />

      <ListPanel
        toolbar={
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <SearchField
                value={table.query}
                onChange={table.setQuery}
                placeholder="Search roles…"
                className="min-w-[14rem] sm:max-w-sm"
              />
              <SegmentedControl
                size="sm"
                ariaLabel="Filter by type"
                value={table.filters.type}
                onChange={(v) => table.setFilter('type', v)}
                options={[
                  { key: 'all', label: 'All', count: roles.length },
                  { key: 'system', label: 'System', count: systemCount },
                  { key: 'custom', label: 'Custom', count: roles.length - systemCount },
                ]}
              />
              <span className="ml-auto flex flex-wrap items-center gap-2">
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
              </span>
            </div>

            {chips.length > 0 && (
              <div className="border-t border-surface-800 pt-3">
                <ActiveFilters chips={chips} onClearAll={table.resetFilters} />
              </div>
            )}
          </div>
        }
      >
        <QueryState
          query={rolesQuery}
          empty={(r) => !r || r.length === 0}
          emptyTitle="No roles defined"
          emptyMessage="Create a role to bundle policies and assign them to accounts."
          emptyAction={
            <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
              Create role
            </Button>
          }
        >
          {() =>
            table.total === 0 ? (
              <Card>
                <EmptyState
                  icon={SearchX}
                  title="No roles match"
                  description="Nothing matches the current search or type filter."
                  action={
                    <Button variant="secondary" onClick={table.resetFilters}>
                      Clear filters
                    </Button>
                  }
                />
              </Card>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[46rem] border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr>
                        <SortHeader
                          label="Role"
                          columnKey="name"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="min-w-[13rem]"
                        />
                        <SortHeader
                          label="Description"
                          columnKey="description"
                          sort={table.sort}
                          onSort={table.toggleSort}
                        />
                        <SortHeader
                          label="Type"
                          columnKey="is_system"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="w-28"
                        />
                        <SortHeader
                          label="Created"
                          columnKey="created_at"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="w-40"
                        />
                        <SortHeader label="Actions" columnKey="_actions" srOnly className="w-20" />
                      </tr>
                    </thead>
                    <tbody>
                      {table.pageRows.map((role) => {
                        const system = isSystemRole(role)
                        return (
                          <tr
                            key={role.id}
                            onClick={() => setPeeked(role)}
                            className="group cursor-pointer transition-colors hover:bg-surface-850"
                          >
                            <td className={clsx('border-b border-surface-800 px-4', pad)}>
                              <div className="flex min-w-0 items-center gap-3">
                                <span
                                  className={clsx(
                                    'flex h-8 w-8 flex-none items-center justify-center rounded-lg border transition-colors',
                                    system
                                      ? 'border-blue-500/30 bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                                      : 'border-surface-700 bg-surface-850 text-ink-400 group-hover:border-surface-600'
                                  )}
                                >
                                  <Lock className="h-3.5 w-3.5" strokeWidth={1.5} />
                                </span>
                                <span className="min-w-0">
                                  <span className="block truncate font-medium text-ink-50 transition-colors group-hover:text-blue-600 dark:group-hover:text-blue-300">
                                    {role.name}
                                  </span>
                                  <span className="mt-0.5 block truncate font-mono text-2xs text-ink-600">
                                    {String(role.id).slice(0, 8)}…
                                  </span>
                                </span>
                              </div>
                            </td>
                            <td
                              className={clsx(
                                'max-w-[20rem] border-b border-surface-800 px-4 text-ink-400',
                                pad
                              )}
                            >
                              <span className="block truncate">{role.description || '-'}</span>
                            </td>
                            <td className={clsx('whitespace-nowrap border-b border-surface-800 px-4', pad)}>
                              {system ? (
                                <Badge className="bg-blue-100 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30">
                                  System
                                </Badge>
                              ) : (
                                <Badge className="bg-surface-800 text-ink-300 ring-surface-700">Custom</Badge>
                              )}
                            </td>
                            <td
                              className={clsx(
                                'whitespace-nowrap border-b border-surface-800 px-4 text-xs tabular-nums text-ink-400',
                                pad
                              )}
                            >
                              {role.created_at ? formatDateTime(role.created_at) : '-'}
                            </td>
                            <td className={clsx('border-b border-surface-800 px-2', pad)}>
                              <div className="flex items-center justify-end gap-0.5">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setDeleteTarget(role)
                                  }}
                                  disabled={system}
                                  aria-label={`Delete ${role.name}`}
                                  title={
                                    system ? 'Built-in system roles cannot be deleted' : `Delete ${role.name}`
                                  }
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-500 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                                >
                                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                                </button>
                                <span className="flex h-7 w-7 items-center justify-center rounded-md text-ink-600 transition-colors group-hover:bg-surface-800 group-hover:text-ink-100">
                                  <ChevronRight className="h-4 w-4" strokeWidth={2} />
                                </span>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <CardFooter className="justify-between">
                  <p className="text-xs text-ink-500">
                    Showing {table.total} of {roles.length} roles
                  </p>
                  <Link2 className="h-3.5 w-3.5 text-ink-600" strokeWidth={1.75} />
                </CardFooter>
              </>
            )
          }
        </QueryState>
      </ListPanel>

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
    </div>
  )
}
