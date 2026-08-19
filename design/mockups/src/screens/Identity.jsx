import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { Crown, Plus, Search, ShieldCheck, Tag } from 'lucide-react'
import { useViewer } from '../state/viewer'
import { auditEvents, policies, roles, users } from '../fixtures'
import {
  AlarmBand, Button, DetailList, FilterChip, Meta, PageHeader, Panel,
  RuledLabel, Section, StatusDot, inputClass,
} from '../ui/primitives'
import { COL, DataTable, RowActions, Td, Th, Tr, Trunc } from '../ui/table'
import { DeniedState, EmptyState } from '../ui/states'
import { dateTime, relative, USER_STATUS_TONE } from '../lib/format'

// ===========================================================================
// Admin Center → Identity
// ===========================================================================
// WHAT CHANGED
//
//  • Roles are a column that always renders, because lib/roles.js already
//    absorbs the payload difference between the list (roles may be absent) and
//    the detail (access.roles as Role objects). The list still hydrates from
//    GET /users/:id — that N+1 is a backend gap, listed in Phase 5.
//  • MFA state becomes a facet. "Who is gated by an MFA rule but hasn't
//    enrolled" is the question this page gets asked and currently can't answer.
//  • On the detail page, lifecycle actions are separated by RISK (Okta's
//    model): routine edits at the top, reversible lifecycle in the middle,
//    irreversible at the bottom under its own rule. Today "edit full name" and
//    "delete this account" are the same visual weight.
//  • Root-only controls SAY they are root-only instead of rendering disabled
//    with no explanation.
//
// PERMISSION FACTS THIS PAGE ENCODES (verified in identity_delegation.go)
//   • Only root may delegate or revoke the admin role (MinRankToDelegateAdmin
//     = 100). An admin pressing it gets 403, so an admin doesn't get the button.
//   • Plain AssignRole refuses admin and root for everyone.
//   • is_protected accounts cannot be suspended, deleted or delegated over —
//     including by root.
//
// ENDPOINTS: GET/POST /admin/identity/users, GET/PATCH/DELETE /users/:id,
//   POST /users/:id/status · /reset-password · /reset-mfa ⚠ · /roles · /policies,
//   DELETE /users/:id/roles/:name · /policies/:id,
//   POST/DELETE /users/:id/delegate-admin, GET /users/:id/delegation,
//   GET /audit/user/:id.  (⚠ = not in the supplied backend snapshot; verify.)

