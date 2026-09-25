import { useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  User,
  Crosshair,
  Link2,
  ShieldCheck,
  FileText,
  Filter,
  Copy,
  Check,
  Fingerprint,
  Globe,
  Clock,
  ChevronDown,
  Braces,
} from 'lucide-react'
import { Drawer } from '../common/Drawer'
import { Badge, MetaTag } from '../common/Badge'
import { Button } from '../common/Button'
import { formatDateTime, formatDateTimeUTC } from '../../lib/format'
import { eventTime, eventActor, eventTarget, eventId, isFailure } from './auditFields'
import { AUDIT_OUTCOME_BADGE } from '../../config/constants'

// ---------------------------------------------------------------------------
// Audit event detail
// ---------------------------------------------------------------------------
// REBUILT AROUND HOW THIS IS ACTUALLY READ. The previous version dumped every
// populated field as an undifferentiated key/value list, so the two questions
// an investigator opens an entry to answer ,
//
//     "what happened, and did it succeed?" and   "who did it, to what?"
//
//, were buried among request IDs and hash values that matter only when you
// are already deep in an investigation. Everything had equal weight, which
// means nothing had any.
//
// The structure now, top to bottom, is the order those questions get asked:
//
//   1. VERDICT   A tinted plate stating the outcome in words, not a badge in
// a corner. On a denial or a critical event this is the whole
// point of opening the row, so it is the first thing read.
//   2. SENTENCE actor → action → target as one line. This is the single
// most-copied fact from any audit entry, so it is also the
// one-click "copy summary".
//   3. FACTS     Actor / Target / Request context, each a compact block, with
// copy on every identifier.
//   4. EVIDENCE  Justification and details, pretty-printed.
//   5. CHAIN     Collapsed by default. Hash values are proof, not reading ,
// nobody scans them, and expanded they pushed everything else
// off the screen.
//
// Still a drawer, not a modal: reading a trail is open-read-close-next, and a
// centred dialog loses your place in a filtered, paged result set each time.

function CopyBtn({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(String(value))
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          /* clipboard unavailable, the value is still selectable on screen */
        }
      }}
      className="flex h-6 w-6 flex-none items-center justify-center rounded text-ink-600 opacity-0 transition-all duration-150 hover:bg-surface-800 hover:text-ink-200 focus-visible:opacity-100 group-hover/row:opacity-100"
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
      ) : (
        <Copy className="h-3 w-3" strokeWidth={1.75} />
      )}
    </button>
  )
}

function Fact({ label, value, mono, copyable }) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  return (
    <div className="group/row flex items-start gap-3 px-4 py-1.5">
      <dt className="w-[7.5rem] flex-none pt-px text-2xs font-medium uppercase tracking-[0.06em] text-ink-500">
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 items-start gap-1">
        <span
          className={clsx(
            'min-w-0 flex-1 break-all text-[0.8125rem] leading-relaxed text-ink-100',
            mono && 'font-mono text-xs'
          )}
        >
          {text}
        </span>
        {copyable && <CopyBtn value={text} label={`Copy ${label.toLowerCase()}`} />}
      </dd>
    </div>
  )
}

function Block({ icon: Icon, title, children }) {
  const kids = (Array.isArray(children) ? children : [children]).filter(Boolean)
  if (kids.length === 0) return null
  return (
    <section className="border-b border-surface-800">
      <h3 className="flex items-center gap-2 px-4 pb-1 pt-3.5 text-xs font-semibold text-ink-500">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} /> {title}
      </h3>
      <dl className="pb-2.5">{kids}</dl>
    </section>
  )
}

// Free-text columns that in practice carry JSON. Pretty-print when parseable,
// show raw otherwise, never a wall of escaped braces.
function Evidence({ label, raw }) {
  if (!raw) return null
  let display = String(raw)
  let isJson = false
  try {
    display = JSON.stringify(JSON.parse(raw), null, 2)
    isJson = true
  } catch {
    /* plain text */
  }
  return (
    <div className="px-4 pb-3">
      <div className="mb-1.5 flex items-center gap-2">
        <p className="text-2xs font-medium uppercase tracking-[0.06em] text-ink-500">{label}</p>
        {isJson && <MetaTag mono>json</MetaTag>}
        <span className="ml-auto">
          <CopyBtn value={display} label={`Copy ${label.toLowerCase()}`} />
        </span>
      </div>
      <pre
        className={clsx(
          'max-h-56 overflow-auto rounded-lg border border-surface-700 bg-surface-850 p-3 text-xs leading-relaxed text-ink-300',
          isJson ? 'font-mono' : 'whitespace-pre-wrap font-sans'
        )}
      >
        {display}
      </pre>
    </div>
  )
}

