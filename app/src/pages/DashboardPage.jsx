import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Boxes,
  KeyRound,
  ShieldAlert,
  ArrowRight,
  Users,
  ClipboardList,
  Lock,
  Activity,
  ChevronRight,
  ShieldCheck,
  Clock,
  TrendingUp,
  CheckCircle2,
  Radio,
  FileKey2,
  Vault,
  Plus,
} from 'lucide-react'
import clsx from 'clsx'
import { useAuthStore } from '../store/authStore'
// verifyAudit is no longer called from this page. Chain verification moved off
// the dashboard masthead and lives on Admin Center > Audit & Compliance, which
// already owns a full Chain tab for it. Left in the comment so nobody assumes
// the call disappeared from the product.
import {
  getStats,
  listJitRequests,
  listAudit,
  /* verifyAudit, */ approveJitRequest,
  denyJitRequest,
} from '../api/admin'
import { listMyGrants, listMyJitRequests } from '../api/jit'
import { listMySessions } from '../api/sessions'
import { searchAudit } from '../api/audit'
import { Card, CardHeader, CardTitle, CardFooter, EmptyState } from '../components/common/Layout'
import { PageTitle } from '../components/ui/layout'
import { QueryState } from '../components/common/QueryState'
import { Badge, MetaTag } from '../components/common/Badge'
import { Button } from '../components/common/Button'
import { Spinner } from '../components/common/Spinner'
import { SegmentedControl } from '../components/common/SegmentedControl'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { AreaChart, DonutChart, BarList } from '../components/charts/Charts'
import {
  bucketByTime,
  outcomeBreakdown,
  topActions,
  topActors,
  categoryBreakdown,
  attentionCounts,
  expiringGrants,
} from '../lib/dashboardMetrics'
import { eventActor, eventTarget, isFailure } from '../components/audit/auditFields'
import { formatDateTime, formatRelativeToNow } from '../lib/format'
import { apiErrorMessage } from '../lib/apiError'
import { JIT_STATUS, JIT_STATUS_BADGE, JIT_STATUS_LABELS, AUDIT_OUTCOME_BADGE } from '../config/constants'
import {
  approveBlockedReason,
  approveButtonLabel,
  approveConsequence,
  readApproveResult,
  approveResultMessage,
  approvalErrorMessage,
  isStaleStateError,
  viewerIdOf,
} from '../lib/fourEyes'
import { ApprovalProgress } from '../components/jit/ApprovalTrail'

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
// WHAT WAS WRONG WITH THE HIERARCHY. Everything on the page had the same
// weight: a page header, then a labelled band, then a KPI strip, then another
// labelled band, then two cards, then another band, then four charts, then a
// grid of navigation tiles that duplicated the sidebar. Six sections, all
// announced the same way, none of them louder than any other, so the eye had
// no entry point and the whole thing read as a stack of widgets. That flatness
// was the problem, not the individual components.
//
// WHAT REPLACES IT, and the principle behind each move:
//
//   1. ONE MASTHEAD, NOT A HEADER PLUS A STRIP. The greeting and the posture
// numbers are a single instrument plate at the top. That gives the page
// an unambiguous anchor, the thing you look at first, instead of three
// competing objects in the first fold. It is the shape Datadog, Grafana
//      Cloud and the AWS Security Hub summary all use.
//
//   2. ATTENTION COLLAPSES WHEN THERE IS NONE. The old page spent half the
// fold on two large empty cards saying "Queue clear" and "Nothing denied
// recently". Good news should be small. When both are empty it is now
// one slim green strip; the cards only take real estate when they carry
// something you must act on. Nothing is hidden, the state is still
// stated, just proportionately.
//
//   3. SECTION HEADINGS ARE RANKED. "Needs your attention" is a heading with
// a live count; "Activity" is a quieter rule. Two levels, so the page
// has a spine.
//
//   4. THE NAV TILE GRID IS GONE. Four cards linking to Identity, Roles,
//      Policies and Audit, immediately below a sidebar containing Identity,
//      Roles, Policies and Audit. Pure filler, and filler at the bottom of a
// dashboard is what makes a console feel padded.
//
// Every chart is still computed client-side from audit rows this page fetched
// (see lib/dashboardMetrics) because the backend has no analytics endpoint,
// and each one still prints its sample size rather than implying a complete
// picture.
//
// THE SAMPLE SIZE IS NOW THE USER'S CHOICE. It used to be a hard-coded 200,
// which is a sensible default and a bad ceiling: 200 entries on a busy
// deployment can be under an hour of history, so the 7-day and 30-day ranges
// were plotting a window the sample could not fill. The control below sets how
// many entries every chart on the page is computed from. It is deliberately
// one control for the whole Activity zone, because one sample feeds all of it,
// and each dashboard view (admin and self-service) keeps its own choice.

const EVENT_LIMITS = [
  { key: '200', label: 'Last 200 events', value: 200, scope: 'the 200 most recent audit entries' },
  { key: '500', label: 'Last 500 events', value: 500, scope: 'the 500 most recent audit entries' },
  { key: '1000', label: 'Last 1,000 events', value: 1000, scope: 'the 1,000 most recent audit entries' },
  {
    key: 'all',
    label: 'Last 5,000 events',
    // 5,000 is the practical ceiling. Past this the charts are being computed
    // in the browser from a payload measured in megabytes, over a page walk
    // long enough that the user is waiting on it.
    value: 5000,
    scope: 'the 5,000 most recent audit entries, or every entry held if there are fewer',
  },
]

const DEFAULT_EVENT_LIMIT = '200'

function resolveLimit(key) {
  return EVENT_LIMITS.find((o) => o.key === key) || EVENT_LIMITS[0]
}

