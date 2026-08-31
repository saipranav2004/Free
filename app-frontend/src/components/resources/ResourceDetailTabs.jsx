import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { AlertTriangle, ScrollText, Radio, KeyRound, ShieldCheck, ShieldOff, FileKey2 } from 'lucide-react'
import { auditByResource, searchAudit } from '../../api/audit'
import { listAudit } from '../../api/admin'
import { listMySessions } from '../../api/sessions'
import { useAuthStore } from '../../store/authStore'
import { Card, CardHeader, CardTitle, EmptyState, DetailList, ListRow, StatusDot } from '../common/Layout'
import { Badge } from '../common/Badge'
import { SkeletonRows } from '../common/Spinner'
import { formatDateTime, formatDuration } from '../../lib/format'
import { CONNECT_MODES } from '../../config/constants'
import { eventTime, eventActor, eventTarget, eventId } from '../audit/auditFields'
import { resourceTypeLabel, CredentialState } from './ResourceCard'

const CONNECT_MODE_LABEL = Object.fromEntries(CONNECT_MODES.map((m) => [m.value, m.label]))

// ---------------------------------------------------------------------------
// Data-protection state, read-only
// ---------------------------------------------------------------------------
// The Edit dialog is where these are SET. This is where they are CHECKED, and
// the two are not the same need: an administrator asking "is developer-tools
// blocking actually on for MinIO" had to open an edit form on a live resource
// and remember not to save, which is a bad way to answer a read-only question.
//
// Each row says On or Off and nothing more clever. A summary that scored these
// or called the resource "protected" would be claiming an outcome; the
// controls differ in strength and two of them are deterrents, so the honest
// display is the raw state plus the one line below about what that means.

function OnOff({ on }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot tone={on ? 'ok' : 'muted'} />
      <span className={on ? 'text-ink-100' : 'text-ink-400'}>{on ? 'On' : 'Off'}</span>
    </span>
  )
}

function formatBytes(n) {
  const v = Number(n)
  if (!v || v <= 0) return 'Unlimited'
  if (v >= 1024 * 1024 * 1024) return `${Math.round(v / (1024 * 1024 * 1024))} GB`
  return `${Math.round(v / (1024 * 1024))} MB`
}

function DataProtectionCard({ resource }) {
  // Empty means every method is permitted, which is the loosest setting, so an
  // absent value must read as "not enforced" rather than as a configured one.
  const methods = String(resource.allowed_connect_methods || '')
  const brokeredOnly = methods !== '' && !methods.split(',').some((m) => m.trim() === 'agent')

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Data protection</CardTitle>
      </CardHeader>
      <DetailList
        items={[
          { label: 'Brokered access only', value: <OnOff on={brokeredOnly} /> },
          { label: 'Block copy and paste', value: <OnOff on={!!resource.block_clipboard} /> },
          { label: 'Block developer tools', value: <OnOff on={!!resource.block_devtools} /> },
          { label: 'Block file downloads', value: <OnOff on={!!resource.block_download} /> },
          { label: 'Watermark the screen', value: <OnOff on={!!resource.watermark} /> },
          { label: 'Session transfer limit', value: formatBytes(resource.max_egress_bytes) },
        ]}
      />
      <p className="px-4 pb-4 text-xs leading-relaxed text-ink-400">
        Downloads and the transfer limit are enforced on the server and cannot be bypassed from the
        browser. Copy, paste and developer-tools blocking are deterrents applied inside the page: they
        raise the effort and record every attempt, and a determined user defeats them. None of it applies
        at all unless brokered access is enforced, because the desktop agent connects to the target
        directly.
      </p>
    </Card>
  )
}

// A tab whose data source doesn't exist for this shape of object gets an
// honest notice, not an empty list that implies "nothing happened here".
function Unavailable({ title, description }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-300/60 bg-amber-50/70 px-4 py-3.5 dark:border-amber-900/40 dark:bg-amber-950/20">
      <AlertTriangle
        className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400"
        strokeWidth={2}
      />
      <div>
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-amber-800/90 dark:text-amber-300/90">{description}</p>
      </div>
    </div>
  )
}

