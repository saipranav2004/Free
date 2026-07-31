/**
 * pam/parts.jsx — the two PAM working surfaces, shared by their pages.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * PAM used to be one page with two tabs. It is now two PAGES — Audit Logs and
 * Alerts — each with its own route and its own entry in the PAM sidebar. The
 * surfaces themselves are unchanged (same endpoints, same parameters, same
 * response handling, same visual language); they simply live here so each page
 * file stays a thin shell, exactly like pages/integrations/m365/parts.jsx.
 *
 * TWO SURFACES, TWO JOBS
 *  · Audit Logs = investigation. Filter → scan → inspect. SIEM master/detail:
 *    a dense chronological feed on the left, full event forensics on the right.
 *  · Alerts = analysis. Denials are aggregate evidence, not a to-do list, so
 *    this page answers "what is being denied, to whom, and where is it
 *    concentrating?" before it ever shows a row.
 *
 * HONEST DATA
 *  · Window totals (24h / 7d / 30d) come from the API's own aggregates.
 *  · The time-series is derived from the loaded event page and says so.
 *  · Action classes are labelled as action classes, not invented severities.
 *  · Nothing is fabricated: empty aggregates render as calm empty states.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useState, useCallback, useRef, useEffect, useMemo, Component } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldAlert, Activity, AlertTriangle, Clock, Pause, Play,
  RefreshCw, Download, XCircle, Users, ArrowLeft, TrendingUp, BarChart3,
  Target, UserX, Layers, Gauge, ScrollText, CheckCircle2, ShieldCheck, Shield,
} from 'lucide-react';
import { useResource } from '../../hooks/useResource.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { alertsApi } from '../../lib/api/alerts.js';
import { identityAuditApi } from '../../lib/api/identityAudit.js';
import {
  Panel, Button, SummaryBar, RankBar, SegmentedControl,
  IconButton, EmptyState, Skeleton, SearchInput,
} from '../../components/ui/primitives.jsx';
import { DashboardAreaChart } from '../../components/dashboard/charts/AreaChart.jsx';
import { ActivityFeed } from '../../components/pam/ActivityFeed.jsx';
import { EventDetailPanel } from '../../components/pam/EventDetailPanel.jsx';
import { PamFilters } from '../../components/pam/PamFilters.jsx';
import { classNames } from '../../utils/format.js';

const ROSE = '#e11d48';

/**
 * Both PAM endpoints —
 *   GET /api/v1/identities/audit-logs   (identityAuditApi.list)
 *   GET /api/v1/identities/alerts       (alertsApi.list)
 * — answer with { items, pagination, stats|summary }, but the envelope is not
 * always unwrapped the same way and different builds name the array `items`,
 * `logs`, `audit_logs` or `alerts`. Reading only one of those names is why the
 * views rendered empty against a healthy API, so every shape is resolved here,
 * once, for both surfaces.
 */
