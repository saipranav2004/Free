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
export function SettingRow({ label, description, control, htmlFor, className = '' }) {
  return (
    <div className={clsx('flex items-start justify-between gap-6 px-4 py-3.5', className)}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-100">
          {label}
        </label>
        {description && <p className="mt-1 max-w-xl text-xs leading-relaxed text-ink-500">{description}</p>}
      </div>
      <div className="flex flex-none items-center gap-2 pt-0.5">{control}</div>
    </div>
  )
}
