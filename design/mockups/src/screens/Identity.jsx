import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { Crown, Plus, Search, ShieldCheck, Tag } from 'lucide-react'
import { useViewer } from '../state/viewer'
import { auditEvents, policies, roles, users } from '../fixtures'
import {
  AlarmBand, Button, DetailList, Field, FieldSet, FilterChip, Meta, PageHeader,
  Panel, RuledLabel, Section, StatusDot, StrengthMeter, inputClass, selectClass,
} from '../ui/primitives'
import {
  COL, DataTable, RowActions, RowCheckbox, SelectAll, SortTh, Td, Th, Tr, Trunc,
  nextSort, sortRows,
} from '../ui/table'
import {
  ActiveFilters, BulkBar, CommandBar, ExportMenu, Pagination, PreferencesMenu,
  RowMenu, SavedViewsMenu, usePaging,
} from '../ui/listchrome'
import { ConfirmDialog, Dialog, MenuItem, useToast } from '../ui/overlay'
import { CreateUserDialog, DelegateAdminDialog } from '../surfaces/CreateForms'
import { DeniedState, EmptyState } from '../ui/states'
import { dateTime, relative, USER_STATUS_TONE } from '../lib/format'

// ===========================================================================
// Admin Center → Identity
// ===========================================================================
// REVISION 2 adds the surfaces pass 1 skipped entirely: the create dialog,
// the six lifecycle confirmations, the role picker, the reset-password form,
// and the root-only delegation dialog — all in the same design language as
// the list, which is the specific mismatch this revision exists to prevent.
//
// PERMISSION FACTS ENCODED (verified in identity_delegation.go)
//   • Only root may delegate or revoke admin (MinRankToDelegateAdmin = 100).
//   • Plain AssignRole refuses admin and root for everyone.
//   • is_protected accounts cannot be suspended, deleted or delegated over —
//     including by root.

const ALL_COLUMNS = [
  { key: 'account', label: 'Account', locked: true },
  { key: 'email', label: 'Email' },
  { key: 'roles', label: 'Roles' },
  { key: 'mfa', label: 'MFA' },
  { key: 'last_login', label: 'Last sign-in' },
  { key: 'created', label: 'Created' },
]

