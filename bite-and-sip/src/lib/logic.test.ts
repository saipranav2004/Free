import { describe, expect, it } from 'vitest'
import catalog from '../data/catalog.json'
import { addDays, cafeDate, cafeDayStartIso, money, orderCode } from './format'
import { canCustomerCancel, canTransition, paymentDisplay, TRANSITIONS } from './orderRules'
import { clampQty, lineKey, priceCart, unitPrice } from './pricing'
import { ordersToCsv, summarize } from './reports'
import type { MenuItem, StaffOrder } from './types'
import { buildUpiLink, isValidUpiId } from './upi'
import { normalizePhone, normalizeTableLabel, validateName, validatePhone } from './validation'

const items: MenuItem[] = catalog.items.map((i) => ({
  ...i,
  image_path: null,
  addons: i.addons.map((a) => ({ ...a, menu_item_id: i.id, is_available: true })),
}))
const maggi = items.find((i) => i.name === 'College Special Maggi')!
const chai = items.find((i) => i.name === 'Masala Chai')!
const wrap = items.find((i) => i.name === 'Paneer Wrap')!
const cheese = maggi.addons.find((a) => a.name === 'Extra Cheese')!

describe('shared dataset', () => {
  it('uses one consistent add-on price list (resolves the mockup conflict)', () => {
    expect(maggi.addons.map((a) => [a.name, a.price])).toEqual([
      ['Extra Cheese', 15],
      ['Extra Masala', 5],
      ['Extra Vegetables', 10],
    ])
  })
  it('has unique ids and positive prices', () => {
    const ids = [...items.map((i) => i.id), ...items.flatMap((i) => i.addons.map((a) => a.id))]
    expect(new Set(ids).size).toBe(ids.length)
    expect(items.every((i) => Number.isInteger(i.price) && i.price > 0)).toBe(true)
  })
  it('combos are cheaper than their parts', () => {
    const combo = items.find((i) => i.name === 'Maggi + Chai Combo')!
    expect(combo.price).toBe(maggi.price + chai.price - 5)
  })
})

describe('pricing', () => {
  it('adds selected add-ons to the unit price', () => {
    expect(unitPrice(maggi, [cheese.id])).toBe(55)
    expect(unitPrice(maggi, [])).toBe(40)
  })
  it('prices the mockup cart: Maggi + Chai = ₹55', () => {
    const cart = priceCart(
      [
        { key: 'a', menu_item_id: maggi.id, addon_ids: [], quantity: 1, note: '' },
        { key: 'b', menu_item_id: chai.id, addon_ids: [], quantity: 1, note: '' },
      ],
      items,
    )
    expect(cart.total).toBe(55)
    expect(cart.units).toBe(2)
    expect(cart.hasIssues).toBe(false)
  })
  it('flags sold-out items, missing items and sold-out add-ons, and excludes them from the total', () => {
    const soldOutAddon = items.map((i) => (i.id === maggi.id ? { ...i, addons: i.addons.map((a) => ({ ...a, is_available: a.id !== cheese.id })) } : i))
    const cart = priceCart(
      [
        { key: 'a', menu_item_id: wrap.id, addon_ids: [], quantity: 1, note: '' },
        { key: 'b', menu_item_id: 'gone', addon_ids: [], quantity: 1, note: '' },
        { key: 'c', menu_item_id: maggi.id, addon_ids: [cheese.id], quantity: 2, note: '' },
        { key: 'd', menu_item_id: chai.id, addon_ids: [], quantity: 3, note: '' },
      ],
      soldOutAddon,
    )
    expect(cart.lines.map((l) => l.issue)).toEqual(['item_unavailable', 'item_missing', 'addon_unavailable', null])
    expect(cart.total).toBe(45)
    expect(cart.hasIssues).toBe(true)
  })
  it('merges identical choices into one line regardless of add-on order or note case', () => {
    expect(lineKey('x', ['b', 'a'], ' Less Spicy ')).toBe(lineKey('x', ['a', 'b'], 'less spicy'))
    expect(lineKey('x', ['a'], '')).not.toBe(lineKey('x', [], ''))
  })
  it('clamps quantities to 1–20', () => {
    expect([clampQty(0), clampQty(25), clampQty(2.6), clampQty(Number.NaN)]).toEqual([1, 20, 3, 1])
  })
})

describe('order rules', () => {
  it('allows only forward steps and cancellation from open states', () => {
    expect(canTransition('placed', 'preparing')).toBe(true)
    expect(canTransition('placed', 'completed')).toBe(false)
    expect(canTransition('ready', 'placed')).toBe(false)
    expect(canTransition('completed', 'cancelled')).toBe(false)
    expect(TRANSITIONS.cancelled).toEqual([])
  })
  it('keeps payment separate from status, and a customer claim never counts as paid', () => {
    expect(paymentDisplay({ payment_method: 'cash', payment_status: 'unpaid', customer_reported_paid_at: null })).toBe('cash_due')
    expect(paymentDisplay({ payment_method: 'upi', payment_status: 'unpaid', customer_reported_paid_at: null })).toBe('upi_pending')
    expect(paymentDisplay({ payment_method: 'upi', payment_status: 'unpaid', customer_reported_paid_at: '2026-10-10T10:00:00Z' })).toBe('upi_verifying')
    expect(paymentDisplay({ payment_method: 'upi', payment_status: 'paid', customer_reported_paid_at: null })).toBe('paid')
  })
  it('lets customers cancel only placed, unpaid, unclaimed orders', () => {
    expect(canCustomerCancel({ status: 'placed', payment_status: 'unpaid', customer_reported_paid_at: null })).toBe(true)
    expect(canCustomerCancel({ status: 'preparing', payment_status: 'unpaid', customer_reported_paid_at: null })).toBe(false)
    expect(canCustomerCancel({ status: 'placed', payment_status: 'unpaid', customer_reported_paid_at: 'x' })).toBe(false)
  })
})