export function OverviewTab({ resource }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
        </CardHeader>
        <DetailList
          items={[
            { label: 'Type', value: resourceTypeLabel(resource.resource_type) },
            { label: 'Host', value: <span className="font-mono text-xs">{resource.host}</span> },
            { label: 'Port', value: <span className="font-mono text-xs tabular-nums">{resource.port}</span> },
            { label: 'Database', value: resource.database_name || '-' },
            {
              label: 'Connect mode',
              value: CONNECT_MODE_LABEL[resource.connect_mode] || resource.connect_mode || '-',
            },
            {
              label: 'Console URL',
              value: resource.console_url ? (
                <a
                  href={resource.console_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="break-all text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  {resource.console_url}
                </a>
              ) : (
                '-'
              ),
            },
          ]}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registration</CardTitle>
        </CardHeader>
        <DetailList
          items={[
            {
              label: 'Resource ID',
              value: <span className="break-all font-mono text-xs">{resource.id}</span>,
            },
            { label: 'Description', value: resource.description || '-' },
            { label: 'Registered', value: resource.created_at ? formatDateTime(resource.created_at) : '-' },
            { label: 'Last updated', value: resource.updated_at ? formatDateTime(resource.updated_at) : '-' },
            { label: 'Credential', value: <CredentialState resource={resource} /> },
          ]}
        />
      </Card>

      <DataProtectionCard resource={resource} />

      {/* PROTOCOL CONFIGURATION, commented out at request, not deleted. It
 dumped resource.extra_config as raw JSON, which is a developer view
 of the record rather than something an operator reads. Restore this
 block to bring it back exactly as it was.

      {resource.extra_config && Object.keys(resource.extra_config).length > 0 && (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Protocol configuration</CardTitle>
          </CardHeader>
          <pre className="overflow-x-auto px-4 py-3.5 font-mono text-xs leading-relaxed text-ink-300">
            {JSON.stringify(resource.extra_config, null, 2)}
          </pre>
        </Card>
      )}
      */}
    </div>
  )
}

