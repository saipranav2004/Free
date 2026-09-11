import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRight, Eye, FolderIcon, KeyRound, Plus, RotateCw, Search } from 'lucide-react'
import { credentials, credentialVersions, folders, resources, safes } from '../fixtures'
import {
  AlarmBand, BreakglassTag, Button, DetailList, Field, FieldSet, FilterChip, Meta,
  PageHeader, Panel, RuledLabel, Section, StatusDot, inputClass, textareaClass,
} from '../ui/primitives'
import { COL, DataTable, RowActions, SortTh, Td, Th, Tr, Trunc, nextSort, sortRows } from '../ui/table'
import { CommandBar, ExportMenu, Pagination, PreferencesMenu, RowMenu, usePaging } from '../ui/listchrome'
import { ConfirmDialog, Dialog, MenuItem, useToast } from '../ui/overlay'
import {
  CreateCredentialDialog, CreateFolderDialog, CreateSafeDialog, RevealDialog,
} from '../surfaces/CreateForms'
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
  const toast = useToast()
  const [q, setQ] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [sort, setSort] = useState({ key: 'safe', dir: 'asc' })
  const countIn = (safeId) => credentials.filter((c) => c.safe_id === safeId).length
  const matched = sortRows(
    safes.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())),
    sort,
    { safe: (x) => x.name, credentials: (x) => countIn(x.id), retention: (x) => x.retention_days, created: (x) => x.created_at }
  )
  const paging = usePaging(matched.length, 25)
  const rows = paging.slice(matched)
  const onSort = (key) => setSort((s2) => nextSort(s2, key))

  return (
    <>
      <PageHeader
        title="Vault"
        description="Safes hold credentials. Revealing one is recorded against your identity with the reason you give."
      />

      <CommandBar
        primary={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>New safe</Button>}
        summary={`${matched.length} of ${safes.length}`}
      >
        <ExportMenu count={rows.length} />
        <PreferencesMenu pageSize={paging.pageSize} onPageSize={paging.setPageSize} />
      </CommandBar>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[13rem] flex-1 sm:max-w-[18rem]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" strokeWidth={1.75} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Safe name" aria-label="Search safes" className={clsx(inputClass, 'pl-7')} />
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState variant="no-match" onClearFilters={() => setQ('')} />
      ) : (
        <DataTable minWidth="52rem">
          <thead>
            <tr>
              <SortTh columnKey="safe" sort={sort} onSort={onSort} width={COL.name} sticky edge>Safe</SortTh>
              <Th width="w-[22rem]">Description</Th>
              <SortTh columnKey="credentials" sort={sort} onSort={onSort} align="right" width={COL.count}>Credentials</SortTh>
              <SortTh columnKey="retention" sort={sort} onSort={onSort} align="right" width={COL.short}>Retention</SortTh>
              <SortTh columnKey="created" sort={sort} onSort={onSort} align="right" width={COL.timestamp}>Created</SortTh>
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

      {rows.length > 0 && (
        <Pagination page={paging.page} pageSize={paging.pageSize} total={matched.length} onPage={paging.setPage} />
      )}

      <CreateSafeDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={(name) => { setCreateOpen(false); toast({ title: `Safe “${name}” created` }) }}
      />
    </>
  )
}

