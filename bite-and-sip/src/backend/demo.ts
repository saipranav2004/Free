// Demo backend: runs entirely in this browser (localStorage + BroadcastChannel).
// It powers the interactive mockups, UI tests and previews when no Supabase
// project is configured. It mirrors the database rules (pricing, state machine,
// permissions) but is NOT secure: nothing here should be used for real orders.
import catalog from '../data/catalog.json'
import { AppError } from '../lib/errors'
import { addDays, cafeDate, cafeDayStartIso } from '../lib/format'
import { canTransition, OPEN_STATUSES } from '../lib/orderRules'
import { MAX_LINES, MAX_QTY_PER_LINE, MAX_UNITS } from '../lib/pricing'
import { summarize } from '../lib/reports'
import { readJson, writeJson } from '../lib/storage'
import type {
  CafeSettings, CafeTable, Category, CustomerOrder, MenuItem, OrderLine, PaymentMethod, PlaceOrderInput,
  StaffMember, StaffOrder, StaffProfile, StaffRole,
} from '../lib/types'
import { cleanText, normalizePhone, normalizeTableLabel } from '../lib/validation'
import { isValidUpiId } from '../lib/upi'
import { bundledImage, isBundledImage } from '../lib/images'
import type { Backend, LiveStatus, MenuItemInput, PublicData } from './types'

const STORE_KEY = 'bitesip-demo-v2'
const SESSION_KEY = 'bitesip-demo-session'

export const DEMO_ACCOUNTS = [
  { email: 'owner@demo.bitesip', password: 'demo-owner', role: 'owner' as const, name: 'Asha (Owner)', user_id: 'demo-owner' },
  { email: 'kitchen@demo.bitesip', password: 'demo-kitchen', role: 'kitchen' as const, name: 'Ravi (Kitchen)', user_id: 'demo-kitchen' },
]

interface DemoOrder extends StaffOrder {
  token: string
  track_key: string
  client_request_id: string
}

interface Store {
  version: 1
  settings: CafeSettings
  categories: Category[]
  items: MenuItem[]
  tables: CafeTable[]
  orders: DemoOrder[]
  staff: StaffMember[]
  nextOrderNo: number
}

const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
const uuid = () => crypto.randomUUID()
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

function seedMenu(): { categories: Category[]; items: MenuItem[] } {
  return {
    categories: catalog.categories.map((c) => ({ ...c })),
    items: catalog.items.map((i) => ({
      id: i.id,
      category_id: i.category_id,
      name: i.name,
      description: i.description,
      price: i.price,
      is_veg: i.is_veg,
      is_available: i.is_available,
      is_popular: i.is_popular,
      image_path: i.image_path ?? null,
      sort_order: i.sort_order,
      addons: i.addons.map((a) => ({ ...a, menu_item_id: i.id, is_available: true })),
    })),
  }
}

/** Deterministic pseudo-random sequence so the sample history is stable. */
function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

const FIRST_NAMES = ['Nikitha', 'Arjun', 'Priya', 'Rahul', 'Sneha', 'Karthik', 'Divya', 'Vikram', 'Ananya', 'Rohan', 'Meera', 'Aditya']

function buildLine(item: MenuItem, qty: number, addonIds: string[], note: string | null): OrderLine {
  const addons = item.addons.filter((a) => addonIds.includes(a.id)).map((a) => ({ id: a.id, name: a.name, price: a.price }))
  const unit = item.price + addons.reduce((s, a) => s + a.price, 0)
  return { name: item.name, base_price: item.price, addons, unit_price: unit, quantity: qty, line_total: unit * qty, note }
}

