import { forwardRef } from 'react'
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { Spinner } from './Spinner'

// ---------------------------------------------------------------------------
// The one button in the console.
// ---------------------------------------------------------------------------
// Every action surface (page header actions, table row actions, modal
// footers, empty-state CTAs) resolves to this component or to `buttonClass()`
// so weight, height, radius, icon size, hover, active and disabled states are
// identical everywhere. Purely presentational, it forwards every prop
// (onClick, type, disabled, form, aria-*) straight through to <button>, so
// swapping a hand-rolled <button className="..."> for this changes nothing
// about behaviour.

// Variants, measured against Cloudscape's button tokens.
//
// The one that surprises people: THE SECONDARY BUTTON HAS BLUE TEXT. AWS's
// visual update made "secondary buttons, links, and interactive elements
// consistently blue", and a white button with a grey border and blue label is
// what a normal button looks like in the Console. A grey-on-grey secondary is
// what it looks like in a template.
//
// The other: THE PRIMARY GOES DARKER ON HOVER, not lighter (#006ce0 to
// #002b66). Lightening on hover reads as the control receding; darkening
// reads as it firming up under the pointer.
const VARIANTS = {
  primary: 'border border-transparent bg-accent text-white hover:bg-accent-hover active:bg-accent-hover',
  secondary: 'border border-line-strong bg-surface text-accent hover:bg-accent-soft active:bg-accent-active',
  // A neutral secondary, for toolbars where a row of blue labels would be
  // louder than the data underneath them.
  subtle: 'border border-line bg-surface text-primary hover:bg-hover active:bg-subtle',
  ghost: 'border border-transparent text-secondary hover:bg-hover hover:text-primary active:bg-subtle',
  danger: 'border border-transparent bg-danger-fill text-white hover:brightness-110 active:brightness-95',
  dangerGhost: 'border border-danger/40 text-danger hover:bg-danger-soft active:bg-danger-soft',
  link: 'border border-transparent px-0 text-accent hover:text-accent-hover hover:underline',
}

const SIZES = {
  xs: 'h-7 gap-1.5 rounded-md px-2.5 text-xs',
  sm: 'h-8 gap-1.5 rounded-md px-2.5 text-sm',
  md: 'h-8 gap-2 rounded-lg px-3 text-sm',
  lg: 'h-10 gap-2 rounded-lg px-4 text-sm',
  // xl exists for the rare action that IS the point of its screen, the
  // Audit & Compliance report builder, an empty-state primary CTA. One step
  // only; a scale with two "extra large" steps just moves the problem.
  xl: 'h-11 gap-2.5 rounded-xl px-5 text-[0.9375rem] font-semibold',
}

const ICON_SIZES = {
  xs: 'h-8 w-8 rounded-md',
  sm: 'h-8 w-8 rounded-md',
  md: 'h-9 w-9 rounded-lg',
  lg: 'h-10 w-10 rounded-lg',
  xl: 'h-11 w-11 rounded-xl',
}

const BASE =
  'inline-flex flex-none select-none items-center justify-center whitespace-nowrap font-semibold ' +
  'transition-[background-color,border-color,color] duration-100 ' +
  'disabled:pointer-events-none disabled:opacity-45'

export function buttonClass({ variant = 'secondary', size = 'md', block = false, iconOnly = false } = {}) {
  return clsx(
    BASE,
    iconOnly ? ICON_SIZES[size] || ICON_SIZES.md : SIZES[size] || SIZES.md,
    VARIANTS[variant] || VARIANTS.secondary,
    block && 'w-full'
  )
}

export const Button = forwardRef(function Button(
  {
    variant = 'secondary',
    size = 'md',
    block = false,
    icon: Icon,
    iconRight: IconRight,
    loading = false,
    disabled,
    className,
    children,
    // A button that navigates is a link. Passing `to` renders a react-router
    // <Link> with the identical classes instead of wrapping an <a> inside a
    // <button>, which is invalid HTML, breaks middle-click and open-in-new-tab,
    // and is announced as a button by screen readers even though it navigates.
    to,
    ...rest
  },
  ref
) {
  const iconOnly = !children
  const glyph =
    size === 'xl' ? 'h-[1.1rem] w-[1.1rem]' : size === 'lg' || size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'
  const Root = to ? Link : 'button'
  const rootProps = to
    ? { to, ...(disabled ? { 'aria-disabled': true, tabIndex: -1 } : {}) }
    : { disabled: disabled || loading }
  return (
    <Root
      ref={ref}
      {...rootProps}
      className={clsx(buttonClass({ variant, size, block, iconOnly }), className)}
      {...rest}
    >
      {loading ? (
        <Spinner
          size={glyph}
          className={variant === 'primary' || variant === 'danger' ? 'text-white' : undefined}
        />
      ) : (
        Icon && <Icon className={clsx(glyph, 'flex-none')} strokeWidth={2} />
      )}
      {children}
      {IconRight && !loading && <IconRight className={clsx(glyph, 'flex-none')} strokeWidth={2} />}
    </Root>
  )
})

// Icon-only control for toolbars/table rows. Always give it an aria-label.
export const IconButton = forwardRef(function IconButton(
  { icon: Icon, variant = 'ghost', size = 'md', className, ...rest },
  ref
) {
  return (
    <button ref={ref} className={clsx(buttonClass({ variant, size, iconOnly: true }), className)} {...rest}>
      <Icon className={size === 'lg' || size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} strokeWidth={2} />
    </button>
  )
})
