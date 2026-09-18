import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Video, VideoOff, X } from 'lucide-react'
import { useViewer } from '../state/viewer'
import { sessions } from '../fixtures'
import {
  BreakglassTag, Button, DetailList, FilterChip, Meta, PageHeader, Panel,
  RuledLabel, Section, Segmented, StatusDot,
} from '../ui/primitives'
import {
  COL, DataTable, RowActions, RowCheckbox, SelectAll, SortTh, Td, Th, Tr, Trunc,
  nextSort, sortRows,
} from '../ui/table'
import {
  ActiveFilters, BulkBar, CommandBar, ExportMenu, Pagination, PreferencesMenu,
  RefreshControl, RowMenu, usePaging,
} from '../ui/listchrome'
import { ConfirmDialog, MenuItem, useToast } from '../ui/overlay'
import { EmptyState } from '../ui/states'
import { dateTime, duration, relative, SESSION_TONE } from '../lib/format'

// ===========================================================================
// Sessions
// ===========================================================================
// REVISION 2 — what changed since pass 1, and why.
//
//  • A COMMAND BAR replaces scattered header buttons: primary action left,
//    view utilities right, filters on their own row beneath. This is the
//    AWS Console / Azure Portal / Salesforce convention and it is the single
//    biggest reason pass 1 read as "nice admin template" rather than
//    "enterprise console" — an enterprise list has a command surface, not a
//    header with three buttons in it.
//  • Sort, pagination, column chooser, export and density are back. All five
//    exist in the app being redesigned (TableControls.jsx). Dropping them in
//    pass 1 was a regression dressed as restraint.
//  • Row actions are always visible. Hover-reveal fails on touch, fails for
//    keyboard, and makes a list un-scannable.
//  • Rows are 32px (26px compact), not 36px. An operator watching a live
//    estate sees ~20 rows per screen instead of ~14.
//
// ACTIONS → ENDPOINTS
//   End   → POST /pam/sessions/:id/end
//   Kill  → POST /pam/admin/actions/sessions/:id/kill   (reason required)
// No bulk endpoint exists, so bulk kill is an explicit per-item loop with a
// per-item result — never one toast implying atomicity.

const ALL_COLUMNS = [
  { key: 'resource', label: 'Resource', locked: true },
  { key: 'user', label: 'User' },
  { key: 'protocol', label: 'Protocol' },
  { key: 'source_ip', label: 'Source IP' },
  { key: 'duration', label: 'Duration' },
  { key: 'recording', label: 'Recording' },
  { key: 'started', label: 'Started' },
  { key: 'grant', label: 'Grant' },
]

function SessionDrawer({ session, isAdmin, onClose, onKill }) {
  if (!session) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="anim-overlay absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
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
              { label: 'Status', value: <StatusDot tone={SESSION_TONE[session.status]} live={session.status === 'ACTIVE'} label={session.status} /> },
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
            <Button variant="danger" size="lg" onClick={() => onKill(session)}>Kill session</Button>
            <Meta>A reason is required and is written to the audit log.</Meta>
          </footer>
        )}
      </aside>
    </div>
  )
}

