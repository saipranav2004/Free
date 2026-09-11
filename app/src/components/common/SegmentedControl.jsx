import clsx from 'clsx'

// ---------------------------------------------------------------------------
// Segmented control.
// ---------------------------------------------------------------------------
// Replaces the "solid blue pill inside a grey trough" pattern, which reads as
// a *button* and competes with the page's real primary action. Enterprise
// consoles use a recessed track with a raised selected segment: the selection
// looks lifted out of the track, so it reads as a view switch, not a CTA.
//
// Controlled and stateless, `value`/`onChange` behave exactly like the raw
// button handlers they replace, so no page's state logic changes.
export function SegmentedControl({ options, value, onChange, size = 'md', className = '', ariaLabel }) {
  const h = size === 'sm' ? 'h-7 text-xs' : 'h-8 text-xs'
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={clsx(
        'inline-flex flex-none items-center gap-0.5 rounded-lg border border-surface-700 bg-surface-800 p-0.5',
        className
      )}
    >
      {options.map((opt) => {
        const key = opt.key ?? opt.value
        const selected = value === key
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(key)}
            className={clsx(
              'inline-flex items-center gap-1.5 whitespace-nowrap rounded-[0.3rem] px-3 font-medium transition-all duration-150',
              h,
              selected
                ? 'bg-surface-900 text-ink-50 ring-1 ring-inset ring-surface-700'
                : 'text-ink-400 hover:text-ink-100'
            )}
          >
            {opt.icon && <opt.icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />}
            {opt.label}
            {typeof opt.count === 'number' && (
              <span
                className={clsx(
                  'rounded px-1 text-2xs font-semibold tabular-nums',
                  selected
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                    : 'text-ink-500'
                )}
              >
                {opt.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// A checkbox styled as a filter toggle rather than a raw OS control, the
// single most obvious "unstyled form" tell in a filter bar.
export function FilterToggle({ checked, onChange, label, className = '' }) {
  return (
    <label
      className={clsx(
        'inline-flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition-colors',
        checked
          ? 'border-blue-500/40 bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
          : 'border-surface-700 bg-surface-900 text-ink-400 hover:border-surface-600 hover:text-ink-100',
        className
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-surface-600 bg-surface-800 text-blue-600 focus:ring-blue-500/30"
      />
      {label}
    </label>
  )
}
