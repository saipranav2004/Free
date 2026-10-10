import { useId, useState } from 'react'
import { backend } from '../../backend'
import { FoodImage } from '../../components/FoodArt'
import { IconX } from '../../components/icons'
import { Button, Dialog, QuantityStepper, VegMark } from '../../components/ui'
import { money } from '../../lib/format'
import { unitPrice } from '../../lib/pricing'
import type { MenuItem } from '../../lib/types'

export function ItemSheet({
  item, categoryName, open, onClose, onAdd, disabled,
}: {
  item: MenuItem | null
  categoryName?: string
  open: boolean
  onClose: () => void
  onAdd: (addonIds: string[], qty: number, note: string) => void
  disabled?: boolean
}) {
  const [addonIds, setAddonIds] = useState<string[]>([])
  const [qty, setQty] = useState(1)
  const [note, setNote] = useState('')
  const titleId = useId()
  const noteId = useId()

  if (!item) return null
  const each = unitPrice(item, addonIds)
  const canAdd = item.is_available && !disabled

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      footer={
        <div className="flex items-center gap-3">
          <QuantityStepper value={qty} onChange={setQty} label={item.name} />
          <Button
            size="lg"
            className="flex-1"
            disabled={!canAdd}
            onClick={() => {
              onAdd(addonIds, qty, note)
              onClose()
            }}
          >
            {item.is_available ? `Add to cart · ${money(each * qty)}` : 'Sold out'}
          </Button>
        </div>
      }
    >
      <div className="relative">
        <FoodImage name={item.name} category={categoryName} url={backend.imageUrl(item.image_path)} className="aspect-[16/9] w-full" />
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 grid size-10 place-items-center rounded-full bg-white/95 text-ink shadow"
          aria-label="Close"
        >
          <IconX />
        </button>
      </div>
      <div className="space-y-5 px-5 py-5">
        <div>
          <div className="flex items-center gap-2">
            <VegMark veg={item.is_veg} />
            {item.is_popular && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-bold">Popular</span>}
          </div>
          <h2 id={titleId} className="mt-2 text-2xl font-extrabold tracking-tight">{item.name}</h2>
          <p className="tabular mt-1 text-lg font-bold">{money(item.price)}</p>
          {item.description && <p className="mt-2 text-[15px] text-muted">{item.description}</p>}
        </div>

        {item.addons.length > 0 && (
          <fieldset>
            <legend className="text-sm font-extrabold">
              Add-ons <span className="font-semibold text-muted">(optional)</span>
            </legend>
            <div className="mt-2 divide-y divide-line rounded-2xl border border-line">
              {item.addons.map((a) => {
                const checked = addonIds.includes(a.id)
                return (
                  <label key={a.id} className={`flex min-h-13 items-center gap-3 px-4 py-2.5 ${a.is_available ? '' : 'opacity-60'}`}>
                    <input
                      type="checkbox"
                      className="size-5 accent-ink"
                      checked={checked}
                      disabled={!a.is_available}
                      onChange={(e) => setAddonIds((ids) => (e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id)))}
                    />
                    <span className="flex-1 font-semibold">{a.name}</span>
                    <span className="tabular text-sm font-bold text-muted">{a.is_available ? (a.price ? `+${money(a.price)}` : 'Free') : 'Sold out'}</span>
                  </label>
                )
              })}
            </div>
          </fieldset>
        )}

        <div>
          <label htmlFor={noteId} className="text-sm font-extrabold">
            Note for the kitchen <span className="font-semibold text-muted">(optional)</span>
          </label>
          <textarea
            id={noteId}
            className="field-input mt-2 min-h-20 resize-none"
            maxLength={120}
            placeholder="e.g. less spicy, no onion"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="mt-1 text-right text-xs text-subtle">{note.length}/120</p>
        </div>
      </div>
    </Dialog>
  )
}
