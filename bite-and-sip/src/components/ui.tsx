import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type ReactNode,
} from 'react'
import { PAYMENT_LABEL, STATUS_LABEL, type PaymentDisplay } from '../lib/orderRules'
import type { OrderStatus } from '../lib/types'
import { IconAlert, IconCheck, IconInfo, IconMinus, IconPlus, IconX } from './icons'

// ---- Button -----------------------------------------------------------------
type Variant = 'primary' | 'dark' | 'secondary' | 'ghost' | 'danger' | 'success'
type Size = 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-ink hover:bg-brand-strong active:bg-brand-strong disabled:bg-brand/50 disabled:text-ink/50',
  dark: 'bg-ink text-white hover:bg-ink-2 disabled:bg-ink/40',
  secondary: 'border border-field bg-surface text-ink hover:bg-sunken disabled:text-subtle',
  ghost: 'text-ink-2 hover:bg-sunken disabled:text-subtle',
  danger: 'border border-danger/30 bg-surface text-danger hover:bg-danger-soft disabled:opacity-50',
  success: 'bg-ready text-white hover:bg-ready/90 disabled:bg-ready/40',
}
const SIZES: Record<Size, string> = {
  sm: 'min-h-9 px-3 text-sm gap-1.5 rounded-lg',
  md: 'min-h-11 px-4 text-[15px] gap-2 rounded-xl',
  lg: 'min-h-13 px-5 text-base gap-2 rounded-2xl',
}

export function Button({
  variant = 'primary', size = 'md', loading = false, className = '', children, disabled, type = 'button', ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center font-bold transition-colors select-none ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  )
}

export function Spinner({ className = 'size-5', label }: { className?: string; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex items-center">
      <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".2" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label && <span className="sr-only">{label}</span>}
    </span>
  )
}

// ---- Badges -----------------------------------------------------------------
const STATUS_STYLE: Record<OrderStatus, string> = {
  placed: 'bg-placed-soft text-placed',
  preparing: 'bg-preparing-soft text-preparing',
  ready: 'bg-ready-soft text-ready',
  completed: 'bg-done-soft text-done',
  cancelled: 'bg-danger-soft text-danger',
}

export function StatusBadge({ status, label }: { status: OrderStatus; label?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_STYLE[status]}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {label ?? STATUS_LABEL[status]}
    </span>
  )
}

const PAYMENT_STYLE: Record<PaymentDisplay, string> = {
  cash_due: 'border border-field bg-surface text-ink-2',
  upi_pending: 'border border-field bg-surface text-ink-2',
  upi_verifying: 'bg-brand-soft text-ink ring-1 ring-brand-strong',
  paid: 'bg-ready-soft text-ready',
}

export function PaymentBadge({ display, method }: { display: PaymentDisplay; method?: 'cash' | 'upi' }) {
  const label = display === 'paid' && method ? `Paid · ${method === 'cash' ? 'Cash' : 'UPI'}` : PAYMENT_LABEL[display]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${PAYMENT_STYLE[display]}`}>
      {display === 'paid' && <IconCheck size={13} strokeWidth={3} />}
      {display === 'upi_verifying' && <IconAlert size={13} strokeWidth={2.5} />}
      {label}
    </span>
  )
}

export function VegMark({ veg }: { veg: boolean }) {
  return (
    <span
      title={veg ? 'Vegetarian' : 'Non-vegetarian'}
      className={`inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] border-[1.5px] bg-white ${veg ? 'border-veg' : 'border-nonveg'}`}
    >
      {veg ? (
        <span className="size-2 rounded-full bg-veg" />
      ) : (
        <span className="size-0 border-x-[4px] border-b-[7px] border-x-transparent border-b-nonveg" />
      )}
      <span className="sr-only">{veg ? 'Vegetarian' : 'Non-vegetarian'}</span>
    </span>
  )
}

// ---- Banner -----------------------------------------------------------------
export function Banner({
  tone = 'info', title, children, action, className = '',
}: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const style = {
    info: 'bg-sunken text-ink-2 border-line',
    warning: 'bg-brand-soft text-ink border-brand-strong/40',
    danger: 'bg-danger-soft text-danger border-danger/25',
    success: 'bg-ready-soft text-ready border-ready/25',
  }[tone]
  const Icon = tone === 'success' ? IconCheck : tone === 'info' ? IconInfo : IconAlert
  return (
    <div role={tone === 'danger' ? 'alert' : undefined} className={`flex gap-3 rounded-2xl border p-3.5 text-sm ${style} ${className}`}>
      <Icon size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-bold">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-4 grid size-16 place-items-center rounded-full bg-brand-soft text-ink">{icon}</div>}
      <h2 className="text-lg font-extrabold">{title}</h2>
      {children && <div className="mt-1.5 max-w-sm text-sm text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

// ---- Quantity stepper ---------------------------------------------------------
export function QuantityStepper({
  value, onChange, min = 1, max = 20, label, size = 'md',
}: { value: number; onChange: (v: number) => void; min?: number; max?: number; label: string; size?: 'sm' | 'md' }) {
  const btn = size === 'sm' ? 'size-8' : 'size-10'
  return (
    <div className="inline-flex items-center rounded-full border border-field bg-surface" role="group" aria-label={label}>
      <button
        type="button"
        className={`${btn} grid place-items-center rounded-full text-ink hover:bg-sunken disabled:text-subtle`}
        onClick={() => onChange(value - 1)}
        disabled={value <= min}
        aria-label={value <= 1 && min === 0 ? `Remove ${label}` : `Decrease ${label}`}
      >
        <IconMinus size={size === 'sm' ? 16 : 18} strokeWidth={2.5} />
      </button>
      <span className={`tabular min-w-7 text-center font-bold ${size === 'sm' ? 'text-sm' : ''}`} aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className={`${btn} grid place-items-center rounded-full text-ink hover:bg-sunken disabled:text-subtle`}
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label={`Increase ${label}`}
      >
        <IconPlus size={size === 'sm' ? 16 : 18} strokeWidth={2.5} />
      </button>
    </div>
  )
}

// ---- Switch -----------------------------------------------------------------
export function Switch({
  checked, onChange, label, disabled, describedBy,
}: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; describedBy?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-ready' : 'bg-line-strong'}`}
    >
      <span className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}