/** Sample history: the previous 13 days of completed orders plus a few live ones today. */
function seedOrders(items: MenuItem[]): { orders: DemoOrder[]; next: number } {
  const rand = prng(20261010)
  const available = items.filter((i) => i.is_available)
  const orders: DemoOrder[] = []
  let no = 1001
  const today = cafeDate()
  const nowMs = Date.now()

  const make = (createdAt: Date, status: StaffOrder['status'], method: PaymentMethod, paid: boolean): DemoOrder => {
    const lineCount = 1 + Math.floor(rand() * 3)
    const lines: OrderLine[] = []
    const used = new Set<string>()
    for (let k = 0; k < lineCount; k++) {
      const item = available[Math.floor(rand() * available.length)]
      if (used.has(item.id)) continue
      used.add(item.id)
      const addonIds = item.addons.length && rand() < 0.4 ? [item.addons[0].id] : []
      lines.push(buildLine(item, 1 + Math.floor(rand() * 2), addonIds, null))
    }
    const total = lines.reduce((s, l) => s + l.line_total, 0)
    const created = createdAt.toISOString()
    const name = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)]
    const phone = `9${Math.floor(100000000 + rand() * 899999999)}`
    const step = (min: number) => new Date(createdAt.getTime() + min * 60000).toISOString()
    const reached = (s: StaffOrder['status']) => ['preparing', 'ready', 'completed'].indexOf(status) >= ['preparing', 'ready', 'completed'].indexOf(s)
    return {
      id: uuid(),
      order_no: no++,
      customer_name: name,
      customer_phone: phone,
      table_label: rand() < 0.75 ? `T${1 + Math.floor(rand() * 12)}` : null,
      status,
      payment_method: method,
      payment_status: paid ? 'paid' : 'unpaid',
      customer_reported_paid_at: null,
      payment_reference: null,
      total,
      item_count: lines.reduce((s, l) => s + l.quantity, 0),
      cancel_reason: status === 'cancelled' ? 'Item ran out' : null,
      cancelled_by: status === 'cancelled' ? 'staff' : null,
      created_at: created,
      updated_at: created,
      preparing_at: status !== 'placed' && status !== 'cancelled' && reached('preparing') ? step(2) : null,
      ready_at: status !== 'placed' && status !== 'cancelled' && reached('ready') ? step(9) : null,
      completed_at: status === 'completed' ? step(14) : null,
      cancelled_at: status === 'cancelled' ? step(3) : null,
      paid_at: paid ? step(14) : null,
      items: lines,
      token: uuid().replaceAll('-', '') + uuid().replaceAll('-', ''),
      track_key: uuid(),
      client_request_id: uuid(),
    }
  }

  for (let d = 13; d >= 1; d--) {
    const day = addDays(today, -d)
    const count = 18 + Math.floor(rand() * 14)
    for (let k = 0; k < count; k++) {
      const minutes = 8 * 60 + Math.floor(rand() * 10 * 60) // 8am–6pm IST
      const created = new Date(new Date(cafeDayStartIso(day)).getTime() + minutes * 60000)
      const cancelled = rand() < 0.04
      const method: PaymentMethod = rand() < 0.55 ? 'upi' : 'cash'
      orders.push(make(created, cancelled ? 'cancelled' : 'completed', method, !cancelled))
    }
  }

  // Today: a few finished orders, and some live ones a few minutes old.
  const todayStart = new Date(cafeDayStartIso(today)).getTime()
  const earliest = Math.min(nowMs - 30 * 60000, todayStart + 9 * 3600000)
  for (let k = 0; k < 6; k++) {
    const t = Math.min(nowMs - 25 * 60000, earliest + k * 11 * 60000)
    orders.push(make(new Date(Math.max(todayStart, t)), 'completed', k % 2 ? 'upi' : 'cash', true))
  }
  const live: [number, StaffOrder['status'], PaymentMethod, boolean][] = [
    [14, 'ready', 'cash', false],
    [9, 'preparing', 'upi', true],
    [6, 'preparing', 'cash', false],
    [3, 'placed', 'upi', false],
    [1, 'placed', 'cash', false],
  ]
  for (const [minsAgo, status, method, paid] of live) {
    const o = make(new Date(Math.max(todayStart, nowMs - minsAgo * 60000)), status, method, paid)
    if (method === 'upi' && !paid) o.customer_reported_paid_at = new Date(nowMs - 2 * 60000).toISOString()
    orders.push(o)
  }
  return { orders, next: no }
}

function freshStore(): Store {
  const menu = seedMenu()
  const { orders, next } = seedOrders(menu.items)
  return {
    version: 1,
    settings: { ...catalog.settings, updated_at: now() },
    categories: menu.categories,
    items: menu.items,
    tables: catalog.tables.map((label) => ({ label, is_active: true })),
    orders,
    staff: DEMO_ACCOUNTS.map((a) => ({ user_id: a.user_id, display_name: a.name, role: a.role, is_active: true, created_at: now() })),
    nextOrderNo: next,
  }
}

function load(): Store {
  const s = readJson<Store | null>(STORE_KEY, null)
  if (s && s.version === 1) return s
  const fresh = freshStore()
  writeJson(STORE_KEY, fresh)
  return fresh
}

