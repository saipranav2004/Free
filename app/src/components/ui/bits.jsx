import clsx from 'clsx'

// ---------------------------------------------------------------------------
// Row level marks
// ---------------------------------------------------------------------------

const DOT = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  accent: 'bg-accent',
  // "Off" should not carry the same weight as "on", so a muted state is a
  // hollow ring rather than a filled dot.
  muted: 'bg-transparent ring-1 ring-inset ring-line-strong',
}

const DOT_TEXT = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  accent: 'text-accent',
  muted: 'text-tertiary',
}

/**
 * State, as a dot. Pass `label` to show the word beside it; leave it off and
 * the dot rides in the identity cell with the state in `title`, which is what
 * the grid does when a dedicated status column would only repeat the colour.
 */
export function StatusDot({ tone = 'muted', label, title, live = false, className }) {
  return (
    <span
      title={title || label}
      className={clsx('inline-flex items-center gap-2 whitespace-nowrap text-sm', DOT_TEXT[tone], className)}
    >
      <span className={clsx('relative flex h-1.5 w-1.5 flex-none rounded-full', DOT[tone])}>
        {live && (
          <span className={clsx('dot-live absolute inset-0 rounded-full', DOT[tone])} aria-hidden="true" />
        )}
      </span>
      {label}
    </span>
  )
}

/**
 * Quiet metadata. A label, not a status: no border, no fill, no judgement.
 * Used for a type name, a protected marker, an "inactive" note beside a name.
 */
export function Meta({ children, tone, mono = false, className }) {
  return (
    <span
      className={clsx(
        'inline-flex flex-none items-center whitespace-nowrap text-xs',
        mono && 'font-mono',
        tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-tertiary',
        className
      )}
    >
      {children}
    </span>
  )
}

/**
 * The one filled marker in the product, reserved for break glass. Everything
 * else is a dot or plain text, so when this appears it means something.
 */
export function AlarmTag({ children = 'Break glass', className }) {
  return (
    <span
      className={clsx(
        'inline-flex flex-none items-center rounded bg-danger-fill px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide text-white',
        className
      )}
    >
      {children}
    </span>
  )
}

/** A facet toggle. Used instead of a wall of dropdowns. */
export function FilterChip({ active, onClick, children, count, className }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'inline-flex h-8 flex-none items-center gap-2 rounded border px-2.5 text-sm font-medium transition-colors duration-100',
        active
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-line bg-surface text-secondary hover:bg-hover hover:text-primary',
        className
      )}
    >
      {children}
      {count != null && <span className="tabular text-tertiary">{count}</span>}
    </button>
  )
}
