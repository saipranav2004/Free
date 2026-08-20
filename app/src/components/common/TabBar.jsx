import clsx from 'clsx'

// Shared tab bar, Sessions/JIT/Admin pages all had their own hand-rolled
// copy of this; centralizing it means the active/inactive styling (and its
// light/dark contrast) is fixed in one place.
//
// Underline tabs rather than filled pills: they read as navigation between
// views of the same object (the enterprise-console convention), where a solid
// blue pill reads as a button and competes with the page's primary action.
export function TabBar({ tabs, active, onChange, className = '' }) {
  return (
    <div
      role="tablist"
      className={clsx(
        'scrollbar-none -mb-px flex items-center gap-1 overflow-x-auto border-b border-surface-800',
        className
      )}
    >
      {tabs.map((t) => {
        const isActive = active === t.key
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.key)}
            className={clsx(
              'relative flex flex-none items-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors',
              'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors',
              isActive
                ? 'text-ink-50 after:bg-blue-600 dark:after:bg-blue-400'
                : 'text-ink-400 hover:text-ink-100 after:bg-transparent'
            )}
          >
            {t.icon && <t.icon className="h-4 w-4 flex-none" strokeWidth={1.75} />}
            {t.label}
            {typeof t.count === 'number' && (
              <span
                className={clsx(
                  'rounded px-1.5 py-0.5 text-2xs font-semibold tabular-nums ring-1 ring-inset',
                  isActive
                    ? 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30'
                    : 'bg-surface-800 text-ink-400 ring-surface-700'
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
