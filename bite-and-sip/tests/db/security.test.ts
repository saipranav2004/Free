// Integration tests against a local Supabase stack (`npx supabase start`).
// They exercise the real PostgREST + RLS + triggers + Realtime + Storage.
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CHAI, ITEM, MAGGI, PANEER_WRAP, addon, admin, anonClient, newToken, placeOrder, setSettings, staffClient, uniquePhone,
} from './helpers'

let anon: SupabaseClient
let owner: SupabaseClient
let kitchen: SupabaseClient
let intruder: SupabaseClient // authenticated, but not in public.staff

beforeAll(async () => {
  anon = anonClient()
  owner = await staffClient('owner', 'owner')
  kitchen = await staffClient('kitchen', 'kitchen')
  intruder = await staffClient(null, 'intruder')
  await setSettings({ is_open: true, upi_id: 'demo.bitesip@exampleupi' })
})

afterAll(async () => {
  await setSettings({ is_open: true, upi_id: 'demo.bitesip@exampleupi' })
})

async function newOrder(extra: Parameters<typeof placeOrder>[1] = {}) {
  const res = await placeOrder(anon, extra)
  if (res.error) throw new Error(res.error.message)
  return { order: res.data as Record<string, any>, token: res.token }
}

describe('anonymous access', () => {
  it('can read the public menu and settings', async () => {
    const menu = await anon.from('menu_items').select('id, name, price')
    expect(menu.error).toBeNull()
    expect(menu.data!.length).toBe(14)
    const settings = await anon.from('cafe_settings').select('*').single()
    expect(settings.data?.cafe_name).toBe('Bite & Sip')
  })

  it('cannot read orders, order items or staff', async () => {
    await newOrder()
    for (const table of ['orders', 'order_items', 'staff']) {
      const res = await anon.from(table).select('*').limit(1)
      expect(res.error?.code, table).toBe('42501')
    }
  })

  it('cannot write tables directly', async () => {
    const ins = await anon.from('orders').insert({ customer_name: 'x' })
    expect(ins.error?.code).toBe('42501')
    const upd = await anon.from('menu_items').update({ price: 1 }).eq('id', CHAI.id)
    expect(upd.error?.code).toBe('42501')
    const set = await anon.from('cafe_settings').update({ is_open: false }).eq('id', true)
    expect(set.error?.code).toBe('42501')
  })

  it('cannot call owner reports', async () => {
    const res = await anon.rpc('sales_summary', { p_from: '2026-10-01', p_to: '2026-10-10' })
    expect(res.error).not.toBeNull()
  })
})

