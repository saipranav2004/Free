import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRight, Eye, FolderIcon, KeyRound, Plus, RotateCw, Search } from 'lucide-react'
import { credentials, credentialVersions, folders, resources, safes } from '../fixtures'
import {
  AlarmBand, BreakglassTag, Button, DetailList, FilterChip, Meta, PageHeader,
  Panel, RuledLabel, Section, StatusDot, inputClass,
} from '../ui/primitives'
import { COL, DataTable, RowActions, Td, Th, Tr, Trunc } from '../ui/table'
import { EmptyState } from '../ui/states'
import { dateTime, relative } from '../lib/format'

// ===========================================================================
// Vault
// ===========================================================================
// WHAT CHANGED
//
//  • Safes: card grid → table. A Safe has four attributes; a card is five
//    times the height of the line it needs.
//  • Safe detail: the flat "folders list + credentials list" becomes a PATH.
//    models.Folder returns `path` ("/prod-databases/postgres") and the current
//    UI never renders it — HashiCorp Vault's path breadcrumb is free here and
//    fixes navigation at zero API cost.
//  • Credential detail: rotation state leads (AWS Secrets Manager's model),
//    and Reveal is the single dominant action with its consequence stated —
//    because it is reason-gated and lands in the audit log as pam:vault:Reveal.
//  • Break-glass credentials get the one filled marker in the design system.
//
// ENDPOINTS
//   GET  /pam/safes · /safes/:id · /safes/:id/folders · /safes/:id/credentials
//   POST /pam/safes · /safes/:id/folders · /safes/:id/credentials
//   GET  /pam/credentials/:id
//   POST /pam/credentials/:id/reveal          (reason required)
//   POST /pam/credentials/:id/versions        (new version + reason)
//   POST /pam/credentials/:id/password-change
//   POST /pam/credentials/:id/rotate          (request rotation)
// There is no "delete credential" endpoint, so there is no delete control.

export function SafesList() {
  const [q, setQ] = useState('')
  const rows = safes.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()))
  const countIn = (safeId) => credentials.filter((c) => c.safe_id === safeId).length

  return (
    <>
      <PageHeader
        title="Vault"
        description="Safes hold credentials. Revealing one is recorded against your identity with the reason you give."
        actions={<Button variant="primary" icon={Plus}>New safe</Button>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-[20rem]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" strokeWidth={1.75} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Safe name" aria-label="Search safes" className={clsx(inputClass, 'pl-7')} />
        </div>
        <span className="ml-auto text-xs tabular text-tertiary">{rows.length} of {safes.length}</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState variant="no-match" onClearFilters={() => setQ('')} />
      ) : (
        <DataTable minWidth="52rem">
          <thead>
            <tr>
              <Th width={COL.name} sticky edge>Safe</Th>
              <Th width="w-[24rem]">Description</Th>
              <Th width={COL.count} align="right">Credentials</Th>
              <Th width={COL.short} align="right">Retention</Th>
              <Th width={COL.timestamp} align="right">Created</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <Tr key={s.id}>
                <Td sticky edge>
                  <div className="flex items-center gap-2">
                    <Link to={`/vault/${s.id}`} className="truncate text-sm font-semibold text-primary hover:text-accent">
                      {s.name}
                    </Link>
                    {s.is_default && <Meta>default</Meta>}
                  </div>
                </Td>
                <Td><Trunc value={s.description} muted /></Td>
                <Td align="right">{countIn(s.id)}</Td>
                <Td align="right">{s.retention_days} d</Td>
                <Td align="right"><span className="text-tertiary">{relative(s.created_at)}</span></Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  )
}

