import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import {
  ChevronRight,
  Database,
  FileKey2,
  KeyRound,
  Layers,
  Lock,
  Plus,
  ShieldCheck,
  Sparkles,
  UserRound,
  Video,
} from 'lucide-react'
import clsx from 'clsx'
import { MORE_W, MORE_H, NODE_W, NODE_H } from '../../lib/identityGraph'

// ---------------------------------------------------------------------------
// One card on the identity canvas
// ---------------------------------------------------------------------------
// THREE BANDS INSIDE ONE RECTANGLE, AND ALWAYS THE SAME THREE.
//
//   STATE    22px. What this object IS and how exposed it is: a tinted strip
//            carrying the state in words, the controls on it as glyphs, and a
//            dot. The only tinted surface on the card.
//   BODY     40px. Icon tile, name, one qualifying line.
//   FOOTER   24px. How much is folded underneath, and the control that opens
//            it.
//
// The earlier version hung the state label ABOVE the card as a floating tab,
// which gave every column a ragged top edge and made the label read as a
// separate object rather than as part of the card. One rectangle with banded
// fills is the shape enterprise consoles converge on for a reason: it is the
// same container Cloudscape, Linear and Vercel use, the bands never move, and
// forty of them read as one structure instead of forty differently shaped
// things.
//
// Colour is spent once. The state strip carries the tone; everything else is
// surface, hairline and text. A canvas of forty cards should read as a
// structure, not as forty alerts.
//
// EXPANDING IS NOT SELECTING. They used to be the same click, which meant a
// reader could not look at a role without also opening it, and could not close
// it again without losing the panel. The footer carries data-expand;
// everything else selects.

const KIND_ICON = {
  user: UserRound,
  role: ShieldCheck,
  policy: FileKey2,
  direct_policy: FileKey2,
  resource: Database,
  credential: KeyRound,
  capability: Sparkles,
}

// Tinted strip, dot, and the text on it. One entry per tone so the three can
// never drift apart.
const TONE = {
  accent: { strip: 'bg-accent-soft', text: 'text-accent', dot: 'bg-accent' },
  ok: { strip: 'bg-ok-soft', text: 'text-ok', dot: 'bg-ok' },
  warn: { strip: 'bg-warn-soft', text: 'text-warn', dot: 'bg-warn' },
  danger: { strip: 'bg-danger-soft', text: 'text-danger', dot: 'bg-danger' },
  muted: { strip: 'bg-subtle', text: 'text-tertiary', dot: 'bg-line-strong' },
}

/**
 * The words on the state strip.
 *
 * Every one comes off a field the API actually sends. Nothing here is a score,
 * a rating or a guess: an object either is a secret this account can reveal or
 * it is not, and the strip says which.
 */
function stateLabel(data) {
  const { kind, meta, badge } = data
  switch (kind) {
    case 'user':
      return 'Account'
    case 'role':
      return meta?.roleKind === 'user_type' ? 'User type' : 'Role'
    case 'direct_policy':
      return 'Direct policy'
    case 'policy':
      return String(meta?.effect || '').toLowerCase() === 'deny' ? 'Deny policy' : 'Policy'
    case 'credential':
      return 'Revealable secret'
    case 'resource':
      if (meta?.access === 'all') return 'Full access'
      if (meta?.standing) return 'Standing access'
      if (meta?.requiresJit) return 'JIT gated'
      return badge || 'Resource'
    default:
      return badge || 'Object'
  }
}

// The stand-in for a parent's hidden children.
//
// A PILL, NOT A CARD, AND THE SIZE IS THE POINT. This was drawn at full card
// size, which made it the seventh object in a column of six: a reader scanning
// the fan had to read one of them to discover it was a button. Every graph
// product that handles collapsed siblings well makes the marker unmistakably
// smaller than the thing it stands for, so the two cannot be confused at a
// glance or at a distance.
function MorePill({ data }) {
  const { hiddenCount, nextCount, dimmed } = data
  return (
    <button
      type="button"
      style={{ width: MORE_W, height: MORE_H }}
      className={clsx(
        'group flex cursor-pointer items-center justify-center gap-1 rounded-full border border-dashed border-line-strong bg-surface transition-all duration-150',
        'hover:border-accent hover:bg-accent-soft hover:shadow-card',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        dimmed ? 'opacity-40' : 'opacity-100'
      )}
      title={`${hiddenCount} more hidden, shows ${nextCount} at a time`}
      aria-label={`Show ${nextCount} more of the ${hiddenCount} still hidden`}
    >
      <Plus
        className="h-3 w-3 flex-none text-tertiary transition-colors group-hover:text-accent"
        strokeWidth={2.6}
      />
      <span className="text-xs font-bold text-secondary transition-colors group-hover:text-accent">
        <span className="tabular">{hiddenCount}</span> more
      </span>
      <Handle type="target" position={Position.Left} className="!h-1 !w-1 !border-0 !bg-transparent" />
    </button>
  )
}

