import type { CartLine, MenuItem } from './types'

export const MAX_QTY_PER_LINE = 20
export const MAX_LINES = 30
export const MAX_UNITS = 50

export type LineIssue = 'item_missing' | 'item_unavailable' | 'addon_unavailable'

export interface PricedLine {
  line: CartLine
  item: MenuItem | null
  addons: { id: string; name: string; price: number }[]
  unitPrice: number
  lineTotal: number
  issue: LineIssue | null
}

export interface PricedCart {
  lines: PricedLine[]
  total: number
  units: number
  hasIssues: boolean
}

/** A cart line is identified by item + chosen add-ons + note, so identical choices merge. */
export function lineKey(menuItemId: string, addonIds: string[], note: string) {
  return [menuItemId, [...addonIds].sort().join(','), note.trim().toLowerCase()].join('|')
}

/** Price of one unit: base price plus the selected add-ons. */
export function unitPrice(item: Pick<MenuItem, 'price' | 'addons'>, addonIds: string[]) {
  const chosen = new Set(addonIds)
  return item.price + item.addons.filter((a) => chosen.has(a.id)).reduce((sum, a) => sum + a.price, 0)
}

/**
 * Prices the cart against the live menu. Display only: the database recomputes
 * every price when the order is placed and never trusts these numbers.
 */
export function priceCart(lines: CartLine[], items: MenuItem[]): PricedCart {
  const byId = new Map(items.map((i) => [i.id, i]))
  const priced = lines.map<PricedLine>((line) => {
    const item = byId.get(line.menu_item_id) ?? null
    if (!item) return { line, item: null, addons: [], unitPrice: 0, lineTotal: 0, issue: 'item_missing' }
    const addons = item.addons
      .filter((a) => line.addon_ids.includes(a.id))
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .map((a) => ({ id: a.id, name: a.name, price: a.price }))
    const missingAddon =
      addons.length !== line.addon_ids.length ||
      item.addons.some((a) => line.addon_ids.includes(a.id) && !a.is_available)
    const price = unitPrice(item, line.addon_ids)
    const issue: LineIssue | null = !item.is_available ? 'item_unavailable' : missingAddon ? 'addon_unavailable' : null
    return { line, item, addons, unitPrice: price, lineTotal: price * line.quantity, issue }
  })
  const valid = priced.filter((p) => !p.issue)
  return {
    lines: priced,
    total: valid.reduce((s, p) => s + p.lineTotal, 0),
    units: valid.reduce((s, p) => s + p.line.quantity, 0),
    hasIssues: priced.some((p) => p.issue),
  }
}

export function clampQty(n: number) {
  if (!Number.isFinite(n)) return 1
  return Math.min(MAX_QTY_PER_LINE, Math.max(1, Math.round(n)))
}
