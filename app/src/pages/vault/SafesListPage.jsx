import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Plus,
  ChevronRight,
  Vault as VaultIcon,
  Clock,
  Star,
  Search,
  LayoutGrid,
  Rows3,
  SearchX,
} from 'lucide-react'
import clsx from 'clsx'
import { listSafes } from '../../api/vault'
import { PageHeader, Card, EmptyState, Toolbar } from '../../components/common/Layout'
import { QueryState } from '../../components/common/QueryState'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { SegmentedControl } from '../../components/common/SegmentedControl'
import { SearchField, SortHeader, RefreshControl } from '../../components/common/TableControls'
import { CreateSafeModal } from '../../components/vault/CreateSafeModal'
import { useTableState } from '../../hooks/useTableState'
import { formatDate } from '../../lib/format'

// ---------------------------------------------------------------------------
// Vault, safes
// ---------------------------------------------------------------------------
// KPI strip REMOVED at the user's request: on a page whose whole content is
// "here are your safes", a stat card reading "Safes: 4" above a list of four
// safes is furniture. The two facts that were worth keeping (which safe is
// default, what retention applies) are now attributes ON each safe, where
// they're actually actionable.
//
// Everything else is the console's standard list apparatus: one search, one
// sort, a card/table view switch, and the create action in the page header.
// listSafes() returns the whole collection and takes no params, so filtering
// and ordering are client-side by necessity, see useTableState.

function retentionTone(days) {
  if (typeof days !== 'number') return 'default'
  if (days >= 365) return 'long'
  if (days <= 30) return 'short'
  return 'default'
}

function SafeCard({ safe }) {
  return (
    <Card
      as={Link}
      to={`/vault/${safe.id}`}
      interactive
      className="group flex flex-col p-4 outline-none focus-visible:border-blue-500"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-surface-700 bg-surface-850 text-ink-400 transition-colors group-hover:border-blue-500/40 group-hover:text-blue-600 dark:group-hover:text-blue-300">
          <VaultIcon className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-50">{safe.name}</h3>
            {safe.is_default && (
              <Badge className="bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30">
                Default
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-500">
            {safe.description || 'No description'}
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-surface-800 pt-3">
        <span
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-2xs tabular-nums',
            retentionTone(safe.retention_days) === 'short'
              ? 'border-amber-300/50 bg-amber-50 text-amber-700 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300'
              : 'border-surface-700 bg-surface-850 text-ink-400'
          )}
          title="Deleted credential versions are purged after this many days"
        >
          <Clock className="h-3 w-3" strokeWidth={1.75} />
          {typeof safe.retention_days === 'number' ? `${safe.retention_days}d retention` : 'No retention set'}
        </span>
        <span className="flex items-center gap-1 text-2xs font-medium text-ink-500 transition-colors group-hover:text-blue-600 dark:group-hover:text-blue-300">
          Open
          <ChevronRight
            className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
            strokeWidth={2}
          />
        </span>
      </div>
    </Card>
  )
}

