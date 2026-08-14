import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { X, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { me, logout as logoutApi } from '../../api/auth'
import { ADMIN_NAV, consoleNav } from '../../config/nav'
import { readMfaStatus } from '../../lib/mfaStatus'
import { TopNavbar } from './TopNavbar'
import { toast } from 'sonner'

const SIDEBAR_STORAGE_KEY = 'pam_sidebar_collapsed'

// Sidebar starts OPEN. It only stays collapsed if this user explicitly
// collapsed it before (persisted per browser) — a missing/invalid value
// always resolves to open.
function readCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function NavItem({ to, label, icon: Icon, end, onNavigate, collapsed }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        clsx(
          'group relative flex items-center rounded-lg text-[0.8125rem] font-medium outline-none transition-all duration-150',
          collapsed ? 'h-10 w-10 justify-center' : 'h-9 gap-2.5 pl-2.5 pr-3',
          isActive
            ? 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-600/15 dark:bg-blue-500/[0.12] dark:text-blue-100 dark:ring-blue-400/20'
            : 'text-ink-400 hover:bg-surface-800/70 hover:text-ink-50'
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Active rail — the enterprise-console convention for "you are
              here", readable at a glance even in the collapsed icon rail. */}
          <span
            aria-hidden="true"
            className={clsx(
              'absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-blue-600 transition-all duration-200 ease-emphasis dark:bg-blue-400',
              isActive ? 'opacity-100' : 'scale-y-0 opacity-0',
              collapsed && '-left-2'
            )}
          />
          <Icon
            className={clsx(
              'h-[1.05rem] w-[1.05rem] flex-none transition-colors',
              isActive ? 'text-blue-600 dark:text-blue-300' : 'text-ink-500 group-hover:text-ink-200'
            )}
            strokeWidth={1.5}
          />
          {!collapsed && <span className="truncate">{label}</span>}
        </>
      )}
    </NavLink>
  )
}

