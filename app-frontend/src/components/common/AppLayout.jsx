import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { X, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { me, logout as logoutApi } from '../../api/auth'
import { ADMIN_NAV, consoleNav } from '../../config/nav'
import { useMfaStatus } from '../../hooks/useMfaStatus'
import { MfaEnforcementGate } from '../auth/MfaEnforcementGate'
import { TopNavbar, NAVBAR_PT_CLASS, NAVBAR_BELOW_CLASS } from './TopNavbar'
import { Breadcrumbs } from './Breadcrumbs'
import { SessionExpiryNotice } from './SessionExpiryNotice'
import { IdleTimeoutNotice } from './IdleTimeoutNotice'
import { useIdleTimeout } from '../../hooks/useIdleTimeout'
import { toast } from 'sonner'

const SIDEBAR_STORAGE_KEY = 'pam_sidebar_collapsed'

// Sidebar starts OPEN. It only stays collapsed if this user explicitly
// collapsed it before (persisted per browser), a missing/invalid value
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
          // Active is BLUE AND BOLD, not a filled pill with a ring. AWS and
          // Cloudscape both mark the current item by weight and colour; a
          // filled chip on every visited page turns the nav into a row of
          // coloured blocks and competes with the content it points at.
          'group relative flex items-center rounded-lg text-sm outline-none transition-colors duration-100',
          collapsed ? 'h-9 w-9 justify-center' : 'h-9 gap-2.5 pl-2.5 pr-3',
          isActive
            ? 'bg-accent-soft font-bold text-accent'
            : 'font-medium text-secondary hover:bg-hover hover:text-primary'
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Active rail, the enterprise-console convention for "you are
 here", readable at a glance even in the collapsed icon rail. */}
          <span
            aria-hidden="true"
            className={clsx(
              'absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent transition-all duration-150',
              isActive ? 'opacity-100' : 'scale-y-0 opacity-0',
              collapsed && '-left-2'
            )}
          />
          <Icon
            className={clsx(
              'h-[1.05rem] w-[1.05rem] flex-none transition-colors',
              isActive ? 'text-accent' : 'text-tertiary group-hover:text-primary'
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
          <p className="flex-none text-xs font-semibold text-ink-600">{label}</p>
          <span className="h-px flex-1 bg-surface-800" aria-hidden="true" />
        </div>
      )}
      {collapsed && label && <div className="mx-auto mb-2 h-px w-5 bg-line" aria-hidden="true" />}
      <div className={clsx('space-y-0.5', collapsed && 'flex flex-col items-center')}>
        {items.map((item) => (
          <NavItem key={item.to} {...item} collapsed={collapsed} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  )
}

// Collapse control, pinned to the sidebar's own top-right corner, the
// placement every mature enterprise console uses. It belongs to the panel it
// resizes, so the affordance points at the edge that actually moves; when
// collapsed it centres in the icon rail.
function SidebarCollapseControl({ collapsed, onToggle, consoleTitle }) {
  return (
    <div
      className={clsx(
        // No bottom rule. With the "Console" caption gone the header sat
        // directly above the first nav item, and a full-width line between a
        // heading and the items it heads separates them rather than grouping
        // them. The padding below already does the separating.
        'flex flex-none items-center gap-2 px-3 py-2.5',
        collapsed ? 'justify-center' : 'justify-between'
      )}
    >
      {/* THE CONSOLE NAME LIVES HERE, heading the navigation it names. This is
          the AWS Console arrangement, where the service name sits at the top
          of the left panel rather than in the global bar, and Okta's, where
          the org heads the admin nav. It is role dependent: administrators
          operate the identity control plane, everyone else the privileged
          access console. Hidden when the rail is collapsed, where the icons
          are the only thing that survives. */}
      {!collapsed && (
        <h2
          className="min-w-0 truncate text-[0.8125rem] font-medium tracking-[0.02em] text-secondary"
          title={consoleTitle}
        >
          {consoleTitle}
        </h2>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-pressed={collapsed}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-hover hover:text-primary"
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
 the self-service JIT Access entry, their JIT surface is Admin
          Center → JIT Approvals, below. */}
      {/* NO LABEL ON THE FIRST GROUP.
          The panel is already headed "IAM Console" or "PAM Console" a few
          pixels above, so a "Console" caption under it named the same thing
          twice, and the divider that comes with a caption drew a line between
          a heading and the items it heads. A group label earns its place by
          separating one group from ANOTHER; the first group has nothing above
          it to be separated from. "Admin Center" keeps its label because it
          genuinely divides two sets of destinations. */}
      <NavSection items={consoleNav(isAdmin)} collapsed={collapsed} onNavigate={onNavigate} />
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
  const { pathname } = useLocation()

  // Console identity, role-dependent: administrators operate the identity
  // control plane ("IAM Console"), everyone else the privileged access
  // console ("PAM Console"). Rendered once, heading the sidebar.
  const consoleTitle = isAdmin ? 'IAM Console' : 'PAM Console'

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // Storage can be unavailable (private mode / locked-down profile) ,
        // the toggle still works for this session, it just won't persist.
      }
      return next
    })
  }, [])

  // SETTINGS COLLAPSES THE RAIL, AND ONLY SETTINGS.
  //
  // Every other page in this console is a place you navigate BETWEEN: you read
  // a table, open a row, come back, go somewhere else, and the rail is how you
  // do it. Settings is the one page you arrive at to finish a task and then
  // leave, and it is the widest form in the product. Giving it the extra
  // 200px is the same call Slack, Notion and the AWS billing console make for
  // their settings surfaces.
  //
  // It restores what it borrowed. The user's own choice is what is persisted
  // in localStorage; this only overrides it while settings is on screen, so
  // someone who keeps the rail open finds it open again the moment they
  // leave, and someone who keeps it collapsed sees no change at all.
  // Moving focus and scroll to the new page on every route change. Scroll is
  // reset because <main> is the scroll container, not the document, so the
  // browser's own restoration never applies to it.
  const mainRef = useRef(null)
  const firstRender = useRef(true)
  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    // NOT ON THE FIRST RENDER. Moving focus into <main> the moment the app
    // mounts puts the reader past the skip link, the navbar and the whole
    // sidebar before they have pressed anything, so the first Tab of the
    // session lands on a dashboard tile and the skip link can never be
    // reached at all. On arrival the browser's own starting point is correct;
    // it is only a route CHANGE that leaves focus stranded on a link that no
    // longer exists, and that is the case this fixes.
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    el.scrollTop = 0
    el.focus({ preventScroll: true })
  }, [pathname])

  const onSettings = pathname === '/settings' || pathname.startsWith('/settings/')
  useEffect(() => {
    if (onSettings) setCollapsed(true)
    else setCollapsed(readCollapsed())
  }, [onSettings])

  // /auth/me is the source of truth for "who am I", login only returns
  // access_token/expires_at, not the user's profile, so this fetch is what
  // actually populates the navbar identity and roles (and is also what
  // AdminRoute/the nav's isAdmin() check depends on).
  //
  // POLLED, deliberately. Roles are not static for the life of a session: root
  // can grant or revoke an admin delegation while the target is signed in, and
  // the server now answers with the account's CURRENT roles rather than the
  // ones frozen into the token at login. Fetching this once at mount would
  // leave a revoked administrator looking at an Admin Center nav where every
  // click 403s until they happened to reload the page. A minute is a fair
  // trade for one small request; window focus covers the common case of
  // someone coming back to the tab after being told their access changed.
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => me(signal),
    retry: false,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    // Overrides the client-wide staleTime of 10s. Without this, returning to
    // the tab inside that window is a no-op, because refetchOnWindowFocus only
    // refetches a query it considers stale. Coming back to the tab is exactly
    // the moment somebody should find out their access changed while they were
    // away, so this one query treats its answer as stale the instant it lands.
    staleTime: 0,
  })

  // Tell them, rather than repainting the navigation under their cursor.
  //
  // Now that /auth/me answers from the database instead of echoing the token,
  // a grant or a revocation lands mid-session. Silently growing or losing a
  // whole section of the console is the kind of change people assume is a bug:
  // an admin who just lost the Admin Center should be told they lost it, and
  // somebody who has just been delegated admin should know it is there.
  const knownRolesRef = useRef(null)
  useEffect(() => {
    if (!meQuery.data) return
    const next = Array.isArray(meQuery.data.roles) ? meQuery.data.roles : []
    const prev = knownRolesRef.current
    setUser(meQuery.data)

    // First resolution establishes the baseline, it is not a change.
    if (prev === null) {
      knownRolesRef.current = next
      return
    }
    const key = (list) => [...list].map((r) => String(r).toLowerCase()).sort().join(',')
    if (key(prev) === key(next)) return
    knownRolesRef.current = next

    const wasAdmin = prev.some((r) => r === 'admin' || r === 'root')
    const isAdminNow = next.some((r) => r === 'admin' || r === 'root')
    if (!wasAdmin && isAdminNow) {
      toast.success('Administrative access granted', {
        description: 'The Admin Center is now available in the sidebar.',
        duration: 8000,
      })
    } else if (wasAdmin && !isAdminNow) {
      toast.warning('Administrative access removed', {
        description: 'The Admin Center is no longer available on this account.',
        duration: 8000,
      })
    } else {
      toast.message('Your access changed', {
        description: `This account now holds: ${next.length ? next.join(', ') : 'no roles'}.`,
        duration: 8000,
      })
    }
  }, [meQuery.data, setUser])

  // A BACKSTOP, not the fix. The effect above only fires when `meQuery.data`
  // changes identity, and React Query's structural sharing hands back the very
  // same object when a refetch returns identical JSON. So if anything ever
  // clears the signed-in account mid-session, invalidating ['me'] cannot put it
  // back and the chrome renders "-" until the page is reloaded. That is what a
  // second factor being enrolled used to do. The real cause is fixed at its
  // source (store/authStore.js keeps the profile across a token swap); this
  // makes the class of bug unable to reach the screen again.
  useEffect(() => {
    if (user || !meQuery.data) return
    setUser(meQuery.data)
  }, [user, meQuery.data, setUser])

  // Subscribed, not computed inline: enabling or disabling MFA in Settings
  // must repaint the navbar's posture chip immediately, and on this backend
  // /auth/me never changes when it does. See hooks/useMfaStatus.js.
  const mfa = useMfaStatus(user)

  // Close the mobile drawer on Escape, a drawer you can only dismiss by
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
      // expired token), we still clear the local session below, a failed
      // logout call must never leave the user stuck "logged in" client-side
      // when they explicitly asked to log out.
    } finally {
      doLogout()
      navigate('/login', { replace: true })
      toast.success('Signed out')
    }
  }

  // INACTIVITY, MEASURED WHERE IT CAN BE MEASURED. The window comes from the
  // server (/auth/me publishes idle_timeout_min), because it is deployment
  // policy; the counting happens here, because the server sees this console's
  // own background polling as traffic and cannot tell it apart from a person.
  // Without this an unattended tab renewed itself indefinitely. See
  // hooks/useIdleTimeout.js.
  const idle = useIdleTimeout(meQuery.data?.idle_timeout_min, () => {
    doLogout()
    navigate('/login', { replace: true })
    toast.warning('Signed out for inactivity', {
      description: 'Your session ended because the console was left unattended. Sign in to carry on.',
      duration: 10000,
    })
  })

  return (
    // The shell is exactly one viewport tall with the top 4rem reserved for
    // the fixed navbar (pt-16 + border-box height:100vh), so the browser's
    // own document scrollbar never engages: only <main> scrolls. That is what
    // keeps BOTH the navbar and the sidebar visually pinned, a taller
    // document would otherwise scroll the whole shell and drag them along.
    <div className={clsx('h-screen overflow-hidden bg-app', NAVBAR_PT_CLASS)}>
      {/* Every console with a persistent nav owes keyboard users a way past
          it. Twenty-odd tab stops sit between the top of this page and its
          first real control, and without this they are paid on every single
          navigation. Visually hidden until focused, which is the whole
          convention. */}
      <a
        href="#main-content"
        className="sr-only z-[100] focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:rounded-lg focus:border focus:border-accent focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent focus:shadow-overlay"
      >
        Skip to main content
      </a>
      <TopNavbar
        isAdmin={isAdmin}
        user={user}
        roles={user?.roles || []}
        meLoading={meQuery.isLoading}
        mfa={mfa}
        onOpenMobileNav={() => setMobileNavOpen(true)}
        onLogout={handleLogout}
      />

      <div className="flex h-full min-h-0">
        {/* Desktop sidebar, starts BELOW the navbar (it is a child of the
 padded shell, not a sibling of the navbar) and never overlaps it.
            Its own surface step sits one level behind the content plane,
 which is what makes navigation read as chrome rather than as
 another panel of content. */}
        <aside
          className={clsx(
            'relative hidden flex-none flex-col border-r border-line bg-subtle transition-[width] duration-150 md:flex',
            collapsed ? 'w-[4.25rem]' : 'w-[15.5rem]'
          )}
        >
          <SidebarCollapseControl
            collapsed={collapsed}
            onToggle={toggleCollapsed}
            consoleTitle={consoleTitle}
          />
          <SidebarContent isAdmin={isAdmin} onNavigate={() => {}} collapsed={collapsed} />
        </aside>

        {/* Mobile sidebar (overlay), also opens below the navbar, so the
 company mark and profile stay reachable while it's open. */}
        {mobileNavOpen && (
          <div className={clsx('fixed inset-x-0 bottom-0 z-40 flex md:hidden', NAVBAR_BELOW_CLASS)}>
            <div
              className="animate-overlay-in absolute inset-0 bg-black/45"
              onClick={() => setMobileNavOpen(false)}
              aria-hidden="true"
            />
            <aside className="relative flex w-[16rem] flex-col border-r border-line bg-subtle shadow-overlay">
              <div className="flex flex-none items-center justify-between gap-2 border-b border-line px-3 py-2.5">
                <h2 className="min-w-0 truncate text-[0.8125rem] font-medium tracking-[0.02em] text-secondary">
                  {consoleTitle}
                </h2>
                <button
                  onClick={() => setMobileNavOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-hover hover:text-primary"
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

        {/* min-h-0 overrides flex's default min-height:auto, without it a
 flex child can't shrink below its content height, so
 overflow-y-auto never actually engages. */}
        {/* FOCUS AND SCROLL MOVE WITH THE ROUTE.
            A single page app changes the whole screen without moving either,
            so a keyboard or screen reader user who follows a link stays parked
            on the link they just left and hears nothing about where they are
            now, and a mouse user arrives at a new page already scrolled
            halfway down it. tabIndex -1 makes the region focusable
            programmatically without adding it to the tab order. */}
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none">
          {/* Role-gated MFA enforcement. The server has already decided , 
 this renders the decision: a dismissible banner while a policy
 is in monitor mode or inside its grace window, and a full
 interrupt when the session is restricted to enrolment only.
              Mounted inside <main> so the banner scrolls with the content
 rather than stealing a permanent strip of the viewport; the
 interrupt covers the whole screen from its own fixed layer. */}
          <MfaEnforcementGate me={user} mfaStatus={mfa} onSignOut={handleLogout} />
          {/* Fluid content column with a fixed 24px gutter, which is what
              Cloudscape uses. It deliberately does not grow with the viewport:
              a table wants the width, and escalating the gutter to 48px on a
              wide monitor just strands the content in the middle.
              Breadcrumbs live here, above the page, because they describe
              where you are in your data rather than in the product. */}
          <div className="mx-auto w-full max-w-[92rem] px-4 py-5 sm:px-6 sm:py-6">
            {/* Above the breadcrumb rather than below it: the session ending is
                not a fact about the page you are on, and it has to be seen
                before the reader starts something they cannot finish. */}
            <SessionExpiryNotice onSignOut={handleLogout} />
            {/* Only in the final minute, and only when a policy is set. A
                countdown that runs all day is wallpaper; one that appears with
                sixty seconds left is a prompt. */}
            {idle.warning && (
              <IdleTimeoutNotice secondsLeft={idle.secondsLeft} onStay={idle.stayActive} />
            )}
            <Breadcrumbs />
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
