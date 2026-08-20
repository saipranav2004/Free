import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { AlertTriangle, Check, ChevronDown, Info, X } from 'lucide-react'
import { Button, inputClass } from './primitives'

// ===========================================================================
// Overlays — the layer pass 1 didn't build at all.
// ===========================================================================
// Elevation level 2 lives here and only here (Phase 4.4): dialogs, sheets,
// menus and toasts are the four things allowed to float over the page.
//
// RESPONSIVE RULE, applied by the primitive rather than per-caller:
// a dialog is a centred panel from 640px up and a FULL-HEIGHT BOTTOM SHEET
// below it. A 520px "centred box" on a 390px phone is the classic mismatch
// this pass exists to remove — it leaves a form squeezed into 60% of the
// screen with the keyboard covering the submit button.

function useLockBody(open) {
  useEffect(() => {
    if (!open) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])
}

// Focus trap + Escape. A dialog you can tab out of is not a dialog.
function useDialogA11y(open, onClose, ref) {
  useEffect(() => {
    if (!open) return undefined
    const node = ref.current
    const previouslyFocused = document.activeElement
    const focusables = () =>
      node?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) || []
    const first = focusables()[0]
    if (first) first.focus()

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose?.()
        return
      }
      if (e.key !== 'Tab') return
      const list = [...focusables()]
      if (list.length === 0) return
      const firstEl = list[0]
      const lastEl = list[list.length - 1]
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [open, onClose, ref])
}

const WIDTHS = {
  sm: 'sm:max-w-[26rem]',
  md: 'sm:max-w-[34rem]',
  lg: 'sm:max-w-[44rem]',
  xl: 'sm:max-w-[56rem]',
}

/**
 * Dialog — centred panel ≥640px, bottom sheet below.
 * `steps` renders a step rail in the header for wizard flows.
 */
export function Dialog({ open, onClose, title, description, size = 'md', steps, current, footer, children }) {
  const ref = useRef(null)
  useLockBody(open)
  useDialogA11y(open, onClose, ref)
  const titleId = useId()
  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="anim-overlay absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={clsx(
          'anim-panel relative flex max-h-[92vh] w-full flex-col rounded-t-xl border border-line bg-surface shadow-overlay',
          'sm:max-h-[86vh] sm:rounded-xl',
          WIDTHS[size]
        )}
      >
        {/* Drag affordance — only meaningful in the sheet presentation. */}
        <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-line-strong sm:hidden" aria-hidden="true" />

        <header className="flex flex-none items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-semibold leading-snug text-primary [text-wrap:balance]">
              {title}
            </h2>
            {description && <p className="mt-1 text-sm text-secondary">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 flex h-9 w-9 flex-none items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </header>

        {steps && <StepRail steps={steps} current={current} />}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

        {footer && (
          <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body
  )
}

// Wizard progress. A step rail is only honest when the flow really has
// ordered steps that gate each other — which the resource wizard and the MFA
// enrolment both do (each validates before it lets you advance).
export function StepRail({ steps, current = 0 }) {
  return (
    <ol className="flex flex-none items-center gap-2 overflow-x-auto border-b border-line bg-subtle px-4 py-2 scrollbar-none">
      {steps.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={s} className="flex flex-none items-center gap-2">
            <span
              className={clsx(
                'flex h-5 w-5 flex-none items-center justify-center rounded-full text-micro font-semibold',
                done && 'bg-ok text-white',
                active && 'bg-accent text-white',
                !done && !active && 'border border-line-strong text-tertiary'
              )}
            >
              {done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
            </span>
            <span className={clsx('whitespace-nowrap text-xs', active ? 'font-semibold text-primary' : 'text-tertiary')}>
              {s}
            </span>
            {i < steps.length - 1 && <span className="h-px w-4 flex-none bg-line-strong" aria-hidden="true" />}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * ConfirmDialog — the shape every destructive action in this product shares.
 * `requireReason` mirrors the API: several endpoints 400 without one, and the
 * reason lands in the audit record, so the field says so instead of being an
 * unexplained textarea.
 * `typeToConfirm` is reserved for the two irreversible actions.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  consequence,
  confirmLabel = 'Confirm',
  destructive = false,
  requireReason = false,
  reasonLabel = 'Reason',
  reasonHint = 'Written to the audit record.',
  typeToConfirm,
  extra,
}) {
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (open) {
      setReason('')
      setTyped('')
    }
  }, [open])

  const blocked =
    (requireReason && reason.trim().length === 0) || (typeToConfirm && typed !== typeToConfirm)

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            size="lg"
            disabled={blocked}
            onClick={() => onConfirm?.(reason)}
          >
            {confirmLabel}
          </Button>
          <Button size="lg" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      {consequence && (
        <p
          className={clsx(
            'text-base',
            destructive ? 'rounded border border-danger/30 bg-danger-soft px-3 py-2 text-danger' : 'text-secondary'
          )}
        >
          {consequence}
        </p>
      )}

      {extra && <div className="mt-4">{extra}</div>}

      {requireReason && (
        <div className="mt-4">
          <label htmlFor="confirm-reason" className="mb-2 block text-micro font-semibold uppercase text-tertiary">
            {reasonLabel} <span className="text-danger">*</span>
          </label>
          <textarea
            id="confirm-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={clsx(inputClass, 'h-auto py-2')}
          />
          <p className="mt-2 text-xs text-tertiary">{reasonHint}</p>
        </div>
      )}

      {typeToConfirm && (
        <div className="mt-4">
          <label htmlFor="confirm-type" className="mb-2 block text-micro font-semibold uppercase text-tertiary">
            Type <span className="font-mono text-primary">{typeToConfirm}</span> to enable the button
          </label>
          <input
            id="confirm-type"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className={clsx(inputClass, 'font-mono')}
          />
        </div>
      )}
    </Dialog>
  )
}

