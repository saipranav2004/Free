import { forwardRef, useEffect, useRef } from 'react'
import clsx from 'clsx'

// A real checkbox (native input, keyboard- and screen-reader-correct) with a
// drawn box on top of it. `indeterminate` is a DOM property, not an
// attribute, so it can only be set imperatively, which is why this needs a
// ref effect rather than being a one-liner.
export const Checkbox = forwardRef(function Checkbox(
  { checked = false, indeterminate = false, onChange, label, srLabel, disabled, className, ...rest },
  forwardedRef
) {
  const innerRef = useRef(null)

  useEffect(() => {
    const el = innerRef.current
    if (el) el.indeterminate = !checked && indeterminate
  }, [checked, indeterminate])

  const box = (
    <span className="relative flex h-4 w-4 flex-none items-center justify-center">
      <input
        ref={(node) => {
          innerRef.current = node
          if (typeof forwardedRef === 'function') forwardedRef(node)
          else if (forwardedRef) forwardedRef.current = node
        }}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked, e)}
        aria-label={srLabel}
        className={clsx(
          'peer h-4 w-4 cursor-pointer appearance-none rounded-[0.25rem] border bg-surface-900 transition-colors duration-150',
          'border-surface-600 hover:border-blue-500',
          'checked:border-blue-600 checked:bg-blue-600 indeterminate:border-blue-600 indeterminate:bg-blue-600',
          'disabled:cursor-not-allowed disabled:opacity-40',
          className
        )}
        {...rest}
      />
      {/* Tick / dash drawn over the input so the control keeps native
 semantics while looking like part of the design system. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="pointer-events-none absolute h-3 w-3 text-white opacity-0 peer-checked:opacity-100"
      >
        <path
          d="M3.5 8.5l3 3 6-6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="pointer-events-none absolute hidden h-[2px] w-2 rounded-full bg-white peer-indeterminate:block"
        aria-hidden="true"
      />
    </span>
  )

  if (!label) return box

  return (
    <label
      className={clsx(
        'inline-flex cursor-pointer select-none items-center gap-2.5 text-sm text-ink-200',
        disabled && 'cursor-not-allowed opacity-60'
      )}
    >
      {box}
      {label}
    </label>
  )
})
