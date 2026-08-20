import clsx from 'clsx'

// The console's one switch. Used for boolean preferences on the Settings
// page, a checkbox reads as "part of a form you submit", a switch reads as
// "a state you flip", which is what these are.
export function Switch({ checked = false, onChange, disabled = false, id, label, describedBy }) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={clsx(
        'relative inline-flex h-[1.375rem] w-10 flex-none items-center rounded-full transition-colors duration-200 ease-emphasis',
        'outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-900',
        'disabled:cursor-not-allowed disabled:opacity-45',
        checked
          ? 'bg-blue-600 ring-1 ring-inset ring-blue-500/50'
          : 'bg-surface-750 ring-1 ring-inset ring-surface-600'
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'pointer-events-none absolute top-1/2 h-[1.05rem] w-[1.05rem] -translate-y-1/2 rounded-full bg-white shadow-sm transition-[left] duration-200 ease-emphasis',
          checked ? 'left-[1.2rem]' : 'left-[0.15rem]'
        )}
      />
    </button>
  )
}

// A labelled preference row: name + explanation on the left, control on the
// right. Every settings section is built from these so label width, control
// alignment and row rhythm are identical across tabs.
/**
 * One setting. Name and its consequence on the left, the control that changes
 * it on the right, on a single hairline-separated row.
 *
 * This is the row every mature settings surface converged on (GitHub, Stripe,
 * Okta, Vercel): the description sits UNDER the label rather than in a tooltip,
 * because the thing people need to know is what flipping the switch actually
 * does, and a tooltip hides exactly that. The control is right-aligned on its
 * own edge so a column of them scans as one list of states instead of drifting
 * with the length of each description.
 *
 * Stacks to a single column below `sm`, where a right-aligned control would be
 * pushed off the text it belongs to.
 */
export function SettingRow({ label, description, control, htmlFor, className = '' }) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8',
        className
      )}
    >
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-semibold text-primary">
          {label}
        </label>
        {description && (
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-secondary">{description}</p>
        )}
      </div>
      <div className="flex flex-none items-center gap-2 sm:pt-0.5">{control}</div>
    </div>
  )
}
