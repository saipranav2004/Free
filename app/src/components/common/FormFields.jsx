import clsx from 'clsx'

// Thin, consistent wrappers around a labeled input/select/textarea plus its
// react-hook-form error message. Not a full form-library abstraction ,
// deliberately dumb, so it's obvious what each field does.
//
// The visual contract: label above (small, medium weight, ink-300), control
// at a fixed 38px height with a 1px border that turns accent on focus plus a
// 3px focus halo, hint below in muted text, error replacing the hint in red.

export function Field({ label, error, hint, children, required, htmlFor }) {
  return (
    <div className="min-w-0">
      {label && (
        <label htmlFor={htmlFor} className="mb-1.5 flex items-center gap-1 text-sm font-bold text-primary">
          {label}
          {required && (
            <span className="font-normal text-tertiary" aria-hidden="true">
              (required)
            </span>
          )}
        </label>
      )}
      {children}
      {hint && !error && <p className="mt-1.5 text-xs leading-relaxed text-tertiary">{hint}</p>}
      {error && (
        <p className="mt-1.5 text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

// A form control sits on the panel ground with a REAL border, not a hairline
// on a tinted well. Cloudscape's input border is #8c8c94, mapped here to
// --border-strong: it is what makes a field read as something you type into.
export const inputClass = (hasError) =>
  clsx(
    'h-9 w-full rounded-lg border bg-surface px-3 text-sm text-primary',
    'placeholder:text-tertiary focus:outline-none focus-visible:outline-none',
    'disabled:cursor-not-allowed disabled:bg-subtle disabled:text-disabled',
    'transition-[border-color,box-shadow] duration-100',
    hasError
      ? 'border-danger focus:border-danger focus:ring-2 focus:ring-danger/25'
      : 'border-line-strong hover:border-primary/40 focus:border-accent focus:ring-2 focus:ring-accent/25'
  )

// Same visual contract for a native <select>. The OS caret is kept (native
// selects stay accessible and keyboard-correct); only the frame, height and
// focus treatment are aligned with the text inputs.
export const selectClass = (hasError) => clsx(inputClass(hasError), 'cursor-pointer pr-8')

// Grouping wrapper for a set of related fields inside a modal or settings
// page, gives forms real structure instead of one flat stack of inputs.
export function FieldSet({ title, description, children, className = '' }) {
  return (
    <fieldset className={className}>
      {title && <legend className="mb-1 text-base font-bold text-primary">{title}</legend>}
      {description && <p className="mb-3 text-sm leading-relaxed text-tertiary">{description}</p>}
      <div className="space-y-4">{children}</div>
    </fieldset>
  )
}
