import { Routes, Route } from 'react-router-dom'
import SafesListPage from './SafesListPage'
import SafeDetailPage from './SafeDetailPage'
import CredentialDetailPage from './CredentialDetailPage'
import NotFoundPage from '../NotFoundPage'

// Mounted at /vault/* by App.jsx. A nested <Routes> here (rather than
// flattening these into App.jsx's top-level route tree) keeps the vault's
// own multi-level navigation (safes -> folders/credentials -> credential
// detail) self-contained and lets it evolve without touching the app shell.
export default function VaultPage() {
  return (
    <Routes>
      <Route index element={<SafesListPage />} />
      <Route path=":safeId" element={<SafeDetailPage />} />
      <Route path=":safeId/credentials/:credentialId" element={<CredentialDetailPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
