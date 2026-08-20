import clsx from 'clsx'
import { Link } from 'react-router-dom'

// ---------------------------------------------------------------------------
// KPI strip, the console's one metric instrument.
// ---------------------------------------------------------------------------
// This is the house pattern already shipping on the product's Audit Logs
// screen, promoted to a shared component: ONE bordered instrument divided
// into cells, no gaps between them, rather than four floating cards.
//
//   ┌──────────────┬──────────────┬──────────────┬──────────────┐
//   │ ▣ LABEL      │ ◔ LABEL      │ ⊘ LABEL      │ ⊕ LABEL      │
//   │ 1,284        │ 46           │ 17           │ 3            │
//   │ description  │ description  │ description  │ description  │
//   └──────────────┴──────────────┴──────────────┴──────────────┘
//
// Why this and not a card grid: gapped cards make four unrelated objects out
// of one reading. A divided strip says "these numbers describe the same
// thing", which is exactly what a KPI row is, and it's what Entra ID, Okta
// and this product's own audit screen do.
//
// STRICTLY PRESENTATIONAL. `value` renders exactly what it is handed. There
// is no trend arrow, sparkline, delta or comparison anywhere in this
// component, because the API returns point-in-time counts with no history ,
// a security console must never draw a number the backend didn't return.

const COLS = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
  5: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5',
  6: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6',
}

const TONES = {
  default: { icon: 'text-ink-500', value: 'text-ink-50', dot: 'bg-blue-500' },
  blue: { icon: 'text-blue-600 dark:text-blue-400', value: 'text-ink-50', dot: 'bg-blue-500' },
  emerald: { icon: 'text-emerald-600 dark:text-emerald-400', value: 'text-ink-50', dot: 'bg-emerald-500' },
  // Attention tones tint the figure itself, on the reference screen the
  // denied/failed count reads red, and that's the whole point of the cell.
  amber: {
    icon: 'text-amber-600 dark:text-amber-400',
    value: 'text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500',
  },
  red: { icon: 'text-red-600 dark:text-red-400', value: 'text-red-700 dark:text-red-300', dot: 'bg-red-500' },
  purple: { icon: 'text-purple-600 dark:text-purple-400', value: 'text-ink-50', dot: 'bg-purple-500' },
}

// One cell. Exported so a page can compose a strip by hand when a cell needs
// custom content (a chain-verification state, a ratio) that `items` can't
// express, the frame and dividers still come from KpiStrip.
export function KpiCell({
  label,
  value,
  icon: Icon,
  description,
  tone = 'default',
  loading = false,
  live = false,
  to,
  onClick,
  children,
  className,
}) {
  const t = TONES[tone] || TONES.default
  const interactive = !!(to || onClick)

  const body = (
    <>
      <div className="flex items-center gap-2">
        {Icon && <Icon className={clsx('h-[0.9rem] w-[0.9rem] flex-none', t.icon)} strokeWidth={1.75} />}
        <p className="truncate text-2xs font-semibold uppercase tracking-[0.11em] text-ink-400">{label}</p>
        {live && (
          <span
            className={clsx('relative ml-auto flex h-1.5 w-1.5 flex-none rounded-full', t.dot)}
            aria-hidden="true"
          >
            <span className={clsx('dot-live absolute inset-0 rounded-full', t.dot)} />
          </span>
        )}
      </div>

      <div className="mt-3">
        {loading ? (
          <span className="skeleton block h-7 w-16 rounded" aria-hidden="true" />
        ) : (
          <span
            className={clsx(
              'block text-[1.75rem] font-semibold leading-none tracking-tight tabular-nums',
              t.value
            )}
          >
            {value}
          </span>
        )}
      </div>

      {children ? (
        <div className="mt-3">{children}</div>
      ) : (
        description && <p className="mt-2.5 truncate text-xs leading-relaxed text-ink-500">{description}</p>
      )}
    </>
  )

  const cellClass = clsx(
    'relative min-w-0 border-t border-surface-800 px-5 py-4 first:border-t-0 sm:border-t-0 sm:border-l sm:first:border-l-0',
    interactive && 'group transition-colors duration-150 hover:bg-surface-850',
    className
  )

  if (to) {
    return (
      <Link to={to} className={clsx(cellClass, 'block outline-none')}>
        {body}
      </Link>
    )
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={clsx(cellClass, 'block w-full text-left outline-none')}
      >
        {body}
      </button>
    )
  }
  return <div className={cellClass}>{body}</div>
}

function withoutKey(item) {
  const { key, ...rest } = item
  return rest
}

export function KpiStrip({ items, columns, loading = false, className, children }) {
  const cells = items || []
  const count = columns || cells.length || 4
  return (
    <div
      className={clsx(
        ' grid overflow-hidden rounded-xl border border-surface-700/70 bg-surface-900',
        COLS[count] || COLS[4],
        className
      )}
    >
      {children ||
        cells.map((item) => (
          // `key` is pulled OUT of the spread rather than passed through it.
          // Spreading an object that carries a `key` field into JSX makes
          // React ignore it and warn, which is how a list ends up with no
          // stable identity and re-mounts on every render.
          <KpiCell key={item.key || item.label} {...withoutKey(item)} loading={loading || item.loading} />
        ))}
    </div>
  )
}
