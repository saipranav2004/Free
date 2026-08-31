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
  ScrollText,
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
  // "MY ACTIVITY" IS FOR EVERYONE, and it was for nobody: the entry was
  // commented out and the route was admin-gated, so a standard user's only
  // view of their own trail was a dashboard panel with a fixed cap on how many
  // entries it walked. There was no page to page through, no date range to
  // narrow, and no total to trust.
  //
  // The earlier reasoning (Okta keeps the System Log admin-only, AWS gates
  // CloudTrail, Entra keeps sign-in logs out of My Account) is about the
  // ORGANISATION's log, and it still holds: that one is Admin Center, Audit
  // and Compliance, and it stays there. Every one of those products also gives
  // an individual their OWN history (Okta's end-user sign-in activity, Entra's
  // My Sign-Ins), because "where has my account been used" is a question
  // people are supposed to be able to answer about themselves.
  //
  // What makes this safe is not the route: AuditPage sends the caller's own id
  // and the server now pins the scope to the token for any non-privileged
  // caller (audit_handler.go's callerScope), so the page cannot be widened by
  // editing a URL.
  { to: '/activity', label: 'My activity', icon: ScrollText },
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
]

// Presentational only, maps a path segment to a human label for the
// topbar breadcrumb. Reads location; never influences routing or fetching.
export const CRUMB_LABELS = {
  resources: 'Resources',
  vault: 'Vault',
  sessions: 'Sessions',
  jit: 'JIT Access',
  requests: 'Request',
  audit: 'My activity',
  activity: 'My activity',
  settings: 'Settings',
  admin: 'Admin Center',
  identity: 'Identity',
  dashboard: 'Dashboard',
  roles: 'Roles',
  'identity-graph': 'Identity Graph',
  policies: 'Policies',
  'vault-ops': 'Vault Operations',
  'mfa-policy': 'MFA Policy',
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
