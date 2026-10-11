import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  Boxes, Database, Globe, HardDrive, KeyRound, Layers, Plus, Search, Shield, Video,
} from 'lucide-react'
import { useViewer } from '../state/viewer'
import { credentials, resources, sessions, auditEvents } from '../fixtures'
import {
  BreakglassTag, Button, DetailList, Field, FieldSet, FilterChip, Meta, PageHeader,
  Panel, RuledLabel, Section, Segmented, StatusDot, inputClass,
} from '../ui/primitives'
import { COL, DataTable, RowActions, SortTh, Td, Th, Tr, Trunc, nextSort, sortRows } from '../ui/table'
import {
  ActiveFilters, CommandBar, ExportMenu, Pagination, PreferencesMenu, RowMenu, usePaging,
} from '../ui/listchrome'
import { ConfirmDialog, Dialog, MenuItem, useToast } from '../ui/overlay'
import { CreateResourceDialog } from '../surfaces/CreateForms'
import { ConnectPanel, PairAgentPanel } from '../surfaces/Panels'
import { EmptyState } from '../ui/states'
import { duration, relative } from '../lib/format'

// ===========================================================================
// Resources  (list + detail)
// ===========================================================================
// WHAT CHANGED
//
//  • The card grid is no longer the default. PAMResource has eight
//    display-worthy fields and they are comparative — that is a table by
//    definition. The grid survives ONLY as an explicit toggle, and only
//    because it is genuinely nicer at <8 resources on a phone.
//  • `requires_jit`, `always_record` and "has a stored credential"
//    (vault_entry_id != null) become FACETS. Today they are badges you have to
//    read row by row; they are the two flags an operator actually navigates by.
//  • Every row carries exactly one verb (Teleport's catalog): Connect, or
//    "Request access" when requires_jit and you hold no grant, or a disabled
//    state that says WHY ("no credential stored").
//  • The type glyph stays, because it encodes real data (resource_type). The
//    decorative icons next to headings do not.
//
// ENDPOINTS
//   list        GET  /pam/resources/groups
//   detail      GET  /pam/resources/:id  ·  GET /pam/resources/:id/connect-info
//   connect     POST /pam/resources/:id/sessions   (web terminal)
//               POST /pam/resources/:id/launch     (desktop agent)
//   admin only  POST /pam/admin/resources · DELETE /:id
//               POST /pam/admin/resources/:id/credential · /rotate

const TYPE_ICON = {
  postgresql: Database, mongodb: Database, oracle: Database, clickhouse: Database,
  redis: Layers, minio: HardDrive, qdrant: Layers,
  metabase: Globe, langfuse: Globe, web: Globe,
}

function TypeGlyph({ type, className }) {
  const Icon = TYPE_ICON[type] || Boxes
  return <Icon className={clsx('h-4 w-4 flex-none text-tertiary', className)} strokeWidth={1.75} />
}

// The one verb per row. What it says is derived from real fields only.
function ConnectAffordance({ resource, size = 'sm' }) {
  if (!resource.is_active) {
    return <Button size={size} disabled title="This resource is marked inactive">Inactive</Button>
  }
  if (!resource.vault_entry_id) {
    return (
      <Button size={size} disabled title="No credential is stored for this resource yet">
        No credential
      </Button>
    )
  }
  if (resource.requires_jit) {
    return (
      <Button size={size} variant="secondary">
        Request access
      </Button>
    )
  }
  return (
    <Button size={size} variant="primary">
      Connect
    </Button>
  )
}

const RES_COLUMNS = [
  { key: 'resource', label: 'Resource', locked: true },
  { key: 'type', label: 'Type' },
  { key: 'host', label: 'Host' },
  { key: 'port', label: 'Port' },
  { key: 'controls', label: 'Controls' },
  { key: 'credential', label: 'Credential' },
]