export default function SafesListPage() {
  const [createOpen, setCreateOpen] = useState(false)
  const [view, setView] = useState('grid')

  const safesQuery = useQuery({
    queryKey: ['vault', 'safes'],
    queryFn: ({ signal }) => listSafes(signal),
  })

  const safes = useMemo(() => safesQuery.data || [], [safesQuery.data])

  const table = useTableState({
    rows: safes,
    storageKey: 'safes',
    rowId: (s) => s.id,
    initialSort: { key: 'name', dir: 'asc' },
    initialPageSize: 50,
    searchFields: ['name', 'description'],
  })

  return (
    <div>
      <PageHeader
        eyebrow="Vault"
        title="Safes"
        description="Safes group credentials by ownership and retention policy. Secrets never leave the vault access is brokered, time-bound and recorded."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Create safe
          </Button>
        }
      />

      <Toolbar>
        <SearchField
          value={table.query}
          onChange={table.setQuery}
          placeholder="Search safes by name or description…"
          className="min-w-[14rem] sm:max-w-sm"
        />
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <SegmentedControl
            size="sm"
            ariaLabel="View"
            value={view}
            onChange={setView}
            options={[
              { key: 'grid', label: '', icon: LayoutGrid },
              { key: 'table', label: '', icon: Rows3 },
            ]}
          />
          <RefreshControl
            onRefresh={() => safesQuery.refetch()}
            isFetching={safesQuery.isFetching}
            updatedAt={safesQuery.dataUpdatedAt}
          />
        </span>
      </Toolbar>

      <QueryState
        query={safesQuery}
        empty={(d) => !d || d.length === 0}
        emptyTitle="No safes yet"
        emptyMessage="Create a safe to start storing credentials under a retention policy."
        emptyAction={
          <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
            Create safe
          </Button>
        }
        skeletonRows={4}
      >
        {() =>
          table.total === 0 ? (
            <Card>
              <EmptyState
                icon={SearchX}
                title="No safes match that search"
                description={`Nothing named like “${table.query}”. Clear the search to see every safe.`}
                action={
                  <Button variant="secondary" onClick={() => table.setQuery('')}>
                    Clear search
                  </Button>
                }
              />
            </Card>
          ) : view === 'grid' ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {table.pageRows.map((safe) => (
                <SafeCard key={safe.id} safe={safe} />
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr>
                      <SortHeader
                        label="Safe"
                        columnKey="name"
                        sort={table.sort}
                        onSort={table.toggleSort}
                        className="min-w-[14rem]"
                      />
                      <SortHeader
                        label="Description"
                        columnKey="description"
                        sort={table.sort}
                        onSort={table.toggleSort}
                      />
                      <SortHeader
                        label="Retention"
                        columnKey="retention_days"
                        sort={table.sort}
                        onSort={table.toggleSort}
                        align="right"
                      />
                      <SortHeader
                        label="Created"
                        columnKey="created_at"
                        sort={table.sort}
                        onSort={table.toggleSort}
                      />
                      <SortHeader label="Open" columnKey="_open" srOnly className="w-12" />
                    </tr>
                  </thead>
                  <tbody>
                    {table.pageRows.map((safe) => (
                      <tr key={safe.id} className="group transition-colors hover:bg-surface-850">
                        <td className="border-b border-surface-800 px-4 py-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-850 text-ink-400">
                              <VaultIcon className="h-4 w-4" strokeWidth={1.5} />
                            </span>
                            <Link
                              to={`/vault/${safe.id}`}
                              className="min-w-0 truncate font-medium text-ink-50 transition-colors hover:text-blue-600 dark:hover:text-blue-300"
                            >
                              {safe.name}
                            </Link>
                            {safe.is_default && (
                              <Badge className="bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30">
                                <Star className="h-2.5 w-2.5" strokeWidth={2.5} />
                                Default
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="max-w-[22rem] border-b border-surface-800 px-4 py-3 text-ink-400">
                          <span className="block truncate">{safe.description || '-'}</span>
                        </td>
                        <td className="whitespace-nowrap border-b border-surface-800 px-4 py-3 text-right font-mono text-xs tabular-nums text-ink-300">
                          {typeof safe.retention_days === 'number' ? `${safe.retention_days}d` : '-'}
                        </td>
                        <td className="whitespace-nowrap border-b border-surface-800 px-4 py-3 text-xs tabular-nums text-ink-400">
                          {safe.created_at ? formatDate(safe.created_at) : '-'}
                        </td>
                        <td className="border-b border-surface-800 px-2 py-3">
                          <Link
                            to={`/vault/${safe.id}`}
                            aria-label={`Open ${safe.name}`}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-600 transition-colors hover:bg-surface-800 hover:text-ink-100"
                          >
                            <ChevronRight className="h-4 w-4" strokeWidth={2} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )
        }
      </QueryState>

      <CreateSafeModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  )
}
