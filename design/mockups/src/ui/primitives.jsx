import clsx from 'clsx'
import { forwardRef } from 'react'
import { Link } from 'react-router-dom'

// ---------------------------------------------------------------------------
// Phase 4 primitives.
// ---------------------------------------------------------------------------
// The rules these encode, so they can't drift:
//   • Elevation default is NOTHING. No shadows on buttons, containers or rails.
//   • Accent (blue) appears on: primary button, active nav, link, focus ring.
//   • Two weights: normal / semibold.
//   • Spacing snaps to the 4px scale defined in tailwind.config.js.

// ── Button ────────────────────────────────────────────────────────────────
// One primary per view. `secondary` is the default and is a bordered surface
// with NO shadow (the old build's `shadow-card` on the default button made
// every control a raised object).
const VARIANTS = {
  primary: 'bg-accent text-white hover:bg-accent-hover',
  secondary: 'border border-line bg-surface text-primary hover:bg-hover hover:border-line-strong',
  ghost: 'text-secondary hover:bg-hover hover:text-primary',
  danger: 'bg-danger text-white hover:opacity-90',
  dangerQuiet: 'border border-danger/40 text-danger hover:bg-danger-soft',
}

const SIZES = {
  sm: 'h-7 gap-2 px-2 text-xs',
  md: 'h-8 gap-2 px-3 text-sm',
  lg: 'h-9 gap-2 px-4 text-sm',
}

const ICON_SIZES = { sm: 'h-7 w-7', md: 'h-8 w-8', lg: 'h-9 w-9' }

// `to` renders a react-router <Link> wearing the button's clothes. An <a>
// nested inside a <button> is invalid HTML and unreachable for keyboard and
// screen-reader users — a navigation that looks like a button must BE a link.
export const Button = forwardRef(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, iconRight: IconRight, to, className, children, ...rest },
  ref
) {
  const iconOnly = !children
  const cls = clsx(
    'inline-flex flex-none select-none items-center justify-center whitespace-nowrap rounded font-semibold',
    'transition-colors duration-100 disabled:pointer-events-none disabled:opacity-40',
    iconOnly ? clsx(ICON_SIZES[size], 'p-0') : SIZES[size],
    VARIANTS[variant],
    className
  )

  const inner = (
    <>
      {Icon && <Icon className="h-4 w-4 flex-none" strokeWidth={1.75} />}
      {children}
      {IconRight && <IconRight className="h-4 w-4 flex-none" strokeWidth={1.75} />}
    </>
  )

  if (to) {
    return (
      <Link ref={ref} to={to} className={cls} {...rest}>
        {inner}
      </Link>
    )
  }
  return (
    <button ref={ref} type="button" className={cls} {...rest}>
      {inner}
    </button>
  )
})

// ── Status ────────────────────────────────────────────────────────────────
// A dot plus text, not a filled pill. Filled treatment is reserved for exactly
// one thing in this product: break-glass (see `BreakglassTag`).
const TONE_DOT = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  neutral: 'bg-tertiary',
  accent: 'bg-accent',
}

export function StatusDot({ tone = 'neutral', live = false, label, className }) {
  return (
    <span className={clsx('inline-flex items-center gap-2 whitespace-nowrap', className)}>
      <span className={clsx('relative inline-flex h-1.5 w-1.5 flex-none rounded-full', TONE_DOT[tone])}>
        {live && <span className={clsx('dot-live absolute inset-0 rounded-full', TONE_DOT[tone])} />}
      </span>
      {label && <span className="text-sm text-primary">{label}</span>}
    </span>
  )
}

// The single sanctioned filled marker in the system.
export function BreakglassTag({ className }) {
  return (
    <span
      className={clsx(
        'inline-flex flex-none items-center gap-1 rounded-sm bg-[rgb(var(--danger-fill))] px-1 py-0.5 text-micro font-semibold uppercase text-white',
        className
      )}
    >
      Break-glass
    </span>
  )
}

// Quiet metadata chip. No border, no fill — just a tinted label.
export function Meta({ children, tone = 'neutral', className, mono = false }) {
  const tones = {
    neutral: 'text-tertiary',
    ok: 'text-ok',
    warn: 'text-warn',
    danger: 'text-danger',
  }
  return (
    <span className={clsx('text-xs', tones[tone], mono && 'font-mono', className)}>{children}</span>
  )
}

