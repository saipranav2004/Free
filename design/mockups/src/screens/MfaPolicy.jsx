import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ShieldAlert } from 'lucide-react'
import { useViewer } from '../state/viewer'
import { mfaCompliance, mfaPolicy, roles } from '../fixtures'
import {
  AlarmBand, Button, FilterChip, HeroMetric, Meta, PageHeader, Panel,
  RuledLabel, Section, StatRail, StatusDot,
} from '../ui/primitives'
import { COL, DataTable, RowActions, Td, Th, Tr, Trunc } from '../ui/table'
import { CommandBar, ExportMenu, RowMenu } from '../ui/listchrome'
import { ConfirmDialog, MenuItem, useToast } from '../ui/overlay'
import { MfaRuleDialog } from '../surfaces/CreateForms'
import { DeniedState, DegradedState, EmptyState } from '../ui/states'
import { relative } from '../lib/format'

// ===========================================================================
// Admin Center → MFA Policy
// ===========================================================================
// WHAT CHANGED — this is the clearest "the API already returns more than the
// UI shows" case in the whole audit.
//
// GET /admin/mfa-policy/compliance returns, per account: who is gated by a
// rule, who has enrolled, and WHO WOULD BE LOCKED OUT if every rule were
// switched to enforce right now. That is Entra Conditional Access's impact
// preview, already implemented server-side — and today it sits below the rule
// editor as a secondary table.
//
// So the page inverts: the impact preview IS the page, the rule editor is the
// thing you scroll to once you've decided. The hero metric is the number that
// should stop you pressing Save.
//
// ENDPOINTS  GET /admin/mfa-policy · GET /…/compliance
//            PUT /…/rules/:roleName · DELETE /…/rules/:roleName
// ⚠ None of these exist in the supplied backend snapshot — the UI cites a
// handler that isn't in the zip. The page therefore also ships a DEGRADED
// state for a deployment that predates them (Phase 4.7).

const MODE_TONE = { enforce: 'ok', grace: 'warn', monitor: 'neutral', off: 'neutral' }
const MODE_COPY = {
  enforce: 'Sign-in is refused without MFA.',
  grace: 'Sign-in is allowed, with a deadline to enrol.',
  monitor: 'Recorded, never blocked.',
  off: 'No rule applies.',
}

