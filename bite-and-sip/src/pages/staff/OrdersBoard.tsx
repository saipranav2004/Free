import { useEffect, useMemo, useRef, useState } from 'react'
import { backend } from '../../backend'
import { IconBell, IconBellOff, IconPhone, IconPin, IconRefresh } from '../../components/icons'
import { Banner, Button, Dialog, PaymentBadge, Spinner, StatusBadge, useToast } from '../../components/ui'
import { Chime, useStaffOrders } from '../../hooks/useStaffOrders'
import { friendlyError, toAppError } from '../../lib/errors'
import { minutesSince, money, orderCode, timeOfDay } from '../../lib/format'
import { canMarkPaid, canRevertPayment, paymentDisplay } from '../../lib/orderRules'
import { readJson, writeJson } from '../../lib/storage'
import type { OrderStatus, StaffOrder } from '../../lib/types'
import { useStaffSession } from '../../state/staffSession'

type Column = 'placed' | 'preparing' | 'ready'
const COLUMNS: { status: Column; title: string; empty: string }[] = [
  { status: 'placed', title: 'New', empty: 'No new orders.' },
  { status: 'preparing', title: 'Preparing', empty: 'Nothing on the stove.' },
  { status: 'ready', title: 'Ready for pickup', empty: 'Nothing waiting at the counter.' },
]

const SOUND_KEY = 'bitesip-staff-sound'