// ── Page structure ────────────────────────────────────────────────────────
// PageHeader: title, one line of context, ONE primary action + overflow.
export function PageHeader({ eyebrow, title, description, actions, children }) {
  return (
    <header className="mb-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <p className="mb-1 text-micro font-semibold uppercase text-tertiary">{eyebrow}</p>
          )}
          <h1 className="truncate text-xl font-semibold text-primary">{title}</h1>
          {description && (
            <p className="mt-1 max-w-prose text-base text-secondary">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  )
}

// Section = heading + air. This replaces `Card` as the default container
// (Phase 4.4). No border, no shadow, no background.
export function Section({ title, description, action, children, className }) {
  return (
    <section className={clsx('mt-8 first:mt-0', className)}>
      {(title || action) && (
        <div className="mb-4 flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title && <h2 className="text-lg font-semibold text-primary">{title}</h2>}
            {description && <p className="mt-1 max-w-prose text-sm text-tertiary">{description}</p>}
          </div>
          {action && <div className="flex flex-none items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

// Quiet label + rule, for zones you read rather than act on.
export function RuledLabel({ children, action, className }) {
  return (
    <div className={clsx('mb-4 flex items-center gap-3', className)}>
      <span className="flex-none text-micro font-semibold uppercase text-tertiary">{children}</span>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      {action}
    </div>
  )
}

// Level 1 — a hairline container. Allowed for tables and rule blocks only.
export function Panel({ children, className, ...rest }) {
  return (
    <div className={clsx('overflow-hidden rounded-lg border border-line bg-surface', className)} {...rest}>
      {children}
    </div>
  )
}

// A flat toolbar row. Not a box (the old `Toolbar` was a bordered, shadowed
// container above every list, which read as content rather than chrome).
export function Toolbar({ children, className }) {
  return (
    <div className={clsx('mb-4 flex flex-wrap items-center gap-2', className)}>{children}</div>
  )
}

// ── The metric rail ───────────────────────────────────────────────────────
// Replaces the KPI-card wall. ONE hero (text-display) owns the view; the rest
// are compact stat lines on a single flat row.
//
// STRICTLY PRESENTATIONAL, and deliberately incapable of drawing a trend:
// GET /admin/stats returns point-in-time counts with no history, so there is
// no delta, arrow or sparkline prop here for a caller to reach for.
export function HeroMetric({ label, value, tone = 'neutral', caption, action, children }) {
  const valueTone = { neutral: 'text-primary', warn: 'text-warn', danger: 'text-danger', ok: 'text-ok' }[tone]
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-micro font-semibold uppercase text-tertiary">{label}</p>
        <p className={clsx('mt-2 text-display font-semibold tabular', valueTone)}>{value}</p>
        {caption && <p className="mt-1 text-sm text-secondary">{caption}</p>}
        {children}
      </div>
      {action && <div className="flex flex-none items-center gap-2">{action}</div>}
    </div>
  )
}

// Compact stat line. Everything that is inventory rather than a decision.
export function StatRail({ items, className }) {
  return (
    <dl
      className={clsx(
        'flex flex-wrap items-baseline gap-x-8 gap-y-3 border-t border-line pt-4',
        className
      )}
    >
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-2">
          <dt className="text-micro font-semibold uppercase text-tertiary">{it.label}</dt>
          <dd className={clsx('text-base font-semibold tabular', it.tone === 'danger' ? 'text-danger' : 'text-primary')}>
            {it.value}
          </dd>
          {it.to && (
            <Link to={it.to} className="text-xs text-accent hover:underline">
              view
            </Link>
          )}
        </div>
      ))}
    </dl>
  )
}

// An alarm band. Renders ONLY when there is something to alarm about — a
// zero-state alarm trains people to ignore the band.
export function AlarmBand({ tone = 'danger', icon: Icon, children, action }) {
  const tones = {
    danger: 'border-danger/30 bg-danger-soft text-danger',
    warn: 'border-warn/30 bg-warn-soft text-warn',
    ok: 'border-ok/30 bg-ok-soft text-ok',
  }
  return (
    <div className={clsx('flex items-center gap-3 rounded-lg border px-4 py-3', tones[tone])}>
      {Icon && <Icon className="h-4 w-4 flex-none" strokeWidth={1.75} />}
      <p className="min-w-0 flex-1 text-sm font-semibold">{children}</p>
      {action}
    </div>
  )
}

// ── Detail list ───────────────────────────────────────────────────────────
// Label/value rows, flat. No card, no per-row border box.
export function DetailList({ items, className, columns = 1 }) {
  return (
    <dl
      className={clsx(
        'grid gap-x-8 gap-y-3',
        columns === 2 ? 'sm:grid-cols-2' : 'grid-cols-1',
        className
      )}
    >
      {items.map(({ label, value, mono }) => (
        <div key={label} className="min-w-0">
          <dt className="text-micro font-semibold uppercase text-tertiary">{label}</dt>
          <dd className={clsx('mt-1 break-words text-base text-primary', mono && 'font-mono text-sm')}>
            {value ?? <span className="text-tertiary">—</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

// ── Small form controls (mockup-level only) ───────────────────────────────
export const inputClass =
  'h-8 w-full rounded border border-line bg-surface px-2 text-sm text-primary placeholder:text-tertiary focus:border-accent focus:outline-none'

export function Segmented({ options, value, onChange, className }) {
  return (
    <div className={clsx('inline-flex rounded border border-line p-0.5', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'h-7 rounded-sm px-3 text-sm font-semibold transition-colors duration-100',
            value === o.value ? 'bg-subtle text-primary' : 'text-tertiary hover:text-primary'
          )}
        >
          {o.label}
          {o.count != null && <span className="ml-2 tabular text-tertiary">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

// Filter chip — a facet toggle. Used instead of a wall of dropdowns.
export function FilterChip({ active, onClick, children, count }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'inline-flex h-7 items-center gap-2 rounded border px-2 text-xs font-semibold transition-colors duration-100',
        active
          ? 'border-line-strong bg-subtle text-primary'
          : 'border-line text-tertiary hover:text-primary'
      )}
    >
      {children}
      {count != null && <span className="tabular text-tertiary">{count}</span>}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Form primitives
// ---------------------------------------------------------------------------
// Added in revision 2. Pass 1 mocked no forms at all, which meant the design
// system had no answer for the single most common enterprise surface: a
// create/edit dialog. The rules encoded here:
//   • label above, control, then EITHER hint or error — never both, and the
//     error replaces the hint so the row never grows and reflows the dialog;
//   • required is a mark on the label, not a colour on the input;
//   • errors are sentences that say what to do, never "Invalid".

export function Field({ label, htmlFor, required, hint, error, children, className }) {
  return (
    <div className={clsx('min-w-0', className)}>
      <label htmlFor={htmlFor} className="mb-2 flex items-center gap-1 text-micro font-semibold uppercase text-tertiary">
        {label}
        {required && <span className="text-danger" aria-hidden="true">*</span>}
        {required && <span className="sr-only">(required)</span>}
      </label>
      {children}
      <p className={clsx('mt-2 text-xs', error ? 'text-danger' : 'text-tertiary')} role={error ? 'alert' : undefined}>
        {error || hint || ' '}
      </p>
    </div>
  )
}

// A labelled group inside a dialog. Flat — a rule and a caption, not a card.
export function FieldSet({ title, hint, children, className }) {
  return (
    <fieldset className={clsx('min-w-0 border-0 p-0', className)}>
      <legend className="mb-3 w-full border-b border-line pb-2 text-micro font-semibold uppercase text-tertiary">
        {title}
      </legend>
      {hint && <p className="mb-3 max-w-prose text-xs text-tertiary">{hint}</p>}
      <div className="flex flex-col gap-2">{children}</div>
    </fieldset>
  )
}

export const selectClass =
  'h-8 w-full rounded border border-line bg-surface px-2 text-sm text-primary focus:border-accent focus:outline-none'

export const textareaClass =
  'w-full rounded border border-line bg-surface px-2 py-2 text-sm text-primary placeholder:text-tertiary focus:border-accent focus:outline-none'

// Password strength — mirrors lib/validators.js's four-band model. Shown as a
// segmented meter rather than a coloured bar, because the bands are discrete
// and a continuous bar implies a precision the rule set doesn't have.
export function StrengthMeter({ score = 0, label }) {
  const bands = ['Too short', 'Weak', 'Fair', 'Strong']
  const tone = ['bg-danger', 'bg-danger', 'bg-warn', 'bg-ok'][score] || 'bg-line-strong'
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="flex flex-1 gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={clsx('h-1 flex-1 rounded-full', i <= score ? tone : 'bg-subtle')} />
        ))}
      </span>
      <span className="w-16 flex-none text-right text-xs text-tertiary">{label || bands[score]}</span>
    </div>
  )
}

// A read-only review row — the last step of a wizard, and the confirmation
// pattern for anything with more than four inputs.
export function ReviewRow({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-b-0">
      <span className="flex-none text-micro font-semibold uppercase text-tertiary">{label}</span>
      <span className="min-w-0 truncate text-right text-sm text-primary">
        {value === undefined || value === null || value === '' ? <span className="text-tertiary">—</span> : value}
      </span>
    </div>
  )
}