export function AuditEventDrawer({ event, onClose, onFilterActor, onFilterAction }) {
  const [chainOpen, setChainOpen] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)

  const summary = useMemo(() => {
    if (!event) return ''
    const parts = [
      formatDateTime(eventTime(event)),
      eventActor(event) || 'unknown actor',
      event.action || 'unknown action',
      eventTarget(event) ? `→ ${eventTarget(event)}` : null,
      event.outcome ? `[${event.outcome}]` : null,
    ].filter(Boolean)
    return parts.join('  ')
  }, [event])

  if (!event) return null

  const failed = isFailure(event)
  const actor = eventActor(event)
  const target = eventTarget(event)
  const id = eventId(event)
  const chained = event.entry_hash || event.prev_hash || event.sequence_number != null

  const verdict = failed
    ? {
        tone: 'red',
        title: `Action ${String(event.outcome || 'denied').toLowerCase()}`,
        note: 'The request was refused. In a PAM console a denial is usually policy working as intended.',
      }
    : { tone: 'emerald', title: 'Action succeeded', note: 'The request was authorized and carried out.' }

  return (
    <Drawer
      open={!!event}
      onClose={onClose}
      width="lg"
      icon={<Fingerprint className="h-4 w-4 text-ink-400" strokeWidth={1.75} />}
      title={event.action || 'Audit event'}
      subtitle={formatDateTime(eventTime(event))}
      footer={
        <>
          {onFilterActor && actor && (
            <Button size="sm" variant="secondary" icon={Filter} onClick={() => onFilterActor(actor)}>
              By this actor
            </Button>
          )}
          {onFilterAction && event.action && (
            <Button size="sm" variant="secondary" icon={Filter} onClick={() => onFilterAction(event.action)}>
              Same action
            </Button>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              icon={Copy}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(summary)
                } catch {
                  /* clipboard unavailable */
                }
              }}
            >
              Copy summary
            </Button>
          </span>
        </>
      }
    >
      {/* 1. VERDICT. What happened, in words, before anything else. */}
      <div
        className={clsx(
          'flex items-start gap-3.5 border-b border-surface-800 px-4 py-4',
          verdict.tone === 'red' ? 'bg-red-50 dark:bg-red-950/20' : 'bg-emerald-50/60 dark:bg-emerald-950/15'
        )}
      >
        <span
          className={clsx(
            'flex h-9 w-9 flex-none items-center justify-center rounded-xl ring-1 ring-inset',
            verdict.tone === 'red'
              ? 'bg-red-100 text-red-600 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25'
              : 'bg-emerald-100 text-emerald-600 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25'
          )}
        >
          <ShieldCheck className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p
              className={clsx(
                'text-sm font-semibold',
                verdict.tone === 'red'
                  ? 'text-red-800 dark:text-red-200'
                  : 'text-emerald-800 dark:text-emerald-200'
              )}
            >
              {verdict.title}
            </p>
            {event.outcome && <Badge className={AUDIT_OUTCOME_BADGE[event.outcome]}>{event.outcome}</Badge>}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">{verdict.note}</p>
        </div>
      </div>

      {/* 2. SENTENCE. actor → action → target, the fact people quote. */}
      <div className="border-b border-surface-800 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
          <span className="font-medium text-ink-50">{actor || 'Unknown actor'}</span>
          <span className="text-ink-500">performed</span>
          <span className="rounded border border-surface-700 bg-surface-850 px-1.5 py-0.5 font-mono text-xs font-medium text-ink-100">
            {event.action || '-'}
          </span>
          {target && (
            <>
              <span className="text-ink-500">on</span>
              <span className="min-w-0 truncate font-medium text-ink-100" title={target}>
                {target}
              </span>
            </>
          )}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-2xs text-ink-500">
          <MetaTag>{event.category || 'OTHER'}</MetaTag>
          {/* Local for the reader, UTC beside it for the record. An audit
              event quoted in a ticket or compared across two offices needs one
              instant both people agree on, and the local rendering alone
              silently means something different to each of them. */}
          <span className="flex items-center gap-1.5">
            <Clock className="h-3 w-3" strokeWidth={1.75} />
            {formatDateTime(eventTime(event))}
          </span>
          <span className="font-mono text-ink-500">{formatDateTimeUTC(eventTime(event))}</span>
          {event.source_ip && (
            <span className="flex items-center gap-1.5 font-mono">
              <Globe className="h-3 w-3" strokeWidth={1.75} />
              {event.source_ip}
            </span>
          )}
          {event.sequence_number != null && <span className="font-mono">seq #{event.sequence_number}</span>}
        </div>
      </div>

      {/* 3. FACTS. */}
      <Block icon={User} title="Actor">
        <Fact label="Username" value={actor} />
        <Fact label="Email" value={event.email} />
        <Fact label="User ID" value={event.user_id} mono copyable />
        <Fact label="Actor type" value={event.actor_type} />
        <Fact label="Service" value={event.service_name} />
      </Block>

      <Block icon={Crosshair} title="Target">
        <Fact label="Resource" value={target} />
        <Fact label="Type" value={event.resource_type} />
        <Fact label="Resource ID" value={event.resource_id} mono copyable />
      </Block>

      <Block icon={Link2} title="Request context">
        <Fact label="Source IP" value={event.source_ip} mono copyable />
        <Fact label="Request ID" value={event.request_id} mono copyable />
        <Fact label="Session ID" value={event.session_id} mono copyable />
        <Fact label="Grant ID" value={event.grant_id} mono copyable />
        <Fact label="Authz decision" value={event.authz_decision_id} mono copyable />
        <Fact label="User agent" value={event.user_agent} />
        <Fact label="Event ID" value={id} mono copyable />
      </Block>

      {/* 4. EVIDENCE. */}
      {(event.justification || event.details) && (
        <section className="border-b border-surface-800">
          <h3 className="flex items-center gap-2 px-4 pb-2 pt-3.5 text-xs font-semibold text-ink-500">
            <FileText className="h-3.5 w-3.5" strokeWidth={1.75} /> Recorded detail
          </h3>
          <Evidence label="Justification" raw={event.justification} />
          <Evidence label="Details" raw={event.details} />
        </section>
      )}

      {/* 5. CHAIN, collapsed. Proof, not reading. */}
      {chained && (
        <section className="border-b border-surface-800">
          <button
            type="button"
            onClick={() => setChainOpen((v) => !v)}
            aria-expanded={chainOpen}
            className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-850"
          >
            <ShieldCheck className="h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
            <span className="text-xs font-semibold text-ink-500">Chain integrity</span>
            <span className="text-2xs text-ink-600">tamper-evidence hashes</span>
            <ChevronDown
              className={clsx(
                'ml-auto h-3.5 w-3.5 flex-none text-ink-500 transition-transform duration-200',
                chainOpen && 'rotate-180'
              )}
              strokeWidth={2}
            />
          </button>
          {chainOpen && (
            <dl className="pb-2.5">
              <Fact label="Sequence" value={event.sequence_number} mono />
              <Fact label="Entry hash" value={event.entry_hash} mono copyable />
              <Fact label="Previous hash" value={event.prev_hash} mono copyable />
              <Fact label="Hash version" value={event.hash_version} />
            </dl>
          )}
        </section>
      )}

      {/* Escape hatch: the whole record, for anyone pasting into a ticket. */}
      <section>
        <button
          type="button"
          onClick={() => setRawOpen((v) => !v)}
          aria-expanded={rawOpen}
          className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-850"
        >
          <Braces className="h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
          <span className="text-xs font-semibold text-ink-500">Raw record</span>
          <ChevronDown
            className={clsx(
              'ml-auto h-3.5 w-3.5 flex-none text-ink-500 transition-transform duration-200',
              rawOpen && 'rotate-180'
            )}
            strokeWidth={2}
          />
        </button>
        {rawOpen && (
          <div className="px-4 pb-4">
            <div className="mb-1.5 flex justify-end">
              <CopyBtn value={JSON.stringify(event, null, 2)} label="Copy raw record" />
            </div>
            <pre className="max-h-72 overflow-auto rounded-lg border border-surface-700 bg-surface-850 p-3 font-mono text-xs leading-relaxed text-ink-300">
              {JSON.stringify(event, null, 2)}
            </pre>
          </div>
        )}
      </section>
    </Drawer>
  )
}
