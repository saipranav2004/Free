import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { backend } from '../../backend'
import type { MenuItemInput } from '../../backend/types'
import { FoodImage } from '../../components/FoodArt'
import { IconEdit, IconImage, IconPlus, IconSearch, IconTrash } from '../../components/icons'
import { Banner, Button, Dialog, EmptyState, Spinner, Switch, useToast, VegMark } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { money } from '../../lib/format'
import { prepareMenuPhoto } from '../../lib/image'
import type { Category, MenuItem } from '../../lib/types'
import { cleanText } from '../../lib/validation'
import { usePublicData } from '../../state/publicData'
import { useStaffSession } from '../../state/staffSession'

export function MenuManager() {
  const { data, refresh } = usePublicData()
  const { profile } = useStaffSession()
  const toast = useToast()
  const isOwner = profile?.role === 'owner'
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null)
  const [catsOpen, setCatsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<Set<string>>(new Set())

  const categories = useMemo(() => (data ? [...data.menu.categories].sort((a, b) => a.sort_order - b.sort_order) : []), [data])
  if (!data) return <div className="grid place-items-center py-24"><Spinner label="Loading menu" /></div>

  const q = query.trim().toLowerCase()
  const items = data.menu.items.filter((i) => !q || i.name.toLowerCase().includes(q))
  const soldOut = data.menu.items.filter((i) => !i.is_available).length

  async function toggle(key: string, fn: () => Promise<void>, msg: string) {
    setPending((p) => new Set(p).add(key))
    try {
      await fn()
      await refresh()
      toast(msg, 'success')
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setPending((p) => {
        const n = new Set(p)
        n.delete(key)
        return n
      })
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-3 pt-3 pb-12 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h1 className="text-xl font-extrabold">Menu</h1>
          <p className="text-sm text-muted">
            {data.menu.items.length} items · {soldOut} sold out
            {!isOwner && ' · You can mark items sold out or back in stock.'}
          </p>
        </div>
        {isOwner && (
          <>
            <Button variant="secondary" onClick={() => setCatsOpen(true)}>Categories</Button>
            <Button onClick={() => setEditing('new')}>
              <IconPlus size={18} /> Add item
            </Button>
          </>
        )}
      </div>

      <div className="relative mt-4">
        <IconSearch className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-subtle" />
        <input type="search" aria-label="Search items" className="field-input pl-11" placeholder="Search items" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {categories.map((c) => {
        const list = items.filter((i) => i.category_id === c.id)
        if (list.length === 0 && q) return null
        return (
          <section key={c.id} className="mt-6" aria-labelledby={`mc-${c.id}`}>
            <h2 id={`mc-${c.id}`} className="mb-2 text-sm font-extrabold tracking-wide text-ink-2 uppercase">{c.name}</h2>
            {list.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">No items in this category.</p>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
                {list.map((item) => (
                  <li key={item.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="size-14 shrink-0 overflow-hidden rounded-xl ring-1 ring-line">
                        <FoodImage name={item.name} category={c.name} url={backend.imageUrl(item.image_path)} className={`size-full ${item.is_available ? '' : 'grayscale'}`} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 font-bold">
                          <VegMark veg={item.is_veg} /> <span className="truncate">{item.name}</span>
                        </p>
                        <p className="tabular text-sm text-muted">
                          {money(item.price)}
                          {item.addons.length > 0 && ` · ${item.addons.length} add-on${item.addons.length > 1 ? 's' : ''}`}
                          {item.is_popular && ' · Popular'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`hidden text-xs font-bold sm:inline ${item.is_available ? 'text-ready' : 'text-danger'}`}>
                          {item.is_available ? 'In stock' : 'Sold out'}
                        </span>
                        <Switch
                          checked={item.is_available}
                          disabled={pending.has(item.id)}
                          label={`${item.name} available`}
                          onChange={(v) => void toggle(item.id, () => backend.setItemAvailability(item.id, v), `${item.name} ${v ? 'back in stock' : 'marked sold out'}`)}
                        />
                        {isOwner && (
                          <Button size="sm" variant="ghost" aria-label={`Edit ${item.name}`} onClick={() => setEditing(item)}>
                            <IconEdit size={18} />
                          </Button>
                        )}
                      </div>
                    </div>
                    {item.addons.length > 0 && (
                      <ul className="mt-2 flex flex-wrap gap-2 pl-[4.25rem]">
                        {item.addons.map((a) => (
                          <li key={a.id}>
                            <button
                              type="button"
                              disabled={pending.has(a.id)}
                              aria-pressed={a.is_available}
                              onClick={() => void toggle(a.id, () => backend.setAddonAvailability(a.id, !a.is_available), `${a.name} ${a.is_available ? 'marked sold out' : 'back in stock'}`)}
                              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-bold ${
                                a.is_available ? 'border-line-strong bg-surface text-ink-2' : 'border-danger/30 bg-danger-soft text-danger line-through'
                              }`}
                              title={a.is_available ? 'Tap to mark sold out' : 'Tap to mark available'}
                            >
                              {a.name} +{money(a.price)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
      {items.length === 0 && q && <EmptyState title={`No items match “${query.trim()}”`} />}

      {isOwner && (
        <ItemEditor
          key={editing === 'new' ? 'new' : editing?.id ?? 'none'}
          open={!!editing}
          item={editing === 'new' ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            await refresh()
            setEditing(null)
            toast(msg, 'success')
          }}
        />
      )}
      {isOwner && <CategoryManager open={catsOpen} onClose={() => setCatsOpen(false)} categories={categories} items={data.menu.items} onChanged={refresh} />}
    </main>
  )
}

interface AddonDraft {
  id?: string
  name: string
  price: string
  is_available: boolean
}

function ItemEditor({
  open, item, categories, onClose, onSaved,
}: { open: boolean; item: MenuItem | null; categories: Category[]; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const toast = useToast()
  const [name, setName] = useState(item?.name ?? '')
  const [categoryId, setCategoryId] = useState(item?.category_id ?? categories[0]?.id ?? '')
  const [price, setPrice] = useState(item ? String(item.price) : '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [isVeg, setIsVeg] = useState(item?.is_veg ?? true)
  const [available, setAvailable] = useState(item?.is_available ?? true)
  const [popular, setPopular] = useState(item?.is_popular ?? false)
  const [imagePath, setImagePath] = useState<string | null>(item?.image_path ?? null)
  const [addons, setAddons] = useState<AddonDraft[]>(item?.addons.map((a) => ({ id: a.id, name: a.name, price: String(a.price), is_available: a.is_available })) ?? [])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploaded = useRef<string[]>([])
  const ids = { name: useId(), cat: useId(), price: useId(), desc: useId() }

  const closeAndCleanup = () => {
    // Drop photos uploaded in this session but never saved.
    for (const p of uploaded.current) if (p !== item?.image_path) void backend.removeImage(p)
    uploaded.current = []
    onClose()
  }

  async function onPickPhoto(file: File | undefined) {
    if (!file) return
    setUploading(true)
    try {
      const blob = await prepareMenuPhoto(file)
      const path = await backend.uploadImage(blob)
      uploaded.current.push(path)
      setImagePath(path)
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function validate(): MenuItemInput | null {
    const e: Record<string, string> = {}
    const cleanName = cleanText(name)
    if (!cleanName) e.name = 'Enter a name.'
    else if (cleanName.length > 60) e.name = 'Keep the name under 60 characters.'
    const p = Number(price)
    if (!/^\d+$/.test(price.trim()) || p < 1 || p > 5000) e.price = 'Enter a whole-rupee price between 1 and 5000.'
    if (!categoryId) e.category = 'Choose a category.'
    if (description.length > 200) e.description = 'Keep the description under 200 characters.'
    const seen = new Set<string>()
    addons.forEach((a, i) => {
      const n = cleanText(a.name)
      if (!n) e[`addon-${i}`] = 'Name the add-on or remove it.'
      else if (n.length > 40) e[`addon-${i}`] = 'Keep add-on names under 40 characters.'
      else if (seen.has(n.toLowerCase())) e[`addon-${i}`] = 'Two add-ons have the same name.'
      seen.add(n.toLowerCase())
      if (!/^\d+$/.test(a.price.trim()) || Number(a.price) > 1000) e[`addon-${i}`] = e[`addon-${i}`] ?? 'Add-on price must be 0–1000.'
    })
    setErrors(e)
    if (Object.keys(e).length) return null
    return {
      id: item?.id,
      category_id: categoryId,
      name: cleanName,
      description: cleanText(description),
      price: p,
      is_veg: isVeg,
      is_available: available,
      is_popular: popular,
      image_path: imagePath,
      addons: addons.map((a) => ({ id: a.id, name: cleanText(a.name), price: Number(a.price), is_available: a.is_available })),
    }
  }

  async function save(ev: FormEvent) {
    ev.preventDefault()
    const input = validate()
    if (!input) return
    setSaving(true)
    try {
      await backend.saveMenuItem(input)
      // Remove the previous photo once the new one is saved.
      if (item?.image_path && item.image_path !== imagePath) void backend.removeImage(item.image_path)
      for (const p of uploaded.current) if (p !== imagePath) void backend.removeImage(p)
      uploaded.current = []
      await onSaved(item ? `${input.name} updated` : `${input.name} added to the menu`)
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!item) return
    setSaving(true)
    try {
      await backend.deleteMenuItem(item.id)
      if (item.image_path) void backend.removeImage(item.image_path)
      await onSaved(`${item.name} deleted`)
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setSaving(false)
      setConfirmDelete(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={closeAndCleanup}
      title={item ? `Edit ${item.name}` : 'Add menu item'}
      size="lg"
      footer={
        <div className="flex flex-wrap items-center gap-3">
          {item && !confirmDelete && (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              <IconTrash size={16} /> Delete
            </Button>
          )}
          {item && confirmDelete && (
            <span className="flex items-center gap-2 text-sm font-semibold">
              Delete permanently?
              <Button size="sm" variant="danger" loading={saving} onClick={() => void remove()}>Yes, delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>No</Button>
            </span>
          )}
          <div className="ml-auto flex gap-3">
            <Button variant="secondary" onClick={closeAndCleanup}>Cancel</Button>
            <Button type="submit" form="item-form" loading={saving} disabled={uploading}>Save</Button>
          </div>
        </div>
      }
    >
      <form id="item-form" onSubmit={save} noValidate className="grid gap-5 px-5 py-5 sm:grid-cols-[180px_1fr]">
        <div>
          <span className="label">Photo</span>
          <div className="relative aspect-square overflow-hidden rounded-2xl ring-1 ring-line">
            <FoodImage name={name || 'item'} url={backend.imageUrl(imagePath)} className="size-full" />
            {uploading && <div className="absolute inset-0 grid place-items-center bg-white/70"><Spinner label="Uploading photo" /></div>}
          </div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" id="photo-input" onChange={(e) => void onPickPhoto(e.target.files?.[0])} />
          <div className="mt-2 flex gap-2">
            <label htmlFor="photo-input" className="inline-flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-field bg-surface px-2 text-sm font-bold hover:bg-sunken">
              <IconImage size={16} /> {imagePath ? 'Change' : 'Upload'}
            </label>
            {imagePath && (
              <Button size="sm" variant="ghost" onClick={() => setImagePath(null)}>Remove</Button>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">Resized on this device before upload.</p>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor={ids.name} className="label">Name</label>
            <input id={ids.name} className="field-input" maxLength={60} value={name} aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
            {errors.name && <p className="mt-1 text-sm font-semibold text-danger">{errors.name}</p>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={ids.cat} className="label">Category</label>
              <select id={ids.cat} className="field-input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {errors.category && <p className="mt-1 text-sm font-semibold text-danger">{errors.category}</p>}
            </div>
            <div>
              <label htmlFor={ids.price} className="label">Price (₹)</label>
              <input id={ids.price} className="field-input tabular" inputMode="numeric" value={price} aria-invalid={!!errors.price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, '').slice(0, 4))} />
              {errors.price && <p className="mt-1 text-sm font-semibold text-danger">{errors.price}</p>}
            </div>
          </div>
          <div>
            <label htmlFor={ids.desc} className="label">Description <span className="font-normal text-muted">(optional)</span></label>
            <textarea id={ids.desc} className="field-input min-h-20 resize-none" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <ToggleRow label="Vegetarian" checked={isVeg} onChange={setIsVeg} />
            <ToggleRow label="In stock" checked={available} onChange={setAvailable} />
            <ToggleRow label="Popular" checked={popular} onChange={setPopular} />
          </div>

          <fieldset>
            <legend className="label">Add-ons</legend>
            <div className="space-y-2">
              {addons.map((a, i) => (
                <div key={a.id ?? `new-${i}`}>
                  <div className="flex items-center gap-2">
                    <input
                      aria-label={`Add-on ${i + 1} name`}
                      className="field-input flex-1"
                      placeholder="e.g. Extra Cheese"
                      maxLength={40}
                      value={a.name}
                      aria-invalid={!!errors[`addon-${i}`]}
                      onChange={(e) => setAddons((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                    <div className="relative w-24">
                      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">+₹</span>
                      <input
                        aria-label={`Add-on ${i + 1} price`}
                        className="field-input tabular pl-8"
                        inputMode="numeric"
                        value={a.price}
                        onChange={(e) => setAddons((list) => list.map((x, j) => (j === i ? { ...x, price: e.target.value.replace(/\D/g, '').slice(0, 4) } : x)))}
                      />
                    </div>
                    <Button variant="ghost" size="sm" aria-label={`Remove add-on ${a.name || i + 1}`} onClick={() => setAddons((list) => list.filter((_, j) => j !== i))}>
                      <IconTrash size={16} />
                    </Button>
                  </div>
                  {errors[`addon-${i}`] && <p className="mt-1 text-sm font-semibold text-danger">{errors[`addon-${i}`]}</p>}
                </div>
              ))}
              {addons.length < 12 && (
                <Button variant="secondary" size="sm" onClick={() => setAddons((list) => [...list, { name: '', price: '0', is_available: true }])}>
                  <IconPlus size={16} /> Add-on
                </Button>
              )}
            </div>
          </fieldset>
          {Object.keys(errors).length > 0 && <Banner tone="danger">Please fix the highlighted fields.</Banner>}
        </div>
      </form>
    </Dialog>
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2">
      <span className="text-sm font-semibold">{label}</span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  )
}

function CategoryManager({
  open, onClose, categories, items, onChanged,
}: { open: boolean; onClose: () => void; categories: Category[]; items: MenuItem[]; onChanged: () => Promise<void> }) {
  const toast = useToast()
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  async function run(key: string, fn: () => Promise<unknown>, msg: string) {
    setBusy(key)
    try {
      await fn()
      await onChanged()
      toast(msg, 'success')
      return true
    } catch (err) {
      toast(friendlyError(err), 'error')
      return false
    } finally {
      setBusy(null)
    }
  }

  async function move(index: number, dir: -1 | 1) {
    const a = categories[index]
    const b = categories[index + dir]
    if (!a || !b) return
    await run(a.id, async () => {
      await backend.updateCategory(a.id, { sort_order: b.sort_order })
      await backend.updateCategory(b.id, { sort_order: a.sort_order })
    }, 'Order updated')
  }

  return (
    <Dialog open={open} onClose={onClose} title="Categories" size="md">
      <div className="space-y-4 px-5 py-4">
        <ul className="divide-y divide-line rounded-2xl ring-1 ring-line">
          {categories.map((c, i) => {
            const count = items.filter((x) => x.category_id === c.id).length
            return (
              <li key={c.id} className="flex items-center gap-2 px-3 py-2">
                {renaming?.id === c.id ? (
                  <form
                    className="flex flex-1 gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      if (await run(c.id, () => backend.updateCategory(c.id, { name: renaming.name }), 'Category renamed')) setRenaming(null)
                    }}
                  >
                    <input aria-label="Category name" className="field-input py-2" maxLength={40} value={renaming.name} onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} />
                    <Button type="submit" size="sm" loading={busy === c.id}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                  </form>
                ) : (
                  <>
                    <span className="flex-1 font-semibold">
                      {c.name} <span className="text-sm text-muted">· {count}</span>
                    </span>
                    <Button size="sm" variant="ghost" aria-label={`Move ${c.name} up`} disabled={i === 0 || !!busy} onClick={() => void move(i, -1)}>↑</Button>
                    <Button size="sm" variant="ghost" aria-label={`Move ${c.name} down`} disabled={i === categories.length - 1 || !!busy} onClick={() => void move(i, 1)}>↓</Button>
                    <Button size="sm" variant="ghost" aria-label={`Rename ${c.name}`} onClick={() => setRenaming({ id: c.id, name: c.name })}><IconEdit size={16} /></Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${c.name}`}
                      disabled={count > 0 || !!busy}
                      title={count > 0 ? 'Move or delete its items first' : 'Delete category'}
                      onClick={() => void run(c.id, () => backend.deleteCategory(c.id), 'Category deleted')}
                    >
                      <IconTrash size={16} />
                    </Button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            const n = cleanText(newName)
            if (!n) return
            if (await run('new', () => backend.createCategory(n), `${n} added`)) setNewName('')
          }}
        >
          <input aria-label="New category name" className="field-input" maxLength={40} placeholder="New category, e.g. Desserts" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button type="submit" loading={busy === 'new'} disabled={!cleanText(newName)}>Add</Button>
        </form>
        <p className="text-xs text-muted">A category can only be deleted when it has no items.</p>
      </div>
    </Dialog>
  )
}
