import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Boxes, Plus, RefreshCw } from 'lucide-react'
import { listServiceIdentities } from '../../api/serviceIdentities'
import { normalizeApiError } from '../../lib/apiError'
import { Container, PageTitle, Stack } from '../../components/ui/layout'
import { DataTable, SkeletonGrid, Td, Th, Tr, Trunc } from '../../components/ui/grid'
import { EmptyState, ErrorState, OfflineState } from '../../components/ui/states'
import { StatusDot } from '../../components/ui/bits'
import { Button } from '../../components/common/Button'
import { CreateServiceIdentityModal } from '../../components/services/CreateServiceIdentityModal'
import { formatRelativeToNow } from '../../lib/format'

// ---------------------------------------------------------------------------
// Service identities
// ---------------------------------------------------------------------------
// The machine half of the vault. Everything else in the Admin Center is about
// people; this is the list of processes that read secrets on their own, and
// the place their tokens and grants are issued and taken away.
//
// It is a plain list on purpose. The interesting surface is one level down,
// per identity: what it can reach, which tokens are live, when each was last
// used. A row here answers "does this exist and is it on".

export default function ServiceIdentitiesPage() {
  const [createOpen, setCreateOpen] = useState(false)

  const query = useQuery({
    queryKey: ['admin', 'services'],
    queryFn: ({ signal }) => listServiceIdentities(signal),
    retry: false,
  })

  const identities = useMemo(() => query.data || [], [query.data])
  const err = query.isError ? normalizeApiError(query.error) : null

  return (
    <Stack gap="lg">
      <PageTitle
        title="Service Identities"
        counter={query.isSuccess ? identities.length : undefined}
        description="Applications and jobs that read secrets without a console session. Each holds its own tokens and its own path grants."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={query.isFetching}
              onClick={() => query.refetch()}
            >
              Refresh
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
              Register identity
            </Button>
          </div>
        }
      />

      <Container padded={false}>
        {query.isLoading ? (
          <DataTable minWidth="52rem"><tbody><SkeletonGrid rows={5} colSpan={5} /></tbody></DataTable>
        ) : err ? (
          // Told apart, because they need different actions: a server that is
          // not there is not the same problem as a server that refused.
          err.code === 'network_error' ? (
            <OfflineState onRetry={() => query.refetch()} retrying={query.isFetching} />
          ) : (
            <ErrorState
              title="Service identities did not load"
              description={err.message}
              onRetry={() => query.refetch()}
              retrying={query.isFetching}
            />
          )
        ) : identities.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="No service identities yet"
            description="Register one for each workload that needs to read a secret on its own. It starts with no token and no access, so creating one grants nothing."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
                Register identity
              </Button>
            }
          />
        ) : (
          <DataTable minWidth="52rem" label="Service identities">
            <thead>
              <tr>
                <Th>Identity</Th>
                <Th>Environment</Th>
                <Th>Status</Th>
                <Th>Reads per minute</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {identities.map((s) => (
                <Tr key={s.id} to={`/admin/services/${s.id}`}>
                  <Td>
                    <Link to={`/admin/services/${s.id}`} className="font-medium text-primary">
                      {s.name}
                    </Link>
                    {s.description && (
                      <span className="mt-0.5 block text-xs text-tertiary">
                        <Trunc value={s.description} />
                      </span>
                    )}
                  </Td>
                  <Td muted>{s.environment || '-'}</Td>
                  <Td>
                    <StatusDot
                      tone={s.status === 'active' ? 'ok' : 'muted'}
                      label={s.status === 'active' ? 'Active' : 'Disabled'}
                    />
                  </Td>
                  <Td muted>
                    {s.max_secrets_per_minute > 0 ? s.max_secrets_per_minute : 'Server default'}
                  </Td>
                  <Td muted>{formatRelativeToNow(s.created_at)}</Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Container>

      <CreateServiceIdentityModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </Stack>
  )
}
