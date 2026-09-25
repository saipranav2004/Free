import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  Users,
  Lock,
  AlertTriangle,
  Info,
  CheckCircle2,
  RefreshCw,
  Trash2,
  Sparkles,
  ArrowRight,
  CalendarClock,
  Timer,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import clsx from 'clsx'
import { getMfaPolicy, getMfaCompliance, upsertMfaRule, deleteMfaRule } from '../../api/mfaPolicy'
import { listRoles } from '../../api/rbac'
import { useAuthStore } from '../../store/authStore'
import { Card } from '../../components/common/Layout'
import { Container, PageTitle, Stack } from '../../components/ui/layout'
import { QueryState } from '../../components/common/QueryState'
import { Badge, StatusIndicator, MetaTag } from '../../components/common/Badge'
import { StatusDot } from '../../components/ui/bits'
import { Button } from '../../components/common/Button'
import { Modal } from '../../components/common/Modal'
import { SearchField } from '../../components/common/TableControls'
import { SegmentedControl } from '../../components/common/SegmentedControl'
import { Pagination } from '../../components/common/Pagination'
import { inputClass } from '../../components/common/FormFields'
import { useTableState } from '../../hooks/useTableState'
import { apiErrorMessage } from '../../lib/apiError'
import { roleBadgeClass, isSystemRoleName, normalizeRoleList } from '../../config/constants'
import {
  MFA_MODE_BLURBS,
  PHASE_IN,
  PHASE_IN_LABELS,
  PHASE_IN_BLURBS,
  mfaModeLabel,
  mfaModeBadgeClass,
  phaseInOf,
  describePhaseIn,
  toLocalInputValue,
  fromLocalInputValue,
} from '../../lib/mfaPolicy'

// ---------------------------------------------------------------------------
// Admin Center, MFA Policy
// ---------------------------------------------------------------------------
// "Accounts holding this role must have a second factor." The same control
// Entra expresses as Conditional Access scoped to a group and Okta as an
// enrollment policy bound to one, against ROLES here, because PAM already has
// roles and a second grouping concept would be two things to keep in sync.
//
// THE SHAPE OF THE SCREEN follows the order the work actually happens in:
//
//   1. Coverage, one glance: how much of the estate is protected, and how
// many people a live rule would stop at their next sign-in. If nothing
// is gated yet the same strip becomes the "start here" call to action.
//   2. Rules, one row per role, each stating mode and roll-out in three
// words, with the member/compliance split beside it. Editing opens a
// focused dialog rather than expanding the row: choosing an enforcement
// mode deserves the reader's whole attention, and an inline form pushes
// every other row off the screen while they think.
//   3. Who is affected, the compliance table, searchable, filterable and
// paged, because "who would this lock out" is the question that gets
// asked before every switch to enforce.
//
// Nothing here evaluates policy. Every number comes from the server's own
// compliance pass; see lib/mfaPolicy.js for why a client-side re-derivation
// would be theatre.

const MODE_ICON = { off: ShieldOff, monitor: ShieldAlert, enforce: ShieldCheck }
const PHASE_ICON = { immediate: Zap, grace: Timer, date: CalendarClock }

// --- KPI ---------------------------------------------------------------------

function Kpi({ icon: Icon, label, value, sub, tone = 'default', progress }) {
  const toneRing = {
    default: 'border-surface-700/70',
    good: 'border-emerald-500/30',
    warn: 'border-amber-500/40',
    danger: 'border-red-500/40',
  }[tone]
  const toneText = {
    default: 'text-ink-500',
    good: 'text-emerald-600 dark:text-emerald-400',
    warn: 'text-amber-600 dark:text-amber-400',
    danger: 'text-red-600 dark:text-red-400',
  }[tone]
  const toneBar = {
    default: 'bg-ink-500/40',
    good: 'bg-emerald-500',
    warn: 'bg-amber-500',
    danger: 'bg-red-500',
  }[tone]

  return (
    <div className={clsx('relative overflow-hidden rounded-xl border bg-surface-900 px-4 py-3.5', toneRing)}>
      <div className="flex items-center gap-2">
        <Icon className={clsx('h-3.5 w-3.5 flex-none', toneText)} strokeWidth={1.9} />
        <span className="text-xs font-semibold text-ink-500">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold leading-none tabular-nums text-ink-50">{value}</p>
      {typeof progress === 'number' && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-surface-800">
          <div
            className={clsx('h-full rounded-full transition-[width] duration-500', toneBar)}
            style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
          />
        </div>
      )}
      {sub && <p className="mt-2 truncate text-xs text-ink-500">{sub}</p>}
    </div>
  )
}

