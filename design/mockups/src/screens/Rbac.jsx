import { useState } from 'react'
import clsx from 'clsx'
import { Plus, X } from 'lucide-react'
import { useViewer } from '../state/viewer'
import { policies, roles, users } from '../fixtures'
import { Button, DetailList, Meta, PageHeader, Panel, RuledLabel, Section, StatusDot } from '../ui/primitives'
import { COL, DataTable, RowActions, SortTh, Td, Th, Tr, Trunc, nextSort, sortRows } from '../ui/table'
import { CommandBar, ExportMenu, PreferencesMenu, RowMenu } from '../ui/listchrome'
import { ConfirmDialog, MenuItem, useToast } from '../ui/overlay'
import { CreatePolicyDialog, CreateRoleDialog } from '../surfaces/CreateForms'
import { DeniedState, EmptyState } from '../ui/states'
import { relative } from '../lib/format'

// ===========================================================================
// Admin Center → Roles and Policies
// ===========================================================================
// WHAT CHANGED
//
//  • A policy is rendered as RULE LINES, the way AWS IAM renders a policy
//    document: EFFECT · ACTION · ON · RESOURCE, monospace, one per line.
//    Today `actions[]` and `resources[]` are two rows of badge soup, which is
//    the same information at four times the reading cost.
//  • System objects state WHY they are locked instead of just being greyed.
//  • The drawer shows what a role grants, resolved through its policies —
//    which is the question "what does data-analyst actually let someone do".
//
// NOT BUILT, DELIBERATELY: "who holds this role". GET /admin/rbac/roles
// returns no membership count and there is no endpoint that answers it without
// walking every user. It is listed under Requires backend support rather than
// mocked with a number the API can't produce.

