import { NavLink } from 'react-router-dom'
import { Menu } from 'lucide-react'
import { useThemeStore } from '../../store/themeStore'
import { ThemeToggle } from './ThemeToggle'
import { GlobalSearch } from './GlobalSearch'
import { NotificationsMenu } from './NotificationsMenu'
import { UserMenu } from './UserMenu'
import logoWordmark from '../../assets/logo-wordmark.png'
import logoWordmarkDark from '../../assets/logo-wordmark-dark.png'
import logoMark from '../../assets/logo-mark.png'

// ---------------------------------------------------------------------------
// Top navigation bar
// ---------------------------------------------------------------------------
// Fixed to the viewport and 48px tall.
//
// It shares one quiet tint with the sidebar, one step off the white content
// area, with a real border underneath. Chrome is quiet, data is on white, and
// a line separates them rather than a change of brightness.
//
// It is 48px instead of the previous 64px because the breadcrumb left.
// Breadcrumbs describe where you are inside your data, so they belong in the
// content area above the page title (see Breadcrumbs.jsx), not in product
// chrome. Stacking a console name over a breadcrumb is what made the bar two
// lines tall in the first place.
export const NAVBAR_HEIGHT_CLASS = 'h-12'

export function TopNavbar({
  isAdmin = false,
  user,
  roles = [],
  meLoading = false,
  mfa,
  onOpenMobileNav,
  onLogout,
}) {
  const isDark = useThemeStore((s) => s.isDark)

  return (
    <header className="fixed inset-x-0 top-0 z-50 h-12 border-b border-chrome-line bg-chrome text-chrome-fg">
      <div className="flex h-full items-center gap-2 pl-3 pr-2 sm:gap-3 sm:pl-4 sm:pr-3">
        {/* Company mark, left corner, and the only place it appears. */}
        <NavLink
          to="/"
          aria-label="Deep Algorithms, Dashboard"
          className="flex flex-none items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <img
            src={isDark ? logoWordmarkDark : logoWordmark}
            alt="Deep Algorithms"
            className="hidden h-6 w-auto sm:block"
          />
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

        {/* THE CONSOLE NAME NOW HEADS THE SIDEBAR, NOT THIS BAR. It names the
            navigation you are looking at, so it belongs to the panel that
            holds it, which is where AWS puts the service name and Okta puts
            the org. The top bar is left for what is global to the account:
            the company mark, search, notifications, theme and profile. */}
        <span className="min-w-0 flex-1" aria-hidden="true" />

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
