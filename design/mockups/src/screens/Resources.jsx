import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  Boxes, Database, Globe, HardDrive, KeyRound, Layers, Plus, Search, Shield, Video,
} from 'lucide-react'
import { useViewer } from '../state/viewer'
import { credentials, resources, sessions, auditEvents } from '../fixtures'
import {
  BreakglassTag, Button, DetailList, FilterChip, Meta, PageHeader, Panel,
  RuledLabel, Section, Segmented, StatusDot, inputClass,
} from '../ui/primitives'
import { COL, DataTable, RowActions, Td, Th, Tr, Trunc } from '../ui/table'
import { EmptyState } from '../ui/states'
import { dateTime, duration, relative } from '../lib/format'

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

export function ResourcesList() {
  const { isAdmin } = useViewer()
  const [q, setQ] = useState('')
  const [view, setView] = useState('table')
  const [jitOnly, setJitOnly] = useState(false)
  const [recordedOnly, setRecordedOnly] = useState(false)
  const [noCredOnly, setNoCredOnly] = useState(false)

  const rows = useMemo(() => {
    let r = resources
    if (q) {
      const s = q.toLowerCase()
      r = r.filter((x) => x.name.toLowerCase().includes(s) || x.host.toLowerCase().includes(s) || x.resource_type.includes(s))
    }
    if (jitOnly) r = r.filter((x) => x.requires_jit)
    if (recordedOnly) r = r.filter((x) => x.always_record)
    if (noCredOnly) r = r.filter((x) => !x.vault_entry_id)
    return r
  }, [q, jitOnly, recordedOnly, noCredOnly])

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
        actions={isAdmin ? <Button variant="primary" icon={Plus}>Add resource</Button> : null}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
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
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs tabular text-tertiary">{rows.length} of {resources.length}</span>
          <Segmented
            value={view}
            onChange={setView}
            options={[{ value: 'table', label: 'Table' }, { value: 'grid', label: 'Grid' }]}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          variant={filtered ? 'no-match' : 'none-yet'}
          description={filtered ? 'No resource matches. Widen the search or drop a facet.' : 'No resources are registered yet.'}
          onClearFilters={clear}
          action={isAdmin ? <Button variant="primary" icon={Plus}>Add the first resource</Button> : null}
        />
      ) : view === 'table' ? (
        <DataTable minWidth="70rem">
          <thead>
            <tr>
              <Th width={COL.name} sticky edge>Resource</Th>
              <Th width={COL.short}>Type</Th>
              <Th width={COL.wide}>Host</Th>
              <Th width={COL.count} align="right">Port</Th>
              <Th width={COL.medium}>Controls</Th>
              <Th width={COL.short}>Credential</Th>
              <Th width={COL.actions} align="right"><span className="sr-only">Actions</span></Th>
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
                <Td><Trunc value={r.resource_type} muted /></Td>
                <Td><Trunc value={r.host} mono /></Td>
                <Td align="right"><span className="font-mono text-xs">{r.port}</span></Td>
                <Td>
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
                </Td>
                <Td>
                  {r.vault_entry_id ? (
                    <StatusDot tone="ok" label="Stored" />
                  ) : (
                    <StatusDot tone="warn" label="Missing" />
                  )}
                </Td>
                <Td align="right">
                  <div className="flex justify-end">
                    <ConnectAffordance resource={r} />
                  </div>
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
        actions={
          <div className="flex items-center gap-2">
            <ConnectAffordance resource={r} size="lg" />
            {r.connect_mode === 'console_url' && <Button size="lg">Open console</Button>}
          </div>
        }
      />

      {r.requires_jit && (
        <Panel className="mb-6 flex items-start gap-3 px-4 py-3">
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
            <Button icon={Shield}>{cred ? 'Replace stored credential' : 'Store a credential'}</Button>
            <Button disabled={!cred} title={cred ? undefined : 'Nothing to rotate — no credential is stored'}>
              Rotate credential
            </Button>
            <Button variant="dangerQuiet">Delete resource</Button>
          </div>
          <p className="mt-3 max-w-prose text-xs text-tertiary">
            Deleting a resource does not delete its audit history or its recordings. It does end the ability to
            connect, immediately.
          </p>
        </Section>
      )}
    </>
  )
}
