import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Plus, Vault as VaultIcon } from 'lucide-react'
import { listSafes } from '../../api/vault'
import { normalizeApiError } from '../../lib/apiError'
import { Container, PageTitle, Stack } from '../../components/ui/layout'
import { DataTable, SkeletonGrid, SortTh, Td, Th, Tr, Trunc } from '../../components/ui/grid'
import { Meta } from '../../components/ui/bits'
import {
  CommandBar,
  Pagination,
  PreferencesMenu,
  RefreshControl,
  SearchField,
} from '../../components/ui/chrome'
import { DeniedState, EmptyState, ErrorState, NoMatchState, OfflineState } from '../../components/ui/states'
import { Button } from '../../components/common/Button'
import { CreateSafeModal } from '../../components/vault/CreateSafeModal'
import { useTableState } from '../../hooks/useTableState'
import { formatDate, formatRelativeToNow } from '../../lib/format'

// ---------------------------------------------------------------------------
// Vault, safes
// ---------------------------------------------------------------------------
// A safe is a container, and there are usually a handful of them, so the
// question this page answers is "which safe, and how much is in it".
//
// THE CARD VIEW IS GONE. Cards were the default: four bordered tiles with a
// name, a description and a count each. That is a table with extra chrome and
// a worse scan line, and it stopped being defensible the moment the count
// mattered, because you cannot compare numbers that are not in a column. The
// same information now reads down five aligned columns.
//
// COUNTS AND RETENTION ARE RIGHT ALIGNED AND TABULAR, because they are
// quantities and the whole point of putting them in a column is comparing
// them vertically. Created stays left aligned: a date is qualitative.
//
// listSafes() returns the whole collection and takes no parameters, so search,
// sort and paging are client side by necessity.

const SAFE_COLUMNS = [
  { key: 'name', label: 'Safe', required: true },
  { key: 'description', label: 'Description' },
  { key: 'credential_count', label: 'Credentials' },
  { key: 'retention_days', label: 'Retention' },
  { key: 'created_at', label: 'Created' },
]

