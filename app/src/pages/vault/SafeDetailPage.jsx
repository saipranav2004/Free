import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import {
  Plus,
  FolderTree,
  KeyRound,
  ChevronRight,
  Clock,
  Hash,
  Folder,
  Layers,
  ShieldAlert,
  SearchX,
  Copy,
  Check,
} from 'lucide-react'
import clsx from 'clsx'
import { getSafe, listFolders, listCredentials } from '../../api/vault'
import { PageHeader, Card, CardHeader, CardTitle, EmptyState } from '../../components/common/Layout'
import { QueryState } from '../../components/common/QueryState'
import { Badge } from '../../components/common/Badge'
import { StatusDot } from '../../components/ui/bits'
import { Button } from '../../components/common/Button'
import { SearchField, SortHeader, RefreshControl } from '../../components/common/TableControls'
import { Pagination } from '../../components/common/Pagination'
import { CreateFolderModal } from '../../components/vault/CreateFolderModal'
import { CreateCredentialModal } from '../../components/vault/CreateCredentialModal'
import { useTableState } from '../../hooks/useTableState'
import { formatDateTime, formatDate } from '../../lib/format'

// ---------------------------------------------------------------------------
// Safe detail, the vault's working screen
// ---------------------------------------------------------------------------
// Rebuilt around what an operator actually does here: find one credential
// among many, see at a glance whether it is healthy (rotation overdue?
// break-glass? inactive?), and store a new one. The old version was two bare
// lists side by side with an unlabelled "+" for folders.
//
// Structure: identity header with the safe's real attributes as chips →
// folder rail that FILTERS the table (rather than being a second list you
// read separately) → credentials table with search, status facet, sort,
// pagination and rotation health.
//
// All three endpoints return whole collections and take no params, so
// filtering/ordering is client-side by necessity (useTableState).

function rotationHealth(cred) {
  if (!cred?.next_rotation_at) return null
  const due = new Date(cred.next_rotation_at).getTime()
  if (Number.isNaN(due)) return null
  const days = Math.round((due - Date.now()) / 86_400_000)
  if (days < 0) return { tone: 'red', label: `Overdue ${Math.abs(days)}d` }
  if (days <= 7) return { tone: 'amber', label: `Due in ${days}d` }
  return { tone: 'ink', label: `Due ${formatDate(cred.next_rotation_at)}` }
}

// Status reads as a dot beside the word, the same mark the grids use, rather
// than a filled pill. Active is settled (ok), a rotation in flight is the
// accent, anything else is a quiet hollow ring.
function credentialStatusTone(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'active') return 'ok'
  if (s === 'rotating') return 'accent'
  return 'muted'
}

function StatusBadge({ status }) {
  return (
    <StatusDot
      tone={credentialStatusTone(status)}
      live={String(status || '').toLowerCase() === 'rotating'}
      label={status || 'unknown'}
      className="capitalize"
    />
  )
}

function MetaChip({ icon: Icon, children, title }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-850 px-2 py-1 text-2xs font-medium text-ink-400"
    >
      <Icon className="h-3 w-3 flex-none text-ink-500" strokeWidth={1.75} />
      {children}
    </span>
  )
}

function SafeIdChip({ id }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(id)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          /* clipboard unavailable, the id is still selectable on screen */
        }
      }}
      title="Copy safe ID"
      className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-850 px-2 py-1 font-mono text-2xs text-ink-400 transition-colors hover:border-surface-600 hover:text-ink-200"
    >
      {copied ? (
        <Check className="h-3 w-3 flex-none text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
      ) : (
        <Copy className="h-3 w-3 flex-none text-ink-500" strokeWidth={1.75} />
      )}
      {String(id).slice(0, 8)}…
    </button>
  )
}

