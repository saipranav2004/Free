import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { registerSessionExpiredHandler } from './lib/http'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { AdminRoute } from './components/auth/AdminRoute'
import { useAuthStore } from './store/authStore'
import { AppLayout } from './components/common/AppLayout'
import { FullPageSpinner } from './components/common/Spinner'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import LoginPage from './pages/auth/LoginPage'
import MfaVerifyPage from './pages/auth/MfaVerifyPage'

// Route-level code splitting: each feature area is its own chunk, loaded
// only when the user actually navigates there. The Vault/Audit/Admin areas
// in particular pull in enough components that bundling them into the main
// chunk would bloat the very first load (login screen) for every user, most
// of whom won't touch half these areas in a given session.
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const ResourcesPage = lazy(() => import('./pages/resources/ResourcesPage'))
const ResourceDetailPage = lazy(() => import('./pages/resources/ResourceDetailPage'))
const VaultPage = lazy(() => import('./pages/vault/VaultPage'))
const SessionsPage = lazy(() => import('./pages/sessions/SessionsPage'))
const JitPage = lazy(() => import('./pages/jit/JitPage'))
const JitRequestDetailPage = lazy(() => import('./pages/jit/JitRequestDetailPage'))
const AuditPage = lazy(() => import('./pages/audit/AuditPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'))

// Admin Center, its own route subtree, wrapped in <AdminRoute> below so a
// non-admin never even downloads these chunks. All admin/* nav entries in
// config/nav.js point here.
//
// AdminOverviewPage IS GONE. It was a strict subset of the Dashboard, the
// same stats, a smaller queue, the same chain check, so administrators had
// two landing pages, each telling half the story. Everything it did that the
// Dashboard didn't (inline approve/deny on the pending queue, the denied
// feed, chain verification) is now on the Dashboard, and /admin redirects to
// Identity: the first screen an administrator actually needs a subtree for.
const IdentityListPage = lazy(() => import('./pages/admin/IdentityListPage'))
const IdentityDetailPage = lazy(() => import('./pages/admin/IdentityDetailPage'))
const RolesPage = lazy(() => import('./pages/admin/RolesPage'))
const RoleDetailPage = lazy(() => import('./pages/admin/RoleDetailPage'))
const MfaPolicyPage = lazy(() => import('./pages/admin/MfaPolicyPage'))
const PoliciesPage = lazy(() => import('./pages/admin/PoliciesPage'))
const AdminJitPage = lazy(() => import('./pages/admin/AdminJitPage'))
const AdminAuditPage = lazy(() => import('./pages/admin/AdminAuditPage'))
const AdminVaultOpsPage = lazy(() => import('./pages/admin/AdminVaultOpsPage'))

// Bridges the plain-JS http.js module (which can't call hooks) to the
// router: on a 401 that ends a previously-valid session, navigate to
// /login and show exactly one toast, no matter how many concurrent
// requests triggered it (the dedup guard itself lives in lib/http.js).
function SessionExpiredBridge() {
  const navigate = useNavigate()
  useEffect(() => {
    registerSessionExpiredHandler(() => {
      toast.error('Your session has expired. Please log in again.')
      navigate('/login', { replace: true })
    })
  }, [navigate])
  return null
}

function SuspenseRoute({ children }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<FullPageSpinner />}>{children}</Suspense>
    </ErrorBoundary>
  )
}

// Self-service-only route. An administrator has no use for /jit, they don't
// raise requests against themselves, they decide other people's, which is
// Admin Center → JIT Approvals. The sidebar no longer offers the entry (see
// config/nav.js), and this makes the URL itself agree: an admin who follows an
// old link, bookmark or notification lands on the approvals queue instead of a
// screen built for a requester. `replace` keeps the redirect out of history.
function SelfServiceOnly({ to, children }) {
  const isAdmin = useAuthStore((s) => s.isAdmin())
  return isAdmin ? <Navigate to={to} replace /> : children
}

