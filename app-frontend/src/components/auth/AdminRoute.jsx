import { Outlet } from 'react-router-dom'
import { ShieldOff, Scissors } from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { FullPageSpinner } from '../common/Spinner'
import { Button } from '../common/Button'

// Gates the entire /admin/* subtree client-side. This is a UX guard, not a
// security boundary: the real enforcement is server-side (RequireAdmin on
// every /api/v1/pam/admin/* route), the way a client-side check should never
// be the only thing between a user and a privileged action. This just keeps a
// non-admin from watching the Admin Center shell paint before every one of
// its requests 403s.
//
// TWO BUGS FIXED HERE.
//
// 1. IT REDIRECTED BEFORE IT KNEW. `isAdmin()` reads `user.roles`, and `user`
// is null between sign-in and the first GET /auth/me. Any hard load of an
// admin URL in that window, following a deep link from the sign-in
// redirect, opening a bookmark, was read as "not an admin" and bounced to
// the dashboard. Unknown is now its own state and it waits.
//
// 2. IT DENIED SILENTLY. A non-admin who follows an admin link landed on the
// dashboard with no explanation, which reads as a broken link rather than
// as a decision. Permission denied is a real state now, and it says which
// role the area needs and how to get back.
// A SCOPED DELEGATE IS TOLD THEY ARE ONE, on every Admin Center screen.
//
// scope_resource_ids confines an administrator to a named set of resources,
// and the server now enforces it: listings are filtered in the query and
// actions on anything else are refused. Correct, and silently baffling without
// this line. An administrator who opens the approval queue and finds it empty
// should learn that they are looking at their slice of it, not conclude that
// nobody is waiting.
//
// The flag comes from GET /auth/me and is server-computed. Nothing here is a
// permission check; the enforcement is in middleware and the query.
function ScopedDelegateNotice({ user }) {
  if (!user?.delegation_scoped) return null
  const n = user.delegation_scope_size || 0
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-warn-soft/40 px-3.5 py-2.5">
      <Scissors className="h-4 w-4 flex-none text-warn" strokeWidth={1.9} />
      <p className="text-sm leading-relaxed text-secondary">
        <span className="font-semibold text-primary">Your administrator access is scoped.</span> It
        covers {n} {n === 1 ? 'resource' : 'resources'}, so lists on these screens show only those and
        actions on anything else are refused. Ask root if you need more.
      </p>
    </div>
  )
}

export function AdminRoute() {
  const user = useAuthStore((s) => s.user)
  const isAdmin = useAuthStore((s) => s.isAdmin())
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated())

  if (isAuthenticated && !user) return <FullPageSpinner />
  if (isAdmin) {
    return (
      <>
        <ScopedDelegateNotice user={user} />
        <Outlet />
      </>
    )
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-16 text-center">
      <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-warn-soft text-warn">
        <ShieldOff className="h-6 w-6" strokeWidth={1.75} />
      </span>
      <h1 className="text-2xl font-semibold text-ink-50">Admin Center is not open to this account</h1>
      <p className="mt-2 text-base leading-relaxed text-ink-400">
        Identity, roles, policies, approvals and vault operations need the{' '}
        <strong className="font-medium text-ink-200">admin</strong> or{' '}
        <strong className="font-medium text-ink-200">root</strong> role. Your account holds{' '}
        {user?.roles?.length ? (
          <span className="font-medium text-ink-200">{user.roles.join(', ')}</span>
        ) : (
          'no administrative role'
        )}
        . Ask an administrator if you need it.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" to="/">
          Back to the dashboard
        </Button>
        <Button variant="secondary" to="/settings">
          Open your settings
        </Button>
      </div>
    </div>
  )
}
