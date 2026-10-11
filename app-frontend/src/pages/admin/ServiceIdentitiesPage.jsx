import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Boxes, Plus } from 'lucide-react'
import clsx from 'clsx'
import { listServiceIdentities } from '../../api/serviceIdentities'
import { normalizeApiError } from '../../lib/apiError'
import { Container, PageTitle, Stack } from '../../components/ui/layout'
import { DataTable, SkeletonGrid, Td, Th, Tr, Trunc } from '../../components/ui/grid'
import { EmptyState, ErrorState, NoMatchState, OfflineState } from '../../components/ui/states'
import { StatusDot } from '../../components/ui/bits'
import { Button } from '../../components/common/Button'
import { ExportMenu, RefreshControl } from '../../components/ui/chrome'
import { exportRowsToCsv, exportRowsToJson } from '../../lib/exportRows'
import { CreateServiceIdentityModal } from '../../components/services/CreateServiceIdentityModal'
import { formatDateTime, formatRelativeToNow } from '../../lib/format'

// ---------------------------------------------------------------------------
// Service identities
// ---------------------------------------------------------------------------
// The machine half of the vault. Everything else in the Admin Center is about
// people; this is the list of processes that read secrets on their own.
//
// It used to be a plain list of Environment, Status, Reads per minute and
// Created, which together answered "does this exist and is it switched on".
// Nobody opens this page to find that out. The three questions an operator
// actually arrives with are what can it reach, is anything still using it, and
// is a token about to expire under a job nobody is watching, and all three
// were one click down on the detail page. They are columns now, off the
// rollup the list endpoint returns (services.ServiceIdentitySummary).
//
// Reads per minute went the other way. It is a rate limit, a thing you set
// once and look at when you are changing it, and it was taking a column on the
// screen you scan during an incident. It lives on the detail page.

const EXPIRY_SOON_DAYS = 14

// Everything the page decides about one row, worked out once so the cells, the
// row tone and the posture strip can never disagree with each other.
function assess(s, now) {
  const expiresAt = s.next_token_expiry ? new Date(s.next_token_expiry) : null
  const daysToExpiry =
    expiresAt && !Number.isNaN(expiresAt.getTime())
      ? Math.floor((expiresAt.getTime() - now) / 86400000)
      : null

  const wildcard = s.wildcard_scope === true
  // A live token that never expires is the quieter half of the same problem a
  // wildcard is: nothing will ever take it away on its own.
  const immortal = s.never_expires === true && (s.live_tokens || 0) > 0
  const expiringSoon = daysToExpiry !== null && daysToExpiry <= EXPIRY_SOON_DAYS
  const neverUsed = !s.last_used_at

  return {
    wildcard,
    immortal,
    expiringSoon,
    daysToExpiry,
    neverUsed,
    // Danger is standing, unbounded reach. A deadline is a warning: it is
    // going to happen, and it has not happened yet.
    tone: wildcard || immortal ? 'danger' : expiringSoon ? 'warn' : undefined,
  }
}

// Metadata only. There is no secret on a service identity row to leak into a
// file: tokens are shown once at mint time and never returned again.
const CSV_COLUMNS = [
  { key: 'name', label: 'Identity' },
  { key: 'description', label: 'Description' },
  { key: 'environment', label: 'Environment' },
  { key: 'status', label: 'Status' },
  { key: 'grant_count', label: 'Live grants' },
  { key: 'widest_scope', label: 'Widest scope', value: (s) => s.widest_scope || '' },
  { key: 'wildcard_scope', label: 'Reads every path', value: (s) => (s.wildcard_scope ? 'yes' : 'no') },
  { key: 'live_tokens', label: 'Live tokens' },
  {
    key: 'next_token_expiry',
    label: 'Next token expiry',
    value: (s) => (s.never_expires ? 'never' : s.next_token_expiry || ''),
  },
  { key: 'last_used_at', label: 'Last read', value: (s) => s.last_used_at || 'never' },
  {
    key: 'max_secrets_per_minute',
    label: 'Reads per minute',
    value: (s) => (s.max_secrets_per_minute > 0 ? s.max_secrets_per_minute : 'Server default'),
  },
  { key: 'owner_id', label: 'Owner' },
  { key: 'created_at', label: 'Registered', value: (s) => s.created_at || '' },
]