export default function MfaPolicyPage() {
  const { isAdmin } = useViewer()
  const toast = useToast()
  const [showDegraded, setShowDegraded] = useState(false)
  const [onlyAtRisk, setOnlyAtRisk] = useState(true)
  const [editRule, setEditRule] = useState(null)
  const [deleteRule, setDeleteRule] = useState(null)

  const accounts = mfaCompliance.accounts
  const atRisk = useMemo(() => accounts.filter((a) => a.would_lock_out), [accounts])
  const gated = accounts.filter((a) => a.gated)
  const rows = onlyAtRisk ? atRisk : accounts

  if (!isAdmin) return <DeniedState requires="admin" what="MFA Policy" />

  return (
    <>
      <PageHeader
        eyebrow="Admin Center"
        title="MFA Policy"
        description="Rules target a role. Everyone holding that role falls under it — membership of the role is the gate."
        actions={
          <Button size="sm" onClick={() => setShowDegraded(!showDegraded)}>
            {showDegraded ? 'Show normal state' : 'Preview degraded state'}
          </Button>
        }
      />

      {showDegraded ? (
        <DegradedState feature="MFA policy" endpoint="GET /api/v1/pam/admin/mfa-policy" />
      ) : (
        <>
          {/* The number that should stop you. */}
          <HeroMetric
            label="Would be locked out if every rule enforced now"
            value={atRisk.length}
            tone={atRisk.length > 0 ? 'danger' : 'ok'}
            caption={
              atRisk.length > 0
                ? 'These accounts hold a gated role and have no MFA device enrolled. Switching their rule to enforce signs them out and keeps them out.'
                : 'Every account under a rule has an enrolled device. Enforcing is safe.'
            }
            // NO "notify these users" button: there is no notification
            // endpoint in this API, and inventing one is exactly the failure
            // mode this exercise forbids. Reviewing them is navigation to a
            // page that already exists.
            action={
              atRisk.length > 0 ? (
                <Button variant="primary" size="lg" to="/admin/identity">
                  Review these accounts
                </Button>
              ) : null
            }
          />

          <StatRail
            className="mt-6"
            items={[
              { label: 'Accounts under a rule', value: gated.length },
              { label: 'Enrolled', value: accounts.filter((a) => a.mfa_enabled).length },
              { label: 'Roles covered', value: `${mfaPolicy.summary.roles_covered} of ${mfaPolicy.summary.roles_total}` },
            ]}
          />

          {atRisk.length > 0 && (
            <div className="mt-6">
              <AlarmBand tone="warn" icon={ShieldAlert}>
                {atRisk.length} account{atRisk.length === 1 ? '' : 's'} would lose access. Check the list before
                changing any rule to enforce.
              </AlarmBand>
            </div>
          )}

          <Section
            title="Impact"
            description="Per-account, from GET /admin/mfa-policy/compliance. This is what a rule change actually does."
            action={
              <FilterChip active={onlyAtRisk} onClick={() => setOnlyAtRisk(!onlyAtRisk)} count={atRisk.length}>
                At risk only
              </FilterChip>
            }
          >
            {rows.length === 0 ? (
              <EmptyState
                variant={onlyAtRisk ? 'no-match' : 'none-yet'}
                title="Nobody is at risk"
                description="Every account under an MFA rule has enrolled a device."
                onClearFilters={() => setOnlyAtRisk(false)}
              />
            ) : (
              <DataTable minWidth="48rem">
                <thead>
                  <tr>
                    <Th width={COL.name} sticky edge>Account</Th>
                    <Th width={COL.medium}>Roles</Th>
                    <Th width={COL.short}>Under a rule</Th>
                    <Th width={COL.short}>MFA</Th>
                    <Th width={COL.medium}>If enforced now</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <Tr key={a.user_id}>
                      <Td sticky edge>
                        <Link to={`/admin/identity/${a.user_id}`} className="truncate text-sm font-semibold text-primary hover:text-accent">
                          {a.username}
                        </Link>
                      </Td>
                      <Td><Trunc value={a.roles.join(', ')} muted /></Td>
                      <Td>{a.gated ? 'Yes' : <Meta>No</Meta>}</Td>
                      <Td>{a.mfa_enabled ? <StatusDot tone="ok" label="Enrolled" /> : <StatusDot tone="warn" label="None" />}</Td>
                      <Td>
                        {a.would_lock_out ? (
                          <StatusDot tone="danger" label="Locked out" />
                        ) : (
                          <StatusDot tone="ok" label="Unaffected" />
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Section>

          <Section
            title="Rules"
            description="One rule per role. A role with no rule is not gated at all."
            action={<Button size="sm" onClick={() => setEditRule({ role_name: '', mode: 'monitor', grace_period_days: 14 })}>Add a rule</Button>}
          >
            <DataTable minWidth="48rem">
              <thead>
                <tr>
                  <Th width={COL.name} sticky edge>Role</Th>
                  <Th width={COL.short}>Mode</Th>
                  <Th width="w-[22rem]">What that means</Th>
                  <Th width={COL.short} align="right">Grace</Th>
                  <Th width={COL.timestamp} align="right">Updated</Th>
                  <Th width={COL.actions} align="right"><span className="sr-only">Actions</span></Th>
                </tr>
              </thead>
              <tbody>
                {mfaPolicy.rules.map((r) => {
                  // Risk is attributable to a rule only when that rule actually
                  // gates. A monitor rule never blocks anyone, so counting
                  // at-risk accounts against it would be a false alarm.
                  const gates = r.mode === 'enforce' || r.mode === 'grace'
                  const riskHere = gates ? atRisk.filter((a) => a.roles.includes(r.role_name)).length : 0
                  return (
                    <Tr key={r.role_name}>
                      <Td sticky edge>
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold text-primary">{r.role_name}</span>
                          {riskHere > 0 && <Meta tone="danger">{riskHere} at risk</Meta>}
                        </span>
                      </Td>
                      <Td><StatusDot tone={MODE_TONE[r.mode]} label={r.mode} /></Td>
                      <Td><Trunc value={MODE_COPY[r.mode]} muted /></Td>
                      <Td align="right">{r.grace_period_days ? `${r.grace_period_days} d` : '—'}</Td>
                      <Td align="right"><span className="text-tertiary">{relative(r.updated_at)}</span></Td>
                      <Td align="right">
                        <RowActions>
                          <Button size="sm" onClick={() => setEditRule(r)}>Edit</Button>
                          <RowMenu label={`Actions for the ${r.role_name} rule`}>
                            <MenuItem onClick={() => setEditRule(r)}>Change mode…</MenuItem>
                            <MenuItem danger onClick={() => setDeleteRule(r)}>Remove rule…</MenuItem>
                          </RowMenu>
                        </RowActions>
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </DataTable>

            <p className="mt-3 max-w-prose text-xs text-tertiary">
              Roles with no rule:{' '}
              {roles
                .filter((r) => !mfaPolicy.rules.some((x) => x.role_name === r.name))
                .map((r) => r.name)
                .join(', ') || 'none'}
              . An account holding only un-ruled roles is never challenged.
            </p>
          </Section>
        </>
      )}

      <MfaRuleDialog
        open={!!editRule}
        onClose={() => setEditRule(null)}
        rule={editRule}
        atRisk={editRule ? atRisk.filter((a) => a.roles.includes(editRule.role_name)).length : 0}
        onDone={(mode) => { const n = editRule.role_name; setEditRule(null); toast({ title: `Rule for ${n} set to ${mode}`, tone: mode === 'enforce' ? 'warning' : 'success' }) }}
      />

      <ConfirmDialog
        open={!!deleteRule}
        onClose={() => setDeleteRule(null)}
        title={`Remove the MFA rule for ${deleteRule?.role_name}?`}
        consequence="Accounts holding that role stop being challenged at sign-in and stop being counted here. Nobody is signed out — the rule simply stops applying."
        confirmLabel="Remove rule"
        destructive
        onConfirm={() => { const n = deleteRule.role_name; setDeleteRule(null); toast({ title: `Rule for ${n} removed`, tone: 'warning' }) }}
      />
    </>
  )
}
