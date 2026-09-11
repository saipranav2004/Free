import clsx from 'clsx'
import { X, Lock } from 'lucide-react'
import { Button } from './Button'

// ---------------------------------------------------------------------------
// Bulk action bar.
// ---------------------------------------------------------------------------
// Floats over the content once anything is ticked, the pattern Okta, Entra
// ID and SailPoint all use, because a bar wedged above the table pushes rows
// down and makes the selection you just made jump away from the cursor.
//
// Two behaviours worth calling out:
//
//  1. SCOPE IS EXPLICIT. "12 selected" and "all 1,284 matching your filters"
// are different statements, and a bulk action that quietly means the
// first while the user believes the second is a data-loss incident. When
// a whole page is ticked and more rows match, the bar offers the wider
// scope as a deliberate second click.
//
//  2. UNAVAILABLE ACTIONS ARE VISIBLE, NOT HIDDEN. This backend has no batch
// endpoints, deleting 50 users means 50 requests. Rather than pretend
// those actions don't exist, they render disabled with the reason, so the
//     UI tells the truth about what the platform can currently do.

export function BulkActionBar({
  count,
  total,
  actions = [], // [{ key, label, icon, onClick, variant, disabled, disabledReason }]
  onClear,
  onSelectAllMatching,
  allMatchingSelected,
  noun = 'item',
  className,
}) {
  if (!count) return null

  const plural = count === 1 ? noun : `${noun}s`
  const canWiden = !allMatchingSelected && typeof total === 'number' && total > count && !!onSelectAllMatching

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className={clsx(
        'pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-5',
        className
      )}
    >
      <div className="animate-panel-in pointer-events-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-surface-700 bg-surface-900 px-3.5 py-3 shadow-overlay">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-7 min-w-[1.75rem] flex-none items-center justify-center rounded-md bg-blue-600 px-1.5 text-xs font-semibold tabular-nums text-white">
            {count.toLocaleString()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-50">
              {allMatchingSelected
                ? `All ${count.toLocaleString()} matching ${plural}`
                : `${plural} selected`}
            </p>
            {canWiden && (
              <button
                type="button"
                onClick={onSelectAllMatching}
                className="mt-0.5 text-xs font-medium text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
              >
                Select all {total.toLocaleString()} matching your filters
              </button>
            )}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions.map((a) => (
            <Button
              key={a.key}
              size="sm"
              variant={a.variant || 'secondary'}
              icon={a.disabled ? Lock : a.icon}
              disabled={a.disabled}
              onClick={a.onClick}
              title={a.disabled ? a.disabledReason : undefined}
            >
              {a.label}
            </Button>
          ))}
          <span className="mx-0.5 h-6 w-px bg-surface-700" aria-hidden="true" />
          <Button
            size="sm"
            variant="ghost"
            icon={X}
            onClick={onClear}
            aria-label="Clear selection"
            title="Clear selection"
          />
        </div>
      </div>
    </div>
  )
}