describe('place_order', () => {
  it('computes the total from database prices, ignoring client-supplied prices', async () => {
    const { order } = await newOrder({
      p_items: [
        { menu_item_id: MAGGI.id, quantity: 2, addon_ids: [addon(MAGGI, 'Extra Cheese')], note: '  less   spicy ', price: 1, unit_price: 1 },
        { menu_item_id: CHAI.id, quantity: 1, price: 0 },
      ],
    })
    // (40 + 15) * 2 + 15 = 125
    expect(order.total).toBe(125)
    expect(order.item_count).toBe(3)
    expect(order.status).toBe('placed')
    expect(order.payment_status).toBe('unpaid')
    expect(order.order_no).toBeGreaterThanOrEqual(1001)
    const maggi = order.items.find((i: any) => i.name === MAGGI.name)
    expect(maggi.unit_price).toBe(55)
    expect(maggi.line_total).toBe(110)
    expect(maggi.note).toBe('less spicy')
    expect(maggi.addons).toEqual([{ id: addon(MAGGI, 'Extra Cheese'), name: 'Extra Cheese', price: 15 }])
    expect(order).not.toHaveProperty('customer_phone')
    expect(order).not.toHaveProperty('access_hash')
  })

  it('normalises phone numbers and validates the table', async () => {
    const { order } = await newOrder({ p_customer_phone: '+91 98765 43210', p_table_label: ' t3 ' })
    expect(order.phone_last4).toBe('3210')
    expect(order.table_label).toBe('T3')
    const { order: noTable } = await newOrder({ p_table_label: 'T999' })
    expect(noTable.table_label).toBeNull()
  })

  it.each([
    ['unavailable item', { p_items: [{ menu_item_id: PANEER_WRAP.id, quantity: 1 }] }, 'item_unavailable'],
    ['unknown item', { p_items: [{ menu_item_id: randomUUID(), quantity: 1 }] }, 'item_not_found'],
    ['malformed item id', { p_items: [{ menu_item_id: 'nope', quantity: 1 }] }, 'invalid_items'],
    ['zero quantity', { p_items: [{ menu_item_id: CHAI.id, quantity: 0 }] }, 'invalid_quantity'],
    ['quantity above 20', { p_items: [{ menu_item_id: CHAI.id, quantity: 21 }] }, 'invalid_quantity'],
    ['fractional quantity', { p_items: [{ menu_item_id: CHAI.id, quantity: 1.5 }] }, 'invalid_items'],
    ['string quantity', { p_items: [{ menu_item_id: CHAI.id, quantity: '2' }] }, 'invalid_items'],
    ['negative quantity', { p_items: [{ menu_item_id: CHAI.id, quantity: -3 }] }, 'invalid_quantity'],
    ['empty cart', { p_items: [] }, 'invalid_items'],
    ['too many lines', { p_items: Array.from({ length: 31 }, () => ({ menu_item_id: CHAI.id, quantity: 1 })) }, 'invalid_items'],
    ['too many units', { p_items: Array.from({ length: 3 }, () => ({ menu_item_id: CHAI.id, quantity: 20 })) }, 'invalid_quantity'],
    ['add-on from another item', { p_items: [{ menu_item_id: CHAI.id, quantity: 1, addon_ids: [addon(MAGGI, 'Extra Cheese')] }] }, 'addon_unavailable'],
    ['duplicate add-on', { p_items: [{ menu_item_id: MAGGI.id, quantity: 1, addon_ids: [addon(MAGGI, 'Extra Cheese'), addon(MAGGI, 'Extra Cheese')] }] }, 'invalid_addons'],
    ['note too long', { p_items: [{ menu_item_id: CHAI.id, quantity: 1, note: 'x'.repeat(121) }] }, 'invalid_note'],
    ['invalid phone', { p_customer_phone: '12345' }, 'invalid_phone'],
    ['blank name', { p_customer_name: '   ' }, 'invalid_name'],
    ['weak access token', { p_access_token: 'abc' }, 'invalid_request'],
  ])('rejects %s', async (_label, args, message) => {
    const res = await placeOrder(anon, args as any)
    expect(res.error?.message).toBe(message)
  })

  it('is idempotent for retried submissions and rejects a hijacked request id', async () => {
    const requestId = randomUUID()
    const token = newToken()
    const phone = uniquePhone()
    const first = await placeOrder(anon, { p_client_request_id: requestId, p_access_token: token, p_customer_phone: phone })
    const second = await placeOrder(anon, { p_client_request_id: requestId, p_access_token: token, p_customer_phone: phone })
    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
    expect((second.data as any).id).toBe((first.data as any).id)
    const { count } = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('client_request_id', requestId)
    expect(count).toBe(1)
    const hijack = await placeOrder(anon, { p_client_request_id: requestId, p_access_token: newToken() })
    expect(hijack.error?.message).toBe('invalid_request')
  })

  it('handles concurrent duplicate submissions without creating two orders', async () => {
    const requestId = randomUUID()
    const token = newToken()
    const phone = uniquePhone()
    const results = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder(anon, { p_client_request_id: requestId, p_access_token: token, p_customer_phone: phone })),
    )
    const ids = new Set(results.map((r) => (r.data as any)?.id))
    expect(results.every((r) => r.error === null)).toBe(true)
    expect(ids.size).toBe(1)
  })

  it('limits open orders per phone number', async () => {
    const phone = uniquePhone()
    for (let i = 0; i < 3; i++) await newOrder({ p_customer_phone: phone })
    const res = await placeOrder(anon, { p_customer_phone: phone })
    expect(res.error?.message).toBe('too_many_open_orders')
  })

  it('refuses orders while the café is closed', async () => {
    await setSettings({ is_open: false })
    try {
      const res = await placeOrder(anon)
      expect(res.error?.message).toBe('cafe_closed')
    } finally {
      await setSettings({ is_open: true })
    }
  })

  it('refuses UPI when no merchant UPI ID is configured', async () => {
    await setSettings({ upi_id: null })
    try {
      const res = await placeOrder(anon, { p_payment_method: 'upi' })
      expect(res.error?.message).toBe('upi_unavailable')
      const cash = await placeOrder(anon, { p_payment_method: 'cash' })
      expect(cash.error).toBeNull()
    } finally {
      await setSettings({ upi_id: 'demo.bitesip@exampleupi' })
    }
  })
})