// The mirror of SelfServiceOnly, for a route that belongs to operators. Used
// by "My activity": audit is an administrative surface in every product of
// this class, and a standard user's own trail is already on their dashboard.
// Redirects rather than denying, because a bookmark to a page that is simply
// not part of your console should land you somewhere useful, not on a wall.
function OperatorOnly({ to = '/', children }) {
  const isAdmin = useAuthStore((s) => s.isAdmin())
  return isAdmin ? children : <Navigate to={to} replace />
}

export default function App() {
  return (
    <>
      <SessionExpiredBridge />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/mfa-verify" element={<MfaVerifyPage />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route
              index
              element={
                <SuspenseRoute>
                  <DashboardPage />
                </SuspenseRoute>
              }
            />
            <Route
              path="resources"
              element={
                <SuspenseRoute>
                  <ResourcesPage />
                </SuspenseRoute>
              }
            />
            <Route
              path="resources/:id"
              element={
                <SuspenseRoute>
                  <ResourceDetailPage />
                </SuspenseRoute>
              }
            />
            <Route
              path="vault/*"
              element={
                <SuspenseRoute>
                  <VaultPage />
                </SuspenseRoute>
              }
            />
            <Route
              path="sessions"
              element={
                <SuspenseRoute>
                  <SessionsPage />
                </SuspenseRoute>
              }
            />
            <Route
              path="jit"
              element={
                <SelfServiceOnly to="/admin/jit">
                  <SuspenseRoute>
                    <JitPage />
                  </SuspenseRoute>
                </SelfServiceOnly>
              }
            />
            <Route
              path="jit/requests/:id"
              element={
                <SelfServiceOnly to="/admin/jit">
                  <SuspenseRoute>
                    <JitRequestDetailPage />
                  </SuspenseRoute>
                </SelfServiceOnly>
              }
            />
            {/* "My activity" is the operator's own self-scoped trail, the
                counterpart to the org-wide Admin Center, Audit and Compliance.
                Standard users do not get it: their activity already has a
                panel on the dashboard. /audit was the original path and stays
                as a redirect so old links and bookmarks land. */}
            <Route
              path="activity"
              element={
                <OperatorOnly>
                  <SuspenseRoute>
                    <AuditPage />
                  </SuspenseRoute>
                </OperatorOnly>
              }
            />
            <Route path="audit" element={<Navigate to="/activity" replace />} />
            <Route
              path="settings"
              element={
                <SuspenseRoute>
                  <SettingsPage />
                </SuspenseRoute>
              }
            />

            {/* Admin Center, client-side gate only; every request these pages
 make is independently enforced server-side by
 middleware.RequireAdmin, so this just prevents the shell from
 flashing on screen for a non-admin before their first request 403s. */}
            <Route path="admin" element={<AdminRoute />}>
              {/* Overview removed, /admin is not a page of its own any more.
                  `replace` so the redirect never lands in history and Back
 doesn't bounce the user through it. */}
              <Route index element={<Navigate to="/admin/identity" replace />} />
              <Route
                path="identity"
                element={
                  <SuspenseRoute>
                    <IdentityListPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="identity/:id"
                element={
                  <SuspenseRoute>
                    <IdentityDetailPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="roles"
                element={
                  <SuspenseRoute>
                    <RolesPage />
                  </SuspenseRoute>
                }
              />
              {/* Full role detail, including the criticality breakdown, lives
                  on its own page rather than in a panel over the list: a
                  details page is where full resource detail belongs, and it
                  gives the classification a URL that can go in a ticket. */}
              <Route
                path="roles/:id"
                element={
                  <SuspenseRoute>
                    <RoleDetailPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="mfa-policy"
                element={
                  <SuspenseRoute>
                    <MfaPolicyPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="policies"
                element={
                  <SuspenseRoute>
                    <PoliciesPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="jit"
                element={
                  <SuspenseRoute>
                    <AdminJitPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="audit"
                element={
                  <SuspenseRoute>
                    <AdminAuditPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="vault-ops"
                element={
                  <SuspenseRoute>
                    <AdminVaultOpsPage />
                  </SuspenseRoute>
                }
              />
            </Route>

            <Route
              path="*"
              element={
                <SuspenseRoute>
                  <NotFoundPage />
                </SuspenseRoute>
              }
            />
          </Route>
        </Route>
      </Routes>
    </>
  )
}
