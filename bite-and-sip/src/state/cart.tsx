import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { clampQty, lineKey, MAX_LINES } from '../lib/pricing'
import { readJson, writeJson } from '../lib/storage'
import type { CartLine } from '../lib/types'

const KEY = 'bitesip-cart-v1'

interface CartApi {
  lines: CartLine[]
  add(menuItemId: string, addonIds: string[], quantity: number, note: string): void
  setQuantity(key: string, quantity: number): void
  remove(key: string): void
  /** Quantity of the plain version (no add-ons, no note) of an item. */
  plainQuantity(menuItemId: string): number
  clear(): void
}

const CartContext = createContext<CartApi | null>(null)

function sanitize(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((l): l is CartLine => !!l && typeof l === 'object' && typeof (l as CartLine).menu_item_id === 'string')
    .map((l) => ({
      key: lineKey(l.menu_item_id, Array.isArray(l.addon_ids) ? l.addon_ids : [], typeof l.note === 'string' ? l.note : ''),
      menu_item_id: l.menu_item_id,
      addon_ids: Array.isArray(l.addon_ids) ? l.addon_ids.filter((a) => typeof a === 'string') : [],
      quantity: clampQty(Number(l.quantity)),
      note: typeof l.note === 'string' ? l.note.slice(0, 120) : '',
    }))
    .slice(0, MAX_LINES)
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => sanitize(readJson(KEY, [])))

  useEffect(() => writeJson(KEY, lines), [lines])

  // Keep multiple tabs in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setLines(sanitize(readJson(KEY, [])))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const add = useCallback((menuItemId: string, addonIds: string[], quantity: number, note: string) => {
    const cleanNote = note.trim().slice(0, 120)
    const key = lineKey(menuItemId, addonIds, cleanNote)
    setLines((prev) => {
      const existing = prev.find((l) => l.key === key)
      if (existing) return prev.map((l) => (l.key === key ? { ...l, quantity: clampQty(l.quantity + quantity) } : l))
      if (prev.length >= MAX_LINES) return prev
      return [...prev, { key, menu_item_id: menuItemId, addon_ids: [...addonIds].sort(), quantity: clampQty(quantity), note: cleanNote }]
    })
  }, [])

  const setQuantity = useCallback((key: string, quantity: number) => {
    setLines((prev) => (quantity <= 0 ? prev.filter((l) => l.key !== key) : prev.map((l) => (l.key === key ? { ...l, quantity: clampQty(quantity) } : l))))
  }, [])

  const remove = useCallback((key: string) => setLines((prev) => prev.filter((l) => l.key !== key)), [])
  const clear = useCallback(() => setLines([]), [])
  const plainQuantity = useCallback(
    (menuItemId: string) => lines.find((l) => l.key === lineKey(menuItemId, [], ''))?.quantity ?? 0,
    [lines],
  )

  const value = useMemo(() => ({ lines, add, setQuantity, remove, clear, plainQuantity }), [lines, add, setQuantity, remove, clear, plainQuantity])
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used inside CartProvider')
  return ctx
}
