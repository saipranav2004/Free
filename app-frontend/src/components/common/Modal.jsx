import { useEffect, useId, useRef } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { IconButton } from './Button'

// ---------------------------------------------------------------------------
// The one modal shell.
// ---------------------------------------------------------------------------
// Behaviour only, no data, no fetching. Handles the things every hand-rolled
// modal in the app was missing: Escape to close, a click-outside target that
// isn't the panel itself, body scroll lock (so the page behind doesn't scroll
// under the dialog), focus moved into the panel on open, and the same
// backdrop/elevation/motion for every dialog in the console.
//
// ---------------------------------------------------------------------------
// FOCUS-STEALING BUG, fixed here, and this file is why it happened everywhere
// ---------------------------------------------------------------------------
// Symptom: open any create form (Resource, Safe, Credential, User, JIT
// request), start typing in the third field, and the caret jumps back to the
// first field mid-word.
//
// Cause: the open effect below used to depend on [open, onClose, busy]. Every
// call site passes an inline arrow (`onClose={() => setCreateOpen(false)}`),
// which is a NEW function identity on every parent render, and the parent
// re-renders constantly behind the modal (react-query background refetches,
// `isFetching` flipping, poll ticks). Each of those re-runs fired the effect,
// which 20ms later ran `querySelector(...first focusable...)` and focused it.
// From the user's side: focus silently teleporting to field one, at random,
// while typing. `busy` flipping during a mutation did the same thing.
//
// Fix, three parts:
//   1. The effect depends on [open] ONLY. Opening is the event that should
// move focus; a parent re-render is not.
//   2. onClose and busy are read through refs, so the handlers always call the
// latest version without the effect re-subscribing.
//   3. Focus is only moved if it isn't already inside the panel, so even a
// forced re-run can't yank the caret out of whatever the user is typing.
//
// The same instability also broke the scroll lock: each re-run captured the
// body's CURRENT overflow as "the original", which by then was already
// 'hidden', so closing the dialog restored 'hidden' and left the page unable
// to scroll. The lock now applies once per open and restores once on close.
export function Modal({
  open,
  onClose,
  title,
  description,
  icon: Icon,
  tone = 'default', // 'default' | 'danger' | 'warning'
  size = 'md', // sm | md | lg | xl
  footer,
  children,
  closeOnBackdrop = true,
  busy = false,
}) {
  const titleId = useId()
  const panelRef = useRef(null)

  // Latest-value refs: handlers below stay correct without becoming effect
  // dependencies.
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  useEffect(() => {
    onCloseRef.current = onClose
    busyRef.current = busy
  })

  useEffect(() => {
    if (!open) return undefined

    const onKey = (e) => {
      if (e.key === 'Escape' && !busyRef.current) onCloseRef.current?.()
    }
    document.addEventListener('keydown', onKey)

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Focus the panel so screen readers land inside the dialog and Escape
    // works immediately without the user clicking first. Guarded: if focus is
    // already inside the panel (the user is typing), leave it alone.
    const t = setTimeout(() => {
      const panel = panelRef.current
      if (!panel) return
      if (panel.contains(document.activeElement)) return
      const focusable = panel.querySelector(
        'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([data-modal-close]):not([disabled])'
      )
      ;(focusable || panel).focus?.()
    }, 20)

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      clearTimeout(t)
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center sm:p-6">
      <div
        className="animate-overlay-in fixed inset-0 bg-slate-950/55 backdrop-blur-[3px] dark:bg-black/70"
        aria-hidden="true"
        onClick={() => {
          if (closeOnBackdrop && !busy) onClose?.()
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={clsx(
          'animate-panel-in relative my-auto w-full rounded-xl border border-surface-700 bg-surface-900 shadow-overlay outline-none',
          SIZES[size] || SIZES.md
        )}
      >
        <div className="flex items-start gap-3 border-b border-surface-800 px-5 py-4">
          {Icon && (
            <span
              className={clsx(
                'mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg ring-1 ring-inset',
                TONES[tone] || TONES.default
              )}
            >
              <Icon className="h-4 w-4" strokeWidth={1.75} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="text-lg font-bold leading-tight tracking-[-0.015em] text-ink-50">
              {title}
            </h3>
            {description && <p className="mt-1 text-sm leading-relaxed text-ink-400">{description}</p>}
          </div>
          <IconButton
            icon={X}
            size="sm"
            data-modal-close
            onClick={onClose}
            disabled={busy}
            aria-label="Close dialog"
            className="-mr-1.5 -mt-1"
          />
        </div>

        <div className="max-h-[calc(100vh-16rem)] overflow-y-auto px-5 py-5">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 rounded-b-xl border-t border-surface-800 bg-surface-850/60 px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
}

const TONES = {
  default:
    'bg-blue-50 text-blue-600 ring-blue-600/15 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/25',
  danger: 'bg-red-50 text-red-600 ring-red-600/15 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25',
  warning:
    'bg-amber-50 text-amber-600 ring-amber-600/15 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25',
}
