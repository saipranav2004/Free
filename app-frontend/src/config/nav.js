import {
  LayoutDashboard,
  Boxes,
  Vault,
  Radio,
  KeyRound,
  Users,
  Lock,
  FileKey2,
  ClipboardList,
  Archive,
  Settings as SettingsIcon,
  ShieldCheck,
  Share2,
  Server,
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
  // THERE IS NO "MY ACTIVITY" ENTRY, and the page behind it is gone too.
  //
  // It was a self-scoped copy of Admin Center, Audit and Compliance: the same
  // table, the same filters, the same report builder, narrowed to one account.
  // The dashboard's own activity band already answers "what have I been doing"
  // for the person looking at it, and an administrator has the org-wide view
  // one section down this list. Two screens over one trail is one screen too
  // many in a sidebar this long.
  //
  // Nothing was weakened by removing it. The server side is unchanged, and the
  // caller-scoping on /pam/audit that made the page safe still applies to every
  // other reader of that endpoint.
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
  // Sits directly under Identity because it answers the question the identity
  // list raises: this account holds these roles, so what does that actually
  // reach? Same subject, one level deeper.
  { to: '/admin/identity-graph', label: 'Identity Graph', icon: Share2 },
  { to: '/admin/roles', label: 'Roles', icon: Lock },
  // Role-gated MFA enforcement. Sits next to Roles because that is what it
  // gates, the rule targets a role, and membership of the role is the gate.
  { to: '/admin/mfa-policy', label: 'MFA Policy', icon: ShieldCheck },
  { to: '/admin/policies', label: 'Policies', icon: FileKey2 },
  { to: '/admin/jit', label: 'JIT Approvals', icon: KeyRound },
  { to: '/admin/audit', label: 'Audit & Compliance', icon: ClipboardList },
  { to: '/admin/vault-ops', label: 'Vault Operations', icon: Archive },
  // Directly under Vault Operations because it is the other half of the same
  // subject: that page is what an operator does to the vault by hand, this is
  // what applications are allowed to read from it on their own.
  { to: '/admin/services', label: 'Service Identities', icon: Server },
]

// Presentational only, maps a path segment to a human label for the
// topbar breadcrumb. Reads location; never influences routing or fetching.
export const CRUMB_LABELS = {
  resources: 'Resources',
  vault: 'Vault',
  sessions: 'Sessions',
  jit: 'JIT Access',
  requests: 'Request',
  settings: 'Settings',
  admin: 'Admin Center',
  identity: 'Identity',
  dashboard: 'Dashboard',
  roles: 'Roles',
  'identity-graph': 'Identity Graph',
  policies: 'Policies',
  'vault-ops': 'Vault Operations',
  'mfa-policy': 'MFA Policy',
  services: 'Service Identities',
  credentials: 'Credential',
  'mfa-verify': 'Verification',
  // Without an entry a segment longer than 12 characters falls back to
  // "Detail", which is how /notifications came to read "Home > Detail".
  notifications: 'Notifications',
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
