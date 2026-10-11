import { Loader2 } from 'lucide-react'
import clsx from 'clsx'

export function Spinner({ className, size = 'h-5 w-5' }) {
  return (
    <Loader2
      className={clsx(size, 'flex-none animate-spin text-ink-400', className)}
      strokeWidth={2}
      aria-label="Loading"
    />
  )
}

export function FullPageSpinner({ label = 'Loading…' }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-ink-400">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-surface-700 bg-surface-900 ">
        <Spinner size="h-5 w-5" />
      </div>
      <span className="text-sm font-medium">{label}</span>
    </div>
  )
}

// Row-shaped skeletons for list/table loading states, a shaped placeholder
// reads as "content is coming", a bare spinner reads as "something is stuck".
export function SkeletonRows({ rows = 5 }) {
  return (
    <ul className="divide-y divide-surface-800" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center justify-between gap-4 px-4 py-3.5">
          <div className="min-w-0 flex-1 space-y-2">
            <span className="skeleton block h-3.5 w-1/3 rounded" />
            <span className="skeleton block h-3 w-1/2 rounded" />
          </div>
          <span className="skeleton block h-5 w-16 rounded-md" />
        </li>
      ))}
    </ul>
  )
}
