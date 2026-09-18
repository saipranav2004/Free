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
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'))
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
const IdentityGraphPage = lazy(() => import('./pages/admin/IdentityGraphPage'))
const MfaPolicyPage = lazy(() => import('./pages/admin/MfaPolicyPage'))
const PoliciesPage = lazy(() => import('./pages/admin/PoliciesPage'))
const AdminJitPage = lazy(() => import('./pages/admin/AdminJitPage'))
const AdminAuditPage = lazy(() => import('./pages/admin/AdminAuditPage'))
const AdminVaultOpsPage = lazy(() => import('./pages/admin/AdminVaultOpsPage'))
const ServiceIdentitiesPage = lazy(() => import('./pages/admin/ServiceIdentitiesPage'))
const ServiceIdentityDetailPage = lazy(() => import('./pages/admin/ServiceIdentityDetailPage'))

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
            {/* The parent path is a real destination, not a dead end.
                /jit/requests carries no id and matches nothing, so anything
                that reaches it, a stale bookmark, a hand-typed URL, a row
                whose id never arrived, used to land on the 404 page. It means
                "the requests list", so send it there. */}
            <Route path="jit/requests" element={<Navigate to="/jit" replace />} />
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
            {/* THERE IS NO "MY ACTIVITY" PAGE. It was a self-scoped copy of
                Admin Center, Audit and Compliance, and it answered a question
                the dashboard's own activity band already answers for the
                account looking at it. Two screens over one trail is one screen
                too many, and the org-wide view remains where it belongs, behind
                RequireAdmin.

                Both paths are left as redirects rather than deleted outright,
                so a bookmark or an old link lands on the dashboard instead of
                a 404. The server side is untouched: /pam/audit is still there,
                still scoped to the caller. */}
            <Route path="activity" element={<Navigate to="/" replace />} />
            <Route path="audit" element={<Navigate to="/" replace />} />
            {/* The archive half of the notification centre. The bell is the
                "what is new right now" view; this is "what happened, and what
                did I miss", which needs filters, history and room to read. */}
            <Route
              path="notifications"
              element={
                <SuspenseRoute>
                  <NotificationsPage />
                </SuspenseRoute>
              }
            />
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
                path="identity-graph"
                element={
                  <SuspenseRoute>
                    <IdentityGraphPage />
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
              {/* Machine identities. Inside the admin element, so the same
                  guard that refuses a standard user the rest of the Admin
                  Center refuses these too, rather than each page inventing
                  its own check. */}
              <Route
                path="services"
                element={
                  <SuspenseRoute>
                    <ServiceIdentitiesPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="services/:id"
                element={
                  <SuspenseRoute>
                    <ServiceIdentityDetailPage />
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