function NavSection({ label, items, collapsed, onNavigate }) {
  return (
    <div>
      {!collapsed && label && (
        <div className="mb-1.5 flex items-center gap-2 px-2.5">
          <p className="flex-none text-2xs font-semibold uppercase tracking-[0.12em] text-ink-600">{label}</p>
          <span className="h-px flex-1 bg-surface-800" aria-hidden="true" />
        </div>
      )}
      {collapsed && label && <div className="mx-auto mb-2 h-px w-5 bg-surface-700" aria-hidden="true" />}
      <div className={clsx('space-y-0.5', collapsed && 'flex flex-col items-center')}>
        {items.map((item) => (
          <NavItem key={item.to} {...item} collapsed={collapsed} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  )
}

// Collapse control — pinned to the sidebar's own top-right corner, the
// placement every mature enterprise console uses. It belongs to the panel it
// resizes, so the affordance points at the edge that actually moves; when
// collapsed it centres in the icon rail.
function SidebarCollapseControl({ collapsed, onToggle }) {
  return (
    <div
      className={clsx(
        'flex flex-none items-center px-3 pt-3',
        collapsed ? 'justify-center' : 'justify-end'
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-pressed={collapsed}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-500 transition-colors duration-150 hover:bg-surface-800 hover:text-ink-100"
      >
        {collapsed ? (
          <PanelLeftOpen className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.5} />
        ) : (
          <PanelLeftClose className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.5} />
        )}
      </button>
    </div>
  )
}

function SidebarContent({ isAdmin, onNavigate, collapsed }) {
  return (
    <nav
      aria-label="Primary"
      className={clsx(
        'scrollbar-none flex-1 space-y-6 overflow-y-auto overflow-x-hidden pb-5 pt-2.5',
        collapsed ? 'px-3' : 'px-4'
      )}
    >
      {/* consoleNav(isAdmin), not CONSOLE_NAV: an administrator does not get
          the self-service JIT Access entry — their JIT surface is Admin
          Center → JIT Approvals, below. */}
      <NavSection label={collapsed ? null : 'Console'} items={consoleNav(isAdmin)} collapsed={collapsed} onNavigate={onNavigate} />
      {isAdmin && (
        <NavSection label="Admin Center" items={ADMIN_NAV} collapsed={collapsed} onNavigate={onNavigate} />
      )}
    </nav>
  )
}

export function AppLayout() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const doLogout = useAuthStore((s) => s.logout)
  const isAdmin = useAuthStore((s) => s.isAdmin())
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  // Console identity, role-dependent: administrators operate the identity
  // control plane ("IAM Console"), everyone else the privileged access
  // console ("PAM Console"). Rendered once, in the topbar.
  const consoleTitle = isAdmin ? 'IAM Console' : 'PAM Console'

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // Storage can be unavailable (private mode / locked-down profile) —
        // the toggle still works for this session, it just won't persist.
      }
      return next
    })
  }, [])

  // /auth/me is the source of truth for "who am I" — login only returns
  // access_token/expires_at, not the user's profile, so this fetch is what
  // actually populates the navbar identity and roles (and is also what
  // AdminRoute/the nav's isAdmin() check depends on).
  const meQuery = useQuery({ queryKey: ['me'], queryFn: ({ signal }) => me(signal), retry: false })

  useEffect(() => {
    if (meQuery.data) setUser(meQuery.data)
  }, [meQuery.data, setUser])

  // Close the mobile drawer on Escape — a drawer you can only dismiss by
  // hitting a small X is a real accessibility gap.
  useEffect(() => {
    if (!mobileNavOpen) return undefined
    const onKey = (e) => e.key === 'Escape' && setMobileNavOpen(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mobileNavOpen])

  const handleLogout = async () => {
    try {
      await logoutApi()
    } catch {
      // Even if the server-side logout call fails (network blip, already
      // expired token), we still clear the local session below — a failed
      // logout call must never leave the user stuck "logged in" client-side
      // when they explicitly asked to log out.
    } finally {
      doLogout()
      navigate('/login', { replace: true })
      toast.success('Signed out')
    }
  }

  return (
    // The shell is exactly one viewport tall with the top 4rem reserved for
    // the fixed navbar (pt-16 + border-box height:100vh), so the browser's
    // own document scrollbar never engages: only <main> scrolls. That is what
    // keeps BOTH the navbar and the sidebar visually pinned — a taller
    // document would otherwise scroll the whole shell and drag them along.
    <div className="h-screen overflow-hidden bg-surface-950 pt-16">
      <TopNavbar
        consoleTitle={consoleTitle}
        isAdmin={isAdmin}
        user={user}
        roles={user?.roles || []}
        meLoading={meQuery.isLoading}
        mfa={readMfaStatus(user)}
        onOpenMobileNav={() => setMobileNavOpen(true)}
        onLogout={handleLogout}
      />

      <div className="flex h-full min-h-0">
        {/* Desktop sidebar — starts BELOW the navbar (it is a child of the
            padded shell, not a sibling of the navbar) and never overlaps it.
            Its own surface step sits one level behind the content plane,
            which is what makes navigation read as chrome rather than as
            another panel of content. */}
        <aside
          className={clsx(
            'relative hidden flex-none flex-col border-r border-surface-800 bg-surface-1000 transition-[width] duration-200 ease-emphasis md:flex',
            collapsed ? 'w-[4.75rem]' : 'w-[16.5rem]'
          )}
        >
          <SidebarCollapseControl collapsed={collapsed} onToggle={toggleCollapsed} />
          <SidebarContent isAdmin={isAdmin} onNavigate={() => {}} collapsed={collapsed} />
        </aside>

        {/* Mobile sidebar (overlay) — also opens below the navbar, so the
            company mark and profile stay reachable while it's open. */}
        {mobileNavOpen && (
          <div className="fixed inset-x-0 bottom-0 top-16 z-40 flex md:hidden">
            <div
              className="animate-overlay-in absolute inset-0 bg-slate-950/55 backdrop-blur-[3px] dark:bg-black/70"
              onClick={() => setMobileNavOpen(false)}
              aria-hidden="true"
            />
            <aside className="relative flex w-[17rem] flex-col border-r border-surface-800 bg-surface-1000 shadow-overlay">
              <div className="flex flex-none items-center justify-end px-3 pt-3">
                <button
                  onClick={() => setMobileNavOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-surface-800 hover:text-ink-50"
                  aria-label="Close navigation"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
              <SidebarContent
                isAdmin={isAdmin}
                onNavigate={() => setMobileNavOpen(false)}
                collapsed={false}
              />
            </aside>
          </div>
        )}

        {/* min-h-0 overrides flex's default min-height:auto — without it a
            flex child can't shrink below its content height, so
            overflow-y-auto never actually engages. */}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {/* FLUID content column: no hard max-width. A fixed rem cap (was
              88rem) looked correct on a laptop but on a 1440p/4K desktop it
              left a wide empty gutter on both sides with the content island
              stranded in the middle. The column now tracks the viewport and
              only the gutters grow with it, so tables, KPI strips and cards
              use the real screen at every size. */}
          <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-7 xl:px-10 2xl:px-12">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
