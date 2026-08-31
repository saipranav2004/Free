import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Scissors,
  ShieldAlert,
  RefreshCw,
  ArrowRight,
  Crown,
  KeyRound,
  Vault,
  ScrollText,
  Clock,
  TrendingDown,
  CheckCircle2,
} from 'lucide-react'
import { toast } from 'sonner'
import clsx from 'clsx'
import {
  privPathSummary,
  privPathTargets,
  privPathsTo,
  privPathChokepoints,
  privPathRebuild,
  privPathSimulate,
} from '../../api/privilegePaths'
import { Card, CardHeader, CardTitle, CardFooter } from '../../components/common/Layout'
import { Container, PageTitle, Stack } from '../../components/ui/layout'
import { Badge, MetaTag } from '../../components/common/Badge'
import { StatusDot } from '../../components/ui/bits'
import { Button } from '../../components/common/Button'
import { SegmentedControl } from '../../components/common/SegmentedControl'
import { QueryState } from '../../components/common/QueryState'
import { apiErrorMessage } from '../../lib/apiError'
import { formatDateTime } from '../../lib/format'

// ---------------------------------------------------------------------------
// Admin Center, Privilege Paths
// ---------------------------------------------------------------------------
// The console for an analyzer that has been running since it was written and
// had no client at all. Eight endpoints, a snapshot rebuilt on every boot, and
// nothing in the product that could show an administrator a single result.
//
// WHAT IT ANSWERS, and why each of the three panels earns its place.
//
//   REACH        For each crown jewel, how many accounts can get there and in
//                how few hops. This is the number that should be small and
//                usually is not. "Effective superuser, reachable by 6" is the
//                sentence a security review opens with.
//   PATHS        The actual routes, hop by hop, with the mechanism named on
//                every edge. A path is only useful if you can see WHY it
//                exists, so each hop carries the table or rule that created it
//                rather than an arrow.
//   CHOKEPOINTS  One edge whose removal severs the most paths. This is the
//                remediation list, ranked by how much it buys, which is the
//                difference between a report and a plan.
//
// WHY A COST COLUMN. Edges are weighted by what an attacker has to do to
// traverse them. A standing role assignment costs nothing: it is already true.
// A JIT grant that must be approved costs more, because it needs somebody else
// to act. So "cheapest path" is not the shortest one, it is the one that needs
// the least help, and a zero-cost path to superuser is standing privilege with
// extra steps.
//
// EVERY NUMBER IS FROM A SNAPSHOT, and the page never lets you forget it. All
// reads are served from memory and an entitlement change is invisible until a
// rebuild runs, so the age sits in the toolbar next to the button that fixes
// it, and turns amber when it is old enough to mislead.
//
// SIMULATION IS SAFE AND SAYS SO. The endpoint clones the snapshot and writes
// nothing, so "what if we cut this" is offered inline with no confirmation
// dialog. A confirmation on a read-only action teaches people to click through
// confirmations.

const TARGET_ICON = {
  'capability:superuser': Crown,
  'capability:admin_center_write': KeyRound,
  'capability:vault_plaintext_any': Vault,
  'capability:audit_read_org_wide': ScrollText,
}

// The backend's labels carry their own parenthetical justification, which is
// right for an API and too long for a tab. Shortened here, with the full text
// kept as the title attribute so nothing is lost.
const TARGET_SHORT = {
  'capability:superuser': 'Superuser',
  'capability:admin_center_write': 'Admin Center',
  'capability:vault_plaintext_any': 'Vault plaintext',
  'capability:audit_read_org_wide': 'Org-wide audit',
}

// A snapshot older than this is called out. Fifteen minutes is not a
// correctness boundary, it is the point at which somebody who just changed an
// entitlement and came here to check it would be reading the wrong answer.
const STALE_AFTER_S = 15 * 60

// The backend's own labels, so a chokepoint's `targets` (which is a list of
// LABELS, not ids) can be shortened the same way the tabs are. Matching on the
// leading phrase rather than the whole string because each label carries a
// parenthetical that is useful in an API and noise in a list of four.
const LABEL_SHORT = [
  ['Effective superuser', 'Superuser'],
  ['Admin Center write access', 'Admin Center'],
  ['Decrypt any vaulted credential', 'Vault plaintext'],
  ['Org-wide audit read', 'Org-wide audit'],
]

function targetShort(id, fallback) {
  if (TARGET_SHORT[id]) return TARGET_SHORT[id]
  const label = fallback || id || ''
  const match = LABEL_SHORT.find(([long]) => label.startsWith(long))
  return match ? match[1] : label
}

