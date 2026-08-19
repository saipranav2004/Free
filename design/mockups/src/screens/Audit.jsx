import { useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  CheckCircle2, Download, FileText, Play, Search, ShieldCheck, X,
} from 'lucide-react'
import { useViewer } from '../state/viewer'
import { auditEvents, auditVerification, recordings } from '../fixtures'
import {
  AlarmBand, BreakglassTag, Button, DetailList, FilterChip, HeroMetric, Meta,
  PageHeader, Panel, RuledLabel, Section, StatRail, StatusDot, inputClass,
} from '../ui/primitives'
import { COL, DataTable, RowActions, Td, Th, Tr, Trunc } from '../ui/table'
import { DeniedState, EmptyState } from '../ui/states'
import { bytes, dateTime, duration, OUTCOME_TONE, relative } from '../lib/format'

// ===========================================================================
// Audit — split into three sibling routes
// ===========================================================================
// The current /admin/audit does four jobs behind two tabs: search events,
// browse recordings, verify the hash chain, and generate compliance reports.
// Those are three different users on three different days.
//
//   /activity          — the SELF-SCOPED trail (fixes the orphaned /audit
//                        route AND the fact that "your activity" currently
//                        renders the whole org's events)
//   /admin/audit       — org-wide search + recordings (Datadog Logs model)
//   /admin/compliance  — chain verification + report generation
//
// WHAT CHANGED in the search view
//  • Facets move to a persistent LEFT RAIL. The current filter bar sits above
//    the table, so opening it pushes the results down and they move under you.
//    Datadog's rail keeps the results still while you narrow them.
//  • The event stream is a dense table, not a card list.
//  • Chain integrity gets the compliance headline it deserves — AuditLog
//    carries prev_hash / entry_hash / sequence_number and
//    GET /admin/audit/verify returns a real verification.
//
// ENDPOINTS
//   GET  /pam/audit                      (q, user_id, category, action, outcome,
//                                         resource, source_ip, from, to, limit,
//                                         offset, sort — all real query params)
//   GET  /pam/admin/audit                (org-wide, paged)
//   GET  /pam/admin/recordings
//   GET  /pam/admin/audit/verify
//   POST /pam/audit/report               (returns a file; MFA-gated)

const CATEGORIES = ['AUTH', 'AUTHZ', 'VAULT', 'SESSION', 'RESOURCE', 'BREAK_GLASS', 'ADMIN', 'REPORT']
const OUTCOMES = ['SUCCESS', 'DENIED', 'ERROR', 'PENDING']

function EventDrawer({ event, onClose }) {
  if (!event) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="anim-overlay absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <aside className="anim-drawer relative flex h-full w-full max-w-[32rem] flex-col border-l border-line bg-surface shadow-overlay">
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line px-4">
          <div className="min-w-0">
            <p className="truncate font-mono text-sm font-semibold text-primary">{event.action}</p>
            <p className="truncate text-xs text-tertiary">seq {event.sequence_number}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto flex h-9 w-9 items-center justify-center rounded text-tertiary hover:bg-hover">
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <DetailList
            columns={2}
            items={[
              { label: 'Outcome', value: <StatusDot tone={OUTCOME_TONE[event.outcome]} label={event.outcome} /> },
              { label: 'Severity', value: event.severity },
              { label: 'Category', value: event.category },
              { label: 'Actor type', value: event.actor_type },
              { label: 'Actor', value: event.username },
              { label: 'Email', value: event.email, mono: true },
              { label: 'Resource', value: event.resource, mono: true },
              { label: 'Source IP', value: event.source_ip, mono: true },
              { label: 'Occurred', value: dateTime(event.occurred_at) },
              { label: 'Request ID', value: event.request_id, mono: true },
            ]}
          />

          {/* Tamper evidence, in the drawer, per event. This is what makes the
              trail worth having and it is currently invisible. */}
          <RuledLabel className="mt-8">Chain</RuledLabel>
          <DetailList
            items={[
              { label: 'Sequence', value: event.sequence_number, mono: true },
              { label: 'Previous hash', value: event.prev_hash, mono: true },
              { label: 'Entry hash', value: event.entry_hash, mono: true },
              { label: 'Hash version', value: event.hash_version },
            ]}
          />
          <p className="mt-3 max-w-prose text-xs text-tertiary">
            Each entry hashes the one before it. Changing any past record breaks every hash after it, which is
            what <span className="font-mono text-primary">GET /admin/audit/verify</span> checks.
          </p>
        </div>
      </aside>
    </div>
  )
}

