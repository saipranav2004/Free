import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Ban, Boxes, CheckCircle2, Clock, ExternalLink, Link2, Pencil, Plus,
  RefreshCw, RotateCcw, ShieldCheck, Tag, Unlink, Users,
} from 'lucide-react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { useToast } from '../../../context/ToastContext.jsx';
import { useResource } from '../../../hooks/useResource.js';
import { pbacApi } from '../../../lib/api/pbac.js';
import { identityApi } from '../../../lib/api/identity.js';
import { integrationApi } from '../../../lib/api/integration.js';
import { PageHeader } from '../../../components/common/PageHeader.jsx';
import {
  Badge, Button, EmptyState, IconButton, Panel, SearchInput, Spinner, StatusBadge,
  SummaryBar, Tabs, Toolbar,
} from '../../../components/ui/primitives.jsx';
import { DataTable } from '../../../components/ui/DataTable.jsx';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog.jsx';
import { PROVIDERS, detectProvider } from '../../../utils/providers.js';
import { extractList, formatDateTime, formatRelative } from '../../../utils/format.js';
import {
  isTokenExpired, lastTouched, mappingId, mappingStatus, readMappings, scopeList,
} from '../../../utils/integrations.js';
import {
  ConnectionHero, DetailRow, FirstRunPanel, LinkedUser, MappingFormModal, MappingRecordModal,
  MappingStatus, ScopeChips,
} from './parts.jsx';

/**
 * GithubResourcePage — the GitHub external-identity mapping detail view.
 *
 * Reached from the Resources registry at
 *   /identity/resources/:resourceId/github
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PAGE IS
 * ═══════════════════════════════════════════════════════════════════════════
 * The registry row answers "is GitHub a protected resource here?". It cannot
 * answer the question an operator actually arrives with: "WHO on GitHub is WHO
 * in this tenant?". That is the /api/v1/integrations surface, and this page is
 * its console.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * API CONTRACT (used exactly as specified — see lib/api/integration.js)
 * ═══════════════════════════════════════════════════════════════════════════
 *   GET    /api/v1/integrations?provider=github   → list every mapping
 *   POST   /api/v1/integrations                   → { user_id, provider, external_id }
 *   GET    /api/v1/integrations/<id>              → the authoritative record
 *   PUT    /api/v1/integrations/<id>              → status | scopes | metadata |
 *                                                   token_expires_at
 *   DELETE /api/v1/integrations/<id>              → deactivate (status=DISABLED)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LAYOUT — WHY IT CHANGED
 * ═══════════════════════════════════════════════════════════════════════════
 * The first version opened a brand-new connection with a row of four zeroed
 * KPI tiles above an empty table. That is the best-documented mistake in
 * dashboard design: on a fresh account the tiles carry no information, fill the
 * most valuable space on the screen, and read as though something is broken.
 * Mature consoles treat zero-data as the ONBOARDING surface.
 *
 * So the page now has two distinct states:
 *
 *   FIRST RUN (no mappings, no error)
 *     Connection hero → guided panel: why it is empty, what will appear here,
 *     and exactly ONE action. No summary band, no toolbar, no empty table.
 *
 *   IN USE (at least one mapping)
 *     Connection hero → facet band → toolbar → table. The facets filter the
 *     list they count, so the numbers and the rows can never disagree.
 *
 * Connection metadata moved behind a "Connection" tab. It is reference material
 * an operator consults occasionally; it was previously competing for attention
 * with the work itself on every visit.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * OTHER DESIGN RULES HELD HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *  · EXPIRY IS A WARNING, NOT A STATUS. The backend owns `status`; an elapsed
 *    `token_expires_at` is its own amber marker and its own facet. The UI never
 *    renders a lifecycle value the API did not return.
 *  · REVOKE, DON'T DELETE. DELETE deactivates, so a wrong link is recoverable.
 *  · ONE DATASET. Summary, search, facets and table all derive from a single
 *    `mappings` array, so one reload after a mutation moves every figure.
 *  · ONE DIRECTORY READ. The user list is fetched here ONCE and handed to the
 *    table AND the create dialog. The dialog previously used a picker that
 *    fetched its own copy, so opening it fired a second identical request.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE RESOURCE IS READ FROM THE LIST
 * ═══════════════════════════════════════════════════════════════════════════
 * `resourceEndpoints.detail(id)` is documented in lib/endpoints.js only as the
 * DELETE target — no GET is confirmed on the running backend. Rather than call
 * a route that may not be registered, the record is resolved out of
 * GET /api/v1/resources, which is confirmed and is the same source the list
 * page renders. `location.state` paints it instantly on in-app navigation; a
 * deep link or a hard refresh simply waits for the list.
 */