export default function Sessions() {
  const { isAdmin, viewer } = useViewer()
  const toast = useToast()
  const [scope, setScope] = useState(isAdmin ? 'all' : 'mine')
  const [live, setLive] = useState(true)
  const [unrecordedOnly, setUnrecordedOnly] = useState(false)
  const [breakglassOnly, setBreakglassOnly] = useState(false)
  const [selected, setSelected] = useState([])
  const [open, setOpen] = useState(null)
  const [sort, setSort] = useState({ key: 'started', dir: 'desc' })
  const [visible, setVisible] = useState(ALL_COLUMNS.filter((c) => c.key !== 'grant').map((c) => c.key))
  const [auto, setAuto] = useState(false)
  const [endTarget, setEndTarget] = useState(null)
  const [killTarget, setKillTarget] = useState(null)
  const [bulkResult, setBulkResult] = useState(null)

  const base = useMemo(
    () => (isAdmin && scope === 'all' ? sessions : sessions.filter((s) => s.user_id === viewer.user_id)),
    [isAdmin, scope, viewer.user_id]
  )

  const filtered = useMemo(() => {
    let r = base
    if (live) r = r.filter((s) => s.status === 'ACTIVE')
    if (unrecordedOnly) r = r.filter((s) => !s.recording_id)
    if (breakglassOnly) r = r.filter((s) => s.is_breakglass)
    return sortRows(r, sort, {
      resource: (s) => s.resource_name,
      user: (s) => s.username,
      duration: (s) => s.duration_seconds,
      started: (s) => s.started_at,
      recording: (s) => (s.recording_id ? 2 : s.recording_required ? 0 : 1),
    })
  }, [base, live, unrecordedOnly, breakglassOnly, sort])

  const paging = usePaging(filtered.length, 25)
  const rows = paging.slice(filtered)

  const liveCount = base.filter((s) => s.status === 'ACTIVE').length
  const unrecordedCount = base.filter((s) => s.status === 'ACTIVE' && !s.recording_id).length
  const bgCount = base.filter((s) => s.status === 'ACTIVE' && s.is_breakglass).length
  const anyFilter = unrecordedOnly || breakglassOnly

  const has = (k) => visible.includes(k)
  const toggleRow = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const onSort = (key) => setSort((s) => nextSort(s, key))

  const chips = [
    live && { label: 'Live now', onRemove: () => setLive(false) },
    unrecordedOnly && { label: 'Unrecorded', onRemove: () => setUnrecordedOnly(false) },
    breakglassOnly && { label: 'Break-glass', onRemove: () => setBreakglassOnly(false) },
    isAdmin && scope === 'mine' && { label: 'Mine only', onRemove: () => setScope('all') },
  ].filter(Boolean)

  return (
    <>
      <PageHeader
        title="Sessions"
        description={isAdmin ? 'Every connection open against the estate, and every one that has ended.' : 'Connections open in your name.'}
      />

      <CommandBar
        primary={
          isAdmin ? (
            <Segmented
              value={scope}
              onChange={setScope}
              options={[
                { value: 'all', label: 'Everyone' },
                { value: 'mine', label: 'Mine' },
              ]}
            />
          ) : null
        }
        summary={`${filtered.length.toLocaleString()} of ${base.length.toLocaleString()}`}
      >
        <RefreshControl auto={auto} onAutoChange={setAuto} onRefresh={() => toast({ title: 'Refreshed', tone: 'info' })} />
        <ExportMenu count={rows.length} />
        <PreferencesMenu
          columns={ALL_COLUMNS}
          visible={visible}
          onVisibleChange={setVisible}
          pageSize={paging.pageSize}
          onPageSize={paging.setPageSize}
        />
      </CommandBar>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterChip active={live} onClick={() => setLive(!live)} count={liveCount}>Live now</FilterChip>
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
      </div>

      <ActiveFilters
        chips={chips}
        onClearAll={() => {
          setLive(false)
          setUnrecordedOnly(false)
          setBreakglassOnly(false)
          if (isAdmin) setScope('all')
        }}
      />

      <BulkBar
        count={selected.length}
        result={bulkResult}
        onClear={() => {
          setSelected([])
          setBulkResult(null)
        }}
      >
        <Button
          size="sm"
          variant="dangerQuiet"
          onClick={() => {
            setBulkResult({ ok: selected.length - 1, failed: 1, total: selected.length, verb: 'killed' })
            setSelected([])
          }}
        >
          Kill each…
        </Button>
      </BulkBar>

      {rows.length === 0 ? (
        <EmptyState
          variant={anyFilter || live ? 'no-match' : 'none-yet'}
          title={live ? 'Nothing is connected right now' : 'No sessions'}
          description={
            live
              ? 'No session is open against the estate at this moment. Turn off “Live now” to see history.'
              : 'Sessions appear here once someone connects to a resource.'
          }
          onClearFilters={() => {
            setLive(false)
            setUnrecordedOnly(false)
            setBreakglassOnly(false)
          }}
        />
      ) : (
        <>
          <DataTable minWidth={isAdmin ? '66rem' : '52rem'}>
            <thead>
              <tr>
                {isAdmin && (
                  <Th width={COL.select} sticky>
                    <SelectAll
                      total={rows.length}
                      selected={selected.length}
                      onChange={(v) => setSelected(v === 'all' ? rows.map((r) => r.id) : [])}
                    />
                  </Th>
                )}
                <SortTh columnKey="resource" sort={sort} onSort={onSort} width={COL.name} sticky left={isAdmin ? 'left-9' : 'left-0'} edge>
                  Resource
                </SortTh>
                {isAdmin && has('user') && <SortTh columnKey="user" sort={sort} onSort={onSort} width={COL.medium}>User</SortTh>}
                {has('protocol') && <Th width={COL.short}>Protocol</Th>}
                {has('source_ip') && <Th width={COL.medium}>Source IP</Th>}
                {has('duration') && <SortTh columnKey="duration" sort={sort} onSort={onSort} align="right" width={COL.short}>Duration</SortTh>}
                {has('recording') && <SortTh columnKey="recording" sort={sort} onSort={onSort} width={COL.medium}>Recording</SortTh>}
                {has('grant') && <Th width={COL.medium}>Grant</Th>}
                {has('started') && <SortTh columnKey="started" sort={sort} onSort={onSort} align="right" width={COL.timestamp}>Started</SortTh>}
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
                        <RowCheckbox checked={sel} onChange={() => toggleRow(s.id)} label={`Select session ${s.id}`} />
                      </Td>
                    )}
                    <Td selected={sel} sticky left={isAdmin ? 'left-9' : 'left-0'} edge>
                      <div className="flex items-center gap-2">
                        <StatusDot tone={SESSION_TONE[s.status]} live={s.status === 'ACTIVE'} />
                        <Trunc value={s.resource_name} />
                        {s.is_breakglass && <BreakglassTag />}
                      </div>
                    </Td>
                    {isAdmin && has('user') && <Td selected={sel}><Trunc value={s.username} /></Td>}
                    {has('protocol') && <Td selected={sel}><Trunc value={s.protocol} mono muted /></Td>}
                    {has('source_ip') && <Td selected={sel}><Trunc value={s.source_ip} mono muted /></Td>}
                    {has('duration') && <Td selected={sel} align="right">{duration(s.duration_seconds)}</Td>}
                    {has('recording') && (
                      <Td selected={sel}>
                        {s.recording_id ? (
                          <span className="inline-flex items-center gap-2 text-sm">
                            <Video className="h-3.5 w-3.5 flex-none text-ok" strokeWidth={1.75} />
                            <span className="text-primary">On</span>
                          </span>
                        ) : s.recording_required ? (
                          <span className="inline-flex items-center gap-2 text-sm text-danger">
                            <VideoOff className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                            Missing
                          </span>
                        ) : (
                          <Meta>Not required</Meta>
                        )}
                      </Td>
                    )}
                    {has('grant') && <Td selected={sel}><Trunc value={s.grant_id} mono muted /></Td>}
                    {has('started') && (
                      <Td selected={sel} align="right"><span className="text-secondary">{relative(s.started_at)}</span></Td>
                    )}
                    <Td selected={sel} align="right">
                      <RowActions>
                        {s.user_id === viewer.user_id && s.status === 'ACTIVE' && (
                          <Button size="sm" onClick={(e) => { e.stopPropagation(); setEndTarget(s) }}>End</Button>
                        )}
                        <span onClick={(e) => e.stopPropagation()}>
                          <RowMenu label={`Actions for ${s.resource_name}`}>
                            <MenuItem onClick={() => setOpen(s)}>View details</MenuItem>
                            {s.recording_id && <MenuItem>Open recording</MenuItem>}
                            {isAdmin && s.status === 'ACTIVE' && s.user_id !== viewer.user_id && (
                              <MenuItem danger onClick={() => setKillTarget(s)}>Kill session…</MenuItem>
                            )}
                          </RowMenu>
                        </span>
                      </RowActions>
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>

          <Pagination page={paging.page} pageSize={paging.pageSize} total={filtered.length} onPage={paging.setPage} />
        </>
      )}

      {isAdmin && unrecordedCount > 0 && (
        <Section title="Why the unrecorded filter matters">
          <p className="max-w-prose text-base text-secondary">
            A session carries <span className="font-mono text-sm text-primary">recording_required</span> from its
            grant and its resource&apos;s <span className="font-mono text-sm text-primary">always_record</span> flag. A
            live session where that is true but <span className="font-mono text-sm text-primary">recording_id</span> is
            null is a privileged connection with no tape — the one row on this page worth interrupting someone for.
          </p>
        </Section>
      )}

      <SessionDrawer
        session={open}
        isAdmin={isAdmin}
        onClose={() => setOpen(null)}
        onKill={(s) => {
          setOpen(null)
          setKillTarget(s)
        }}
      />

      <ConfirmDialog
        open={!!endTarget}
        onClose={() => setEndTarget(null)}
        title={`End your session on ${endTarget?.resource_name}?`}
        consequence="Your connection closes immediately. Anything unsaved in that terminal is lost. You can reconnect while the grant is still valid."
        confirmLabel="End session"
        onConfirm={() => {
          setEndTarget(null)
          toast({ title: 'Session ended', description: `Your connection to ${endTarget.resource_name} is closed.` })
        }}
      />

      <ConfirmDialog
        open={!!killTarget}
        onClose={() => setKillTarget(null)}
        title={`Kill ${killTarget?.username}'s session on ${killTarget?.resource_name}?`}
        consequence="Their connection is terminated immediately, mid-command. They are not warned. This is the right action for a session that should not be open — and a disruptive one otherwise."
        confirmLabel="Kill session"
        destructive
        requireReason
        reasonLabel="Why is this being killed"
        reasonHint="Written to the audit log against your identity, and visible to the person whose session it was."
        onConfirm={() => {
          setKillTarget(null)
          toast({
            title: 'Session killed',
            tone: 'warning',
            description: `${killTarget.username} was disconnected from ${killTarget.resource_name}.`,
          })
        }}
      />
    </>
  )
}