export function SafeDetail() {
  const { safeId } = useParams()
  const safe = safes.find((s) => s.id === safeId) || safes[0]
  const [path, setPath] = useState('/')

  const safeFolders = folders.filter((f) => f.safe_id === safe.id)
  const safeCreds = credentials.filter((c) => c.safe_id === safe.id)

  // Path-first navigation, built from Folder.path — the field the current UI
  // fetches and throws away.
  const childFolders = safeFolders.filter((f) => {
    const parent = f.path.slice(0, f.path.lastIndexOf('/')) || '/'
    return parent === (path === '/' ? '' : path) || (path === '/' && parent === '')
  })
  const credsHere = safeCreds.filter((c) => {
    const folder = safeFolders.find((f) => f.id === c.folder_id)
    return (folder?.path || '/') === path
  })

  const segments = path === '/' ? [] : path.split('/').filter(Boolean)

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/vault" className="hover:text-accent">Vault</Link>}
        title={safe.name}
        description={safe.description}
        actions={
          <div className="flex items-center gap-2">
            <Button icon={Plus}>New folder</Button>
            <Button variant="primary" icon={Plus}>New credential</Button>
          </div>
        }
      />

      {/* The path IS the navigation. */}
      <nav aria-label="Folder path" className="mb-4 flex flex-wrap items-center gap-1 font-mono text-sm">
        <button type="button" onClick={() => setPath('/')} className={clsx('rounded px-1 hover:bg-hover', path === '/' ? 'text-primary' : 'text-accent')}>
          {safe.name}
        </button>
        {segments.map((seg, i) => {
          const p = '/' + segments.slice(0, i + 1).join('/')
          const isLast = i === segments.length - 1
          return (
            <span key={p} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 text-tertiary" strokeWidth={1.75} />
              <button type="button" onClick={() => setPath(p)} className={clsx('rounded px-1 hover:bg-hover', isLast ? 'text-primary' : 'text-accent')}>
                {seg}
              </button>
            </span>
          )
        })}
      </nav>

      {childFolders.length === 0 && credsHere.length === 0 ? (
        <EmptyState title="This folder is empty" description="Add a credential here, or a sub-folder to organise them." action={<Button variant="primary" icon={Plus}>New credential</Button>} />
      ) : (
        <DataTable minWidth="58rem">
          <thead>
            <tr>
              <Th width={COL.name} sticky edge>Name</Th>
              <Th width={COL.medium}>Account</Th>
              <Th width={COL.short}>Type</Th>
              <Th width={COL.count} align="right">Version</Th>
              <Th width={COL.medium} align="right">Next rotation</Th>
              <Th width={COL.actions} align="right">·</Th>
            </tr>
          </thead>
          <tbody>
            {childFolders.map((f) => (
              <Tr key={f.id} onClick={() => setPath(f.path)}>
                <Td sticky edge>
                  <span className="flex items-center gap-2">
                    <FolderIcon className="h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
                    <span className="truncate text-sm font-semibold text-primary">{f.name}</span>
                  </span>
                </Td>
                <Td colSpan={5}>
                  <Meta mono>{f.path}</Meta>
                </Td>
              </Tr>
            ))}
            {credsHere.map((c) => {
              const overdue = c.next_rotation_at && new Date(c.next_rotation_at) < new Date()
              return (
                <Tr key={c.id}>
                  <Td sticky edge>
                    <span className="flex items-center gap-2">
                      <KeyRound className="h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
                      <Link to={`/vault/${safe.id}/credentials/${c.id}`} className="truncate text-sm font-semibold text-primary hover:text-accent">
                        {c.name}
                      </Link>
                      {c.is_breakglass && <BreakglassTag />}
                    </span>
                  </Td>
                  <Td><Trunc value={c.account_name} mono /></Td>
                  <Td><Trunc value={c.credential_type} muted /></Td>
                  <Td align="right">v{c.version}</Td>
                  <Td align="right">
                    {c.next_rotation_at ? (
                      <span className={overdue ? 'text-danger' : ''}>{relative(c.next_rotation_at)}</span>
                    ) : (
                      <Meta>not scheduled</Meta>
                    )}
                  </Td>
                  <Td align="right">
                    <RowActions>
                      <Button size="sm" icon={Eye}>Reveal</Button>
                    </RowActions>
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </DataTable>
      )}
    </>
  )
}

export function CredentialDetail() {
  const { credentialId, safeId } = useParams()
  const cred = credentials.find((c) => c.id === credentialId) || credentials[0]
  const safe = safes.find((s) => s.id === (safeId || cred.safe_id))
  const folder = folders.find((f) => f.id === cred.folder_id)
  const resource = resources.find((r) => r.id === cred.resource_id)
  const versions = credentialVersions.filter((v) => v.credential_id === cred.id)
  const overdue = cred.next_rotation_at && new Date(cred.next_rotation_at) < new Date()

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-1 font-mono">
            <Link to="/vault" className="hover:text-accent">{safe?.name}</Link>
            {folder && <><ChevronRight className="inline h-3 w-3" />{folder.path}</>}
          </span>
        }
        title={cred.name}
        description={`${cred.credential_type} for ${cred.account_name}`}
        actions={
          <Button variant="primary" size="lg" icon={Eye}>
            Reveal
          </Button>
        }
      />

      {cred.is_breakglass && (
        <AlarmBand>
          Break-glass credential. {cred.breakglass_note}
        </AlarmBand>
      )}

      {/* Consequence stated at the point of the action, not in a tooltip. */}
      <Panel className={clsx('flex items-start gap-3 px-4 py-3', cred.is_breakglass && 'mt-4')}>
        <Eye className="mt-0.5 h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
        <p className="max-w-prose text-base text-secondary">
          Revealing requires a reason and writes{' '}
          <span className="font-mono text-sm text-primary">pam:vault:Reveal</span> to the audit log with your
          identity, the reason and the time. The plaintext is returned once and expires.
        </p>
      </Panel>

      {/* Rotation leads — the Secrets Manager pattern. These four fields are
          already returned by GET /pam/credentials/:id and barely surfaced today. */}
      <Section title="Rotation">
        {overdue && (
          <div className="mb-4">
            <AlarmBand tone="warn">
              Rotation is overdue by {relative(cred.next_rotation_at).replace(' ago', '')}.
            </AlarmBand>
          </div>
        )}
        <DetailList
          columns={2}
          items={[
            { label: 'Current version', value: `v${cred.version}` },
            { label: 'Last rotated', value: cred.last_rotated_at ? `${dateTime(cred.last_rotated_at)} (${relative(cred.last_rotated_at)})` : 'Never' },
            { label: 'Next rotation', value: cred.next_rotation_at ? dateTime(cred.next_rotation_at) : 'Not scheduled' },
            { label: 'Interval', value: cred.rotation_interval_days ? `${cred.rotation_interval_days} days` : 'Manual only' },
          ]}
        />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button icon={RotateCw}>Request rotation</Button>
          <Button>Store a new version</Button>
          <Button>Change the password on the target</Button>
        </div>
        <p className="mt-3 max-w-prose text-xs text-tertiary">
          &ldquo;Store a new version&rdquo; records a secret the vault already knows about.
          &ldquo;Change the password on the target&rdquo; also pushes it to{' '}
          {resource ? <span className="font-mono text-primary">{resource.name}</span> : 'the resource'}. They are
          different endpoints and different blast radii.
        </p>
      </Section>

      <Section title="Details">
        <DetailList
          columns={2}
          items={[
            { label: 'Credential ID', value: cred.id, mono: true },
            { label: 'Safe', value: safe?.name },
            { label: 'Folder', value: folder?.path || '/', mono: true },
            { label: 'Account', value: cred.account_name, mono: true },
            { label: 'Type', value: cred.credential_type },
            { label: 'Status', value: <StatusDot tone={cred.status === 'active' ? 'ok' : 'neutral'} label={cred.status} /> },
            { label: 'Resource', value: resource ? <Link to={`/resources/${resource.id}`} className="text-accent hover:underline">{resource.name}</Link> : null },
            { label: 'Last updated by', value: cred.updated_by },
          ]}
        />
      </Section>

      <Section title="Version history" description="Every version records who wrote it and why.">
        {versions.length === 0 ? (
          <EmptyState title="One version only" description="This credential has never been rotated or re-stored." />
        ) : (
          <ul className="divide-y divide-line">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-primary">v{v.version}</p>
                  <p className="mt-1 truncate text-sm text-secondary">{v.reason}</p>
                </div>
                <div className="flex flex-none items-center gap-4">
                  <Meta>{v.created_by}</Meta>
                  <Meta>{relative(v.created_at)}</Meta>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}
