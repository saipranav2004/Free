import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Plus,
  FileKey2,
  Trash2,
  ShieldCheck,
  ShieldX,
  SearchX,
  ChevronRight,
  Globe,
  Terminal,
  Boxes,
  AlertTriangle,
  Copy,
  Check,
} from 'lucide-react'
import clsx from 'clsx'
import { listPolicies, deletePolicy } from '../../api/rbac'
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
import { CreatePolicyModal } from '../../components/admin/CreatePolicyModal'
import { useTableState } from '../../hooks/useTableState'
import { exportRowsToCsv, exportRowsToJson } from '../../lib/exportRows'
import { apiErrorMessage } from '../../lib/apiError'
import { formatDateTime } from '../../lib/format'
import { POLICY_EFFECT_BADGE } from '../../config/constants'

// ---------------------------------------------------------------------------
// Admin Center, Policies
// ---------------------------------------------------------------------------
// Was a flat list of two-line rows: name, effect badge, and a truncated
// "actions: a, b, +3 more · resources: …" string that answered neither
// question it was trying to answer. A policy has exactly three facts worth
// scanning, effect, how many actions, how wide its resource scope, so they
// become columns, and the full rule opens in a drawer.
//
// The scope column is the one that earns its place: a policy scoped to `*`
// is categorically different from one scoped to two named resources, and
// that difference was previously buried inside a truncated string.

const CSV_COLUMNS = [
  { key: 'name', label: 'Policy' },
  { key: 'effect', label: 'Effect' },
  { key: 'description', label: 'Description' },
  { key: 'actions', label: 'Actions', value: (p) => (p.actions || []).join(' | ') },
  { key: 'resources', label: 'Resources', value: (p) => (p.resources || []).join(' | ') },
  { key: 'created_at', label: 'Created' },
  { key: 'id', label: 'Policy ID' },
]

function isWildcard(policy) {
  return (policy?.resources || []).includes('*')
}

function CopyLine({ value }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          /* clipboard unavailable, the value is still selectable on screen */
        }
      }}
      title="Copy"
      className="flex h-6 w-6 flex-none items-center justify-center rounded text-ink-600 transition-colors hover:bg-surface-800 hover:text-ink-200"
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
      ) : (
        <Copy className="h-3 w-3" strokeWidth={1.75} />
      )}
    </button>
  )
}