describe('customer order access', () => {
  it('requires the order secret; an order id alone reveals nothing', async () => {
    const a = await newOrder()
    const b = await newOrder()
    const ok = await anon.rpc('get_order', { p_order_id: a.order.id, p_access_token: a.token })
    expect(ok.data.id).toBe(a.order.id)
    const wrong = await anon.rpc('get_order', { p_order_id: a.order.id, p_access_token: b.token })
    expect(wrong.error?.message).toBe('order_not_found')
    const guess = await anon.rpc('get_order', { p_order_id: a.order.id, p_access_token: 'f'.repeat(64) })
    expect(guess.error?.message).toBe('order_not_found')
    const missing = await anon.rpc('get_order', { p_order_id: randomUUID(), p_access_token: a.token })
    expect(missing.error?.message).toBe('order_not_found')
  })

  it('batch lookup returns only orders whose secret matches', async () => {
    const a = await newOrder()
    const b = await newOrder()
    const res = await anon.rpc('get_orders', {
      p_refs: [
        { id: a.order.id, token: a.token },
        { id: b.order.id, token: a.token },
        { id: 'not-a-uuid', token: a.token },
      ],
    })
    expect(res.error).toBeNull()
    expect(res.data.map((o: any) => o.id)).toEqual([a.order.id])
  })

  it('lets a customer cancel only while the order is placed and unpaid', async () => {
    const a = await newOrder()
    const cancelled = await anon.rpc('cancel_my_order', { p_order_id: a.order.id, p_access_token: a.token })
    expect(cancelled.data.status).toBe('cancelled')
    expect(cancelled.data.cancelled_by).toBe('customer')

    const b = await newOrder()
    await kitchen.from('orders').update({ status: 'preparing' }).eq('id', b.order.id)
    const late = await anon.rpc('cancel_my_order', { p_order_id: b.order.id, p_access_token: b.token })
    expect(late.error?.message).toBe('cannot_cancel')
  })

  it('records "I have paid" for UPI without marking the order paid', async () => {
    const a = await newOrder({ p_payment_method: 'upi' })
    const res = await anon.rpc('report_upi_payment', { p_order_id: a.order.id, p_access_token: a.token })
    expect(res.data.payment_status).toBe('unpaid')
    expect(res.data.customer_reported_paid_at).not.toBeNull()
    // Having reported payment, they can no longer self-cancel.
    const cancel = await anon.rpc('cancel_my_order', { p_order_id: a.order.id, p_access_token: a.token })
    expect(cancel.error?.message).toBe('cannot_cancel')
    const cash = await newOrder({ p_payment_method: 'cash' })
    const bad = await anon.rpc('report_upi_payment', { p_order_id: cash.order.id, p_access_token: cash.token })
    expect(bad.error?.message).toBe('not_allowed')
  })
})

