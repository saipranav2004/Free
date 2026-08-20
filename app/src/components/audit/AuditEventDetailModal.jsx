import { useEffect } from 'react'
import { X, User, Target, Link2, ShieldCheck, FileText } from 'lucide-react'
import { formatDateTime } from '../../lib/format'
import { CopyButton } from '../common/CopyButton'
import { Badge } from '../common/Badge'
import { AUDIT_OUTCOME_BADGE, AUDIT_SEVERITY_BADGE } from '../../config/constants'

// Field names here match models/audit_log.go exactly (verified against the
// backend source, not guessed), unlike AuditPage's actor/target label
// helpers, which stay defensive because they're also used against the
// admin list endpoint whose exact response shape isn't pinned down. This
// modal is the "I clicked one row, show me everything about it" view, so
// it's worth being precise rather than generic here.
function Row({ label, value, mono, copyable }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="flex-none text-xs text-ink-500">{label}</dt>
      <dd
        className={
          'min-w-0 flex-1 truncate text-right text-sm text-ink-100' + (mono ? ' font-mono text-xs' : '')
        }
        title={typeof value === 'string' ? value : undefined}
      >
        {String(value)}
      </dd>
      {copyable && <CopyButton value={String(value)} label="" />}
    </div>
  )
}

function Section({ icon: Icon, title, children }) {
  return (
    <div className="rounded-md border border-surface-800 p-3">
      <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
        <Icon className="h-3.5 w-3.5" /> {title}
      </h4>
      <dl className="divide-y divide-surface-800/60">{children}</dl>
    </div>
  )
}

// `details`/`justification` are free-text on the backend (models/audit_log.go
// stores them as `text` columns) but frequently carry a JSON-encoded blob in
// practice, pretty-print when parseable, fall back to the raw string
// otherwise rather than showing a wall of unformatted JSON.
function DetailsBlock({ label, raw }) {
  if (!raw) return null
  let display = raw
  try {
    display = JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // not JSON, show as-is
  }
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-ink-400">{label}</p>
      <pre className="max-h-48 overflow-auto rounded-md bg-surface-950/60 p-2 text-xs text-ink-300">
        {display}
      </pre>
    </div>
  )
}

export function AuditEventDetailModal({ event, onClose }) {
  useEffect(() => {
    if (!event) return undefined
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [event, onClose])

  if (!event) return null

  const ts = event.occurred_at || event.created_at || event.timestamp
  const actor = event.username || event.actor_username || event.actor_id || event.user_id
  const target = event.resource_name || event.resource || event.resource_id || event.target

  return (
    <div
      className="animate-overlay-in fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/55 p-4 backdrop-blur-[3px] dark:bg-black/70"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="animate-panel-in my-auto max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-overlay">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink-50">
              <span className="text-ink-400">{event.category || 'OTHER'}</span>
              <span>{event.action || '-'}</span>
            </h3>
            <p className="mt-1 text-xs text-ink-500">{formatDateTime(ts)}</p>
          </div>
          <div className="flex flex-none items-center gap-2">
            {event.outcome && (
              <Badge
                className={AUDIT_OUTCOME_BADGE[event.outcome] || 'bg-ink-500/15 text-ink-400 ring-ink-500/30'}
              >
                {event.outcome}
              </Badge>
            )}
            {event.severity && (
              <Badge
                className={
                  AUDIT_SEVERITY_BADGE[event.severity] || 'bg-ink-500/15 text-ink-400 ring-ink-500/30'
                }
              >
                {event.severity}
              </Badge>
            )}
            <button onClick={onClose} className="text-ink-500 hover:text-ink-200" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <Section icon={User} title="Actor">
            <Row label="Username" value={actor} />
            <Row label="Email" value={event.email} />
            <Row label="User ID" value={event.user_id} mono copyable />
            <Row label="Actor type" value={event.actor_type} />
            <Row label="Service" value={event.service_name} />
          </Section>

          <Section icon={Target} title="Target">
            <Row label="Resource" value={target} />
            <Row label="Resource type" value={event.resource_type} />
            <Row label="Resource ID" value={event.resource_id} mono copyable />
          </Section>

          <Section icon={Link2} title="Context">
            <Row label="Source IP" value={event.source_ip} mono />
            <Row label="Request ID" value={event.request_id} mono copyable />
            <Row label="Session ID" value={event.session_id} mono copyable />
            <Row label="Grant ID" value={event.grant_id} mono copyable />
            <Row label="Authz decision" value={event.authz_decision_id} mono copyable />
            <Row label="User agent" value={event.user_agent} mono />
          </Section>

          {(event.prev_hash || event.entry_hash || event.sequence_number != null) && (
            <Section icon={ShieldCheck} title="Chain integrity">
              <Row label="Sequence #" value={event.sequence_number} mono />
              <Row label="Entry hash" value={event.entry_hash} mono copyable />
              <Row label="Prev hash" value={event.prev_hash} mono copyable />
              <Row label="Hash version" value={event.hash_version} />
            </Section>
          )}

          {(event.details || event.justification) && (
            <div className="space-y-3 rounded-md border border-surface-800 p-3">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                <FileText className="h-3.5 w-3.5" /> Details
              </h4>
              <DetailsBlock label="Justification" raw={event.justification} />
              <DetailsBlock label="Details" raw={event.details} />
            </div>
          )}

          <div className="flex items-center justify-between pt-1 text-xs text-ink-500">
            <span>
              Event ID: <span className="font-mono text-ink-400">{event.id || '-'}</span>
            </span>
            {event.id && <CopyButton value={event.id} label="Copy ID" />}
          </div>
        </div>
      </div>
    </div>
  )
}