export function readEnvelope(payload) {
  if (!payload) return { rows: [], pagination: null, stats: null, summary: null };
  if (Array.isArray(payload)) return { rows: payload, pagination: null, stats: null, summary: null };
  const body =
    payload.data && !Array.isArray(payload.data) ? { ...payload, ...payload.data } : payload;
  const rows =
    [body.items, body.logs, body.audit_logs, body.alerts, body.events, body.results].find(
      Array.isArray
    ) || (Array.isArray(payload.data) ? payload.data : []);
  return {
    rows,
    pagination: body.pagination || null,
    stats: body.stats || body.summary || null,
    // The audit route names its whole-set aggregate `summary`
    // ({ total, authn, authz, success, failure }); alerts names its own `stats`.
    summary: body.summary || null,
  };
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function formatActionName(action) {
  if (!action) return 'Authorization event';
  const map = {
    'role:assign': 'Role assignment',
    'role:remove': 'Role removal',
    'policy:read': 'Policy read',
    'resource:read': 'Resource read',
    'resource:create': 'Resource create',
    'user:login': 'User login',
    'user:logout': 'User logout',
    'mfa:verify': 'MFA verification',
    'session:create': 'Session create',
    'session:revoke': 'Session revoke',
  };
  if (map[action]) return map[action];
  const words = String(action).split(':');
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Groups a denial action into an operational class (never called "severity"). */
function actionClass(action = '') {
  const a = String(action).toLowerCase();
  if (a.includes('role:') || a.includes('admin') || a.includes('delegation') || a.includes('policy:write')) {
    return 'privileged';
  }
  if (a.includes('policy:') || a.includes('resource:') || a.includes('group:')) return 'access';
  return 'other';
}

/**
 * Only privileged denials carry colour. Everything else is a neutral step on
 * the same grey ramp, so the eye lands on the risky slice first instead of
 * decoding a three-colour legend.
 */
const CLASS_META = {
  privileged: { label: 'Privileged operations', bar: 'bg-rose-500', tone: 'red' },
  access: { label: 'Access & policy reads', bar: 'bg-slate-400', tone: 'slate' },
  other: { label: 'Other operations', bar: 'bg-slate-200', tone: 'slate' },
};

const WINDOWS = [
  { value: '24h', label: '24h', buckets: 12, spanMs: 24 * 3600e3 },
  { value: '7d', label: '7d', buckets: 7, spanMs: 7 * 86400e3 },
  { value: '30d', label: '30d', buckets: 10, spanMs: 30 * 86400e3 },
];

/** Buckets events into a time series over the selected window. */
function buildSeries(events, windowKey) {
  const win = WINDOWS.find((w) => w.value === windowKey) || WINDOWS[0];
  const now = Date.now();
  const start = now - win.spanMs;
  const size = win.spanMs / win.buckets;
  const buckets = Array.from({ length: win.buckets }, (_, i) => ({
    at: start + i * size,
    value: 0,
  }));

  let counted = 0;
  events.forEach((e) => {
    const t = new Date(e?.created_at || 0).getTime();
    if (!t || Number.isNaN(t) || t < start || t > now) return;
    const idx = Math.min(win.buckets - 1, Math.floor((t - start) / size));
    buckets[idx].value += 1;
    counted += 1;
  });

  const labelFor = (ms) => {
    const d = new Date(ms);
    if (windowKey === '24h') {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return { data: buckets.map((b) => ({ name: labelFor(b.at), value: b.value })), counted };
}

/* ── Error boundary ───────────────────────────────────────────────────────── */

export class PamErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[PAM] Render error:', error, info?.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <EmptyState
          icon={AlertTriangle}
          title="This section failed to render"
          description={this.state.error?.message || 'An unexpected error occurred.'}
          action={
            <Button variant="secondary" onClick={() => this.setState({ hasError: false, error: null })}>
              Try again
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}

/* ── Shared live/refresh control strip ────────────────────────────────────── */

function LiveControls({ autoRefresh, onToggle, onRefresh, refreshing, lastUpdated, intervalLabel, extra }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={autoRefresh ? 'primary' : 'secondary'} size="sm" onClick={onToggle}>
          {autoRefresh ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {autoRefresh ? `Live · ${intervalLabel}` : 'Auto-refresh'}
        </Button>
        <IconButton icon={RefreshCw} title="Refresh now" onClick={onRefresh} loading={refreshing} variant="secondary" />
        {extra}
      </div>
      <span className="flex items-center gap-1.5 text-2xs text-slate-500">
        <Clock className="h-3 w-3 text-slate-400" />
        {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Not refreshed yet'}
      </span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Audit Logs — investigation surface (page: pages/pam/AuditLogsPage.jsx)
   ═══════════════════════════════════════════════════════════════════════════ */

export function AuditLogsSection({ preset }) {
  const navigate = useNavigate();
  const { accountId } = useAuth();
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const timerRef = useRef(null);
  const logsRef = useRef(null);
  const summaryRef = useRef(null);

  const [filters, setFilters] = useState({ severity: 'all', type: 'all', search: '', from: '', to: '' });
  const [applied, setApplied] = useState({
    severity: 'all', type: 'all', search: '', from: '', to: '', page: 1, page_size: 20,
  });

  /* Page size is part of the investigation: 10 rows to read an incident line by
     line, 100 to scan a burst. It is a real request parameter, so the server
     pages accordingly and the totals stay correct. */
  const handlePerPageChange = useCallback((size) => {
    setApplied((a) => ({ ...a, page_size: size, page: 1 }));
    setSelectedEvent(null);
  }, []);

  /* Drill-through from the Alerts page: a ranked bar hands over a search term
     and (optionally) a decision in the URL, and this view opens pre-filtered. */
  useEffect(() => {
    if (!preset) return;
    setFilters((f) => ({ ...f, search: preset.search || '', severity: preset.severity || 'denied' }));
    setApplied((a) => ({
      ...a,
      search: preset.search || '',
      severity: preset.severity || 'denied',
      page: 1,
    }));
  }, [preset]);

  /* The decision facet is a SERVER parameter (`status`), not a client filter.
     Filtering the fetched page client-side meant "Denied" showed only the denials
     that happened to be on page 1, and the pagination total still described the
     unfiltered set. */
  const statusParam =
    applied.severity === 'denied' ? 'FAILURE' : applied.severity === 'success' ? 'SUCCESS' : undefined;

  const fetcher = useCallback(
    () =>
      identityAuditApi.list({
        // Tenant scope — see identityAudit.js: omitting it makes an admin-gated
        // backend reject the call as unauthorised.
        account_id: accountId || undefined,
        type: applied.type !== 'all' ? applied.type : undefined,
        status: statusParam,
        search: applied.search || undefined,
        from: applied.from || undefined,
        to: applied.to || undefined,
        page: applied.page,
        page_size: applied.page_size,
      }),
    [accountId, applied.type, statusParam, applied.search, applied.from, applied.to, applied.page, applied.page_size]
  );

  const logs = useResource(fetcher, [
    accountId, applied.type, statusParam, applied.search, applied.from, applied.to, applied.page, applied.page_size,
  ]);
  logsRef.current = logs;

  /* ── Whole-set aggregates ──────────────────────────────────────────────────
     One extra minimal request (page_size 1 — only the aggregate is read) that
     carries every applied filter EXCEPT the decision facet. That is what makes
     the facet counts and the summary band describe the entire matching log set
     rather than the current page, and it is the standard facet-count pattern:
     the count of a facet must not be narrowed by that same facet. */
  const summaryRes = useResource(
    () =>
      identityAuditApi.list({
        account_id: accountId || undefined,
        type: applied.type !== 'all' ? applied.type : undefined,
        search: applied.search || undefined,
        from: applied.from || undefined,
        to: applied.to || undefined,
        page: 1,
        page_size: 1,
      }),
    [accountId, applied.type, applied.search, applied.from, applied.to]
  );
  summaryRef.current = summaryRes;

  const { rows: items, pagination: serverPagination } = readEnvelope(logs?.data);
  const pagination = serverPagination || {
    page: applied.page,
    page_size: applied.page_size,
    total: items.length,
    total_pages: 1,
  };

  /* Rows are already scoped by the server; nothing is filtered away locally, so
     the list, the count in the feed header and the pagination range all agree. */
  const filteredItems = items;

  /* Polling stops on an authorisation failure: re-issuing a request that was
     refused every 30s only produces audit noise and a flickering error. */
  const logsDenied = logs?.status === 401 || logs?.status === 403;

  useEffect(() => {
    if (!autoRefresh || logsDenied) return undefined;
    timerRef.current = setInterval(() => {
      logsRef.current?.reload?.();
      // The aggregates are part of the view, so they refresh with the rows.
      summaryRef.current?.reload?.();
      setLastUpdated(new Date());
    }, 30_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, logsDenied]);

  const handleFilterChange = useCallback((key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    if (key !== 'search') setApplied((a) => ({ ...a, [key]: value, page: 1 }));
  }, []);

  const handleSearch = useCallback((value) => {
    // Keep the echoed filter chips in step with what was actually applied.
    setFilters((f) => ({ ...f, search: value }));
    setApplied((a) => ({ ...a, search: value, page: 1 }));
  }, []);

  const handleReset = useCallback(() => {
    const empty = { severity: 'all', type: 'all', search: '', from: '', to: '' };
    setFilters(empty);
    // Page size is a display preference, not a filter — a reset keeps it.
    setApplied((a) => ({ ...empty, page: 1, page_size: a.page_size }));
    setSelectedEvent(null);
  }, []);

  const handlePageChange = useCallback((page) => {
    setApplied((a) => ({ ...a, page }));
    setSelectedEvent(null);
  }, []);

  const handleExport = useCallback(() => {
    if (!filteredItems?.length) return;
    const headers = ['Time', 'Type', 'User', 'Action', 'Decision', 'Resource', 'Status', 'IP'];
    const rows = filteredItems.map((r) => [
      r?.created_at || '', r?.log_type || '', r?.username || r?.user_id || '',
      r?.action || r?.event_type || '', r?.decision || '',
      r?.resource_name || r?.resource || '', r?.status || '', r?.ip_address || '',
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [filteredItems]);

  /* ── Facet counts + summary band ──────────────────────────────────────────
     Read from the server's own aggregate over the WHOLE filtered log set, so
     "Denied 412" means 412 denials exist — not "412 on this page". When a
     deployment sends no aggregate the counts are omitted rather than guessed
     from the page, because a wrong count is worse than no count. */
  const auditSummary = readEnvelope(summaryRes?.data).summary;
  const summaryTotal =
    auditSummary?.total ?? readEnvelope(summaryRes?.data).pagination?.total ?? null;
  const failureCount = auditSummary?.failure ?? null;
  const successCount =
    auditSummary?.success ??
    (summaryTotal != null && failureCount != null ? summaryTotal - failureCount : null);

  const counts = useMemo(
    () => ({
      total: summaryTotal ?? undefined,
      denied: failureCount ?? undefined,
      success: successCount ?? undefined,
    }),
    [summaryTotal, failureCount, successCount]
  );

  const summaryItems = [
    {
      id: 'total',
      label: 'Events in scope',
      value: summaryTotal ?? '—',
      hint: 'Matching the current filters',
      icon: ScrollText,
    },
    {
      id: 'authn',
      label: 'Authentication',
      value: auditSummary?.authn ?? '—',
      hint: 'Sign-in and session events',
      tone: 'muted',
      icon: ShieldCheck,
    },
    {
      id: 'authz',
      label: 'Authorisation',
      value: auditSummary?.authz ?? '—',
      hint: 'Policy decisions',
      tone: 'muted',
      icon: Shield,
    },
    {
      id: 'allowed',
      label: 'Successful',
      value: successCount ?? '—',
      hint: 'Allowed or completed',
      tone: 'positive',
      icon: CheckCircle2,
    },
    {
      id: 'failed',
      label: 'Denied / failed',
      value: failureCount ?? '—',
      hint: 'Refusals and failures',
      tone: 'danger',
      icon: XCircle,
    },
  ];

  return (
    <div className="space-y-4">
      <LiveControls
        autoRefresh={autoRefresh}
        onToggle={() => setAutoRefresh((v) => !v)}
        onRefresh={() => {
          logs?.reload?.();
          summaryRes?.reload?.();
          setLastUpdated(new Date());
        }}
        refreshing={logs?.loading}
        lastUpdated={lastUpdated}
        intervalLabel="30s"
        extra={
          <Button variant="secondary" size="sm" onClick={handleExport} disabled={!filteredItems?.length}>
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        }
      />

      {/* ── Scope band ───────────────────────────────────────────────────────
          What the current filters actually cover, as one compact band: the
          shape of the evidence before the evidence itself. Whole-set server
          aggregates — never page-local arithmetic. */}
      <SummaryBar
        ariaLabel="Audit log summary"
        items={summaryItems}
        loading={summaryRes?.loading && summaryTotal == null}
      />

      <div className="card px-3 py-3 sm:px-4">
        <PamFilters
          filters={filters}
          onFilterChange={handleFilterChange}
          onSearch={handleSearch}
          onReset={handleReset}
          counts={counts}
        />
      </div>

      <div
        className={classNames(
          'card grid grid-cols-1 overflow-hidden lg:grid-cols-5',
          selectedEvent ? 'min-h-[560px]' : 'min-h-[420px]'
        )}
      >
        <div
          className={classNames(
            'flex flex-col border-b border-line lg:col-span-3 lg:border-b-0 lg:border-r',
            selectedEvent ? 'hidden lg:flex' : 'flex'
          )}
        >
          <ActivityFeed
            events={filteredItems}
            selectedEvent={selectedEvent}
            onSelectEvent={setSelectedEvent}
            loading={logs?.loading && filteredItems.length === 0}
            error={
              logs?.error && filteredItems.length === 0
                ? logsDenied
                  ? 'Your session is not authorised to read the tenant audit trail. Sign out and back in to refresh your token, or ask a root administrator to grant audit access.'
                  : logs.error
                : null
            }
            errorTitle={
              logsDenied ? 'Audit trail not available to this session' : 'Could not load events'
            }
            canRetry={!logsDenied}
            pagination={pagination}
            onPageChange={handlePageChange}
            onPerPageChange={handlePerPageChange}
            onRetry={() => {
              logs?.reload?.();
              summaryRes?.reload?.();
            }}
            emptyMessage="No audit events match the current filters."
          />
        </div>
        <div
          className={classNames(
            'flex flex-col bg-slate-50/40 lg:col-span-2',
            selectedEvent ? 'flex' : 'hidden lg:flex'
          )}
        >
          {selectedEvent && (
            <button
              type="button"
              onClick={() => setSelectedEvent(null)}
              className="flex items-center gap-2 border-b border-line bg-white px-4 py-3 text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-50 lg:hidden"
            >
              <ArrowLeft className="h-4 w-4" /> Back to feed
            </button>
          )}
          <EventDetailPanel
            event={selectedEvent}
            onClose={() => setSelectedEvent(null)}
            onNavigateToUser={(userId) => navigate(`/identity/users/${userId}`)}
            onNavigateToResource={(resource) =>
              navigate(`/identity/resources?search=${encodeURIComponent(resource)}`)
            }
          />
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Alerts — analytical denial view (page: pages/pam/AlertsPage.jsx)
   ═══════════════════════════════════════════════════════════════════════════ */

export function AlertsSection({ onInvestigate }) {
  const navigate = useNavigate();
  const { accountId } = useAuth();
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [windowKey, setWindowKey] = useState('7d');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const timerRef = useRef(null);
  const alertsRef = useRef(null);

  /* The request is parameterised: paging and search go to the server (the
     endpoint documents both), instead of being applied to one fixed page of
     100 rows on the client. `stats` is computed backend-side over the whole
     data set, so the KPI tiles stay correct on every page. */
  /* Page size is a real request parameter (the endpoint documents page_size up
     to 200), so widening the window widens the query — it never slices a fixed
     page client-side. */
  const [pageSize, setPageSize] = useState(25);
  const fetcher = useCallback(
    () =>
      alertsApi.list({
        // Tenant scope — see alerts.js: without it an admin-gated backend
        // cannot resolve the caller's role and rejects the request.
        account_id: accountId || undefined,
        page,
        page_size: pageSize,
        search: appliedSearch || undefined,
      }),
    [accountId, page, pageSize, appliedSearch]
  );
  const alerts = useResource(fetcher, [accountId, page, pageSize, appliedSearch]);
  alertsRef.current = alerts;

  const { rows: items, pagination: serverPagination, stats: serverStats } = readEnvelope(
    alerts?.data
  );

  const events = useMemo(
    () =>
      items
        .map((item) => {
          const event = item?.audit_event || item || {};
          const profile = item?.user_profile || {};
          return {
            audit_id: event?.audit_id || event?.id || item?.audit_id || item?.id,
            action: event?.action || event?.event_type || item?.action || item?.event_type,
            username: profile?.username || event?.username || item?.username || event?.user_id,
            email: profile?.email || event?.email || item?.email,
            resource_name: event?.resource_name || event?.resource || item?.resource_name || item?.resource,
            decision: event?.decision || event?.status || item?.decision,
            status: event?.status || item?.status,
            ip_address: event?.ip_address || item?.ip_address,
            created_at: event?.created_at || item?.created_at,
            details: event?.details || item?.details,
            log_type: event?.log_type || item?.log_type,
            user_agent: event?.user_agent || item?.user_agent,
            user_id: event?.user_id || item?.user_id,
            audit_event: event,
            user_profile: profile,
          };
        })
        .filter((e) => e.audit_id),
    [items]
  );

  const stats = serverStats || {
    total_deny: 0, unique_users: 0, unique_actions: 0, unique_resources: 0,
    deny_by_action: [], deny_by_resource: [], deny_by_user: [],
    trend: { last_24h: 0, last_7d: 0, last_30d: 0 },
  };

  useEffect(() => {
    if (!autoRefresh) return undefined;
    timerRef.current = setInterval(() => {
      alertsRef.current?.reload?.();
      setLastUpdated(new Date());
    }, 60_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh]);

  /* ── Derived analytics ── */
  const series = useMemo(() => buildSeries(events, windowKey), [events, windowKey]);

  const byUser = (stats.deny_by_user || []).map((i) => ({
    name: i.username || i.user_id || 'Unknown principal',
    value: i.count || 0,
  }));
  const byResource = (stats.deny_by_resource || []).map((i) => ({
    name: i.resource || 'Unknown resource',
    value: i.count || 0,
  }));
  const byAction = (stats.deny_by_action || []).map((i) => ({
    name: formatActionName(i.action),
    raw: i.action,
    value: i.count || 0,
  }));

  const maxUser = Math.max(...byUser.map((d) => d.value), 1);
  const maxResource = Math.max(...byResource.map((d) => d.value), 1);
  const maxAction = Math.max(...byAction.map((d) => d.value), 1);

  const classMix = useMemo(() => {
    const totals = { privileged: 0, access: 0, other: 0 };
    (stats.deny_by_action || []).forEach((a) => {
      totals[actionClass(a.action)] += a.count || 0;
    });
    const sum = totals.privileged + totals.access + totals.other;
    return { totals, sum };
  }, [stats.deny_by_action]);

  const totalDeny = stats.total_deny || 0;
  const topUserShare =
    byUser.length && totalDeny > 0 ? Math.round((byUser[0].value / totalDeny) * 100) : 0;

  /* ── Recent denial feed ──
     Server pagination when the API reports it; a client slice only as a
     fallback for a build that returns the whole set unpaginated. */
  const pagination = serverPagination || {
    page,
    page_size: pageSize,
    total: events.length,
    total_pages: Math.max(1, Math.ceil(events.length / pageSize)),
  };
  const paginated = serverPagination
    ? events
    : events.slice((page - 1) * pageSize, page * pageSize);

  const applySearch = useCallback(() => {
    setAppliedSearch(search.trim());
    setPage(1);
    setSelectedEvent(null);
  }, [search]);

  const loading = alerts?.loading;

  /* Opening this page counts as reading the alerts, however the operator got
     here (bell, sidebar, deep link). The Topbar's notification hook listens for
     this event and moves its unread baseline. */
  useEffect(() => {
    if (loading) return;
    window.dispatchEvent(new Event('iam:alerts-read'));
  }, [loading, events.length]);

  return (
    <div className="space-y-4">
      <LiveControls
        autoRefresh={autoRefresh}
        onToggle={() => setAutoRefresh((v) => !v)}
        onRefresh={() => {
          alerts?.reload?.();
          setLastUpdated(new Date());
        }}
        refreshing={loading}
        lastUpdated={lastUpdated}
        intervalLabel="60s"
        extra={
          /* Server-side search over principal, action, resource and reason —
             Enter applies it, exactly like the audit filters. */
          <>
            <SearchInput
              value={search}
              onChange={setSearch}
              onSubmit={applySearch}
              placeholder="Search denials, then press Enter…"
            />
            {appliedSearch && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setAppliedSearch('');
                  setPage(1);
                  setSelectedEvent(null);
                }}
              >
                Clear
              </Button>
            )}
          </>
        }
      />

      {/* ── Volume band ──────────────────────────────────────────────────────
          The same four server aggregates the tiles carried, in the console's
          standard summary band: the analysis below is the content of this page,
          so the headline figures state the scale and then get out of the way. */}
      <SummaryBar
        ariaLabel="Denial volume summary"
        loading={loading}
        items={[
          {
            id: 'total',
            label: 'Total denials',
            value: totalDeny,
            hint: 'All recorded DENY decisions',
            tone: 'danger',
            icon: XCircle,
          },
          {
            id: 'recent',
            label: 'Last 24 hours',
            value: stats.trend?.last_24h ?? 0,
            hint: `${(stats.trend?.last_7d ?? 0).toLocaleString()} in 7d · ${(stats.trend?.last_30d ?? 0).toLocaleString()} in 30d`,
            icon: TrendingUp,
          },
          {
            id: 'principals',
            label: 'Principals denied',
            value: stats.unique_users ?? 0,
            hint: topUserShare > 0 ? `Top principal is ${topUserShare}% of denials` : 'Distinct identities refused',
            tone: 'muted',
            icon: Users,
          },
          {
            id: 'resources',
            label: 'Resources targeted',
            value: stats.unique_resources ?? 0,
            hint: `${(stats.unique_actions ?? 0).toLocaleString()} distinct actions`,
            tone: 'muted',
            icon: Layers,
          },
        ]}
      />

      {/* ── Timeline + action-class mix ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title="Denial volume over time"
          subtitle={
            series.counted > 0
              ? `${series.counted.toLocaleString()} of the ${events.length.toLocaleString()} most recent denial events fall in this window`
              : 'Derived from the most recent denial events'
          }
          icon={Activity}
          action={
            <SegmentedControl
              size="sm"
              ariaLabel="Time window"
              value={windowKey}
              onChange={setWindowKey}
              options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
            />
          }
        >
          {loading ? (
            <Skeleton className="h-[220px] w-full" />
          ) : series.counted === 0 ? (
            <div className="flex h-[220px] flex-col items-center justify-center text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50">
                <ShieldAlert className="h-5 w-5 text-emerald-500" />
              </span>
              <p className="mt-3 text-[13px] font-medium text-ink-900">
                No denials in the selected window
              </p>
              <p className="mt-1 max-w-xs text-xs text-slate-500">
                Authorisation is operating without refusals over this period.
              </p>
            </div>
          ) : (
            <DashboardAreaChart data={series.data} color={ROSE} height={220} />
          )}
        </Panel>

        <Panel title="Denials by action class" icon={BarChart3}>
          {classMix.sum === 0 ? (
            <p className="py-8 text-center text-[13px] text-slate-500">No aggregated actions yet.</p>
          ) : (
            <>
              <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100">
                {Object.entries(classMix.totals).map(([key, count]) =>
                  count > 0 ? (
                    <div
                      key={key}
                      className={CLASS_META[key].bar}
                      style={{ width: `${(count / classMix.sum) * 100}%` }}
                      title={`${CLASS_META[key].label}: ${count}`}
                    />
                  ) : null
                )}
              </div>
              <ul className="mt-4 space-y-2.5">
                {Object.entries(classMix.totals).map(([key, count]) => (
                  <li key={key} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={classNames('h-2 w-2 shrink-0 rounded-full', CLASS_META[key].bar)} />
                      <span className="truncate text-[12.5px] text-ink-700">{CLASS_META[key].label}</span>
                    </span>
                    <span className="shrink-0 text-[12.5px] font-semibold text-ink-900 tabular">
                      {count.toLocaleString()}
                      <span className="ml-1.5 font-normal tracking-tight text-slate-400">
                        {Math.round((count / classMix.sum) * 100)}%
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 border-t border-line-soft pt-3 text-2xs leading-relaxed text-slate-500">
                Privileged operations are role, delegation and policy-write denials — these are the
                ones worth investigating first.
              </p>
            </>
          )}
        </Panel>
      </div>

      {/* ── Ranked concentration ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Top denied principals" icon={UserX} subtitle="Select a row to investigate in the audit trail">
          {byUser.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-slate-500">No principal aggregates.</p>
          ) : (
            <div className="space-y-3.5">
              {byUser.slice(0, 6).map((item, i) => (
                <RankBar
                  key={`${item.name}-${i}`}
                  label={item.name}
                  value={item.value}
                  max={maxUser}
                  tone={i === 0 ? 'brand' : 'slate'}
                  onClick={() => onInvestigate?.(item.name)}
                  actionHint={`Investigate denials for ${item.name}`}
                  leading={
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-slate-100 text-3xs font-semibold text-slate-600">
                      {String(item.name).charAt(0).toUpperCase()}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Most targeted resources" icon={Target}>
          {byResource.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-slate-500">No resource aggregates.</p>
          ) : (
            <div className="space-y-3.5">
              {byResource.slice(0, 6).map((item, i) => (
                <RankBar
                  key={`${item.name}-${i}`}
                  label={item.name}
                  value={item.value}
                  max={maxResource}
                  tone={i === 0 ? 'brand' : 'slate'}
                  onClick={() => onInvestigate?.(item.name)}
                  actionHint={`Investigate denials on ${item.name}`}
                />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Most denied actions" icon={Gauge}>
          {byAction.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-slate-500">No action aggregates.</p>
          ) : (
            <div className="space-y-3.5">
              {byAction.slice(0, 6).map((item, i) => (
                <RankBar
                  key={`${item.name}-${i}`}
                  label={item.name}
                  title={item.raw}
                  value={item.value}
                  max={maxAction}
                  tone={actionClass(item.raw) === 'privileged' ? 'red' : 'slate'}
                  onClick={() => onInvestigate?.(item.raw || item.name)}
                  actionHint={`Investigate ${item.raw || item.name} denials`}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ── Raw denial evidence ── */}
      <div
        className={classNames(
          'card grid grid-cols-1 overflow-hidden lg:grid-cols-5',
          selectedEvent ? 'min-h-[560px]' : 'min-h-[420px]'
        )}
      >
        <div
          className={classNames(
            'flex flex-col border-b border-line lg:col-span-3 lg:border-b-0 lg:border-r',
            selectedEvent ? 'hidden lg:flex' : 'flex'
          )}
        >
          <ActivityFeed
            title="Recent denials"
            events={paginated}
            selectedEvent={selectedEvent}
            onSelectEvent={setSelectedEvent}
            loading={loading && paginated.length === 0}
            error={alerts?.error && paginated.length === 0 ? alerts.error : null}
            pagination={pagination}
            onPageChange={(p) => {
              setPage(p);
              setSelectedEvent(null);
            }}
            onPerPageChange={(size) => {
              setPageSize(size);
              setPage(1);
              setSelectedEvent(null);
            }}
            onRetry={() => alerts?.reload?.()}
            emptyMessage="No denial alerts detected."
          />
        </div>
        <div
          className={classNames(
            'flex flex-col bg-slate-50/40 lg:col-span-2',
            selectedEvent ? 'flex' : 'hidden lg:flex'
          )}
        >
          {selectedEvent && (
            <button
              type="button"
              onClick={() => setSelectedEvent(null)}
              className="flex items-center gap-2 border-b border-line bg-white px-4 py-3 text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-50 lg:hidden"
            >
              <ArrowLeft className="h-4 w-4" /> Back to denials
            </button>
          )}
          <EventDetailPanel
            event={selectedEvent}
            onClose={() => setSelectedEvent(null)}
            onNavigateToUser={(userId) => navigate(`/identity/users/${userId}`)}
            onNavigateToResource={(resource) =>
              navigate(`/identity/resources?search=${encodeURIComponent(resource)}`)
            }
          />
        </div>
      </div>
    </div>
  );
}
