import { Link } from 'react-router-dom'
import { IconBag, IconPin, IconReceipt } from './icons'
import { Wordmark } from './ui'

const STEPS = [
  { icon: IconBag, title: 'Order from your seat', body: 'Pick your food and add notes for the kitchen.' },
  { icon: IconReceipt, title: 'Pay your way', body: 'Cash at the counter, or UPI from your phone.' },
  { icon: IconPin, title: 'Collect when ready', body: 'This page tells you the moment it’s ready.' },
]

/** "How it works" plus café links, shown at the end of the student menu. */
export function SiteFooter() {
  return (
    <footer className="mt-14 bg-ink text-white">
      <div className="mx-auto max-w-3xl px-4 pt-10 pb-32">
        <h2 className="text-sm font-bold tracking-[0.25em] text-brand uppercase">How it works</h2>
        <ol className="mt-5 grid gap-5 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3 sm:flex-col">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-brand text-ink">
                <s.icon size={20} />
              </span>
              <span>
                <span className="block font-extrabold">
                  <span className="text-white/50">{i + 1}.</span> {s.title}
                </span>
                <span className="mt-0.5 block text-sm text-white/70">{s.body}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-10 flex flex-wrap items-end justify-between gap-6 border-t border-white/10 pt-6">
          <Wordmark onDark className="text-lg" />
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-semibold text-white/75">
            <Link to="/orders" viewTransition className="hover:text-white">My orders</Link>
            <Link to="/credits" viewTransition className="hover:text-white">Photo credits</Link>
            <Link to="/staff/login" className="hover:text-white">Staff login</Link>
          </nav>
        </div>
        <p className="mt-4 text-xs text-white/50">Bite &amp; Sip College Café · Pickup at the counter · Prices include all charges.</p>
      </div>
    </footer>
  )
}