// One posture fact. Quiet until it has something to say, and it says a number
// and a consequence rather than a metric.
function PostureCard({ tone, count, headline, detail, active, onClick }) {
  const dot = { danger: 'bg-danger', warn: 'bg-warn', muted: 'bg-transparent ring-1 ring-inset ring-line-strong' }[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'flex items-center gap-3 rounded-xl border bg-surface px-4 py-3 text-left shadow-card transition-colors',
        active ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'
      )}
    >
      <span className={clsx('h-2 w-2 flex-none rounded-full', dot)} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-primary">
          {count} {headline}
        </span>
        <span className="mt-0.5 block truncate text-xs text-tertiary">{detail}</span>
      </span>
    </button>
  )
}

export default function ServiceIdentitiesPage() {
  const [createOpen, setCreateOpen] = useState(false)
  const [filter, setFilter] = useState(null)

  const query = useQuery({
    queryKey: ['admin', 'services'],
    queryFn: ({ signal }) => listServiceIdentities(signal),
    retry: false,
  })

  const identities = useMemo(() => query.data || [], [query.data])
  const err = query.isError ? normalizeApiError(query.error) : null

  // `now` is pinned to the fetch rather than read per render, so every row and
  // every count on one screen is measured from the same instant.
  const rows = useMemo(() => {
    const now = query.dataUpdatedAt || Date.now()
    return identities.map((s) => ({ ...s, risk: assess(s, now) }))
  }, [identities, query.dataUpdatedAt])

  const posture = useMemo(
    () =>
      [
        {
          key: 'reach',
          tone: 'danger',
          count: rows.filter((r) => r.risk.wildcard || r.risk.immortal).length,
          headline: 'unbounded',
          detail: 'Reads every path, or holds a token with no expiry',
          match: (r) => r.risk.wildcard || r.risk.immortal,
        },
        {
          key: 'expiring',
          tone: 'warn',
          count: rows.filter((r) => r.risk.expiringSoon).length,
          headline: `expiring within ${EXPIRY_SOON_DAYS} days`,
          detail: 'A job stops working when this lapses',
          match: (r) => r.risk.expiringSoon,
        },
        {
          key: 'unused',
          tone: 'muted',
          count: rows.filter((r) => r.risk.neverUsed).length,
          headline: 'never used',
          detail: 'Registered, but has not read a secret yet',
          match: (r) => r.risk.neverUsed,
        },
      ].filter((f) => f.count > 0),
    [rows]
  )

  const active = posture.find((f) => f.key === filter) || null
  const shown = active ? rows.filter(active.match) : rows

  return (
    <Stack gap="lg">
      <PageTitle
        title="Service Identities"
        counter={query.isSuccess ? identities.length : undefined}
        description="Applications and jobs that read secrets without a console session. Each holds its own tokens and its own path grants."
        actions={
          <div className="flex items-center gap-2">
            {/* Same toolbar as every other list: export what is on screen, and
                a refresh that says when the data was last read. */}
            <ExportMenu
              count={shown.length}
              disabled={shown.length === 0}
              onExportCsv={() => exportRowsToCsv(shown, CSV_COLUMNS, 'service-identities')}
              onExportJson={() => exportRowsToJson(shown, CSV_COLUMNS, 'service-identities')}
            />
            <RefreshControl
              onRefresh={() => query.refetch()}
              isFetching={query.isFetching}
              updatedAt={query.dataUpdatedAt}
            />
            <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
              Register identity
            </Button>
          </div>
        }
      />

      {/* Only what is true. A tenant with nothing to answer for gets no strip
          at all rather than a row of confident zeros. */}
      {posture.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {posture.map((f) => (
            <PostureCard
              key={f.key}
              tone={f.tone}
              count={f.count}
              headline={f.headline}
              detail={f.detail}
              active={filter === f.key}
              onClick={() => setFilter(filter === f.key ? null : f.key)}
            />
          ))}
        </div>
      )}

      <Container padded={false}>
        {query.isLoading ? (
          <DataTable minWidth="58rem"><tbody><SkeletonGrid rows={5} colSpan={5} /></tbody></DataTable>
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
        ) : shown.length === 0 ? (
          <NoMatchState
            title="Nothing matches that filter"
            description="No service identity is in that state right now."
            onClear={() => setFilter(null)}
            clearLabel="Show all"
          />
        ) : (
          <DataTable minWidth="58rem" label="Service identities">
            <thead>
              <tr>
                <Th width="w-[22rem]">Identity</Th>
                <Th>What it can read</Th>
                <Th>Tokens</Th>
                <Th>Last read</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <Tr key={s.id} to={`/admin/services/${s.id}`} tone={s.risk.tone}>
                  <Td>
                    <Link
                      to={`/admin/services/${s.id}`}
                      className="font-mono text-[0.8125rem] font-medium text-primary"
                    >
                      {s.name}
                    </Link>
                    <span className="mt-0.5 block text-xs text-tertiary">
                      <Trunc value={s.description || s.environment || 'No description'} />
                    </span>
                  </Td>

                  <Td>
                    {s.grant_count > 0 ? (
                      <>
                        <span
                          className={clsx(
                            'inline-flex h-[1.375rem] items-center rounded-md px-2 text-xs font-medium',
                            s.risk.wildcard ? 'bg-danger-soft text-danger' : 'bg-subtle text-secondary'
                          )}
                        >
                          {s.risk.wildcard
                            ? 'Every path'
                            : `${s.grant_count} ${s.grant_count === 1 ? 'path' : 'paths'}`}
                        </span>
                        {/* ONE grant shows its path. Several do not: printing
                            the widest of three under a "3 paths" pill reads as
                            though it were the only one, and the honest summary
                            of several paths is the count. The rest are one
                            click away on the identity. */}
                        {s.grant_count === 1 && s.widest_scope && !s.risk.wildcard && (
                          <span className="mt-0.5 block font-mono text-xs text-tertiary">
                            <Trunc value={s.widest_scope} mono />
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-sm text-tertiary">Nothing granted</span>
                    )}
                  </Td>

                  <Td>
                    <span className="text-sm text-primary">
                      {s.live_tokens > 0 ? `${s.live_tokens} live` : 'None issued'}
                    </span>
                    {s.live_tokens > 0 && (
                      <span
                        className={clsx(
                          'mt-0.5 block text-xs',
                          s.risk.immortal
                            ? 'font-medium text-danger'
                            : s.risk.expiringSoon
                              ? 'font-medium text-warn'
                              : 'text-tertiary'
                        )}
                      >
                        {s.risk.immortal
                          ? 'no expiry set'
                          : s.next_token_expiry
                            ? `expires ${formatRelativeToNow(s.next_token_expiry)}`
                            : 'no expiry set'}
                      </span>
                    )}
                  </Td>

                  <Td muted>
                    {s.last_used_at ? (
                      <span title={formatDateTime(s.last_used_at)}>
                        {formatRelativeToNow(s.last_used_at)}
                      </span>
                    ) : (
                      <span className="text-tertiary">Never</span>
                    )}
                  </Td>

                  <Td>
                    <StatusDot
                      tone={s.status === 'active' ? 'ok' : 'muted'}
                      label={s.status === 'active' ? 'Active' : 'Disabled'}
                    />
                  </Td>
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