// ── Menu ──────────────────────────────────────────────────────────────────
// One popover primitive for every dropdown in the product: user menu,
// notifications, export, column chooser, saved views. Closes on outside click
// and Escape; anchored right by default because all of ours sit at a row or
// toolbar's right edge.
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
      <span onClick={() => setOpen((v) => !v)} className="contents">
        {typeof trigger === 'function' ? trigger(open) : trigger}
      </span>
      {open && (
        <MenuCloseCtx.Provider value={() => setOpen(false)}>
          <div
            role="menu"
            aria-label={label}
            className={clsx(
              'anim-panel absolute top-full z-40 mt-1 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-overlay',
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

export function MenuItem({ icon: Icon, children, onClick, danger = false, checked, hint, keepOpen = false, className }) {
  const closeMenu = useContext(MenuCloseCtx)
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        onClick?.(e)
        // A multi-select menu (columns, density) stays open; everything else
        // closes, so it never hangs behind the thing it just opened.
        if (!keepOpen && checked === undefined) closeMenu()
      }}
      className={clsx(
        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors duration-100',
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

export function MenuDivider() {
  return <div className="my-1 h-px bg-line" aria-hidden="true" />
}

// ── Toasts ────────────────────────────────────────────────────────────────
// 141 call sites in the current build and no design in pass 1. Rules encoded
// here: bottom-right on desktop, TOP on mobile (a bottom toast sits under the
// thumb and the on-screen keyboard); one icon that encodes the outcome; a
// description line for the "what happens next" the API tells us — which is
// exactly what a partial four-eyes approval needs to say.
const ToastCtx = createContext(() => {})
export const useToast = () => useContext(ToastCtx)

const TOAST_TONE = {
  success: { icon: Check, cls: 'text-ok' },
  error: { icon: AlertTriangle, cls: 'text-danger' },
  info: { icon: Info, cls: 'text-accent' },
  warning: { icon: AlertTriangle, cls: 'text-warn' },
}

export function ToastHost({ children }) {
  const [items, setItems] = useState([])

  const push = (t) => {
    const id = Math.random().toString(36).slice(2)
    setItems((s) => [...s, { id, ...t }])
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), t.duration || 5200)
  }

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:bottom-0 sm:right-0 sm:top-auto sm:items-end">
        {items.map((t) => {
          const tone = TOAST_TONE[t.tone || 'success']
          const Icon = tone.icon
          return (
            <div
              key={t.id}
              role="status"
              className="anim-panel pointer-events-auto flex w-full max-w-[24rem] items-start gap-3 rounded-lg border border-line bg-surface px-3 py-3 shadow-overlay"
            >
              <Icon className={clsx('mt-0.5 h-4 w-4 flex-none', tone.cls)} strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-primary">{t.title}</p>
                {t.description && <p className="mt-1 text-sm text-secondary">{t.description}</p>}
                {t.action}
              </div>
              <button
                type="button"
                onClick={() => setItems((s) => s.filter((x) => x.id !== t.id))}
                aria-label="Dismiss"
                className="-mr-1 -mt-1 flex h-7 w-7 flex-none items-center justify-center rounded text-tertiary hover:bg-hover"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastCtx.Provider>
  )
}

// A dropdown trigger that looks like a secondary button. Extracted because
// six toolbar controls share it and they must not drift apart.
export function MenuButton({ icon: Icon, children, open, count }) {
  return (
    <span
      className={clsx(
        'inline-flex h-8 flex-none cursor-pointer select-none items-center gap-2 rounded border px-3 text-sm font-semibold transition-colors duration-100',
        open ? 'border-line-strong bg-hover text-primary' : 'border-line bg-surface text-primary hover:bg-hover'
      )}
    >
      {Icon && <Icon className="h-4 w-4 flex-none" strokeWidth={1.75} />}
      {children}
      {count != null && <span className="tabular text-tertiary">{count}</span>}
      <ChevronDown className="h-3.5 w-3.5 flex-none text-tertiary" strokeWidth={1.75} />
    </span>
  )
}