function SnapshotAge({ ageSeconds, builtAt }) {
  if (ageSeconds == null) return null
  const stale = ageSeconds > STALE_AFTER_S
  const mins = Math.round(ageSeconds / 60)
  const label = ageSeconds < 60 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`
  return (
    <span
      className={clsx('flex items-center gap-1.5 text-xs', stale ? 'text-warn' : 'text-tertiary')}
      title={builtAt ? `Snapshot taken ${formatDateTime(builtAt)}` : undefined}
    >
      <Clock className="h-3.5 w-3.5" strokeWidth={1.9} />
      Snapshot {label}
      {stale && ' · rebuild to see recent changes'}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------

function ReachCard({ target, total, onInspect, active }) {
  const Icon = TARGET_ICON[target.target_id] || ShieldAlert
  const reachable = target.reachable_users ?? 0
  const standing = target.standing_paths ?? 0
  // Standing means the whole route is already true, with nothing left to
  // approve. That is the number that matters, so it gets the colour.
  const tone = standing > 0 ? 'danger' : reachable > 0 ? 'warn' : 'ok'

  return (
    <button
      type="button"
      onClick={() => onInspect(target.target_id)}
      title={target.target_label}
      className={clsx(
        'flex w-full flex-col gap-2 rounded-xl border p-4 text-left transition-colors',
        active
          ? 'border-accent bg-accent-soft/40'
          : 'border-line bg-surface hover:border-line-strong hover:bg-hover'
      )}
    >
      <span className="flex items-center gap-2">
        <span
          className={clsx(
            'flex h-7 w-7 flex-none items-center justify-center rounded-lg',
            tone === 'danger'
              ? 'bg-red-500/10 text-red-600 dark:text-red-400'
              : tone === 'warn'
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          )}
        >
          <Icon className="h-4 w-4" strokeWidth={1.9} />
        </span>
        <span className="min-w-0 truncate text-sm font-semibold text-primary">
          {targetShort(target.target_id, target.target_label)}
        </span>
      </span>

      <span className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular text-primary">{reachable}</span>
        <span className="text-xs text-secondary">
          of {total} {total === 1 ? 'account' : 'accounts'} can reach it
        </span>
      </span>

      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-tertiary">
        {target.shortest_hops != null && <span>{target.shortest_hops} hops at the shortest</span>}
        {standing > 0 && (
          <span className="font-semibold text-danger">
            {standing} standing, nothing to approve
          </span>
        )}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// One path, hop by hop
// ---------------------------------------------------------------------------

const KIND_LABEL = {
  HAS_ROLE: 'holds role',
  ROLE_GRANTS: 'grants',
  HAS_POLICY: 'has policy',
  ALLOWS_ACTION: 'allows',
  ROOT_BYPASS: 'bypasses policy',
  ADMIN_CENTER: 'opens',
  CAN_ATTACH: 'can attach',
  CAN_DELEGATE: 'can delegate',
  STANDING_USE: 'may use',
  CAN_REVEAL: 'can reveal',
  JIT_GRANT: 'holds grant',
}

function Hop({ hop, last }) {
  return (
    <li className="flex items-start gap-2">
      <span className="flex min-w-0 flex-col">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium text-primary">{hop.to_label}</span>
          <Badge className="bg-subtle text-secondary">{KIND_LABEL[hop.kind] || hop.kind}</Badge>
          {hop.cost > 0 && <MetaTag mono>cost {hop.cost}</MetaTag>}
        </span>
        {/* The mechanism, verbatim from the analyzer. A path without it is an
            arrow you have to take on faith. */}
        {hop.via && <span className="mt-0.5 block text-2xs leading-relaxed text-tertiary">{hop.via}</span>}
      </span>
      {!last && <ArrowRight className="mt-1 h-3.5 w-3.5 flex-none text-ink-600" strokeWidth={1.9} />}
    </li>
  )
}

function PathRow({ path, onSimulate, simulating }) {
  const [open, setOpen] = useState(false)
  const firstHop = path.hops?.[0]

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-w-0 flex-1 text-left"
          aria-expanded={open}
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-primary">{path.source_label}</span>
            <ArrowRight className="h-3.5 w-3.5 flex-none text-ink-600" strokeWidth={1.9} />
            <span className="truncate text-sm text-secondary">
              {targetShort(path.target_id, path.target_label)}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-tertiary">
            <span>{path.hops?.length ?? 0} hops</span>
            <span>cost {path.total_cost ?? 0}</span>
            {path.all_standing ? (
              <span className="font-semibold text-danger">standing, no approval needed</span>
            ) : (
              <span>needs an approval on the way</span>
            )}
          </span>
        </button>

        {/* Cutting the FIRST hop is the actionable one: it is the edge that
            attaches this account to the route at all, and the only hop unique
            to this path rather than shared with every other account holding
            the same role. */}
        {firstHop && (
          <Button
            size="xs"
            variant="subtle"
            icon={Scissors}
            loading={simulating}
            onClick={() =>
              onSimulate({ from: firstHop.from_id, to: firstHop.to_id, kind: firstHop.kind })
            }
            title={`Model removing "${firstHop.from_label} ${KIND_LABEL[firstHop.kind] || firstHop.kind} ${firstHop.to_label}". Nothing is changed.`}
          >
            What if we cut this
          </Button>
        )}
      </div>

      {open && (
        <ol className="mt-3 flex flex-col gap-2 border-l border-line-soft pl-3">
          {(path.hops || []).map((hop, i) => (
            <Hop key={`${hop.from_id}-${hop.to_id}-${i}`} hop={hop} last={i === path.hops.length - 1} />
          ))}
        </ol>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Simulation result
// ---------------------------------------------------------------------------

function SimulationResult({ result, onClear }) {
  if (!result) return null
  const remediated = result.users_remediated ?? 0
  const before = result.before?.users_with_any_path ?? 0
  const after = result.after?.users_with_any_path ?? 0

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle icon={TrendingDown}>If you cut that edge</CardTitle>
        <span className="ml-auto">
          <Button size="xs" variant="ghost" onClick={onClear}>
            Dismiss
          </Button>
        </span>
      </CardHeader>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-4">
        <span className="flex items-baseline gap-2">
          <span
            className={clsx(
              'text-3xl font-bold tabular',
              remediated > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-primary'
            )}
          >
            {remediated}
          </span>
          <span className="text-sm text-secondary">
            {remediated === 1 ? 'account loses' : 'accounts lose'} every route they had
          </span>
        </span>
        <span className="text-sm text-tertiary">
          Accounts with a path: <span className="tabular text-primary">{before}</span> before,{' '}
          <span className="tabular text-primary">{after}</span> after
        </span>
      </div>
      <CardFooter>
        <p className="flex items-center gap-2 text-2xs leading-relaxed text-ink-500">
          <CheckCircle2 className="h-3.5 w-3.5 flex-none text-emerald-600 dark:text-emerald-400" strokeWidth={1.9} />
          Modelled against a copy of the snapshot. Nothing was changed, and no entitlement was touched.
        </p>
      </CardFooter>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PrivilegePathsPage() {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState('capability:superuser')
  const [simulation, setSimulation] = useState(null)

  const summaryQuery = useQuery({
    queryKey: ['privpaths', 'summary'],
    queryFn: ({ signal }) => privPathSummary(signal),
    retry: false,
  })

  const targetsQuery = useQuery({
    queryKey: ['privpaths', 'targets'],
    queryFn: ({ signal }) => privPathTargets(signal),
    staleTime: 300_000,
    retry: false,
  })

  const pathsQuery = useQuery({
    queryKey: ['privpaths', 'to', target],
    queryFn: ({ signal }) => privPathsTo({ target, limit: 50 }, signal),
    placeholderData: (prev) => prev,
    retry: false,
  })

  const chokepointsQuery = useQuery({
    queryKey: ['privpaths', 'chokepoints'],
    queryFn: ({ signal }) => privPathChokepoints({ limit: 10 }, signal),
    retry: false,
  })

  const rebuild = useMutation({
    mutationFn: privPathRebuild,
    onSuccess: ({ performed, coalesced }) => {
      // The backend distinguishes "rebuilt" from "folded into a rebuild
      // already running", and so does this: a green "done" over pre-change
      // data is the exact failure the endpoint reports in order to prevent.
      if (coalesced || !performed) {
        toast.info('A rebuild was already running', {
          description: 'The figures below are still the previous snapshot. Refresh again in a moment.',
        })
      } else {
        toast.success('Snapshot rebuilt')
      }
      queryClient.invalidateQueries({ queryKey: ['privpaths'] })
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const simulate = useMutation({
    mutationFn: privPathSimulate,
    onSuccess: (data) => setSimulation(data),
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const summary = summaryQuery.data?.summary
  const totalUsers = summary?.total_users ?? 0
  // Memoised so it is a stable dependency for targetOptions below: a fresh []
  // on every render would rebuild the segmented control's options each time.
  const targets = useMemo(() => summary?.targets || [], [summary])
  const age = summaryQuery.data?.age_seconds
  const builtAt = summaryQuery.data?.built_at

  const targetOptions = useMemo(() => {
    const fromSummary = targets.map((t) => ({ key: t.target_id, label: targetShort(t.target_id, t.target_label) }))
    if (fromSummary.length > 0) return fromSummary
    return (targetsQuery.data || []).map((t) => ({ key: t.id, label: targetShort(t.id, t.label) }))
  }, [targets, targetsQuery.data])

  const chokepoints = chokepointsQuery.data?.chokepoints || []
  const paths = pathsQuery.data?.paths || []

  return (
    <Stack gap="lg">
      <PageTitle
        title="Privilege Paths"
        description="Every route an account can take to something that matters, ranked by how little has to happen for it to work."
        actions={
          <span className="flex items-center gap-3">
            <SnapshotAge ageSeconds={age} builtAt={builtAt} />
            <Button
              variant="secondary"
              icon={RefreshCw}
              loading={rebuild.isPending}
              onClick={() => rebuild.mutate()}
            >
              Rebuild snapshot
            </Button>
          </span>
        }
      />

      {/* ---- REACH ------------------------------------------------------- */}
      <Stack gap="sm">
        <h2 className="text-xl font-bold leading-tight text-primary">Reach</h2>
        <QueryState
          query={summaryQuery}
          empty={(d) => !d?.summary?.targets?.length}
          emptyTitle="No snapshot yet"
          emptyMessage="The analyzer has not built a snapshot. Rebuild to run it now."
          skeletonRows={2}
        >
          {() => (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {targets.map((t) => (
                <ReachCard
                  key={t.target_id}
                  target={t}
                  total={totalUsers}
                  active={t.target_id === target}
                  onInspect={setTarget}
                />
              ))}
            </div>
          )}
        </QueryState>
      </Stack>

      <SimulationResult result={simulation} onClear={() => setSimulation(null)} />

      {/* ---- PATHS ------------------------------------------------------- */}
      <Stack gap="sm">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="flex-none text-xl font-bold leading-tight text-primary">Paths</h2>
          <span className="h-px flex-1 bg-line-soft" aria-hidden="true" />
          {targetOptions.length > 1 && (
            <SegmentedControl
              size="sm"
              ariaLabel="Analysis target"
              value={target}
              onChange={setTarget}
              options={targetOptions}
            />
          )}
        </div>

        <Container padded={false}>
          <QueryState
            query={pathsQuery}
            empty={(d) => !d?.paths?.length}
            emptyTitle="Nothing reaches this target"
            emptyMessage="No account currently has a route to it. That is the state you want."
            skeletonRows={4}
          >
            {() => (
              <ul className="divide-y divide-line-soft">
                {paths.map((p, i) => (
                  <PathRow
                    key={`${p.source_id}-${p.target_id}-${i}`}
                    path={p}
                    simulating={simulate.isPending}
                    onSimulate={(edge) => simulate.mutate(edge)}
                  />
                ))}
              </ul>
            )}
          </QueryState>
        </Container>
      </Stack>

      {/* ---- CHOKEPOINTS ------------------------------------------------- */}
      <Stack gap="sm">
        <h2 className="text-xl font-bold leading-tight text-primary">Chokepoints</h2>
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle icon={Scissors}>Cut one edge, sever the most paths</CardTitle>
            {chokepoints.length > 0 && (
              <span className="ml-auto">
                <MetaTag>{chokepoints.length} ranked</MetaTag>
              </span>
            )}
          </CardHeader>
          <QueryState
            query={chokepointsQuery}
            empty={(d) => !d?.chokepoints?.length}
            emptyTitle="No chokepoints"
            emptyMessage="Either nothing reaches a target, or no single edge carries more than one route."
            skeletonRows={3}
          >
            {() => (
              <ul className="divide-y divide-line-soft">
                {chokepoints.map((cp, i) => (
                  <li key={`${cp.edge?.from}-${cp.edge?.to}-${i}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-primary">{cp.from_label}</span>
                        <Badge className="bg-subtle text-secondary">
                          {KIND_LABEL[cp.edge?.kind] || cp.edge?.kind}
                        </Badge>
                        <span className="truncate text-sm text-secondary">{cp.to_label}</span>
                        {cp.edge?.standing && <StatusDot tone="danger" label="standing" />}
                      </span>
                      <span className="mt-0.5 block text-2xs text-tertiary">
                        Reaches {(cp.targets || []).map((t) => targetShort('', t)).join(', ')}
                      </span>
                    </span>

                    <span className="flex flex-none items-baseline gap-1.5">
                      <span className="text-lg font-bold tabular text-primary">{cp.paths_severed}</span>
                      <span className="text-2xs text-tertiary">
                        paths · {cp.users_cut_off} {cp.users_cut_off === 1 ? 'account' : 'accounts'}
                      </span>
                    </span>

                    <Button
                      size="xs"
                      variant="subtle"
                      icon={Scissors}
                      loading={simulate.isPending}
                      onClick={() =>
                        simulate.mutate({ from: cp.edge?.from, to: cp.edge?.to, kind: cp.edge?.kind })
                      }
                    >
                      What if we cut this
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
          <CardFooter>
            <p className="text-2xs leading-relaxed text-ink-500">
              Ranked by paths severed, then by accounts cut off. Nothing here changes an entitlement:
              use Identity and Roles to act on what you decide.
            </p>
          </CardFooter>
        </Card>
      </Stack>
    </Stack>
  )
}
