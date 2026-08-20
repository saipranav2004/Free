import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'

// Gate for every authenticated route.
//
// It preserves the attempted location in router state so an INTERRUPTED
// navigation resumes after sign-in: a deep link like /jit/requests/abc123
// opened in a new tab, or a token that expired mid-session, should land the
// user back where they meant to be rather than on the dashboard.
//
// It deliberately does NOT do that after a deliberate sign-out. Clearing the
// session re-renders this component while the user is still "on" whatever
// page they clicked Sign out from, so without the guard below that page got
// captured as `state.from` and the next sign-in dropped them straight back
// onto it, signing out of /admin/policies and back in reopened
// /admin/policies instead of the dashboard. Choosing to leave is not an
// interrupted navigation, so there is nothing to resume: `signedOut` (set by
// authStore.logout, cleared by setSession) suppresses the hand-off and the
// user starts where a fresh session should start.
export function ProtectedRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated())
  const signedOut = useAuthStore((s) => s.signedOut)
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={signedOut ? undefined : { from: location }} />
  }
  return <Outlet />
}
