import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  useViewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  Clock,
  Database,
  FileKey2,
  Focus,
  KeyRound,
  Maximize2,
  Minimize2,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  RotateCcw,
  Route as RouteIcon,
  Search,
  Share2,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Target,
  UserRound,
  X,
  Layers,
} from 'lucide-react'
import clsx from 'clsx'
import { listUsers } from '../../api/identity'
import { getMemberGraph } from '../../api/identityGraph'
import {
  COL_STRIDE,
  DEFAULT_FILTERS,
  DEPTH_OPTIONS,
  EXPOSURE_FILTERS,
  KIND_FILTERS,
  LEVELS,
  MORE_H,
  MORE_W,
  NODE_H,
  NODE_W,
  REVEAL_INITIAL,
  REVEAL_STEP,
  activeFilterCount,
  buildTree,
  filterTree,
  filtersAreDefault,
  isMoreNode,
  layout,
  subtreeCount,
  pathNodes,
  pathToRoot,
  summarise,
  visibleNodes,
} from '../../lib/identityGraph'
import GraphNodeCard from '../../components/graph/GraphNode'
import { Menu, MenuDivider, MenuItem, MenuLabel, MenuNote } from '../../components/ui/menu'
import { PageTitle, Stack } from '../../components/ui/layout'
import { Button } from '../../components/common/Button'
import { DeniedState, EmptyState, ErrorState, OfflineState } from '../../components/ui/states'
import { apiErrorMessage, normalizeApiError } from '../../lib/apiError'
import { formatDateTime } from '../../lib/format'
import { SEARCH_DEBOUNCE_MS } from '../../config/constants'

// ---------------------------------------------------------------------------
// Identity graph
// ---------------------------------------------------------------------------
// "How is this account actually assembled, and what can it reach?"
//
// THE ONE DESIGN DECISION THIS PAGE IS BUILT ON: it never draws the whole
// graph. A single ordinary account returns around a hundred nodes, and a
// hundred nodes drawn at once is a hairball that answers nothing. Every
// product that does attack-path and access visualisation well collapses the
// graph and lets the reader open one branch at a time, keeping a count on the
// closed ones so nothing is silently hidden. That is the model here:
//
//   01 ACCOUNT -> 02 GRANTS -> 03 POLICIES -> 04 REACH
//
// Opening a card reveals only its own children. The branch you are reading
// stays fully lit; everything else dims rather than disappearing, so you keep
// your bearings while following a path.
//
// The colours are this console's own semantic tokens, not a second palette. A
// canvas is still part of the product, and a graph that invents its own reds
// and ambers teaches the reader that colour means something different here
// than it does on every other screen.

const nodeTypes = { identity: GraphNodeCard }

// ── Small pieces ───────────────────────────────────────────────────────────

