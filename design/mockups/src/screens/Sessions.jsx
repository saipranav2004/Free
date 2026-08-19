import { useMemo, useState } from 'react'
import { Radio, Video, VideoOff, X } from 'lucide-react'
import { useViewer } from '../state/viewer'
import { sessions } from '../fixtures'
import {
  BreakglassTag, Button, DetailList, FilterChip, Meta, PageHeader, Panel,
  RuledLabel, Section, Segmented, StatusDot,
} from '../ui/primitives'
import { COL, DataTable, RowActions, Td, Th, Tr, Trunc } from '../ui/table'
import { EmptyState, FreshnessMarker } from '../ui/states'
import { dateTime, duration, relative, SESSION_TONE } from '../lib/format'

// ===========================================================================
// Sessions
// ===========================================================================
// WHAT CHANGED
//
//  • The KPI strip is gone. On a page whose entire value is a live table, a
//    strip of counts above it pushes the instrument below the fold. The counts
//    that mattered (how many live, how many unrecorded, how many break-glass)
//    are now the FILTER CHIPS — same numbers, and clicking them does something.
//  • "Mine / All" stops being a control a normal user has to understand. A
//    normal user has exactly one scope (GET /sessions/mine), so the switch
//    does not render for them at all.
//  • `is_breakglass` and `recording_required` become facets, because
//    "show me every unrecorded privileged session right now" is the real
//    operator question and the current build can only answer it by eye.
//  • Liveness is stated honestly: the backend has no push channel
//    (SESSIONS_POLL_MS = 15000), so the header says when we last looked
//    instead of implying a stream. (Datadog Live Processes.)
//
// ACTIONS → ENDPOINTS
//   End (own session)  → POST /pam/sessions/:id/end
//   Kill (any session) → POST /pam/admin/actions/sessions/:id/kill  (reason required)
// No bulk endpoint exists, so selecting rows offers a per-row progress list,
// never a single "Kill 6 sessions" button that implies one atomic call.

function SessionDrawer({ session, isAdmin, onClose }) {
  if (!session) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="anim-overlay absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <aside className="anim-drawer relative flex h-full w-full max-w-[30rem] flex-col border-l border-line bg-surface shadow-overlay">
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line px-4">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-primary">{session.resource_name}</p>
            <p className="truncate font-mono text-xs text-tertiary">{session.id}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto flex h-9 w-9 items-center justify-center rounded text-tertiary hover:bg-hover">
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <DetailList
            columns={2}
            items={[
              { label: 'User', value: session.username },
              { label: 'Status', value: session.status },
              { label: 'Protocol', value: session.protocol, mono: true },
              { label: 'Source IP', value: session.source_ip, mono: true },
              { label: 'Started', value: dateTime(session.started_at) },
              { label: 'Duration', value: duration(session.duration_seconds) },
              { label: 'Grant', value: session.grant_id, mono: true },
              { label: 'JIT request', value: session.jit_request_id, mono: true },
              { label: 'Recording', value: session.recording_id || (session.recording_required ? 'required, not started' : 'not required'), mono: !!session.recording_id },
              { label: 'Authz decision', value: session.authz_allowed ? 'allowed' : 'denied' },
            ]}
          />
          {session.kill_reason && (
            <>
              <RuledLabel className="mt-6">Termination</RuledLabel>
              <p className="text-base text-primary">{session.kill_reason}</p>
              <p className="mt-1 text-xs text-tertiary">by {session.killed_by} · {dateTime(session.ended_at)}</p>
            </>
          )}
        </div>
        {isAdmin && session.status === 'ACTIVE' && (
          <footer className="flex flex-none items-center gap-2 border-t border-line px-4 py-3">
            <Button variant="danger" size="lg">Kill session</Button>
            <p className="text-xs text-tertiary">A reason is required and is written to the audit log.</p>
          </footer>
        )}
      </aside>
    </div>
  )
}

