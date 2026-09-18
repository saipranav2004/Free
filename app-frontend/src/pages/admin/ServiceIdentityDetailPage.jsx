import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Boxes, KeyRound, Plus, Route, Ban, Trash2, ShieldAlert } from 'lucide-react'
import {
  listServiceIdentities,
  listServiceTokens,
  listServiceGrants,
  issueServiceToken,
  revokeServiceToken,
  grantServiceScope,
  revokeServiceGrant,
  disableServiceIdentity,
} from '../../api/serviceIdentities'
import { normalizeApiError, apiErrorMessage } from '../../lib/apiError'
import { Container, ContainerHeader, PageTitle, KeyValueGrid, Stack } from '../../components/ui/layout'
import { DataTable, SkeletonGrid, Td, Th, Tr } from '../../components/ui/grid'
import { EmptyState, ErrorState, OfflineState } from '../../components/ui/states'
import { StatusDot } from '../../components/ui/bits'
import { Button } from '../../components/common/Button'
import { Field, inputClass } from '../../components/common/FormFields'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { IssuedTokenDialog } from '../../components/services/IssuedTokenDialog'
import { formatDateTime, formatRelativeToNow } from '../../lib/format'

// ---------------------------------------------------------------------------
// One service identity: what it can reach, and what it authenticates with
// ---------------------------------------------------------------------------
// Two lists, because they answer two different questions and are revoked
// independently. Tokens are "who is allowed to say they are this service";
// grants are "what this service may read once it has". Killing a token stops
// one deployment; killing a grant stops all of them reaching one path.
//
// Neither list ever carries a secret. The token's secret half exists for one
// response at mint time and is shown once by IssuedTokenDialog; the rows below
// are metadata only.

const MIN_REASON = 10

function tokenState(t) {
  if (t.revoked_at) return { tone: 'muted', label: 'Revoked' }
  if (t.expires_at && new Date(t.expires_at) <= new Date()) return { tone: 'warn', label: 'Expired' }
  return { tone: 'ok', label: 'Active' }
}

function grantState(g) {
  if (g.revoked_at) return { tone: 'muted', label: 'Revoked' }
  if (g.expires_at && new Date(g.expires_at) <= new Date()) return { tone: 'warn', label: 'Expired' }
  return { tone: 'ok', label: 'Active' }
}

