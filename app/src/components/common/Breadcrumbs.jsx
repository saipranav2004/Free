import { useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { CRUMB_LABELS } from '../../config/nav'

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------
// MOVED OUT OF THE TOP BAR. Cloudscape puts breadcrumbs in the content layout,
// directly above the page title, not in the product navigation. That is the
// right home for them: they describe where you are inside your data, and the
// top bar describes the product. Keeping them in the top bar was also what
// forced it to 64px and two stacked lines of text.
export function Breadcrumbs({ trail }) {
  const { pathname } = useLocation()
  const crumbs = useMemo(() => {
    if (trail) return trail
    const parts = pathname.split('/').filter(Boolean)
    let acc = ''
    return parts.map((p) => {
      acc += `/${p}`
      // An opaque segment (a UUID, a numeric id) gets a neutral label rather
      // than being printed raw. A 36 character UUID in a breadcrumb is noise,
      // not navigation.
      return { to: acc, label: CRUMB_LABELS[p] || (p.length > 12 ? 'Detail' : p) }
    })
  }, [pathname, trail])

  if (crumbs.length === 0) return null

  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
      <Link to="/" className="flex-none text-accent transition-colors hover:underline">
        Home
      </Link>
      {crumbs.map((c, i) => (
        <span key={c.to} className="flex min-w-0 items-center gap-1.5">
          <ChevronRight className="h-3.5 w-3.5 flex-none text-tertiary" strokeWidth={2} aria-hidden="true" />
          {i === crumbs.length - 1 ? (
            <span className="truncate text-secondary" aria-current="page">
              {c.label}
            </span>
          ) : (
            <Link to={c.to} className="truncate text-accent transition-colors hover:underline">
              {c.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  )
}
