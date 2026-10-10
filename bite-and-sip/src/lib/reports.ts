import { cafeDate, TIME_ZONE } from './format'
import type { SalesSummary, StaffOrder } from './types'

/**
 * Same rules as public.sales_summary() in the database (used by demo mode and tests).
 * sales = cash collected + UPI confirmed + outstanding, always.
 */
export function summarize(orders: StaffOrder[], from: string, to: string): SalesSummary {
  const inRange = orders.filter((o) => {
    const d = cafeDate(new Date(o.created_at))
    return d >= from && d <= to
  })
  const live = inRange.filter((o) => o.status !== 'cancelled')
  const cancelled = inRange.filter((o) => o.status === 'cancelled')
  const sum = (list: StaffOrder[]) => list.reduce((s, o) => s + o.total, 0)

  const items = new Map<string, { name: string; quantity: number; sales: number }>()
  for (const o of live)
    for (const l of o.items) {
      const t = items.get(l.name) ?? { name: l.name, quantity: 0, sales: 0 }
      t.quantity += l.quantity
      t.sales += l.line_total
      items.set(l.name, t)
    }

  const byDay = new Map<string, { day: string; orders: number; sales: number }>()
  const byHour = new Map<number, { hour: number; orders: number; sales: number }>()
  const hourFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: TIME_ZONE })
  for (const o of live) {
    const day = cafeDate(new Date(o.created_at))
    const d = byDay.get(day) ?? { day, orders: 0, sales: 0 }
    d.orders += 1
    d.sales += o.total
    byDay.set(day, d)
    const hour = Number(hourFmt.format(new Date(o.created_at)))
    const h = byHour.get(hour) ?? { hour, orders: 0, sales: 0 }
    h.orders += 1
    h.sales += o.total
    byHour.set(hour, h)
  }

  const paid = (m: 'cash' | 'upi') => live.filter((o) => o.payment_method === m && o.payment_status === 'paid')
  const unpaid = (m: 'cash' | 'upi') => live.filter((o) => o.payment_method === m && o.payment_status === 'unpaid')
  const refunds = cancelled.filter((o) => o.payment_status === 'paid')

  return {
    from,
    to,
    orders: live.length,
    items_sold: live.reduce((s, o) => s + o.item_count, 0),
    sales: sum(live),
    average_order_value: live.length ? Math.round(sum(live) / live.length) : 0,
    cash_collected: sum(paid('cash')),
    upi_confirmed: sum(paid('upi')),
    outstanding_cash: sum(unpaid('cash')),
    outstanding_upi: sum(unpaid('upi')),
    upi_awaiting_verification: unpaid('upi').filter((o) => o.customer_reported_paid_at).length,
    open_orders: live.filter((o) => ['placed', 'preparing', 'ready'].includes(o.status)).length,
    completed_orders: live.filter((o) => o.status === 'completed').length,
    cancelled_orders: cancelled.length,
    cancelled_value: sum(cancelled),
    refunds_due: sum(refunds),
    refunds_due_count: refunds.length,
    top_items: [...items.values()]
      .sort((a, b) => b.quantity - a.quantity || b.sales - a.sales || a.name.localeCompare(b.name))
      .slice(0, 10),
    by_day: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    by_hour: [...byHour.values()].sort((a, b) => a.hour - b.hour),
  }
}

export function ordersToCsv(orders: StaffOrder[]) {
  const header = ['order', 'placed_at', 'customer', 'phone', 'table', 'status', 'payment_method', 'payment_status', 'payment_reference', 'items', 'total']
  const esc = (v: unknown) => {
    let s = String(v ?? '')
    // Neutralise spreadsheet formula injection from customer-entered text.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  const rows = orders.map((o) => [
    `BS-${o.order_no}`, o.created_at, o.customer_name, o.customer_phone, o.table_label ?? '', o.status,
    o.payment_method, o.payment_status, o.payment_reference ?? '',
    o.items.map((i) => `${i.quantity}x ${i.name}`).join('; '), o.total,
  ])
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n')
}