// COLUMN HEADERS, ANCHORED TO THE COLUMNS.
//
// The first version was one fixed strip in the corner listing all four levels,
// which was honest but told you nothing about WHERE anything was. The version
// before that positioned each label at its column's x and then drifted the
// moment anyone panned, because it read the layout once and never again.
//
// This reads the live viewport transform, so a label sits over its column at
// any pan or zoom and slides off the edge with it. The text does not scale:
// a caption that shrinks with the scene stops being a caption. Only levels
// that have something on them are labelled, so the header row grows as the
// reader opens the graph rather than promising columns that are not there.
function ColumnHeaders({ counts }) {
  const { x, zoom } = useViewport()
  return (
    // A RESERVED BAND, NOT AN OVERLAY. Floating the labels over the canvas put
    // them on top of whatever card happened to be at the top of a column, and
    // no amount of fit padding fixes that reliably because the padding is a
    // fraction of a scene whose height keeps changing. Giving the row its own
    // strip costs 30px once and can never collide.
    <div className="relative h-[30px] flex-none overflow-hidden border-b border-line-soft bg-surface">
      {LEVELS.map((l) => {
        const n = counts[l.index] || 0
        if (!n) return null
        return (
          <div
            key={l.key}
            style={{ left: l.index * COL_STRIDE * zoom + x, width: Math.max(NODE_W * zoom, 120) }}
            className="absolute top-2 flex items-center gap-1.5 truncate"
          >
            <span className="rounded bg-subtle px-1 py-px text-2xs font-bold tabular text-tertiary">
              {String(l.index + 1).padStart(2, '0')}
            </span>
            <span className="truncate text-2xs font-bold uppercase tracking-[0.09em] text-secondary">
              {l.label}
            </span>
            <span className="tabular text-2xs font-bold text-accent">{n}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * What the canvas is drawing, and what it is not.
 *
 * Progressive disclosure only works if it is honest about itself. Without this
 * the reader has no way to tell a fully opened branch from one that stopped at
 * six, so the toolbar states both numbers, and says when a filter is the
 * reason the second one moved.
 */
function ShowingPill({ shown, total, filtered }) {
  const hidden = Math.max(0, total - shown)
  return (
    <span className="hidden items-center rounded-full border border-line-soft bg-subtle px-2.5 py-1 text-2xs text-secondary lg:inline-flex">
      <span className="tabular font-semibold text-primary">{shown}</span>
      <span className="px-1">of</span>
      <span className="tabular font-semibold text-primary">{total}</span>
      <span className="pl-1 text-tertiary">
        {filtered ? 'objects match' : hidden > 0 ? 'objects, open a branch for more' : 'objects, all open'}
      </span>
    </span>
  )
}

// ── Toolbar controls ───────────────────────────────────────────────────────
//
// The label-over-value chip, which is the shape every serious analysis toolbar
// converges on and the one this page was missing entirely. A bare "Everything"
// button tells a reader nothing; "DEPTH · Everything" tells them what dimension
// they are about to change before they open anything.

function ControlChip({ label, value, open, count }) {
  return (
    <span
      className={clsx(
        'inline-flex h-8 flex-none cursor-pointer select-none items-center gap-1.5 rounded-lg border px-2.5 transition-colors duration-100',
        open ? 'border-line-strong bg-hover' : 'border-line bg-surface hover:bg-hover'
      )}
    >
      <span className="text-2xs font-bold uppercase tracking-[0.08em] text-tertiary">{label}</span>
      <span className="max-w-[8rem] truncate text-xs font-semibold text-primary">{value}</span>
      {count > 0 && (
        <span className="tabular rounded bg-accent px-1 text-2xs font-bold text-accent-on">{count}</span>
      )}
      <ChevronDown className="h-3 w-3 flex-none text-tertiary" strokeWidth={2.2} />
    </span>
  )
}

/** An icon-only canvas action. Three of them, and all three do something real. */
function IconAction({ icon: Icon, label, onClick, disabled, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={clsx(
        'flex h-8 w-8 flex-none items-center justify-center rounded-lg border transition-colors duration-100',
        'disabled:pointer-events-none disabled:opacity-40',
        active
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-line bg-surface text-secondary hover:bg-hover hover:text-primary'
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={1.9} />
    </button>
  )
}

// The colour vocabulary, with what each one MEANS rather than just what it is
// called. A legend that reads "amber: standing access" assumes the reader
// already knows why that matters; the second line is what makes it a
// definition instead of a key.
const LEGEND = [
  {
    tone: 'bg-danger',
    label: 'Secret or full access',
    hint: 'Readable in plaintext, or unrestricted on the resource',
  },
  {
    tone: 'bg-warn',
    label: 'Standing access',
    hint: 'Reachable right now, with nothing to request',
  },
  {
    tone: 'bg-ok',
    label: 'Time boxed or deny',
    hint: 'Behind a JIT gate, or explicitly denied',
  },
  { tone: 'bg-accent', label: 'Structure', hint: 'The account and the grants it is built from' },
  { tone: 'bg-line-strong', label: 'Informational', hint: 'Listed or read only' },
]

// NO LEGEND ON THE CANVAS. It lived bottom-left, wrapped to two lines as soon
// as the canvas got a third column, and collided with the zoom controls. It is
// also reference material rather than something you consult mid-gesture, so it
// belongs where the rest of the reading is: the bottom of the detail panel.

// ── Panel pieces ───────────────────────────────────────────────────────────
//
// The rule this panel is built to, and the one the first version broke: SAY IT
// IN A NUMBER OR A LABEL, NOT IN A SENTENCE. A rail that explains each finding
// in two lines of prose reads as documentation, and nobody reads documentation
// while they are looking at a picture. The information is the same; it is
// carried by a headline figure, a grid of counts and a short label each,
// because that is what can be taken in at a glance beside a canvas.

function PanelLead({ icon: Icon, eyebrow, title, hint }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-tertiary">{eyebrow}</p>
        )}
        <p className="mt-0.5 text-sm font-bold text-primary">{title}</p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-tertiary">{hint}</p>}
      </div>
    </div>
  )
}

/** The one figure the panel leads with. */
function HeroMetric({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-accent/25 bg-accent-soft px-4 py-4 text-center">
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-accent">{label}</p>
      <p className="tabular mt-1 text-4xl font-bold leading-none text-primary">{value}</p>
      <p className="mt-1.5 text-2xs text-tertiary">{hint}</p>
    </div>
  )
}

function StatTile({ icon: Icon, label, value, tone }) {
  return (
    <div className="rounded-lg border border-line-soft bg-surface px-2.5 py-2">
      <div className="flex items-baseline gap-1.5">
        <Icon className="h-3 w-3 flex-none translate-y-px text-tertiary" strokeWidth={2} />
        <span
          className={clsx(
            'tabular text-xl font-bold leading-none',
            tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-primary'
          )}
        >
          {value}
        </span>
      </div>
      <p className="mt-1.5 text-2xs leading-tight text-tertiary">{label}</p>
    </div>
  )
}

/**
 * The risk chips under the account name.
 *
 * These replace the paragraph-per-finding list that was here. A chip carries
 * the same fact in three words, sits next to the name it is about, and can be
 * read without being read: the colour alone says whether there is anything to
 * look at.
 */
function RiskChips({ stats, user }) {
  const chips = []
  if (!user?.mfa_enabled) chips.push({ tone: 'danger', label: 'No MFA' })
  if (stats.credentials > 0) chips.push({ tone: 'danger', label: `${stats.credentials} revealable` })
  if (stats.standing > 0) chips.push({ tone: 'warn', label: `${stats.standing} standing` })
  if (stats.directPolicies > 0) chips.push({ tone: 'warn', label: `${stats.directPolicies} direct` })
  if (user?.status && user.status !== 'ACTIVE') chips.push({ tone: 'muted', label: user.status })
  if (user?.is_protected) chips.push({ tone: 'accent', label: 'Protected' })
  if (chips.length === 0) chips.push({ tone: 'ok', label: 'Nothing standing' })

  const TONE = {
    danger: 'border-danger/35 bg-danger-soft text-danger',
    warn: 'border-warn/35 bg-warn-soft text-warn',
    ok: 'border-ok/35 bg-ok-soft text-ok',
    accent: 'border-accent/35 bg-accent-soft text-accent',
    muted: 'border-line bg-subtle text-secondary',
  }

  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.label}
          className={clsx(
            'rounded border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide',
            TONE[c.tone]
          )}
        >
          {c.label}
        </span>
      ))}
    </div>
  )
}

// ── Access path ────────────────────────────────────────────────────────────
//
// THE REASON THIS PAGE IS A GRAPH AND NOT A LIST.
//
// "Can this account reach the payments database" is a yes or no that a table
// can answer. "Through what" is the question a graph exists for, and it is the
// one that matters operationally: the hop is the thing that can be revoked.
//
// Each step names the RELATION in two words, the way an attack-path view
// labels its edges, rather than explaining itself in a clause.

const PATH_ICON = {
  user: UserRound,
  role: ShieldCheck,
  policy: FileKey2,
  direct_policy: FileKey2,
  resource: Database,
  credential: KeyRound,
}

/** The relation that gets you from the previous hop to this one. */
function relationInto(node) {
  switch (node.kind) {
    case 'role':
      return node.meta?.roleKind === 'user_type' ? 'user type' : 'member of'
    case 'direct_policy':
      return 'attached'
    case 'policy':
      return String(node.meta?.effect || '').toLowerCase() === 'deny' ? 'denies' : 'allows'
    case 'resource':
      return 'reaches'
    case 'credential':
      return 'reveals'
    default:
      return 'then'
  }
}

const KIND_LABEL = {
  user: 'Account',
  role: 'Role',
  direct_policy: 'Direct policy',
  policy: 'Policy',
  resource: 'Resource',
  credential: 'Credential',
  capability: 'Capability',
}

