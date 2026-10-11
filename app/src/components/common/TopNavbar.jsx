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
// 64px. It carries a single line (no breadcrumb, that lives in the content
// area above the page title, see Breadcrumbs.jsx), but 48px squeezed the
// wordmark down to a size where it read as an icon rather than as a brand,
// and left the controls feeling cramped against the top edge.
//
// EVERY OTHER SURFACE MEASURES OFF THESE. The shell's top padding and the
// overlay panels that must sit below the bar all import these constants
// rather than repeating a number, because the last time this height changed
// the drawer kept its old offset and slid underneath the navbar.
export const NAVBAR_HEIGHT_CLASS = 'h-16'
/** Top offset for anything that must begin below the navbar. */
export const NAVBAR_BELOW_CLASS = 'top-16'
/** Padding the app shell needs so content clears the fixed navbar. */
export const NAVBAR_PT_CLASS = 'pt-16'

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
    <header className="fixed inset-x-0 top-0 z-50 h-16 border-b border-chrome-line bg-chrome text-chrome-fg">
      <div className="flex h-full items-center gap-2 pl-4 pr-3 sm:gap-3 sm:pl-5 sm:pr-4">
        {/* Company mark, left corner, and the only place it appears. */}
        <NavLink
          to="/"
          aria-label="Deep Algorithms, Dashboard"
          className="flex flex-none items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <img
            src={isDark ? logoWordmarkDark : logoWordmark}
            alt="Deep Algorithms"
            className="hidden h-8 w-auto sm:block"
          />
          <img src={logoMark} alt="Deep Algorithms" className="h-8 w-8 object-contain sm:hidden" />
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