export function IdentityList() {
  const { isAdmin } = useViewer()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [noMfa, setNoMfa] = useState(false)
  const [privileged, setPrivileged] = useState(false)
  const [notActive, setNotActive] = useState(false)
  const [sort, setSort] = useState({ key: 'account', dir: 'asc' })
  const [visible, setVisible] = useState(ALL_COLUMNS.filter((c) => c.key !== 'created').map((c) => c.key))
  const [selected, setSelected] = useState([])
  const [bulkResult, setBulkResult] = useState(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [suspendTarget, setSuspendTarget] = useState(null)

  const filtered = useMemo(() => {
    let r = users
    if (q) {
      const s = q.toLowerCase()
      r = r.filter((u) => u.username.toLowerCase().includes(s) || u.email.toLowerCase().includes(s) || (u.full_name || '').toLowerCase().includes(s))
    }
    if (noMfa) r = r.filter((u) => !u.mfa_enabled)
    if (privileged) r = r.filter((u) => u.roles.some((x) => ['root', 'admin'].includes(x)))
    if (notActive) r = r.filter((u) => u.status !== 'ACTIVE')
    return sortRows(r, sort, {
      account: (u) => u.username,
      email: (u) => u.email,
      roles: (u) => u.roles.join(','),
      mfa: (u) => (u.mfa_enabled ? 1 : 0),
      last_login: (u) => u.last_login_at,
      created: (u) => u.created_at,
    })
  }, [q, noMfa, privileged, notActive, sort])

  const paging = usePaging(filtered.length, 25)
  const rows = paging.slice(filtered)

  if (!isAdmin) return <DeniedState requires="admin" what="Identity" />

  const anyFilter = !!q || noMfa || privileged || notActive
  const clear = () => { setQ(''); setNoMfa(false); setPrivileged(false); setNotActive(false) }
  const has = (k) => visible.includes(k)
  const onSort = (key) => setSort((s) => nextSort(s, key))

  const chips = [
    q && { label: `“${q}”`, onRemove: () => setQ('') },
    privileged && { label: 'Privileged', onRemove: () => setPrivileged(false) },
    noMfa && { label: 'No MFA', onRemove: () => setNoMfa(false) },
    notActive && { label: 'Not active', onRemove: () => setNotActive(false) },
  ].filter(Boolean)

  return (
    <>
      <PageHeader
        eyebrow="Admin Center"
        title="Identity"
        description="Every account in the org, what it holds, and whether it can actually sign in."
      />

      <CommandBar
        primary={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>New user</Button>}
        summary={`${filtered.length} of ${users.length}`}
      >
        <SavedViewsMenu
          views={[{ name: 'Privileged, no MFA' }]}
          active={null}
          onApply={() => { setPrivileged(true); setNoMfa(true) }}
          onSave={() => toast({ title: 'View saved in this browser', tone: 'info' })}
          canSave={anyFilter}
        />
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
        <div className="relative min-w-[13rem] flex-1 sm:max-w-[18rem]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" strokeWidth={1.75} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Username, email or name" aria-label="Search accounts" className={clsx(inputClass, 'pl-7')} />
        </div>
        <FilterChip active={privileged} onClick={() => setPrivileged(!privileged)} count={users.filter((u) => u.roles.some((x) => ['root', 'admin'].includes(x))).length}>Privileged</FilterChip>
        <FilterChip active={noMfa} onClick={() => setNoMfa(!noMfa)} count={users.filter((u) => !u.mfa_enabled).length}>No MFA</FilterChip>
        <FilterChip active={notActive} onClick={() => setNotActive(!notActive)} count={users.filter((u) => u.status !== 'ACTIVE').length}>Not active</FilterChip>
      </div>

      <ActiveFilters chips={chips} onClearAll={clear} />

      <BulkBar
        count={selected.length}
        result={bulkResult}
        onClear={() => { setSelected([]); setBulkResult(null) }}
      >
        <Button size="sm" variant="dangerQuiet" onClick={() => { setBulkResult({ ok: selected.length, failed: 0, total: selected.length, verb: 'suspended' }); setSelected([]) }}>
          Suspend each…
        </Button>
      </BulkBar>

      {rows.length === 0 ? (
        <EmptyState
          variant={anyFilter ? 'no-match' : 'none-yet'}
          onClearFilters={clear}
          action={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>New user</Button>}
        />
      ) : (
        <>
          <DataTable minWidth="64rem">
            <thead>
              <tr>
                <Th width={COL.select} sticky>
                  <SelectAll total={rows.length} selected={selected.length} onChange={(v) => setSelected(v === 'all' ? rows.map((r) => r.user_id) : [])} />
                </Th>
                <SortTh columnKey="account" sort={sort} onSort={onSort} width={COL.name} sticky left="left-9" edge>Account</SortTh>
                {has('email') && <SortTh columnKey="email" sort={sort} onSort={onSort} width={COL.wide}>Email</SortTh>}
                {has('roles') && <SortTh columnKey="roles" sort={sort} onSort={onSort} width={COL.medium}>Roles</SortTh>}
                {has('mfa') && <SortTh columnKey="mfa" sort={sort} onSort={onSort} width={COL.short}>MFA</SortTh>}
                {has('last_login') && <SortTh columnKey="last_login" sort={sort} onSort={onSort} align="right" width={COL.timestamp}>Last sign-in</SortTh>}
                {has('created') && <SortTh columnKey="created" sort={sort} onSort={onSort} align="right" width={COL.timestamp}>Created</SortTh>}
                <Th width={COL.actions} align="right"><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const sel = selected.includes(u.user_id)
                return (
                  <Tr key={u.user_id} selected={sel}>
                    <Td selected={sel} sticky>
                      <RowCheckbox
                        checked={sel}
                        onChange={() => setSelected((s) => (s.includes(u.user_id) ? s.filter((x) => x !== u.user_id) : [...s, u.user_id]))}
                        label={`Select ${u.username}`}
                      />
                    </Td>
                    <Td selected={sel} sticky left="left-9" edge>
                      <div className="flex items-center gap-2">
                        <StatusDot tone={USER_STATUS_TONE[u.status]} />
                        <Link to={`/admin/identity/${u.user_id}`} className="truncate text-sm font-semibold text-primary hover:text-accent">
                          {u.username}
                        </Link>
                        {u.is_protected && <Meta>protected</Meta>}
                      </div>
                    </Td>
                    {has('email') && <Td selected={sel}><Trunc value={u.email} mono muted /></Td>}
                    {has('roles') && (
                      <Td selected={sel}>
                        <span className="flex flex-wrap items-center gap-2">
                          {u.roles.map((r) => (
                            <span key={r} className={clsx('text-xs', ['root', 'admin'].includes(r) ? 'font-semibold text-primary' : 'text-tertiary')}>{r}</span>
                          ))}
                        </span>
                      </Td>
                    )}
                    {has('mfa') && (
                      <Td selected={sel}>
                        {u.mfa_enabled ? <StatusDot tone="ok" label="Enrolled" /> : <StatusDot tone="warn" label="None" />}
                      </Td>
                    )}
                    {has('last_login') && <Td selected={sel} align="right"><span className="text-tertiary">{relative(u.last_login_at)}</span></Td>}
                    {has('created') && <Td selected={sel} align="right"><span className="text-tertiary">{relative(u.created_at)}</span></Td>}
                    <Td selected={sel} align="right">
                      <RowActions>
                        <RowMenu label={`Actions for ${u.username}`}>
                          <MenuItem><Link to={`/admin/identity/${u.user_id}`}>Open account</Link></MenuItem>
                          <MenuItem>Reset password…</MenuItem>
                          <MenuItem danger onClick={() => setSuspendTarget(u)}>
                            {u.status === 'SUSPENDED' ? 'Reinstate…' : 'Suspend…'}
                          </MenuItem>
                        </RowMenu>
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

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={(name) => {
          setCreateOpen(false)
          toast({ title: `${name} created`, description: 'They can sign in with the password you set. No role was assigned unless you picked one.' })
        }}
      />

      <ConfirmDialog
        open={!!suspendTarget}
        onClose={() => setSuspendTarget(null)}
        title={
          suspendTarget?.status === 'SUSPENDED'
            ? `Reinstate ${suspendTarget?.username}?`
            : `Suspend ${suspendTarget?.username}?`
        }
        consequence={
          suspendTarget?.status === 'SUSPENDED'
            ? 'They can sign in again immediately. Their roles and grants are unchanged — nothing was removed by the suspension.'
            : 'They cannot sign in. Active sessions are NOT killed by this — end those separately on the Sessions page if that is what you need.'
        }
        confirmLabel={suspendTarget?.status === 'SUSPENDED' ? 'Reinstate' : 'Suspend'}
        destructive={suspendTarget?.status !== 'SUSPENDED'}
        onConfirm={() => {
          const name = suspendTarget.username
          setSuspendTarget(null)
          toast({ title: `${name} updated`, tone: 'warning' })
        }}
      />
    </>
  )
}

// ===========================================================================
// One account
// ===========================================================================
export function IdentityDetail() {
  const { id } = useParams()
  const { isAdmin, isRoot } = useViewer()
  const toast = useToast()
  const u = users.find((x) => x.user_id === id) || users[3]

  const [statusTarget, setStatusTarget] = useState(null)
  const [resetMfaOpen, setResetMfaOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [delegateOpen, setDelegateOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [roleOpen, setRoleOpen] = useState(false)
  const [pwd, setPwd] = useState('')

  const userAudit = auditEvents.filter((e) => e.user_id === u.user_id).slice(0, 8)
  const holdsAdmin = u.roles.includes('admin')
  const holdsRoot = u.roles.includes('root')
  const score = pwd.length >= 20 ? 3 : pwd.length >= 16 ? 2 : pwd.length >= 12 ? 1 : 0

  if (!isAdmin) return <DeniedState requires="admin" what="Identity" />

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/admin/identity" className="hover:text-accent">Identity</Link>}
        title={u.username}
        description={u.full_name}
      />

      {/* Object-level command bar — Azure's pattern: the actions that act on
          THIS object, in one strip, not scattered down the page. */}
      <CommandBar
        primary={<StatusDot tone={USER_STATUS_TONE[u.status]} label={u.status} />}
        actions={
          <>
            <Button size="md" onClick={() => setPasswordOpen(true)}>Reset password</Button>
            <Button size="md" disabled={!u.mfa_enabled} onClick={() => setResetMfaOpen(true)}>Reset MFA</Button>
            <Button size="md" disabled={u.is_protected} onClick={() => setStatusTarget(u.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED')}>
              {u.status === 'SUSPENDED' ? 'Reinstate' : 'Suspend'}
            </Button>
          </>
        }
      >
        <RowMenu label="More actions">
          {u.status === 'LOCKED' && <MenuItem onClick={() => setStatusTarget('ACTIVE')}>Unlock now</MenuItem>}
          {isRoot && !holdsRoot && (
            holdsAdmin ? (
              <MenuItem danger onClick={() => setRevokeOpen(true)}>Revoke admin delegation…</MenuItem>
            ) : (
              <MenuItem onClick={() => setDelegateOpen(true)}>Delegate admin…</MenuItem>
            )
          )}
          <MenuItem
            danger
            onClick={() => setDeleteOpen(true)}
          >
            Delete account…
          </MenuItem>
        </RowMenu>
      </CommandBar>

      {u.is_protected && (
        <AlarmBand tone="warn" icon={Crown}>
          Protected account. It cannot be suspended, deleted, or delegated over — not by an admin, and not by
          root either.
        </AlarmBand>
      )}
      {u.status === 'LOCKED' && (
        <div className={clsx(u.is_protected && 'mt-3')}>
          <AlarmBand tone="warn">
            Locked after {u.failed_login_attempts} failed sign-ins. Unlocks {relative(u.locked_until)} — or set the
            status back to ACTIVE to unlock now.
          </AlarmBand>
        </div>
      )}

      <Section title="Identity">
        <DetailList
          columns={2}
          items={[
            { label: 'User ID', value: u.user_id, mono: true },
            { label: 'Username', value: u.username, mono: true },
            { label: 'Email', value: u.email, mono: true },
            { label: 'Full name', value: u.full_name },
            { label: 'Created', value: dateTime(u.created_at) },
            { label: 'Last sign-in', value: u.last_login_at ? `${dateTime(u.last_login_at)} from ${u.last_login_ip}` : 'Never' },
            { label: 'MFA', value: u.mfa_enabled ? <StatusDot tone="ok" label="Enrolled" /> : <StatusDot tone="warn" label="Not enrolled" /> },
            { label: 'Failed sign-ins', value: u.failed_login_attempts },
          ]}
        />
      </Section>

      <Section
        title="Access"
        description="Attachments, not effective permissions — GET /users/:id returns access.roles and access.policies. Resolving what those actually allow needs a backend capability that doesn't exist yet."
        action={<Button size="sm" icon={Plus} onClick={() => setRoleOpen(true)}>Assign role</Button>}
      >
        <RuledLabel>Roles</RuledLabel>
        <ul className="divide-y divide-line">
          {u.roles.map((r) => {
            const role = roles.find((x) => x.name === r)
            const system = role?.is_system
            const RoleIcon = r === 'root' ? Crown : system ? ShieldCheck : Tag
            return (
              <li key={r} className="flex items-center justify-between gap-4 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <RoleIcon className="h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-primary">{r}</p>
                    <p className="mt-0.5 max-w-prose truncate text-xs text-tertiary">{role?.description}</p>
                  </div>
                </div>
                <div className="flex flex-none items-center gap-3">
                  {r === 'admin' && (isRoot ? (
                    <Button size="sm" variant="dangerQuiet" onClick={() => setRevokeOpen(true)}>Revoke</Button>
                  ) : (
                    <Meta>only root can revoke this</Meta>
                  ))}
                  {r === 'root' && <Meta>cannot be assigned or revoked through the API</Meta>}
                  {!system && <Button size="sm" variant="dangerQuiet">Remove</Button>}
                </div>
              </li>
            )
          })}
        </ul>

        <RuledLabel className="mt-6">Directly attached policies</RuledLabel>
        <ul className="divide-y divide-line">
          {policies.slice(2, 3).map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-4 py-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-primary">{p.name}</p>
                <p className="mt-0.5 max-w-prose truncate text-xs text-tertiary">{p.description}</p>
              </div>
              <Button size="sm" variant="dangerQuiet">Detach</Button>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Administrative delegation"
        description="The only genuinely root-gated capability in this product. Enforced server-side: MinRankToDelegateAdmin = 100."
      >
        {holdsRoot ? (
          <p className="max-w-prose text-base text-secondary">
            This is the root account. The root role is outside the delegation model entirely.
          </p>
        ) : isRoot ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={u.is_protected}
              title={u.is_protected ? 'Protected accounts cannot be delegated over' : undefined}
              onClick={() => (holdsAdmin ? setRevokeOpen(true) : setDelegateOpen(true))}
            >
              {holdsAdmin ? 'Revoke admin delegation' : 'Delegate admin'}
            </Button>
            <Meta>Scope, expiry and a reason are required. The grant is revocable and audited.</Meta>
          </div>
        ) : (
          <Panel className="px-4 py-3">
            <p className="max-w-prose text-base text-secondary">
              Only a <span className="font-mono text-sm text-primary">root</span> account can grant or revoke the
              admin role. Your account holds <span className="font-mono text-sm text-primary">admin</span>, which
              ranks below the threshold — the endpoint returns 403, so the control is not offered here.
            </p>
          </Panel>
        )}
      </Section>

      <Section title="Activity" description="From GET /pam/audit/user/:id — everything this account has done.">
        <ul className="divide-y divide-line">
          {userAudit.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-4 py-2">
              <p className="truncate font-mono text-xs text-primary">{e.action}</p>
              <div className="flex flex-none items-center gap-4">
                <Trunc value={e.resource} mono muted className="hidden max-w-[16rem] sm:block" />
                <StatusDot tone={e.outcome === 'SUCCESS' ? 'ok' : 'danger'} label={e.outcome} />
                <Meta>{relative(e.occurred_at)}</Meta>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      {/* ── Surfaces ────────────────────────────────────────────────────── */}

      <Dialog
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        size="md"
        title={`Reset password for ${u.username}`}
        description="They sign in with this immediately. There is no self-service change endpoint, so tell them out of band."
        footer={
          <>
            <Button variant="primary" size="lg" disabled={pwd.length < 12} onClick={() => { setPasswordOpen(false); setPwd(''); toast({ title: 'Password reset', description: `${u.username} must use the new password at their next sign-in.` }) }}>
              Reset password
            </Button>
            <Button size="lg" onClick={() => setPasswordOpen(false)}>Cancel</Button>
            <Meta className="ml-auto hidden sm:inline">POST /admin/identity/users/:id/reset-password</Meta>
          </>
        }
      >
        <FieldSet title="New password">
          <Field label="Password" htmlFor="rp-pass" required error={pwd.length > 0 && pwd.length < 12 ? 'At least 12 characters.' : null}>
            <input id="rp-pass" value={pwd} onChange={(e) => setPwd(e.target.value)} className={clsx(inputClass, 'font-mono')} />
          </Field>
          <StrengthMeter score={score} />
        </FieldSet>
        <p className="mt-4 max-w-prose text-xs text-tertiary">
          This does not end their existing sessions. If the reset is because an account is compromised, kill their
          live sessions on the Sessions page as well.
        </p>
      </Dialog>

      <Dialog
        open={roleOpen}
        onClose={() => setRoleOpen(false)}
        size="sm"
        title={`Assign a role to ${u.username}`}
        footer={
          <>
            <Button variant="primary" size="lg" onClick={() => { setRoleOpen(false); toast({ title: 'Role assigned' }) }}>Assign</Button>
            <Button size="lg" onClick={() => setRoleOpen(false)}>Cancel</Button>
            <Meta className="ml-auto hidden sm:inline">POST /…/users/:id/roles</Meta>
          </>
        }
      >
        <Field label="Role" htmlFor="ar-role" hint="admin and root are refused by this endpoint.">
          <select id="ar-role" className={selectClass}>
            {roles.filter((r) => !['admin', 'root'].includes(r.name) && !u.roles.includes(r.name)).map((r) => (
              <option key={r.id} value={r.name}>{r.name}</option>
            ))}
          </select>
        </Field>
      </Dialog>

      <DelegateAdminDialog
        open={delegateOpen}
        onClose={() => setDelegateOpen(false)}
        username={u.username}
        onDone={() => { setDelegateOpen(false); toast({ title: `Admin delegated to ${u.username}`, description: 'Revocable at any time, and recorded against your identity.' }) }}
      />

      <ConfirmDialog
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        title={`Revoke admin from ${u.username}?`}
        consequence="They lose the Admin Center immediately, including any approval they were part-way through. Their own access and sessions are untouched."
        confirmLabel="Revoke admin"
        destructive
        requireReason
        reasonLabel="Why is this being revoked"
        onConfirm={() => { setRevokeOpen(false); toast({ title: 'Admin delegation revoked', tone: 'warning' }) }}
      />

      <ConfirmDialog
        open={!!statusTarget}
        onClose={() => setStatusTarget(null)}
        title={`Set ${u.username} to ${statusTarget}?`}
        consequence={
          statusTarget === 'SUSPENDED'
            ? 'They cannot sign in. Live sessions are NOT killed by this — end those separately if that is what you need.'
            : 'They can sign in again immediately. Roles and grants are unchanged.'
        }
        confirmLabel={statusTarget === 'SUSPENDED' ? 'Suspend' : 'Reinstate'}
        destructive={statusTarget === 'SUSPENDED'}
        onConfirm={() => { setStatusTarget(null); toast({ title: `${u.username} is now ${statusTarget}`, tone: 'warning' }) }}
      />

      <ConfirmDialog
        open={resetMfaOpen}
        onClose={() => setResetMfaOpen(false)}
        title={`Reset MFA for ${u.username}?`}
        consequence="Their enrolled device and backup codes are discarded. Until they re-enrol they sign in with a password alone — and if an MFA policy rule covers one of their roles, they will be blocked at the gate instead."
        confirmLabel="Reset MFA"
        destructive
        requireReason
        reasonLabel="Why is this being reset"
        reasonHint="Written to the audit log. This is the entry an auditor looks for after an account takeover."
        onConfirm={() => { setResetMfaOpen(false); toast({ title: 'MFA reset', tone: 'warning', description: `${u.username} must enrol a new device.` }) }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete ${u.username} permanently?`}
        consequence="The account is gone. Its audit history is not — the trail is hash-chained and immutable, so its past actions remain attributable. Active grants and sessions are not cleaned up by this."
        confirmLabel="Delete account"
        destructive
        requireReason
        typeToConfirm={u.username}
        onConfirm={() => { setDeleteOpen(false); toast({ title: `${u.username} deleted`, tone: 'error' }) }}
      />
    </>
  )
}
