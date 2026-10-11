import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { backend } from '../../backend'
import { IconChevronRight, IconReceipt } from '../../components/icons'
import { DemoRibbon, StudentHeader } from '../../components/StudentShell'
import { Banner, Button, EmptyState, PaymentBadge, Spinner, StatusBadge } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { dateLabel, money, orderCode, timeOfDay } from '../../lib/format'
import { OPEN_STATUSES, paymentDisplay } from '../../lib/orderRules'
import type { CustomerOrder } from '../../lib/types'
import { myOrderRefs } from '../../state/device'

export function MyOrdersPage() {
  const [orders, setOrders] = useState<CustomerOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setError(null)
    try {
      const refs = myOrderRefs()
      const list = await backend.getOrders(refs.map((r) => ({ id: r.id, token: r.token })))
      setOrders(list.sort((a, b) => b.created_at.localeCompare(a.created_at)))
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const active = orders?.filter((o) => OPEN_STATUSES.includes(o.status)) ?? []
  const past = orders?.filter((o) => !OPEN_STATUSES.includes(o.status)) ?? []

  return (
    <div className="min-h-dvh pb-12">
      <DemoRibbon />
      <StudentHeader back="/" title="My orders" right={<span />} />
      <main className="mx-auto max-w-3xl px-4 pt-4">
        {error && (
          <Banner tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>
            {error}
          </Banner>
        )}
        {!orders && !error && <div className="grid place-items-center py-20"><Spinner label="Loading your orders" /></div>}
        {orders && orders.length === 0 && (
          <EmptyState icon={<IconReceipt />} title="No orders on this phone yet" action={<Link to="/" viewTransition className="inline-flex min-h-11 items-center rounded-xl bg-brand px-4 font-bold text-ink hover:bg-brand-strong">Browse the menu</Link>}>
            Orders you place on this phone show up here so you can track them.
          </EmptyState>
        )}
        {active.length > 0 && <OrderList title="In progress" orders={active} />}
        {past.length > 0 && <OrderList title="Earlier" orders={past} />}
        {orders && orders.length > 0 && (
          <p className="mt-6 text-center text-xs text-muted">Only orders placed on this phone appear here (last 20).</p>
        )}
      </main>
    </div>
  )
}

function OrderList({ title, orders }: { title: string; orders: CustomerOrder[] }) {
  return (
    <section className="mt-4">
      <h2 className="text-sm font-extrabold tracking-wider text-muted uppercase">{title}</h2>
      <ul className="mt-2 space-y-2">
        {orders.map((o, i) => (
          <li key={o.id} className="animate-rise" style={{ animationDelay: `${Math.min(i * 60, 360)}ms` }}>
            <Link to={`/order/${o.id}`} viewTransition className="card flex items-center gap-3 p-4 transition-colors hover:border-line-strong">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tabular font-extrabold">{orderCode(o.order_no)}</span>
                  <StatusBadge status={o.status} />
                  {o.status !== 'cancelled' && <PaymentBadge display={paymentDisplay(o)} method={o.payment_method} />}
                </div>
                <p className="mt-1 truncate text-sm text-muted">
                  {o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                </p>
                <p className="mt-0.5 text-xs text-subtle">
                  {dateLabel(o.created_at)}, {timeOfDay(o.created_at)}
                </p>
              </div>
              <span className="tabular font-bold">{money(o.total)}</span>
              <IconChevronRight className="text-subtle" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