export default function SafeDetailPage() {
  const { safeId } = useParams()
  const [folderModalOpen, setFolderModalOpen] = useState(false)
  const [credentialModalOpen, setCredentialModalOpen] = useState(false)
  const [activeFolder, setActiveFolder] = useState('all') // 'all' | 'root' | folder id

  const safeQuery = useQuery({
    queryKey: ['vault', 'safes', safeId],
    queryFn: ({ signal }) => getSafe(safeId, signal),
  })
  const foldersQuery = useQuery({
    queryKey: ['vault', 'safes', safeId, 'folders'],
    queryFn: ({ signal }) => listFolders(safeId, signal),
  })
  const credentialsQuery = useQuery({
    queryKey: ['vault', 'safes', safeId, 'credentials'],
    queryFn: ({ signal }) => listCredentials(safeId, signal),
  })

  const folders = useMemo(() => foldersQuery.data || [], [foldersQuery.data])
  const credentials = useMemo(() => credentialsQuery.data || [], [credentialsQuery.data])

  const countsByFolder = useMemo(() => {
    const map = new Map()
    let rootCount = 0
    for (const c of credentials) {
      if (!c.folder_id) rootCount++
      else map.set(c.folder_id, (map.get(c.folder_id) || 0) + 1)
    }
    return { map, rootCount }
  }, [credentials])

  const table = useTableState({
    rows: credentials,
    storageKey: 'safe-credentials',
    rowId: (c) => c.id,
    initialSort: { key: 'name', dir: 'asc' },
    initialPageSize: 25,
    initialFilters: { status: 'all', folder: 'all' },
    searchFields: ['name', 'account_name', 'credential_type', 'description'],
    filterFn: (c, f) => {
      if (f.status !== 'all' && String(c.status || '').toLowerCase() !== f.status) return false
      if (f.folder === 'root' && c.folder_id) return false
      if (f.folder !== 'all' && f.folder !== 'root' && c.folder_id !== f.folder) return false
      return true
    },
  })

  const selectFolder = (key) => {
    setActiveFolder(key)
    table.setFilter('folder', key)
  }

  const statuses = useMemo(
    () => [...new Set(credentials.map((c) => String(c.status || 'unknown').toLowerCase()))].sort(),
    [credentials]
  )

  const breakglassCount = credentials.filter((c) => c.is_breakglass).length
  const overdueCount = credentials.filter((c) => rotationHealth(c)?.tone === 'red').length

  return (
    <div>
      <QueryState query={safeQuery} skeletonRows={3}>
        {(safe) => (
          <PageHeader
            title={safe.name}
            description={safe.description || 'No description set for this safe.'}
            meta={
              <>
                {safe.is_default && (
                  <Badge className="bg-accent-soft text-accent ring-accent/20">
                    Default safe
                  </Badge>
                )}
                <MetaChip icon={Clock} title="Deleted versions are purged after this many days">
                  {typeof safe.retention_days === 'number'
                    ? `${safe.retention_days}d retention`
                    : 'No retention set'}
                </MetaChip>
                <MetaChip icon={KeyRound}>{credentials.length} credentials</MetaChip>
                <MetaChip icon={Folder}>{folders.length} folders</MetaChip>
                {breakglassCount > 0 && <MetaChip icon={ShieldAlert}>{breakglassCount} break-glass</MetaChip>}
                {safe.created_at && <MetaChip icon={Hash}>Created {formatDate(safe.created_at)}</MetaChip>}
                <SafeIdChip id={safe.id} />
              </>
            }
            actions={
              <>
                <Button variant="secondary" icon={FolderTree} onClick={() => setFolderModalOpen(true)}>
                  New folder
                </Button>
                <Button variant="primary" icon={Plus} onClick={() => setCredentialModalOpen(true)}>
                  Store credential
                </Button>
              </>
            }
          />
        )}
      </QueryState>

      {overdueCount > 0 && (
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-amber-300/70 bg-amber-50 px-4 py-3 dark:border-amber-900/40 dark:bg-amber-950/25">
          <ShieldAlert
            className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400"
            strokeWidth={1.75}
          />
          <p className="text-sm leading-relaxed text-amber-800 dark:text-amber-200">
            <span className="font-semibold">
              {overdueCount} credential{overdueCount === 1 ? '' : 's'} past its rotation date.
            </span>{' '}
            Rotation is requested per credential, open one to queue a rotation job.
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
        {/* Folder rail, a FILTER, not a second list to read. */}
        <Card className="h-fit overflow-hidden">
          <CardHeader>
            <CardTitle icon={FolderTree}>Folders</CardTitle>
            <Button
              size="xs"
              variant="ghost"
              icon={Plus}
              className="ml-auto"
              onClick={() => setFolderModalOpen(true)}
              aria-label="Create folder"
            />
          </CardHeader>
          <nav className="p-1.5" aria-label="Folders">
            {[
              { key: 'all', name: 'All credentials', count: credentials.length, icon: Layers },
              { key: 'root', name: 'Safe root', count: countsByFolder.rootCount, icon: Folder },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => selectFolder(f.key)}
                className={clsx(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                  activeFolder === f.key
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-ink-300 hover:bg-surface-850 hover:text-ink-50'
                )}
              >
                <f.icon
                  className={clsx(
                    'h-4 w-4 flex-none',
                    activeFolder === f.key ? 'text-accent' : 'text-ink-500'
                  )}
                  strokeWidth={1.5}
                />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="flex-none text-2xs tabular-nums text-ink-500">{f.count}</span>
              </button>
            ))}

            {folders.length > 0 && <div className="my-1.5 h-px bg-surface-800" aria-hidden="true" />}

            <QueryState query={foldersQuery} skeletonRows={3} empty={() => false}>
              {() =>
                folders.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => selectFolder(f.id)}
                    title={f.path}
                    className={clsx(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                      activeFolder === f.id
                        ? 'bg-accent-soft font-medium text-accent'
                        : 'text-ink-300 hover:bg-surface-850 hover:text-ink-50'
                    )}
                  >
                    <Folder
                      className={clsx(
                        'h-4 w-4 flex-none',
                        activeFolder === f.id ? 'text-accent' : 'text-ink-500'
                      )}
                      strokeWidth={1.5}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{f.name}</span>
                      <span className="block truncate font-mono text-2xs text-ink-600">{f.path}</span>
                    </span>
                    <span className="flex-none text-2xs tabular-nums text-ink-500">
                      {countsByFolder.map.get(f.id) || 0}
                    </span>
                  </button>
                ))
              }
            </QueryState>

            {folders.length === 0 && !foldersQuery.isLoading && (
              <p className="px-2.5 py-3 text-xs leading-relaxed text-ink-500">
                No folders yet, every credential sits at the safe root.
              </p>
            )}
          </nav>
        </Card>

        {/* Credentials */}
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-surface-700/70 bg-surface-900 px-3 py-2.5 ">
            <SearchField
              value={table.query}
              onChange={table.setQuery}
              placeholder="Search name, account or type…"
              className="min-w-[13rem] sm:max-w-xs"
            />
            <label className="flex items-center gap-2">
              <span className="whitespace-nowrap text-xs font-medium text-ink-400">Status</span>
              <select
                value={table.filters.status}
                onChange={(e) => table.setFilter('status', e.target.value)}
                className="h-9 cursor-pointer rounded-lg border border-surface-700 bg-surface-900 pl-2.5 pr-7 text-xs font-medium text-ink-100 shadow-sm transition-colors hover:border-surface-600 focus:border-accent focus:outline-none"
              >
                <option value="all">Any</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <span className="ml-auto">
              <RefreshControl
                onRefresh={() => credentialsQuery.refetch()}
                isFetching={credentialsQuery.isFetching}
                updatedAt={credentialsQuery.dataUpdatedAt}
              />
            </span>
          </div>

          <QueryState
            query={credentialsQuery}
            empty={(c) => !c || c.length === 0}
            emptyTitle="No credentials in this safe"
            emptyMessage="Store the first credential, it is encrypted before it is written and only ever released through an audited reveal."
            emptyAction={
              <Button variant="primary" icon={Plus} onClick={() => setCredentialModalOpen(true)}>
                Store credential
              </Button>
            }
            skeletonRows={6}
          >
            {() =>
              table.total === 0 ? (
                <Card>
                  <EmptyState
                    icon={SearchX}
                    title="Nothing matches these filters"
                    description="Every credential in this safe was filtered out by the current search, folder or status."
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => {
                          table.resetFilters()
                          setActiveFolder('all')
                        }}
                      >
                        Clear filters
                      </Button>
                    }
                  />
                </Card>
              ) : (
                <Card className="overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[44rem] border-separate border-spacing-0 text-sm">
                      <thead>
                        <tr>
                          <SortHeader
                            label="Credential"
                            columnKey="name"
                            sort={table.sort}
                            onSort={table.toggleSort}
                            className="min-w-[15rem]"
                          />
                          <SortHeader
                            label="Account"
                            columnKey="account_name"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                          <SortHeader
                            label="Type"
                            columnKey="credential_type"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                          <SortHeader
                            label="Status"
                            columnKey="status"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                          <SortHeader
                            label="Rotation"
                            columnKey="next_rotation_at"
                            sort={table.sort}
                            onSort={table.toggleSort}
                          />
                          <SortHeader label="Open" columnKey="_open" srOnly className="w-12" />
                        </tr>
                      </thead>
                      <tbody>
                        {table.pageRows.map((c) => {
                          const health = rotationHealth(c)
                          return (
                            <tr key={c.id} className="group transition-colors hover:bg-surface-850">
                              <td className="border-b border-surface-800 px-4 py-3">
                                <div className="flex min-w-0 items-center gap-3">
                                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-850 text-ink-400">
                                    <KeyRound className="h-4 w-4" strokeWidth={1.5} />
                                  </span>
                                  <span className="min-w-0">
                                    <Link
                                      to={`/vault/${safeId}/credentials/${c.id}`}
                                      className="block truncate font-medium text-ink-50"
                                    >
                                      {c.name}
                                    </Link>
                                    {c.description && (
                                      <span className="mt-0.5 block truncate text-xs text-ink-500">
                                        {c.description}
                                      </span>
                                    )}
                                  </span>
                                  {c.is_breakglass && (
                                    <Badge className="bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30">
                                      Break-glass
                                    </Badge>
                                  )}
                                </div>
                              </td>
                              <td className="border-b border-surface-800 px-4 py-3 font-mono text-xs text-ink-300">
                                {c.account_name || '-'}
                              </td>
                              <td className="whitespace-nowrap border-b border-surface-800 px-4 py-3 text-xs text-ink-400">
                                {c.credential_type || '-'}
                              </td>
                              <td className="whitespace-nowrap border-b border-surface-800 px-4 py-3">
                                <StatusBadge status={c.status} />
                              </td>
                              <td className="whitespace-nowrap border-b border-surface-800 px-4 py-3 text-xs">
                                {health ? (
                                  <span
                                    className={clsx(
                                      'font-medium',
                                      health.tone === 'red'
                                        ? 'text-danger'
                                        : health.tone === 'amber'
                                          ? 'text-warn'
                                          : 'text-ink-400'
                                    )}
                                  >
                                    {health.label}
                                  </span>
                                ) : (
                                  <span className="text-ink-500">
                                    {c.last_rotated_at
                                      ? `Rotated ${formatDateTime(c.last_rotated_at)}`
                                      : 'Manual only'}
                                  </span>
                                )}
                              </td>
                              <td className="border-b border-surface-800 px-2 py-3">
                                <Link
                                  to={`/vault/${safeId}/credentials/${c.id}`}
                                  aria-label={`Open ${c.name}`}
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-600 transition-colors hover:bg-surface-800 hover:text-ink-100"
                                >
                                  <ChevronRight className="h-4 w-4" strokeWidth={2} />
                                </Link>
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
                    label="credentials"
                  />
                </Card>
              )
            }
          </QueryState>
        </div>
      </div>

      <CreateFolderModal
        open={folderModalOpen}
        onClose={() => setFolderModalOpen(false)}
        safeId={safeId}
        folders={folders}
      />
      <CreateCredentialModal
        open={credentialModalOpen}
        onClose={() => setCredentialModalOpen(false)}
        safeId={safeId}
        folders={folders}
        folderId={activeFolder !== 'all' && activeFolder !== 'root' ? activeFolder : undefined}
      />
    </div>
  )
}