// ---------------------------------------------------------------------------
// Assembling the sample
// ---------------------------------------------------------------------------
// WHY THIS IS NOT ONE REQUEST, and why the control used to do nothing above
// 200. Both audit endpoints clamp how many rows a single call may return, and
// they clamp SILENTLY: an over-large ask comes back trimmed, with a 200 OK and
// nothing in the payload saying it was trimmed.
//
//   GET /admin/audit page_size clamped to 200  (pagingFrom at the HTTP
// layer, and again in AuditService.List's normalisePaging)
//   GET /audit/search limit clamped to 500  (AuditQueryService.Search)
//
// So "Last 1,000" and "All available" were both being served exactly 200 rows
// on the admin dashboard and exactly 500 on the self-service one. Every chart
// was then recomputed from an identical row set, which is exactly the reported
// symptom: moving the control changed nothing in the activity cards.
//
// The fix is to page. Each helper below walks consecutive pages AT THE
// ENDPOINT'S OWN MAXIMUM and concatenates until it has the requested number of
// rows, the server runs out of history, or a hard request ceiling is hit.
// Requests are sequential and every one carries the query's abort signal, so
// changing the control mid-walk cancels the rest instead of leaving a fan of
// requests in flight.
//
// Rows are de-duplicated by id. The log is ordered newest-first, so an entry
// written between page 1 and page 2 shifts the whole window down and would
// otherwise be counted twice - which would quietly inflate every chart.

const ADMIN_PAGE_CAP = 200 // GET /admin/audit - page_size ceiling
const SEARCH_PAGE_CAP = 500 // GET /audit/search - limit ceiling
const MAX_SAMPLE_REQUESTS = 30

function eventKey(e) {
  return e?.id ?? e?.sequence_number ?? `${e?.occurred_at || ''}|${e?.action || ''}|${e?.actor_user_id || ''}`
}

function appendUnique(rows, seen, batch) {
  for (const e of batch) {
    const key = eventKey(e)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(e)
  }
}

// Org-wide sample. Returns the same { events, pagination } shape one listAudit
// call returns, so every consumer of auditQuery.data stays unchanged.
async function fetchAuditSample(target, signal) {
  const rows = []
  const seen = new Set()
  let pagination = null
  for (let page = 1; page <= MAX_SAMPLE_REQUESTS; page += 1) {
    const data = await listAudit({ page, page_size: ADMIN_PAGE_CAP }, signal)
    const batch = data?.events || []
    pagination = data?.pagination || pagination
    appendUnique(rows, seen, batch)
    if (batch.length < ADMIN_PAGE_CAP) break // ran out of history
    if (rows.length >= target) break
    const totalPages = pagination?.total_pages
    if (totalPages && page >= totalPages) break
  }
  return { events: rows.slice(0, target), pagination }
}

// Personal trail. limit/offset rather than page/page_size, so the offset is
// tracked from rows RECEIVED (not rows kept) - otherwise a de-duplicated row
// would make the next request re-read a window it has already seen.
// Returns searchAudit's { items, total } shape.
async function fetchSelfAuditSample(target, signal) {
  const rows = []
  const seen = new Set()
  let offset = 0
  let total = null
  for (let i = 0; i < MAX_SAMPLE_REQUESTS; i += 1) {
    const want = Math.min(SEARCH_PAGE_CAP, target - rows.length)
    if (want <= 0) break
    const data = await searchAudit({ limit: want, offset }, signal)
    const batch = data?.items || []
    total = data?.total ?? total
    appendUnique(rows, seen, batch)
    offset += batch.length
    if (batch.length < want) break
    if (total != null && offset >= total) break
  }
  return { items: rows.slice(0, target), total: total ?? rows.length }
}

function pick(obj, ...keys) {
  if (!obj) return undefined
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return undefined
}

const RANGES = [
  { key: '24h', label: '24h', buckets: 24, span: 'hour' },
  { key: '7d', label: '7 days', buckets: 7, span: 'day' },
  { key: '30d', label: '30 days', buckets: 30, span: 'day' },
]

// ---------------------------------------------------------------------------
// Activity toolbar
// ---------------------------------------------------------------------------
// ONE control group for one sample. The time range and the sample size answer
// halves of the same question ("which events am I looking at"), so they sit
// together in the section rule rather than being split between a rule and a
// card header the way they were.
//
// Replaced EventSampleSelect (sample-select only) with ActivityToolbar so the
// two halves of a single question live in one strip. Both controls govern the
// same sample, so the toolbar exists exactly once and sits in the QuietSection
// rule above the Activity zone. Nothing in this file outside the Activity
// zone renders an ActivityToolbar.

