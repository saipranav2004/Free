import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { classNames } from '../../utils/format.js';

/**
 * Modal — the single dialog surface for every create / edit / attach flow.
 *
 * Enterprise dialog conventions applied here:
 *  · One column, generous field rhythm, no cramped side-by-side inputs
 *  · Header states the object + verb; description carries the consequence
 *  · Footer is sticky and right-aligned: cancel (quiet) then confirm (loud)
 *  · Long bodies scroll inside the dialog, never the page behind it
 *  · Escape closes; backdrop click does NOT (dialogs hold unsaved form data)
 *  · Focus moves into the dialog on open and returns to the trigger on close
 *
 * API is unchanged: { open, onClose, title, description, children, footer, size }
 * Optional additions: icon, tone, dismissOnBackdrop, bodyClassName.
 */
const SIZES = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-6xl',
  /**
   * `form` — the standard size for every create / attach / assign dialog.
   *
   * Enterprise dialogs must not resize themselves around their field count:
   * a one-combobox "Attach policy" and a five-field "Create user" should read
   * as the same object. This bucket pins the width AND (via BODY_SIZES below)
   * the body box, so the dialog is a consistent medium rectangle whether it
   * holds one dropdown or six inputs — and a combobox always has room to open.
   */
  form: 'max-w-[560px]',
};

// Body geometry per size. `form` is fixed-height by design; every other size
// keeps the original viewport-relative cap.
const BODY_SIZES = {
  form: 'min-h-[240px] max-h-[420px]',
};
const BODY_DEFAULT = 'max-h-[calc(100vh-16rem)]';

const TONES = {
  brand: 'bg-brand-50 text-brand-600',
  danger: 'bg-rose-50 text-rose-600',
  warning: 'bg-amber-50 text-amber-600',
  slate: 'bg-slate-100 text-slate-500',
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  icon: Icon,
  tone = 'brand',
  dismissOnBackdrop = false,
  bodyClassName,
}) {
  const panelRef = useRef(null);
  const restoreFocusRef = useRef(null);

  /**
   * Bug fix — focus jumping back to the first field while typing.
   *
   * Every call site passes an inline arrow for `onClose`
   * (`onClose={() => setOpen(false)}`), so the prop is a NEW function on every
   * render. With `onClose` in this effect's dependency list, the effect was
   * torn down and re-run on every keystroke that updated form state — which
   * re-armed the autofocus timer below and pulled the caret out of the field
   * being typed in and back into the dialog's first input.
   *
   * The handler is now held in a ref (always current, never a dependency) and
   * the effects below key on `open` alone, so autofocus runs exactly once per
   * opening.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Scroll lock + Escape + Tab containment. Runs once per open/close.
  useEffect(() => {
    if (!open) return undefined;

    restoreFocusRef.current = document.activeElement;
    const scrollbarComp = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPadding = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (scrollbarComp > 0) document.body.style.paddingRight = `${scrollbarComp}px`;

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      // Simple focus containment so Tab never escapes the dialog.
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPadding;
      if (restoreFocusRef.current instanceof HTMLElement) restoreFocusRef.current.focus?.();
    };
  }, [open]);

  // Initial focus — once per opening, and never steals focus from a field the
  // user has already moved to (a combobox opens its own input immediately).
  useEffect(() => {
    if (!open) return undefined;
    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      if (panel.contains(document.activeElement) && document.activeElement !== panel) return;
      const target = panel.querySelector(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [data-autofocus]'
      );
      (target || panel).focus?.();
    }, 40);
    return () => window.clearTimeout(focusTimer);
  }, [open]);

  if (!open) return null;

  const titleId = 'modal-title';

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-ink-900/45 p-4 backdrop-blur-[2px] animate-fade-in sm:p-6"
      onMouseDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="flex min-h-full items-start justify-center py-6 sm:py-10">
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={classNames(
            'w-full overflow-hidden rounded-2xl border border-line bg-white shadow-overlay outline-none animate-dialog-in',
            SIZES[size] || SIZES.md
          )}
        >
          {/* Header */}
          <div className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
            {Icon && (
              <span
                className={classNames(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  TONES[tone] || TONES.brand
                )}
              >
                <Icon className="h-4.5 w-4.5" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[15px] font-semibold text-ink-900">
                {title}
              </h2>
              {description && (
                <p className="mt-1 text-[13px] leading-relaxed text-slate-500">{description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-ink-700"
              aria-label="Close dialog"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div
            className={classNames(
              'overflow-y-auto px-5 py-5',
              BODY_SIZES[size] || BODY_DEFAULT,
              bodyClassName
            )}
          >
            {children}
          </div>

          {/* Footer */}
          {footer && (
            <div className="flex flex-col-reverse gap-2 border-t border-line-soft bg-slate-50/70 px-5 py-3.5 sm:flex-row sm:justify-end">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
