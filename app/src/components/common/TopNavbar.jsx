import { NavLink } from 'react-router-dom'
import { Menu } from 'lucide-react'
import { ThemeToggle } from './ThemeToggle'
import { GlobalSearch } from './GlobalSearch'
import { NotificationsMenu } from './NotificationsMenu'
import { UserMenu } from './UserMenu'
import logoWordmarkDark from '../../assets/logo-wordmark-dark.png'
import logoMark from '../../assets/logo-mark.png'

// ---------------------------------------------------------------------------
// Top navigation bar
// ---------------------------------------------------------------------------
// Fixed to the viewport, 48px tall, and DARK IN BOTH THEMES.
//
// Two changes from the previous 64px white bar, both for the same reason.
//
// The bar is dark because the page and its containers are now both white:
// with the shadows gone and the grey page gone, a white bar had nothing to
// separate it from the content. AWS Console, the Azure Portal and Salesforce
// all anchor the page the same way, and it draws a line the product wants
// anyway, above it is the product, below it is your data.
//
// It is 48px instead of 64px because the breadcrumb left. Breadcrumbs
// describe where you are inside your data, so they belong in the content
// area above the page title (see Breadcrumbs.jsx), not in product chrome.
// Stacking a console name over a breadcrumb was what made the bar two lines
// tall in the first place.
export const NAVBAR_HEIGHT_CLASS = 'h-12'

export function TopNavbar({
  consoleTitle,
  isAdmin = false,
  user,
  roles = [],
  meLoading = false,
  mfa,
  onOpenMobileNav,
  onLogout,
}) {
  return (
    <header className="fixed inset-x-0 top-0 z-50 h-12 border-b border-chrome-line bg-chrome text-chrome-fg">
      <div className="flex h-full items-center gap-2 pl-3 pr-2 sm:gap-3 sm:pl-4 sm:pr-3">
        {/* Company mark, left corner, and the only place it appears. */}
        <NavLink
          to="/"
          aria-label="Deep Algorithms, Dashboard"
          className="flex flex-none items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          {/* The bar is dark in both themes, so the dark-ground wordmark is
              always the right one. */}
          <img src={logoWordmarkDark} alt="Deep Algorithms" className="hidden h-6 w-auto sm:block" />
          <img src={logoMark} alt="Deep Algorithms" className="h-6 w-6 object-contain sm:hidden" />
        </NavLink>

        <button
          type="button"
          onClick={onOpenMobileNav}
          className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-chrome-muted transition-colors hover:bg-chrome-hover hover:text-chrome-fg md:hidden"
          aria-label="Open navigation"
        >
          <Menu className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.75} />
        </button>

        <span className="hidden h-5 w-px flex-none bg-chrome-line sm:block" aria-hidden="true" />

        {/* Console identity, one line. Role dependent: administrators operate
            the identity control plane, everyone else the privileged access
            console. */}
        <p className="min-w-0 flex-1 truncate text-sm font-bold text-chrome-fg">{consoleTitle}</p>

        <div className="flex flex-none items-center gap-1 sm:gap-1.5">
          <GlobalSearch isAdmin={isAdmin} />
          <NotificationsMenu isAdmin={isAdmin} />
          <ThemeToggle compact />
          <span className="mx-0.5 hidden h-5 w-px bg-chrome-line sm:block" aria-hidden="true" />
          <UserMenu user={user} roles={roles} onLogout={onLogout} loading={meLoading} mfa={mfa} />
        </div>
      </div>
    </header>
  )
}