export default function ServiceIdentityDetailPage() {
  const { id } = useParams()
  const queryClient = useQueryClient()

  const [issued, setIssued] = useState(null)
  const [tokenDesc, setTokenDesc] = useState('')
  const [tokenTtl, setTokenTtl] = useState('90')
  const [scope, setScope] = useState('')
  const [reason, setReason] = useState('')
  const [maxTtl, setMaxTtl] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('')
  const [confirmDisable, setConfirmDisable] = useState(false)
  const [revokeToken, setRevokeToken] = useState(null)
  const [revokeGrant, setRevokeGrant] = useState(null)

  // The list endpoint is the only one that returns the identity record, so the
  // detail view reads it from there rather than inventing a second shape.
  const identityQuery = useQuery({
    queryKey: ['admin', 'services'],
    queryFn: ({ signal }) => listServiceIdentities(signal),
    retry: false,
  })
  const identity = useMemo(
    () => (identityQuery.data || []).find((s) => s.id === id),
    [identityQuery.data, id]
  )

  const tokensQuery = useQuery({
    queryKey: ['admin', 'services', id, 'tokens'],
    queryFn: ({ signal }) => listServiceTokens(id, signal),
    retry: false,
  })
  const grantsQuery = useQuery({
    queryKey: ['admin', 'services', id, 'grants'],
    queryFn: ({ signal }) => listServiceGrants(id, signal),
    retry: false,
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'services'] })

  const mint = useMutation({
    mutationFn: () => issueServiceToken(id, { description: tokenDesc.trim(), ttlDays: Number(tokenTtl) || 90 }),
    onSuccess: (data) => {
      // Held in local state for the life of the dialog and nowhere else. It is
      // deliberately NOT put into the query cache: a cached secret would
      // survive navigation and show up in devtools long after the one moment
      // it was meant to exist for.
      setIssued(data)
      setTokenDesc('')
      refresh()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const grant = useMutation({
    mutationFn: () =>
      grantServiceScope(id, {
        scope: scope.trim(),
        reason: reason.trim(),
        maxTtlSeconds: Number(maxTtl) || 0,
        expiresInDays: Number(expiresInDays) || 0,
      }),
    onSuccess: () => {
      toast.success('Grant created', { description: `${scope.trim()} is now readable by this identity.` })
      setScope('')
      setReason('')
      setMaxTtl('')
      setExpiresInDays('')
      refresh()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const killToken = useMutation({
    mutationFn: (tokenId) => revokeServiceToken(tokenId),
    onSuccess: () => {
      toast.success('Token revoked', { description: 'Anything still presenting it is refused from now on.' })
      setRevokeToken(null)
      refresh()
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setRevokeToken(null)
    },
  })

  const killGrant = useMutation({
    mutationFn: (grantId) => revokeServiceGrant(grantId),
    onSuccess: () => {
      toast.success('Grant revoked', { description: 'The path is no longer readable by this identity.' })
      setRevokeGrant(null)
      refresh()
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setRevokeGrant(null)
    },
  })

  const disable = useMutation({
    mutationFn: () => disableServiceIdentity(id),
    onSuccess: () => {
      toast.success('Identity disabled', { description: 'Every token it holds was revoked at the same time.' })
      setConfirmDisable(false)
      refresh()
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setConfirmDisable(false)
    },
  })

  const err = identityQuery.isError ? normalizeApiError(identityQuery.error) : null
  if (err) {
    return (
      <Stack gap="lg">
        <PageTitle title="Service identity" />
        <Container>
          {err.code === 'network_error' ? (
            <OfflineState onRetry={() => identityQuery.refetch()} retrying={identityQuery.isFetching} />
          ) : (
            <ErrorState
              title="This identity did not load"
              description={err.message}
              onRetry={() => identityQuery.refetch()}
              retrying={identityQuery.isFetching}
            />
          )}
        </Container>
      </Stack>
    )
  }

  if (identityQuery.isSuccess && !identity) {
    return (
      <Stack gap="lg">
        <PageTitle title="Service identity" />
        <Container>
          <EmptyState
            icon={Boxes}
            title="No such service identity"
            description="It may have been removed, or the link may be out of date."
          />
        </Container>
      </Stack>
    )
  }

  const active = identity?.status === 'active'
  const tokens = tokensQuery.data || []
  const grants = grantsQuery.data || []

  return (
    <Stack gap="lg">
      <PageTitle
        title={identity?.name || 'Service identity'}
        description={identity?.description || 'A machine principal that reads secrets without a console session.'}
        actions={
          active ? (
            <Button variant="secondary" size="sm" icon={Ban} onClick={() => setConfirmDisable(true)}>
              Disable identity
            </Button>
          ) : null
        }
      />

      {!active && identity && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-50/60 px-3.5 py-3 dark:bg-amber-950/15">
          <ShieldAlert
            className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400"
            strokeWidth={1.9}
          />
          <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300/90">
            This identity is disabled. Every token it held was revoked, and no new token can be
            minted for it, so nothing can authenticate as it.
          </p>
        </div>
      )}

      <Container>
        <KeyValueGrid
          columns={4}
          items={[
            { label: 'Environment', value: identity?.environment || 'Not set' },
            {
              label: 'Status',
              value: (
                <StatusDot tone={active ? 'ok' : 'muted'} label={active ? 'Active' : 'Disabled'} />
              ),
            },
            {
              label: 'Reads per minute',
              value:
                identity?.max_secrets_per_minute > 0
                  ? String(identity.max_secrets_per_minute)
                  : 'Server default',
              hint: 'How fast a leaked token could drain the vault before it is noticed.',
            },
            { label: 'Registered', value: identity ? formatDateTime(identity.created_at) : '-' },
          ]}
        />
      </Container>

      {/* ── Grants ───────────────────────────────────────────────────────── */}
      <Container
        padded={false}
        header={
          <ContainerHeader
            title="What it can read"
            counter={grantsQuery.isSuccess ? grants.length : undefined}
            description="Path scopes, not individual credentials. A scope covers a subtree, so adding a credential inside it does not mean editing this list."
          />
        }
      >
        <div className="border-b border-line-soft px-4 py-4 sm:px-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]">
            <Field
              label="Scope"
              htmlFor="grant-scope"
              hint="prod-db/* is the direct children. prod-db/** crosses folders. A bare * is every secret and is root only."
            >
              <input
                id="grant-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                disabled={!active}
                placeholder="prod-db/postgres/*"
                className={inputClass(false)}
              />
            </Field>
            <Field label="Reason" htmlFor="grant-reason" hint="Recorded on the grant and in the audit trail.">
              <input
                id="grant-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={!active}
                placeholder="Why this workload needs this path"
                className={inputClass(false)}
              />
            </Field>
            <div className="flex items-end">
              <Button
                variant="primary"
                icon={Plus}
                loading={grant.isPending}
                disabled={!active || scope.trim().length === 0 || reason.trim().length < MIN_REASON}
                onClick={() => grant.mutate()}
              >
                Add grant
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:max-w-md">
            <Field
              label="Cache ceiling (seconds)"
              htmlFor="grant-ttl"
              hint="How long a client may hold a secret matched by this scope. Empty uses the server default."
            >
              <input
                id="grant-ttl"
                type="number"
                min="0"
                value={maxTtl}
                onChange={(e) => setMaxTtl(e.target.value)}
                disabled={!active}
                placeholder="Server default"
                className={inputClass(false)}
              />
            </Field>
            <Field label="Expires in (days)" htmlFor="grant-exp" hint="Empty means it does not expire on its own.">
              <input
                id="grant-exp"
                type="number"
                min="0"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                disabled={!active}
                placeholder="Never"
                className={inputClass(false)}
              />
            </Field>
          </div>
        </div>

        {grantsQuery.isLoading ? (
          <DataTable minWidth="48rem">
            <tbody>
              <SkeletonGrid rows={3} colSpan={5} />
            </tbody>
          </DataTable>
        ) : grantsQuery.isError ? (
          <ErrorState
            title="Grants did not load"
            description={normalizeApiError(grantsQuery.error).message}
            onRetry={() => grantsQuery.refetch()}
            retrying={grantsQuery.isFetching}
          />
        ) : grants.length === 0 ? (
          <EmptyState
            icon={Route}
            title="No grants yet"
            description="Until a scope is granted, this identity authenticates successfully and can read nothing."
          />
        ) : (
          <DataTable minWidth="48rem" label="Path grants for this service identity">
            <thead>
              <tr>
                <Th>Scope</Th>
                <Th>Reason</Th>
                <Th>Cache ceiling</Th>
                <Th>Status</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => {
                const st = grantState(g)
                return (
                  <Tr key={g.id}>
                    <Td>
                      <code className="font-mono text-xs text-primary">{g.scope}</code>
                      {g.expires_at && (
                        <span className="mt-0.5 block text-xs text-tertiary">
                          Expires {formatRelativeToNow(g.expires_at)}
                        </span>
                      )}
                    </Td>
                    <Td muted>{g.reason || '-'}</Td>
                    <Td muted>{g.max_ttl_seconds > 0 ? `${g.max_ttl_seconds}s` : 'Server default'}</Td>
                    <Td>
                      <StatusDot tone={st.tone} label={st.label} />
                    </Td>
                    <Td align="right">
                      {st.label === 'Active' && (
                        <Button
                          variant="ghost"
                          size="xs"
                          icon={Trash2}
                          onClick={() => setRevokeGrant(g)}
                        >
                          Revoke
                        </Button>
                      )}
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        )}
      </Container>

      {/* ── Tokens ───────────────────────────────────────────────────────── */}
      <Container
        padded={false}
        header={
          <ContainerHeader
            title="Tokens"
            counter={tokensQuery.isSuccess ? tokens.length : undefined}
            description="More than one may be live at a time. That overlap is what makes rotation a rolling deploy: mint the new one, roll the fleet, revoke the old one."
          />
        }
      >
        <div className="border-b border-line-soft px-4 py-4 sm:px-5">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
            <Field label="Description" htmlFor="token-desc" hint="Where this token is going, so it can be found and revoked later.">
              <input
                id="token-desc"
                value={tokenDesc}
                onChange={(e) => setTokenDesc(e.target.value)}
                disabled={!active}
                placeholder="billing-api pod, eu-west-1"
                className={inputClass(false)}
              />
            </Field>
            <Field label="Valid for (days)" htmlFor="token-ttl">
              <input
                id="token-ttl"
                type="number"
                min="1"
                value={tokenTtl}
                onChange={(e) => setTokenTtl(e.target.value)}
                disabled={!active}
                className={inputClass(false)}
              />
            </Field>
            <div className="flex items-end">
              <Button
                variant="primary"
                icon={KeyRound}
                loading={mint.isPending}
                disabled={!active}
                onClick={() => mint.mutate()}
              >
                Mint token
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-tertiary">
            Minting asks for your second factor. The token is shown once and cannot be recovered.
          </p>
        </div>

        {tokensQuery.isLoading ? (
          <DataTable minWidth="48rem">
            <tbody>
              <SkeletonGrid rows={3} colSpan={5} />
            </tbody>
          </DataTable>
        ) : tokensQuery.isError ? (
          <ErrorState
            title="Tokens did not load"
            description={normalizeApiError(tokensQuery.error).message}
            onRetry={() => tokensQuery.refetch()}
            retrying={tokensQuery.isFetching}
          />
        ) : tokens.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No tokens issued"
            description="This identity cannot authenticate until one is minted."
          />
        ) : (
          <DataTable minWidth="48rem" label="Tokens for this service identity">
            <thead>
              <tr>
                <Th>Token</Th>
                <Th>Description</Th>
                <Th>Last used</Th>
                <Th>Status</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const st = tokenState(t)
                return (
                  <Tr key={t.token_id}>
                    <Td>
                      <code className="font-mono text-xs text-primary">{t.token_id}</code>
                      {t.expires_at && (
                        <span className="mt-0.5 block text-xs text-tertiary">
                          Expires {formatRelativeToNow(t.expires_at)}
                        </span>
                      )}
                    </Td>
                    <Td muted>{t.description || '-'}</Td>
                    <Td muted>
                      {t.last_used_at ? formatRelativeToNow(t.last_used_at) : 'Never used'}
                    </Td>
                    <Td>
                      <StatusDot tone={st.tone} label={st.label} />
                    </Td>
                    <Td align="right">
                      {!t.revoked_at && (
                        <Button
                          variant="ghost"
                          size="xs"
                          icon={Trash2}
                          onClick={() => setRevokeToken(t)}
                        >
                          Revoke
                        </Button>
                      )}
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        )}
      </Container>

      <IssuedTokenDialog open={!!issued} issued={issued} onClose={() => setIssued(null)} />

      <ConfirmDialog
        open={!!revokeToken}
        title="Revoke this token?"
        description={`Anything still presenting ${revokeToken?.token_id} will be refused immediately. Other tokens for this identity keep working.`}
        confirmLabel="Revoke token"
        destructive
        isLoading={killToken.isPending}
        onConfirm={() => killToken.mutate(revokeToken.token_id)}
        onCancel={() => setRevokeToken(null)}
      />

      <ConfirmDialog
        open={!!revokeGrant}
        title="Revoke this grant?"
        description={`This identity will stop being able to read ${revokeGrant?.scope}. Clients already holding a cached value keep it until their cache ceiling expires.`}
        confirmLabel="Revoke grant"
        destructive
        isLoading={killGrant.isPending}
        onConfirm={() => killGrant.mutate(revokeGrant.id)}
        onCancel={() => setRevokeGrant(null)}
      />

      <ConfirmDialog
        open={confirmDisable}
        title="Disable this identity?"
        description="Every token it holds is revoked at the same time, and no new token can be minted for it. Its grants are kept, so re-enabling would need new tokens but not new grants."
        confirmLabel="Disable identity"
        destructive
        isLoading={disable.isPending}
        onConfirm={() => disable.mutate()}
        onCancel={() => setConfirmDisable(false)}
      />
    </Stack>
  )
}