// --- Rule editor -------------------------------------------------------------

// Mode and roll-out are the only two decisions, so each gets a row of cards
// rather than a dropdown: an administrator should be able to read every option
// and its consequence without opening anything.
function ChoiceCard({ icon: Icon, title, blurb, selected, onSelect, tone = 'default' }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={clsx(
        'flex-1 rounded-xl border px-3 py-2.5 text-left transition-all duration-150',
        selected
          ? tone === 'danger'
            ? 'border-red-500/50 bg-red-50 shadow-sm dark:bg-red-950/25'
            : tone === 'warn'
              ? 'border-amber-500/50 bg-amber-50 shadow-sm dark:bg-amber-950/25'
              : 'border-blue-500/50 bg-blue-50 shadow-sm dark:bg-blue-500/10'
          : 'border-surface-700 bg-surface-900 hover:border-surface-600 hover:bg-surface-850'
      )}
    >
      <span className="flex items-center gap-2">
        <Icon
          className={clsx('h-3.5 w-3.5 flex-none', selected ? 'text-ink-100' : 'text-ink-500')}
          strokeWidth={1.9}
        />
        <span className={clsx('text-sm font-semibold', selected ? 'text-ink-50' : 'text-ink-200')}>
          {title}
        </span>
      </span>
      <span className="mt-1 block text-2xs leading-relaxed text-ink-500">{blurb}</span>
    </button>
  )
}