export default function Sessions() {
  const { isAdmin, viewer } = useViewer()
  const [scope, setScope] = useState(isAdmin ? 'all' : 'mine')
  const [live, setLive] = useState(true)
  const [unrecordedOnly, setUnrecordedOnly] = useState(false)
  const [breakglassOnly, setBreakglassOnly] = useState(false)
  const [selected, setSelected] = useState([])
  const [open, setOpen] = useState(null)

  const base = useMemo(() => {
    // A normal user can only ever see their own: GET /pam/sessions/mine.
    const scoped = isAdmin && scope === 'all' ? sessions : sessions.filter((s) => s.user_id === viewer.user_id)
    return scoped
  }, [isAdmin, scope, viewer.user_id])

  const rows = useMemo(() => {
    let r = base
    if (live) r = r.filter((s) => s.status === 'ACTIVE')
    if (unrecordedOnly) r = r.filter((s) => !s.recording_id)
    if (breakglassOnly) r = r.filter((s) => s.is_breakglass)
    return r
  }, [base, live, unrecordedOnly, breakglassOnly])

  const liveCount = base.filter((s) => s.status === 'ACTIVE').length
  const unrecordedCount = base.filter((s) => s.status === 'ACTIVE' && !s.recording_id).length
  const bgCount = base.filter((s) => s.status === 'ACTIVE' && s.is_breakglass).length
  const filtered = unrecordedOnly || breakglassOnly

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <>
      <PageHeader
        title="Sessions"
        description={isAdmin ? 'Every connection open against the estate, and every one that has ended.' : 'Connections open in your name.'}
        actions={<FreshnessMarker />}
      />

      {/* The counts that used to be a KPI strip are these chips. Same numbers,
          and now each one is a question you can ask. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {isAdmin && (
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'Everyone' },
              { value: 'mine', label: 'Mine' },
            ]}
          />
        )}
        <FilterChip active={live} onClick={() => setLive(!live)} count={liveCount}>
          Live now
        </FilterChip>
        {isAdmin && (
          <>
            <FilterChip active={unrecordedOnly} onClick={() => setUnrecordedOnly(!unrecordedOnly)} count={unrecordedCount}>
              Unrecorded
            </FilterChip>
            <FilterChip active={breakglassOnly} onClick={() => setBreakglassOnly(!breakglassOnly)} count={bgCount}>
              Break-glass
            </FilterChip>
          </>
        )}
        <span className="ml-auto text-xs text-tertiary tabular">
          {rows.length} of {base.length}
        </span>
      </div>

      {/* Selection: per-item, never implied-atomic (no bulk endpoint exists). */}
      {selected.length > 0 && (
        <Panel className="mb-4 flex flex-wrap items-center gap-3 px-4 py-2">
          <span className="text-sm font-semibold text-primary tabular">{selected.length} selected</span>
          <Button size="sm" variant="dangerQuiet">Kill each…</Button>
          <span className="text-xs text-tertiary">
            There is no bulk endpoint — this issues one request per session and reports each result separately.
          </span>
          <button type="button" onClick={() => setSelected([])} className="ml-auto text-xs text-accent hover:underline">
            Clear
          </button>
        </Panel>
      )}

      {rows.length === 0 ? (
        <EmptyState
          variant={filtered || live ? 'no-match' : 'none-yet'}
          title={live ? 'Nothing is connected right now' : 'No sessions'}
          description={
            live
              ? 'No session is open against the estate at this moment. Turn off "Live now" to see history.'
              : 'Sessions appear here once someone connects to a resource.'
          }
          onClearFilters={() => {
            setLive(false)
            setUnrecordedOnly(false)
            setBreakglassOnly(false)
          }}
        />
      ) : (
        <DataTable minWidth={isAdmin ? '72rem' : '56rem'}>
          <thead>
            <tr>
              {isAdmin && <Th width={COL.select} sticky />}
              <Th width={COL.name} sticky left={isAdmin ? 'left-10' : 'left-0'} edge>
                Resource
              </Th>
              {isAdmin && <Th width={COL.medium}>User</Th>}
              <Th width={COL.short}>Protocol</Th>
              <Th width={COL.medium}>Source IP</Th>
              <Th width={COL.short} align="right">Duration</Th>
              <Th width={COL.short}>Recording</Th>
              <Th width={COL.timestamp} align="right">Started</Th>
              <Th width={COL.actions} align="right"><span className="sr-only">Actions</span></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const sel = selected.includes(s.id)
              return (
                <Tr key={s.id} selected={sel} onClick={() => setOpen(s)}>
                  {isAdmin && (
                    <Td selected={sel} sticky>
                      <input
                        type="checkbox"
                        checked={sel}
                        onChange={() => toggle(s.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select session ${s.id}`}
                        className="h-4 w-4 accent-[rgb(var(--accent))]"
                      />
                    </Td>
                  )}
                  <Td selected={sel} sticky left={isAdmin ? 'left-10' : 'left-0'} edge>
                    <div className="flex items-center gap-2">
                      <StatusDot tone={SESSION_TONE[s.status]} live={s.status === 'ACTIVE'} />
                      <Trunc value={s.resource_name} />
                      {s.is_breakglass && <BreakglassTag />}
                    </div>
                    <Meta className="block truncate pl-4">{s.resource_type}</Meta>
                  </Td>
                  {isAdmin && <Td selected={sel}><Trunc value={s.username} /></Td>}
                  <Td selected={sel}><Trunc value={s.protocol} mono /></Td>
                  <Td selected={sel}><Trunc value={s.source_ip} mono /></Td>
                  <Td selected={sel} align="right">{duration(s.duration_seconds)}</Td>
                  <Td selected={sel}>
                    {s.recording_id ? (
                      <span className="inline-flex items-center gap-2 text-sm">
                        <Video className="h-3.5 w-3.5 text-ok" strokeWidth={1.75} />
                        <span className="text-primary">Recording</span>
                      </span>
                    ) : s.recording_required ? (
                      <span className="inline-flex items-center gap-2 text-sm text-danger">
                        <VideoOff className="h-3.5 w-3.5" strokeWidth={1.75} />
                        Required, missing
                      </span>
                    ) : (
                      <Meta>Not required</Meta>
                    )}
                  </Td>
                  <Td selected={sel} align="right">
                    <span className="text-secondary">{relative(s.started_at)}</span>
                  </Td>
                  <Td selected={sel} align="right">
                    <RowActions>
                      {s.status === 'ACTIVE' &&
                        (s.user_id === viewer.user_id ? (
                          <Button size="sm" onClick={(e) => e.stopPropagation()}>End</Button>
                        ) : isAdmin ? (
                          <Button size="sm" variant="dangerQuiet" onClick={(e) => e.stopPropagation()}>Kill</Button>
                        ) : null)}
                    </RowActions>
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </DataTable>
      )}

      {isAdmin && unrecordedCount > 0 && (
        <Section title="Why the unrecorded filter matters">
          <p className="max-w-prose text-base text-secondary">
            A session carries <span className="font-mono text-sm text-primary">recording_required</span> from its
            grant and its resource&apos;s <span className="font-mono text-sm text-primary">always_record</span> flag. A
            live session where that is true but <span className="font-mono text-sm text-primary">recording_id</span> is
            null is a privileged connection with no tape — that is the one row on this page worth interrupting
            someone for.
          </p>
        </Section>
      )}

      <SessionDrawer session={open} isAdmin={isAdmin} onClose={() => setOpen(null)} />
    </>
  )
}