function ActivityToolbar({ range, onRangeChange, limitKey, onLimitChange, idSuffix, fetching }) {
  const id = `dashboard-event-sample-${idSuffix}`
  return (
    <>
      <SegmentedControl
        size="sm"
        ariaLabel="Time range"
        value={range}
        onChange={onRangeChange}
        options={RANGES.map((r) => ({ key: r.key, label: r.label }))}
      />
      <span className="flex flex-none items-center gap-2">
        <label htmlFor={id} className="text-sm text-secondary">
          Sample
        </label>
        <select
          id={id}
          value={limitKey}
          onChange={(e) => onLimitChange(e.target.value)}
          className="h-7 cursor-pointer rounded-lg border border-surface-700 bg-surface-900 pl-2.5 pr-7 text-xs font-medium text-ink-100 shadow-sm transition-colors hover:border-surface-600 focus:border-blue-500 focus:outline-none"
        >
          {EVENT_LIMITS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        {fetching && <Spinner size="h-3 w-3" />}
      </span>
    </>
  )
}

// ---------------------------------------------------------------------------
// Section headings
// ---------------------------------------------------------------------------

function SectionLink({ to, children }) {
  return (
    <Link
      to={to}
      className="group inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
    >
      {children}
      <ArrowRight
        className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
        strokeWidth={2}
      />
    </Link>
  )
}

// Level-1 heading: used once per page, for the zone that carries an action.
function PrimarySection({ title, count, children }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2.5">
        <h2 className="text-xl font-bold leading-tight text-primary">{title}</h2>
        {count > 0 && (
          <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs font-bold tabular text-warn">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

// Level-2 heading: a quiet labelled rule for zones you read, not act on.
function QuietSection({ label, action, children }) {
  return (
    <section className="mt-9">
      <div className="mb-3.5 flex items-center gap-3">
        <h2 className="flex-none text-xl font-bold leading-tight text-primary">{label}</h2>
        <span className="h-px flex-1 bg-line-soft" aria-hidden="true" />
        {action && <div className="flex flex-none items-center gap-3">{action}</div>}
      </div>
      {children}
    </section>
  )
}

function AllClearStrip({ children }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-emerald-600/25 bg-emerald-50/70 px-4 py-3 dark:bg-emerald-950/15">
      <CheckCircle2 className="h-4 w-4 flex-none text-emerald-600 dark:text-emerald-400" strokeWidth={1.9} />
      <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">{children}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Administration shortcuts
// ---------------------------------------------------------------------------
// A NAV TILE GRID WAS REMOVED FROM THIS PAGE IN AN EARLIER PASS, AND BRINGING
// ONE BACK NEEDS A REASON. The old one was four large cards linking to
// Identity, Roles, Policies and Audit sitting directly under a sidebar
// containing Identity, Roles, Policies and Audit: same destinations, same
// words, twice the height, no extra information. That is filler.
//
// This is a different object, and the difference is the whole justification.
// IT LEADS WITH THE ACTION, NOT THE PAGE. Each row's "+" goes straight to the
// create form (make a user, define a role, write a policy), which is the verb
// an administrator actually arrives wanting. The sidebar can only ever take
// you to a list. That is precisely the split AWS draws between its service nav
// and the console home's task shortcuts, and what Salesforce Setup's shortcut
// rail and Google Cloud's "Quick access" do.
//
// Deliberately NOT here: object counts. They would make the row read like an
// instrument, and GET /admin/stats returns only pending_approvals,
// active_sessions, active_grants, active_breakglass_grants and
// active_resources. There is no user, role, policy or safe total. Firing four
// more list requests on dashboard load to decorate a shortcut is exactly the
// kind of cost that is not worth a number nobody asked for.
//
// One dense row of rows, not four hero cards: this is bottom-of-page chrome
// and it is weighted like chrome.

function ShortcutRow({ to, icon: Icon, label, description, actionTo, actionLabel }) {
  return (
    <div className="group flex items-center gap-3 border-t border-surface-800 px-4 py-3 transition-colors first:border-t-0 hover:bg-surface-850 sm:border-l sm:border-t-0 sm:first:border-l-0">
      <Link to={to} className="flex min-w-0 flex-1 items-center gap-3 outline-none">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-850 text-ink-400 transition-colors group-hover:border-surface-600 group-hover:text-ink-200">
          <Icon className="h-4 w-4" strokeWidth={1.7} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink-100">{label}</span>
          <span className="mt-0.5 block truncate text-2xs text-ink-500">{description}</span>
        </span>
      </Link>
      {actionTo && (
        <Link
          to={actionTo}
          title={actionLabel}
          aria-label={actionLabel}
          className="flex h-7 w-7 flex-none items-center justify-center rounded-md border border-surface-700 bg-surface-900 text-ink-500 opacity-0 transition-all duration-150 hover:border-blue-500/50 hover:text-blue-600 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:text-blue-300"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.2} />
        </Link>
      )}
    </div>
  )
}

function AdminShortcuts() {
  return (
    <div className="grid overflow-hidden rounded-xl border border-surface-700/70 bg-surface-900 sm:grid-cols-2 xl:grid-cols-4">
      <ShortcutRow
        to="/admin/identity"
        icon={Users}
        label="Identity"
        description="Accounts, status and effective access"
        actionTo="/admin/identity?new=1"
        actionLabel="Create a user"
      />
      <ShortcutRow
        to="/admin/roles"
        icon={ShieldCheck}
        label="Roles"
        description="Bundles of policy, assigned to people"
        actionTo="/admin/roles?new=1"
        actionLabel="Create a role"
      />
      <ShortcutRow
        to="/admin/policies"
        icon={FileKey2}
        label="Policies"
        description="The allow and deny rules themselves"
        actionTo="/admin/policies?new=1"
        actionLabel="Write a policy"
      />
      <ShortcutRow
        to="/admin/vault-ops"
        icon={Vault}
        label="Vault Operations"
        description="Rotation, backup and restore"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Masthead: greeting plus posture, welded into one object
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The dashboard header
// ---------------------------------------------------------------------------
// WAS: a bordered plate carrying an eyebrow, a greeting, a sentence of prose
// and a five cell KPI grid, which is a KPI wall inside a card. Three problems.
//
// The greeting is not information. "Good to see you, d.okonkwo" is 26px of
// the fold spent on something the reader already knows.
//
// Five equal weight cells say all five numbers matter equally. They do not:
// pending approvals and break glass are things you act on, the rest are
// context. Equal weight is a decision not to rank, and ranking is the whole
// job of a dashboard.
//
// And a bordered card around the page's own title makes the title look like
// content rather than like the page.
//
// NOW: the page title, then the numbers on a rule. Each one is a link to the
// screen that owns it, and the ones that need action carry colour while the
// rest stay quiet. None of them shows a trend, because GET /admin/stats
// returns point in time counts with no history.
function Fact({ label, value, to, tone = 'default', description, live = false, loading }) {
  const toneClass = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-primary'

  const body = (
    <>
      <span className="flex items-baseline gap-2">
        {loading ? (
          <span className="skeleton block h-7 w-10 rounded" />
        ) : (
          <span className={clsx('text-2xl font-bold leading-none tabular', toneClass)}>{value}</span>
        )}
        <span className="flex items-center gap-1.5 text-sm text-secondary">
          {label}
          {live && !loading && (
            <span className="relative flex h-1.5 w-1.5 flex-none rounded-full bg-ok" aria-hidden="true">
              <span className="dot-live absolute inset-0 rounded-full bg-ok" />
            </span>
          )}
        </span>
      </span>
      {description && <span className="mt-0.5 block text-xs text-tertiary">{description}</span>}
    </>
  )

  if (!to) return <span className="min-w-0">{body}</span>
  return (
    <Link
      to={to}
      className="min-w-0 rounded transition-colors hover:[&_span]:text-accent focus-visible:outline-2"
    >
      {body}
    </Link>
  )
}

function Masthead({ title, description, cells, loading }) {
  return (
    <div>
      <PageTitle title={title} description={description} />
      <div className="mt-4 flex flex-wrap items-start gap-x-10 gap-y-4 border-y border-line-soft py-4">
        {cells.map((c) => (
          <Fact key={c.key} {...withoutKey(c)} loading={loading || c.loading} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CHAIN VERIFICATION ASIDE, REMOVED FROM THE MASTHEAD (kept for reference)
// ---------------------------------------------------------------------------
// It sat inside the control-plane plate as a third column of prose: a heading,
// two lines of explanation and a button. Three problems. It was the wordiest
// object in the first fold while being the least urgent, an on-demand
// integrity check nobody runs on every login. It squeezed the five posture
// numbers into a narrower grid than they deserved. And it duplicated the Chain
// tab on Admin Center > Audit & Compliance, which does the same job with room
// to show the break detail. So the masthead is posture only, and chain
// verification has exactly one home. Restore this component and pass
// `aside={<ChainAside mutation={verifyMutation} />}` to bring it back.
//
// function ChainAside({ mutation }) {
// const r = mutation.data
// const field = r && ('valid' in r ? 'valid' : 'chain_valid' in r ? 'chain_valid' : 'intact' in r ? 'intact' : 'success' in r ? 'success' : null)
// const isValid = field ? Boolean(r[field]) : null
//   … status plate + Verify chain button …
// }

// ---------------------------------------------------------------------------
// Analysis (shared)
// ---------------------------------------------------------------------------
//
// CHANGES IN THIS SECTION ONLY. The Activity zone was carrying the same
// control twice in different places: the time range inside the Activity
// volume card header, and the sample size in the section rule above it.
// That made the two halves of one question ("which events am I looking at")
// look unrelated. The toolbar now groups them; this Analysis component no
// longer owns the range control and the two card headers are quiet readers
// of the current selection (window chip + sample-size chip, denial rate).
//
// The cards themselves, the footer copy, the chart wiring and the
// extra-slot layout are unchanged.

function ActivityAnalysis({ events, loading, range, scopeNote, auditHref, extra }) {
  const preset = RANGES.find((r) => r.key === range) || RANGES[0]

  const series = useMemo(
    () => bucketByTime(events, { buckets: preset.buckets, span: preset.span }),
    [events, preset]
  )
  const outcomes = useMemo(() => outcomeBreakdown(events), [events])
  const actions = useMemo(() => topActions(events), [events])
  const categories = useMemo(() => categoryBreakdown(events), [events])
  const counts = useMemo(() => attentionCounts(events), [events])
  const plotted = series.reduce((n, s) => n + s.value, 0)
  // Computed here because the Outcomes card is the only place this percentage
  // is shown, keeping the math next to its display means the chart and the
  // chip can never disagree about which "denied" they mean.
  const failureRate = counts.total > 0 ? (counts.failed / counts.total) * 100 : 0

  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader className="flex-wrap gap-y-2">
            <CardTitle icon={TrendingUp}>Activity volume</CardTitle>
            {/* The range control is NOT here any more, it governs this card,
 the donut and the ranked lists, so it belongs to the section
 rule above the cards, not to one of the things it changes. */}
            <span className="ml-auto flex items-center gap-2">
              <MetaTag>{preset.label}</MetaTag>
              <MetaTag mono>{counts.total.toLocaleString()} sampled</MetaTag>
            </span>
          </CardHeader>
          <div className="px-4 pb-3 pt-4">
            {loading ? (
              <div className="skeleton h-[200px] rounded-lg" />
            ) : (
              <AreaChart points={series} valueLabel="Events" />
            )}
          </div>
          <CardFooter className="justify-between">
            <p className="text-2xs leading-relaxed text-ink-500">
              {plotted.toLocaleString()} of the {counts.total.toLocaleString()} events in this sample fall
              inside the selected window. {scopeNote}
            </p>
            <SectionLink to={auditHref}>Open audit</SectionLink>
          </CardFooter>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle icon={ShieldCheck}>Outcomes</CardTitle>
            {counts.total > 0 && (
              <span className="ml-auto">
                {/* Renders "<0.1" rather than "0.0" for sub-decimal rates so
 a quiet denial day is read as a quiet denial day, not as
 a perfectly clean one. Real zero is still 0.0. */}
                <MetaTag>
                  {failureRate < 0.1 && counts.failed > 0 ? '<0.1' : failureRate.toFixed(1)}% denied or failed
                </MetaTag>
              </span>
            )}
          </CardHeader>
          <div className="p-4">
            {loading ? (
              <div className="skeleton h-[148px] rounded-lg" />
            ) : counts.total === 0 ? (
              <p className="py-12 text-center text-xs text-ink-500">No events recorded yet</p>
            ) : (
              <DonutChart
                segments={outcomes}
                centerValue={counts.total.toLocaleString()}
                centerLabel="events"
              />
            )}
          </div>
          <CardFooter>
            <p className="text-2xs leading-relaxed text-ink-500">
              Across the {counts.total.toLocaleString()} events in this sample. A denial is not necessarily an
              incident: policy working is the common case.
            </p>
          </CardFooter>
        </Card>
      </div>

      <div className={clsx('mt-4 grid gap-4', extra ? 'lg:grid-cols-2 xl:grid-cols-3' : 'lg:grid-cols-2')}>
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle icon={Activity}>Most frequent actions</CardTitle>
          </CardHeader>
          <BarList items={actions} mono emptyLabel="No actions recorded yet" />
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle icon={ClipboardList}>By category</CardTitle>
            <span className="ml-auto text-2xs text-ink-500">red = contains a denial</span>
          </CardHeader>
          <BarList items={categories} emptyLabel="No categories recorded yet" />
        </Card>

        {extra}
      </div>
    </>
  )
}

function DeniedList({ events, href }) {
  const denied = (events || []).filter(isFailure).slice(0, 5)

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle icon={ShieldAlert}>Denied &amp; failed</CardTitle>
        <span className="ml-auto">
          <SectionLink to={href}>View all</SectionLink>
        </span>
      </CardHeader>
      <ul className="divide-y divide-surface-800">
        {denied.map((e, i) => (
          <li key={e?.id ?? i} className="relative px-4 py-3 pl-5">
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-red-400/70" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded border border-surface-700 bg-surface-850 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-ink-500">
                {e?.category || 'OTHER'}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-ink-100"
                title={e?.action || undefined}
              >
                {e?.action || 'unknown action'}
              </span>
              {e?.outcome && <Badge className={AUDIT_OUTCOME_BADGE[e.outcome]}>{e.outcome}</Badge>}
            </div>
            <p className="mt-1 truncate text-2xs text-ink-500">
              {eventActor(e) || 'unknown actor'}
              {eventTarget(e) ? ` · ${eventTarget(e)}` : ''} ·{' '}
              {formatDateTime(e?.occurred_at || e?.created_at)}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

function AdminDashboard({ user }) {
  const queryClient = useQueryClient()
  const [range, setRange] = useState('24h')
  // Scoped to this view. The self-service dashboard below keeps its own,
  // because "how much of my own trail" and "how much of the org's trail" are
  // different questions with different costs.
  const [limitKey, setLimitKey] = useState(DEFAULT_EVENT_LIMIT)
  const sample = resolveLimit(limitKey)
  const [approveTarget, setApproveTarget] = useState(null)
  const [denyTarget, setDenyTarget] = useState(null)

  // Root's approval is final on its own, which changes what the Approve
  // button here promises, so the button has to know.
  const isRootUser = useAuthStore((st) => st.isRoot())

  const statsQuery = useQuery({ queryKey: ['admin', 'stats'], queryFn: ({ signal }) => getStats(signal) })

  // One sample serves every chart AND the denied list. The chosen size is part
  // of the key, so switching it refetches instead of re-slicing stale rows,
  // and placeholderData keeps the previous charts on screen while it does.
  // fetchAuditSample, not a bare listAudit: the endpoint caps one call at 200
  // rows, so anything larger has to be walked a page at a time.
  const auditQuery = useQuery({
    queryKey: ['admin', 'audit', 'dashboard-sample', sample.value],
    queryFn: ({ signal }) => fetchAuditSample(sample.value, signal),
    placeholderData: (prev) => prev,
    retry: false,
  })

  const pendingQuery = useQuery({
    queryKey: ['admin', 'jit-requests', 'pending-list'],
    queryFn: ({ signal }) => listJitRequests({ page: 1, page_size: 5, status: 'PENDING' }, signal),
  })

  // FOUR-EYES. A request with one of its two approvals is NOT waiting on
  // nobody, it is waiting on a specific second person, and it is the fastest
  // thing in the queue to clear. Filtering the queue to PENDING alone would
  // hide exactly those. The endpoint takes one status at a time, so this is a
  // second call rather than a widened filter.
  const partialQuery = useQuery({
    queryKey: ['admin', 'jit-requests', 'partial-list'],
    queryFn: ({ signal }) =>
      listJitRequests({ page: 1, page_size: 5, status: JIT_STATUS.PARTIALLY_APPROVED }, signal),
    retry: false,
  })

  const invalidatePending = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'jit-requests'] })
    queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] })
  }

  const approveMutation = useMutation({
    mutationFn: ({ id, reason }) => approveJitRequest(id, reason),
    // The response says which of the two things just happened. "Request
    // approved" on a first approval would promise access that does not exist.
    onSuccess: (data) => {
      const result = readApproveResult(data)
      toast.success(approveResultMessage(result), {
        description: result.partial
          ? result.next || 'A second, different admin, or root, must approve to issue the grant.'
          : undefined,
      })
      setApproveTarget(null)
      invalidatePending()
    },
    onError: (err) => {
      toast.error(approvalErrorMessage(err, apiErrorMessage(err)))
      setApproveTarget(null)
      if (isStaleStateError(err)) invalidatePending()
    },
  })

  const denyMutation = useMutation({
    mutationFn: ({ id, reason }) => denyJitRequest(id, reason),
    onSuccess: () => {
      toast.success('Request denied')
      setDenyTarget(null)
      invalidatePending()
    },
    onError: (err) => {
      toast.error(approvalErrorMessage(err, apiErrorMessage(err)))
      setDenyTarget(null)
      if (isStaleStateError(err)) invalidatePending()
    },
  })

  const s = statsQuery.data
  const events = useMemo(() => auditQuery.data?.events || [], [auditQuery.data])
  const actors = useMemo(() => topActors(events), [events])

  // One queue, oldest first, with the half-approved ones in it. Capped at the
  // same five rows the card was always sized for, this is a pointer to the
  // real queue, not the queue.
  const pending = useMemo(() => {
    const first = pendingQuery.data?.requests || []
    const second = partialQuery.data?.requests || []
    return [...first, ...second]
      .sort(
        (a, b) =>
          new Date(a?.requested_at || a?.created_at || 0).getTime() -
          new Date(b?.requested_at || b?.created_at || 0).getTime()
      )
      .slice(0, 5)
  }, [pendingQuery.data, partialQuery.data])

  const viewer = useMemo(() => ({ id: viewerIdOf(user), isRoot: isRootUser }), [user, isRootUser])
  const denied = useMemo(() => events.filter(isFailure), [events])
  const isMutatingJit = approveMutation.isPending || denyMutation.isPending

  const nothingWaiting =
    !pendingQuery.isLoading && !auditQuery.isLoading && pending.length === 0 && denied.length === 0

  return (
    <div>
      {/* The plate is posture only: identity, five numbers, no prose.
          Everything that was explanation has either moved to the surface that
 owns it (chain verification to Admin Center > Audit & Compliance) or
 been cut, because a number with a two-word caption is read faster
 than a paragraph telling you what to feel about it. */}
      <Masthead
        title="Dashboard"
        description="Organisation wide posture, and what is waiting on you."
        loading={statsQuery.isLoading}
        cells={[
          {
            key: 'sessions',
            label: 'Active sessions',
            icon: Activity,
            tone: 'default',
            live: true,
            value: pick(s, 'active_sessions') ?? 'n/a',
            description: 'Live now',
            to: '/sessions',
          },
          {
            key: 'pending',
            label: 'Pending approvals',
            icon: KeyRound,
            tone: (pick(s, 'pending_approvals') ?? 0) > 0 ? 'warn' : 'default',
            value: pick(s, 'pending_approvals') ?? 'n/a',
            // Four-eyes splits the queue in two, and the split is the useful
            // half: the requests already carrying one approval need a single
            // different admin and nothing else. `pending_approvals` also
            // counts break-glass WAITING, so it is NOT the sum of the two ,
            // the caption says the parts rather than implying arithmetic.
            description:
              pick(s, 'awaiting_second_approval') != null || pick(s, 'awaiting_first_approval') != null
                ? `${pick(s, 'awaiting_first_approval') ?? 0} new · ${pick(s, 'awaiting_second_approval') ?? 0} need a 2nd`
                : 'Awaiting you',
            to: '/admin/jit',
          },
          {
            key: 'grants',
            label: 'Active grants',
            icon: Lock,
            value: pick(s, 'active_grants') ?? 'n/a',
            description: 'Elevation in force',
            to: '/admin/jit',
          },
          {
            key: 'resources',
            label: 'Resources',
            icon: Boxes,
            value: pick(s, 'active_resources') ?? 'n/a',
            description: 'Registered',
            to: '/resources',
          },
          {
            key: 'breakglass',
            label: 'Break-glass active',
            icon: ShieldAlert,
            tone: (pick(s, 'active_breakglass_grants') ?? 0) > 0 ? 'danger' : 'default',
            value: pick(s, 'active_breakglass_grants') ?? 'n/a',
            description: 'Emergency use',
            to: '/admin/jit',
          },
        ]}
      />

      {/* Good news is small. Two large empty cards saying "nothing here" used
 to eat half the fold; this is the same information, proportionate. */}
      {nothingWaiting ? (
        <div className="mt-8">
          <AllClearStrip>
            Nothing is waiting on you. The approval queue is clear and no action has been denied recently.
          </AllClearStrip>
        </div>
      ) : (
        <PrimarySection title="Needs your attention" count={pending.length}>
          <div className={clsx('grid gap-4', pending.length > 0 && denied.length > 0 && 'lg:grid-cols-2')}>
            {pending.length > 0 && (
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle icon={KeyRound}>Approval queue</CardTitle>
                  <span className="ml-auto">
                    <SectionLink to="/admin/jit">View all</SectionLink>
                  </span>
                </CardHeader>
                <QueryState
                  query={pendingQuery}
                  empty={(d) => !d?.requests || d.requests.length === 0}
                  emptyTitle="Queue clear"
                  emptyMessage="No JIT or break-glass requests are waiting on a decision."
                  skeletonRows={3}
                >
                  {() => (
                    <ul className="divide-y divide-surface-800">
                      {pending.map((r) => (
                        <li
                          key={r.id}
                          className="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-ink-100">
                              {r?.resource_name || r?.resource_id || 'Unnamed resource'}
                              <span className="ml-2 text-xs font-normal text-ink-500">
                                by{' '}
                                {r?.requester_username ||
                                  r?.username ||
                                  r?.requested_by ||
                                  r?.user_id ||
                                  'unknown requester'}
                              </span>
                            </p>
                            <p className="mt-0.5 truncate text-xs text-ink-500">
                              {formatRelativeToNow(r?.created_at)}
                              {r?.justification || r?.reason ? ` · ${r.justification || r.reason}` : ''}
                            </p>
                          </div>
                          <div className="flex flex-none items-center gap-2">
                            {/* No trail on a list response, so this counts
 from status alone, "1 of 2", never who. */}
                            <ApprovalProgress request={r} approvals={null} showLabel={false} />
                            {/* <Badge className={JIT_STATUS_BADGE[r?.status]}>
                              {JIT_STATUS_LABELS[r?.status] || r?.status || 'Unknown'}
                            </Badge> */}
                            <Button
                              size="xs"
                              variant="primary"
                              disabled={isMutatingJit || !!approveBlockedReason(r, null, viewer)}
                              title={approveBlockedReason(r, null, viewer) || undefined}
                              onClick={() => setApproveTarget(r)}
                            >
                              {approveButtonLabel(r, null, viewer)}
                            </Button>
                            <Button
                              size="xs"
                              variant="dangerGhost"
                              disabled={isMutatingJit}
                              onClick={() => setDenyTarget(r)}
                            >
                              Deny
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </QueryState>
              </Card>
            )}

            {denied.length > 0 && <DeniedList events={events} href="/admin/audit" />}
          </div>
        </PrimarySection>
      )}

      <QuietSection
        label="Activity"
        action={
          <ActivityToolbar
            range={range}
            onRangeChange={setRange}
            limitKey={limitKey}
            onLimitChange={setLimitKey}
            idSuffix="admin"
            fetching={auditQuery.isFetching}
          />
        }
      >
        <ActivityAnalysis
          events={events}
          loading={auditQuery.isLoading}
          range={range}
          auditHref="/admin/audit"
          // scopeNote={`Organization-wide, computed from ${sample.scope}.`}
          extra={
            <>
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle icon={Users}>Most active accounts</CardTitle>
                </CardHeader>
                <BarList items={actors} emptyLabel="No actor activity in the sample" />
                <CardFooter>
                  <p className="text-2xs leading-relaxed text-ink-500">
                    High volume is not itself suspicious. An automation account should be here.
                  </p>
                </CardFooter>
              </Card>

              {/* "Accounts hitting denials" lived here and is currently off.
                  To bring it back, restore this block and compute
                  `const deniedActors = topActors(denied)` above. */}
              {/* {deniedActors.length > 0 && (
                <Card className="overflow-hidden">
                  <CardHeader>
                    <CardTitle icon={ShieldAlert}>Accounts hitting denials</CardTitle>
                  </CardHeader>
                  <BarList items={deniedActors} emptyLabel="No denials in the sample" />
                  <CardFooter>
                    <p className="text-2xs leading-relaxed text-ink-500">
                      From the {denied.length.toLocaleString()} denied or failed entries in this sample.
                      Repeated refusals usually mean under-entitlement, not an attack.
                    </p>
                  </CardFooter>
                </Card>
              )} */}
            </>
          }
        />
      </QuietSection>

      <QuietSection
        label="Administration"
        // action={<SectionLink to="/admin/identity">Admin Center</SectionLink>}
      >
        <AdminShortcuts />
      </QuietSection>

      <ConfirmDialog
        open={!!approveTarget}
        title={`Approve request for "${approveTarget?.resource_name || approveTarget?.resource_id || 'this resource'}"?`}
        description={approveConsequence(approveTarget, null, viewer)}
        confirmLabel={approveButtonLabel(approveTarget, null, viewer)}
        reasonLabel="Reason (optional)"
        isLoading={approveMutation.isPending}
        onConfirm={(reason) => approveMutation.mutate({ id: approveTarget.id, reason })}
        onCancel={() => setApproveTarget(null)}
      />

      <ConfirmDialog
        open={!!denyTarget}
        title={`Deny request for "${denyTarget?.resource_name || denyTarget?.resource_id || 'this resource'}"?`}
        description="One denial ends this request, unlike approval, it does not wait for a second person. The requester will need to submit a new one if access is still needed."
        confirmLabel="Deny"
        destructive
        requireReason
        reasonLabel="Reason for denial (required for the audit record)"
        isLoading={denyMutation.isPending}
        onConfirm={(reason) => denyMutation.mutate({ id: denyTarget.id, reason })}
        onCancel={() => setDenyTarget(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Self-service
// ---------------------------------------------------------------------------

function UserDashboard({ user }) {
  const [range, setRange] = useState('7d')
  const [limitKey, setLimitKey] = useState(DEFAULT_EVENT_LIMIT)
  const sample = resolveLimit(limitKey)

  const grantsQuery = useQuery({
    queryKey: ['jit', 'grants', 'mine', { activeOnly: true, dashboard: true }],
    queryFn: ({ signal }) => listMyGrants({ activeOnly: true, pageSize: 25, signal }),
  })
  const requestsQuery = useQuery({
    queryKey: ['jit', 'requests', 'mine', { status: 'PENDING', dashboard: true }],
    queryFn: ({ signal }) => listMyJitRequests({ status: 'PENDING', pageSize: 5, signal }),
  })
  // Half-approved is still in flight, one approval short of access, and the
  // state a requester most wants to see on their own dashboard. The endpoint
  // filters by a single status, hence the second call.
  const partialRequestsQuery = useQuery({
    queryKey: ['jit', 'requests', 'mine', { status: JIT_STATUS.PARTIALLY_APPROVED, dashboard: true }],
    queryFn: ({ signal }) =>
      listMyJitRequests({ status: JIT_STATUS.PARTIALLY_APPROVED, pageSize: 5, signal }),
    retry: false,
  })
  const sessionsQuery = useQuery({
    queryKey: ['sessions', 'mine', { activeOnly: true, dashboard: true }],
    queryFn: ({ signal }) => listMySessions({ activeOnly: true, pageSize: 5, signal }),
  })
  // Walked in pages of 500, the ceiling /audit/search enforces on limit.
  const auditQuery = useQuery({
    queryKey: ['audit', 'dashboard-sample', sample.value],
    queryFn: ({ signal }) => fetchSelfAuditSample(sample.value, signal),
    placeholderData: (prev) => prev,
    retry: false,
  })

  const events = useMemo(() => auditQuery.data?.items || [], [auditQuery.data])
  const grants = grantsQuery.data?.grants || []
  const expiring = useMemo(() => expiringGrants(grants), [grants])
  const pendingRequests = useMemo(
    () => [...(requestsQuery.data?.requests ?? []), ...(partialRequestsQuery.data?.requests ?? [])],
    [requestsQuery.data, partialRequestsQuery.data]
  )

  const partiallyApprovedCount = (partialRequestsQuery.data?.requests ?? []).length

  const loadingAttention = grantsQuery.isLoading || requestsQuery.isLoading
  const nothingWaiting = !loadingAttention && expiring.length === 0 && pendingRequests.length === 0

  return (
    <div>
      <Masthead
        eyebrow="Your access"
        title={`Welcome${user?.username ? `, ${user.username}` : ''}`}
        description="Elevation in force, requests in flight, live sessions, and what you've been doing."
        columns={4}
        cells={[
          {
            key: 'grants',
            label: 'Active grants',
            icon: Lock,
            loading: grantsQuery.isLoading,
            value: grantsQuery.data?.pagination?.total ?? grants.length,
            description: 'Elevation available to you right now',
            to: '/jit',
          },
          {
            key: 'expiring',
            label: 'Expiring soon',
            icon: Clock,
            tone: expiring.some((e) => e.tone === 'red') ? 'red' : expiring.length > 0 ? 'amber' : 'default',
            loading: grantsQuery.isLoading,
            value: expiring.length,
            description: 'Within the next 12 hours',
            to: '/jit',
          },
          {
            key: 'requests',
            label: 'Pending requests',
            icon: KeyRound,
            tone: pendingRequests.length > 0 ? 'amber' : 'default',
            loading: requestsQuery.isLoading || partialRequestsQuery.isLoading,
            // Both stages of the wait, added, one number for "how many of my
            // requests have not landed yet", which is the only question this
            // tile answers.
            value:
              (requestsQuery.data?.pagination?.total ?? requestsQuery.data?.requests?.length ?? 0) +
              (partialRequestsQuery.data?.pagination?.total ??
                partialRequestsQuery.data?.requests?.length ??
                0),
            description:
              partiallyApprovedCount > 0
                ? `${partiallyApprovedCount} one approval short`
                : 'Waiting on an approver',
            to: '/jit',
          },
          {
            key: 'sessions',
            label: 'Active sessions',
            icon: Radio,
            live: true,
            loading: sessionsQuery.isLoading,
            value: sessionsQuery.data?.pagination?.total ?? sessionsQuery.data?.sessions?.length ?? 0,
            description: 'Connections open in your name',
            to: '/sessions',
          },
        ]}
      />

      {nothingWaiting ? (
        <div className="mt-8">
          <AllClearStrip>
            Nothing needs you. No grant expires in the next 12 hours and no request is waiting on an approver.
          </AllClearStrip>
        </div>
      ) : (
        <PrimarySection title="Needs your attention" count={expiring.length + pendingRequests.length}>
          <div
            className={clsx(
              'grid gap-4',
              expiring.length > 0 && pendingRequests.length > 0 && 'lg:grid-cols-2'
            )}
          >
            {(expiring.length > 0 || loadingAttention) && (
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle icon={Clock}>Access expiring soon</CardTitle>
                  <span className="ml-auto">
                    <SectionLink to="/jit">All grants</SectionLink>
                  </span>
                </CardHeader>
                {grantsQuery.isLoading ? (
                  <div className="space-y-2 p-4">
                    {[0, 1].map((i) => (
                      <div key={i} className="skeleton h-10 rounded-lg" />
                    ))}
                  </div>
                ) : expiring.length === 0 ? (
                  <EmptyState
                    icon={CheckCircle2}
                    title="Nothing expiring in the next 12 hours"
                    className="py-8"
                  />
                ) : (
                  <ul className="divide-y divide-surface-800">
                    {expiring.slice(0, 5).map(({ grant, label, tone }) => (
                      <li key={grant.id} className="flex items-center justify-between gap-4 px-4 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink-100">
                            {grant.resource_name || grant.resource_id || 'Unnamed resource'}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-ink-500">
                            Expires {formatDateTime(grant.expires_at)}
                          </p>
                        </div>
                        <span
                          className={clsx(
                            'flex-none rounded-md px-2 py-1 text-2xs font-semibold tabular-nums ring-1 ring-inset',
                            tone === 'red'
                              ? 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25'
                              : tone === 'amber'
                                ? 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25'
                                : 'bg-surface-800 text-ink-400 ring-surface-700'
                          )}
                        >
                          {label}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {pendingRequests.length > 0 && (
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle icon={KeyRound}>Requests in flight</CardTitle>
                  <span className="ml-auto">
                    <SectionLink to="/jit">View all</SectionLink>
                  </span>
                </CardHeader>
                <ul className="divide-y divide-surface-800">
                  {pendingRequests.map((r) => (
                    <li key={r.id}>
                      <Link
                        to={`/jit/requests/${r.id}`}
                        className="group flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-850"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink-100">
                            {r.resource_name || r.resource_id || 'Unnamed resource'}
                          </p>
                          <p className="mt-0.5 text-xs text-ink-500">
                            Requested {formatRelativeToNow(r.created_at)}
                          </p>
                        </div>
                        <div className="flex flex-none items-center gap-2.5">
                          <ApprovalProgress request={r} approvals={null} showLabel={false} />
                          <Badge className={JIT_STATUS_BADGE[r.status]}>
                            {JIT_STATUS_LABELS[r.status] || r.status}
                          </Badge>
                          <ChevronRight
                            className="h-4 w-4 text-ink-600 transition-transform duration-200 group-hover:translate-x-0.5"
                            strokeWidth={1.5}
                          />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </PrimarySection>
      )}

      <QuietSection
        label="Your activity"
        action={
          <ActivityToolbar
            range={range}
            onRangeChange={setRange}
            limitKey={limitKey}
            onLimitChange={setLimitKey}
            idSuffix="self"
            fetching={auditQuery.isFetching}
          />
        }
      >
        <ActivityAnalysis
          events={events}
          loading={auditQuery.isLoading}
          range={range}
          auditHref="/audit"
          scopeNote={`Your own trail, computed from ${sample.scope}.`}
        />
      </QuietSection>
    </div>
  )
}

function withoutKey(item) {
  const { key, ...rest } = item
  return rest
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user)
  const isAdmin = useAuthStore((s) => s.isAdmin())
  return isAdmin ? <AdminDashboard user={user} /> : <UserDashboard user={user} />
}
