import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { backend, isDemo } from '../../backend'
import { resetDemoData } from '../../backend/demo'
import { IconPrinter, IconQr, IconTrash } from '../../components/icons'
import { QrImage } from '../../components/QrImage'
import { Banner, Button, Dialog, Spinner, Switch, useToast } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { isValidUpiId, buildUpiLink } from '../../lib/upi'
import type { StaffMember } from '../../lib/types'
import { cleanText, normalizeTableLabel } from '../../lib/validation'
import { usePublicData } from '../../state/publicData'
import { useStaffSession } from '../../state/staffSession'

export function publicSiteUrl() {
  const configured = import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined
  return (configured || window.location.origin).replace(/\/$/, '')
}

export function SettingsPage() {
  const { data } = usePublicData()
  if (!data) return <div className="grid place-items-center py-24"><Spinner label="Loading settings" /></div>
  return (
    <main className="mx-auto max-w-3xl space-y-5 px-3 pt-3 pb-12 sm:px-4">
      <h1 className="text-xl font-extrabold">Settings</h1>
      <CafeStatus />
      <PaymentSettings />
      <TablesSettings />
      <StaffSettings />
      {isDemo && <DemoReset />}
    </main>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="card p-4 sm:p-5">
      <h2 className="text-lg font-extrabold">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function CafeStatus() {
  const { data, refresh } = usePublicData()
  const toast = useToast()
  const [message, setMessage] = useState(data!.settings.closed_message)
  const [busy, setBusy] = useState<string | null>(null)
  const settings = data!.settings
  const msgId = useId()

  async function save(key: string, patch: Parameters<typeof backend.updateSettings>[0], msg: string) {
    setBusy(key)
    try {
      await backend.updateSettings(patch)
      await refresh()
      toast(msg, 'success')
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Café status" description="When closed, students can browse the menu but can’t place orders.">
      <div className={`flex items-center gap-4 rounded-2xl p-4 ${settings.is_open ? 'bg-ready-soft' : 'bg-danger-soft'}`}>
        <div className="flex-1">
          <p className={`text-lg font-extrabold ${settings.is_open ? 'text-ready' : 'text-danger'}`}>
            {settings.is_open ? 'Open — taking orders' : 'Closed — orders paused'}
          </p>
          <p className="text-sm text-ink-2">Orders already placed are not affected.</p>
        </div>
        <Switch
          checked={settings.is_open}
          disabled={busy === 'open'}
          label="Taking orders"
          onChange={(v) => void save('open', { is_open: v }, v ? 'Café is open for orders' : 'Orders paused')}
        />
      </div>
      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save('msg', { closed_message: cleanText(message) || 'We’re closed right now. Please check back soon.' }, 'Message saved')
        }}
      >
        <label htmlFor={msgId} className="label">Message shown while closed</label>
        <div className="flex gap-2">
          <input id={msgId} className="field-input" maxLength={160} value={message} onChange={(e) => setMessage(e.target.value)} />
          <Button type="submit" variant="secondary" loading={busy === 'msg'} disabled={message === settings.closed_message}>Save</Button>
        </div>
      </form>
    </Section>
  )
}

function PaymentSettings() {
  const { data, refresh } = usePublicData()
  const toast = useToast()
  const settings = data!.settings
  const [upiId, setUpiId] = useState(settings.upi_id ?? '')
  const [payee, setPayee] = useState(settings.upi_payee_name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const idA = useId()
  const idB = useId()

  async function submit(e: FormEvent) {
    e.preventDefault()
    const id = upiId.trim()
    if (id && !isValidUpiId(id)) {
      setError('Enter a valid UPI ID, like bitesip@okaxis.')
      return
    }
    if (!cleanText(payee)) {
      setError('Enter the name customers will see.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      await backend.updateSettings({ upi_id: id || null, upi_payee_name: cleanText(payee) })
      await refresh()
      toast(id ? 'UPI details saved' : 'UPI turned off — cash only', 'success')
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  const dirty = (settings.upi_id ?? '') !== upiId.trim() || settings.upi_payee_name !== payee

  return (
    <Section title="UPI payments" description="Customers who choose UPI pay this ID directly. Staff confirm each payment in this account before handover.">
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={idA} className="label">Café UPI ID</label>
            <input id={idA} className="field-input" placeholder="bitesip@okaxis" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={upiId} aria-invalid={!!error} onChange={(e) => setUpiId(e.target.value)} />
            <p className="mt-1 text-xs text-muted">Leave empty to accept cash only.</p>
          </div>
          <div>
            <label htmlFor={idB} className="label">Name shown to customers</label>
            <input id={idB} className="field-input" maxLength={50} value={payee} onChange={(e) => setPayee(e.target.value)} />
          </div>
        </div>
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy} disabled={!dirty}>Save</Button>
          {settings.upi_id && (
            <Button variant="secondary" onClick={() => setTestOpen(true)}>
              <IconQr size={16} /> Test with ₹1
            </Button>
          )}
        </div>
        <Banner tone="info">
          The app never marks UPI orders as paid by itself — a customer tapping “I’ve paid” only asks staff to check. Some UPI apps limit payment links to personal IDs; a merchant (business) UPI ID works most reliably. Test it once with your own phone.
        </Banner>
      </form>
      {settings.upi_id && (
        <Dialog open={testOpen} onClose={() => setTestOpen(false)} title="Test your UPI QR" size="sm">
          <div className="flex flex-col items-center gap-3 px-5 py-5 text-center">
            <QrImage
              text={buildUpiLink({ upiId: settings.upi_id, payeeName: settings.upi_payee_name, amount: 1, note: 'Bite & Sip test' })}
              size={200}
              alt="Test UPI QR code for ₹1"
            />
            <p className="text-sm">Scan with your UPI app. It should show <strong>{settings.upi_payee_name}</strong> and <strong>₹1.00</strong>. You don’t need to complete the payment.</p>
          </div>
        </Dialog>
      )}
    </Section>
  )
}

function TablesSettings() {
  const { data, refresh } = usePublicData()
  const toast = useToast()
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tables = data!.tables

  async function run(key: string, fn: () => Promise<void>, msg: string) {
    setBusy(key)
    try {
      await fn()
      await refresh()
      toast(msg, 'success')
      return true
    } catch (err) {
      toast(friendlyError(err), 'error')
      return false
    } finally {
      setBusy(null)
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    // Accepts "T13" or a range like "T13-T20".
    const raw = label.trim().toUpperCase()
    const range = raw.match(/^([A-Z]*)(\d+)\s*(?:-|TO)\s*\1?(\d+)$/)
    let labels: string[] = []
    if (range) {
      const [, prefix, a, b] = range
      const from = Number(a)
      const to = Number(b)
      if (to < from || to - from > 50) {
        setError('Ranges can add up to 50 tables at a time.')
        return
      }
      for (let n = from; n <= to; n++) labels.push(`${prefix}${n}`)
    } else {
      const one = normalizeTableLabel(raw)
      if (one) labels = [one]
    }
    if (!labels.length || labels.some((l) => !normalizeTableLabel(l))) {
      setError('Use letters, numbers and dashes, up to 10 characters (e.g. T13 or T13-T20).')
      return
    }
    setError(null)
    if (await run('add', () => backend.addTables(labels), labels.length === 1 ? `Table ${labels[0]} added` : `${labels.length} tables added`)) setLabel('')
  }

  const active = tables.filter((t) => t.is_active)

  return (
    <Section title="Tables & QR codes" description="Each table gets its own QR code. Scanning it opens the menu with the table filled in.">
      <div className="flex flex-wrap gap-2">
        <Link to="/staff/print-qr" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-ink px-4 font-bold text-white hover:bg-ink-2">
          <IconPrinter size={18} /> Print table QR codes ({active.length})
        </Link>
        <Link to="/staff/print-qr?only=counter" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-field bg-surface px-4 font-bold hover:bg-sunken">
          <IconQr size={18} /> Print counter QR
        </Link>
      </div>
      <p className="mt-2 text-xs text-muted">QR codes link to {publicSiteUrl()}/t/&lt;table&gt;. Print them after deploying to the final web address.</p>

      <form onSubmit={add} className="mt-4 flex gap-2" noValidate>
        <input aria-label="New table label" className="field-input" placeholder="T13 or T13-T20" maxLength={20} value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button type="submit" loading={busy === 'add'} disabled={!label.trim()}>Add</Button>
      </form>
      {error && <p className="mt-1.5 text-sm font-semibold text-danger">{error}</p>}

      <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {tables.map((t) => (
          <li key={t.label} className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${t.is_active ? 'border-line' : 'border-dashed border-line-strong bg-sunken'}`}>
            <span className="flex-1 font-bold">{t.label}</span>
            <Switch checked={t.is_active} label={`Table ${t.label} active`} disabled={busy === t.label} onChange={(v) => void run(t.label, () => backend.setTableActive(t.label, v), v ? `${t.label} active` : `${t.label} hidden`)} />
            <button
              type="button"
              className="grid size-9 place-items-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger"
              aria-label={`Delete table ${t.label}`}
              disabled={busy === t.label}
              onClick={() => void run(t.label, () => backend.deleteTable(t.label), `${t.label} deleted`)}
            >
              <IconTrash size={16} />
            </button>
          </li>
        ))}
      </ul>
      {tables.length === 0 && <p className="mt-3 text-sm text-muted">No tables yet. Students can still order using the counter QR.</p>}
    </Section>
  )
}

function StaffSettings() {
  const { profile } = useStaffSession()
  const toast = useToast()
  const [staff, setStaff] = useState<StaffMember[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    try {
      setStaff(await backend.listStaff())
    } catch (err) {
      toast(friendlyError(err), 'error')
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function update(m: StaffMember, patch: Partial<Pick<StaffMember, 'role' | 'is_active'>>, msg: string) {
    setBusy(m.user_id)
    try {
      await backend.updateStaff(m.user_id, patch)
      await load()
      toast(msg, 'success')
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Staff" description="Kitchen staff can run the orders board and mark items sold out. Owners can also edit the menu, settings and reports.">
      {!staff ? (
        <Spinner label="Loading staff" />
      ) : (
        <ul className="divide-y divide-line rounded-2xl ring-1 ring-line">
          {staff.map((m) => {
            const self = m.user_id === profile?.user_id
            return (
              <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold">
                    {m.display_name} {self && <span className="text-sm font-semibold text-muted">(you)</span>}
                  </p>
                  <p className="text-sm text-muted capitalize">{m.role}{m.is_active ? '' : ' · deactivated'}</p>
                </div>
                <select
                  aria-label={`Role for ${m.display_name}`}
                  className="field-input w-auto py-2"
                  value={m.role}
                  disabled={self || busy === m.user_id}
                  onChange={(e) => void update(m, { role: e.target.value as StaffMember['role'] }, 'Role updated')}
                >
                  <option value="kitchen">Kitchen</option>
                  <option value="owner">Owner</option>
                </select>
                <Switch
                  checked={m.is_active}
                  label={`${m.display_name} can sign in`}
                  disabled={self || busy === m.user_id}
                  onChange={(v) => void update(m, { is_active: v }, v ? 'Access restored' : 'Access removed')}
                />
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-3 text-sm text-muted">
        To add a staff member, create their account with the <code className="rounded bg-sunken px-1">create-staff</code> script (see the setup guide). Public sign-up is disabled.
      </p>
    </Section>
  )
}

function DemoReset() {
  const [confirm, setConfirm] = useState(false)
  return (
    <Section title="Demo data" description="Demo mode keeps everything in this browser.">
      {confirm ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Reset menu, orders and settings to the sample data?</span>
          <Button variant="danger" size="sm" onClick={() => { resetDemoData(); window.location.reload() }}>Reset</Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setConfirm(true)}>Reset demo data</Button>
      )}
    </Section>
  )
}
