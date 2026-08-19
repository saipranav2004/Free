import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import clsx from 'clsx'
import {
  Activity, Archive, Boxes, ClipboardList, FileKey2, KeyRound, LayoutDashboard,
  Lock, Menu, Moon, PanelLeftClose, PanelLeftOpen, Radio, ScrollText, Search,
  Settings as SettingsIcon, ShieldCheck, Sun, Users, Vault, X,
} from 'lucide-react'
import { useViewer } from '../state/viewer'
import { Button } from '../ui/primitives'

// ---------------------------------------------------------------------------
// Navigation model (Phase 4.6)
// ---------------------------------------------------------------------------
// Persistent 240px sidebar ≥1280 · 56px icon rail 768–1279 · off-canvas drawer
// <768. One active indicator (accent rail + accent text + subtle fill), not
// four. Page actions never live in the top bar — they belong beside the
// content they change.

const CONSOLE_NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/resources', label: 'Resources', icon: Boxes },
  { to: '/vault', label: 'Vault', icon: Vault },
  { to: '/sessions', label: 'Sessions', icon: Radio },
  { to: '/jit', label: 'JIT Access', icon: KeyRound, selfServiceOnly: true },
  // FIXES F-01: /audit was routed but commented out of the nav, so the page
  // was live and unreachable. It comes back as the SELF-SCOPED trail.
  { to: '/activity', label: 'My activity', icon: ScrollText },
]

const ADMIN_NAV = [
  { to: '/admin/jit', label: 'Approvals', icon: KeyRound, badgeKey: 'pending' },
  { to: '/admin/identity', label: 'Identity', icon: Users },
  { to: '/admin/roles', label: 'Roles', icon: Lock },
  { to: '/admin/policies', label: 'Policies', icon: FileKey2 },
  { to: '/admin/mfa-policy', label: 'MFA Policy', icon: ShieldCheck },
  { to: '/admin/audit', label: 'Audit', icon: ClipboardList },
  { to: '/admin/compliance', label: 'Compliance', icon: Activity },
  { to: '/admin/vault-ops', label: 'Vault Operations', icon: Archive },
]

function NavItem({ to, label, icon: Icon, end, collapsed, badge, onNavigate }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        clsx(
          'group relative flex items-center rounded text-sm transition-colors duration-100',
          collapsed ? 'h-8 w-8 justify-center' : 'h-8 gap-2 pl-3 pr-2',
          isActive
            ? 'bg-subtle font-semibold text-accent'
            : 'font-normal text-secondary hover:bg-hover hover:text-primary'
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={clsx(
              'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent transition-opacity duration-100',
              isActive ? 'opacity-100' : 'opacity-0'
            )}
          />
          <Icon className="h-4 w-4 flex-none" strokeWidth={1.75} />
          {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
          {!collapsed && badge > 0 && (
            <span className="flex-none rounded-full bg-warn-soft px-2 text-micro font-semibold tabular text-warn">
              {badge}
            </span>
          )}
          {collapsed && badge > 0 && (
            <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-warn" />
          )}
        </>
      )}
    </NavLink>
  )
}

function SidebarBody({ collapsed, onNavigate, isAdmin, pendingCount }) {
  const consoleItems = CONSOLE_NAV.filter((i) => !(i.selfServiceOnly && isAdmin))
  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
      <div className="space-y-0.5">
        {!collapsed && (
          <p className="mb-2 px-3 text-micro font-semibold uppercase text-tertiary">Console</p>
        )}
        {consoleItems.map((i) => (
          <NavItem key={i.to} {...i} collapsed={collapsed} onNavigate={onNavigate} />
        ))}
      </div>

      {isAdmin && (
        <div className="space-y-0.5">
          {!collapsed ? (
            <p className="mb-2 px-3 text-micro font-semibold uppercase text-tertiary">Admin Center</p>
          ) : (
            <div className="mx-auto mb-2 h-px w-4 bg-line" aria-hidden="true" />
          )}
          {ADMIN_NAV.map((i) => (
            <NavItem
              key={i.to}
              {...i}
              collapsed={collapsed}
              onNavigate={onNavigate}
              badge={i.badgeKey === 'pending' ? pendingCount : undefined}
            />
          ))}
        </div>
      )}

      <div className="mt-auto space-y-0.5">
        <NavItem to="/settings" label="Settings" icon={SettingsIcon} collapsed={collapsed} onNavigate={onNavigate} />
      </div>
    </nav>
  )
}