export function ResourcesList() {
  const { isAdmin } = useViewer()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [view, setView] = useState('table')
  const [jitOnly, setJitOnly] = useState(false)
  const [recordedOnly, setRecordedOnly] = useState(false)
  const [noCredOnly, setNoCredOnly] = useState(false)
  const [sort, setSort] = useState({ key: 'resource', dir: 'asc' })
  const [visible, setVisible] = useState(RES_COLUMNS.map((c) => c.key))
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)

  const matched = useMemo(() => {
    let r = resources
    if (q) {
      const s = q.toLowerCase()
      r = r.filter((x) => x.name.toLowerCase().includes(s) || x.host.toLowerCase().includes(s) || x.resource_type.includes(s))
    }
    if (jitOnly) r = r.filter((x) => x.requires_jit)
    if (recordedOnly) r = r.filter((x) => x.always_record)
    if (noCredOnly) r = r.filter((x) => !x.vault_entry_id)
    return sortRows(r, sort, {
      resource: (x) => x.name,
      type: (x) => x.resource_type,
      host: (x) => x.host,
      port: (x) => x.port,
      credential: (x) => (x.vault_entry_id ? 1 : 0),
    })
  }, [q, jitOnly, recordedOnly, noCredOnly, sort])

  const paging = usePaging(matched.length, 25)
  const rows = paging.slice(matched)
  const has = (k) => visible.includes(k)
  const onSort = (key) => setSort((s2) => nextSort(s2, key))
  const filtered = !!q || jitOnly || recordedOnly || noCredOnly
  const clear = () => {
    setQ('')
    setJitOnly(false)
    setRecordedOnly(false)
    setNoCredOnly(false)
  }

  return (
    <>
      <PageHeader
        title="Resources"
        description="Everything you can connect to. JIT-gated resources need an approved request first."
      />

      <CommandBar
        primary={isAdmin ? <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>Add resource</Button> : null}
        summary={`${matched.length} of ${resources.length}`}
      >
        <Segmented value={view} onChange={setView} options={[{ value: 'table', label: 'Table' }, { value: 'grid', label: 'Grid' }]} />
        <ExportMenu count={rows.length} />
        <PreferencesMenu
          columns={RES_COLUMNS}
          visible={visible}
          onVisibleChange={setVisible}
          pageSize={paging.pageSize}
          onPageSize={paging.setPageSize}
        />
      </CommandBar>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-[20rem]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" strokeWidth={1.75} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, host or type"
            aria-label="Search resources"
            className={clsx(inputClass, 'pl-7')}
          />
        </div>
        <FilterChip active={jitOnly} onClick={() => setJitOnly(!jitOnly)} count={resources.filter((r) => r.requires_jit).length}>
          JIT required
        </FilterChip>
        <FilterChip active={recordedOnly} onClick={() => setRecordedOnly(!recordedOnly)} count={resources.filter((r) => r.always_record).length}>
          Always recorded
        </FilterChip>
        {isAdmin && (
          <FilterChip active={noCredOnly} onClick={() => setNoCredOnly(!noCredOnly)} count={resources.filter((r) => !r.vault_entry_id).length}>
            No credential
          </FilterChip>
        )}
      </div>

      <ActiveFilters
        chips={[
          q && { label: `“${q}”`, onRemove: () => setQ('') },
          jitOnly && { label: 'JIT required', onRemove: () => setJitOnly(false) },
          recordedOnly && { label: 'Always recorded', onRemove: () => setRecordedOnly(false) },
          noCredOnly && { label: 'No credential', onRemove: () => setNoCredOnly(false) },
        ].filter(Boolean)}
        onClearAll={clear}
      />

      {rows.length === 0 ? (
        <EmptyState
          variant={filtered ? 'no-match' : 'none-yet'}
          description={filtered ? 'No resource matches. Widen the search or drop a facet.' : 'No resources are registered yet.'}
          onClearFilters={clear}
          action={isAdmin ? <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>Add the first resource</Button> : null}
        />
      ) : view === 'table' ? (
        <DataTable minWidth="70rem">
          <thead>
            <tr>
              <SortTh columnKey="resource" sort={sort} onSort={onSort} width={COL.name} sticky edge>Resource</SortTh>
              {has('type') && <SortTh columnKey="type" sort={sort} onSort={onSort} width={COL.short}>Type</SortTh>}
              {has('host') && <SortTh columnKey="host" sort={sort} onSort={onSort} width={COL.wide}>Host</SortTh>}
              {has('port') && <SortTh columnKey="port" sort={sort} onSort={onSort} align="right" width={COL.count}>Port</SortTh>}
              {has('controls') && <Th width={COL.medium}>Controls</Th>}
              {has('credential') && <SortTh columnKey="credential" sort={sort} onSort={onSort} width={COL.short}>Credential</SortTh>}
              <Th width="w-[11rem]" align="right"><span className="sr-only">Actions</span></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td sticky edge>
                  <div className="flex items-center gap-2">
                    <TypeGlyph type={r.resource_type} />
                    <Link to={`/resources/${r.id}`} className="truncate text-sm font-semibold text-primary hover:text-accent" title={r.name}>
                      {r.name}
                    </Link>
                    {!r.is_active && <Meta>inactive</Meta>}
                  </div>
                </Td>
                {has('type') && <Td><Trunc value={r.resource_type} muted /></Td>}
                {has('host') && <Td><Trunc value={r.host} mono /></Td>}
                {has('port') && <Td align="right"><span className="font-mono text-xs">{r.port}</span></Td>}
                {has('controls') && <Td>
                  <span className="flex items-center gap-3">
                    {r.requires_jit && (
                      <span className="inline-flex items-center gap-1 text-xs text-warn" title="Requires an approved JIT request">
                        <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} /> JIT
                      </span>
                    )}
                    {r.always_record && (
                      <span className="inline-flex items-center gap-1 text-xs text-secondary" title="Every session is recorded">
                        <Video className="h-3.5 w-3.5" strokeWidth={1.75} /> Rec
                      </span>
                    )}
                    {!r.requires_jit && !r.always_record && <Meta>none</Meta>}
                  </span>
                </Td>}
                {has('credential') && (
                  <Td>{r.vault_entry_id ? <StatusDot tone="ok" label="Stored" /> : <StatusDot tone="warn" label="Missing" />}</Td>
                )}
                <Td align="right">
                  <RowActions>
                    <ConnectAffordance resource={r} />
                    <RowMenu label={`Actions for ${r.name}`}>
                      <MenuItem><Link to={`/resources/${r.id}`}>Open resource</Link></MenuItem>
                      {isAdmin && <MenuItem>{r.vault_entry_id ? 'Replace credential…' : 'Store a credential…'}</MenuItem>}
                      {isAdmin && <MenuItem danger onClick={() => setDeleteTarget(r)}>Delete resource…</MenuItem>}
                    </RowMenu>
                  </RowActions>
                </Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        // The ONE sanctioned card-per-row in the product: a large touch target
        // when the list is short. Still no shadow, still no hover lift.
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <div key={r.id} className="rounded-lg border border-line bg-surface p-4">
              <div className="flex items-start gap-2">
                <TypeGlyph type={r.resource_type} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <Link to={`/resources/${r.id}`} className="block truncate text-base font-semibold text-primary hover:text-accent">
                    {r.name}
                  </Link>
                  <p className="mt-1 truncate font-mono text-xs text-tertiary">{r.host}:{r.port}</p>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-3">
                {r.requires_jit && <Meta tone="warn">JIT</Meta>}
                {r.always_record && <Meta>Recorded</Meta>}
                {!r.vault_entry_id && <Meta tone="warn">No credential</Meta>}
              </div>
              <div className="mt-4">
                <ConnectAffordance resource={r} size="md" />
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'table' && rows.length > 0 && (
        <Pagination page={paging.page} pageSize={paging.pageSize} total={matched.length} onPage={paging.setPage} />
      )}

      <CreateResourceDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={(name) => {
          setCreateOpen(false)
          toast({ title: `${name} registered`, description: 'No credential is stored yet, so it will refuse connections until you add one.' })
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name}?`}
        consequence="Nobody can connect to it from this moment. Its audit history and its recordings are kept — deleting a resource does not delete the evidence of what was done on it. Active sessions are not cleaned up by this."
        confirmLabel="Delete resource"
        destructive
        typeToConfirm={deleteTarget?.name}
        onConfirm={() => { const n = deleteTarget.name; setDeleteTarget(null); toast({ title: `${n} deleted`, tone: 'error' }) }}
      />
    </>
  )
}

// ===========================================================================
// Resource detail
// ===========================================================================
// WHAT CHANGED
//  • Connect is the page's primary and sits in the header. It was a card among
//    cards; it is the reason the page exists.
//  • Admin management (store credential, rotate, delete) is a separate,
//    lower-weight zone at the bottom, clearly labelled. CyberArk separates
//    "use this account" from "administer this account" for the same reason.
//  • Four tabs collapse to one scrolling page with ruled labels — every
//    section is deep-linkable and nothing hides behind a click you have to
//    guess at (Entra's blade model rather than tabs).
export function ResourceDetail() {
  const { id } = useParams()
  const { isAdmin } = useViewer()
  const toast = useToast()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [credOpen, setCredOpen] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [showPair, setShowPair] = useState(false)
  const r = resources.find((x) => x.id === id) || resources[0]
  const cred = credentials.find((c) => c.id === r.vault_entry_id)
  const resSessions = sessions.filter((s) => s.resource_id === r.id)
  const resAudit = auditEvents.filter((e) => e.resource === `pam:resource/${r.id}`).slice(0, 8)

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/resources" className="hover:text-accent">Resources</Link>}
        title={
          <span className="flex items-center gap-2">
            <TypeGlyph type={r.resource_type} />
            {r.name}
          </span>
        }
        description={r.description}
      />

      <ConnectPanel resource={r} />

      {showPair ? (
        <div className="mt-3"><PairAgentPanel /></div>
      ) : (
        <button type="button" onClick={() => setShowPair(true)} className="mt-2 text-xs text-accent hover:underline">
          No paired device? Pair one →
        </button>
      )}

      {r.requires_jit && (
        <Panel className="mb-6 mt-3 flex items-start gap-3 px-4 py-3">
          <KeyRound className="mt-0.5 h-4 w-4 flex-none text-warn" strokeWidth={1.75} />
          <p className="text-base text-secondary">
            This resource is JIT-gated. Connecting needs an approved request — standard requests take two
            different approvers.{' '}
            <Link to="/jit" className="font-semibold text-accent hover:underline">Raise one</Link>.
          </p>
        </Panel>
      )}

      <RuledLabel>Connection</RuledLabel>
      <DetailList
        columns={2}
        items={[
          { label: 'Host', value: r.host, mono: true },
          { label: 'Port', value: r.port, mono: true },
          { label: 'Type', value: r.resource_type },
          { label: 'Database', value: r.database_name, mono: true },
          { label: 'Connect mode', value: r.connect_mode, mono: true },
          { label: 'Console URL', value: r.console_url, mono: true },
        ]}
      />

      <RuledLabel className="mt-8">Controls</RuledLabel>
      <DetailList
        columns={2}
        items={[
          { label: 'Requires JIT', value: r.requires_jit ? 'Yes — every connection needs an approved request' : 'No' },
          { label: 'Always record', value: r.always_record ? 'Yes — every session is recorded' : 'No' },
          { label: 'Active', value: r.is_active ? 'Yes' : 'No — connections are refused' },
          {
            label: 'Stored credential',
            value: cred ? (
              <Link to={`/vault/${cred.safe_id}/credentials/${cred.id}`} className="text-accent hover:underline">
                {cred.name} <span className="text-tertiary">v{cred.version}</span>
              </Link>
            ) : (
              <span className="text-warn">None stored</span>
            ),
          },
        ]}
      />

      <Section title="Sessions on this resource">
        {resSessions.length === 0 ? (
          <EmptyState title="No sessions yet" description="Nobody has connected to this resource." />
        ) : (
          <ul className="divide-y divide-line">
            {resSessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-4 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-primary">{s.username}</p>
                  <p className="truncate text-xs text-tertiary">
                    <span className="font-mono">{s.protocol}</span> · {s.source_ip} · {duration(s.duration_seconds)}
                  </p>
                </div>
                <div className="flex flex-none items-center gap-4">
                  {s.is_breakglass && <BreakglassTag />}
                  <StatusDot tone={s.status === 'ACTIVE' ? 'ok' : 'neutral'} live={s.status === 'ACTIVE'} label={s.status} />
                  <Meta>{relative(s.started_at)}</Meta>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Audit"
        description="From GET /pam/audit/resource/pam:resource/{id} — every event recorded against this resource."
      >
        <ul className="divide-y divide-line">
          {resAudit.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-4 py-2">
              <p className="truncate font-mono text-xs text-primary">{e.action}</p>
              <div className="flex flex-none items-center gap-4">
                <span className="text-xs text-tertiary">{e.username}</span>
                <StatusDot tone={e.outcome === 'SUCCESS' ? 'ok' : 'danger'} label={e.outcome} />
                <Meta>{relative(e.occurred_at)}</Meta>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      {isAdmin && (
        <Section
          title="Administration"
          description="These change the resource for everyone. Every one of them is written to the audit log with your identity."
          className="mt-12 border-t border-line pt-8"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={Shield} onClick={() => setCredOpen(true)}>{cred ? 'Replace stored credential' : 'Store a credential'}</Button>
            <Button disabled={!cred} onClick={() => setRotateOpen(true)} title={cred ? undefined : 'Nothing to rotate — no credential is stored'}>
              Rotate credential
            </Button>
            <Button variant="dangerQuiet" onClick={() => setDeleteOpen(true)}>Delete resource</Button>
          </div>
          <p className="mt-3 max-w-prose text-xs text-tertiary">
            Deleting a resource does not delete its audit history or its recordings. It does end the ability to
            connect, immediately.
          </p>
        </Section>
      )}

      <Dialog
        open={credOpen}
        onClose={() => setCredOpen(false)}
        size="md"
        title={cred ? `Replace the credential on ${r.name}` : `Store a credential for ${r.name}`}
        description="This is the account the broker uses to open sessions. Nobody sees it — they get a session, not the secret."
        footer={
          <>
            <Button variant="primary" size="lg" onClick={() => { setCredOpen(false); toast({ title: 'Credential stored' }) }}>Store credential</Button>
            <Button size="lg" onClick={() => setCredOpen(false)}>Cancel</Button>
            <Meta className="ml-auto hidden sm:inline">POST /admin/resources/:id/credential</Meta>
          </>
        }
      >
        <FieldSet title="Broker account">
          <Field label="Username" htmlFor="rc-user" required>
            <input id="rc-user" className={clsx(inputClass, 'font-mono')} defaultValue="pam_admin" />
          </Field>
          <Field label="Secret" htmlFor="rc-secret" required hint="Encrypted on arrival. Rotating later replaces it without a gap.">
            <input id="rc-secret" type="password" className={clsx(inputClass, 'font-mono')} />
          </Field>
        </FieldSet>
      </Dialog>

      <ConfirmDialog
        open={rotateOpen}
        onClose={() => setRotateOpen(false)}
        title={`Rotate the credential on ${r.name}?`}
        consequence="The broker changes the password on the target and stores the new value as the next version. Sessions already open keep working; new sessions use the new secret. If the target refuses the change, nothing is stored and the old value stays valid."
        confirmLabel="Rotate now"
        onConfirm={() => { setRotateOpen(false); toast({ title: 'Rotation requested', description: 'The result appears on the credential in the vault.' }) }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete ${r.name}?`}
        consequence="Nobody can connect to it from this moment. Its audit history and recordings are kept — deleting a resource does not delete the evidence of what was done on it."
        confirmLabel="Delete resource"
        destructive
        typeToConfirm={r.name}
        onConfirm={() => { setDeleteOpen(false); toast({ title: `${r.name} deleted`, tone: 'error' }) }}
      />
    </>
  )
}
