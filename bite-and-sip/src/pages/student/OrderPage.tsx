import { useEffect, useRef, useState } from 'react'
import { CheckBurst, Confetti } from '../../components/Celebrate'
import { Link, useLocation, useParams } from 'react-router-dom'
import { backend } from '../../backend'
import { IconCheck, IconCopy, IconExternal, IconRefresh, IconWifiOff } from '../../components/icons'
import { QrImage } from '../../components/QrImage'
import { DemoRibbon, StudentHeader } from '../../components/StudentShell'
import { Banner, Button, Dialog, EmptyState, PaymentBadge, Spinner, useToast } from '../../components/ui'
import { useOrderTracking } from '../../hooks/useOrderTracking'
import { friendlyError } from '../../lib/errors'
import { money, orderCode, timeOfDay } from '../../lib/format'
import { canCustomerCancel, paymentDisplay, STATUS_MESSAGE, STUDENT_STEPS } from '../../lib/orderRules'
import type { CustomerOrder } from '../../lib/types'
import { buildUpiLink } from '../../lib/upi'
import { tokenFor } from '../../state/device'
import { usePublicData } from '../../state/publicData'

export function OrderPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const justPlaced = (location.state as { justPlaced?: boolean } | null)?.justPlaced
  const token = tokenFor(id)
  const { order, setOrder, error, live, lastSync, refetch } = useOrderTracking(id, token)
  const prevStatus = useRef<string | null>(null)
  // Celebrate a freshly placed order once, and again when it turns ready.
  // (Only for an order placed in the last minute, so a page refresh doesn't replay it.)
  const [celebrate, setCelebrate] = useState(0)
  const freshOrder = !!order && Date.now() - new Date(order.created_at).getTime() < 60_000
  const celebratedPlacement = useRef(false)
  useEffect(() => {
    if (justPlaced && freshOrder && !celebratedPlacement.current) {
      celebratedPlacement.current = true
      setCelebrate((c) => c + 1)
    }
  }, [justPlaced, freshOrder])

  // Nudge the student when the order becomes ready.
  useEffect(() => {
    if (!order) return
    if (prevStatus.current && prevStatus.current !== 'ready' && order.status === 'ready') {
      setCelebrate((c) => c + 1)
      try {
        navigator.vibrate?.([200, 100, 200])
      } catch {
        /* not supported */
      }
    }
    prevStatus.current = order.status
    document.title = order.status === 'ready' ? `Ready! ${orderCode(order.order_no)} · Bite & Sip` : `${orderCode(order.order_no)} · Bite & Sip`
    return () => {
      document.title = 'Bite & Sip'
    }
  }, [order])

  if (!token || error === 'order_not_found') {
    return (
      <>
        <DemoRibbon />
        <StudentHeader back="/" title="Order" />
        <EmptyState title="This order isn’t on this phone" action={<Link to="/" className="font-bold underline underline-offset-4">Back to the menu</Link>}>
          Orders can only be opened on the phone that placed them. If you need help, show your order number at the counter.
        </EmptyState>
      </>
    )
  }

  if (!order) {
    return (
      <>
        <DemoRibbon />
        <StudentHeader back="/" title="Order" />
        <div className="grid place-items-center gap-4 py-24">
          {error ? (
            <EmptyState icon={<IconWifiOff />} title="Couldn’t load your order" action={<Button onClick={() => void refetch()}>Try again</Button>}>
              {friendlyError(new Error(error))}
            </EmptyState>
          ) : (
            <Spinner label="Loading your order" />
          )}
        </div>
      </>
    )
  }

  const msg = STATUS_MESSAGE[order.status]
  const code = orderCode(order.order_no)

  return (
    <div className="min-h-dvh pb-12">
      <DemoRibbon />
      <StudentHeader back="/" title={`Order ${code}`} />
      <main className="mx-auto max-w-3xl space-y-4 px-4 pt-4">
        {justPlaced && freshOrder && order.status === 'placed' && (
          <Banner tone="success" title="Order placed!">
            Keep this page open — it updates by itself.
          </Banner>
        )}

        <div className="relative">
        {celebrate > 0 && <Confetti key={`c${celebrate}`} count={order.status === 'ready' ? 34 : 26} />}
        <section
          key={`hero-${order.status === 'ready' ? 'ready' : 'base'}`}
          className={`card overflow-hidden transition-colors duration-500 ${order.status === 'ready' ? 'animate-pop border-ink bg-brand' : ''}`}
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="px-5 pt-5 pb-4 text-center">
            {justPlaced && freshOrder && order.status === 'placed' && <CheckBurst className="mx-auto mb-2 size-14" />}
            <p className="text-sm font-bold tracking-wider text-ink-2 uppercase">Order number</p>
            <p className="tabular mt-1 text-5xl font-extrabold tracking-tight">{code}</p>
            <p className="mt-1 text-sm font-semibold text-ink-2">
              {order.customer_name}
              {order.table_label && <> · Table {order.table_label}</>}
            </p>
            <h2 className={`mt-4 text-2xl font-extrabold ${order.status === 'cancelled' ? 'text-danger' : ''}`}>{msg.title}</h2>
            <p className="mt-1 text-[15px] text-ink-2">
              {order.status === 'cancelled'
                ? order.cancelled_by === 'customer'
                  ? 'You cancelled this order.'
                  : `The café cancelled this order${order.cancel_reason ? `: ${order.cancel_reason}` : '.'}`
                : msg.body}
            </p>
          </div>
          {order.status !== 'cancelled' && <Steps order={order} />}
        </section>
        </div>

        <PaymentCard order={order} onUpdated={setOrder} />

        <section className="card p-4" aria-labelledby="summary-h">
          <h2 id="summary-h" className="font-extrabold">Your order</h2>
          <ul className="mt-2 divide-y divide-line">
            {order.items.map((l, i) => (
              <li key={i} className="flex gap-3 py-2.5 text-[15px]">
                <span className="tabular w-7 shrink-0 font-bold">{l.quantity}×</span>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{l.name}</span>
                  {l.addons.length > 0 && <span className="block text-sm text-muted">+ {l.addons.map((a) => a.name).join(', ')}</span>}
                  {l.note && <span className="block text-sm text-muted italic">“{l.note}”</span>}
                </span>
                <span className="tabular font-semibold">{money(l.line_total)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between border-t border-line pt-3">
            <span className="font-extrabold">Total</span>
            <span className="tabular text-xl font-extrabold">{money(order.total)}</span>
          </div>
          <p className="mt-1 text-xs text-muted">Placed at {timeOfDay(order.created_at)}</p>
        </section>

        <CancelSection order={order} onUpdated={setOrder} />

        <LiveIndicator live={live} lastSync={lastSync} onRefresh={() => void refetch()} final={order.status === 'completed' || order.status === 'cancelled'} />
      </main>
    </div>
  )
}

function Steps({ order }: { order: CustomerOrder }) {
  const idx = STUDENT_STEPS.findIndex((s) => s.status === order.status)
  const times: Record<string, string | null> = {
    placed: order.created_at, preparing: order.preparing_at, ready: order.ready_at, completed: order.completed_at,
  }
  return (
    <ol className="grid grid-cols-4 border-t border-ink/10 bg-surface/60 px-2 py-3">
      {STUDENT_STEPS.map((s, i) => {
        const done = i <= idx
        const current = i === idx
        return (
          <li key={s.status} className="relative flex flex-col items-center text-center" aria-current={current ? 'step' : undefined}>
            {i > 0 && (
              <span className="absolute top-3.5 right-1/2 h-0.5 w-full bg-line-strong" aria-hidden="true">
                <span className={`block h-full bg-ink transition-[width] duration-700 ease-out ${i <= idx ? 'w-full' : 'w-0'}`} />
              </span>
            )}
            <span
              className={`relative z-10 grid size-7 place-items-center rounded-full border-2 transition-colors duration-500 ${
                done ? 'border-ink bg-ink text-brand' : 'border-line-strong bg-surface text-transparent'
              } ${current && s.status !== 'completed' ? 'animate-pulse-ring' : ''}`}
            >
              <IconCheck size={14} strokeWidth={3.5} />
            </span>
            <span className={`mt-1.5 text-xs font-bold ${done ? 'text-ink' : 'text-subtle'}`}>{s.label}</span>
            <span className="tabular text-[11px] text-muted">{done ? timeOfDay(times[s.status]) : ''}</span>
            <span className="sr-only">{done ? (current ? '(current step)' : '(done)') : '(upcoming)'}</span>
          </li>
        )
      })}
    </ol>
  )
}

function PaymentCard({ order, onUpdated }: { order: CustomerOrder; onUpdated: (o: CustomerOrder) => void }) {
  const { data } = usePublicData()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const display = paymentDisplay(order)
  const settings = data?.settings
  const code = orderCode(order.order_no)

  if (order.status === 'cancelled') {
    if (order.payment_status !== 'paid' && !order.customer_reported_paid_at) return null
    return (
      <Banner tone="warning" title="Refund">
        If you already paid for this order, show your order number at the counter to get your money back.
      </Banner>
    )
  }

  const upiLink =
    order.payment_method === 'upi' && settings?.upi_id
      ? buildUpiLink({ upiId: settings.upi_id, payeeName: settings.upi_payee_name, amount: order.total, note: `Bite & Sip ${code}` })
      : null

  async function reportPaid() {
    const token = tokenFor(order.id)
    if (!token) return
    setBusy(true)
    try {
      onUpdated(await backend.reportUpiPayment(order.id, token))
      toast('Thanks! Staff will confirm your payment.', 'success')
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card p-4" aria-labelledby="pay-h">
      <div className="flex items-center justify-between gap-3">
        <h2 id="pay-h" className="font-extrabold">Payment</h2>
        <PaymentBadge display={display} method={order.payment_method} />
      </div>

      {display === 'cash_due' && (
        <p className="mt-2 text-[15px]">
          Pay <strong className="tabular">{money(order.total)}</strong> in cash at the counter when you collect your order.
        </p>
      )}

      {display === 'paid' && (
        <p className="mt-2 text-[15px]">
          {order.payment_method === 'cash' ? 'Paid in cash.' : 'Your UPI payment was confirmed by the café.'} Thank you!
        </p>
      )}

      {(display === 'upi_pending' || (display === 'upi_verifying' && showQr)) && (
        <div className="mt-3">
          {upiLink ? (
            <>
              <ol className="space-y-1 text-[15px]">
                <li>
                  1. Pay <strong className="tabular">{money(order.total)}</strong> to <strong>{settings?.upi_payee_name}</strong>.
                </li>
                <li>2. Come back here and tap “I’ve paid”.</li>
                <li>3. Staff check the payment before handing over your food.</li>
              </ol>
              <a
                href={upiLink}
                className="mt-4 flex min-h-13 w-full items-center justify-center gap-2 rounded-2xl bg-ink px-5 font-extrabold text-white sm:hidden"
              >
                Pay {money(order.total)} with a UPI app <IconExternal size={18} />
              </a>
              <div className="mt-4 flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface p-4">
                <QrImage text={upiLink} size={200} alt={`UPI QR code to pay ${money(order.total)} to ${settings?.upi_payee_name}`} />
                <p className="text-center text-sm text-muted">Scan with any UPI app — the amount is filled in for you.</p>
                <CopyRow label="UPI ID" value={settings!.upi_id!} />
              </div>
            </>
          ) : (
            <Banner tone="warning">UPI details aren’t available right now. You can pay at the counter instead.</Banner>
          )}
          {display === 'upi_pending' && (
            <Button variant="secondary" size="lg" className="mt-4 w-full border-ink" loading={busy} onClick={() => void reportPaid()}>
              I’ve paid
            </Button>
          )}
        </div>
      )}

      {display === 'upi_verifying' && (
        <div className="mt-2 space-y-2 text-[15px]">
          <p>
            <strong>Waiting for the café to confirm your payment.</strong> They check it in their UPI account before handing over your food.
          </p>
          <p className="text-sm text-muted">If they can’t find it, they’ll ask you at the counter — keep your UPI app handy.</p>
          {!showQr && (
            <button type="button" className="text-sm font-bold underline underline-offset-4" onClick={() => setShowQr(true)}>
              Haven’t paid yet? Show the QR again
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const toast = useToast()
  return (
    <div className="flex w-full items-center gap-2 rounded-xl bg-sunken px-3 py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate font-bold">{value}</span>
      <button
        type="button"
        className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 font-bold hover:bg-line"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => toast('UPI ID copied', 'success'),
            () => toast('Couldn’t copy — please copy it manually', 'error'),
          )
        }}
      >
        <IconCopy size={16} /> Copy
      </button>
    </div>
  )
}

function CancelSection({ order, onUpdated }: { order: CustomerOrder; onUpdated: (o: CustomerOrder) => void }) {
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!canCustomerCancel(order)) return null

  async function cancel() {
    const token = tokenFor(order.id)
    if (!token) return
    setBusy(true)
    try {
      onUpdated(await backend.cancelMyOrder(order.id, token))
      toast('Order cancelled')
      setConfirm(false)
    } catch (err) {
      toast(friendlyError(err), 'error')
      setConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="text-center">
        <button type="button" className="min-h-11 px-3 text-sm font-bold text-danger underline underline-offset-4" onClick={() => setConfirm(true)}>
          Cancel this order
        </button>
        <p className="text-xs text-muted">You can cancel until the kitchen starts preparing it.</p>
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Cancel this order?"
        size="sm"
        footer={
          <div className="flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setConfirm(false)}>Keep order</Button>
            <Button variant="danger" className="flex-1" loading={busy} onClick={() => void cancel()}>Cancel order</Button>
          </div>
        }
      >
        <p className="px-5 py-4 text-[15px]">
          {orderCode(order.order_no)} · {money(order.total)}. The kitchen hasn’t started it yet.
        </p>
      </Dialog>
    </>
  )
}

function LiveIndicator({ live, lastSync, onRefresh, final }: { live: string; lastSync: number | null; onRefresh: () => void; final: boolean }) {
  if (final) return null
  return (
    <div className="flex items-center justify-center gap-2 pt-2 text-sm text-muted">
      <span className={`size-2 rounded-full ${live === 'live' ? 'bg-ready' : 'bg-brand-strong'}`} aria-hidden="true" />
      <span>
        {live === 'live' ? 'Live updates on' : 'Reconnecting — checking every few seconds'}
        {lastSync && ` · updated ${timeOfDay(new Date(lastSync).toISOString())}`}
      </span>
      <button type="button" onClick={onRefresh} className="grid size-9 place-items-center rounded-full hover:bg-sunken" aria-label="Refresh order status">
        <IconRefresh size={16} />
      </button>
    </div>
  )
}