const PROVIDER_ID = 'github';

const FACETS = {
  all: () => true,
  ACTIVE: (m) => mappingStatus(m) === 'ACTIVE',
  DISABLED: (m) => mappingStatus(m) === 'DISABLED',
  expired: (m) => isTokenExpired(m),
};

export default function GithubResourcePage() {
  const { resourceId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, accountId } = useAuth();

  const provider = PROVIDERS[PROVIDER_ID];
  const ProviderIcon = provider.icon;
  const currentUserId = user?.user_id || user?.id || user?.sub || null;

  const [tab, setTab] = useState('mappings');
  const [search, setSearch] = useState('');
  const [facet, setFacet] = useState('all');
  const [busy, setBusy] = useState(false);
  const [formMode, setFormMode] = useState(null); // 'create' | 'edit' | null
  const [editing, setEditing] = useState(null);
  const [recordOf, setRecordOf] = useState(null);
  const [deactivateTarget, setDeactivateTarget] = useState(null);

  /* ── Data ────────────────────────────────────────────────────────────────
     Three independent reads, all started on mount. The mapping list is keyed
     on the provider from the route, so it does not wait on the registry. */
  const resources = useResource(() => pbacApi.listResources(), []);
  const mappings = useResource(
    () => integrationApi.mappings.list({ provider: PROVIDER_ID }),
    []
  );
  /* The directory turns a UUID into a name, and seeds the create dialog's
     picker. It is an enhancement, never a gate: an operator who cannot read it
     still sees every mapping and can still map their own identity. */
  const users = useResource(
    () =>
      accountId
        ? identityApi.listUsers({ account_id: accountId, per_page: 200 })
        : Promise.resolve(null),
    [accountId]
  );

  const registry = useMemo(() => {
    const payload = resources.data;
    return Array.isArray(payload)
      ? payload
      : payload?.resources || payload?.data?.resources || [];
  }, [resources.data]);

  const resource = useMemo(
    () =>
      registry.find((r) => String(r.resource_id) === String(resourceId)) ||
      location.state?.resource ||
      null,
    [registry, resourceId, location.state]
  );

  const resolvedProvider = resource ? detectProvider(resource) : null;

  /* One derivation of the directory, consumed by the table (name lookup) and
     by the create dialog (picker options). */
  const directoryUsers = useMemo(() => extractList(users.data, 'users'), [users.data]);

  const directory = useMemo(() => {
    const map = {};
    directoryUsers.forEach((u) => {
      if (u?.user_id) map[u.user_id] = u.username || u.email || null;
    });
    return map;
  }, [directoryUsers]);

  const userOptions = useMemo(
    () =>
      directoryUsers
        .filter((u) => u?.user_id)
        .map((u) => ({
          id: u.user_id,
          label: u.username || u.email || u.user_id,
          description: u.email && u.username ? u.email : u.department || undefined,
          badge: u.status && u.status !== 'ACTIVE' ? u.status : undefined,
        })),
    [directoryUsers]
  );

  /* "Unavailable" means the read finished and produced nothing usable — not
     that it is still in flight. A loading directory must never be reported to
     the operator as an outage. */
  const directoryUnavailable =
    !users.loading && (!!users.error || (!accountId && directoryUsers.length === 0));

  const rows = useMemo(() => readMappings(mappings.data), [mappings.data]);

  /* ── Counts ──
     Every figure derives from `rows`, so a create / update / deactivate moves
     the hero, the facet band, the toolbar count and the table together the
     moment `mappings.reload()` lands. Nothing is cached separately. */
  const counts = useMemo(
    () => ({
      all: rows.length,
      ACTIVE: rows.filter(FACETS.ACTIVE).length,
      DISABLED: rows.filter(FACETS.DISABLED).length,
      expired: rows.filter(FACETS.expired).length,
    }),
    [rows]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchesFacet = FACETS[facet] || FACETS.all;
    return rows.filter((m) => {
      if (!matchesFacet(m)) return false;
      if (!q) return true;
      const name = directory[m.user_id] || '';
      return (
        String(m.external_id ?? '').toLowerCase().includes(q) ||
        String(m.user_id ?? '').toLowerCase().includes(q) ||
        name.toLowerCase().includes(q) ||
        mappingStatus(m).toLowerCase().includes(q) ||
        scopeList(m.scopes).some((s) => s.toLowerCase().includes(q))
      );
    });
  }, [rows, facet, search, directory]);

  const lastActivity = useMemo(() => {
    const stamps = rows.map(lastTouched).filter(Boolean);
    return stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
  }, [rows]);

  /* ── Actions ─────────────────────────────────────────────────────────── */

  const copyValue = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied to clipboard.');
    } catch {
      toast.error('Clipboard is unavailable in this browser.');
    }
  };

  const refreshAll = () => {
    mappings.reload();
    resources.reload();
  };

  const openCreate = () => {
    setEditing(null);
    setFormMode('create');
  };

  const openEdit = (mapping) => {
    setRecordOf(null);
    setEditing(mapping);
    setFormMode('edit');
  };

  // DELETE /api/v1/integrations/<id> — a deactivation, not a removal.
  const deactivate = async () => {
    const id = mappingId(deactivateTarget);
    if (!id) {
      toast.error('This mapping has no identifier and cannot be deactivated.');
      setDeactivateTarget(null);
      return;
    }
    setBusy(true);
    try {
      await integrationApi.mappings.deactivate(id);
      toast.success(`Mapping for “${deactivateTarget.external_id}” deactivated.`);
      setDeactivateTarget(null);
      setRecordOf(null);
      mappings.reload();
    } catch (err) {
      toast.error(err.userMessage || 'Could not deactivate this mapping.');
    } finally {
      setBusy(false);
    }
  };

  /* Reactivate = PUT back to ACTIVE. The record's current scopes, metadata and
     expiry are re-sent alongside the status so a backend that treats PUT as a
     full replacement does not silently blank them. */
  const reactivate = async (mapping) => {
    const id = mappingId(mapping);
    if (!id) {
      toast.error('This mapping has no identifier and cannot be reactivated.');
      return;
    }
    setBusy(true);
    try {
      await integrationApi.mappings.update(id, {
        status: 'ACTIVE',
        scopes: typeof mapping.scopes === 'string' ? mapping.scopes : scopeList(mapping.scopes),
        metadata:
          mapping.metadata && typeof mapping.metadata === 'object' ? mapping.metadata : {},
        token_expires_at: mapping.token_expires_at || null,
      });
      toast.success(`Mapping for “${mapping.external_id}” reactivated.`);
      setRecordOf(null);
      mappings.reload();
    } catch (err) {
      toast.error(err.userMessage || 'Could not reactivate this mapping.');
    } finally {
      setBusy(false);
    }
  };

  /* ── Table ───────────────────────────────────────────────────────────── */

  const columns = [
    {
      id: 'external_id',
      header: 'External identity',
      primary: true,
      sortable: true,
      sortValue: (m) => String(m.external_id ?? '').toLowerCase(),
      render: (m) => (
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink-900 text-white">
            <ProviderIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-mono text-[13px] font-medium text-ink-900">
              {m.external_id || '—'}
            </p>
            <p className="truncate text-xs text-slate-500">{provider.identityLabel}</p>
          </div>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      hideable: false,
      sortValue: (m) => (mappingStatus(m) === 'ACTIVE' ? 0 : 1),
      render: (m) => <MappingStatus mapping={m} />,
    },
    {
      id: 'user_id',
      header: 'Linked IAM user',
      sortable: true,
      sortValue: (m) => (directory[m.user_id] || m.user_id || '').toLowerCase(),
      render: (m) => (
        <LinkedUser
          userId={m.user_id}
          directory={directory}
          isSelf={m.user_id === currentUserId}
        />
      ),
    },
    {
      id: 'scopes',
      header: 'Scopes',
      render: (m) => <ScopeChips scopes={m.scopes} />,
    },
    {
      id: 'token_expires_at',
      header: 'Token expiry',
      sortable: true,
      hideOnMobile: true,
      sortValue: (m) => (m.token_expires_at ? new Date(m.token_expires_at).getTime() : null),
      render: (m) =>
        m.token_expires_at ? (
          <div className="min-w-0">
            <p
              className={
                isTokenExpired(m) ? 'text-[13px] text-amber-700' : 'text-[13px] text-ink-800'
              }
            >
              {formatRelative(m.token_expires_at)}
            </p>
            <p className="truncate text-xs text-slate-500">
              {formatDateTime(m.token_expires_at)}
            </p>
          </div>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      id: 'updated_at',
      header: 'Last updated',
      sortable: true,
      hideOnMobile: true,
      sortValue: (m) => lastTouched(m),
      render: (m) => (
        <div className="min-w-0">
          <p className="text-[13px] text-ink-800">
            {formatRelative(m.updated_at || m.created_at)}
          </p>
          <p className="truncate text-xs text-slate-500">
            {formatDateTime(m.updated_at || m.created_at)}
          </p>
        </div>
      ),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      render: (m) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {m.external_id && (
            <a
              href={provider.profileUrl(m.external_id)}
              target="_blank"
              rel="noreferrer noopener"
              title={`Open ${m.external_id} on ${provider.label}`}
              aria-label={`Open ${m.external_id} on ${provider.label}`}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-ink-700"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          <IconButton icon={Pencil} title="Edit mapping" onClick={() => openEdit(m)} />
          {mappingStatus(m) === 'DISABLED' ? (
            <IconButton
              icon={RotateCcw}
              title="Reactivate mapping"
              tone="success"
              onClick={() => reactivate(m)}
            />
          ) : (
            <IconButton
              icon={Unlink}
              title="Deactivate mapping"
              tone="danger"
              onClick={() => setDeactivateTarget(m)}
            />
          )}
        </div>
      ),
    },
  ];

  /* ── Guard states ─────────────────────────────────────────────────────── */

  const backLink = (
    <Link
      to="/identity/resources"
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-ink-700"
    >
      <ArrowLeft className="h-4 w-4" /> Registered resources
    </Link>
  );

  if (resources.loading && !resource) {
    return (
      <div>
        {backLink}
        <div className="card flex items-center justify-center py-20">
          <Spinner />
        </div>
      </div>
    );
  }

  if (!resource) {
    return (
      <div>
        {backLink}
        <EmptyState
          icon={Boxes}
          title="This resource could not be found"
          description={
            resources.error ||
            'It may have been removed from the registry, or it is not available to this account.'
          }
          action={
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={resources.reload}>
                Retry
              </Button>
              <Button onClick={() => navigate('/identity/resources')}>Back to resources</Button>
            </div>
          }
        />
      </div>
    );
  }

  if (resolvedProvider?.id !== PROVIDER_ID) {
    return (
      <div>
        {backLink}
        <EmptyState
          icon={Boxes}
          title={`“${resource.resource_name}” is not a ${provider.label} resource`}
          description={`External identity mapping is only available for resources that resolve to a supported provider. Set metadata.provider to “${PROVIDER_ID}” on this resource if it should be treated as ${provider.label}.`}
          action={<Button onClick={() => navigate('/identity/resources')}>Back to resources</Button>}
        />
      </div>
    );
  }

  /* First run = the connection exists but nothing has been mapped yet, and the
     list genuinely answered. A failed read is NOT a first run — it is an
     outage, and gets the error state instead. */
  const isFirstRun = !mappings.loading && !mappings.error && rows.length === 0;

  /* ── Page ─────────────────────────────────────────────────────────────── */

  return (
    <div>
      {backLink}

      <PageHeader
        title={`${provider.label} integration`}
        description={`External identity mappings that bind ${provider.label} logins to IAM users for this protected resource.`}
        icon={<ProviderIcon className="h-4.5 w-4.5" />}
        breadcrumbs={[
          { label: 'Identity' },
          { label: 'Resources', to: '/identity/resources' },
          { label: resource.resource_name || provider.label },
        ]}
      />

      <div className="space-y-4">
        <ConnectionHero
          resource={resource}
          provider={provider}
          activeCount={counts.ACTIVE}
          totalCount={counts.all}
          expiredCount={counts.expired}
          loading={mappings.loading}
          error={mappings.error}
          onCopy={copyValue}
          actions={
            <>
              <Button variant="secondary" onClick={refreshAll} loading={mappings.loading}>
                <RefreshCw className="h-4 w-4" /> Refresh
              </Button>
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" /> Map identity
              </Button>
            </>
          }
        />

        <Tabs
          tabs={[
            {
              id: 'mappings',
              label: 'Identity mappings',
              icon: Link2,
              count: mappings.loading ? undefined : counts.all,
            },
            { id: 'connection', label: 'Connection', icon: ShieldCheck },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === 'mappings' && (
          <>
            {/* A failed read is stated explicitly — an empty table would
                otherwise read as "no identities are mapped", which is a
                different and far more dangerous claim. */}
            {mappings.error && !mappings.loading ? (
              <EmptyState
                icon={Link2}
                title="Identity mappings could not be loaded"
                description={mappings.error}
                action={<Button onClick={mappings.reload}>Retry</Button>}
              />
            ) : isFirstRun ? (
              <FirstRunPanel provider={provider} onCreate={openCreate} />
            ) : (
              <>
                {/* Facets, not KPI tiles: every cell filters the list it
                    counts, so the numbers can never contradict the rows. */}
                <SummaryBar
                  ariaLabel={`${provider.label} identity mapping summary`}
                  loading={mappings.loading}
                  value={facet}
                  onSelect={setFacet}
                  items={[
                    {
                      id: 'all',
                      label: 'Total mappings',
                      value: counts.all,
                      hint: `${provider.label} identities in this tenant`,
                      icon: Link2,
                    },
                    {
                      id: 'ACTIVE',
                      label: 'Active',
                      value: counts.ACTIVE,
                      hint: 'Applied to access decisions',
                      tone: 'positive',
                      icon: CheckCircle2,
                    },
                    {
                      id: 'DISABLED',
                      label: 'Disabled',
                      value: counts.DISABLED,
                      hint: 'Retained but not applied',
                      tone: 'muted',
                      icon: Ban,
                    },
                    {
                      id: 'expired',
                      label: 'Expired token',
                      value: counts.expired,
                      hint: 'Credential needs renewing',
                      tone: counts.expired > 0 ? 'warning' : 'muted',
                      icon: Clock,
                    },
                  ]}
                />

                <Toolbar
                  right={
                    <span className="text-2xs text-slate-500 tabular">
                      {filtered.length} of {counts.all} mapping{counts.all === 1 ? '' : 's'}
                    </span>
                  }
                >
                  <SearchInput
                    value={search}
                    onChange={setSearch}
                    placeholder="Search username, user, scope or status…"
                  />
                </Toolbar>

                <DataTable
                  columns={columns}
                  data={filtered}
                  loading={mappings.loading}
                  getRowId={(m, i) => mappingId(m) ?? i}
                  onRowClick={(m) => setRecordOf(m)}
                  columnsStorageKey="iam-github-mappings-columns"
                  empty={{
                    icon: Link2,
                    title: search ? `No mappings match “${search}”` : 'No mappings in this view',
                    description:
                      facet === 'all'
                        ? 'Adjust the search to see more results.'
                        : 'Choose Total mappings to see every record.',
                    action: (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setSearch('');
                          setFacet('all');
                        }}
                      >
                        Clear filters
                      </Button>
                    ),
                  }}
                />
              </>
            )}
          </>
        )}

        {tab === 'connection' && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Registry record" subtitle="How this resource is registered" icon={Boxes}>
              <dl className="divide-y divide-line-soft">
                <DetailRow label="Resource name">
                  {resource.resource_name || <span className="text-slate-400">—</span>}
                </DetailRow>
                <DetailRow label="Resource type">
                  {resource.resource_type ? (
                    <Badge tone="slate">{resource.resource_type}</Badge>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </DetailRow>
                <DetailRow label="Registry status">
                  <StatusBadge status={resource.is_active ? 'ACTIVE' : 'DISABLED'} />
                </DetailRow>
                <DetailRow label="Endpoint">
                  {resource.target_url ? (
                    <a
                      href={resource.target_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="break-all text-[13px] text-brand-700 hover:text-brand-800"
                    >
                      {resource.target_url}
                    </a>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </DetailRow>
                <DetailRow label="Resource ID" mono>
                  {resource.resource_id || '—'}
                </DetailRow>
                <DetailRow label="Registered">
                  {formatDateTime(resource.created_at)}
                </DetailRow>
              </dl>
            </Panel>

            <Panel
              title="Provider"
              subtitle={`How this tenant reaches ${provider.label}`}
              icon={Tag}
            >
              <dl className="divide-y divide-line-soft">
                <DetailRow label="Provider">
                  <span className="flex items-center gap-2">
                    <ProviderIcon className="h-4 w-4 text-ink-800" />
                    <span>{provider.label}</span>
                    <Badge tone="slate" mono>
                      {provider.id}
                    </Badge>
                  </span>
                </DetailRow>
                <DetailRow label="Identity key">{provider.identityLabel}</DetailRow>
                <DetailRow label="Mappings">
                  {mappings.loading ? (
                    <span className="text-slate-400">Loading…</span>
                  ) : mappings.error ? (
                    <span className="text-slate-400">Unavailable</span>
                  ) : (
                    <span className="tabular">
                      {counts.ACTIVE} active of {counts.all}
                    </span>
                  )}
                </DetailRow>
                <DetailRow label="Expired credentials">
                  {counts.expired > 0 ? (
                    <Badge tone="amber" dot>
                      {counts.expired} need attention
                    </Badge>
                  ) : (
                    <span className="text-slate-500">None</span>
                  )}
                </DetailRow>
                <DetailRow label="Last change">
                  {lastActivity ? (
                    <span>
                      {formatRelative(lastActivity)}{' '}
                      <span className="text-slate-500">({formatDateTime(lastActivity)})</span>
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </DetailRow>
                <DetailRow label="Environment">
                  {resource.metadata?.env || resource.metadata?.team ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      {resource.metadata?.env && <Badge tone="brand">{resource.metadata.env}</Badge>}
                      {resource.metadata?.team && (
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                          <Users className="h-3 w-3 text-slate-400" />
                          {resource.metadata.team}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </DetailRow>
              </dl>
            </Panel>
          </div>
        )}
      </div>

      {/* ── Full record ── */}
      {recordOf && (
        <MappingRecordModal
          mapping={recordOf}
          provider={provider}
          directory={directory}
          currentUserId={currentUserId}
          onClose={() => setRecordOf(null)}
          onEdit={openEdit}
          onDeactivate={(m) => {
            setRecordOf(null);
            setDeactivateTarget(m);
          }}
          onReactivate={reactivate}
          onCopy={copyValue}
        />
      )}

      <MappingFormModal
        open={formMode !== null}
        mode={formMode === 'edit' ? 'edit' : 'create'}
        provider={provider}
        mapping={editing}
        currentUser={user}
        currentUserId={currentUserId}
        userOptions={userOptions}
        usersLoading={users.loading}
        directoryUnavailable={directoryUnavailable}
        existingMappings={rows}
        directory={directory}
        onClose={() => {
          setFormMode(null);
          setEditing(null);
        }}
        onSaved={() => mappings.reload()}
      />

      <ConfirmDialog
        open={!!deactivateTarget}
        onClose={() => setDeactivateTarget(null)}
        onConfirm={deactivate}
        danger
        loading={busy}
        title="Deactivate mapping"
        confirmLabel="Deactivate mapping"
        message={`“${deactivateTarget?.external_id || 'This identity'}” will no longer resolve to ${
          directory[deactivateTarget?.user_id] || 'the linked IAM user'
        }.`}
        detail="The record is retained with status Disabled and can be reactivated later. Access already granted through other means is unaffected."
      />
    </div>
  );
}