describe('staff permissions', () => {
  it('denies authenticated users who are not staff', async () => {
    const { order } = await newOrder()
    const read = await intruder.from('orders').select('id')
    expect(read.data).toEqual([])
    const upd = await intruder.from('orders').update({ status: 'preparing' }).eq('id', order.id).select()
    expect(upd.data ?? []).toEqual([])
    const menu = await intruder.from('menu_items').update({ is_available: false }).eq('id', CHAI.id).select()
    expect(menu.data ?? []).toEqual([])
    const report = await intruder.rpc('sales_summary', { p_from: '2026-10-01', p_to: '2026-10-10' })
    expect(report.error?.message).toBe('owner_only')
  })

  it('lets kitchen read orders and toggle availability, but not prices or settings', async () => {
    const read = await kitchen.from('orders').select('id').limit(1)
    expect(read.error).toBeNull()
    expect(read.data!.length).toBe(1)

    const toggle = await kitchen.from('menu_items').update({ is_available: false }).eq('id', CHAI.id).select()
    expect(toggle.data?.[0].is_available).toBe(false)
    await kitchen.from('menu_items').update({ is_available: true }).eq('id', CHAI.id)

    const price = await kitchen.from('menu_items').update({ price: 1 }).eq('id', CHAI.id)
    expect(price.error?.message).toBe('kitchen_can_only_change_availability')

    const addonPrice = await kitchen.from('addons').update({ price: 0 }).eq('id', addon(MAGGI, 'Extra Cheese'))
    expect(addonPrice.error?.message).toBe('kitchen_can_only_change_availability')

    const settings = await kitchen.from('cafe_settings').update({ upi_id: 'attacker@okaxis' }).eq('id', true).select()
    expect(settings.data ?? []).toEqual([])
    const { data } = await admin.from('cafe_settings').select('upi_id').single()
    expect(data?.upi_id).toBe('demo.bitesip@exampleupi')

    const ins = await kitchen.from('menu_items').insert({ category_id: MAGGI.category_id, name: 'Free food', price: 1 }).select()
    expect(ins.error).not.toBeNull()

    const report = await kitchen.rpc('sales_summary', { p_from: '2026-10-01', p_to: '2026-10-10' })
    expect(report.error?.message).toBe('owner_only')
  })

  it('prevents role escalation', async () => {
    const { data: me } = await kitchen.auth.getUser()
    const esc = await kitchen.from('staff').update({ role: 'owner' }).eq('user_id', me.user!.id).select()
    expect(esc.data ?? []).toEqual([])
    const ins = await kitchen.from('staff').insert({ user_id: me.user!.id, display_name: 'x', role: 'owner' })
    expect(ins.error?.code).toBe('42501')
    const { data: row } = await admin.from('staff').select('role').eq('user_id', me.user!.id).single()
    expect(row?.role).toBe('kitchen')

    const { data: ownerMe } = await owner.auth.getUser()
    const selfDemote = await owner.from('staff').update({ role: 'kitchen' }).eq('user_id', ownerMe.user!.id)
    expect(selfDemote.error?.message).toBe('cannot_change_own_role_or_status')
  })

  it('cannot modify order fields outside the workflow', async () => {
    const { order } = await newOrder()
    const total = await kitchen.from('orders').update({ total: 1 }).eq('id', order.id)
    expect(total.error?.code).toBe('42501')
    const paidAt = await kitchen.from('orders').update({ paid_at: new Date().toISOString() }).eq('id', order.id)
    expect(paidAt.error?.code).toBe('42501')
    const del = await owner.from('orders').delete().eq('id', order.id)
    expect(del.error?.code).toBe('42501')
  })
})