// ---- Dialog / bottom sheet ------------------------------------------------------
export function Dialog({
  open, onClose, title, children, footer, size = 'md', sheet = true, labelledBy,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** Bottom sheet on phones, centred dialog on larger screens. */
  sheet?: boolean
  labelledBy?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      document.documentElement.style.overflow = 'hidden'
    } else if (!open && d.open) {
      d.close()
    }
    return () => {
      document.documentElement.style.overflow = ''
    }
  }, [open])

  useEffect(() => {
    const d = ref.current
    if (!d) return
    const cancel = (e: Event) => {
      e.preventDefault()
      onCloseRef.current()
    }
    d.addEventListener('cancel', cancel)
    return () => d.removeEventListener('cancel', cancel)
  }, [])

  const width = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl' }[size]
  const position = sheet
    ? 'mt-auto mb-0 w-full max-w-none rounded-t-3xl sm:m-auto sm:rounded-3xl'
    : 'm-auto w-[calc(100%-2rem)] rounded-3xl'

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
      className={`${position} ${width} max-h-[92dvh] overflow-hidden bg-surface p-0 text-ink shadow-[var(--shadow-float)] backdrop:bg-ink/50 open:flex open:flex-col open:animate-slide-up`}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      {open && (
        <>
          {title && (
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <h2 id={titleId} className="text-lg font-extrabold">{title}</h2>
              <button type="button" onClick={onClose} className="-m-2 grid size-10 shrink-0 place-items-center rounded-full hover:bg-sunken" aria-label="Close">
                <IconX />
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
          {footer && <div className="border-t border-line bg-surface px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
        </>
      )}
    </dialog>
  )
}

// ---- Toasts -----------------------------------------------------------------
interface Toast {
  id: number
  message: string
  tone: 'default' | 'success' | 'error'
}
const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const counter = useRef(0)
  const push = useCallback((message: string, tone: Toast['tone'] = 'default') => {
    const id = ++counter.current
    setToasts((t) => [...t.slice(-2), { id, message, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500)
  }, [])
  const value = useMemo(() => push, [push])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 sm:top-3 sm:bottom-auto">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`animate-slide-up pointer-events-auto flex max-w-md items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold shadow-[var(--shadow-float)] ${
              t.tone === 'error' ? 'bg-danger text-white' : 'bg-ink text-white'
            }`}
          >
            {t.tone === 'success' && <IconCheck size={18} className="text-brand" strokeWidth={3} />}
            {t.tone === 'error' && <IconAlert size={18} />}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

// ---- Brand ------------------------------------------------------------------
export function Wordmark({ className = '', subtitle = true, onDark = false }: { className?: string; subtitle?: boolean; onDark?: boolean }) {
  return (
    <span className={`inline-flex flex-col leading-none ${className}`}>
      <span className="text-[1.35em] font-extrabold tracking-tight">
        Bite <span className={onDark ? 'text-brand' : 'text-brand-ink'}>&amp;</span> Sip
      </span>
      {subtitle && (
        <span className={`mt-1 text-[0.55em] font-bold tracking-[0.28em] uppercase ${onDark ? 'text-white/65' : 'text-muted'}`}>College Café</span>
      )}
    </span>
  )
}