export default function SafesListPage() {
  const [createOpen, setCreateOpen] = useState(false)

  const safesQuery = useQuery({
    queryKey: ['vault', 'safes'],
    queryFn: ({ signal }) => listSafes(signal),
  })

  const safes = useMemo(() => safesQuery.data || [], [safesQuery.data])

  const table = useTableState({
    rows: safes,
    storageKey: 'safes',
    // View state in the address bar, so a filtered list is something you can
    // send to someone. See useTableState.
    urlSync: true,
    rowId: (s) => s.id,
    initialSort: { key: 'name', dir: 'asc' },
    initialPageSize: 25,
    searchFields: ['name', 'description'],
  })

  const err = safesQuery.isError ? normalizeApiError(safesQuery.error) : null
  const show = (key) => !table.visibleColumns || table.visibleColumns.includes(key)

  return (
    <Stack gap="lg">
      <PageTitle
        title="Vault"
        counter={safesQuery.isSuccess ? safes.length : undefined}
        description="Safes hold credentials. Revealing one is recorded against your identity, with the reason you give."
      />

      <Stack gap="sm">
        <CommandBar
          primary={
            <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
              Create safe
            </Button>
          }
          summary={
            safesQuery.isSuccess && table.total !== safes.length
              ? `${table.total} of ${safes.length} shown`
              : undefined
          }
        >
          <RefreshControl
            onRefresh={() => safesQuery.refetch()}
            isFetching={safesQuery.isFetching}
            updatedAt={safesQuery.dataUpdatedAt}
          />
          <PreferencesMenu
            columns={SAFE_COLUMNS}
            visible={table.visibleColumns}
            onVisibleChange={table.setVisibleColumns}
            pageSize={table.pageSize}
            onPageSize={table.setPageSize}
          />
        </CommandBar>

        <SearchField
          value={table.query}
          onChange={table.setQuery}
          placeholder="Search safes by name or description"
          label="Search safes"
        />
      </Stack>

      <Container padded={false}>
        {safesQuery.isLoading ? (
          <table className="w-full">
            <tbody>
              <SkeletonGrid colSpan={SAFE_COLUMNS.length} rows={5} />
            </tbody>
          </table>
        ) : err ? (
          err.status === 403 ? (
            <DeniedState description={err.message} />
          ) : err.code === 'network_error' ? (
            <OfflineState onRetry={() => safesQuery.refetch()} retrying={safesQuery.isFetching} />
          ) : (
            <ErrorState
              description={err.message}
              onRetry={() => safesQuery.refetch()}
              retrying={safesQuery.isFetching}
            />
          )
        ) : safes.length === 0 ? (
          <EmptyState
            icon={VaultIcon}
            title="No safes yet"
            description="Create a safe to start storing credentials under a retention policy."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
                Create the first safe
              </Button>
            }
          />
        ) : table.total === 0 ? (
          <NoMatchState
            description="No safe matches that search."
            onClear={() => table.setQuery('')}
            clearLabel="Clear search"
          />
        ) : (
          <>
            <DataTable minWidth="52rem" label="Safes">
              <colgroup>
                {show('name') && <col className="w-[16rem] min-w-[12rem]" />}
                {show('description') && <col className="w-auto" />}
                {show('credential_count') && <col className="w-[8rem]" />}
                {show('retention_days') && <col className="w-[8rem]" />}
                {show('created_at') && <col className="w-[10rem]" />}
              </colgroup>

              <thead>
                <tr>
                  {show('name') && (
                    <SortTh columnKey="name" sort={table.sort} onSort={table.toggleSort} sticky edge>
                      Safe
                    </SortTh>
                  )}
                  {show('description') && <Th>Description</Th>}
                  {show('credential_count') && (
                    <SortTh
                      columnKey="credential_count"
                      sort={table.sort}
                      onSort={table.toggleSort}
                      align="right"
                    >
                      Credentials
                    </SortTh>
                  )}
                  {show('retention_days') && (
                    <SortTh
                      columnKey="retention_days"
                      sort={table.sort}
                      onSort={table.toggleSort}
                      align="right"
                    >
                      Retention
                    </SortTh>
                  )}
                  {show('created_at') && (
                    <SortTh columnKey="created_at" sort={table.sort} onSort={table.toggleSort}>
                      Created
                    </SortTh>
                  )}
                </tr>
              </thead>

              <tbody>
                {table.pageRows.map((s) => (
                  <Tr key={s.id}>
                    {show('name') && (
                      <Td sticky edge>
                        <div className="flex min-w-0 items-center gap-2">
                          <Link
                            to={`/vault/${s.id}`}
                            title={s.name}
                            className="min-w-0 truncate text-sm font-medium text-primary transition-colors hover:text-accent hover:underline"
                          >
                            {s.name}
                          </Link>
                          {s.is_default && <Meta>default</Meta>}
                        </div>
                      </Td>
                    )}
                    {show('description') && (
                      <Td>
                        <Trunc value={s.description} muted />
                      </Td>
                    )}
                    {show('credential_count') && (
                      <Td align="right">
                        <span className="text-sm tabular text-primary">{s.credential_count ?? '-'}</span>
                      </Td>
                    )}
                    {show('retention_days') && (
                      <Td align="right">
                        <span className="text-sm tabular text-secondary">
                          {s.retention_days ? `${s.retention_days} d` : '-'}
                        </span>
                      </Td>
                    )}
                    {show('created_at') && (
                      <Td>
                        <span className="text-sm text-secondary" title={formatDate(s.created_at)}>
                          {formatRelativeToNow(s.created_at)}
                        </span>
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </DataTable>

            <Pagination
              page={table.page}
              pageSize={table.pageSize}
              total={table.total}
              totalPages={table.totalPages}
              onPageChange={table.setPage}
              label="safes"
            />
          </>
        )}
      </Container>

      <CreateSafeModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </Stack>
  )
}