function RuleLines({ policy }) {
  const effect = policy.effect === 'deny' ? 'DENY' : 'ALLOW'
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-subtle px-3 py-2">
      <table className="w-full font-mono text-xs">
        <tbody>
          {policy.actions.map((a) =>
            policy.resources.map((r) => (
              <tr key={`${a}|${r}`}>
                <td className={clsx('py-0.5 pr-3 font-semibold', effect === 'DENY' ? 'text-danger' : 'text-ok')}>{effect}</td>
                <td className="py-0.5 pr-3 text-primary">{a}</td>
                <td className="py-0.5 pr-3 text-tertiary">ON</td>
                <td className="py-0.5 text-primary">{r}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

function RoleDrawer({ role, onClose }) {
  if (!role) return null
  // Which policies are attached is a real read: GET /admin/rbac/roles/:id
  // returns { role, policies }.
  const attached =
    role.name === 'admin' || role.name === 'root'
      ? policies.filter((p) => p.name === 'full-access')
      : role.name === 'user'
        ? policies.filter((p) => p.name === 'standard-user-access')
        : policies.filter((p) => !p.is_system)

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="anim-overlay absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <aside className="anim-drawer relative flex h-full w-full max-w-[34rem] flex-col border-l border-line bg-surface shadow-overlay">
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line px-4">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-primary">{role.name}</p>
            <p className="truncate text-xs text-tertiary">{role.is_system ? 'System role' : 'Custom role'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto flex h-9 w-9 items-center justify-center rounded text-tertiary hover:bg-hover">
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <p className="max-w-prose text-base text-secondary">{role.description}</p>

          <RuledLabel className="mt-6">What it grants</RuledLabel>
          <div className="space-y-4">
            {attached.map((p) => (
              <div key={p.id}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-primary">{p.name}</span>
                  {!role.is_system && <Button size="sm" variant="dangerQuiet">Detach</Button>}
                </div>
                <RuleLines policy={p} />
              </div>
            ))}
          </div>

          {!role.is_system && (
            <div className="mt-4">
              <Button size="sm" icon={Plus}>Attach a policy</Button>
            </div>
          )}

          <RuledLabel className="mt-8">Members</RuledLabel>
          <p className="max-w-prose text-sm text-tertiary">
            Not shown. No endpoint returns role membership — answering &ldquo;who holds this role&rdquo; today
            means walking every account. Raised as a backend gap rather than guessed at.
          </p>
        </div>
      </aside>
    </div>
  )
}

export function RolesPage() {
  const { isAdmin } = useViewer()
  const toast = useToast()
  const [open, setOpen] = useState(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [sort, setSort] = useState({ key: 'role', dir: 'asc' })
  const rows = sortRows(roles, sort, { role: (r) => r.name, kind: (r) => (r.is_system ? 0 : 1), created: (r) => r.created_at })
  const onSort = (key) => setSort((s2) => nextSort(s2, key))
  if (!isAdmin) return <DeniedState requires="admin" what="Roles" />

  return (
    <>
      <PageHeader
        eyebrow="Admin Center"
        title="Roles"
        description="A role is a bundle of policies. Membership of a role is what gates the MFA rules and the Admin Center."
      />

      <CommandBar
        primary={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>New role</Button>}
        summary={`${roles.length} roles`}
      >
        <ExportMenu count={roles.length} />
      </CommandBar>

      <DataTable minWidth="52rem">
        <thead>
          <tr>
            <SortTh columnKey="role" sort={sort} onSort={onSort} width={COL.name} sticky edge>Role</SortTh>
            <Th width="w-[26rem]">Description</Th>
            <SortTh columnKey="kind" sort={sort} onSort={onSort} width={COL.short}>Kind</SortTh>
            <SortTh columnKey="created" sort={sort} onSort={onSort} align="right" width={COL.timestamp}>Created</SortTh>
            <Th width={COL.actions} align="right"><span className="sr-only">Actions</span></Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.id} onClick={() => setOpen(r)}>
              <Td sticky edge>
                <span className="truncate text-sm font-semibold text-primary">{r.name}</span>
              </Td>
              <Td><Trunc value={r.description} muted /></Td>
              <Td>{r.is_system ? <Meta>system</Meta> : <Meta tone="ok">custom</Meta>}</Td>
              <Td align="right"><span className="text-tertiary">{relative(r.created_at)}</span></Td>
              <Td align="right">
                <RowActions>
                  <span onClick={(e) => e.stopPropagation()}>
                    <RowMenu label={`Actions for ${r.name}`}>
                      <MenuItem onClick={() => setOpen(r)}>What it grants…</MenuItem>
                      {r.is_system ? (
                        <p className="px-3 py-2 text-xs leading-relaxed text-tertiary">
                          System role — part of the install. The policy engine resolves against it, so it cannot
                          be deleted, by an admin or by root.
                        </p>
                      ) : (
                        <MenuItem danger onClick={() => setDeleteTarget(r)}>Delete role…</MenuItem>
                      )}
                    </RowMenu>
                  </span>
                </RowActions>
              </Td>
            </Tr>
          ))}
        </tbody>
      </DataTable>

      <p className="mt-3 max-w-prose text-xs text-tertiary">
        <span className="font-mono text-primary">root</span>,{' '}
        <span className="font-mono text-primary">admin</span> and{' '}
        <span className="font-mono text-primary">user</span> are seeded by the install and cannot be renamed or
        deleted — including by root. Deleting them would leave the policy engine with no roles to resolve.
      </p>

      <RoleDrawer role={open} onClose={() => setOpen(null)} />

      <CreateRoleDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={(name) => { setCreateOpen(false); toast({ title: `Role “${name}” created`, description: 'It grants nothing until a policy is attached.' }) }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={`Delete role “${deleteTarget?.name}”?`}
        consequence="Everyone holding it loses whatever it granted, immediately. Any MFA policy rule that targets this role stops applying — check MFA Policy before deleting a role that is gated."
        confirmLabel="Delete role"
        destructive
        onConfirm={() => { const n = deleteTarget.name; setDeleteTarget(null); toast({ title: `Role “${n}” deleted`, tone: 'error' }) }}
      />
    </>
  )
}

export function PoliciesPage() {
  const { isAdmin } = useViewer()
  const toast = useToast()
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  if (!isAdmin) return <DeniedState requires="admin" what="Policies" />

  return (
    <>
      <PageHeader
        eyebrow="Admin Center"
        title="Policies"
        description="Allow and deny rules over actions and resources. A deny always beats an allow."
      />

      <CommandBar
        primary={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>New policy</Button>}
        summary={`${policies.length} policies`}
      >
        <ExportMenu count={policies.length} />
      </CommandBar>

      <div className="space-y-8">
        {policies.map((p) => (
          <div key={p.id}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-lg font-semibold text-primary">{p.name}</h2>
                  <StatusDot tone={p.effect === 'deny' ? 'danger' : 'ok'} label={p.effect} />
                  {p.is_system && <Meta>system</Meta>}
                </div>
                <p className="mt-1 max-w-prose text-sm text-secondary">{p.description}</p>
              </div>
              <div className="flex flex-none items-center gap-2">
                <Button size="sm" disabled={p.is_system} title={p.is_system ? 'System policies are part of the install' : undefined}>Edit</Button>
                <Button size="sm" variant="dangerQuiet" disabled={p.is_system} onClick={() => setDeleteTarget(p)}>Delete</Button>
              </div>
            </div>
            <RuleLines policy={p} />
            <p className="mt-2 text-xs text-tertiary tabular">
              {p.actions.length} action{p.actions.length === 1 ? '' : 's'} × {p.resources.length} resource
              {p.resources.length === 1 ? '' : 's'} · created {relative(p.created_at)}
            </p>
          </div>
        ))}
      </div>

      <CreatePolicyDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={(name) => { setCreateOpen(false); toast({ title: `Policy “${name}” created`, description: 'Attach it to a role or an account for it to take effect.' }) }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={`Delete policy “${deleteTarget?.name}”?`}
        consequence={
          deleteTarget?.effect === 'deny'
            ? 'This is a DENY policy. Deleting it does not remove access — it removes a refusal, so anyone an allow-policy already covers gains what this was blocking.'
            : 'Every role and account it is attached to loses these actions immediately.'
        }
        confirmLabel="Delete policy"
        destructive
        onConfirm={() => { const n = deleteTarget.name; setDeleteTarget(null); toast({ title: `Policy “${n}” deleted`, tone: 'error' }) }}
      />
    </>
  )
}