function AccessPath({ nodes, onSelect }) {
  if (!nodes || nodes.length < 2) return null
  return (
    <ol>
      {nodes.map((n, i) => {
        const Icon = PATH_ICON[n.kind] || Layers
        const last = i === nodes.length - 1
        return (
          <li key={n.id}>
            {i > 0 && (
              <div className="flex items-center gap-2 py-1 pl-[0.4375rem]">
                <span className="h-3 w-px flex-none bg-line" aria-hidden="true" />
                <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-tertiary">
                  {relationInto(n)}
                </span>
              </div>
            )}
            <button
              type="button"
              onClick={() => onSelect(n.id)}
              className={clsx(
                'flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors',
                last
                  ? 'border-accent/35 bg-accent-soft'
                  : 'border-line-soft bg-surface hover:border-line hover:bg-hover'
              )}
            >
              <span
                className={clsx(
                  'flex h-5 w-5 flex-none items-center justify-center rounded',
                  last ? 'text-accent' : 'text-tertiary'
                )}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={clsx(
                    'block truncate text-xs font-semibold',
                    last ? 'text-accent' : 'text-primary'
                  )}
                  title={n.label}
                >
                  {n.label}
                </span>
              </span>
              <span className="flex-none text-2xs uppercase tracking-wide text-tertiary">
                {KIND_LABEL[n.kind] || n.kind}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

// ── The right rail ─────────────────────────────────────────────────────────
//
// Two modes, and the switch between them is the whole design. With nothing
// selected it is an ACCOUNT OVERVIEW: how much this account reaches and what
// is worth looking at. With a card selected it becomes an OBJECT VIEW: what
// that object is, how the account arrived at it, and where to go to change it.
//
// Cloudscape's guidance is the reason it is not one scrolling column holding
// both: a panel that stacks a summary the reader has finished with on top of
// the thing they just clicked buries the answer under the context.

/**
 * A wrapped row of monospace chips.
 *
 * A policy's actions are the densest thing in the panel and were the tallest:
 * ten one-per-line entries pushed everything under them off the screen. They
 * are short tokens, not sentences, so they wrap like tokens.
 */
function ChipList({ label, items, empty, tone = 'muted' }) {
  const list = Array.isArray(items) ? items : []
  const TONE = {
    accent: 'border-accent/25 bg-accent-soft text-accent',
    ok: 'border-ok/30 bg-ok-soft text-ok',
    muted: 'border-line-soft bg-subtle text-secondary',
  }
  return (
    <div>
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-tertiary">{label}</p>
      {list.length === 0 ? (
        <p className="mt-1.5 text-xs text-tertiary">{empty}</p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {list.map((v) => (
            <span
              key={v}
              className={clsx(
                'break-all rounded border px-1.5 py-0.5 font-mono text-2xs',
                TONE[tone] || TONE.muted
              )}
            >
              {v}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function PanelSection({ children, className = '' }) {
  return <section className={clsx('border-b border-line-soft px-4 py-4', className)}>{children}</section>
}

function Definitions() {
  return (
    <PanelSection className="border-b-0">
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-tertiary">
        What the colours mean
      </p>
      <ul className="mt-2 space-y-2">
        {LEGEND.map((l) => (
          <li key={l.label} className="flex gap-2">
            <span className={clsx('mt-[0.3rem] h-2 w-2 flex-none rounded-sm', l.tone)} aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-primary">{l.label}</span>
              <span className="block text-2xs leading-relaxed text-tertiary">{l.hint}</span>
            </span>
          </li>
        ))}
      </ul>
    </PanelSection>
  )
}

function AccountView({ tree, stats }) {
  const reach = useMemo(() => subtreeCount(tree), [tree])

  return (
    <>
      <PanelSection>
        <PanelLead icon={Target} eyebrow="Access reach" title="What can this account touch?" />
        <div className="mt-3">
          <HeroMetric label="Reachable objects" value={reach} hint="everything below this account" />
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <StatTile icon={Database} label="Resources" value={stats.resources} />
          <StatTile
            icon={KeyRound}
            label="Revealable secrets"
            value={stats.credentials}
            tone={stats.credentials > 0 ? 'danger' : undefined}
          />
          <StatTile
            icon={ShieldCheck}
            label="Standing, no request"
            value={stats.standing}
            tone={stats.standing > 0 ? 'warn' : undefined}
          />
          <StatTile icon={Clock} label="Behind a JIT gate" value={stats.jitGated} />
          <StatTile icon={FileKey2} label={`Policies, ${stats.denyPolicies} deny`} value={stats.policies} />
          <StatTile
            icon={Layers}
            label="Direct, outside a role"
            value={stats.directPolicies}
            tone={stats.directPolicies > 0 ? 'warn' : undefined}
          />
        </div>
      </PanelSection>

      <PanelSection>
        <div className="flex gap-2.5 rounded-lg border border-line-soft bg-subtle/50 px-3 py-2.5">
          <Share2 className="mt-0.5 h-3.5 w-3.5 flex-none text-accent" strokeWidth={2} />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-primary">Open one branch at a time</p>
            <p className="mt-0.5 text-2xs leading-relaxed text-tertiary">
              Every card says how much sits below it. A wide branch opens six at a time.
            </p>
          </div>
        </div>
      </PanelSection>

      <Definitions />
    </>
  )
}

function SelectedView({ tree, selected, onSelect, onBack }) {
  const path = useMemo(() => pathNodes(tree, selected.id), [tree, selected.id])
  const Icon = PATH_ICON[selected.kind] || Layers

  // Only where a real page exists for the object. A dead link that 404s is
  // worse than no link, so policies and credentials, which have no detail
  // route, simply do not get one.
  const href =
    selected.kind === 'resource'
      ? `/resources/${selected.id.replace(/^resource:/, '')}`
      : selected.kind === 'role'
        ? `/admin/roles/${selected.id.replace(/^role:/, '')}`
        : selected.kind === 'user'
          ? `/admin/identity/${selected.meta?.id || ''}`
          : null

  const facts =
    selected.kind === 'resource'
      ? [
          ['Type', selected.sublabel],
          ['Access', selected.badge],
          ['JIT gated', selected.meta?.requiresJit ? 'Yes' : 'No'],
          ['Always recorded', selected.meta?.alwaysRecord ? 'Yes' : 'No'],
          ['Active', selected.meta?.active ? 'Yes' : 'No'],
        ]
      : selected.kind === 'role'
        ? [
            ['Kind', selected.meta?.roleKind === 'user_type' ? 'User type' : 'Additional role'],
            ['Origin', selected.meta?.isSystem ? 'System' : 'Custom'],
            ['Policies', selected.childCount],
          ]
        : selected.kind === 'credential'
          ? [
              ['Type', selected.meta?.type || 'Secret'],
              ['Account', selected.meta?.account || 'Not recorded'],
            ]
          : []

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-secondary transition-colors hover:text-accent"
        >
          <ChevronLeft className="h-3.5 w-3.5 flex-none" strokeWidth={2} />
          Account overview
        </button>
      </div>

      <PanelSection>
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-line-soft bg-subtle text-tertiary">
            <Icon className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-bold text-primary">{selected.label}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs uppercase tracking-wide text-tertiary">
              <span>{KIND_LABEL[selected.kind] || selected.kind}</span>
              {selected.badge && (
                <span
                  className={clsx(
                    'font-semibold',
                    selected.tone === 'danger'
                      ? 'text-danger'
                      : selected.tone === 'warn'
                        ? 'text-warn'
                        : selected.tone === 'ok'
                          ? 'text-ok'
                          : 'text-accent'
                  )}
                >
                  {selected.badge}
                </span>
              )}
            </p>
          </div>
        </div>
        {href && (
          <Link
            to={href}
            className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-accent transition-colors hover:text-accent-hover hover:underline"
          >
            Open the full record
            <ArrowUpRight className="h-3.5 w-3.5 flex-none" strokeWidth={2} />
          </Link>
        )}
      </PanelSection>

      {path.length > 1 && (
        <PanelSection>
          <PanelLead icon={RouteIcon} eyebrow="Access path" title="How the account gets here" />
          <div className="mt-3">
            <AccessPath nodes={path} onSelect={onSelect} />
          </div>
        </PanelSection>
      )}

      {facts.length > 0 && (
        <PanelSection>
          <dl className="space-y-1.5">
            {facts.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-tertiary">{k}</dt>
                <dd className="text-xs font-medium text-primary">{v}</dd>
              </div>
            ))}
          </dl>
          {selected.meta?.standing && (
            <p className="mt-2.5 rounded-lg border border-warn/35 bg-warn-soft px-2.5 py-1.5 text-xs leading-relaxed text-primary">
              Standing access. Reachable right now, with nothing to request.
            </p>
          )}
          {selected.kind === 'credential' && (
            <p className="mt-2.5 rounded-lg border border-danger/35 bg-danger-soft px-2.5 py-1.5 text-xs leading-relaxed text-primary">
              A policy on this account can reveal this secret in plaintext.
            </p>
          )}
        </PanelSection>
      )}

      {(selected.kind === 'policy' || selected.kind === 'direct_policy') && (
        <PanelSection>
          <ChipList
            label="Actions"
            items={selected.meta?.actions}
            empty="None recorded"
            tone={String(selected.meta?.effect || '').toLowerCase() === 'deny' ? 'ok' : 'accent'}
          />
          <div className="mt-3">
            <ChipList
              label="Resource patterns"
              items={selected.meta?.patterns}
              empty="None. Matches nothing on its own."
            />
          </div>
        </PanelSection>
      )}

      {selected.meta?.description && (
        <PanelSection>
          <p className="text-xs leading-relaxed text-secondary">{selected.meta.description}</p>
        </PanelSection>
      )}

      <Definitions />
    </>
  )
}

function DetailPanel({ graph, tree, selected, onSelect, onClose }) {
  const stats = useMemo(() => summarise(tree), [tree])
  const user = graph?.user || {}

  return (
    <aside
      aria-label="Selected object details"
      className="flex h-full w-full flex-col overflow-y-auto border-l border-line bg-surface"
    >
      <div className="sticky top-0 z-10 border-b border-line-soft bg-surface px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-accent-soft text-sm font-bold text-accent">
            {(user.username || '?').slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-bold leading-tight text-primary">{user.username}</p>
            <p className="truncate text-xs text-tertiary">{user.full_name || user.email}</p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close panel"
              className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-hover hover:text-primary"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </button>
          )}
        </div>
        <div className="mt-2">
          <RiskChips stats={stats} user={user} />
        </div>
      </div>

      {selected ? (
        <SelectedView tree={tree} selected={selected} onSelect={onSelect} onBack={() => onSelect(null)} />
      ) : (
        <AccountView tree={tree} stats={stats} />
      )}

      {graph?.built_at && (
        <p className="mt-auto border-t border-line-soft px-4 py-2.5 text-2xs text-tertiary">
          Built {formatDateTime(graph.built_at)}
        </p>
      )}
    </aside>
  )
}

// ── Canvas ─────────────────────────────────────────────────────────────────

/** Minimap swatch colour. Same vocabulary as the cards, so the two agree. */
const MINIMAP_TONE = {
  accent: 'rgb(var(--accent))',
  ok: 'rgb(var(--ok))',
  warn: 'rgb(var(--warn))',
  danger: 'rgb(var(--danger))',
  muted: 'rgb(var(--border-strong))',
}

function Canvas({ tree, expanded, revealed, maxLevel, onToggle, onReveal, selectedId, onSelect, onFitRef }) {
  const { fitView } = useReactFlow()

  const nodes = useMemo(
    () => visibleNodes(tree, expanded, revealed, maxLevel),
    [tree, expanded, revealed, maxLevel]
  )
  const positions = useMemo(() => layout(nodes), [nodes])

  // The lit branch: root down to whatever is selected. Used to keep one path
  // at full strength while the rest recedes.
  const lit = useMemo(() => new Set(selectedId ? pathToRoot(tree, selectedId) : []), [tree, selectedId])

  const rfNodes = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: 'identity',
        position: positions.get(n.id) || { x: 0, y: 0 },
        // DECLARED, NOT MEASURED, and the minimap is why.
        //
        // This page rebuilds the node array from the tree on every change
        // rather than driving it through applyNodeChanges, so React Flow never
        // writes its measurements back onto these objects. The canvas does not
        // care, because it measures the real DOM, but MiniMap reads the node
        // it was HANDED and skips any without dimensions, which is how it came
        // out as an empty grey rectangle. The layout already knows both sizes
        // exactly, so stating them fixes the minimap and saves a measure pass.
        width: isMoreNode(n) ? MORE_W : NODE_W,
        height: isMoreNode(n) ? MORE_H : NODE_H,
        draggable: false,
        selectable: true,
        data: {
          ...n,
          selected: n.id === selectedId,
          // A "more" card inherits its parent's lit state: it stands in for
          // that parent's children, so dimming it while the branch is lit
          // would hide the one control that finishes reading the branch.
          onLit: lit.has(n.id) || (isMoreNode(n) && lit.has(n.parentOf)),
          dimmed: lit.size > 0 && !lit.has(n.id) && !(isMoreNode(n) && lit.has(n.parentOf)),
        },
      })),
    [nodes, positions, selectedId, lit]
  )

  const rfEdges = useMemo(
    () =>
      nodes
        .filter((n) => n.parentId)
        .map((n) => {
          const onPath = lit.has(n.id) && lit.has(n.parentId)
          return {
            id: `${n.parentId}->${n.id}`,
            source: n.parentId,
            target: n.id,
            // CURVES, NOT ELBOWS.
            //
            // Orthogonal routing looks tidy on a flowchart with two boxes and
            // wrong on a fan: fifteen smoothstep edges leaving one policy stack
            // into a vertical trunk with fifteen identical right angles hanging
            // off it, which reads as plumbing and eats a column's worth of
            // horizontal space to make room for the turns. A bezier leaves the
            // parent and heads for its target, so a fan looks like a fan, the
            // gap between columns can shrink, and the eye can follow one strand
            // out of fifteen because no two of them share a run.
            type: 'default',
            // The relation, named, and only where it is being read. An
            // attack-path view earns its edges by saying what each one IS
            // ("member of", "allows", "reaches"); labelling all forty at once
            // would bury the picture in captions, so only the lit branch,
            // which is the one the reader is following, carries them.
            label: onPath && !isMoreNode(n) ? relationInto(n) : undefined,
            labelBgPadding: [6, 2],
            labelBgBorderRadius: 4,
            labelBgStyle: { fill: 'rgb(var(--bg-surface))', fillOpacity: 0.95 },
            labelStyle: {
              fill: 'rgb(var(--accent))',
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            },
            // Only the lit branch animates. Animating every edge is how a
            // canvas turns into a screensaver: motion stops meaning anything
            // once it is everywhere.
            animated: onPath,
            style: {
              stroke: onPath ? 'rgb(var(--accent))' : 'rgb(var(--border))',
              strokeWidth: onPath ? 2 : 1.25,
              strokeDasharray: onPath ? '6 5' : undefined,
              opacity: lit.size > 0 && !onPath ? 0.3 : 1,
              transition: 'stroke 200ms ease, opacity 200ms ease',
            },
          }
        }),
    [nodes, lit]
  )

  // Refit when the visible set changes, so opening a branch never leaves the
  // new cards off screen. Deferred a frame so React Flow measures first.
  //
  // minZoom MATTERS HERE. A policy can match forty resources, and fitting a
  // column that tall to the viewport shrinks every card until the labels are
  // grey smears, which defeats the point of opening the branch at all. The
  // floor keeps the cards readable and lets a long column overflow instead;
  // readable-and-pannable beats complete-and-illegible, and that overflow is
  // exactly what the minimap is there to make navigable.
  const fit = useCallback(
    () => fitView({ duration: 450, padding: 0.16, minZoom: 0.55, maxZoom: 1 }),
    [fitView]
  )

  const count = rfNodes.length
  useEffect(() => {
    const t = setTimeout(fit, 80)
    return () => clearTimeout(t)
  }, [count, fit])

  // AND WHENEVER THE CANVAS ITSELF CHANGES SIZE.
  //
  // The node-count effect alone is not enough, because the container resizes
  // for reasons the node count knows nothing about: the detail panel opening,
  // the account rail collapsing, full screen, a window drag. Each of those
  // used to leave the graph fitted to a viewport that no longer exists, which
  // is how the last column ended up half under the panel. A ResizeObserver
  // catches all of them with one rule instead of a special case each.
  const wrapRef = useRef(null)
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [fit])

  // Hand the fit control up so the toolbar's own button drives the same code
  // path the automatic refit uses, rather than a second implementation of it.
  useEffect(() => {
    if (onFitRef) onFitRef.current = fit
  }, [onFitRef, fit])

  const levelCounts = useMemo(() => {
    const c = [0, 0, 0, 0]
    // "more" cards are chrome, not objects, so they are not counted as one.
    for (const n of nodes) if (!isMoreNode(n)) c[n.level] = (c[n.level] || 0) + 1
    return c
  }, [nodes])

  // SELECTING AND EXPANDING ARE DIFFERENT CLICKS.
  //
  // They used to be the same one, which meant a reader could not read a role
  // in the panel without also opening it on the canvas, and could not close it
  // again without throwing the panel away. The card's footer carries
  // data-expand; everything else selects.
  const handleNodeClick = useCallback(
    (event, node) => {
      const model = nodes.find((n) => n.id === node.id)
      if (!model) return
      // A "more" card is a control, not an object. Selecting it would light a
      // branch that ends in a button and put nothing worth reading in the
      // panel, so it only ever reveals.
      if (isMoreNode(model)) {
        onReveal(model.parentOf)
        return
      }
      if (event.target?.closest?.('[data-expand]')) {
        onToggle(node.id)
        return
      }
      onSelect(node.id)
    },
    [nodes, onSelect, onToggle, onReveal]
  )

  return (
    <div className="flex h-full flex-col">
      <ColumnHeaders counts={levelCounts} />
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
          onPaneClick={() => onSelect(null)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          maxZoom={1.6}
          defaultEdgeOptions={{ type: 'default' }}
          fitView
          fitViewOptions={{ padding: 0.16, minZoom: 0.55, maxZoom: 1 }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="opacity-50" />
          <Controls
            showInteractive={false}
            position="bottom-left"
            className="!rounded-lg !border !border-line-soft !bg-surface !shadow-card"
          />
          {/* THE MINIMAP EARNS ITS PLACE NOW, WHICH IT DID NOT BEFORE.
            It was cut in the first pass because progressive disclosure meant
            the scene never exceeded the viewport, so it rendered as an empty
            grey rectangle. A branch opened to fifteen resources at a readable
            zoom does exceed it, and then an overview is the difference
            between panning blind and panning to something. So it appears only
            when there is actually something off screen to find. */}
          {count > 12 && (
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              ariaLabel="Graph overview"
              className="!rounded-lg !border !border-line-soft !bg-surface !shadow-card"
              maskColor="rgb(var(--bg-app) / 0.72)"
              nodeStrokeWidth={0}
              nodeBorderRadius={3}
              nodeColor={(n) => MINIMAP_TONE[n.data?.tone] || MINIMAP_TONE.muted}
            />
          )}
        </ReactFlow>
      </div>
    </div>
  )
}

// ── Account rail ───────────────────────────────────────────────────────────
//
// The account picker was a native <select> beside a search box that did not
// visibly do anything: you typed, the dropdown quietly re-populated, and you
// still had to open it to find out what you had matched. Typing into a search
// field should narrow a list you can see.
//
// So the two controls are one control. The field filters the list underneath
// it as each character lands, and the list carries the things you pick an
// account BY: whether it is active, whether MFA is on it, what it is called in
// full. That is the same shape Okta's people list and the AWS console's
// resource pickers use, for the same reason.
function AccountRail({ query, onQuery, users, loading, error, activeId, onPick, onClose }) {
  return (
    <nav
      aria-label="Accounts"
      className="flex h-full w-full flex-col border-r border-line bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-tertiary">Accounts</span>
        {typeof users?.length === 'number' && !loading && (
          <span className="tabular text-2xs font-semibold text-secondary">{users.length}</span>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide the account list"
            className="ml-auto flex h-6 w-6 flex-none items-center justify-center rounded text-tertiary transition-colors hover:bg-hover hover:text-primary"
          >
            <PanelLeftClose className="h-4 w-4" strokeWidth={1.8} />
          </button>
        )}
      </div>

      <div className="border-b border-line-soft p-2.5">
        <label className="relative flex items-center">
          <Search
            className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-tertiary"
            strokeWidth={1.8}
          />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Filter by name or email"
            aria-label="Filter accounts"
            className="h-8 w-full rounded-lg border border-line-strong bg-surface pl-8 pr-7 text-sm text-primary transition-colors placeholder:text-tertiary hover:border-primary/40 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQuery('')}
              aria-label="Clear the filter"
              className="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-tertiary transition-colors hover:bg-hover hover:text-primary"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          )}
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading ? (
          <p className="px-2 py-3 text-xs text-tertiary">Loading accounts</p>
        ) : error ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-warn">{error}</p>
        ) : users.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-tertiary">
            {query ? `No account matches "${query}".` : 'No accounts to show.'}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {users.map((u) => {
              const active = u.user_id === activeId
              return (
                <li key={u.user_id}>
                  <button
                    type="button"
                    onClick={() => onPick(u.user_id)}
                    aria-current={active ? 'true' : undefined}
                    className={clsx(
                      'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                      active ? 'bg-accent-soft' : 'hover:bg-hover'
                    )}
                  >
                    <span
                      className={clsx(
                        'flex h-7 w-7 flex-none items-center justify-center rounded-lg text-2xs font-bold',
                        active ? 'bg-accent text-accent-on' : 'bg-subtle text-tertiary'
                      )}
                    >
                      {(u.username || '?').slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={clsx(
                          'block truncate text-sm font-medium',
                          active ? 'text-accent' : 'text-primary'
                        )}
                      >
                        {u.username}
                      </span>
                      <span className="block truncate text-2xs text-tertiary">{u.full_name || u.email}</span>
                    </span>
                    {/* The two facts worth carrying at this size. A dormant or
                        locked account and an account with no MFA are both
                        reasons to look at it, and both are invisible once you
                        are inside the graph. */}
                    <span className="flex flex-none items-center gap-1">
                      {!u.mfa_enabled && (
                        <ShieldOff
                          className="h-3.5 w-3.5 text-danger"
                          strokeWidth={1.9}
                          aria-label="MFA not enrolled"
                        />
                      )}
                      {u.status && u.status !== 'ACTIVE' && (
                        <span className="rounded bg-subtle px-1 py-0.5 text-2xs font-semibold uppercase tracking-wide text-tertiary">
                          {u.status}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </nav>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function IdentityGraphPage() {
  const [params, setParams] = useSearchParams()
  const userId = params.get('user') || ''

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(new Set())
  // How many children of each opened parent have been asked for. Absent means
  // the first batch; see REVEAL_BATCH.
  const [revealed, setRevealed] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [listOpen, setListOpen] = useState(() => !userId)
  const [full, setFull] = useState(false)
  // How deep the canvas may go, and which objects it may draw. Both narrow the
  // TREE rather than greying things out on it, so every count on the page keeps
  // describing the same graph.
  // DEPTH AND ACCESS LIVE IN THE URL, and that is not tidiness either.
  //
  // "Look at what l.fernandes can reach with no request" is a thing one
  // administrator sends another, and a console that cannot put that in a link
  // makes them send a screenshot and a sentence of instructions instead. Every
  // analysis surface worth the name encodes its view in the address bar, so
  // these two do. The object-kind toggles stay local: they are a scratch cut
  // rather than a finding, and putting six of them in the query string would
  // make every link unreadable for no gain.
  const depth = Number(params.get('depth')) || 3
  const exposure = params.get('access') || 'all'
  const [kindFilters, setKindFilters] = useState({
    kinds: DEFAULT_FILTERS.kinds,
    jitOnly: false,
    recordedOnly: false,
  })

  const filters = useMemo(() => ({ ...kindFilters, exposure }), [kindFilters, exposure])

  const patchParams = useCallback(
    (patch) => {
      const next = new URLSearchParams(params)
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') next.delete(k)
        else next.set(k, String(v))
      }
      setParams(next, { replace: true })
    },
    [params, setParams]
  )

  const setDepth = useCallback((d) => patchParams({ depth: d === 3 ? null : d }), [patchParams])
  const setExposure = useCallback((e) => patchParams({ access: e === 'all' ? null : e }), [patchParams])
  const fitRef = useRef(null)

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  const usersQuery = useQuery({
    queryKey: ['admin', 'users', search],
    queryFn: ({ signal }) => listUsers(search || undefined, signal),
  })

  // TWO FILTERS, ON PURPOSE. The server query is what makes this work on an
  // org with ten thousand accounts, but it is debounced, so on its own the
  // list would visibly lag a keystroke behind the field. Filtering the loaded
  // page again on the raw input makes every character narrow the list
  // immediately, and the server result then widens it to anything the loaded
  // page did not contain.
  const users = useMemo(() => {
    const all = usersQuery.data?.users || []
    const needle = searchInput.trim().toLowerCase()
    if (!needle) return all
    return all.filter((u) =>
      [u.username, u.email, u.full_name].some((v) =>
        String(v || '')
          .toLowerCase()
          .includes(needle)
      )
    )
  }, [usersQuery.data, searchInput])

  const graphQuery = useQuery({
    queryKey: ['admin', 'identity', userId, 'graph'],
    queryFn: ({ signal }) => getMemberGraph(userId, signal),
    enabled: !!userId,
  })

  const fullTree = useMemo(() => buildTree(graphQuery.data), [graphQuery.data])

  // The filtered tree is what the canvas draws; the full one is what the panel
  // summarises. Keeping them apart is deliberate: "what does this account
  // reach" does not change because the reader narrowed the picture, and a
  // panel that silently re-counted itself every time a filter moved would be
  // reporting the filter rather than the account.
  const tree = useMemo(() => filterTree(fullTree, filters), [fullTree, filters])
  const filtering = !filtersAreDefault(filters)

  // Open the account's own row on arrival, so the canvas never lands on a
  // single card with nothing to look at. Re-runs when a filter re-cuts the
  // tree, because a branch opened under the old cut may not exist under the
  // new one and a stale expansion set would leave the canvas half drawn.
  useEffect(() => {
    if (tree) {
      setExpanded(new Set([tree.id]))
      setRevealed({})
      setSelectedId(null)
    }
  }, [tree])

  const toggle = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        // Collapsing a branch closes everything under it too, otherwise
        // reopening later restores a shape the reader never chose.
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
    // And it forgets how far that branch had been revealed, for the same
    // reason: reopening starts at the first ten again rather than at whatever
    // was on screen when it was closed.
    setRevealed((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const reveal = useCallback((parentId) => {
    setRevealed((prev) => ({ ...prev, [parentId]: (prev[parentId] ?? REVEAL_INITIAL) + REVEAL_STEP }))
  }, [])

  const selectUser = (id) => {
    const next = new URLSearchParams(params)
    if (id) next.set('user', id)
    else next.delete('user')
    setParams(next, { replace: true })
  }

  const visible = useMemo(
    () => visibleNodes(tree, expanded, revealed, depth),
    [tree, expanded, revealed, depth]
  )

  const selected = useMemo(
    () => (selectedId ? visible.find((n) => n.id === selectedId) || null : null),
    [selectedId, visible]
  )

  // What the canvas is drawing against what exists. "more" cards are chrome,
  // so they are not counted as objects.
  const shownObjects = visible.filter((n) => !isMoreNode(n)).length
  // Measured against the FILTERED tree when a filter is on ("12 of 12 objects
  // match") and against the whole account otherwise, because those are two
  // different questions and one number cannot answer both.
  const totalObjects = tree ? subtreeCount(tree) + 1 : 0

  const resetView = () => {
    if (tree) setExpanded(new Set([tree.id]))
    setRevealed({})
    setSelectedId(null)
    patchParams({ depth: null, access: null })
    setKindFilters({ kinds: DEFAULT_FILTERS.kinds, jitOnly: false, recordedOnly: false })
  }

  const toggleKind = (key) =>
    setKindFilters((f) => {
      const on = f.kinds.includes(key)
      // Never let the last kind be switched off: an empty canvas with no
      // explanation is a worse answer than a full one.
      if (on && f.kinds.length === 1) return f
      return { ...f, kinds: on ? f.kinds.filter((k) => k !== key) : [...f.kinds, key] }
    })

  const clearFilters = () => {
    setKindFilters({ kinds: DEFAULT_FILTERS.kinds, jitOnly: false, recordedOnly: false })
    setExposure('all')
  }

  const expandAll = () => {
    if (!tree) return
    // Deliberately bounded: opening every level of a hundred-node account is
    // the hairball this page exists to avoid. Two levels is the most that
    // stays readable, and the reader can go deeper by hand from there.
    const next = new Set([tree.id])
    for (const g of tree.children || []) next.add(g.id)
    setExpanded(next)
    setRevealed({})
  }

  // Escape leaves full view, then clears the selection. Anything that takes
  // over the whole screen has to have an exit that does not require finding a
  // button first.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (full) setFull(false)
      else if (selectedId) setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full, selectedId])

  // Full view hides the page behind it, so the page must not keep scrolling
  // underneath while it is up.
  useEffect(() => {
    if (!full) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [full])

  const err = graphQuery.isError ? normalizeApiError(graphQuery.error) : null
  const activeUser = users.find((u) => u.user_id === userId) || graphQuery.data?.user || null

  const depthLabel = DEPTH_OPTIONS.find((d) => d.key === depth)?.label || 'Everything'
  const exposureLabel = EXPOSURE_FILTERS.find((e) => e.key === filters.exposure)?.label || 'All access'
  const filterCount = activeFilterCount(filters)

  // THE CONTROL BAR.
  //
  // What was missing was not decoration: an analysis canvas that offers no way
  // to say "only two levels", "only standing access" or "hide the credentials"
  // makes the reader do all the narrowing with their eyes. Three chips and
  // three icon actions, and every one of them reads a field the API actually
  // sends. Nothing here is a score or a rating.
  const toolbar = (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line-soft bg-surface px-2.5 py-2">
      {!listOpen && (
        <IconAction icon={PanelLeftOpen} label="Show the account list" onClick={() => setListOpen(true)} />
      )}
      <span className="min-w-0 truncate px-1 text-sm font-bold text-primary">
        {activeUser ? activeUser.username : 'No account selected'}
      </span>
      {activeUser?.full_name && (
        <span className="hidden min-w-0 truncate text-xs text-tertiary xl:inline">
          {activeUser.full_name}
        </span>
      )}
      {tree && <ShowingPill shown={shownObjects} total={totalObjects} filtered={filtering} />}

      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        {/* DEPTH. The graph is four levels by construction, so this is a real
            dimension and not a slider over nothing: stopping at Grants answers
            "what is this account made of", stopping at Policies answers "what
            do those grants say", and Everything answers "what does it touch". */}
        <Menu
          align="right"
          width="w-56"
          label="Canvas depth"
          trigger={(open) => <ControlChip label="Depth" value={depthLabel} open={open} />}
        >
          <MenuLabel>Draw down to</MenuLabel>
          {DEPTH_OPTIONS.map((d) => (
            <MenuItem
              key={d.key}
              checked={depth === d.key}
              keepOpen
              onClick={() => setDepth(d.key)}
              hint={`${d.key + 1} levels`}
            >
              {d.label}
            </MenuItem>
          ))}
        </Menu>

        {/* EXPOSURE. Narrows the reach column and prunes every branch that no
            longer leads to one, which turns the canvas into an answer:
            "standing only" draws exactly the grants that hand this account
            access it never has to ask for. */}
        <Menu
          align="right"
          width="w-60"
          label="Exposure"
          trigger={(open) => <ControlChip label="Access" value={exposureLabel} open={open} />}
        >
          <MenuLabel>Show reach that is</MenuLabel>
          {EXPOSURE_FILTERS.map((e) => (
            <MenuItem
              key={e.key}
              checked={filters.exposure === e.key}
              keepOpen
              onClick={() => setExposure(e.key)}
            >
              {e.label}
            </MenuItem>
          ))}
          <MenuDivider />
          <MenuNote>Branches that stop leading anywhere are removed, not greyed out.</MenuNote>
        </Menu>

        <Menu
          align="right"
          width="w-64"
          label="Filters"
          trigger={(open) => (
            <ControlChip
              label="Filters"
              value={filterCount > 0 ? 'On' : 'Off'}
              open={open}
              count={filterCount}
            />
          )}
        >
          <MenuLabel>Object kinds</MenuLabel>
          {KIND_FILTERS.map((k) => (
            <MenuItem
              key={k.key}
              checked={filters.kinds.includes(k.key)}
              keepOpen
              onClick={() => toggleKind(k.key)}
            >
              {k.label}
            </MenuItem>
          ))}
          <MenuDivider />
          <MenuLabel>Resource controls</MenuLabel>
          <MenuItem
            checked={filters.jitOnly}
            keepOpen
            onClick={() => setKindFilters((f) => ({ ...f, jitOnly: !f.jitOnly }))}
          >
            Requires a JIT request
          </MenuItem>
          <MenuItem
            checked={filters.recordedOnly}
            keepOpen
            onClick={() => setKindFilters((f) => ({ ...f, recordedOnly: !f.recordedOnly }))}
          >
            Always recorded
          </MenuItem>
          {filterCount > 0 && (
            <>
              <MenuDivider />
              <MenuItem onClick={clearFilters}>Clear all filters</MenuItem>
            </>
          )}
        </Menu>

        {/* The icon actions stay together when the bar wraps. Letting them
            break across two rows split one group of related controls into two
            unrelated-looking ones. */}
        <span className="flex flex-none items-center gap-1.5">
          <span className="mx-0.5 hidden h-5 w-px bg-line sm:block" aria-hidden="true" />

          <IconAction
            icon={Focus}
            label="Fit the graph to the view"
            disabled={!tree}
            onClick={() => fitRef.current?.()}
          />
          <IconAction icon={Network} label="Open every grant" disabled={!tree} onClick={expandAll} />
          <IconAction
            icon={RotateCcw}
            label="Reset the view, depth and filters"
            disabled={!tree}
            onClick={resetView}
          />
          {!panelOpen && (
            <IconAction
              icon={PanelRightOpen}
              label="Show the detail panel"
              onClick={() => setPanelOpen(true)}
            />
          )}
          <IconAction
            icon={full ? Minimize2 : Maximize2}
            label={full ? 'Exit full screen' : 'Full screen'}
            active={full}
            disabled={!tree}
            onClick={() => setFull((v) => !v)}
          />
        </span>
      </span>
    </div>
  )

  const body = !userId ? (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        icon={UserRound}
        title="Choose an account"
        description="Pick an account from the list to see how it is assembled: its user type, the roles and policies attached to it, and the resources and credentials those actually reach."
      />
    </div>
  ) : graphQuery.isLoading ? (
    <div className="flex h-full items-center justify-center gap-3 text-sm text-secondary">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
      Building the identity graph
    </div>
  ) : err ? (
    <div className="flex h-full items-center justify-center p-6">
      {err.status === 403 ? (
        <DeniedState description={err.message} />
      ) : err.code === 'network_error' ? (
        <OfflineState onRetry={() => graphQuery.refetch()} retrying={graphQuery.isFetching} />
      ) : (
        <ErrorState
          description={apiErrorMessage(graphQuery.error)}
          onRetry={() => graphQuery.refetch()}
          retrying={graphQuery.isFetching}
        />
      )}
    </div>
  ) : !fullTree ? (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        icon={Layers}
        title="Nothing to graph"
        description="This account holds no roles or policies, so there is no structure to draw."
      />
    </div>
  ) : !tree || (tree.children || []).length === 0 ? (
    // Filtering to nothing is a legitimate answer, and often the useful one:
    // "no standing access on this account" is exactly what a reviewer wants to
    // hear. It just has to say so rather than showing a blank canvas.
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        icon={SlidersHorizontal}
        title={filtering ? 'Nothing matches these filters' : 'Nothing to graph'}
        description={
          filtering
            ? 'No object on this account matches the current access filter. That is a finding, not an error.'
            : 'This account holds no roles or policies, so there is no structure to draw.'
        }
        action={
          filtering && (
            <Button variant="secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          )
        }
      />
    </div>
  ) : (
    <>
      <div className="relative min-w-0 flex-1">
        <ReactFlowProvider>
          <Canvas
            tree={tree}
            expanded={expanded}
            revealed={revealed}
            maxLevel={depth}
            onToggle={toggle}
            onReveal={reveal}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onFitRef={fitRef}
          />
        </ReactFlowProvider>
      </div>
      {panelOpen && (
        <div className={clsx('hidden flex-none lg:block', full ? 'w-[23rem]' : 'w-[21rem]')}>
          <DetailPanel
            graph={graphQuery.data}
            tree={fullTree}
            selected={selected}
            onSelect={setSelectedId}
            onClose={() => setPanelOpen(false)}
          />
        </div>
      )}
    </>
  )

  const shell = (
    <div
      className={clsx(
        'flex flex-col overflow-hidden bg-app',
        // FULL SCREEN MEANS FULL SCREEN. The previous version inset itself by
        // twelve pixels and started below the navbar, which is a bigger panel
        // rather than a different mode: the reader still lost a strip of
        // canvas to chrome they had explicitly asked to get out of the way.
        // This covers the viewport, and because the toolbar and both rails
        // live INSIDE the shell, nothing is left behind when it does.
        full
          ? 'fixed inset-0 z-[70] h-screen w-screen'
          : 'h-[calc(100vh-16rem)] min-h-[32rem] rounded-2xl border border-line'
      )}
    >
      {toolbar}
      <div className="flex min-h-0 flex-1">
        {listOpen && (
          <div className="hidden w-[15.5rem] flex-none md:block">
            <AccountRail
              query={searchInput}
              onQuery={setSearchInput}
              users={users}
              loading={usersQuery.isLoading}
              error={usersQuery.isError ? apiErrorMessage(usersQuery.error) : null}
              activeId={userId}
              onPick={selectUser}
              onClose={() => setListOpen(false)}
            />
          </div>
        )}
        <div className="flex min-w-0 flex-1">{body}</div>
      </div>
    </div>
  )

  return (
    <Stack gap="lg">
      <PageTitle
        title="Identity graph"
        description="How one account is assembled, and everything it can reach. Open one branch at a time: each card reports what sits underneath it, and a branch that runs wide opens six at a time."
      />
      {/* IN FULL SCREEN THE SHELL LEAVES THE DOCUMENT FLOW ENTIRELY.
          Not for tidiness: `fixed inset-0` inside Stack was landing 24px down
          the page, because Stack spaces its children with `space-y`, which is
          a top MARGIN on every child after the first, and a margin still
          offsets a fixed element from its inset. The result was a strip of
          navbar showing above a view whose entire purpose is to have nothing
          above it. A portal onto document.body has no such parent, and it
          keeps working whatever this page is later nested inside.

          A placeholder keeps its slot so the page does not jump when full
          screen closes. */}
      {full ? (
        <>
          <div className="h-[calc(100vh-16rem)] min-h-[32rem]" aria-hidden="true" />
          {createPortal(shell, document.body)}
        </>
      ) : (
        shell
      )}
    </Stack>
  )
}