describe('UPI link', () => {
  it('follows the NPCI format with a decimal amount', () => {
    const link = buildUpiLink({ upiId: 'bitesip@okaxis', payeeName: 'Bite & Sip', amount: 55, note: 'Bite & Sip BS-1042' })
    expect(link).toBe('upi://pay?pa=bitesip%40okaxis&pn=Bite%20%26%20Sip&am=55.00&cu=INR&tn=Bite%20%26%20Sip%20BS-1042')
  })
  it('validates UPI IDs', () => {
    expect(isValidUpiId('cafe.name-1@ybl')).toBe(true)
    expect(isValidUpiId('no-at-sign')).toBe(false)
    expect(isValidUpiId('a@1bank')).toBe(false)
    expect(() => buildUpiLink({ upiId: 'x@ybl', payeeName: 'x', amount: 0, note: '' })).toThrow()
  })
})

describe('validation', () => {
  it('normalises Indian mobile numbers', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('9876543210')
    expect(normalizePhone('09876543210')).toBe('9876543210')
    expect(normalizePhone('5876543210')).toBeNull()
    expect(normalizePhone('98765')).toBeNull()
    expect(validatePhone('')).toMatch(/enter/)
  })
  it('requires a name', () => {
    expect(validateName('  ')).not.toBeNull()
    expect(validateName('Nikitha')).toBeNull()
    expect(validateName('x'.repeat(41))).not.toBeNull()
  })
  it('normalises table labels', () => {
    expect(normalizeTableLabel(' t12 ')).toBe('T12')
    expect(normalizeTableLabel('<script>')).toBeNull()
  })
})

describe('formatting', () => {
  it('formats money and order codes', () => {
    expect(money(1240)).toBe('₹1,240')
    expect(orderCode(1042)).toBe('BS-1042')
  })
  it('uses the café time zone for business days', () => {
    expect(cafeDate(new Date('2026-10-10T19:00:00Z'))).toBe('2026-10-11') // 00:30 IST
    expect(cafeDayStartIso('2026-10-11')).toBe('2026-10-10T18:30:00.000Z')
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30')
  })
})

function order(p: Partial<StaffOrder>): StaffOrder {
  return {
    id: crypto.randomUUID(), order_no: 1, customer_name: 'A', customer_phone: '9876543210', table_label: null,
    status: 'completed', payment_method: 'cash', payment_status: 'paid', customer_reported_paid_at: null,
    payment_reference: null, total: 100, item_count: 1, cancel_reason: null, cancelled_by: null,
    created_at: '2026-10-10T06:00:00Z', updated_at: '2026-10-10T06:00:00Z', preparing_at: null, ready_at: null,
    completed_at: null, cancelled_at: null, paid_at: null,
    items: [{ name: 'Masala Chai', base_price: 15, addons: [], unit_price: 15, quantity: 1, line_total: 15, note: null }],
    ...p,
  }
}

describe('sales summary', () => {
  const orders = [
    order({ total: 55, payment_method: 'cash' }),
    order({ total: 95, payment_method: 'upi' }),
    order({ total: 40, payment_method: 'upi', status: 'ready', payment_status: 'unpaid', customer_reported_paid_at: '2026-10-10T06:05:00Z' }),
    order({ total: 30, payment_method: 'cash', status: 'placed', payment_status: 'unpaid' }),
    order({ total: 60, status: 'cancelled', payment_status: 'paid' }),
    order({ total: 25, status: 'cancelled', payment_status: 'unpaid' }),
    order({ total: 999, created_at: '2026-10-09T06:00:00Z' }), // other day
  ]
  const s = summarize(orders, '2026-10-10', '2026-10-10')

  it('reconciles: sales = cash collected + UPI confirmed + outstanding', () => {
    expect(s.sales).toBe(220)
    expect(s.cash_collected + s.upi_confirmed + s.outstanding_cash + s.outstanding_upi).toBe(s.sales)
    expect([s.cash_collected, s.upi_confirmed, s.outstanding_cash, s.outstanding_upi]).toEqual([55, 95, 30, 40])
  })
  it('excludes cancelled orders from sales and reports refunds due', () => {
    expect(s.orders).toBe(4)
    expect(s.cancelled_orders).toBe(2)
    expect(s.cancelled_value).toBe(85)
    expect(s.refunds_due).toBe(60)
    expect(s.upi_awaiting_verification).toBe(1)
    expect(s.open_orders).toBe(2)
  })
  it('escapes CSV and neutralises formula injection', () => {
    const csv = ordersToCsv([order({ customer_name: '=HYPERLINK("x")' })])
    expect(csv.split('\n')[1]).toContain(`"'=HYPERLINK(""x"")"`)
  })
})