export function SafeDetail() {
  const { safeId } = useParams()
  const toast = useToast()
  const safe = safes.find((s) => s.id === safeId) || safes[0]
  const [path, setPath] = useState('/')
  const [folderOpen, setFolderOpen] = useState(false)
  const [credOpen, setCredOpen] = useState(false)
  const [revealTarget, setRevealTarget] = useState(null)

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
      />

      <CommandBar
        primary={<Button variant="primary" icon={Plus} onClick={() => setCredOpen(true)}>New credential</Button>}
        actions={<Button icon={Plus} onClick={() => setFolderOpen(true)}>New folder</Button>}
      >
        <ExportMenu count={safeCreds.length} />
      </CommandBar>

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
        <EmptyState title="This folder is empty" description="Add a credential here, or a sub-folder to organise them." action={<Button variant="primary" icon={Plus} onClick={() => setCredOpen(true)}>New credential</Button>} />
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
                      <Button size="sm" icon={Eye} onClick={() => setRevealTarget(c)}>Reveal</Button>
                      <RowMenu label={`Actions for ${c.name}`}>
                        <MenuItem><Link to={`/vault/${safe.id}/credentials/${c.id}`}>Open credential</Link></MenuItem>
                        <MenuItem>Request rotation…</MenuItem>
                      </RowMenu>
                    </RowActions>
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </DataTable>
      )}

      <CreateFolderDialog
        open={folderOpen}
        onClose={() => setFolderOpen(false)}
        safeId={safe.id}
        currentPath={path}
        onDone={(name) => { setFolderOpen(false); toast({ title: `Folder “${name}” created` }) }}
      />
      <CreateCredentialDialog
        open={credOpen}
        onClose={() => setCredOpen(false)}
        safeId={safe.id}
        onDone={(name) => { setCredOpen(false); toast({ title: `${name} stored`, description: 'Encrypted. Revealing it later needs a reason and is audited.' }) }}
      />
      <RevealDialog open={!!revealTarget} onClose={() => setRevealTarget(null)} credential={revealTarget} />
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
  const toast = useToast()
  const [revealOpen, setRevealOpen] = useState(false)
  const [versionOpen, setVersionOpen] = useState(false)
  const [pushOpen, setPushOpen] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)

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
          <Button variant="primary" size="lg" icon={Eye} onClick={() => setRevealOpen(true)}>
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
          <Button icon={RotateCw} onClick={() => setRotateOpen(true)}>Request rotation</Button>
          <Button onClick={() => setVersionOpen(true)}>Store a new version</Button>
          <Button onClick={() => setPushOpen(true)}>Change the password on the target</Button>
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

      <RevealDialog open={revealOpen} onClose={() => setRevealOpen(false)} credential={cred} />

      <Dialog
        open={versionOpen}
        onClose={() => setVersionOpen(false)}
        size="md"
        title="Store a new version"
        description="Records a secret the vault does not yet know about. It does NOT change anything on the target system."
        footer={
          <>
            <Button variant="primary" size="lg" onClick={() => { setVersionOpen(false); toast({ title: `Version ${cred.version + 1} stored` }) }}>Store version</Button>
            <Button size="lg" onClick={() => setVersionOpen(false)}>Cancel</Button>
            <Meta className="ml-auto hidden sm:inline">POST /pam/credentials/:id/versions</Meta>
          </>
        }
      >
        <FieldSet title={`New value — becomes v${cred.version + 1}`}>
          <Field label="Secret" htmlFor="nv-secret" required>
            <input id="nv-secret" type="password" className={clsx(inputClass, 'font-mono')} />
          </Field>
          <Field label="Reason" htmlFor="nv-reason" required hint="Shown in the version history beside your name.">
            <textarea id="nv-reason" rows={2} className={textareaClass} />
          </Field>
        </FieldSet>
      </Dialog>

      <Dialog
        open={pushOpen}
        onClose={() => setPushOpen(false)}
        size="md"
        title="Change the password on the target"
        description={`Sets a new password on ${resource ? resource.name : 'the resource'} AND stores it. Different endpoint, different blast radius.`}
        footer={
          <>
            <Button variant="danger" size="lg" onClick={() => { setPushOpen(false); toast({ title: 'Password changed on the target', tone: 'warning' }) }}>Change it</Button>
            <Button size="lg" onClick={() => setPushOpen(false)}>Cancel</Button>
            <Meta className="ml-auto hidden sm:inline">POST /pam/credentials/:id/password-change</Meta>
          </>
        }
      >
        <p className="rounded border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
          Anything using this account outside the console — a cron job, an application, a script — breaks the
          moment this succeeds. Sessions already open are unaffected.
        </p>
        <div className="mt-4">
          <FieldSet title="New password">
            <Field label="Password" htmlFor="pc-secret" required>
              <input id="pc-secret" type="password" className={clsx(inputClass, 'font-mono')} />
            </Field>
          </FieldSet>
        </div>
      </Dialog>

      <ConfirmDialog
        open={rotateOpen}
        onClose={() => setRotateOpen(false)}
        title="Request rotation?"
        consequence="The rotation service generates a new secret, sets it on the target, and stores it as the next version. If the target refuses, nothing changes and the current value stays valid."
        confirmLabel="Request rotation"
        onConfirm={() => { setRotateOpen(false); toast({ title: 'Rotation requested' }) }}
      />
    </>
  )
}