export function resetDemoData() {
  writeJson(STORE_KEY, freshStore())
  notify(null)
}

// ---- change notifications (same tab + other tabs) -------------------------
type Listener = (orderId: string | null) => void
const listeners = new Set<Listener>()
let bc: BroadcastChannel | null = null
try {
  bc = new BroadcastChannel('bitesip-demo')
  bc.onmessage = (e) => listeners.forEach((l) => l((e.data as { orderId: string | null }).orderId))
} catch {
  bc = null
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORE_KEY) listeners.forEach((l) => l(null))
  })
}
function notify(orderId: string | null) {
  listeners.forEach((l) => l(orderId))
  try {
    bc?.postMessage({ orderId })
  } catch {
    /* ignore */
  }
}

function mutate<T>(fn: (s: Store) => T, orderId: string | null = null): T {
  const s = load()
  const result = fn(s)
  writeJson(STORE_KEY, s)
  notify(orderId)
  return result
}

// ---- helpers ---------------------------------------------------------------
function toCustomer(o: DemoOrder): CustomerOrder {
  return {
    id: o.id, order_no: o.order_no, customer_name: o.customer_name, phone_last4: o.customer_phone.slice(-4),
    table_label: o.table_label, status: o.status, payment_method: o.payment_method, payment_status: o.payment_status,
    customer_reported_paid_at: o.customer_reported_paid_at, total: o.total, item_count: o.item_count,
    cancel_reason: o.cancel_reason, cancelled_by: o.cancelled_by, track_key: o.track_key, created_at: o.created_at,
    updated_at: o.updated_at, preparing_at: o.preparing_at, ready_at: o.ready_at, completed_at: o.completed_at,
    cancelled_at: o.cancelled_at, paid_at: o.paid_at, items: clone(o.items),
  }
}

function toStaff(o: DemoOrder): StaffOrder {
  const { token: _t, track_key: _k, client_request_id: _c, ...rest } = o
  return clone(rest)
}

function session(): { user_id: string; role: StaffRole } | null {
  const id = readJson<string | null>(SESSION_KEY, null)
  if (!id) return null
  const member = load().staff.find((m) => m.user_id === id && m.is_active)
  return member ? { user_id: member.user_id, role: member.role } : null
}

function requireStaff() {
  const s = session()
  if (!s) throw new AppError('not_allowed')
  return s
}

function requireOwner() {
  const s = requireStaff()
  if (s.role !== 'owner') throw new AppError('owner_only')
  return s
}

function findCustomerOrder(s: Store, id: string, token: string) {
  const o = s.orders.find((x) => x.id === id && x.token === token)
  if (!o || !/^[0-9a-f]{64}$/.test(token)) throw new AppError('order_not_found')
  return o
}

