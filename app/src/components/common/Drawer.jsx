import { isValidElement, createElement, useEffect, useRef } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { IconButton } from './Button'
import { NAVBAR_BELOW_CLASS } from './TopNavbar'

// ---------------------------------------------------------------------------
// Side drawer.
// ---------------------------------------------------------------------------
// The "peek" half of the enterprise list/detail pattern: inspect a row
// without losing your place in a filtered, paged, partially-selected table.
// Deep work still happens on the full detail page, the drawer's footer is
// where "Open full page" lives.
//
// It does not own any data. Whatever the caller renders inside is what the
// user sees, so a drawer showing a resource and the resource's own page can
// never drift apart in what they claim.
//
// Same latest-value-ref treatment as Modal: every call site passes an inline
// `onClose={() => setPeeked(null)}`, so keeping it in the dependency array
// tore down and re-subscribed the Escape listener on every parent re-render
// (and every background refetch behind the drawer). Harmless-looking, but it
// is the identical pattern that caused the focus-stealing bug in Modal, so it
// is fixed the same way rather than left as a trap for the next edit.
export function Drawer({ open, onClose, title, subtitle, icon, footer, width = 'md', children }) {
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && onCloseRef.current?.()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  // `icon` accepts EITHER a rendered element (<Fingerprint className="…" />)
  // or an icon component (Fingerprint). It used to render `{icon}` raw, which
  // meant passing the component, the more natural of the two, and what every
  // other icon prop in this console takes, handed React a forwardRef object
  // as a child and crashed the whole route with "Objects are not valid as a
  // React child (found: object with keys {$$typeof, render})". Normalising
  // here rather than at the call sites is the fix, because the next drawer
  // added would have hit the identical trap.
  const iconNode = isValidElement(icon)
    ? icon
    : icon
      ? createElement(icon, { className: 'h-4 w-4 text-ink-400', strokeWidth: 1.75 })
      : null

  return (
    // THE PANEL STARTS BELOW THE NAVBAR, it does not cover it. Anchored at
    // inset-0 the header slid under the fixed bar, which clipped the panel's
    // own title and close control and left the product chrome half hidden
    // behind a dimmed overlay. Keeping the bar visible also keeps it usable:
    // search and the account menu stay reachable while a panel is open, which
    // is how Cloudscape's split panel and Okta's side panels behave.
    <div
      className={clsx('fixed inset-x-0 bottom-0 z-40 flex justify-end', NAVBAR_BELOW_CLASS)}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : 'Details'}
    >
      <div
        className="animate-overlay-in absolute inset-0 bg-slate-950/40 backdrop-blur-[2px] dark:bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={clsx(
          'animate-panel-in relative flex h-full w-full flex-col border-l border-surface-700 bg-surface-900 shadow-overlay',
          width === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg'
        )}
      >
        <header className="flex flex-none items-start gap-3 border-b border-surface-800 px-5 py-4">
          {iconNode && (
            <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-850">
              {iconNode}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-ink-50">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate font-mono text-xs text-ink-500">{subtitle}</p>}
          </div>
          <IconButton icon={X} onClick={onClose} aria-label="Close" title="Close" />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer && (
          <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-surface-800 bg-surface-850/50 px-5 py-3">
            {footer}
          </footer>
        )}
      </aside>
    </div>
  )
}