// ── Role switcher ─────────────────────────────────────────────────────────
// Mockup-only affordance so a reviewer can see every role-conditional branch
// without three logins. It is NOT a proposed product feature.
function RoleSwitcher() {
  const { role, setRole } = useViewer()
  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-micro font-semibold uppercase text-tertiary sm:inline">Viewing as</span>
      <div className="inline-flex rounded border border-line p-0.5">
        {['user', 'admin', 'root'].map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRole(r)}
            className={clsx(
              'h-6 rounded-sm px-2 text-xs font-semibold capitalize transition-colors duration-100',
              role === r ? 'bg-subtle text-primary' : 'text-tertiary hover:text-primary'
            )}
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  )
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])
  return [dark, setDark]
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [dark, setDark] = useTheme()
  const { viewer, isAdmin, pendingCount } = useViewer()
  const location = useLocation()

  useEffect(() => setDrawerOpen(false), [location.pathname])

  // Presentational only — maps a path segment to a human label. Never
  // influences routing.
  const CRUMB = {
    resources: 'Resources', vault: 'Vault', sessions: 'Sessions', jit: 'JIT Access',
    requests: 'Request', activity: 'My activity', settings: 'Settings',
    admin: 'Admin Center', identity: 'Identity', roles: 'Roles', policies: 'Policies',
    'vault-ops': 'Vault Operations', 'mfa-policy': 'MFA Policy', audit: 'Audit',
    compliance: 'Compliance', credentials: 'Credential', denied: 'Permission denied',
  }
  const crumb = location.pathname
    .split('/')
    .filter(Boolean)
    // Ids (uuid-ish or fixture-ish) read as noise in a breadcrumb.
    .filter((seg) => !/^(res|jit|usr|sess|cred|safe|fld|grant|rec|evt|role|pol|dev|ver)-/.test(seg))
    .map((seg) => CRUMB[seg] || seg)

  return (
    <div className="flex h-full bg-app">
      {/* Desktop sidebar. Hidden below 768 where the drawer takes over. */}
      <aside
        className={clsx(
          'hidden flex-none flex-col border-r border-line bg-surface transition-[width] duration-150 md:flex',
          collapsed ? 'w-14' : 'w-60'
        )}
      >
        <div className={clsx('flex h-14 flex-none items-center gap-2 border-b border-line px-3', collapsed && 'justify-center')}>
          <span className="flex h-6 w-6 flex-none items-center justify-center rounded bg-accent text-micro font-semibold text-white">
            P
          </span>
          {!collapsed && <span className="truncate text-sm font-semibold text-primary">PAM Console</span>}
          {!collapsed && (
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label="Collapse sidebar"
              className="ml-auto flex h-7 w-7 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
            >
              <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
        </div>
        {collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
            className="mx-auto mt-3 flex h-7 w-7 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
          >
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
        )}
        <SidebarBody collapsed={collapsed} isAdmin={isAdmin} pendingCount={pendingCount} />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="anim-overlay absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="anim-drawer absolute inset-y-0 left-0 flex w-60 flex-col border-r border-line bg-surface">
            <div className="flex h-14 flex-none items-center gap-2 border-b border-line px-3">
              <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-micro font-semibold text-white">P</span>
              <span className="text-sm font-semibold text-primary">PAM Console</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation"
                className="ml-auto flex h-9 w-9 items-center justify-center rounded text-tertiary hover:bg-hover"
              >
                <X className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>
            <SidebarBody collapsed={false} isAdmin={isAdmin} pendingCount={pendingCount} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="flex h-11 w-11 flex-none items-center justify-center rounded text-tertiary hover:bg-hover md:hidden"
          >
            <Menu className="h-4 w-4" strokeWidth={1.75} />
          </button>

          <nav aria-label="Breadcrumb" className="hidden min-w-0 flex-1 items-center gap-2 text-sm text-tertiary sm:flex">
            <span className="truncate">{crumb.length === 0 ? 'Dashboard' : crumb.join(' / ')}</span>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="hidden h-8 items-center gap-2 rounded border border-line px-2 text-xs text-tertiary hover:text-primary lg:flex"
            >
              <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
              Jump to…
              <kbd className="rounded border border-line px-1 font-mono text-micro">⌘K</kbd>
            </button>
            <RoleSwitcher />
            <button
              type="button"
              onClick={() => setDark(!dark)}
              aria-label="Toggle theme"
              className="flex h-8 w-8 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
            >
              {dark ? <Sun className="h-4 w-4" strokeWidth={1.75} /> : <Moon className="h-4 w-4" strokeWidth={1.75} />}
            </button>
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-subtle text-micro font-semibold text-primary">
              {viewer.username.slice(0, 2).toUpperCase()}
            </span>
          </div>
        </header>

        {/* Content caps at 1440 and centres, so an ultrawide doesn't stretch a
            table to 2500px of unreadable line length (Phase 6). */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-content px-4 py-6 md:px-8 md:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

export { CONSOLE_NAV, ADMIN_NAV }
