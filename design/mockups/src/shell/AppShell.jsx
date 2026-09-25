import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import {
  Activity, Archive, Bell, Boxes, ClipboardList, FileKey2, KeyRound, LayoutDashboard,
  LogOut, Lock, Menu, Moon, PanelLeftClose, PanelLeftOpen, Radio, ScrollText, Search,
  Settings as SettingsIcon, ShieldAlert, ShieldCheck, Sun, Users, Vault, X,
} from 'lucide-react'
import { useViewer } from '../state/viewer'
import {
  adminStats, grants, jitRequests,
  resources as fixResources, safes as fixSafes, users as fixUsers,
} from '../fixtures'
import { relative } from '../lib/format'
import { Menu as Popover, MenuDivider, MenuItem, MenuLabel } from '../ui/overlay'
import { StatusDot } from '../ui/primitives'

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


// ── Notifications ─────────────────────────────────────────────────────────
// Mirrors NotificationsMenu.jsx exactly: it is NOT a generic feed. It runs
// four real queries and renders only what those return — for an admin, the
// pending and one-approval-short queues; for everyone, their own in-flight
// requests and grants about to expire. Nothing else is invented, because
// nothing else has an endpoint behind it.
function NotificationsMenu({ isAdmin }) {
  const pending = jitRequests.filter((r) => r.status === 'PENDING').length
  const second = jitRequests.filter((r) => r.status === 'PARTIALLY_APPROVED').length
  const expiring = grants.filter(
    (g) => g.status === 'ACTIVE' && new Date(g.expires_at).getTime() - Date.now() < 12 * 3600_000
  )
  const items = isAdmin
    ? [
        pending > 0 && {
          tone: 'warn',
          title: `${pending} request${pending === 1 ? '' : 's'} awaiting a first approval`,
          to: '/admin/jit',
        },
        second > 0 && {
          tone: 'warn',
          title: `${second} waiting on a second, different approver`,
          to: '/admin/jit',
        },
        adminStats.active_breakglass_grants > 0 && {
          tone: 'danger',
          title: `${adminStats.active_breakglass_grants} break-glass grant in force`,
          to: '/admin/jit',
        },
      ].filter(Boolean)
    : expiring.map((g) => ({
        tone: 'warn',
        title: `${g.resource_name} expires ${relative(g.expires_at)}`,
        to: '/jit',
      }))

  return (
    <Popover
      label="Notifications"
      width="w-72"
      trigger={(open) => (
        <span
          className={clsx(
            'relative flex h-9 w-9 cursor-pointer items-center justify-center rounded',
            open ? 'bg-hover text-primary' : 'text-tertiary hover:bg-hover hover:text-primary'
          )}
        >
          <Bell className="h-4 w-4" strokeWidth={1.75} />
          {items.length > 0 && (
            <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" />
          )}
        </span>
      )}
    >
      <MenuLabel>Needs attention</MenuLabel>
      {items.length === 0 ? (
        <p className="px-3 py-3 text-sm text-tertiary">Nothing is waiting on you.</p>
      ) : (
        items.map((n) => (
          <NavLink
            key={n.title}
            to={n.to}
            role="menuitem"
            className="flex items-start gap-2 px-3 py-2 text-sm text-primary hover:bg-hover"
          >
            <StatusDot tone={n.tone} className="mt-1" />
            <span className="min-w-0 flex-1">{n.title}</span>
          </NavLink>
        ))
      )}
      <MenuDivider />
      <p className="px-3 pb-2 pt-1 text-xs leading-relaxed text-tertiary">
        Built from the JIT queues and your own grants. There is no notification endpoint — nothing here is
        pushed, and nothing is marked read.
      </p>
    </Popover>
  )
}

// ── User menu ─────────────────────────────────────────────────────────────
// Carries the one thing an account menu in a PAM console must carry: MFA
// posture. Everything else is navigation.
function UserMenu({ viewer, roles, dark, onToggleTheme }) {
  return (
    <Popover
      label="Account"
      width="w-64"
      trigger={(open) => (
        <span
          className={clsx(
            'flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-micro font-semibold',
            open ? 'bg-accent text-white' : 'bg-subtle text-primary hover:bg-hover'
          )}
        >
          {viewer.username.slice(0, 2).toUpperCase()}
        </span>
      )}
    >
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-primary">{viewer.full_name || viewer.username}</p>
        <p className="truncate font-mono text-xs text-tertiary">{viewer.email}</p>
        <p className="mt-2 text-xs text-tertiary">{roles.join(' · ')}</p>
      </div>
      <MenuDivider />
      <div className="flex items-center gap-2 px-3 py-2">
        {viewer.mfa_enabled ? (
          <StatusDot tone="ok" label="MFA enrolled" />
        ) : (
          <StatusDot tone="warn" label="No second factor" />
        )}
      </div>
      <MenuItem icon={ShieldCheck}>
        <NavLink to="/settings">{viewer.mfa_enabled ? 'Manage MFA' : 'Enrol now'}</NavLink>
      </MenuItem>
      <MenuItem icon={SettingsIcon}>
        <NavLink to="/settings">Settings</NavLink>
      </MenuItem>
      <MenuItem icon={dark ? Sun : Moon} onClick={onToggleTheme} className="sm:hidden">
        {dark ? 'Light theme' : 'Dark theme'}
      </MenuItem>
      <MenuDivider />
      <MenuItem icon={LogOut} danger>
        Sign out
      </MenuItem>
    </Popover>
  )
}

