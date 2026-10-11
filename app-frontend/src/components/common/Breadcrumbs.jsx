import { useMemo } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { CRUMB_LABELS } from '../../config/nav'

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------
// MOVED OUT OF THE TOP BAR. Cloudscape puts breadcrumbs in the content layout,
// directly above the page title, not in the product navigation. That is the
// right home for them: they describe where you are inside your data, and the
// top bar describes the product. Keeping them in the top bar was also what
// forced it to 64px and two stacked lines of text.
// A BACK CONTROL SITS WITH THE BREADCRUMB, not on every page individually.
//
// "Add a back button for every page" is the request; putting one in each page
// component would be a dozen copies to keep in step, and would appear on the
// top-level pages too, where "back" has no meaning because the sidebar is the
// way in. The breadcrumb already renders only on nested routes and already
// knows the hierarchy, so it is the one place that gets both for free.
//
// It goes BACK IN HISTORY rather than up a level, because that is what a back
// button means to the person pressing it: return to where I just was. The
// breadcrumb links beside it are the "up a level" control, and having both is
// the point. When there is no history to return to (a pasted link, a new tab)
// it falls back to the parent crumb so it is never a dead control.
export function Breadcrumbs({ trail }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
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

  const parentTo = crumbs.length > 1 ? crumbs[crumbs.length - 2].to : '/'
  const goBack = () => {
    // history.state.idx is React Router's own position in the stack. 0 means
    // this entry is the first in this tab, so there is nothing to go back to.
    const idx = window.history.state?.idx
    if (typeof idx === 'number' && idx > 0) navigate(-1)
    else navigate(parentTo)
  }

  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
      <button
        type="button"
        onClick={goBack}
        aria-label="Go back"
        className="mr-1 flex h-6 w-6 flex-none items-center justify-center rounded-md text-tertiary transition-colors hover:bg-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={2} />
      </button>
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
