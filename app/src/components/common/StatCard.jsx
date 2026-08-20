import clsx from 'clsx'

// ---------------------------------------------------------------------------
// Metric plate.
// ---------------------------------------------------------------------------
// Not a "stat card": a drawn instrument plate. Structure, top to bottom ,
//
//   ┌─ accent rail (tone) ────────────────────────────────────┐
//   │  LABEL (small caps) [icon tile]  │
//   │  1,284            ← the loudest thing on the plate      │
//   │  ● supporting context                                   │
//   └─────────────────────────────────────────────────────────┘
//
// The faint modular grid in the corner and the hairline top highlight are
// what stop it reading as a flat rectangle, depth from structure, not from
// a gradient wash. Hovering lifts the plate and warms the icon tile.
//
// PURELY PRESENTATIONAL. `value` renders exactly as passed, so counts and
// their loading state behave identically to before. There is no derived,
// inferred or decorative data anywhere on this component, a metric plate in
// a security console must never draw a number the backend didn't return.
export function StatCard({
  label,
  value,
  icon: Icon,
  tone = 'default',
  hint,
  loading,
  footer,
  live = false, // shows a pulsing presence dot beside the hint
  className,
}) {
  const t = TONES[tone] || TONES.default
  return (
    <div
      className={clsx(
        ' group relative flex h-full flex-col overflow-hidden rounded-xl border border-surface-700/70 bg-surface-900',
        'transition-[border-color,box-shadow,transform] duration-200 ease-emphasis',
        'hover:border-line-strong',
        className
      )}
    >
      {/* Technical ground, corner-anchored and faded out, visible enough to
 register as structure, quiet enough never to compete with the figure. */}
      <span
        aria-hidden="true"
        className="tex-grid pointer-events-none absolute -right-6 -top-6 h-32 w-32 opacity-70 [mask-image:radial-gradient(circle_at_top_right,black,transparent_72%)]"
      />
      {/* Tone rail across the top edge. */}
      <span aria-hidden="true" className={clsx('absolute inset-x-0 top-0 h-[3px]', t.rail)} />

      <div className="relative flex items-start justify-between gap-3 px-4 pb-4 pt-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-2xs font-semibold uppercase tracking-[0.11em] text-ink-500">{label}</p>

          <div className="mt-3 flex items-baseline gap-2">
            {loading ? (
              <span className="skeleton inline-block h-9 w-20 rounded" aria-hidden="true" />
            ) : (
              <span className="text-[2rem] font-semibold leading-none tabular-nums tracking-tight text-ink-50">
                {value}
              </span>
            )}
          </div>

          {hint && (
            <p className="mt-3 flex items-center gap-1.5 text-xs leading-relaxed text-ink-500">
              {live && (
                <span className={clsx('relative flex h-1.5 w-1.5 flex-none rounded-full', t.dot)}>
                  <span className={clsx('dot-live absolute inset-0 rounded-full', t.dot)} />
                </span>
              )}
              <span className="truncate">{hint}</span>
            </p>
          )}
        </div>

        {Icon && (
          <span
            className={clsx(
              'flex h-9 w-9 flex-none items-center justify-center rounded-lg ring-1 ring-inset transition-colors duration-200',
              t.chip
            )}
          >
            <Icon className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.5} />
          </span>
        )}
      </div>

      {footer && (
        <div className="relative mt-auto border-t border-surface-800 bg-surface-850/50 px-4 py-2.5 text-xs text-ink-500">
          {footer}
        </div>
      )}
    </div>
  )
}

const TONES = {
  default: {
    rail: 'bg-blue-500/60',
    dot: 'bg-blue-500',
    chip: 'bg-blue-50 text-blue-600 ring-blue-600/15 group-hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/25 dark:group-hover:bg-blue-500/20',
  },
  amber: {
    rail: 'bg-amber-500/75',
    dot: 'bg-amber-500',
    chip: 'bg-amber-50 text-amber-600 ring-amber-600/15 group-hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25 dark:group-hover:bg-amber-500/20',
  },
  emerald: {
    rail: 'bg-emerald-500/75',
    dot: 'bg-emerald-500',
    chip: 'bg-emerald-50 text-emerald-600 ring-emerald-600/15 group-hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25 dark:group-hover:bg-emerald-500/20',
  },
  red: {
    rail: 'bg-red-500/75',
    dot: 'bg-red-500',
    chip: 'bg-red-50 text-red-600 ring-red-600/15 group-hover:bg-red-100 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25 dark:group-hover:bg-red-500/20',
  },
  purple: {
    rail: 'bg-purple-500/75',
    dot: 'bg-purple-500',
    chip: 'bg-purple-50 text-purple-600 ring-purple-600/15 group-hover:bg-purple-100 dark:bg-purple-500/10 dark:text-purple-300 dark:ring-purple-500/25 dark:group-hover:bg-purple-500/20',
  },
}