describe('order and payment state machine', () => {
  it('follows placed → preparing → ready → completed and rejects skips', async () => {
    const { order } = await newOrder()
    const skip = await kitchen.from('orders').update({ status: 'completed' }).eq('id', order.id)
    expect(skip.error?.message).toBe('invalid_transition')

    const prep = await kitchen.from('orders').update({ status: 'preparing' }).eq('id', order.id).eq('status', 'placed').select().single()
    expect(prep.data?.status).toBe('preparing')
    expect(prep.data?.preparing_at).not.toBeNull()

    const back = await kitchen.from('orders').update({ status: 'placed' }).eq('id', order.id)
    expect(back.error?.message).toBe('invalid_transition')

    await kitchen.from('orders').update({ status: 'ready' }).eq('id', order.id)
    const unpaid = await kitchen.from('orders').update({ status: 'completed' }).eq('id', order.id)
    expect(unpaid.error?.message).toBe('payment_required')

    const done = await kitchen.from('orders').update({ status: 'completed', payment_status: 'paid' }).eq('id', order.id).select().single()
    expect(done.data?.status).toBe('completed')
    expect(done.data?.payment_status).toBe('paid')
    expect(done.data?.paid_at).not.toBeNull()

    const after = await kitchen.from('orders').update({ status: 'cancelled', cancel_reason: 'x' }).eq('id', order.id)
    expect(after.error?.message).toBe('invalid_transition')
  })

  it('detects concurrent updates through the expected-status guard', async () => {
    const { order } = await newOrder()
    const [a, b] = await Promise.all([
      kitchen.from('orders').update({ status: 'preparing' }).eq('id', order.id).eq('status', 'placed').select(),
      owner.from('orders').update({ status: 'preparing' }).eq('id', order.id).eq('status', 'placed').select(),
    ])
    const winners = [a.data?.length ?? 0, b.data?.length ?? 0]
    expect(winners.sort()).toEqual([0, 1])
  })

  it('requires a reason when staff cancel', async () => {
    const { order } = await newOrder()
    const none = await kitchen.from('orders').update({ status: 'cancelled' }).eq('id', order.id)
    expect(none.error?.message).toBe('cancel_reason_required')
    const ok = await kitchen.from('orders').update({ status: 'cancelled', cancel_reason: 'Out of milk' }).eq('id', order.id).select().single()
    expect(ok.data?.cancelled_by).toBe('staff')
  })

  it('only owners can reverse a payment, and never after completion', async () => {
    const { order } = await newOrder({ p_payment_method: 'upi' })
    const paid = await kitchen.from('orders').update({ payment_status: 'paid', payment_reference: 'UTR 1234' }).eq('id', order.id).select().single()
    expect(paid.data?.payment_status).toBe('paid')
    expect(paid.data?.payment_reference).toBe('UTR 1234')

    const kitchenUndo = await kitchen.from('orders').update({ payment_status: 'unpaid' }).eq('id', order.id)
    expect(kitchenUndo.error?.message).toBe('owner_only')
    const ownerUndo = await owner.from('orders').update({ payment_status: 'unpaid' }).eq('id', order.id).select().single()
    expect(ownerUndo.data?.payment_status).toBe('unpaid')
    expect(ownerUndo.data?.paid_at).toBeNull()

    await kitchen.from('orders').update({ status: 'preparing' }).eq('id', order.id)
    await kitchen.from('orders').update({ status: 'ready' }).eq('id', order.id)
    await kitchen.from('orders').update({ status: 'completed', payment_status: 'paid' }).eq('id', order.id)
    const late = await owner.from('orders').update({ payment_status: 'unpaid' }).eq('id', order.id)
    expect(late.error?.message).toBe('payment_required')
  })

  it('cannot mark a cancelled order as paid', async () => {
    const { order } = await newOrder()
    await kitchen.from('orders').update({ status: 'cancelled', cancel_reason: 'Test' }).eq('id', order.id)
    const res = await kitchen.from('orders').update({ payment_status: 'paid' }).eq('id', order.id)
    expect(res.error?.message).toBe('order_cancelled')
  })
})

describe('sales_summary', () => {
  it('reconciles sales with cash, confirmed UPI and outstanding amounts', async () => {
    // A cash order completed, a UPI order verified, an unpaid UPI order, and a paid-then-cancelled order.
    const cash = await newOrder({ p_items: [{ menu_item_id: MAGGI.id, quantity: 1 }] })
    for (const s of ['preparing', 'ready']) await kitchen.from('orders').update({ status: s }).eq('id', cash.order.id)
    await kitchen.from('orders').update({ status: 'completed', payment_status: 'paid' }).eq('id', cash.order.id)

    const upi = await newOrder({ p_payment_method: 'upi' })
    await kitchen.from('orders').update({ payment_status: 'paid' }).eq('id', upi.order.id)

    await newOrder({ p_payment_method: 'upi', p_items: [{ menu_item_id: ITEM['Cold Coffee'].id, quantity: 1 }] })

    const refund = await newOrder({ p_payment_method: 'upi' })
    await kitchen.from('orders').update({ payment_status: 'paid' }).eq('id', refund.order.id)
    await kitchen.from('orders').update({ status: 'cancelled', cancel_reason: 'Out of stock' }).eq('id', refund.order.id)

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
    const { data, error } = await owner.rpc('sales_summary', { p_from: today, p_to: today })
    expect(error).toBeNull()
    expect(data.sales).toBe(data.cash_collected + data.upi_confirmed + data.outstanding_cash + data.outstanding_upi)
    expect(data.refunds_due).toBeGreaterThanOrEqual(15)
    expect(data.cancelled_orders).toBeGreaterThanOrEqual(1)

    // Cross-check against raw rows.
    const { data: rows } = await admin.from('orders').select('total, status, payment_method, payment_status, created_at')
    const live = rows!.filter((r) => r.status !== 'cancelled' && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(r.created_at)) === today)
    expect(data.sales).toBe(live.reduce((s, r) => s + r.total, 0))
    expect(data.orders).toBe(live.length)
    expect(data.cash_collected).toBe(live.filter((r) => r.payment_method === 'cash' && r.payment_status === 'paid').reduce((s, r) => s + r.total, 0))
  })

  it('validates the date range', async () => {
    const res = await owner.rpc('sales_summary', { p_from: '2026-10-10', p_to: '2026-10-01' })
    expect(res.error?.message).toBe('invalid_range')
    const long = await owner.rpc('sales_summary', { p_from: '2026-01-01', p_to: '2026-10-01' })
    expect(long.error?.message).toBe('invalid_range')
  })
})