function RuleEditor({ open, onClose, role, rule, stats, onSave, onRemove, saving, removing }) {
  const [mode, setMode] = useState('monitor')
  const [phase, setPhase] = useState(PHASE_IN.IMMEDIATE)
  const [graceHours, setGraceHours] = useState('48')
  const [enforceFrom, setEnforceFrom] = useState('')
  const [reason, setReason] = useState('')

  // Every open starts from what the server currently holds, so a cancelled or
  // failed edit never leaves the form showing something that was never stored.
  useEffect(() => {
    if (!open) return
    const current = rule?.mode || 'monitor'
    setMode(current === 'off' ? 'monitor' : current)
    const p = phaseInOf(rule)
    setPhase(p)
    setGraceHours(String(rule?.grace_hours > 0 ? rule.grace_hours : 48))
    setEnforceFrom(toLocalInputValue(rule?.enforce_from))
    setReason(rule?.reason || '')
  }, [open, rule])

  if (!role) return null

  const hours = Math.max(0, Number(graceHours) || 0)
  const dateInvalid = phase === PHASE_IN.DATE && !enforceFrom
  const graceInvalid = phase === PHASE_IN.GRACE && hours <= 0
  const atRisk = stats?.nonCompliant || 0

  const submit = () => {
    onSave({
      roleName: role.name,
      mode,
      grace_hours: phase === PHASE_IN.GRACE ? hours : 0,
      enforce_from: phase === PHASE_IN.DATE ? fromLocalInputValue(enforceFrom) : null,
      reason: reason.trim(),
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={ShieldCheck}
      title={`MFA policy for “${role.name}”`}
      description="Everyone holding this role is covered by this rule, checked by the server on every sign-in."
      size="xl"
      busy={saving || removing}
      footer={
        <>
          {rule && (
            <Button
              variant="dangerGhost"
              icon={Trash2}
              loading={removing}
              className="mr-auto"
              onClick={() => onRemove(role.name)}
            >
              Remove rule
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={saving || removing}>
            Cancel
          </Button>
          <Button
            variant="primary"
            // icon={ShieldCheck}
            loading={saving}
            disabled={dateInvalid || graceInvalid}
            onClick={submit}
          >
            Save rule
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <section>
          <h4 className="mb-2 text-xs font-semibold text-ink-500">What happens at sign-in</h4>
          <div className="flex flex-col gap-2 sm:flex-row">
            <ChoiceCard
              icon={ShieldAlert}
              title="Monitor"
              blurb="Allow and record. Members see a reminder."
              tone="warn"
              selected={mode === 'monitor'}
              onSelect={() => setMode('monitor')}
            />
            <ChoiceCard
              icon={ShieldCheck}
              title="Enforce"
              blurb="No second factor, no access - enrolment only."
              selected={mode === 'enforce'}
              onSelect={() => setMode('enforce')}
            />
            <ChoiceCard
              icon={ShieldOff}
              title="Off"
              blurb="Keep the rule on record; change nothing."
              selected={mode === 'off'}
              onSelect={() => setMode('off')}
            />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">{MFA_MODE_BLURBS[mode]}</p>
        </section>

        {mode === 'enforce' && (
          <section>
            <h4 className="mb-2 text-xs font-semibold text-ink-500">When it starts</h4>
            <div className="flex flex-col gap-2 sm:flex-row">
              {[PHASE_IN.IMMEDIATE, PHASE_IN.GRACE, PHASE_IN.DATE].map((p) => (
                <ChoiceCard
                  key={p}
                  icon={PHASE_ICON[p]}
                  title={PHASE_IN_LABELS[p]}
                  blurb={PHASE_IN_BLURBS[p]}
                  selected={phase === p}
                  onSelect={() => setPhase(p)}
                />
              ))}
            </div>

            {phase === PHASE_IN.GRACE && (
              <label className="mt-3 flex flex-wrap items-center gap-2.5">
                <span className="text-xs font-medium text-ink-300">Each account gets</span>
                <input
                  type="number"
                  min={1}
                  max={8760}
                  value={graceHours}
                  onChange={(e) => setGraceHours(e.target.value)}
                  className={clsx(inputClass(graceInvalid), 'h-8 !w-24 py-0 text-sm')}
                />
                <span className="text-xs text-ink-400">
                  hours{hours >= 24 ? ` (${Math.round((hours / 24) * 10) / 10} days)` : ''} from when they
                  first fall under this rule
                </span>
              </label>
            )}

            {phase === PHASE_IN.DATE && (
              <label className="mt-3 flex flex-wrap items-center gap-2.5">
                <span className="text-xs font-medium text-ink-300">Enforce from</span>
                <input
                  type="datetime-local"
                  value={enforceFrom}
                  onChange={(e) => setEnforceFrom(e.target.value)}
                  className={clsx(inputClass(dateInvalid), 'h-8 !w-auto py-0 text-sm')}
                />
                <span className="text-xs text-ink-400">, the same instant for every member</span>
              </label>
            )}
          </section>
        )}

        <section>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-ink-500">
              Reason <span className="font-normal normal-case tracking-normal text-ink-600">(optional)</span>
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this role is gated"
              className={inputClass(false)}
            />
          </label>
        </section>

        {/* The impact line. Shown for the mode being CHOSEN, not the one
 stored, so the consequence is visible before Save is pressed. */}
        {mode === 'enforce' && atRisk > 0 && (
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-300/70 bg-amber-50 px-3.5 py-3 dark:border-amber-900/40 dark:bg-amber-950/25">
            <AlertTriangle
              className="mt-px h-3.5 w-3.5 flex-none text-amber-600 dark:text-amber-400"
              strokeWidth={1.9}
            />
            <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
              <span className="font-semibold">
                {atRisk} of {stats.members} member{stats.members === 1 ? '' : 's'}
              </span>{' '}
              {atRisk === 1 ? 'has' : 'have'} no second factor.{' '}
              {phase === PHASE_IN.IMMEDIATE
                ? 'They will be restricted to enrolment at their next sign-in.'
                : 'They will be restricted once the window closes.'}
            </p>
          </div>
        )}
      </div>
    </Modal>
  )
}

// --- Rule row ----------------------------------------------------------------

function RuleRow({ role, rule, stats, canEdit, onEdit }) {
  const mode = rule?.mode || 'off'
  const gated = mode !== 'off'
  const ModeIcon = MODE_ICON[mode] || ShieldOff
  const members = stats?.members || 0
  const enrolled = stats?.enrolled || 0
  const pct = members === 0 ? 0 : Math.round((enrolled / members) * 100)
  const atRisk = gated ? stats?.nonCompliant || 0 : 0

  return (
    <li className="group flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3 transition-colors hover:bg-surface-850/50">
      <span
        className={clsx(
          'flex h-5 w-5 flex-none items-center justify-center',
          gated ? 'text-accent' : 'text-tertiary'
        )}
      >
        <ModeIcon className="h-4 w-4" strokeWidth={1.8} />
      </span>

      {/* THREE COLOURED CHIPS PER ROW WAS THE PROBLEM: a purple role pill, a
          grey System pill and a green or amber mode pill, on every row, is a
          column of colour that says nothing because every row has it. The
          role is a name, built in versus custom is a word, and the mode is
          the one thing here that carries state, so it is the only one that
          keeps colour, as a dot. */}
      <div className="flex min-w-[9rem] flex-1 items-baseline gap-2">
        <span className="truncate text-sm font-medium text-primary">{role.name}</span>
        <span className="flex-none text-xs text-tertiary">
          {isSystemRoleName(role.name) ? 'built in' : 'custom'}
        </span>
      </div>

      <div className="flex w-28 flex-none items-center">
        <StatusDot
          tone={
            mode === 'enforce' ? 'ok' : mode === 'grace' ? 'warn' : mode === 'monitor' ? 'accent' : 'muted'
          }
          label={mfaModeLabel(mode)}
        />
      </div>

      <div className="w-36 flex-none truncate text-xs text-ink-400" title={describePhaseIn(rule)}>
        {gated ? describePhaseIn(rule) : '-'}
      </div>

      {/* Members and how many of them are covered, the number an operator is
 really deciding against. */}
      <div className="w-44 flex-none">
        {members === 0 ? (
          <span className="text-xs text-ink-500">No members</span>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs tabular-nums text-ink-300">
                {enrolled}/{members} protected
              </span>
              {atRisk > 0 && (
                <span
                  className={clsx(
                    'text-2xs font-semibold tabular-nums',
                    mode === 'enforce'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-amber-600 dark:text-amber-400'
                  )}
                >
                  {atRisk} at risk
                </span>
              )}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-800">
              <div
                className={clsx(
                  'h-full rounded-full transition-[width] duration-500',
                  pct === 100
                    ? 'bg-emerald-500'
                    : atRisk > 0 && mode === 'enforce'
                      ? 'bg-red-500'
                      : 'bg-amber-500'
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </>
        )}
      </div>

      <div className="ml-auto flex-none">
        {canEdit ? (
          <Button
            size="xs"
            variant={gated ? 'secondary' : 'ghost'}
            onClick={onEdit}
            iconRight={gated ? undefined : ArrowRight}
          >
            {gated ? 'Edit' : 'Require MFA'}
          </Button>
        ) : (
          <span
            title="Only admin or root users can change MFA policy"
            className="inline-flex items-center gap-1 rounded-md border border-surface-700 bg-surface-850 px-1.5 py-1 text-2xs font-medium text-ink-500"
          >
            <Lock className="h-3 w-3" strokeWidth={1.9} /> Read-only
          </span>
        )}
      </div>
    </li>
  )
}

// --- Page --------------------------------------------------------------------

const COMPLIANCE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'breach', label: 'Not compliant' },
  { key: 'gated', label: 'Gated' },
  { key: 'ungated', label: 'Not gated' },
]

export default function MfaPolicyPage() {
  const queryClient = useQueryClient()
  // WHO MAY CHANGE POLICY. Admin OR root, `isAdmin()` is true for both (see
  // store/authStore.js). This used to be root-only and is now the same rule
  // the server enforces in services/mfa_policy.go#canManageMFAPolicy; the two
  // must agree, or the console offers a button that always 403s.
  const canEditPolicy = useAuthStore((s) => s.isAdmin())
  const [editing, setEditing] = useState(null)

  const policyQuery = useQuery({
    queryKey: ['admin', 'mfa-policy'],
    queryFn: ({ signal }) => getMfaPolicy(signal),
  })
  const complianceQuery = useQuery({
    queryKey: ['admin', 'mfa-policy', 'compliance'],
    queryFn: ({ signal }) => getMfaCompliance(signal),
  })
  const rolesQuery = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: ({ signal }) => listRoles(signal),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'mfa-policy'] })

  const saveMutation = useMutation({
    mutationFn: ({ roleName, ...payload }) => upsertMfaRule(roleName, payload),
    onSuccess: (_d, vars) => {
      toast.success(`MFA policy updated for “${vars.roleName}”`)
      invalidate()
      setEditing(null)
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const removeMutation = useMutation({
    mutationFn: (roleName) => deleteMfaRule(roleName),
    onSuccess: (_d, roleName) => {
      toast.success(`MFA policy removed for “${roleName}”`)
      invalidate()
      setEditing(null)
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const rules = useMemo(() => policyQuery.data?.rules || [], [policyQuery.data])
  const rulesByRole = useMemo(() => {
    const map = new Map()
    for (const r of rules) map.set(String(r.role_name).toLowerCase(), r)
    return map
  }, [rules])

  const rows = useMemo(() => complianceQuery.data?.rows || [], [complianceQuery.data])

  // Per-role membership, derived from the compliance rows so the numbers next
  // to a rule and the numbers in the table are the SAME numbers, computed
  // twice is computed differently, eventually.
  const statsByRole = useMemo(() => {
    const map = new Map()
    for (const row of rows) {
      for (const role of row.roles || []) {
        const key = String(role).toLowerCase()
        const s = map.get(key) || { members: 0, enrolled: 0, nonCompliant: 0 }
        s.members += 1
        if (row.mfa_enabled) s.enrolled += 1
        else if (row.required) s.nonCompliant += 1
        map.set(key, s)
      }
    }
    return map
  }, [rows])

  // Gated roles first, the ones with a live rule are what an operator came to
  // look at; everything else is inventory.
  const roleList = useMemo(() => {
    const catalogue = normalizeRoleList(rolesQuery.data)
    return [...catalogue].sort((a, b) => {
      const am = rulesByRole.get(String(a.name).toLowerCase())?.mode || 'off'
      const bm = rulesByRole.get(String(b.name).toLowerCase())?.mode || 'off'
      const rank = (m) => (m === 'enforce' ? 0 : m === 'monitor' ? 1 : 2)
      return rank(am) - rank(bm)
    })
  }, [rolesQuery.data, rulesByRole])

  const summary = complianceQuery.data
  const total = summary?.totalUsers ?? 0
  const enrolled = summary?.enrolled ?? 0
  const gated = summary?.gated ?? 0
  const nonCompliant = summary?.nonCompliant ?? 0
  const wouldBlock = summary?.wouldBlock ?? 0
  const coverage = total === 0 ? 0 : Math.round((enrolled / total) * 100)
  const nothingGated = !complianceQuery.isLoading && gated === 0

  // Search / filter / paging for the compliance table.
  const table = useTableState({
    rows,
    storageKey: 'mfa-compliance',
    rowId: (r) => r.user_id,
    initialSort: { key: 'username', dir: 'asc' },
    initialPageSize: 10,
    initialFilters: { view: 'all' },
    searchFields: ['username', 'email', (r) => (r.roles || []).join(' ')],
    filterFn: (r, f) => {
      if (f.view === 'breach') return r.required && !r.compliant
      if (f.view === 'gated') return !!r.required
      if (f.view === 'ungated') return !r.required
      return true
    },
    sortAccessor: (r, key) => (key === 'roles' ? (r.roles || []).join(', ') : r[key]),
  })

  const editingStats = editing ? statsByRole.get(String(editing.name).toLowerCase()) : null

  return (
    <Stack gap="lg">
      <PageTitle
        title="MFA policy"
        description="Require a second factor from everyone holding a given role. Checked by the server on every sign-in."
        actions={
          <>
            {!canEditPolicy && (
              <span className="inline-flex items-center gap-1.5 text-sm text-tertiary">
                <Lock className="h-3.5 w-3.5" strokeWidth={1.9} /> Read only, only root can change policy
              </span>
            )}
            <Button
              variant="subtle"
              icon={RefreshCw}
              loading={policyQuery.isFetching || complianceQuery.isFetching}
              onClick={invalidate}
            >
              Refresh
            </Button>
          </>
        }
      />

      {/* ONE HERO NUMBER, NOT FOUR CARDS.
          This page had a four card KPI wall: protected, covered, not
          compliant, blocked. Four equal weight plates say all four matter
          equally, and they do not: coverage is the number this page exists to
          move, and the other three are its breakdown. So coverage gets the
          display size and a meter, and the rest are facts on the same rule.
          None of them is a trend, because GET /admin/mfa-policy/compliance
          returns point in time state with no history. */}
      <div className="border-y border-line-soft py-4">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
          <div className="min-w-[13rem]">
            <p className="text-sm text-secondary">Accounts with a second factor</p>
            <p className="mt-1 flex items-baseline gap-2">
              <span
                className={clsx(
                  'text-[2rem] font-bold leading-none tabular',
                  coverage === 100 ? 'text-ok' : coverage >= 50 ? 'text-warn' : 'text-danger'
                )}
              >
                {coverage}%
              </span>
              <span className="text-sm text-tertiary tabular">
                {enrolled} of {total}
              </span>
            </p>
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-subtle"
              role="img"
              aria-label={`${coverage} percent of accounts have a second factor`}
            >
              <div
                className={clsx(
                  'h-full rounded-full',
                  coverage === 100 ? 'bg-ok' : coverage >= 50 ? 'bg-warn' : 'bg-danger'
                )}
                style={{ width: `${coverage}%` }}
              />
            </div>
          </div>

          <span className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular text-primary">{gated}</span>
            <span className="text-sm text-secondary">
              {gated === 0 ? 'no role is gated yet' : 'covered by a rule'}
            </span>
          </span>

          <span className="flex items-baseline gap-2">
            <span
              className={clsx('text-2xl font-bold tabular', nonCompliant > 0 ? 'text-warn' : 'text-primary')}
            >
              {nonCompliant}
            </span>
            <span className="text-sm text-secondary">gated with no second factor</span>
          </span>

          <span className="flex items-baseline gap-2">
            <span
              className={clsx('text-2xl font-bold tabular', wouldBlock > 0 ? 'text-danger' : 'text-primary')}
            >
              {wouldBlock}
            </span>
            <span className="text-sm text-secondary">
              {wouldBlock === 0 ? 'nobody is locked out' : 'blocked at next sign-in'}
            </span>
          </span>
        </div>
      </div>

      {/* Empty state that teaches, shown only when there is genuinely nothing
 to look at. Two sentences and the one action worth taking. */}
      {nothingGated && canEditPolicy && (
        <Card className="mb-5 border-blue-500/30 bg-blue-50/60 dark:bg-blue-500/[0.06]">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl border border-blue-500/30 bg-surface-900 text-blue-600 dark:text-blue-300">
              <Sparkles className="h-4 w-4" strokeWidth={1.8} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink-50">No role requires MFA yet</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-400">
                Start with <span className="font-semibold">admin</span> in Monitor - nobody is blocked, and
                the table below fills in with exactly who would be.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* ── 2. Rules ── */}
      <Card className="mb-5 overflow-hidden">
        <div className="flex items-center gap-3 border-b border-surface-800 bg-surface-850/50 px-4 py-2.5">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-900 text-ink-400">
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.8} />
          </span>
          <h3 className="text-sm font-semibold text-ink-50">Rules</h3>
          <span className="rounded-md bg-surface-800 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-ink-400">
            {rules.filter((r) => r.mode !== 'off').length} active
          </span>
          <Link
            to="/admin/roles"
            className="ml-auto text-xs font-semibold text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400"
          >
            Manage roles
          </Link>
        </div>

        <QueryState query={policyQuery} skeletonRows={4}>
          {() =>
            roleList.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-400">
                No roles exist yet - MFA policy gates roles, so there is nothing to gate.
              </p>
            ) : (
              <ul className="divide-y divide-surface-800">
                {roleList.map((role) => (
                  <RuleRow
                    key={role.name}
                    role={role}
                    rule={rulesByRole.get(String(role.name).toLowerCase())}
                    stats={statsByRole.get(String(role.name).toLowerCase())}
                    canEdit={canEditPolicy}
                    onEdit={() => setEditing(role)}
                  />
                ))}
              </ul>
            )
          }
        </QueryState>

        <p className="flex items-center gap-2 border-t border-surface-800 bg-surface-850/40 px-4 py-2 text-2xs text-ink-500">
          <Info className="h-3 w-3 flex-none" strokeWidth={1.9} />
          Someone in two gated roles is held to the stricter of the two.
        </p>
      </Card>

      {/* ── 3. Who is affected ── */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-surface-800 px-3 py-2.5">
          <SearchField
            value={table.query}
            onChange={table.setQuery}
            placeholder="Search account or role…"
            className="min-w-[13rem] sm:max-w-xs"
          />
          <SegmentedControl
            size="sm"
            ariaLabel="Filter accounts"
            value={table.filters.view}
            onChange={(v) => table.setFilter('view', v)}
            options={COMPLIANCE_FILTERS.map((f) => ({
              ...f,
              count:
                f.key === 'all'
                  ? rows.length
                  : f.key === 'breach'
                    ? rows.filter((r) => r.required && !r.compliant).length
                    : f.key === 'gated'
                      ? rows.filter((r) => r.required).length
                      : rows.filter((r) => !r.required).length,
            }))}
          />
        </div>

        <QueryState query={complianceQuery} skeletonRows={6}>
          {() =>
            table.pageRows.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <CheckCircle2
                  className="mx-auto h-5 w-5 text-emerald-600 dark:text-emerald-400"
                  strokeWidth={1.8}
                />
                <p className="mt-2 text-sm font-semibold text-ink-100">
                  {table.filters.view === 'breach' ? 'Everyone is compliant' : 'No accounts match'}
                </p>
                <p className="mt-1 text-xs text-ink-500">
                  {table.filters.view === 'breach'
                    ? 'Every account covered by a rule has a second factor.'
                    : 'Try a different search or filter.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-800 bg-surface-850/50 text-left">
                      {['Account', 'Roles', 'Second factor', 'Policy'].map((h) => (
                        <th key={h} className="px-4 py-2 text-xs font-semibold text-ink-500">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-800">
                    {table.pageRows.map((row) => (
                      <tr key={row.user_id} className="transition-colors hover:bg-surface-850/40">
                        <td className="px-4 py-2.5">
                          <Link
                            to={`/admin/identity/${row.user_id}`}
                            className="font-medium text-ink-100 transition-colors hover:text-blue-500"
                          >
                            {row.username}
                          </Link>
                          <p className="truncate text-2xs text-ink-500">{row.email}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="flex flex-wrap gap-1">
                            {(row.roles || []).length === 0 ? (
                              <span className="text-xs text-ink-500">None</span>
                            ) : (
                              (row.roles || []).map((r) => (
                                <span
                                  key={r}
                                  className="rounded bg-subtle px-1.5 py-0.5 text-xs text-secondary"
                                >
                                  {r}
                                </span>
                              ))
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusIndicator tone={row.mfa_enabled ? 'emerald' : 'neutral'}>
                            {row.mfa_enabled ? 'Enrolled' : 'Not set up'}
                          </StatusIndicator>
                        </td>
                        <td className="px-4 py-2.5">
                          {!row.required ? (
                            <span className="text-xs text-ink-500">Not gated</span>
                          ) : row.compliant ? (
                            <StatusIndicator tone="emerald">Compliant</StatusIndicator>
                          ) : (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <StatusIndicator tone={row.mode === 'enforce' ? 'red' : 'amber'}>
                                {row.mode === 'enforce' ? 'Will be blocked' : 'In breach'}
                              </StatusIndicator>
                              {(row.gated_by || []).length > 0 && (
                                <span className="text-2xs text-ink-500">via {row.gated_by.join(', ')}</span>
                              )}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </QueryState>

        <Pagination
          page={table.page}
          pageSize={table.pageSize}
          total={table.total}
          totalPages={table.totalPages}
          onPageChange={table.setPage}
          onPageSizeChange={table.setPageSize}
          label="accounts"
        />
      </Card>

      {canEditPolicy && (
        <RuleEditor
          open={!!editing}
          onClose={() => setEditing(null)}
          role={editing}
          rule={editing ? rulesByRole.get(String(editing.name).toLowerCase()) : null}
          stats={editingStats}
          saving={saveMutation.isPending}
          removing={removeMutation.isPending}
          onSave={(payload) => saveMutation.mutate(payload)}
          onRemove={(roleName) => removeMutation.mutate(roleName)}
        />
      )}
    </Stack>
  )
}
