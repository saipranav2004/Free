import { createContext, useContext, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Check, ChevronDown, MoreHorizontal } from 'lucide-react'

// ---------------------------------------------------------------------------
// One popover primitive for every dropdown in the console
// ---------------------------------------------------------------------------
// Toolbar menus, the column chooser, export, saved views, and the per row
// overflow. Closes on outside click and on Escape, and anchors right by
// default because almost all of them sit at a row or toolbar's right edge.
//
// MenuItem closes its own menu on activation unless it is a multi select
// item. Without that, opening a dialog from a row menu left the menu hanging
// open behind the dialog it had just opened.
const MenuCloseCtx = createContext(() => {})

export function Menu({ trigger, children, align = 'right', width = 'w-56', label }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative flex-none">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="block"
      >
        {typeof trigger === 'function' ? trigger(open) : trigger}
      </button>
      {open && (
        <MenuCloseCtx.Provider value={() => setOpen(false)}>
          <div
            role="menu"
            aria-label={label}
            className={clsx(
              'animate-menu-in absolute top-full z-40 mt-1 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-overlay',
              width,
              align === 'right' ? 'right-0' : 'left-0'
            )}
          >
            {children}
          </div>
        </MenuCloseCtx.Provider>
      )}
    </div>
  )
}

export function MenuItem({
  icon: Icon,
  children,
  onClick,
  danger = false,
  checked,
  hint,
  keepOpen = false,
  disabled = false,
  className,
}) {
  const closeMenu = useContext(MenuCloseCtx)
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e)
        if (!keepOpen && checked === undefined) closeMenu()
      }}
      className={clsx(
        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors duration-100',
        'disabled:pointer-events-none disabled:opacity-45',
        danger ? 'text-danger hover:bg-danger-soft' : 'text-primary hover:bg-hover',
        className
      )}
    >
      {checked !== undefined ? (
        <span
          className={clsx(
            'flex h-4 w-4 flex-none items-center justify-center rounded-sm border',
            checked ? 'border-accent bg-accent text-white' : 'border-line-strong'
          )}
        >
          {checked && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
      ) : (
        Icon && <Icon className="h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="flex-none text-xs text-tertiary">{hint}</span>}
    </button>
  )
}

export function MenuLabel({ children }) {
  return <p className="px-3 pb-1 pt-2 text-micro font-semibold uppercase text-tertiary">{children}</p>
}

export function MenuNote({ children }) {
  return <p className="px-3 pb-2 pt-1 text-xs leading-relaxed text-tertiary">{children}</p>
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-line" aria-hidden="true" />
}

// A dropdown trigger that reads as a secondary button. Extracted because six
// toolbar controls share it and they must not drift apart. It is a <span>
// because Menu already renders the <button> around it.
export function MenuButton({ icon: Icon, children, open, count, className }) {
  return (
    <span
      className={clsx(
        'inline-flex h-8 flex-none cursor-pointer select-none items-center gap-2 rounded border px-3 text-sm font-medium transition-colors duration-100',
        open
          ? 'border-line-strong bg-hover text-primary'
          : 'border-line bg-surface text-primary hover:bg-hover',
        className
      )}
    >
      {Icon && <Icon className="h-4 w-4 flex-none" strokeWidth={1.75} />}
      {children}
      {count != null && <span className="tabular text-tertiary">{count}</span>}
      <ChevronDown className="h-3.5 w-3.5 flex-none text-tertiary" strokeWidth={1.75} />
    </span>
  )
}

// The per row overflow. Destructive row actions live in here, never on the
// row itself.
export function RowMenu({ children, label = 'Row actions' }) {
  return (
    <Menu
      label={label}
      width="w-56"
      trigger={(open) => (
        <span
          className={clsx(
            'flex h-6 w-6 items-center justify-center rounded transition-colors',
            open ? 'bg-hover text-primary' : 'text-tertiary hover:bg-hover hover:text-primary'
          )}
        >
          <MoreHorizontal className="h-4 w-4" strokeWidth={2} />
        </span>
      )}
    >
      {children}
    </Menu>
  )
}