function PolicyDrawer({ policy, onClose, onDelete }) {
  if (!policy) return null
  const actions = policy.actions || []
  const resources = policy.resources || []
  const deny = policy.effect === 'deny'
  const wildcard = isWildcard(policy)

  return (
    <Drawer
      open={!!policy}
      onClose={onClose}
      width="lg"
      icon={
        deny ? (
          <ShieldX className="h-4 w-4 text-red-500" strokeWidth={1.75} />
        ) : (
          <ShieldCheck className="h-4 w-4 text-emerald-500" strokeWidth={1.75} />
        )
      }
      title={policy.name}
      subtitle={policy.id}
      footer={
        <>
          <Button size="sm" variant="dangerGhost" icon={Trash2} onClick={() => onDelete(policy)}>
            Delete policy
          </Button>
          <span className="ml-auto text-2xs text-ink-500">
            {actions.length} action{actions.length === 1 ? '' : 's'} · {resources.length} resource pattern
            {resources.length === 1 ? '' : 's'}
          </span>
        </>
      }
    >
      {/* The rule as a sentence, before the lists, an auditor reading this
 drawer wants the verdict first, the enumeration second. */}
      <div
        className={clsx(
          'border-b border-surface-800 px-4 py-4',
          deny ? 'bg-red-50 dark:bg-red-950/20' : 'bg-emerald-50/60 dark:bg-emerald-950/15'
        )}
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge className={POLICY_EFFECT_BADGE[policy.effect]}>{policy.effect || 'unknown'}</Badge>
          {wildcard && (
            <span className="inline-flex items-center gap-1.5 rounded border border-amber-300/70 bg-amber-50 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
              <Globe className="h-3 w-3" strokeWidth={2} /> All resources
            </span>
          )}
        </div>
        <p
          className={clsx(
            'text-sm font-medium leading-relaxed',
            deny ? 'text-red-800 dark:text-red-200' : 'text-emerald-800 dark:text-emerald-200'
          )}
        >
          {deny ? 'Denies' : 'Allows'} {actions.length} action{actions.length === 1 ? '' : 's'} on{' '}
          {wildcard
            ? 'every resource'
            : `${resources.length} resource pattern${resources.length === 1 ? '' : 's'}`}
          .
        </p>
        {policy.description && (
          <p className="mt-1.5 text-sm leading-relaxed text-ink-400">{policy.description}</p>
        )}
      </div>

      {deny && (
        <div className="flex items-start gap-2.5 border-b border-surface-800 bg-surface-850/60 px-4 py-3">
          <AlertTriangle
            className="mt-px h-3.5 w-3.5 flex-none text-amber-600 dark:text-amber-400"
            strokeWidth={1.75}
          />
          <p className="text-xs leading-relaxed text-ink-400">
            Deny takes precedence over every allow an account holds, from any role or direct attachment. A
            single deny is enough to block the action.
          </p>
        </div>
      )}

      <section>
        <h3 className="flex items-center gap-2 border-b border-surface-800 bg-surface-850/60 px-4 py-2 text-2xs font-semibold uppercase tracking-[0.09em] text-ink-500">
          <Terminal className="h-3.5 w-3.5" strokeWidth={1.75} /> Actions ({actions.length})
        </h3>
        {actions.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-ink-500">
            No actions, this policy matches nothing.
          </p>
        ) : (
          <ul className="divide-y divide-surface-800/70">
            {actions.map((a) => (
              <li key={a} className="flex items-center gap-2 px-4 py-2">
                <span className="min-w-0 flex-1 break-all font-mono text-xs text-ink-200">{a}</span>
                <CopyLine value={a} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="flex items-center gap-2 border-b border-surface-800 bg-surface-850/60 px-4 py-2 text-2xs font-semibold uppercase tracking-[0.09em] text-ink-500">
          <Boxes className="h-3.5 w-3.5" strokeWidth={1.75} /> Resource patterns ({resources.length})
        </h3>
        {resources.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-ink-500">
            No resource patterns, this policy matches nothing.
          </p>
        ) : (
          <ul className="divide-y divide-surface-800/70">
            {resources.map((r) => (
              <li key={r} className="flex items-center gap-2 px-4 py-2">
                <span className="min-w-0 flex-1 break-all font-mono text-xs text-ink-200">
                  {r}
                  {r === '*' && (
                    <span className="ml-2 font-sans text-2xs text-amber-600 dark:text-amber-400">
                      every resource
                    </span>
                  )}
                </span>
                <CopyLine value={r} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <dl className="divide-y divide-surface-800 border-t border-surface-800">
        <div className="grid grid-cols-[minmax(6.5rem,34%)_1fr] gap-3 px-4 py-2.5">
          <dt className="text-2xs font-medium uppercase tracking-[0.07em] text-ink-500">Created</dt>
          <dd className="text-sm text-ink-100">
            {policy.created_at ? formatDateTime(policy.created_at) : '-'}
          </dd>
        </div>
        <div className="grid grid-cols-[minmax(6.5rem,34%)_1fr] gap-3 px-4 py-2.5">
          <dt className="text-2xs font-medium uppercase tracking-[0.07em] text-ink-500">Policy ID</dt>
          <dd className="break-all font-mono text-xs text-ink-300">{policy.id}</dd>
        </div>
      </dl>
    </Drawer>
  )
}

export default function PoliciesPage() {
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

  const policiesQuery = useQuery({
    queryKey: ['admin', 'policies'],
    queryFn: ({ signal }) => listPolicies(signal),
  })

  const deleteMutation = useMutation({
    mutationFn: (policyId) => deletePolicy(policyId),
    onSuccess: () => {
      toast.success('Policy deleted')
      queryClient.invalidateQueries({ queryKey: ['admin', 'policies'] })
      setDeleteTarget(null)
      setPeeked(null)
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setDeleteTarget(null)
    },
  })

  const policies = useMemo(() => policiesQuery.data || [], [policiesQuery.data])

  const table = useTableState({
    rows: policies,
    storageKey: 'policies',
    rowId: (p) => p.id,
    initialSort: { key: 'name', dir: 'asc' },
    initialPageSize: 25,
    initialFilters: { effect: 'all' },
    // Free text is owned BY the hook (table.query), it already resets paging
    // and clears selection on change, so a parallel local useState would only
    // give the two a way to disagree.
    searchFields: ['name', 'description'],
    filterFn: (p, f) => (f.effect === 'all' ? true : p.effect === f.effect),
    sortAccessor: (p, key) =>
      key === 'actions'
        ? (p.actions || []).length
        : key === 'resources'
          ? (p.resources || []).length
          : p[key],
  })

  const allowCount = policies.filter((p) => p.effect === 'allow').length
  const denyCount = policies.filter((p) => p.effect === 'deny').length
  const wildcardCount = policies.filter(isWildcard).length

  const chips = []
  if (table.query) {
    chips.push({ key: 'q', label: 'Search', value: table.query, onClear: () => table.setQuery('') })
  }
  if (table.filters.effect !== 'all') {
    chips.push({
      key: 'effect',
      label: 'Effect',
      value: table.filters.effect,
      onClear: () => table.setFilter('effect', 'all'),
    })
  }

  const pad = table.density === 'compact' ? 'py-1.5' : 'py-2'

  return (
    <div>
      <PageHeader
        eyebrow="Admin Center"
        title="Policies"
        description="Allow and deny rules over actions and resources. Attach them to roles for reuse, or directly to an account as a deliberate exception."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Create policy
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
                placeholder="Search policies…"
                className="min-w-[14rem] sm:max-w-sm"
              />
              <SegmentedControl
                size="sm"
                ariaLabel="Filter by effect"
                value={table.filters.effect}
                onChange={(v) => table.setFilter('effect', v)}
                options={[
                  { key: 'all', label: 'All', count: policies.length },
                  { key: 'allow', label: 'Allow', count: allowCount },
                  { key: 'deny', label: 'Deny', count: denyCount },
                ]}
              />
              <span className="ml-auto flex flex-wrap items-center gap-2">
                <ExportMenu
                  count={table.total}
                  disabled={table.total === 0}
                  onExportCsv={() => exportRowsToCsv(table.filteredRows, CSV_COLUMNS, 'policies')}
                  onExportJson={() => exportRowsToJson(table.filteredRows, CSV_COLUMNS, 'policies')}
                />
                <RefreshControl
                  onRefresh={() => policiesQuery.refetch()}
                  isFetching={policiesQuery.isFetching}
                  updatedAt={policiesQuery.dataUpdatedAt}
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
          query={policiesQuery}
          empty={(p) => !p || p.length === 0}
          emptyTitle="No policies defined"
          emptyMessage="A policy is one allow-or-deny rule over actions and resources. Create the first one to start granting access."
          emptyAction={
            <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
              Create policy
            </Button>
          }
        >
          {() =>
            table.total === 0 ? (
              <Card>
                <EmptyState
                  icon={SearchX}
                  title="No policies match"
                  description="Nothing matches the current search or effect filter."
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
                  <table className="w-full min-w-[52rem] border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr>
                        <SortHeader
                          label="Policy"
                          columnKey="name"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="min-w-[14rem]"
                        />
                        <SortHeader
                          label="Effect"
                          columnKey="effect"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="w-24"
                        />
                        <SortHeader
                          label="Actions"
                          columnKey="actions"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="w-24"
                        />
                        <SortHeader
                          label="Scope"
                          columnKey="resources"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          className="w-44"
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
                      {table.pageRows.map((p) => {
                        const deny = p.effect === 'deny'
                        const wildcard = isWildcard(p)
                        const actionCount = (p.actions || []).length
                        const resourceCount = (p.resources || []).length
                        return (
                          <tr
                            key={p.id}
                            onClick={() => setPeeked(p)}
                            className={clsx(
                              'group cursor-pointer transition-colors',
                              deny ? 'hover:bg-red-50/60 dark:hover:bg-red-950/20' : 'hover:bg-surface-850'
                            )}
                          >
                            <td className={clsx('relative border-b border-surface-800 px-4', pad)}>
                              {/* Deny rules carry an edge rail for the same
 reason failed audit rows do: they invert the
 meaning of everything around them. */}
                              <span
                                aria-hidden="true"
                                className={clsx(
                                  'absolute inset-y-0 left-0 w-[3px]',
                                  deny ? 'bg-red-400/70' : 'bg-transparent'
                                )}
                              />
                              <div className="flex min-w-0 items-center gap-3">
                                <span
                                  className={clsx(
                                    'flex h-8 w-8 flex-none items-center justify-center rounded-lg border transition-colors',
                                    deny
                                      ? 'border-red-300/60 bg-red-50 text-red-600 dark:border-red-900/50 dark:bg-red-500/10 dark:text-red-300'
                                      : 'border-emerald-300/50 bg-emerald-50 text-emerald-600 dark:border-emerald-900/40 dark:bg-emerald-500/10 dark:text-emerald-300'
                                  )}
                                >
                                  {deny ? (
                                    <ShieldX className="h-3.5 w-3.5" strokeWidth={1.5} />
                                  ) : (
                                    <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
                                  )}
                                </span>
                                <span className="min-w-0">
                                  <span className="block truncate font-medium text-ink-50 transition-colors group-hover:text-blue-600 dark:group-hover:text-blue-300">
                                    {p.name}
                                  </span>
                                  {p.description && (
                                    <span className="mt-0.5 block max-w-[22rem] truncate text-xs text-ink-500">
                                      {p.description}
                                    </span>
                                  )}
                                </span>
                              </div>
                            </td>
                            <td className={clsx('whitespace-nowrap border-b border-surface-800 px-4', pad)}>
                              <Badge className={POLICY_EFFECT_BADGE[p.effect]}>{p.effect || 'unknown'}</Badge>
                            </td>
                            <td
                              className={clsx(
                                'whitespace-nowrap border-b border-surface-800 px-4 text-xs tabular-nums',
                                pad
                              )}
                            >
                              <span
                                className={
                                  actionCount === 0 ? 'text-amber-600 dark:text-amber-400' : 'text-ink-300'
                                }
                              >
                                {actionCount}
                              </span>
                            </td>
                            <td className={clsx('whitespace-nowrap border-b border-surface-800 px-4', pad)}>
                              {wildcard ? (
                                <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-0.5 text-2xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25">
                                  <Globe className="h-3 w-3" strokeWidth={2} /> All resources
                                </span>
                              ) : (
                                <span className="text-xs tabular-nums text-ink-400">
                                  {resourceCount} pattern{resourceCount === 1 ? '' : 's'}
                                </span>
                              )}
                            </td>
                            <td
                              className={clsx(
                                'whitespace-nowrap border-b border-surface-800 px-4 text-xs tabular-nums text-ink-400',
                                pad
                              )}
                            >
                              {p.created_at ? formatDateTime(p.created_at) : '-'}
                            </td>
                            <td className={clsx('border-b border-surface-800 px-2', pad)}>
                              <div className="flex items-center justify-end gap-0.5">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setDeleteTarget(p)
                                  }}
                                  aria-label={`Delete ${p.name}`}
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30 dark:hover:text-red-300"
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
                    Showing {table.total} of {policies.length} policies
                  </p>
                  {denyCount > 0 && <p className="text-2xs text-ink-500">Deny rules override every allow</p>}
                </CardFooter>
              </>
            )
          }
        </QueryState>
      </ListPanel>

      <PolicyDrawer policy={peeked} onClose={() => setPeeked(null)} onDelete={setDeleteTarget} />

      <CreatePolicyModal open={createOpen} onClose={() => setCreateOpen(false)} />

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete policy “${deleteTarget?.name}”?`}
        description="Every role and account it was attached to immediately loses the access it granted, or, for a deny rule, regains the access it was blocking."
        confirmLabel="Delete policy"
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