// ---- backend ---------------------------------------------------------------
export function createDemoBackend(): Backend {
  return {
    mode: 'demo',

    async getPublicData(): Promise<PublicData> {
      await delay()
      const s = load()
      return {
        settings: clone(s.settings),
        menu: { categories: clone(s.categories).sort((a, b) => a.sort_order - b.sort_order), items: clone(s.items).sort((a, b) => a.sort_order - b.sort_order) },
        tables: clone(s.tables),
      }
    },

    async placeOrder(input: PlaceOrderInput) {
      await delay(400)
      return mutate((s) => {
        const existing = s.orders.find((o) => o.client_request_id === input.client_request_id)
        if (existing) {
          if (existing.token !== input.access_token) throw new AppError('invalid_request')
          return toCustomer(existing)
        }
        if (!/^[0-9a-f]{64}$/.test(input.access_token)) throw new AppError('invalid_request')
        if (!s.settings.is_open) throw new AppError('cafe_closed')
        const name = cleanText(input.customer_name)
        if (!name || name.length > 40) throw new AppError('invalid_name')
        const phone = normalizePhone(input.customer_phone)
        if (!phone) throw new AppError('invalid_phone')
        if (input.payment_method === 'upi' && !s.settings.upi_id) throw new AppError('upi_unavailable')
        let table = normalizeTableLabel(input.table_label)
        if (table && !s.tables.some((t) => t.label === table && t.is_active)) table = null
        if (!input.items.length || input.items.length > MAX_LINES) throw new AppError('invalid_items')
        const open = s.orders.filter((o) => o.customer_phone === phone && OPEN_STATUSES.includes(o.status)).length
        if (open >= 3) throw new AppError('too_many_open_orders')

        const lines: OrderLine[] = input.items.map((l) => {
          if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QTY_PER_LINE) throw new AppError('invalid_quantity')
          const item = s.items.find((i) => i.id === l.menu_item_id)
          if (!item) throw new AppError('item_not_found')
          if (!item.is_available) throw new AppError('item_unavailable')
          if (new Set(l.addon_ids).size !== l.addon_ids.length) throw new AppError('invalid_addons')
          const valid = item.addons.filter((a) => l.addon_ids.includes(a.id) && a.is_available)
          if (valid.length !== l.addon_ids.length) throw new AppError('addon_unavailable')
          const note = l.note ? cleanText(l.note) : null
          if (note && note.length > 120) throw new AppError('invalid_note')
          return buildLine(item, l.quantity, l.addon_ids, note || null)
        })
        const units = lines.reduce((x, l) => x + l.quantity, 0)
        if (units > MAX_UNITS) throw new AppError('invalid_quantity')

        const created = now()
        const order: DemoOrder = {
          id: uuid(), order_no: s.nextOrderNo++, customer_name: name, customer_phone: phone, table_label: table,
          status: 'placed', payment_method: input.payment_method, payment_status: 'unpaid', customer_reported_paid_at: null,
          payment_reference: null, total: lines.reduce((x, l) => x + l.line_total, 0), item_count: units,
          cancel_reason: null, cancelled_by: null, created_at: created, updated_at: created, preparing_at: null,
          ready_at: null, completed_at: null, cancelled_at: null, paid_at: null, items: lines,
          token: input.access_token, track_key: uuid(), client_request_id: input.client_request_id,
        }
        s.orders.push(order)
        return toCustomer(order)
      })
    },

    async getOrder(id, token) {
      await delay(80)
      return toCustomer(findCustomerOrder(load(), id, token))
    },

    async getOrders(refs) {
      await delay(80)
      const s = load()
      return refs.slice(0, 20).flatMap((r) => {
        try {
          return [toCustomer(findCustomerOrder(s, r.id, r.token))]
        } catch {
          return []
        }
      })
    },

    async reportUpiPayment(id, token) {
      await delay()
      return mutate((s) => {
        const o = findCustomerOrder(s, id, token)
        if (o.payment_method !== 'upi' || o.status === 'cancelled') throw new AppError('not_allowed')
        if (o.payment_status === 'unpaid' && !o.customer_reported_paid_at) {
          o.customer_reported_paid_at = now()
          o.updated_at = now()
        }
        return toCustomer(o)
      }, id)
    },

    async cancelMyOrder(id, token) {
      await delay()
      return mutate((s) => {
        const o = findCustomerOrder(s, id, token)
        if (o.status !== 'placed' || o.payment_status !== 'unpaid' || o.customer_reported_paid_at) throw new AppError('cannot_cancel')
        o.status = 'cancelled'
        o.cancelled_at = now()
        o.cancelled_by = 'customer'
        o.cancel_reason = 'Cancelled by customer'
        o.updated_at = now()
        return toCustomer(o)
      }, id)
    },

    watchOrder(trackKey, onChange, onStatus) {
      const id = load().orders.find((o) => o.track_key === trackKey)?.id
      const l: Listener = (orderId) => {
        if (orderId === null || orderId === id) onChange()
      }
      listeners.add(l)
      setTimeout(() => onStatus('live'), 0)
      return () => listeners.delete(l)
    },

    imageUrl(path) {
      if (isBundledImage(path)) return bundledImage(path)!.src
      return path && path.startsWith('data:') ? path : null
    },

    async getStaffSession() {
      const s = session()
      if (!s) return null
      const account = DEMO_ACCOUNTS.find((a) => a.user_id === s.user_id)
      const member = load().staff.find((m) => m.user_id === s.user_id)!
      return { user_id: s.user_id, email: account?.email ?? null, display_name: member.display_name, role: member.role, is_active: true }
    },

    async signIn(email, password) {
      await delay(300)
      const account = DEMO_ACCOUNTS.find((a) => a.email === email.trim().toLowerCase() && a.password === password)
      if (!account) throw new AppError('invalid_credentials')
      const member = load().staff.find((m) => m.user_id === account.user_id)
      if (!member?.is_active) throw new AppError('not_staff')
      writeJson(SESSION_KEY, account.user_id)
      authListeners.forEach((cb) => cb())
      return { user_id: account.user_id, email: account.email, display_name: member.display_name, role: member.role, is_active: true } satisfies StaffProfile
    },

    async signOut() {
      writeJson(SESSION_KEY, null)
      authListeners.forEach((cb) => cb())
    },

    onAuthChange(cb) {
      authListeners.add(cb)
      return () => authListeners.delete(cb)
    },

    async listOrdersSince(sinceIso) {
      await delay(80)
      requireStaff()
      return load()
        .orders.filter((o) => OPEN_STATUSES.includes(o.status) || o.created_at >= sinceIso)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(toStaff)
    },

    async listOrdersInRange(fromDay, toDay) {
      await delay(80)
      requireStaff()
      const from = cafeDayStartIso(fromDay)
      const to = cafeDayStartIso(addDays(toDay, 1))
      return load()
        .orders.filter((o) => o.created_at >= from && o.created_at < to)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(toStaff)
    },

    async changeStatus(id, change) {
      await delay()
      requireStaff()
      return mutate((s) => {
        const o = s.orders.find((x) => x.id === id)
        if (!o || o.status !== change.from) throw new AppError('conflict')
        if (!canTransition(o.status, change.to)) throw new AppError('invalid_transition')
        const t = now()
        if (change.markPaid && o.payment_status === 'unpaid') {
          o.payment_status = 'paid'
          o.paid_at = t
        }
        if (change.to === 'completed' && o.payment_status !== 'paid') throw new AppError('payment_required')
        if (change.to === 'cancelled') {
          const reason = cleanText(change.reason ?? '')
          if (!reason) throw new AppError('cancel_reason_required')
          o.cancel_reason = reason
          o.cancelled_by = 'staff'
          o.cancelled_at = t
        }
        if (change.to === 'preparing') o.preparing_at = t
        if (change.to === 'ready') o.ready_at = t
        if (change.to === 'completed') o.completed_at = t
        o.status = change.to
        o.updated_at = t
        return toStaff(o)
      }, id)
    },

    async setPayment(id, paid, reference) {
      await delay()
      const me = requireStaff()
      return mutate((s) => {
        const o = s.orders.find((x) => x.id === id)
        if (!o || o.payment_status === (paid ? 'paid' : 'unpaid')) throw new AppError('conflict')
        if (o.status === 'cancelled') throw new AppError('order_cancelled')
        if (!paid) {
          if (me.role !== 'owner') throw new AppError('owner_only')
          if (o.status === 'completed') throw new AppError('payment_required')
          o.payment_status = 'unpaid'
          o.paid_at = null
          o.payment_reference = null
        } else {
          o.payment_status = 'paid'
          o.paid_at = now()
          o.payment_reference = reference ? cleanText(reference).slice(0, 40) || null : null
        }
        o.updated_at = now()
        return toStaff(o)
      }, id)
    },

    watchOrders(onChange, onStatus) {
      listeners.add(onChange)
      setTimeout(() => onStatus('live' as LiveStatus), 0)
      return () => listeners.delete(onChange)
    },

    async saveMenuItem(input: MenuItemInput) {
      await delay()
      requireOwner()
      return mutate((s) => {
        const name = cleanText(input.name)
        if (!name || name.length > 60 || !Number.isInteger(input.price) || input.price < 1 || input.price > 5000) throw new AppError('invalid')
        if (!s.categories.some((c) => c.id === input.category_id)) throw new AppError('invalid')
        const id = input.id ?? uuid()
        const existing = s.items.find((i) => i.id === id)
        const names = input.addons.map((a) => cleanText(a.name).toLowerCase())
        if (new Set(names).size !== names.length) throw new AppError('duplicate', 'Two add-ons have the same name.')
        const item: MenuItem = {
          id,
          category_id: input.category_id,
          name,
          description: cleanText(input.description).slice(0, 200),
          price: input.price,
          is_veg: input.is_veg,
          is_available: input.is_available,
          is_popular: input.is_popular,
          image_path: input.image_path,
          sort_order: existing?.sort_order ?? Math.max(0, ...s.items.filter((i) => i.category_id === input.category_id).map((i) => i.sort_order)) + 1,
          addons: input.addons.map((a, idx) => ({
            id: a.id ?? uuid(), menu_item_id: id, name: cleanText(a.name), price: a.price, is_available: a.is_available, sort_order: idx + 1,
          })),
        }
        if (existing) Object.assign(existing, item)
        else s.items.push(item)
        return id
      })
    },

    async deleteMenuItem(id) {
      await delay()
      requireOwner()
      mutate((s) => {
        s.items = s.items.filter((i) => i.id !== id)
      })
    },

    async setItemAvailability(id, available) {
      await delay(80)
      requireStaff()
      mutate((s) => {
        const i = s.items.find((x) => x.id === id)
        if (!i) throw new AppError('not_allowed')
        i.is_available = available
      })
    },

    async setAddonAvailability(id, available) {
      await delay(80)
      requireStaff()
      mutate((s) => {
        const a = s.items.flatMap((i) => i.addons).find((x) => x.id === id)
        if (!a) throw new AppError('not_allowed')
        a.is_available = available
      })
    },

    async uploadImage(file) {
      requireOwner()
      if (file.size > 2 * 1024 * 1024) throw new AppError('invalid', 'Images must be under 2 MB.')
      return await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(new AppError('unknown'))
        r.readAsDataURL(file)
      })
    },

    async removeImage() {
      /* data URLs are dropped with the item */
    },

    async createCategory(name) {
      await delay()
      requireOwner()
      return mutate((s) => {
        const clean = cleanText(name)
        if (!clean || clean.length > 40) throw new AppError('invalid')
        if (s.categories.some((c) => c.name.toLowerCase() === clean.toLowerCase())) throw new AppError('duplicate', 'That name is already in use.')
        const c = { id: uuid(), name: clean, sort_order: Math.max(0, ...s.categories.map((x) => x.sort_order)) + 1 }
        s.categories.push(c)
        return c
      })
    },

    async updateCategory(id, patch) {
      await delay()
      requireOwner()
      mutate((s) => {
        const c = s.categories.find((x) => x.id === id)
        if (!c) throw new AppError('not_allowed')
        if (patch.name !== undefined) {
          const clean = cleanText(patch.name)
          if (!clean || clean.length > 40) throw new AppError('invalid')
          if (s.categories.some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) throw new AppError('duplicate', 'That name is already in use.')
          c.name = clean
        }
        if (patch.sort_order !== undefined) c.sort_order = patch.sort_order
      })
    },

    async deleteCategory(id) {
      await delay()
      requireOwner()
      mutate((s) => {
        if (s.items.some((i) => i.category_id === id)) throw new AppError('in_use', 'This is still in use and can’t be deleted.')
        s.categories = s.categories.filter((c) => c.id !== id)
      })
    },

    async updateSettings(patch) {
      await delay()
      requireOwner()
      return mutate((s) => {
        if (patch.upi_id !== undefined && patch.upi_id !== null && !isValidUpiId(patch.upi_id)) throw new AppError('invalid', 'Enter a valid UPI ID, like cafe@okaxis.')
        Object.assign(s.settings, patch, { updated_at: now() })
        return clone(s.settings)
      })
    },

    async addTables(labels) {
      await delay()
      requireOwner()
      mutate((s) => {
        for (const label of labels) {
          const t = s.tables.find((x) => x.label === label)
          if (t) t.is_active = true
          else s.tables.push({ label, is_active: true })
        }
        s.tables.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
      })
    },

    async setTableActive(label, active) {
      await delay(80)
      requireOwner()
      mutate((s) => {
        const t = s.tables.find((x) => x.label === label)
        if (!t) throw new AppError('not_allowed')
        t.is_active = active
      })
    },

    async deleteTable(label) {
      await delay(80)
      requireOwner()
      mutate((s) => {
        s.tables = s.tables.filter((t) => t.label !== label)
      })
    },

    async listStaff() {
      await delay(80)
      requireOwner()
      return clone(load().staff)
    },

    async updateStaff(userId, patch) {
      await delay()
      const me = requireOwner()
      mutate((s) => {
        const m = s.staff.find((x) => x.user_id === userId)
        if (!m) throw new AppError('owner_only')
        if (userId === me.user_id && ((patch.role && patch.role !== m.role) || patch.is_active === false)) throw new AppError('cannot_change_own_role_or_status')
        Object.assign(m, patch)
      })
    },

    async salesSummary(fromDay, toDay) {
      await delay()
      requireOwner()
      if (toDay < fromDay || addDays(fromDay, 92) < toDay) throw new AppError('invalid_range')
      return summarize(load().orders.map(toStaff), fromDay, toDay)
    },
  }
}

const authListeners = new Set<() => void>()