describe('realtime', () => {
  it('notifies the student device on its public order topic without personal data', async () => {
    const { order, token } = await newOrder()
    const student = anonClient()
    const received: any[] = []
    const channel = student.channel(`order:${order.track_key}`, { config: { private: false } })
    await new Promise<void>((resolve, reject) => {
      channel.on('broadcast', { event: 'order_changed' }, (msg) => received.push(msg.payload))
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve()
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status))
      })
    })
    await kitchen.from('orders').update({ status: 'preparing' }).eq('id', order.id)
    await waitFor(() => received.length > 0)
    expect(received[0].status).toBe('preparing')
    expect(JSON.stringify(received[0])).not.toContain(order.customer_name)
    const fresh = await student.rpc('get_order', { p_order_id: order.id, p_access_token: token })
    expect(fresh.data.status).toBe('preparing')
    await student.removeChannel(channel)
  })

  it('streams new orders to staff through Postgres Changes, but not to non-staff', async () => {
    const seenByKitchen: string[] = []
    const seenByIntruder: string[] = []
    const subscribe = (client: SupabaseClient, sink: string[], name: string) =>
      new Promise<ReturnType<SupabaseClient['channel']>>((resolve, reject) => {
        const ch = client
          .channel(name)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, (p) => sink.push((p.new as any).id))
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') resolve(ch)
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status))
          })
      })
    const k = await subscribe(kitchen, seenByKitchen, 'staff-orders-test')
    const i = await subscribe(intruder, seenByIntruder, 'intruder-orders-test')
    await new Promise((r) => setTimeout(r, 1000))
    const { order } = await newOrder()
    await waitFor(() => seenByKitchen.includes(order.id))
    await new Promise((r) => setTimeout(r, 1500))
    expect(seenByIntruder).not.toContain(order.id)
    await kitchen.removeChannel(k)
    await intruder.removeChannel(i)
  }, 20000)
})

describe('storage', () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137])

  it('allows owners to upload menu images and denies everyone else', async () => {
    const path = `items/test-${randomUUID()}.png`
    const ok = await owner.storage.from('menu-images').upload(path, png, { contentType: 'image/png' })
    expect(ok.error).toBeNull()
    const k = await kitchen.storage.from('menu-images').upload(`items/k-${randomUUID()}.png`, png, { contentType: 'image/png' })
    expect(k.error).not.toBeNull()
    const a = await anon.storage.from('menu-images').upload(`items/a-${randomUUID()}.png`, png, { contentType: 'image/png' })
    expect(a.error).not.toBeNull()
    const bad = await owner.storage.from('menu-images').upload(`items/x-${randomUUID()}.html`, new TextEncoder().encode('<script>'), { contentType: 'text/html' })
    expect(bad.error).not.toBeNull()
    const del = await owner.storage.from('menu-images').remove([path])
    expect(del.error).toBeNull()
  })
})

async function waitFor(cond: () => boolean, timeout = 8000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 100))
  }
}
