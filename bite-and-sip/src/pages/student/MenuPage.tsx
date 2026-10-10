import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import { FoodImage } from '../../components/FoodArt'
import { IconArrowRight, IconBag, IconPin, IconRefresh, IconSearch, IconX } from '../../components/icons'
import { DemoRibbon, StudentHeader } from '../../components/StudentShell'
import { Banner, Button, EmptyState, QuantityStepper, useToast, VegMark } from '../../components/ui'
import { money } from '../../lib/format'
import { lineKey, priceCart } from '../../lib/pricing'
import type { MenuItem } from '../../lib/types'
import { useCart } from '../../state/cart'
import { currentTable } from '../../state/device'
import { usePublicData } from '../../state/publicData'
import { ItemSheet } from './ItemSheet'

export function MenuPage() {
  const { data, loading, error, refresh } = usePublicData()
  const cart = useCart()
  const toast = useToast()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('all')
  const [selected, setSelected] = useState<MenuItem | null>(null)
  const scanned = currentTable()

  const categories = useMemo(() => (data ? [...data.menu.categories].sort((a, b) => a.sort_order - b.sort_order) : []), [data])
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? ''

  const q = query.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!data) return []
    return data.menu.items.filter(
      (i) =>
        (category === 'all' || i.category_id === category) &&
        (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || catName(i.category_id).toLowerCase().includes(q)),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, category, q])

  const table = scanned && data?.tables.some((t) => t.is_active && t.label === scanned) ? scanned : null
  const popular = data?.menu.items.filter((i) => i.is_popular && i.is_available) ?? []
  const priced = data ? priceCart(cart.lines, data.menu.items) : null
  const isOpen = data?.settings.is_open ?? true

  const addPlain = (item: MenuItem) => {
    cart.add(item.id, [], 1, '')
    toast(`${item.name} added`, 'success')
  }

  if (loading && !data) return <MenuSkeleton />
  if (!data)
    return (
      <>
        <DemoRibbon />
        <StudentHeader />
        <EmptyState icon={<IconRefresh />} title="Menu didn’t load" action={<Button onClick={() => void refresh()}>Try again</Button>}>
          {error}
        </EmptyState>
      </>
    )

  const grouped = categories
    .map((c) => ({ category: c, items: visible.filter((i) => i.category_id === c.id) }))
    .filter((g) => g.items.length > 0)

  return (
    <div className="min-h-dvh pb-28">
      <DemoRibbon />
      <StudentHeader />
      <main className="mx-auto max-w-3xl px-4">
        <section className="-mx-4 rounded-b-[1.75rem] bg-ink px-4 pt-2 pb-5 text-white">
          <p className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-brand px-3 text-sm font-bold text-ink">
            <IconPin size={16} />
            {table ? `Table ${table} · Pickup at the counter` : 'Pickup at the counter'}
          </p>
          <h1 className="mt-3 text-[1.6rem] leading-[1.15] font-extrabold tracking-tight sm:text-4xl">
            Hungry? <span className="text-brand">Order from your seat.</span>
          </h1>
          <p className="mt-1.5 text-sm text-white/75 sm:text-[15px]">Track it live and collect it at the counter when it’s ready.</p>
          {error && <p className="mt-2 text-sm font-semibold text-brand">{error} Showing the last menu we loaded.</p>}
        </section>

        {!isOpen && (
          <Banner tone="warning" title="We’re closed right now" className="my-3">
            {data.settings.closed_message} You can still browse the menu.
          </Banner>
        )}

        <div className="sticky top-16 z-20 -mx-4 bg-canvas/95 px-4 pt-3 pb-3 backdrop-blur supports-[backdrop-filter]:bg-canvas/85">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-subtle" />
            <input
              type="search"
              inputMode="search"
              aria-label="Search the menu"
              placeholder="Search maggi, chai, samosa…"
              className="field-input pr-11 pl-11"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-1.5 grid size-9 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-sunken"
                aria-label="Clear search"
              >
                <IconX size={18} />
              </button>
            )}
          </div>
          <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]" role="group" aria-label="Categories">
            <button type="button" className="chip shrink-0" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>
              All
            </button>
            {categories.map((c) => (
              <button key={c.id} type="button" className="chip shrink-0" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        </div>

        {category === 'all' && !q && popular.length > 0 && (
          <section aria-labelledby="popular-h" className="mt-3">
            <h2 id="popular-h" className="text-lg font-extrabold">Popular right now</h2>
            <div className="-mx-4 mt-3 flex snap-x gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none]">
              {popular.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelected(item)}
                  className="card w-40 shrink-0 snap-start overflow-hidden text-left transition-transform active:scale-[0.98]"
                >
                  <FoodImage name={item.name} category={catName(item.category_id)} url={backend.imageUrl(item.image_path)} className="aspect-[4/3] w-full" />
                  <span className="block px-3 pt-2 pb-3">
                    <span className="line-clamp-1 text-sm font-bold">{item.name}</span>
                    <span className="tabular text-sm font-semibold text-muted">{money(item.price)}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {grouped.length === 0 ? (
          <EmptyState
            icon={<IconSearch />}
            title={q ? `Nothing matches “${query.trim()}”` : 'Nothing here yet'}
            action={
              <Button variant="secondary" onClick={() => { setQuery(''); setCategory('all') }}>
                Show the full menu
              </Button>
            }
          >
            Try another word, like “chai” or “maggi”.
          </EmptyState>
        ) : (
          grouped.map(({ category: c, items }) => (
            <section key={c.id} aria-labelledby={`cat-${c.id}`} className="mt-6">
              <h2 id={`cat-${c.id}`} className="text-lg font-extrabold">
                {c.name} <span className="text-sm font-semibold text-subtle">· {items.length}</span>
              </h2>
              <ul className="mt-2 divide-y divide-line">
                {items.map((item) => (
                  <MenuRow
                    key={item.id}
                    item={item}
                    categoryName={c.name}
                    disabled={!isOpen}
                    plainQty={cart.plainQuantity(item.id)}
                    onOpen={() => setSelected(item)}
                    onAdd={() => (item.addons.length ? setSelected(item) : addPlain(item))}
                    onSetPlain={(n) => cart.setQuantity(lineKey(item.id, [], ''), n)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </main>

      <ItemSheet
        key={selected?.id ?? 'none'}
        item={selected}
        categoryName={selected ? catName(selected.category_id) : undefined}
        open={!!selected}
        disabled={!isOpen}
        onClose={() => setSelected(null)}
        onAdd={(addonIds, qty, note) => {
          if (!selected) return
          cart.add(selected.id, addonIds, qty, note)
          toast(`${selected.name} added`, 'success')
        }}
      />

      {priced && priced.units > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => navigate('/cart')}
            className="mx-auto flex min-h-15 w-full max-w-3xl items-center gap-3 rounded-2xl bg-ink px-4 text-left text-white shadow-[var(--shadow-float)]"
          >
            <span className="grid size-9 place-items-center rounded-full bg-brand text-ink">
              <IconBag size={18} />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-semibold text-white/75">
                {priced.units} {priced.units === 1 ? 'item' : 'items'}
              </span>
              <span className="tabular block text-lg leading-tight font-extrabold">{money(priced.total)}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 font-extrabold text-ink">
              View cart <IconArrowRight size={18} />
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

function MenuRow({
  item, categoryName, plainQty, disabled, onOpen, onAdd, onSetPlain,
}: {
  item: MenuItem
  categoryName: string
  plainQty: number
  disabled: boolean
  onOpen: () => void
  onAdd: () => void
  onSetPlain: (n: number) => void
}) {
  const customisable = item.addons.length > 0
  return (
    <li className="flex gap-3 py-4">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 gap-3 text-left" aria-label={`${item.name}, ${money(item.price)}. View details`}>
        <span className="relative size-20 shrink-0 overflow-hidden rounded-2xl ring-1 ring-line sm:size-24">
          <FoodImage name={item.name} category={categoryName} url={backend.imageUrl(item.image_path)} className={`size-full ${item.is_available ? '' : 'grayscale'}`} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <VegMark veg={item.is_veg} />
            {item.is_popular && <span className="text-xs font-bold text-brand-ink">Popular</span>}
          </span>
          <span className={`mt-1 block font-bold leading-snug ${item.is_available ? '' : 'text-muted'}`}>{item.name}</span>
          {item.description && <span className="mt-0.5 line-clamp-2 block text-sm text-muted">{item.description}</span>}
          <span className="tabular mt-1 block font-bold">{money(item.price)}</span>
        </span>
      </button>
      <div className="flex shrink-0 flex-col items-end justify-center gap-1">
        {!item.is_available ? (
          <span className="rounded-full bg-sunken px-3 py-1.5 text-xs font-bold text-muted">Sold out</span>
        ) : plainQty > 0 && !customisable ? (
          <QuantityStepper size="sm" value={plainQty} min={0} onChange={onSetPlain} label={item.name} />
        ) : (
          <Button size="sm" variant="secondary" disabled={disabled} onClick={onAdd} className="min-w-20 border-ink font-extrabold" aria-label={`Add ${item.name}`}>
            Add
          </Button>
        )}
        {customisable && item.is_available && <span className="text-[11px] font-semibold text-subtle">Customisable</span>}
      </div>
    </li>
  )
}

function MenuSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading menu">
      <DemoRibbon />
      <StudentHeader />
      <div className="mx-auto max-w-3xl animate-pulse px-4 pt-6">
        <div className="h-7 w-40 rounded-full bg-sunken" />
        <div className="mt-4 h-9 w-3/4 rounded-xl bg-sunken" />
        <div className="mt-5 h-12 rounded-xl bg-sunken" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="mt-5 flex gap-3">
            <div className="size-20 rounded-2xl bg-sunken" />
            <div className="flex-1 space-y-2 pt-1">
              <div className="h-4 w-1/2 rounded bg-sunken" />
              <div className="h-3 w-3/4 rounded bg-sunken" />
              <div className="h-4 w-16 rounded bg-sunken" />
            </div>
          </div>
        ))}
      </div>
      <p className="sr-only" role="status">Loading menu…</p>
    </div>
  )
}