export function IdentityList() {
  const { isAdmin } = useViewer()
  const [q, setQ] = useState('')
  const [noMfa, setNoMfa] = useState(false)
  const [privileged, setPrivileged] = useState(false)
  const [notActive, setNotActive] = useState(false)

  const rows = useMemo(() => {
    let r = users
    if (q) {
      const s = q.toLowerCase()
      r = r.filter((u) => u.username.toLowerCase().includes(s) || u.email.toLowerCase().includes(s) || (u.full_name || '').toLowerCase().includes(s))
    }
    if (noMfa) r = r.filter((u) => !u.mfa_enabled)
    if (privileged) r = r.filter((u) => u.roles.some((x) => ['root', 'admin'].includes(x)))
    if (notActive) r = r.filter((u) => u.status !== 'ACTIVE')
    return r
  }, [q, noMfa, privileged, notActive])

  if (!isAdmin) return <DeniedState requires="admin" what="Identity" />

  const filtered = !!q || noMfa || privileged || notActive
  const clear = () => { setQ(''); setNoMfa(false); setPrivileged(false); setNotActive(false) }

  return (
    <>
      <PageHeader
        eyebrow="Admin Center"
        title="Identity"
        description="Every account in the org, what it holds, and whether it can actually sign in."
        actions={<Button variant="primary" icon={Plus}>New user</Button>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-[20rem]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" strokeWidth={1.75} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Username, email or name" aria-label="Search accounts" className={clsx(inputClass, 'pl-7')} />
        </div>
        <FilterChip active={privileged} onClick={() => setPrivileged(!privileged)} count={users.filter((u) => u.roles.some((x) => ['root', 'admin'].includes(x))).length}>
          Privileged
        </FilterChip>
        <FilterChip active={noMfa} onClick={() => setNoMfa(!noMfa)} count={users.filter((u) => !u.mfa_enabled).length}>
          No MFA
        </FilterChip>
        <FilterChip active={notActive} onClick={() => setNotActive(!notActive)} count={users.filter((u) => u.status !== 'ACTIVE').length}>
          Not active
        </FilterChip>
        <span className="ml-auto text-xs tabular text-tertiary">{rows.length} of {users.length}</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState variant={filtered ? 'no-match' : 'none-yet'} onClearFilters={clear} />
      ) : (
        <DataTable minWidth="72rem">
          <thead>
            <tr>
              <Th width={COL.name} sticky edge>Account</Th>
              <Th width={COL.wide}>Email</Th>
              <Th width={COL.medium}>Roles</Th>
              <Th width={COL.short}>MFA</Th>
              <Th width={COL.timestamp} align="right">Last sign-in</Th>
              <Th width={COL.actions} align="right"><span className="sr-only">Actions</span></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <Tr key={u.user_id}>
                <Td sticky edge>
                  <div className="flex items-center gap-2">
                    <StatusDot tone={USER_STATUS_TONE[u.status]} />
                    <Link to={`/admin/identity/${u.user_id}`} className="truncate text-sm font-semibold text-primary hover:text-accent">
                      {u.username}
                    </Link>
                    {u.is_protected && <Meta>protected</Meta>}
                  </div>
                  <Meta className="block truncate pl-4">{u.full_name}</Meta>
                </Td>
                <Td><Trunc value={u.email} mono muted /></Td>
                <Td>
                  <span className="flex flex-wrap items-center gap-2">
                    {u.roles.map((r) => (
                      <span key={r} className={clsx('text-xs', ['root', 'admin'].includes(r) ? 'font-semibold text-primary' : 'text-tertiary')}>
                        {r}
                      </span>
                    ))}
                  </span>
                </Td>
                <Td>
                  {u.mfa_enabled ? <StatusDot tone="ok" label="Enrolled" /> : <StatusDot tone="warn" label="None" />}
                </Td>
                <Td align="right"><span className="text-tertiary">{relative(u.last_login_at)}</span></Td>
                <Td align="right">
                  <RowActions>
                    <Link to={`/admin/identity/${u.user_id}`} className="text-xs font-semibold text-accent hover:underline">Open</Link>
                  </RowActions>
                </Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <p className="mt-3 text-xs text-tertiary">
        Bulk selection is deliberately absent: no bulk endpoint exists, so a &ldquo;suspend 12 accounts&rdquo;
        button would be twelve requests with twelve failure modes wearing one button&apos;s clothes.
      </p>
    </>
  )
}

// ===========================================================================
// One account
// ===========================================================================
export function IdentityDetail() {
  const { id } = useParams()
  const { isAdmin, isRoot } = useViewer()
  const u = users.find((x) => x.user_id === id) || users[3]
  const userAudit = auditEvents.filter((e) => e.user_id === u.user_id).slice(0, 8)
  const holdsAdmin = u.roles.includes('admin')
  const holdsRoot = u.roles.includes('root')

  if (!isAdmin) return <DeniedState requires="admin" what="Identity" />

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/admin/identity" className="hover:text-accent">Identity</Link>}
        title={u.username}
        description={u.full_name}
        actions={
          <div className="flex items-center gap-2">
            <StatusDot tone={USER_STATUS_TONE[u.status]} label={u.status} />
          </div>
        }
      />

      {u.is_protected && (
        <AlarmBand tone="warn" icon={Crown}>
          Protected account. It cannot be suspended, deleted, or delegated over — not by an admin, and not by
          root either.
        </AlarmBand>
      )}
      {u.status === 'LOCKED' && (
        <div className={clsx(u.is_protected && 'mt-4')}>
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
      >
        <RuledLabel>Roles</RuledLabel>
        <ul className="divide-y divide-line">
          {u.roles.map((r) => {
            const role = roles.find((x) => x.name === r)
            const system = role?.is_system
            const RoleIcon = r === 'root' ? Crown : system ? ShieldCheck : Tag
            return (
              <li key={r} className="flex items-center justify-between gap-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <RoleIcon className="h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-primary">{r}</p>
                    <p className="mt-0.5 max-w-prose text-xs text-tertiary">{role?.description}</p>
                  </div>
                </div>
                <div className="flex flex-none items-center gap-3">
                  {r === 'admin' &&
                    (isRoot ? (
                      <Button size="sm" variant="dangerQuiet">Revoke delegation</Button>
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

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" icon={Plus}>Assign a role</Button>
          <Meta>
            The admin and root roles are refused by this endpoint — admin is granted through delegation below,
            and root cannot be granted at all.
          </Meta>
        </div>

        <RuledLabel className="mt-8">Directly attached policies</RuledLabel>
        {policies.filter((p) => !p.is_system).length === 0 ? (
          <EmptyState title="None attached" description="This account inherits everything from its roles." />
        ) : (
          <ul className="divide-y divide-line">
            {policies.slice(2, 3).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-primary">{p.name}</p>
                  <p className="mt-0.5 max-w-prose text-xs text-tertiary">{p.description}</p>
                </div>
                <Button size="sm" variant="dangerQuiet">Detach</Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Root-only zone. Present for an admin too — but explaining itself
          rather than showing a dead button. */}
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
            <Button variant="primary" disabled={u.is_protected} title={u.is_protected ? 'Protected accounts cannot be delegated over' : undefined}>
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

      {/* Risk-separated lifecycle. This is the zone that was indistinguishable
          from "edit full name" in the current build. */}
      <Section
        title="Account lifecycle"
        description="Reversible operations. Each one is written to the audit log against your identity."
        className="mt-12 border-t border-line pt-8"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={u.is_protected}>{u.status === 'SUSPENDED' ? 'Reinstate' : 'Suspend'}</Button>
          <Button disabled={u.status !== 'LOCKED'}>Unlock</Button>
          <Button>Reset password</Button>
          <Button disabled={!u.mfa_enabled}>Reset MFA</Button>
        </div>
        <p className="mt-3 max-w-prose text-xs text-tertiary">
          Resetting MFA lets this account sign in with a password alone until it re-enrols. If an MFA policy rule
          covers one of its roles, it will be blocked at the enforcement gate instead — check{' '}
          <Link to="/admin/mfa-policy" className="text-accent hover:underline">MFA Policy</Link> first.
        </p>

        <RuledLabel className="mt-8">Irreversible</RuledLabel>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="danger" disabled={u.is_protected} title={u.is_protected ? 'Protected accounts cannot be deleted' : undefined}>
            Delete this account
          </Button>
          <Meta tone="danger">
            Deletion does not remove this account&apos;s audit history — the trail is hash-chained and immutable.
          </Meta>
        </div>
      </Section>
    </>
  )
}