// ── Command palette ───────────────────────────────────────────────────────
// NAVIGATION ONLY, and the reason is worth keeping: the existing QuickJump
// says a palette that lists actions it cannot perform is worse than one that
// only jumps, and no action registry exists. What it gains here is the real
// object scope GlobalSearch.jsx already queries — resources, safes, accounts —
// so ⌘K reaches objects, not just pages.
function CommandPalette({ open, onClose, isAdmin }) {
  const [q, setQ] = useState('')
  const nav = useNavigate()
  useEffect(() => {
    if (open) setQ('')
  }, [open])
  if (!open) return null

  const s = q.toLowerCase()
  const pages = [
    ...CONSOLE_NAV.filter((i) => !(i.selfServiceOnly && isAdmin)),
    ...(isAdmin ? ADMIN_NAV : []),
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ].filter((i) => i.label.toLowerCase().includes(s))
  const objects = [
    ...fixResources.filter((r) => r.name.toLowerCase().includes(s)).slice(0, 5).map((r) => ({ to: `/resources/${r.id}`, label: r.name, group: 'Resources', sub: `${r.host}:${r.port}` })),
    ...fixSafes.filter((x) => x.name.toLowerCase().includes(s)).slice(0, 3).map((x) => ({ to: `/vault/${x.id}`, label: x.name, group: 'Vault', sub: 'safe' })),
    ...(isAdmin
      ? fixUsers.filter((u) => u.username.toLowerCase().includes(s)).slice(0, 5).map((u) => ({ to: `/admin/identity/${u.user_id}`, label: u.username, group: 'Accounts', sub: u.email }))
      : []),
  ]

  const go = (to) => {
    onClose()
    nav(to)
  }

  return (
    <div className="fixed inset-0 z-[55] flex items-start justify-center p-4 sm:pt-24">
      <div className="anim-overlay absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        className="anim-panel relative flex max-h-[70vh] w-full max-w-[34rem] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-overlay"
      >
        <div className="flex flex-none items-center gap-2 border-b border-line px-3">
          <Search className="h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
            placeholder="Jump to a page, resource, safe or account"
            aria-label="Jump to"
            className="h-11 w-full bg-transparent text-base text-primary placeholder:text-tertiary focus:outline-none"
          />
          <kbd className="flex-none rounded border border-line px-1 font-mono text-micro text-tertiary">esc</kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {pages.length === 0 && objects.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-tertiary">Nothing matches “{q}”.</p>
          )}
          {pages.length > 0 && <MenuLabel>Pages</MenuLabel>}
          {pages.map((i) => (
            <button
              key={i.to}
              type="button"
              onClick={() => go(i.to)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-primary hover:bg-hover"
            >
              <i.icon className="h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
              {i.label}
            </button>
          ))}
          {objects.length > 0 && <MenuLabel>Objects</MenuLabel>}
          {objects.map((o) => (
            <button
              key={o.to}
              type="button"
              onClick={() => go(o.to)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate text-primary">{o.label}</span>
              <span className="flex-none truncate font-mono text-xs text-tertiary">{o.sub}</span>
              <span className="flex-none text-micro uppercase text-tertiary">{o.group}</span>
            </button>
          ))}
        </div>
        <p className="flex-none border-t border-line px-3 py-2 text-xs text-tertiary">
          Navigation only — no page-level actions. There is no action registry, and a palette that lists actions
          it cannot perform is worse than one that only jumps.
        </p>
      </div>
    </div>
  )
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [dark, setDark] = useTheme()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const { viewer, roles, isAdmin, pendingCount } = useViewer()
  const location = useLocation()

  useEffect(() => setDrawerOpen(false), [location.pathname])

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onOpenSearch = () => setPaletteOpen(true)

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

          <div className="ml-auto flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={onOpenSearch}
              className="hidden h-8 items-center gap-2 rounded border border-line px-2 text-xs text-tertiary hover:border-line-strong hover:text-primary lg:flex"
            >
              <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
              Search resources, safes, accounts
              <kbd className="rounded border border-line px-1 font-mono text-micro">⌘K</kbd>
            </button>
            <button
              type="button"
              onClick={onOpenSearch}
              aria-label="Search"
              className="flex h-9 w-9 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary lg:hidden"
            >
              <Search className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <RoleSwitcher />
            <NotificationsMenu isAdmin={isAdmin} />
            <button
              type="button"
              onClick={() => setDark(!dark)}
              aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
              className="hidden h-9 w-9 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary sm:flex"
            >
              {dark ? <Sun className="h-4 w-4" strokeWidth={1.75} /> : <Moon className="h-4 w-4" strokeWidth={1.75} />}
            </button>
            <UserMenu viewer={viewer} roles={roles} dark={dark} onToggleTheme={() => setDark(!dark)} />
          </div>
        </header>

        {/* Content caps at 1440 and centres, so an ultrawide doesn't stretch a
            table to 2500px of unreadable line length (Phase 6). */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-content px-4 py-4 md:px-6 md:py-6">
            <Outlet />
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} isAdmin={isAdmin} />
    </div>
  )
}

export { CONSOLE_NAV, ADMIN_NAV }
