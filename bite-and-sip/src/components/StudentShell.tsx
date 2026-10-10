import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { isDemo } from '../backend'
import { IconArrowLeft, IconReceipt } from './icons'
import { Wordmark } from './ui'

export function DemoRibbon() {
  if (!isDemo) return null
  return (
    <div className="no-print bg-brand px-4 py-1.5 text-center text-xs font-bold text-ink">
      Demo mode — orders stay in this browser. Don’t make real payments.
    </div>
  )
}

/** Header for student pages. */
export function StudentHeader({ back, title, right }: { back?: string; title?: string; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 bg-ink text-white">
      <div className="mx-auto flex h-16 max-w-3xl items-center gap-2 px-4">
        {back ? (
          <Link to={back} className="-ml-2 grid size-11 place-items-center rounded-full hover:bg-white/10" aria-label="Back">
            <IconArrowLeft />
          </Link>
        ) : null}
        {title ? (
          <h1 className="flex-1 truncate text-lg font-extrabold">{title}</h1>
        ) : (
          <Link to="/" className="flex-1" aria-label="Bite & Sip menu">
            <Wordmark onDark className="text-base" />
          </Link>
        )}
        {right ?? (
          <NavLink to="/orders" className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-bold text-white hover:bg-white/10">
            <IconReceipt size={18} />
            My orders
          </NavLink>
        )}
      </div>
    </header>
  )
}
