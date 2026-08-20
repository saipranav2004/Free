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
import { Container, PageTitle, Stack } from '../../components/ui/layout'
import { DataTable, RowActions, SkeletonGrid, SortTh, Td, Th, Tr, Trunc } from '../../components/ui/grid'
import { MenuItem, MenuNote, RowMenu } from '../../components/ui/menu'
import { FilterChip, Meta, StatusDot } from '../../components/ui/bits'
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
import { CardFooter } from '../../components/common/Layout'
import { QueryState } from '../../components/common/QueryState'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { Drawer } from '../../components/common/Drawer'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { CreatePolicyModal } from '../../components/admin/CreatePolicyModal'
import { useTableState } from '../../hooks/useTableState'
import { exportRowsToCsv, exportRowsToJson } from '../../lib/exportRows'
import { apiErrorMessage, normalizeApiError } from '../../lib/apiError'
import { formatDateTime, formatRelativeToNow } from '../../lib/format'
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
            <span className="inline-flex items-center gap-1.5 rounded border border-amber-300/70 bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
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
        <h3 className="flex items-center gap-2 border-b border-surface-800 bg-surface-850/60 px-4 py-2 text-xs font-semibold text-ink-500">
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
        <h3 className="flex items-center gap-2 border-b border-surface-800 bg-surface-850/60 px-4 py-2 text-xs font-semibold text-ink-500">
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
      toast.success('Policy deleted', {
        description: 'Roles that referenced it no longer grant its actions.',
      })
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

  const err = policiesQuery.isError ? normalizeApiError(policiesQuery.error) : null

  const chips = []
  if (table.query)
    chips.push({ key: 'q', label: 'Search', value: table.query, onClear: () => table.setQuery('') })
  if (table.filters.effect !== 'all')
    chips.push({
      key: 'effect',
      label: 'Effect',
      value: table.filters.effect,
      onClear: () => table.setFilter('effect', 'all'),
    })

  return (
    <Stack gap="lg">
      <PageTitle
        title="Policies"
        counter={policiesQuery.isSuccess ? policies.length : undefined}
        description="A policy is one allow or deny rule over a set of actions and a set of resources. Roles bundle them; the policy engine evaluates them."
      />

      <Stack gap="sm">
        <CommandBar
          primary={
            <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
              Create policy
            </Button>
          }
          summary={
            policiesQuery.isSuccess && table.total !== policies.length
              ? `${table.total} of ${policies.length} shown`
              : undefined
          }
        >
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
          <PreferencesMenu pageSize={table.pageSize} onPageSize={table.setPageSize} />
        </CommandBar>

        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            value={table.query}
            onChange={table.setQuery}
            placeholder="Search policies"
            label="Search policies"
          />
          {[
            { key: 'all', label: 'All', count: policies.length },
            { key: 'allow', label: 'Allow', count: allowCount },
            { key: 'deny', label: 'Deny', count: denyCount },
          ].map((f) => (
            <FilterChip
              key={f.key}
              active={table.filters.effect === f.key}
              count={f.count}
              onClick={() => table.setFilter('effect', f.key)}
            >
              {f.label}
            </FilterChip>
          ))}
          {wildcardCount > 0 && (
            <span className="text-sm text-warn" title="Policies whose scope includes a wildcard">
              {wildcardCount} unscoped
            </span>
          )}
        </div>

        <ActiveFilters chips={chips} onClearAll={table.resetFilters} />
      </Stack>

      <Container padded={false}>
        {policiesQuery.isLoading ? (
          <table className="w-full">
            <tbody>
              <SkeletonGrid colSpan={6} rows={6} />
            </tbody>
          </table>
        ) : err ? (
          err.status === 403 ? (
            <DeniedState description={err.message} />
          ) : err.code === 'network_error' ? (
            <OfflineState onRetry={() => policiesQuery.refetch()} retrying={policiesQuery.isFetching} />
          ) : (
            <ErrorState
              description={err.message}
              onRetry={() => policiesQuery.refetch()}
              retrying={policiesQuery.isFetching}
            />
          )
        ) : policies.length === 0 ? (
          <EmptyState
            icon={FileKey2}
            title="No policies yet"
            description="A policy is one allow or deny rule over actions and resources. Create the first one to start granting access."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
                Create the first policy
              </Button>
            }
          />
        ) : table.total === 0 ? (
          <NoMatchState
            description="Nothing matches the current search or effect filter."
            onClear={table.resetFilters}
          />
        ) : (
          <>
            <DataTable minWidth="54rem">
              <colgroup>
                <col className="w-[16rem] min-w-[12rem]" />
                <col className="w-[7.5rem]" />
                <col className="w-[8.5rem]" />
                <col className="w-auto" />
                <col className="w-[9rem]" />
                <col className="w-[4rem]" />
              </colgroup>
              <thead>
                <tr>
                  <SortTh columnKey="name" sort={table.sort} onSort={table.toggleSort} sticky edge>
                    Policy
                  </SortTh>
                  <SortTh columnKey="effect" sort={table.sort} onSort={table.toggleSort}>
                    Effect
                  </SortTh>
                  <SortTh columnKey="actions" sort={table.sort} onSort={table.toggleSort} align="right">
                    Actions
                  </SortTh>
                  <Th>Scope</Th>
                  <SortTh columnKey="created_at" sort={table.sort} onSort={table.toggleSort}>
                    Created
                  </SortTh>
                  <Th align="right">
                    <span className="sr-only">Row actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {table.pageRows.map((p) => {
                  const deny = p.effect === 'deny'
                  const wildcard = isWildcard(p)
                  return (
                    <Tr key={p.id}>
                      {/* A deny rule carries an edge rail for the same reason a
                          failed audit row does: it inverts the meaning of
                          everything around it, and it has to be findable
                          without reading across to the effect column. */}
                      <Td
                        sticky
                        edge
                        className={deny ? 'shadow-[inset_3px_0_0_0_rgb(var(--danger))]' : undefined}
                      >
                        <button
                          type="button"
                          onClick={() => setPeeked(p)}
                          title={p.name}
                          className="block max-w-full truncate text-left text-sm font-medium text-primary transition-colors hover:text-accent hover:underline"
                        >
                          {p.name}
                        </button>
                      </Td>
                      <Td>
                        <StatusDot tone={deny ? 'danger' : 'ok'} label={deny ? 'Deny' : 'Allow'} />
                      </Td>
                      <Td align="right">
                        <span className="text-sm tabular text-primary">{(p.actions || []).length}</span>
                      </Td>
                      <Td>
                        {/* The scope is the whole point of a policy, so it is
                            shown rather than counted. A wildcard is called out
                            because "resources: 1" hides that the one is `*`. */}
                        <span className="flex min-w-0 items-center gap-2">
                          <Trunc value={(p.resources || []).join(', ')} mono muted />
                          {wildcard && <Meta tone="warn">unscoped</Meta>}
                        </span>
                      </Td>
                      <Td>
                        <span className="text-sm text-secondary" title={formatDateTime(p.created_at)}>
                          {formatRelativeToNow(p.created_at)}
                        </span>
                      </Td>
                      <Td align="right">
                        <RowActions>
                          <RowMenu label={`Actions for ${p.name}`}>
                            <MenuItem icon={FileKey2} onClick={() => setPeeked(p)}>
                              Open policy
                            </MenuItem>
                            {!p.is_system && (
                              <MenuItem icon={Trash2} danger onClick={() => setDeleteTarget(p)}>
                                Delete policy
                              </MenuItem>
                            )}
                            {p.is_system && <MenuNote>Built in policies cannot be deleted.</MenuNote>}
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
              label="policies"
            />
          </>
        )}
      </Container>

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
    </Stack>
  )
}
