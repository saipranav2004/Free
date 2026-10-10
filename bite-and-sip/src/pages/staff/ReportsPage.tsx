import { useCallback, useEffect, useState } from 'react'
import { backend } from '../../backend'
import { IconDownload } from '../../components/icons'
import { Banner, Button, PaymentBadge, Spinner, StatusBadge } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { addDays, cafeDate, formatDay, hourLabel, money, orderCode, timeOfDay } from '../../lib/format'
import { paymentDisplay } from '../../lib/orderRules'
import { ordersToCsv } from '../../lib/reports'
import type { SalesSummary, StaffOrder } from '../../lib/types'

type Preset = 'today' | 'yesterday' | '7d' | 'month' | 'custom'

function rangeFor(p: Preset, custom: { from: string; to: string }) {
  const today = cafeDate()
  switch (p) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) }
    case '7d':
      return { from: addDays(today, -6), to: today }
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today }
    case 'custom':
      return custom
  }
}

export function ReportsPage() {
  const today = cafeDate()
  const [preset, setPreset] = useState<Preset>('today')
  const [custom, setCustom] = useState({ from: addDays(today, -6), to: today })
  const [summary, setSummary] = useState<SalesSummary | null>(null)
  const [orders, setOrders] = useState<StaffOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const range = rangeFor(preset, custom)
  const rangeInvalid = range.to < range.from || addDays(range.from, 92) < range.to

  const load = useCallback(async () => {
    if (rangeInvalid) return
    setLoading(true)
    setError(null)
    try {
      const [s, o] = await Promise.all([backend.salesSummary(range.from, range.to), backend.listOrdersInRange(range.from, range.to)])
      setSummary(s)
      setOrders(o)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setLoading(false)
    }
  }, [range.from, range.to, rangeInvalid])

  useEffect(() => {
    void load()
  }, [load])

  const presets: { id: Preset; label: string }[] = [
    { id: 'today', label: 'Today' },
    { id: 'yesterday', label: 'Yesterday' },
    { id: '7d', label: 'Last 7 days' },
    { id: 'month', label: 'This month' },
    { id: 'custom', label: 'Custom' },
  ]

  function downloadCsv() {
    if (!orders) return
    const blob = new Blob([ordersToCsv(orders)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bite-and-sip-orders-${range.from}-to-${range.to}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const label = range.from === range.to ? formatDay(range.from) : `${formatDay(range.from)} – ${formatDay(range.to)}`

  return (
    <main className="mx-auto max-w-6xl px-3 pt-3 pb-12 sm:px-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-extrabold">Reports</h1>
          <p className="text-sm text-muted">{label} · India time · based on when orders were placed</p>
        </div>
        <Button variant="secondary" size="sm" onClick={downloadCsv} disabled={!orders?.length}>
          <IconDownload size={16} /> Download CSV
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
        {presets.map((p) => (
          <button key={p.id} type="button" className="chip" aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>
            {p.label}
          </button>
        ))}
        {preset === 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm font-semibold">
              From
              <input type="date" className="field-input w-auto py-2" max={today} value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </label>
            <label className="flex items-center gap-1.5 text-sm font-semibold">
              To
              <input type="date" className="field-input w-auto py-2" max={today} value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </label>
          </div>
        )}
      </div>
      {rangeInvalid && <Banner tone="danger" className="mt-3">Choose a start date before the end date, up to 92 days apart.</Banner>}
      {error && <Banner tone="danger" className="mt-3" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Banner>}

      {loading && !summary ? (
        <div className="grid place-items-center py-24"><Spinner label="Loading report" /></div>
      ) : summary ? (
        <div className={`mt-4 space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Sales" value={money(summary.sales)} hint="Excludes cancelled orders" big />
            <Stat label="Orders" value={String(summary.orders)} hint={`${summary.items_sold} items sold`} />
            <Stat label="Average order" value={money(summary.average_order_value)} />
            <Stat label="Open right now" value={String(summary.open_orders)} hint={summary.open_orders ? 'Not yet collected' : 'All collected'} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card p-4" aria-labelledby="money-h">
              <h2 id="money-h" className="font-extrabold">Where the money is</h2>
              <dl className="mt-3 divide-y divide-line text-[15px]">
                <Row label="Cash collected" value={summary.cash_collected} />
                <Row label="UPI confirmed by staff" value={summary.upi_confirmed} />
                <Row label="Cash not yet collected" value={summary.outstanding_cash} muted />
                <Row
                  label="UPI not yet confirmed"
                  value={summary.outstanding_upi}
                  muted
                  note={summary.upi_awaiting_verification ? `${summary.upi_awaiting_verification} waiting for a staff check` : undefined}
                />
                <div className="flex items-center justify-between pt-3 font-extrabold">
                  <dt>Sales</dt>
                  <dd className="tabular">{money(summary.sales)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-muted">
                Cash collected + UPI confirmed + not yet paid = sales. Only payments staff confirmed count as received.
              </p>
            </section>

            <section className="card p-4" aria-labelledby="cancel-h">
              <h2 id="cancel-h" className="font-extrabold">Cancellations & refunds</h2>
              <dl className="mt-3 divide-y divide-line text-[15px]">
                <div className="flex items-center justify-between py-2">
                  <dt>Cancelled orders</dt>
                  <dd className="tabular font-bold">{summary.cancelled_orders} · {money(summary.cancelled_value)}</dd>
                </div>
                <div className="flex items-center justify-between py-2">
                  <dt>Refunds due <span className="text-sm text-muted">(paid, then cancelled)</span></dt>
                  <dd className={`tabular font-bold ${summary.refunds_due ? 'text-danger' : ''}`}>
                    {summary.refunds_due_count} · {money(summary.refunds_due)}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-muted">Cancelled orders are not counted in sales.</p>
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <section className="card p-4" aria-labelledby="trend-h">
              <h2 id="trend-h" className="font-extrabold">{range.from === range.to ? 'Sales by hour' : 'Sales by day'}</h2>
              {range.from === range.to ? (
                <BarChart
                  data={summary.by_hour.map((h) => ({ key: String(h.hour), label: hourLabel(h.hour), value: h.sales, detail: `${h.orders} orders` }))}
                />
              ) : (
                <BarChart
                  data={enumerateDays(range.from, range.to).map((d) => {
                    const row = summary.by_day.find((x) => x.day === d)
                    return { key: d, label: formatDay(d).replace(/^\w+, /, ''), value: row?.sales ?? 0, detail: `${row?.orders ?? 0} orders` }
                  })}
                />
              )}
            </section>

            <section className="card p-4" aria-labelledby="top-h">
              <h2 id="top-h" className="font-extrabold">Top items</h2>
              {summary.top_items.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted">No sales in this period.</p>
              ) : (
                <table className="mt-2 w-full text-left text-[15px]">
                  <thead className="text-xs text-muted uppercase">
                    <tr>
                      <th className="py-1.5 font-semibold">Item</th>
                      <th className="py-1.5 text-right font-semibold">Qty</th>
                      <th className="py-1.5 text-right font-semibold">Sales</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {summary.top_items.map((t) => (
                      <tr key={t.name}>
                        <td className="py-2 font-semibold">{t.name}</td>
                        <td className="tabular py-2 text-right">{t.quantity}</td>
                        <td className="tabular py-2 text-right">{money(t.sales)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <OrdersTable orders={orders ?? []} />
        </div>
      ) : null}
    </main>
  )
}

function enumerateDays(from: string, to: string) {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

function Stat({ label, value, hint, big }: { label: string; value: string; hint?: string; big?: boolean }) {
  return (
    <div className={`card p-4 ${big ? 'bg-ink text-white' : ''}`}>
      <p className={`text-sm font-semibold ${big ? 'text-white/70' : 'text-muted'}`}>{label}</p>
      <p className={`tabular mt-1 text-2xl font-extrabold tracking-tight sm:text-3xl ${big ? 'text-brand' : ''}`}>{value}</p>
      {hint && <p className={`mt-0.5 text-xs ${big ? 'text-white/60' : 'text-muted'}`}>{hint}</p>}
    </div>
  )
}

function Row({ label, value, muted, note }: { label: string; value: number; muted?: boolean; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className={muted ? 'text-ink-2' : 'font-semibold'}>
        {label}
        {note && <span className="block text-xs font-bold text-brand-ink">{note}</span>}
      </dt>
      <dd className="tabular font-bold">{money(value)}</dd>
    </div>
  )
}

/** Single-series bar chart. Bars carry their values in tooltips and in an accessible table. */
function BarChart({ data }: { data: { key: string; label: string; value: number; detail: string }[] }) {
  const [active, setActive] = useState<string | null>(null)
  if (data.length === 0 || data.every((d) => d.value === 0)) return <p className="py-10 text-center text-sm text-muted">No sales in this period.</p>
  const max = Math.max(...data.map((d) => d.value))
  const step = niceStep(max)
  const top = Math.ceil(max / step) * step
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step)
  const showEvery = data.length > 16 ? Math.ceil(data.length / 8) : 1
  const current = data.find((d) => d.key === active)

  return (
    <figure className="mt-3">
      <div className="relative h-56 pl-12">
        {ticks.map((t) => (
          <div key={t} className="absolute right-0 left-12 border-t border-line" style={{ bottom: `${(t / top) * 100}%` }} aria-hidden="true">
            <span className="tabular absolute -top-2 -left-12 w-10 text-right text-[11px] text-muted">{t >= 1000 ? `${t / 1000}k` : t}</span>
          </div>
        ))}
        <div className="absolute inset-y-0 right-0 left-12 flex items-end gap-[2px]">
          {data.map((d) => (
            <button
              key={d.key}
              type="button"
              className="group relative flex h-full flex-1 items-end focus:outline-none"
              onMouseEnter={() => setActive(d.key)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(d.key)}
              onBlur={() => setActive(null)}
              aria-label={`${d.label}: ${money(d.value)}, ${d.detail}`}
            >
              <span
                className={`block w-full max-w-10 mx-auto rounded-t-[4px] transition-colors ${active === d.key ? 'bg-brand ring-2 ring-ink' : 'bg-ink-2'}`}
                style={{ height: `${(d.value / top) * 100}%`, minHeight: d.value ? 2 : 0 }}
              />
            </button>
          ))}
        </div>
        {current && (
          <div className="pointer-events-none absolute top-0 right-0 rounded-xl bg-ink px-3 py-2 text-sm text-white shadow-[var(--shadow-float)]" role="status">
            <span className="font-bold">{current.label}</span> · <span className="tabular">{money(current.value)}</span>
            <span className="block text-xs text-white/70">{current.detail}</span>
          </div>
        )}
      </div>
      <div className="mt-1 flex gap-[2px] pl-12" aria-hidden="true">
        {data.map((d, i) => (
          <span key={d.key} className="flex-1 truncate text-center text-[11px] text-muted">{i % showEvery === 0 ? d.label : ''}</span>
        ))}
      </div>
      <figcaption className="sr-only">Sales per period. Hover or focus a bar for its value.</figcaption>
    </figure>
  )
}

function niceStep(max: number) {
  if (max <= 0) return 1
  const raw = max / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  const n = raw / pow
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow
}

function OrdersTable({ orders }: { orders: StaffOrder[] }) {
  const [showAll, setShowAll] = useState(false)
  const list = showAll ? orders : orders.slice(0, 25)
  return (
    <section className="card overflow-hidden" aria-labelledby="orders-h">
      <div className="flex items-center justify-between px-4 pt-4">
        <h2 id="orders-h" className="font-extrabold">Orders ({orders.length})</h2>
      </div>
      {orders.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">No orders in this period.</p>
      ) : (
        <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Orders table (scrolls sideways)">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-y border-line bg-sunken text-xs text-muted uppercase">
              <tr>
                <th className="px-4 py-2.5">Order</th>
                <th className="px-4 py-2.5">Placed</th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Payment</th>
                <th className="px-4 py-2.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((o) => (
                <tr key={o.id}>
                  <td className="tabular px-4 py-2.5 font-bold">{orderCode(o.order_no)}</td>
                  <td className="tabular px-4 py-2.5 text-muted">{formatDay(cafeDate(new Date(o.created_at)))}, {timeOfDay(o.created_at)}</td>
                  <td className="px-4 py-2.5">{o.customer_name}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={o.status} /></td>
                  <td className="px-4 py-2.5">
                    {o.status === 'cancelled' && o.payment_status === 'paid' ? (
                      <span className="text-xs font-bold text-danger">Refund due</span>
                    ) : o.status === 'cancelled' ? (
                      <span className="text-xs text-muted">—</span>
                    ) : (
                      <PaymentBadge display={paymentDisplay(o)} method={o.payment_method} />
                    )}
                  </td>
                  <td className={`tabular px-4 py-2.5 text-right font-bold ${o.status === 'cancelled' ? 'text-muted line-through' : ''}`}>{money(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {orders.length > 25 && (
        <div className="border-t border-line p-3 text-center">
          <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${orders.length}`}</Button>
        </div>
      )}
    </section>
  )
}