export function OrdersBoard() {
  const toast = useToast()
  const chime = useRef(new Chime())
  const [soundWanted, setSoundWanted] = useState(() => readJson(SOUND_KEY, false))
  const [soundReady, setSoundReady] = useState(false)
  const [tab, setTab] = useState<Column>('placed')
  const [now, setNow] = useState(() => Date.now())
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set())
  const { orders, error, live, lastSync, refetch, applyRow } = useStaffOrders((fresh) => {
    setFreshIds((s) => new Set([...s, ...fresh.map((o) => o.id)]))
    setTimeout(() => setFreshIds((s) => new Set([...s].filter((id) => !fresh.some((o) => o.id === id)))), 4000)
    chime.current.play()
    toast(fresh.length === 1 ? `New order ${orderCode(fresh[0].order_no)}` : `${fresh.length} new orders`, 'success')
  })

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  const open = useMemo(() => (orders ?? []).filter((o) => o.status === 'placed' || o.status === 'preparing' || o.status === 'ready'), [orders])
  const byStatus = (s: Column) => open.filter((o) => o.status === s)
  const done = useMemo(
    () => (orders ?? []).filter((o) => o.status === 'completed' || o.status === 'cancelled').sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [orders],
  )
  const toVerify = open.filter((o) => paymentDisplay(o) === 'upi_verifying').length
  const newCount = byStatus('placed').length

  useEffect(() => {
    document.title = newCount ? `(${newCount}) New orders · Bite & Sip` : 'Orders · Bite & Sip'
    return () => {
      document.title = 'Bite & Sip'
    }
  }, [newCount])

  async function toggleSound() {
    if (soundWanted && soundReady) {
      setSoundWanted(false)
      setSoundReady(false)
      writeJson(SOUND_KEY, false)
      return
    }
    const ok = await chime.current.unlock()
    setSoundReady(ok)
    setSoundWanted(true)
    writeJson(SOUND_KEY, true)
    if (ok) chime.current.play()
    else toast('This browser blocked sound.', 'error')
  }

  if (!orders) {
    return (
      <div className="grid place-items-center py-24">
        {error ? (
          <Banner tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void refetch()}>Retry</Button>}>{error}</Banner>
        ) : (
          <Spinner label="Loading orders" />
        )}
      </div>
    )
  }

  return (
    <main className="mx-auto max-w-[1500px] px-3 pt-3 pb-10 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-extrabold">Orders</h1>
        {toVerify > 0 && (
          <span className="rounded-full bg-brand px-3 py-1.5 text-sm font-bold">
            {toVerify} UPI {toVerify === 1 ? 'payment' : 'payments'} to check
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-sm font-semibold ring-1 ring-line" role="status">
          <span className={`size-2 rounded-full ${live === 'live' ? 'bg-ready' : 'bg-brand-strong animate-pulse'}`} aria-hidden="true" />
          {live === 'live' ? 'Live' : 'Reconnecting…'}
          {lastSync && <span className="text-muted">· {timeOfDay(new Date(lastSync).toISOString())}</span>}
        </span>
        <Button size="sm" variant="secondary" onClick={() => void refetch()} aria-label="Refresh orders">
          <IconRefresh size={16} />
        </Button>
        <Button size="sm" variant={soundWanted && soundReady ? 'dark' : 'secondary'} onClick={() => void toggleSound()} aria-pressed={soundWanted && soundReady}>
          {soundWanted && soundReady ? <IconBell size={16} /> : <IconBellOff size={16} />}
          {soundWanted && !soundReady ? 'Tap to enable sound' : soundWanted ? 'Sound on' : 'Sound off'}
        </Button>
      </div>
      {error && <Banner tone="warning" className="mt-3">{error} Showing the last orders we loaded.</Banner>}

      {/* Phone / tablet: one column at a time */}
      <div className="mt-3 grid grid-cols-3 gap-1 rounded-2xl bg-surface p-1 ring-1 ring-line lg:hidden" role="tablist" aria-label="Order stages">
        {COLUMNS.map((c) => (
          <button
            key={c.status}
            type="button"
            role="tab"
            aria-selected={tab === c.status}
            onClick={() => setTab(c.status)}
            className={`min-h-11 rounded-xl px-2 text-sm font-bold ${tab === c.status ? 'bg-ink text-white' : 'text-ink-2 hover:bg-sunken'}`}
          >
            {c.title.replace(' for pickup', '')} <span className="tabular">({byStatus(c.status).length})</span>
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((c) => (
          <section key={c.status} aria-label={c.title} className={`${tab === c.status ? '' : 'hidden'} lg:block`}>
            <h2 className="mb-2 hidden items-center gap-2 text-sm font-extrabold tracking-wide text-ink-2 uppercase lg:flex">
              {c.title} <span className="tabular rounded-full bg-surface px-2 py-0.5 ring-1 ring-line">{byStatus(c.status).length}</span>
            </h2>
            <div className="space-y-3">
              {byStatus(c.status).length === 0 && (
                <p className="rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">{c.empty}</p>
              )}
              {byStatus(c.status).map((o) => (
                <OrderCard key={o.id} order={o} now={now} fresh={freshIds.has(o.id)} onChanged={applyRow} onConflict={() => void refetch()} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <DoneToday orders={done} />
    </main>
  )
}

function OrderCard({
  order, now, fresh, onChanged, onConflict,
}: { order: StaffOrder; now: number; fresh: boolean; onChanged: (o: StaffOrder) => void; onConflict: () => void }) {
  const toast = useToast()
  const { profile } = useStaffSession()
  const [busy, setBusy] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'verify' | 'cash' | 'cancel' | null>(null)
  const pay = paymentDisplay(order)
  const age = minutesSince(order.created_at, now)
  // Ticket timer: calm → amber → red (red reserved for genuinely overdue tickets).
  const [warnAt, lateAt] = order.status === 'placed' ? [3, 5] : order.status === 'preparing' ? [12, 20] : [10, 20]
  const timerStyle = age >= lateAt ? 'bg-danger text-white' : age >= warnAt ? 'bg-brand text-ink' : 'bg-sunken text-ink-2'

  async function run(key: string, fn: () => Promise<StaffOrder>, success?: string) {
    if (busy) return
    setBusy(key)
    try {
      const row = await fn()
      onChanged(row)
      if (success) toast(success, 'success')
      setDialog(null)
    } catch (err) {
      const e = toAppError(err)
      toast(friendlyError(e), 'error')
      if (e.code === 'conflict' || e.code === 'invalid_transition') {
        setDialog(null)
        onConflict()
      }
    } finally {
      setBusy(null)
    }
  }

  const change = (to: OrderStatus, extra: { markPaid?: boolean; reason?: string } = {}) =>
    backend.changeStatus(order.id, { from: order.status, to, ...extra })

  return (
    <article
      className={`card overflow-hidden ${fresh ? 'animate-rise-flash' : 'animate-rise'} ${pay === 'upi_verifying' ? 'ring-2 ring-brand-strong' : ''}`}
      aria-label={`Order ${orderCode(order.order_no)} for ${order.customer_name}`}
    >
      <header className="flex items-start gap-3 border-b border-line px-4 pt-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tabular text-2xl font-extrabold tracking-tight">{orderCode(order.order_no)}</span>
            <StatusBadge status={order.status} />
          </div>
          <p className="mt-0.5 truncate font-bold">{order.customer_name}</p>
          <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted">
            <span className="inline-flex items-center gap-1">
              <IconPhone size={13} /> ••{order.customer_phone.slice(-4)}
            </span>
            {order.table_label && (
              <span className="inline-flex items-center gap-1">
                <IconPin size={13} /> {order.table_label}
              </span>
            )}
          </p>
        </div>
        <div className="text-right">
          <p className={`tabular inline-block rounded-lg px-2 py-0.5 text-sm font-extrabold ${timerStyle}`} title="Time since the order was placed">
            {age < 1 ? 'Now' : `${age} min`}
          </p>
          <p className="tabular mt-0.5 text-xs text-subtle">{timeOfDay(order.created_at)}</p>
        </div>
      </header>

      <ul className="space-y-1.5 px-4 py-3">
        {order.items.map((l, i) => (
          <li key={i} className="flex gap-2 text-[15px] leading-snug">
            <span className="tabular w-7 shrink-0 font-extrabold">{l.quantity}×</span>
            <span className="min-w-0">
              <span className="font-bold">{l.name}</span>
              {l.addons.length > 0 && <span className="block text-sm text-ink-2">+ {l.addons.map((a) => a.name).join(', ')}</span>}
              {l.note && <span className="mt-0.5 block rounded-md bg-brand-soft px-1.5 py-0.5 text-sm font-semibold">Note: {l.note}</span>}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
        <span className="tabular text-lg font-extrabold">{money(order.total)}</span>
        <PaymentBadge display={pay} method={order.payment_method} />
        {order.payment_reference && <span className="text-xs text-muted">Ref {order.payment_reference}</span>}
      </div>

      <footer className="flex flex-wrap gap-2 bg-sunken/60 px-4 py-3">
        {order.status === 'placed' && (
          <Button className="flex-1" loading={busy === 'prep'} disabled={!!busy} onClick={() => void run('prep', () => change('preparing'))}>
            Start preparing
          </Button>
        )}
        {order.status === 'preparing' && (
          <Button variant="success" className="flex-1" loading={busy === 'ready'} disabled={!!busy} onClick={() => void run('ready', () => change('ready'), `${orderCode(order.order_no)} is ready`)}>
            Mark ready
          </Button>
        )}
        {order.status === 'ready' && order.payment_status === 'paid' && (
          <Button variant="dark" className="flex-1" loading={busy === 'done'} disabled={!!busy} onClick={() => void run('done', () => change('completed'), 'Handed over')}>
            Hand over
          </Button>
        )}
        {order.status === 'ready' && order.payment_status === 'unpaid' && order.payment_method === 'cash' && (
          <Button variant="dark" className="flex-1" disabled={!!busy} onClick={() => setDialog('cash')}>
            Collect {money(order.total)} & hand over
          </Button>
        )}
        {order.payment_method === 'upi' && canMarkPaid(order) && (
          <Button
            variant={order.status === 'ready' ? 'primary' : 'secondary'}
            className={order.status === 'ready' ? 'flex-1' : ''}
            disabled={!!busy}
            onClick={() => setDialog('verify')}
          >
            Check UPI payment
          </Button>
        )}
        {order.payment_method === 'cash' && canMarkPaid(order) && order.status !== 'ready' && (
          <Button variant="ghost" size="md" disabled={!!busy} onClick={() => setDialog('cash')}>
            Paid already
          </Button>
        )}
        {profile && canRevertPayment(profile.role, order) && (
          <Button
            variant="ghost"
            disabled={!!busy}
            loading={busy === 'undo'}
            onClick={() => void run('undo', () => backend.setPayment(order.id, false), 'Payment marked unpaid')}
          >
            Undo payment
          </Button>
        )}
        {(order.status === 'placed' || order.status === 'preparing' || order.status === 'ready') && (
          <Button variant="ghost" className="text-danger" disabled={!!busy} onClick={() => setDialog('cancel')}>
            Cancel
          </Button>
        )}
      </footer>

      <VerifyUpiDialog
        key={dialog === 'verify' ? 'verify-open' : 'verify'}
        open={dialog === 'verify'}
        order={order}
        busy={busy === 'verify'}
        onClose={() => setDialog(null)}
        onConfirm={(ref) => void run('verify', () => backend.setPayment(order.id, true, ref), 'UPI payment confirmed')}
      />
      <CashDialog
        open={dialog === 'cash'}
        order={order}
        busy={busy === 'cash'}
        onClose={() => setDialog(null)}
        onConfirm={() =>
          void run(
            'cash',
            () => (order.status === 'ready' ? change('completed', { markPaid: true }) : backend.setPayment(order.id, true)),
            order.status === 'ready' ? 'Cash collected · handed over' : 'Marked as paid',
          )
        }
      />
      <CancelDialog
        key={dialog === 'cancel' ? 'cancel-open' : 'cancel'}
        open={dialog === 'cancel'}
        order={order}
        busy={busy === 'cancel'}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => void run('cancel', () => change('cancelled', { reason }), 'Order cancelled')}
      />
    </article>
  )
}

function OrderSummaryLine({ order }: { order: StaffOrder }) {
  return (
    <div className="rounded-2xl bg-sunken p-4 text-center">
      <p className="tabular text-3xl font-extrabold">{money(order.total)}</p>
      <p className="mt-1 text-sm text-muted">
        {orderCode(order.order_no)} · {order.customer_name} · ••{order.customer_phone.slice(-4)} · placed {timeOfDay(order.created_at)}
      </p>
    </div>
  )
}

function VerifyUpiDialog({
  open, order, busy, onClose, onConfirm,
}: { open: boolean; order: StaffOrder; busy: boolean; onClose: () => void; onConfirm: (reference: string) => void }) {
  const [reference, setReference] = useState('')
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Check the UPI payment"
      size="sm"
      footer={
        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onClose}>Not received</Button>
          <Button variant="success" className="flex-1" loading={busy} onClick={() => onConfirm(reference)}>
            Received {money(order.total)}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 px-5 py-4 text-[15px]">
        <OrderSummaryLine order={order} />
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Open the café’s UPI or bank app.</li>
          <li>Find a payment of <strong>{money(order.total)}</strong> received around {timeOfDay(order.customer_reported_paid_at ?? order.created_at)}.</li>
          <li>Only confirm if the money is in the café’s account. Don’t trust screenshots.</li>
        </ol>
        {order.customer_reported_paid_at ? (
          <p className="rounded-xl bg-brand-soft px-3 py-2 text-sm font-semibold">Customer tapped “I’ve paid” at {timeOfDay(order.customer_reported_paid_at)}.</p>
        ) : (
          <p className="rounded-xl bg-sunken px-3 py-2 text-sm">The customer hasn’t said they’ve paid yet.</p>
        )}
        <div>
          <label htmlFor={`ref-${order.id}`} className="label">UPI reference <span className="font-normal text-muted">(optional)</span></label>
          <input
            id={`ref-${order.id}`}
            className="field-input"
            maxLength={40}
            placeholder="e.g. last 4 digits of the UTR"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      </div>
    </Dialog>
  )
}

function CashDialog({ open, order, busy, onClose, onConfirm }: { open: boolean; order: StaffOrder; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const handover = order.status === 'ready'
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={handover ? 'Collect cash and hand over' : 'Mark as paid in cash'}
      size="sm"
      footer={
        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onClose}>Back</Button>
          <Button variant="dark" className="flex-1" loading={busy} onClick={onConfirm}>
            {handover ? `Collected ${money(order.total)}` : 'Mark paid'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 px-5 py-4 text-[15px]">
        <OrderSummaryLine order={order} />
        <p>{handover ? 'Take the cash, then hand over the order. This completes it.' : 'Use this if the customer paid at the counter before the food was ready.'}</p>
      </div>
    </Dialog>
  )
}

const REASONS = ['Item ran out', 'Customer asked to cancel', 'Customer didn’t collect', 'Kitchen closing']

function CancelDialog({
  open, order, busy, onClose, onConfirm,
}: { open: boolean; order: StaffOrder; busy: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  const [other, setOther] = useState('')
  const final = reason === 'Other' ? other.trim() : reason
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Cancel ${orderCode(order.order_no)}?`}
      size="sm"
      footer={
        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onClose}>Keep order</Button>
          <Button variant="danger" className="flex-1" disabled={!final} loading={busy} onClick={() => onConfirm(final)}>
            Cancel order
          </Button>
        </div>
      }
    >
      <fieldset className="space-y-2 px-5 py-4">
        <legend className="mb-2 text-[15px] font-bold">Why are you cancelling?</legend>
        {order.payment_status === 'paid' && (
          <Banner tone="warning">This order is paid. Refund {money(order.total)} to the customer — it will show under “Refunds due” in reports.</Banner>
        )}
        {[...REASONS, 'Other'].map((r) => (
          <label key={r} className={`flex min-h-11 items-center gap-3 rounded-xl border px-3 ${reason === r ? 'border-ink bg-brand-soft' : 'border-line'}`}>
            <input type="radio" name={`reason-${order.id}`} className="size-4 accent-ink" checked={reason === r} onChange={() => setReason(r)} />
            <span className="font-semibold">{r}</span>
          </label>
        ))}
        {reason === 'Other' && (
          <input className="field-input" aria-label="Reason" maxLength={140} placeholder="Reason shown to the customer" value={other} onChange={(e) => setOther(e.target.value)} />
        )}
        <p className="text-xs text-muted">The customer sees this reason on their order page.</p>
      </fieldset>
    </Dialog>
  )
}

function DoneToday({ orders }: { orders: StaffOrder[] }) {
  const [open, setOpen] = useState(false)
  if (orders.length === 0) return null
  const collected = orders.filter((o) => o.status === 'completed')
  return (
    <section className="mt-8">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-2xl bg-surface px-4 py-3 text-left font-bold ring-1 ring-line"
      >
        <span>
          Finished today · {collected.length} collected, {orders.length - collected.length} cancelled
        </span>
        <span className="text-sm text-muted">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="mt-2 overflow-x-auto rounded-2xl bg-surface ring-1 ring-line" tabIndex={0} role="region" aria-label="Finished orders (scrolls sideways)">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line text-xs text-muted uppercase">
              <tr>
                <th className="px-4 py-2.5">Order</th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Items</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Payment</th>
                <th className="px-4 py-2.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="tabular px-4 py-2.5 font-bold">
                    {orderCode(o.order_no)}
                    <span className="block text-xs font-normal text-muted">{timeOfDay(o.created_at)}</span>
                  </td>
                  <td className="px-4 py-2.5">{o.customer_name}</td>
                  <td className="max-w-64 truncate px-4 py-2.5 text-muted">{o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={o.status} />
                    {o.cancel_reason && <span className="block text-xs text-muted">{o.cancel_reason}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    {o.status === 'cancelled' && o.payment_status === 'paid' ? (
                      <span className="text-xs font-bold text-danger">Refund due</span>
                    ) : (
                      <PaymentBadge display={paymentDisplay(o)} method={o.payment_method} />
                    )}
                  </td>
                  <td className="tabular px-4 py-2.5 text-right font-bold">{money(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
