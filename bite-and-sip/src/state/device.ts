// Per-device conveniences: remembered checkout details, table from QR, and the
// secrets that prove this device placed its orders.
import { readJson, writeJson } from '../lib/storage'
import { normalizeTableLabel } from '../lib/validation'

const ORDERS_KEY = 'bitesip-my-orders-v1'
const DETAILS_KEY = 'bitesip-details-v1'
const TABLE_KEY = 'bitesip-table-v1'
const PENDING_KEY = 'bitesip-pending-order-v1'

export interface OrderRef {
  id: string
  token: string
  order_no: number
  created_at: string
}

export function myOrderRefs(): OrderRef[] {
  const refs = readJson<OrderRef[]>(ORDERS_KEY, [])
  return Array.isArray(refs) ? refs.filter((r) => r && typeof r.id === 'string' && typeof r.token === 'string') : []
}

export function rememberOrder(ref: OrderRef) {
  const refs = [ref, ...myOrderRefs().filter((r) => r.id !== ref.id)].slice(0, 20)
  writeJson(ORDERS_KEY, refs)
}

export function forgetOrder(id: string) {
  writeJson(ORDERS_KEY, myOrderRefs().filter((r) => r.id !== id))
}

export function tokenFor(id: string) {
  return myOrderRefs().find((r) => r.id === id)?.token ?? null
}

export interface SavedDetails {
  name: string
  phone: string
}

export function savedDetails(): SavedDetails {
  const d = readJson<SavedDetails>(DETAILS_KEY, { name: '', phone: '' })
  return { name: typeof d.name === 'string' ? d.name : '', phone: typeof d.phone === 'string' ? d.phone : '' }
}

export function saveDetails(d: SavedDetails) {
  writeJson(DETAILS_KEY, d)
}

/** Table from the QR code. Kept for 6 hours so a later visit doesn't reuse a stale table. */
export function currentTable(): string | null {
  const t = readJson<{ label: string; at: number } | null>(TABLE_KEY, null)
  if (!t || Date.now() - t.at > 6 * 3600 * 1000) return null
  return normalizeTableLabel(t.label)
}

export function setCurrentTable(label: string | null) {
  writeJson(TABLE_KEY, label ? { label, at: Date.now() } : null)
}

/**
 * An order submission in flight. If the network drops after the server saved
 * the order, retrying with the same request id + token returns that order
 * instead of creating a duplicate.
 */
export interface PendingOrder {
  client_request_id: string
  access_token: string
  fingerprint: string
}

export function pendingOrder(): PendingOrder | null {
  return readJson<PendingOrder | null>(PENDING_KEY, null)
}

export function setPendingOrder(p: PendingOrder | null) {
  writeJson(PENDING_KEY, p)
}