export function PoliciesTab({ resource }) {
  const rules = [
    {
      key: 'jit',
      icon: resource.requires_jit ? KeyRound : ShieldCheck,
      tone: resource.requires_jit ? 'amber' : 'emerald',
      title: resource.requires_jit ? 'Just-in-time elevation required' : 'Standing access permitted',
      body: resource.requires_jit
        ? 'No standing privilege. A user must hold an approved, time-boxed JIT grant before this resource will broker a session.'
        : 'Any user whose role or attached policy permits this resource may connect without raising a request first.',
    },
    {
      key: 'record',
      icon: resource.always_record ? Radio : ScrollText,
      tone: resource.always_record ? 'purple' : 'default',
      title: resource.always_record ? 'Recording is mandatory' : 'Recording follows session policy',
      body: resource.always_record
        ? 'Every session on this resource is recorded. Recording cannot be waived per session.'
        : 'Sessions are recorded when the requesting policy or the session request asks for it.',
    },
    {
      key: 'state',
      icon: resource.is_active ? ShieldCheck : ShieldOff,
      tone: resource.is_active ? 'emerald' : 'red',
      title: resource.is_active ? 'Resource is active' : 'Resource is disabled',
      body: resource.is_active
        ? 'The resource is registered and available for brokered access.'
        : 'The registration exists but is disabled, connection attempts are refused.',
    },
  ]

  const TONE = {
    default: 'border-surface-700 bg-surface-850 text-ink-400',
    emerald:
      'border-emerald-600/20 bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300',
    amber: 'border-amber-600/20 bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300',
    purple: 'border-purple-600/20 bg-purple-50 text-purple-600 dark:bg-purple-500/10 dark:text-purple-300',
    red: 'border-red-600/20 bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300',
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle icon={FileKey2}>Access rules in force</CardTitle>
        </CardHeader>
        <ul className="divide-y divide-surface-800">
          {rules.map((r) => (
            <li key={r.key} className="flex gap-3.5 px-4 py-4">
              <span
                className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg border ${TONE[r.tone]}`}
              >
                <r.icon className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink-50">{r.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-ink-400">{r.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <p className="px-1 text-xs leading-relaxed text-ink-500">
        These are the access rules stored on the resource record itself. Role- and policy-based grants that
        also govern this resource are managed in{' '}
        <Link
          to="/admin/policies"
          className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
        >
          Admin Center → Policies
        </Link>
        .
      </p>
    </div>
  )
}

export function SessionsTab({ resource }) {
  // Self-service endpoint: it returns the caller's OWN sessions only, so the
  // heading says so. Filtering happens here because /sessions/mine takes no
  // resource parameter, claiming otherwise would mean inventing a request.
  const query = useQuery({
    queryKey: ['sessions', 'mine', 'all-for-resource'],
    queryFn: ({ signal }) => listMySessions({ page: 1, pageSize: 100, signal }),
  })

  const sessions = (query.data?.sessions || []).filter(
    (s) => s.resource_id === resource.id || s.resource_name === resource.name
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={Radio}>Your sessions on this resource</CardTitle>
        <span className="ml-auto text-xs text-ink-500">Self-service view, your own sessions only</span>
      </CardHeader>

      {query.isLoading ? (
        <div className="p-4">
          <SkeletonRows rows={3} />
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="No sessions yet"
          description="Sessions you open against this resource will be listed here with their duration and outcome."
          className="py-12"
        />
      ) : (
        <ul className="divide-y divide-surface-800">
          {sessions.map((s) => (
            <li key={s.id}>
              <ListRow
                title={
                  <span className="flex items-center gap-2">
                    {s.status === 'ACTIVE' && <StatusDot tone="emerald" live />}
                    <span className="truncate">{s.protocol || 'Session'}</span>
                  </span>
                }
                subtitle={`Started ${formatDateTime(s.started_at)}`}
                trailing={
                  <>
                    <span className="text-xs tabular-nums text-ink-400">
                      {s.status === 'ACTIVE'
                        ? formatDuration((Date.now() - new Date(s.started_at).getTime()) / 1000)
                        : formatDuration(s.duration_seconds)}
                    </span>
                    <Badge
                      className={
                        s.status === 'ACTIVE'
                          ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/12 dark:text-emerald-300'
                          : 'bg-ink-500/10 text-ink-400 ring-ink-500/25'
                      }
                    >
                      {s.status}
                    </Badge>
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Audit tab
// ---------------------------------------------------------------------------
// WHY THIS TAB WAS EMPTY. It asked GET /pam/audit/resource/{uuid} and showed
// whatever came back, which was nothing. That route is registered as
// /audit/resource/*resource and matches the value the WRITER put in the audit
// row's resource field, which on this backend is not reliably the resource's
// UUID: some entries carry the resource NAME, some a host, some only carry
// the id inside their details payload. So the lookup returned an empty array
// and the tab honestly reported "no recorded events" for a resource that had
// plenty.
//
// THE FIX IS TWO SOURCES, MERGED, never one guess:
//   1. the per-resource route, still asked first (if this backend does index
// by id, it is the cheapest and most complete answer), and
//   2. a recent slice of the trail this viewer is allowed to read, org-wide
//      /admin/audit for an admin, their own /pam/audit otherwise, filtered
// to rows that reference this resource by id, name or host, including
// ids buried in a details/metadata blob.
// Rows are de-duplicated by event id and sorted newest first, so a row that
// arrives from both sources appears once. The "unavailable" notice now only
// appears when BOTH sources fail, previously a single 404 painted a warning
// over a tab that could have shown data.

const RESOURCE_AUDIT_SCAN = 200

function eventMatchesResource(e, resource) {
  if (!e || !resource) return false
  const wanted = [resource.id, resource.name, resource.host]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase())
  const rid = String(resource.id || '').toLowerCase()

  const direct = [
    e.resource_id,
    e.resource_name,
    e.resource,
    e.resource_path,
    e.target,
    e.target_id,
    e.target_name,
    e.details?.resource_id,
    e.details?.resource_name,
    e.metadata?.resource_id,
    e.metadata?.resource_name,
  ]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase())

  if (direct.some((v) => wanted.includes(v))) return true
  if (rid && direct.some((v) => v.includes(rid))) return true

  // details / metadata can arrive as a JSON string rather than an object.
  if (!rid) return false
  return [e.details, e.metadata, e.extra].some(
    (blob) => typeof blob === 'string' && blob.toLowerCase().includes(rid)
  )
}

export function AuditTab({ resource }) {
  const isAdmin = useAuthStore((s) => s.isAdmin())

  const scopedQuery = useQuery({
    queryKey: ['audit', 'resource', resource.id],
    queryFn: ({ signal }) => auditByResource(resource.id, 100, signal),
    retry: false,
  })

  const scanQuery = useQuery({
    queryKey: ['audit', 'resource-scan', isAdmin ? 'org' : 'mine', resource.id],
    queryFn: ({ signal }) =>
      isAdmin
        ? listAudit({ page: 1, page_size: RESOURCE_AUDIT_SCAN }, signal)
        : searchAudit({ limit: RESOURCE_AUDIT_SCAN, offset: 0 }, signal),
    retry: false,
  })

  const events = useMemo(() => {
    const scoped = Array.isArray(scopedQuery.data) ? scopedQuery.data : scopedQuery.data?.items || []
    const scanned = isAdmin ? scanQuery.data?.events || [] : scanQuery.data?.items || []
    const matched = scanned.filter((e) => eventMatchesResource(e, resource))

    const seen = new Set()
    const merged = []
    for (const e of [...scoped, ...matched]) {
      const key = eventId(e) || `${eventTime(e)}|${e?.action}|${eventActor(e)}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(e)
    }
    return merged.sort(
      (a, b) => new Date(eventTime(b) || 0).getTime() - new Date(eventTime(a) || 0).getTime()
    )
  }, [scopedQuery.data, scanQuery.data, isAdmin, resource])

  const loading = scopedQuery.isLoading || scanQuery.isLoading
  const bothFailed = scopedQuery.isError && scanQuery.isError

  return (
    <div className="space-y-4">
      {bothFailed && (
        <Unavailable
          title="Audit lookup unavailable"
          description="Neither the per-resource route nor the audit search returned a result for this account. The full, filterable trail is available on the Audit page."
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle icon={ScrollText}>Recent activity</CardTitle>
          <Link
            to={isAdmin ? '/admin/audit' : '/audit'}
            className="ml-auto text-xs font-medium text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400"
          >
            Open full audit trail →
          </Link>
        </CardHeader>

        {loading ? (
          <div className="p-4">
            <SkeletonRows rows={4} />
          </div>
        ) : events.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={bothFailed ? 'Nothing to show here' : 'No recorded events'}
            description={
              bothFailed
                ? 'Use the Audit page to search the tamper-evident trail across every resource.'
                : 'Access decisions, session starts and credential operations for this resource will appear here.'
            }
            className="py-12"
          />
        ) : (
          <>
            <ul className="divide-y divide-surface-800">
              {events.slice(0, 25).map((e, i) => (
                <li key={eventId(e) || i} className="flex items-start justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-100">
                      {e.action || e.event_type || 'Event'}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-500">
                      {eventActor(e) || '-'}
                      {e.category ? ` · ${e.category}` : ''}
                      {eventTarget(e) ? ` · ${eventTarget(e)}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-none items-center gap-2.5">
                    {e.outcome && (
                      <Badge
                        className={
                          String(e.outcome).toUpperCase().includes('DENIED') ||
                          String(e.outcome).toUpperCase().includes('FAIL')
                            ? 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/12 dark:text-red-300'
                            : 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/12 dark:text-emerald-300'
                        }
                      >
                        {e.outcome}
                      </Badge>
                    )}
                    <span className="whitespace-nowrap text-xs tabular-nums text-ink-500">
                      {formatDateTime(eventTime(e))}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="border-t border-surface-800 px-4 py-2.5">
              <p className="text-2xs leading-relaxed text-ink-500">
                {events.length > 25 ? `Showing 25 of ${events.length} matched entries · ` : ''}
                Matched against this resource&apos;s id, name and host across the{' '}
                {isAdmin ? 'organization’s' : 'your'} {RESOURCE_AUDIT_SCAN} most recent audit entries.
              </p>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