// The shared search surface. `scope` decides which endpoint answers and
// whether the actor facet exists at all.
function EventSearch({ scope, viewer }) {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState(null)
  const [outcome, setOutcome] = useState(null)
  const [open, setOpen] = useState(null)

  const source = useMemo(
    // Self scope sends user_id — the parameter the endpoint already accepts and
    // the current build never sets.
    () => (scope === 'self' ? auditEvents.filter((e) => e.user_id === viewer.user_id) : auditEvents),
    [scope, viewer.user_id]
  )

  const rows = useMemo(() => {
    let r = source
    if (q) {
      const s = q.toLowerCase()
      r = r.filter((e) => e.action.toLowerCase().includes(s) || e.username.toLowerCase().includes(s) || e.resource.toLowerCase().includes(s))
    }
    if (category) r = r.filter((e) => e.category === category)
    if (outcome) r = r.filter((e) => e.outcome === outcome)
    return r
  }, [source, q, category, outcome])

  const filtered = !!q || !!category || !!outcome
  const clear = () => { setQ(''); setCategory(null); setOutcome(null) }
  const denied = rows.filter((e) => e.outcome === 'DENIED' || e.outcome === 'ERROR').length

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* Persistent facet rail. Filtering never moves the results. */}
      <aside className="w-full flex-none lg:w-[13rem]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" strokeWidth={1.75} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Free text"
            aria-label="Search the audit trail"
            className={clsx(inputClass, 'pl-7')}
          />
        </div>

        <RuledLabel className="mt-6">Category</RuledLabel>
        <div className="flex flex-wrap gap-1">
          {CATEGORIES.map((c) => {
            const n = source.filter((e) => e.category === c).length
            if (n === 0) return null
            return (
              <FilterChip key={c} active={category === c} onClick={() => setCategory(category === c ? null : c)} count={n}>
                {c}
              </FilterChip>
            )
          })}
        </div>

        <RuledLabel className="mt-6">Outcome</RuledLabel>
        <div className="flex flex-wrap gap-1">
          {OUTCOMES.map((o) => {
            const n = source.filter((e) => e.outcome === o).length
            if (n === 0) return null
            return (
              <FilterChip key={o} active={outcome === o} onClick={() => setOutcome(outcome === o ? null : o)} count={n}>
                {o}
              </FilterChip>
            )
          })}
        </div>

        {filtered && (
          <Button size="sm" className="mt-6" onClick={clear}>
            Clear filters
          </Button>
        )}
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <span className="text-sm text-secondary tabular">
            <span className="font-semibold text-primary">{rows.length.toLocaleString()}</span> events
          </span>
          {denied > 0 && (
            <span className="text-sm text-danger tabular">
              <span className="font-semibold">{denied}</span> denied or errored
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" icon={Download}>Export CSV</Button>
          </span>
        </div>

        {rows.length === 0 ? (
          <EmptyState variant={filtered ? 'no-match' : 'none-yet'} onClearFilters={clear} description={filtered ? 'Nothing matches. Widen the range or drop a facet.' : 'No events recorded yet.'} />
        ) : (
          <DataTable minWidth="52rem">
            <thead>
              <tr>
                <Th width={COL.wide} sticky edge>Action</Th>
                {scope !== 'self' && <Th width={COL.medium}>Actor</Th>}
                <Th width={COL.medium}>Resource</Th>
                <Th width={COL.short}>Category</Th>
                <Th width={COL.medium}>Source IP</Th>
                <Th width={COL.timestamp} align="right">When</Th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 40).map((e) => (
                <Tr key={e.id} onClick={() => setOpen(e)}>
                  <Td sticky edge>
                    <span className="flex items-center gap-2">
                      <StatusDot tone={OUTCOME_TONE[e.outcome]} />
                      <Trunc value={e.action} mono />
                    </span>
                  </Td>
                  {scope !== 'self' && <Td><Trunc value={e.username} /></Td>}
                  <Td><Trunc value={e.resource} mono muted /></Td>
                  <Td><Trunc value={e.category} muted /></Td>
                  <Td><Trunc value={e.source_ip} mono muted /></Td>
                  <Td align="right"><span className="text-tertiary">{relative(e.occurred_at)}</span></Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
        )}
        <p className="mt-3 text-xs text-tertiary">
          Showing the first 40 of {rows.length.toLocaleString()}. The endpoint pages with limit/offset and caps a
          single call at 500 rows.
        </p>
      </div>

      <EventDrawer event={open} onClose={() => setOpen(null)} />
    </div>
  )
}

// ── /activity — the self-scoped trail ─────────────────────────────────────
export function MyActivity() {
  const { viewer } = useViewer()
  return (
    <>
      <PageHeader
        title="My activity"
        description="Everything recorded against your account: sign-ins, connections, reveals, requests."
      />
      <Panel className="mb-6 flex items-start gap-3 px-4 py-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
        <p className="max-w-prose text-base text-secondary">
          Scoped to <span className="font-mono text-sm text-primary">{viewer.username}</span> by sending{' '}
          <span className="font-mono text-sm text-primary">user_id</span> on the query. The endpoint accepts it;
          the current console never sends it, which is why today&apos;s &ldquo;your activity&rdquo; panel shows the
          whole organisation&apos;s events.
        </p>
      </Panel>
      <EventSearch scope="self" viewer={viewer} />
    </>
  )
}

// ── /admin/audit — org-wide events + recordings ───────────────────────────
export function AdminAudit() {
  const { isAdmin, viewer } = useViewer()
  const [tab, setTab] = useState('events')
  if (!isAdmin) return <DeniedState requires="admin" what="the organisation audit trail" fallbackHref="/activity" fallbackLabel="See your own activity" />

  return (
    <>
      <PageHeader
        eyebrow="Admin Center"
        title="Audit"
        description="Every action taken in this organisation, hash-chained in sequence."
        actions={
          <div className="inline-flex rounded border border-line p-0.5">
            {[
              ['events', 'Events'],
              ['recordings', `Recordings (${recordings.length})`],
            ].map(([v, l]) => (
              <button
                key={v}
                type="button"
                onClick={() => setTab(v)}
                className={clsx('h-7 rounded-sm px-3 text-sm font-semibold', tab === v ? 'bg-subtle text-primary' : 'text-tertiary hover:text-primary')}
              >
                {l}
              </button>
            ))}
          </div>
        }
      />

      {tab === 'events' ? (
        <EventSearch scope="org" viewer={viewer} />
      ) : (
        <>
          <DataTable minWidth="66rem">
            <thead>
              <tr>
                <Th width={COL.name} sticky edge>Resource</Th>
                <Th width={COL.medium}>User</Th>
                <Th width={COL.short} align="right">Duration</Th>
                <Th width={COL.short} align="right">Size</Th>
                <Th width={COL.wide}>Integrity</Th>
                <Th width={COL.timestamp} align="right">Started</Th>
                <Th width={COL.actions} align="right"><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {recordings.map((r) => (
                <Tr key={r.id}>
                  <Td sticky edge>
                    <span className="flex items-center gap-2">
                      <StatusDot tone={r.status === 'RECORDING' ? 'ok' : 'neutral'} live={r.status === 'RECORDING'} />
                      <Trunc value={r.resource_name} />
                      {r.is_breakglass && <BreakglassTag />}
                    </span>
                  </Td>
                  <Td><Trunc value={r.username} /></Td>
                  <Td align="right">{duration(r.duration_seconds)}</Td>
                  <Td align="right">{bytes(r.size_bytes)}</Td>
                  <Td><Trunc value={r.sha256} mono muted /></Td>
                  <Td align="right"><span className="text-tertiary">{relative(r.started_at)}</span></Td>
                  <Td align="right">
                    <RowActions>
                      <Button size="sm" icon={Play}>Play</Button>
                    </RowActions>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </DataTable>
          <p className="mt-3 max-w-prose text-xs text-tertiary">
            Recordings are <span className="font-mono text-primary">asciicast</span> terminal captures with a
            SHA-256 over the stored object, so a recording can be proved unmodified independently of the audit
            chain. A live one keeps growing until the session ends.
          </p>
        </>
      )}
    </>
  )
}

// ── /admin/compliance — chain verification + reports ──────────────────────
// Split out of the audit page because it is a different job on a different
// day: an auditor asking "can you prove this trail is intact and give me a
// report", not an operator searching for an event.
export function Compliance() {
  const { isAdmin } = useViewer()
  const v = auditVerification
  if (!isAdmin) return <DeniedState requires="admin" what="compliance reporting" fallbackHref="/activity" fallbackLabel="See your own activity" />

  return (
    <>
      <PageHeader
        eyebrow="Admin Center"
        title="Compliance"
        description="Prove the trail is intact, and produce the evidence someone else can check."
      />

      <HeroMetric
        label="Audit chain"
        value={v.verified ? 'Intact' : 'Broken'}
        tone={v.verified ? 'ok' : 'danger'}
        caption={`${v.entries_checked.toLocaleString()} entries verified, sequence ${v.first_sequence.toLocaleString()}–${v.last_sequence.toLocaleString()} · last checked ${relative(v.verified_at)}`}
        action={<Button variant="primary" size="lg" icon={ShieldCheck}>Re-verify now</Button>}
      />

      {!v.verified && (
        <div className="mt-6">
          <AlarmBand>Chain broken at sequence {v.broken_at}. Every entry after it is suspect.</AlarmBand>
        </div>
      )}

      <StatRail
        className="mt-6"
        items={[
          { label: 'Entries', value: v.entries_checked.toLocaleString() },
          { label: 'First sequence', value: v.first_sequence.toLocaleString() },
          { label: 'Last sequence', value: v.last_sequence.toLocaleString() },
        ]}
      />

      <Section title="How this works">
        <p className="max-w-prose text-base text-secondary">
          Every audit entry stores the hash of the entry before it
          (<span className="font-mono text-sm text-primary">prev_hash</span>) and a hash of itself
          (<span className="font-mono text-sm text-primary">entry_hash</span>). Verification walks the sequence and
          recomputes both. Editing or deleting any past row breaks every hash after it, so tampering cannot be
          hidden — only detected. That property is the reason this console can be used as evidence.
        </p>
      </Section>

      <Section
        title="Reports"
        description="A compliance report over a time window and a set of filters. Generation is MFA-gated and is itself audited as pam:report:Generate."
      >
        <Panel className="p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="from" className="mb-2 block text-micro font-semibold uppercase text-tertiary">From</label>
              <input id="from" type="date" className={inputClass} />
            </div>
            <div>
              <label htmlFor="to" className="mb-2 block text-micro font-semibold uppercase text-tertiary">To</label>
              <input id="to" type="date" className={inputClass} />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={FileText}>Generate report</Button>
            <Meta>Returns a file. Large windows take a while — the request streams rather than paging.</Meta>
          </div>
        </Panel>
      </Section>

      <Section title="Break-glass reports" description="Every break-glass grant can produce a standalone report of what was done under it.">
        <p className="max-w-prose text-base text-secondary">
          From <span className="font-mono text-sm text-primary">GET /admin/breakglass</span> and{' '}
          <span className="font-mono text-sm text-primary">GET /admin/breakglass/:grant_id/report</span>. These are
          the two endpoints an incident review actually asks for, and the current console surfaces neither
          prominently.
        </p>
        <div className="mt-4">
          <Button icon={FileText}>Open break-glass register</Button>
        </div>
      </Section>
    </>
  )
}
