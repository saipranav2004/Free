import { useId, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { backend } from '../../backend'
import { FoodImage } from '../../components/FoodArt'
import { IconBag, IconPin, IconTrash } from '../../components/icons'
import { DemoRibbon, StudentHeader } from '../../components/StudentShell'
import { Banner, Button, EmptyState, QuantityStepper, Spinner } from '../../components/ui'
import { friendlyError, toAppError } from '../../lib/errors'
import { money } from '../../lib/format'
import { priceCart, type LineIssue } from '../../lib/pricing'
import { newAccessToken, newId } from '../../lib/tokens'
import type { PaymentMethod, PlaceOrderInput } from '../../lib/types'
import { cleanText, normalizePhone, validateName, validatePhone } from '../../lib/validation'
import { useCart } from '../../state/cart'
import {
  currentTable, pendingOrder, rememberOrder, savedDetails, saveDetails, setCurrentTable, setPendingOrder,
} from '../../state/device'
import { usePublicData } from '../../state/publicData'

const ISSUE_TEXT: Record<LineIssue, string> = {
  item_missing: 'No longer on the menu',
  item_unavailable: 'Sold out right now',
  addon_unavailable: 'An add-on is sold out',
}

export function CartPage() {
  const { data, loading, refresh } = usePublicData()
  const cart = useCart()
  const navigate = useNavigate()
  const saved = savedDetails()
  const [name, setName] = useState(saved.name)
  const [phone, setPhone] = useState(saved.phone)
  const [method, setMethod] = useState<PaymentMethod | null>(null)
  const [errors, setErrors] = useState<{ name?: string; phone?: string; method?: string }>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [scanned, setScanned] = useState(currentTable())
  const nameId = useId()
  const phoneId = useId()

  if (loading && !data) {
    return (
      <>
        <DemoRibbon />
        <StudentHeader back="/" title="Your cart" right={<span />} />
        <div className="grid place-items-center py-24"><Spinner label="Loading cart" /></div>
      </>
    )
  }

  const items = data?.menu.items ?? []
  const priced = priceCart(cart.lines, items)
  const settings = data?.settings
  const upiAvailable = !!settings?.upi_id
  const isOpen = settings?.is_open ?? false
  const table = scanned && data?.tables.some((t) => t.is_active && t.label === scanned) ? scanned : null

  if (cart.lines.length === 0) {
    return (
      <>
        <DemoRibbon />
        <StudentHeader back="/" title="Your cart" right={<span />} />
        <EmptyState icon={<IconBag />} title="Your cart is empty" action={<Button onClick={() => navigate('/')}>Browse the menu</Button>}>
          Add something tasty and it will show up here.
        </EmptyState>
      </>
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setNotice(null)
    const nextErrors = {
      name: validateName(name) ?? undefined,
      phone: validatePhone(phone) ?? undefined,
      method: method ? undefined : 'Choose how you’ll pay.',
    }
    setErrors(nextErrors)
    if (nextErrors.name || nextErrors.phone || nextErrors.method) {
      const first = nextErrors.name ? nameId : nextErrors.phone ? phoneId : 'payment-method'
      document.getElementById(first)?.focus()
      return
    }
    if (priced.hasIssues || !isOpen || !method) return

    setSubmitting(true)
    try {
      // Re-check prices and availability against the latest menu before sending.
      const fresh = await backend.getPublicData()
      const check = priceCart(cart.lines, fresh.menu.items)
      if (!fresh.settings.is_open || check.hasIssues || check.total !== priced.total) {
        await refresh()
        setNotice(
          !fresh.settings.is_open
            ? 'The café just closed, so we can’t take orders right now.'
            : check.hasIssues
              ? 'Something in your cart just sold out. Please review your cart.'
              : `Prices were updated. Your new total is ${money(check.total)} — please review and place your order again.`,
        )
        return
      }

      const cleanName = cleanText(name)
      const cleanPhone = normalizePhone(phone)!
      saveDetails({ name: cleanName, phone: cleanPhone })
      const input: Omit<PlaceOrderInput, 'client_request_id' | 'access_token'> = {
        customer_name: cleanName,
        customer_phone: cleanPhone,
        payment_method: method,
        table_label: table,
        items: cart.lines.map((l) => ({ menu_item_id: l.menu_item_id, quantity: l.quantity, addon_ids: l.addon_ids, note: l.note || null })),
      }
      // Reuse the same request id + secret if a previous attempt for this exact
      // cart may have reached the server, so a retry can never create a duplicate.
      const fingerprint = JSON.stringify(input)
      const prev = pendingOrder()
      const ids = prev && prev.fingerprint === fingerprint ? prev : { client_request_id: newId(), access_token: newAccessToken(), fingerprint }
      setPendingOrder(ids)

      const order = await backend.placeOrder({ ...input, client_request_id: ids.client_request_id, access_token: ids.access_token })
      rememberOrder({ id: order.id, token: ids.access_token, order_no: order.order_no, created_at: order.created_at })
      setPendingOrder(null)
      cart.clear()
      navigate(`/order/${order.id}`, { replace: true, state: { justPlaced: true } })
    } catch (err) {
      const appErr = toAppError(err)
      if (appErr.code !== 'network' && appErr.code !== 'unknown') setPendingOrder(null)
      if (['item_unavailable', 'addon_unavailable', 'item_not_found', 'cafe_closed', 'upi_unavailable'].includes(appErr.code)) void refresh()
      setSubmitError(friendlyError(appErr))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-dvh pb-10">
      <DemoRibbon />
      <StudentHeader back="/" title="Your cart" right={<span />} />
      <form onSubmit={submit} noValidate className="mx-auto max-w-3xl space-y-6 px-4 pt-4">
        {!isOpen && settings && (
          <Banner tone="warning" title="We’re closed right now">
            {settings.closed_message} Your cart is saved on this phone.
          </Banner>
        )}

        <section aria-labelledby="items-h" className="card p-4">
          <div className="flex items-center justify-between">
            <h2 id="items-h" className="text-lg font-extrabold">Items</h2>
            <Link to="/" className="text-sm font-bold underline underline-offset-4">Add more</Link>
          </div>
          <ul className="mt-2 divide-y divide-line">
            {priced.lines.map(({ line, item, addons, unitPrice, lineTotal, issue }) => (
              <li key={line.key} className="flex gap-3 py-3.5">
                <span className="size-14 shrink-0 overflow-hidden rounded-xl ring-1 ring-line">
                  <FoodImage name={item?.name ?? 'Item'} url={backend.imageUrl(item?.image_path ?? null)} className="size-full" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold leading-snug">{item?.name ?? 'Removed item'}</p>
                  {addons.length > 0 && <p className="text-sm text-muted">+ {addons.map((a) => a.name).join(', ')}</p>}
                  {line.note && <p className="text-sm text-muted italic">“{line.note}”</p>}
                  {issue ? (
                    <p className="mt-1 text-sm font-bold text-danger">{ISSUE_TEXT[issue]}</p>
                  ) : (
                    <p className="tabular mt-0.5 text-sm text-muted">{money(unitPrice)} each</p>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    {issue ? (
                      <Button size="sm" variant="danger" onClick={() => cart.remove(line.key)}>
                        <IconTrash size={16} /> Remove
                      </Button>
                    ) : (
                      <QuantityStepper size="sm" value={line.quantity} min={0} onChange={(n) => cart.setQuantity(line.key, n)} label={item?.name ?? 'item'} />
                    )}
                    {!issue && <span className="tabular font-bold">{money(lineTotal)}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="details-h" className="card space-y-4 p-4">
          <div>
            <h2 id="details-h" className="text-lg font-extrabold">Your details</h2>
            <p className="text-sm text-muted">We call your name at the counter. Your number is only used for this order.</p>
          </div>
          <div>
            <label htmlFor={nameId} className="label">Name</label>
            <input
              id={nameId}
              className="field-input"
              autoComplete="given-name"
              autoCorrect="off"
              spellCheck={false}
              maxLength={40}
              value={name}
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? `${nameId}-err` : undefined}
              onChange={(e) => {
                setName(e.target.value)
                if (errors.name) setErrors((x) => ({ ...x, name: undefined }))
              }}
              placeholder="e.g. Nikitha"
            />
            {errors.name && <p id={`${nameId}-err`} className="mt-1.5 text-sm font-semibold text-danger">{errors.name}</p>}
          </div>
          <div>
            <label htmlFor={phoneId} className="label">Mobile number</label>
            <div className="flex">
              <span className="inline-flex items-center rounded-l-xl border border-r-0 border-line-strong bg-sunken px-3 font-semibold text-muted">+91</span>
              <input
                id={phoneId}
                className="field-input rounded-l-none"
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                maxLength={16}
                value={phone}
                aria-invalid={!!errors.phone}
                aria-describedby={errors.phone ? `${phoneId}-err` : undefined}
                onChange={(e) => {
                  setPhone(e.target.value.replace(/[^\d\s+]/g, ''))
                  if (errors.phone) setErrors((x) => ({ ...x, phone: undefined }))
                }}
                placeholder="98765 43210"
              />
            </div>
            {errors.phone && <p id={`${phoneId}-err`} className="mt-1.5 text-sm font-semibold text-danger">{errors.phone}</p>}
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-sunken px-3 py-2.5 text-sm">
            <IconPin size={16} className="shrink-0" />
            <span className="flex-1">
              <strong>Pickup at the counter</strong>
              {table && <> · You’re at table {table}</>}
            </span>
            {table && (
              <button
                type="button"
                className="font-bold underline underline-offset-4"
                onClick={() => {
                  setCurrentTable(null)
                  setScanned(null)
                }}
              >
                Not at {table}?
              </button>
            )}
          </div>
        </section>

        <fieldset className="card space-y-3 p-4" aria-describedby={errors.method ? 'method-err' : undefined}>
          <legend className="sr-only">Payment</legend>
          <h2 className="text-lg font-extrabold" aria-hidden="true">Payment</h2>
          <PaymentOption
            id="payment-method"
            checked={method === 'cash'}
            onSelect={() => {
              setMethod('cash')
              setErrors((x) => ({ ...x, method: undefined }))
            }}
            title="Cash at the counter"
            body="Pay when you collect your order."
          />
          <PaymentOption
            checked={method === 'upi'}
            onSelect={() => {
              setMethod('upi')
              setErrors((x) => ({ ...x, method: undefined }))
            }}
            disabled={!upiAvailable}
            title="UPI"
            body={upiAvailable ? 'Pay with any UPI app after placing the order. Staff confirm it before handover.' : 'Not available right now.'}
          />
          {errors.method && <p id="method-err" className="text-sm font-semibold text-danger">{errors.method}</p>}
        </fieldset>

        <section className="card p-4" aria-label="Order total">
          <div className="flex items-center justify-between text-sm text-muted">
            <span>{priced.units} {priced.units === 1 ? 'item' : 'items'}</span>
            <span className="tabular">{money(priced.total)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-line pt-3">
            <span className="text-lg font-extrabold">Total</span>
            <span className="tabular text-2xl font-extrabold">{money(priced.total)}</span>
          </div>
          <p className="mt-1 text-xs text-muted">No taxes or extra charges.</p>
        </section>

        {notice && <Banner tone="warning">{notice}</Banner>}
        {submitError && <Banner tone="danger">{submitError}</Banner>}
        {priced.hasIssues && <Banner tone="danger">Remove the sold-out items to continue.</Banner>}

        <div className="sticky bottom-0 -mx-4 bg-canvas/95 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
          <Button type="submit" size="lg" className="w-full" loading={submitting} disabled={!isOpen || priced.hasIssues || priced.units === 0}>
            {submitting ? 'Placing order…' : `Place order · ${money(priced.total)}`}
          </Button>
        </div>
      </form>
    </div>
  )
}

function PaymentOption({
  id, checked, onSelect, title, body, disabled,
}: { id?: string; checked: boolean; onSelect: () => void; title: string; body: string; disabled?: boolean }) {
  return (
    <label
      className={`flex items-start gap-3 rounded-2xl border-2 p-3.5 transition-colors ${
        checked ? 'border-ink bg-brand-soft' : 'border-line hover:border-line-strong'
      } ${disabled ? 'cursor-not-allowed opacity-55' : ''}`}
    >
      <input id={id} type="radio" name="payment" className="mt-1 size-5 accent-ink" checked={checked} onChange={onSelect} disabled={disabled} />
      <span>
        <span className="block font-bold">{title}</span>
        <span className="block text-sm text-muted">{body}</span>
      </span>
    </label>
  )
}
