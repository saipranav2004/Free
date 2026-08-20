import { useEffect, useState } from 'react'
import { Route, Routes } from 'react-router-dom'
import { AppShell } from './shell/AppShell'
import { ViewerProvider } from './state/viewer'
import { DensityProvider } from './ui/table'
import { ToastHost } from './ui/overlay'
import Dashboard from './screens/Dashboard'
import { ResourcesList, ResourceDetail } from './screens/Resources'
import { SafesList, SafeDetail, CredentialDetail } from './screens/Vault'
import Sessions from './screens/Sessions'
import { JitPage, JitRequestDetail } from './screens/Jit'
import AdminApprovals from './screens/AdminApprovals'
import { IdentityList, IdentityDetail } from './screens/Identity'
import { RolesPage, PoliciesPage } from './screens/Rbac'
import MfaPolicyPage from './screens/MfaPolicy'
import { MyActivity, AdminAudit, Compliance } from './screens/Audit'
import { Settings, VaultOps, NotFound, DeniedDemo } from './screens/Misc'
import { Login, MfaVerify } from './screens/Auth'

// Route map mirrors the audited one, with three deliberate changes documented
// in design/05-redesigns.md:
//   • /audit          → /activity   (self-scoped; fixes the orphan route)
//   • /admin/audit    keeps events + recordings
//   • /admin/compliance is NEW as a route, but is only the chain-verify and
//     report-generation surfaces lifted out of /admin/audit — no new endpoint.
// Density is a real, persisted user preference — not a line in a spec doc.
// It sits at the app root because a power user sets it once and expects every
// list in the product to obey it.
function useDensityPref() {
  const [density, setDensity] = useState(() => {
    try {
      return localStorage.getItem('pam_density') === 'compact' ? 'compact' : 'comfortable'
    } catch {
      return 'comfortable'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('pam_density', density)
    } catch {
      /* private browsing — the preference just doesn't persist */
    }
  }, [density])
  return { density, setDensity }
}

export default function App() {
  const density = useDensityPref()
  return (
    <ViewerProvider>
      <DensityProvider value={density}>
      <ToastHost>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/mfa-verify" element={<MfaVerify />} />

        <Route element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="resources" element={<ResourcesList />} />
          <Route path="resources/:id" element={<ResourceDetail />} />
          <Route path="vault" element={<SafesList />} />
          <Route path="vault/:safeId" element={<SafeDetail />} />
          <Route path="vault/:safeId/credentials/:credentialId" element={<CredentialDetail />} />
          <Route path="sessions" element={<Sessions />} />
          <Route path="jit" element={<JitPage />} />
          <Route path="jit/requests/:id" element={<JitRequestDetail />} />
          <Route path="activity" element={<MyActivity />} />
          <Route path="settings" element={<Settings />} />

          <Route path="admin/jit" element={<AdminApprovals />} />
          <Route path="admin/identity" element={<IdentityList />} />
          <Route path="admin/identity/:id" element={<IdentityDetail />} />
          <Route path="admin/roles" element={<RolesPage />} />
          <Route path="admin/policies" element={<PoliciesPage />} />
          <Route path="admin/mfa-policy" element={<MfaPolicyPage />} />
          <Route path="admin/audit" element={<AdminAudit />} />
          <Route path="admin/compliance" element={<Compliance />} />
          <Route path="admin/vault-ops" element={<VaultOps />} />

          <Route path="denied" element={<DeniedDemo />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      </ToastHost>
      </DensityProvider>
    </ViewerProvider>
  )
}
