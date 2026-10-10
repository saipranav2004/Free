import { Link, useSearchParams } from 'react-router-dom'
import { IconArrowLeft, IconPrinter } from '../../components/icons'
import { QrImage } from '../../components/QrImage'
import { Button, Spinner, Wordmark } from '../../components/ui'
import { usePublicData } from '../../state/publicData'
import { publicSiteUrl } from './SettingsPage'

/** Printable A4 sheet of table QR cards (2 × 3 per page). */
export function PrintQrPage() {
  const { data } = usePublicData()
  const [params] = useSearchParams()
  if (!data) return <div className="grid min-h-dvh place-items-center"><Spinner label="Loading tables" /></div>

  const base = publicSiteUrl()
  const onlyCounter = params.get('only') === 'counter'
  const cards = onlyCounter
    ? [{ key: 'counter', title: 'Order here', subtitle: 'Pickup at the counter', url: `${base}/` }]
    : [
        ...data.tables.filter((t) => t.is_active).map((t) => ({ key: t.label, title: `Table ${t.label}`, subtitle: 'Pickup at the counter', url: `${base}/t/${encodeURIComponent(t.label)}` })),
        { key: 'counter', title: 'Order here', subtitle: 'Pickup at the counter', url: `${base}/` },
      ]

  return (
    <div className="min-h-dvh bg-sunken print:bg-white">
      <div className="no-print sticky top-0 z-10 flex items-center gap-3 bg-ink px-4 py-3 text-white">
        <Link to="/staff/settings" className="grid size-10 place-items-center rounded-full hover:bg-white/10" aria-label="Back to settings">
          <IconArrowLeft />
        </Link>
        <p className="flex-1 font-bold">{cards.length} QR {cards.length === 1 ? 'card' : 'cards'} · {base}</p>
        <Button onClick={() => window.print()}>
          <IconPrinter size={18} /> Print
        </Button>
      </div>
      <div className="mx-auto grid max-w-[210mm] grid-cols-1 gap-4 p-4 sm:grid-cols-2 print:grid-cols-2 print:gap-[6mm] print:p-0">
        {cards.map((c) => (
          <article
            key={c.key}
            className="flex break-inside-avoid flex-col items-center rounded-3xl border-[3px] border-ink bg-white p-6 text-center text-ink print:h-[88mm] print:rounded-2xl print:p-4"
          >
            <Wordmark className="text-lg" />
            <p className="mt-3 text-2xl font-extrabold">{c.title}</p>
            <div className="mt-3 rounded-2xl bg-brand p-3">
              <QrImage text={c.url} size={150} alt={`QR code for ${c.title}`} className="rounded-lg" />
            </div>
            <p className="mt-3 font-bold">Scan to order · {c.subtitle}</p>
            <p className="mt-1 text-xs break-all text-muted">{c.url.replace(/^https?:\/\//, '')}</p>
          </article>
        ))}
      </div>
    </div>
  )
}
