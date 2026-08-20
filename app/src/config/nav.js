import {
  LayoutDashboard,
  Boxes,
  Vault,
  Radio,
  KeyRound,
  ScrollText,
  Users,
  Lock,
  FileKey2,
  ClipboardList,
  Archive,
  Settings as SettingsIcon,
  ShieldCheck,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Navigation model
// ---------------------------------------------------------------------------
// Lifted out of AppLayout so the sidebar, the topbar breadcrumb and the
// topbar's jump-to search all read the SAME list. Previously the sidebar
// owned these arrays privately, which meant anything else that wanted to
// know "what can you navigate to" had to duplicate them and drift.

// Self-service, visible to every authenticated user, regardless of role.
// (Role-dependent filtering happens in consoleNav() below, not here, so this
// stays the single canonical list.)
export const CONSOLE_NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/resources', label: 'Resources', icon: Boxes },
  { to: '/vault', label: 'Vault', icon: Vault },
  { to: '/sessions', label: 'Sessions', icon: Radio },
  { to: '/jit', label: 'JIT Access', icon: KeyRound },
  // { to: '/audit', label: 'Audit', icon: ScrollText },
]

// JIT ACCESS IS NOT RENDERED FOR AN ADMINISTRATOR. /jit is the self-service
// side of just-in-time access: raise a request for yourself, watch your own
// grants tick down. An administrator's relationship with JIT is the opposite
// one, they decide other people's requests and revoke other people's grants,
// which is Admin Center → JIT Approvals. Showing both put two different JIT
// screens in one sidebar, three items apart, and the one that couldn't do an
// approver's job sat higher. So for admin/root accounts the self-service entry
// is dropped here, and /jit itself redirects to /admin/jit (see App.jsx) so a
// stale link or bookmark still lands somewhere useful.
export function consoleNav(isAdmin) {
  return isAdmin ? CONSOLE_NAV.filter((i) => i.to !== '/jit') : CONSOLE_NAV
}

// Admin Center, only rendered for accounts holding the "admin" or "root"
// role (see AdminRoute for the matching route guard).
//
// NO "Overview" ENTRY. Admin Center → Overview has been removed: it was a
// strict subset of the Dashboard, so an administrator had two landing pages
// that each told half the story and neither was worth opening. Everything it
// did that the Dashboard didn't, the inline approve/deny queue, the denied
// feed, chain verification, now lives on the Dashboard. /admin redirects
// there (see App.jsx).
export const ADMIN_NAV = [
  { to: '/admin/identity', label: 'Identity', icon: Users },
  { to: '/admin/roles', label: 'Roles', icon: Lock },
  // Role-gated MFA enforcement. Sits next to Roles because that is what it
  // gates, the rule targets a role, and membership of the role is the gate.
  { to: '/admin/mfa-policy', label: 'MFA Policy', icon: ShieldCheck },
  { to: '/admin/policies', label: 'Policies', icon: FileKey2 },
  { to: '/admin/jit', label: 'JIT Approvals', icon: KeyRound },
  { to: '/admin/audit', label: 'Audit & Compliance', icon: ClipboardList },
  { to: '/admin/vault-ops', label: 'Vault Operations', icon: Archive },
]

// Presentational only, maps a path segment to a human label for the
// topbar breadcrumb. Reads location; never influences routing or fetching.
export const CRUMB_LABELS = {
  resources: 'Resources',
  vault: 'Vault',
  sessions: 'Sessions',
  jit: 'JIT Access',
  requests: 'Request',
  audit: 'Audit',
  settings: 'Settings',
  admin: 'Admin Center',
  identity: 'Identity',
  dashboard: 'Dashboard',
  roles: 'Roles',
  policies: 'Policies',
  'vault-ops': 'Vault Operations',
  'mfa-policy': 'MFA Policy',
  credentials: 'Credential',
  'mfa-verify': 'Verification',
}

// Everything the topbar's jump-to (⌘K) can navigate to. Navigation targets
// only, deliberately NOT a command palette: page-level *actions* need an
// action registry that doesn't exist yet, and a palette that lists actions
// it can't perform is worse than one that only jumps.
export function quickJumpTargets(isAdmin) {
  return [
    ...consoleNav(isAdmin).map((i) => ({ to: i.to, label: i.label, icon: i.icon, group: 'Console' })),
    ...(isAdmin
      ? ADMIN_NAV.map((i) => ({ to: i.to, label: i.label, icon: i.icon, group: 'Admin Center' }))
      : []),
    { to: '/settings', label: 'Settings', icon: SettingsIcon, group: 'Account' },
  ]
}