function ObjectCard({ data }) {
  const {
    kind,
    label,
    sublabel,
    tone = 'muted',
    meta,
    childCount = 0,
    subtreeCount = 0,
    isExpanded,
    isLeaf,
    atDepthLimit,
    selected,
    onLit,
    dimmed,
  } = data

  const Icon = KIND_ICON[kind] || Layers
  const t = TONE[tone] || TONE.muted

  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      className={clsx(
        'group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-surface text-left transition-all duration-200',
        // Three resting states, deliberately different in STRUCTURE rather than
        // only in colour: the selected card gets a ring, a card on the lit
        // branch keeps a solid border and a lift, everything else recedes.
        selected
          ? 'border-accent shadow-pop ring-2 ring-accent/30'
          : onLit
            ? 'border-line shadow-card'
            : 'border-line-soft',
        !isLeaf && !selected && 'hover:border-line hover:shadow-pop',
        dimmed ? 'opacity-35 saturate-[0.6]' : 'opacity-100'
      )}
    >
      {/* ---- state ------------------------------------------------------ */}
      <div
        className={clsx(
          'flex h-[22px] flex-none items-center gap-1.5 border-b border-line-soft px-2.5',
          t.strip
        )}
      >
        <span className={clsx('h-1.5 w-1.5 flex-none rounded-full', t.dot)} aria-hidden="true" />
        <span
          className={clsx(
            'min-w-0 flex-1 truncate text-2xs font-bold uppercase leading-none tracking-[0.07em]',
            t.text
          )}
        >
          {stateLabel(data)}
        </span>
        {/* The two controls a PAM reader looks for on a resource, as glyphs
            rather than words: is it gated, and is it always recorded. */}
        {meta?.requiresJit && (
          <Lock className="h-3 w-3 flex-none opacity-70" strokeWidth={2.2} aria-label="Requires a JIT request" />
        )}
        {meta?.alwaysRecord && (
          <Video className="h-3 w-3 flex-none opacity-70" strokeWidth={2.2} aria-label="Always recorded" />
        )}
      </div>

      {/* ---- body ------------------------------------------------------- */}
      {/* The body selects. It gets its own hover so a reader can tell the two
          halves of the card do different things before they click one. */}
      <div className="flex min-h-0 flex-1 items-center gap-2 px-2.5 transition-colors hover:bg-hover">
        <span
          className={clsx(
            'flex h-7 w-7 flex-none items-center justify-center rounded-md border transition-colors',
            selected
              ? 'border-accent/40 bg-accent-soft text-accent'
              : 'border-line-soft bg-subtle text-tertiary'
          )}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-bold leading-tight text-primary" title={label}>
            {label}
          </span>
          {sublabel && (
            <span
              className="mt-px block truncate text-2xs leading-tight text-tertiary"
              title={sublabel}
            >
              {sublabel}
            </span>
          )}
        </span>
      </div>

      {/* ---- footer ----------------------------------------------------- */}
      {/* Only exists when there is something underneath. A leaf card has no
          affordance to press, so it does not grow one. */}
      {!isLeaf && (
        // A BUTTON, NOT A DIV. It is the control that opens the branch, so it
        // has to be reachable by keyboard and announce itself. The click still
        // reaches React Flow's onNodeClick by bubbling, which is what keeps the
        // "footer expands, body selects" split working for mouse and keyboard
        // through the same code path.
        <button
          type="button"
          tabIndex={atDepthLimit ? -1 : 0}
          disabled={atDepthLimit}
          data-expand={atDepthLimit ? undefined : 'true'}
          aria-label={
            atDepthLimit
              ? `${subtreeCount} below, past the current depth limit`
              : isExpanded
                ? `Collapse ${label}`
                : `Open ${childCount} under ${label}`
          }
          className={clsx(
            'flex h-6 w-full flex-none items-center justify-between gap-2 border-t border-line-soft px-2.5 text-left transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
            atDepthLimit ? 'cursor-default bg-subtle/40' : 'bg-subtle/60 hover:bg-accent-soft'
          )}
        >
          <span className="pointer-events-none flex items-center gap-1 text-2xs text-tertiary">
            <Layers className="h-2.5 w-2.5 flex-none" strokeWidth={2.2} aria-hidden="true" />
            <span className="tabular font-bold text-secondary">{subtreeCount}</span> below
          </span>
          {atDepthLimit ? (
            <span className="pointer-events-none text-2xs font-bold uppercase tracking-wide text-tertiary">
              Past depth
            </span>
          ) : (
            <span
              className={clsx(
                'pointer-events-none flex items-center gap-0.5 text-2xs font-bold uppercase tracking-wide transition-colors',
                isExpanded ? 'text-accent' : 'text-tertiary group-hover:text-accent'
              )}
            >
              {isExpanded ? 'Collapse' : `Open ${childCount}`}
              <ChevronRight
                className={clsx('h-3 w-3 transition-transform duration-200', isExpanded && 'rotate-90')}
                strokeWidth={2.6}
              />
            </span>
          )}
        </button>
      )}

      {/* Handles are visually silent: the edge should appear to touch the card,
          not to plug into a port. */}
      <Handle type="target" position={Position.Left} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <Handle type="source" position={Position.Right} className="!h-1 !w-1 !border-0 !bg-transparent" />
    </div>
  )
}

function GraphNodeCard({ data }) {
  if (data.kind === 'more') return <MorePill data={data} />
  return <ObjectCard data={data} />
}

export default memo(GraphNodeCard)
