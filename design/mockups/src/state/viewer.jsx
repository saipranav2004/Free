import { createContext, useContext, useMemo, useState } from 'react'
import { adminStats, viewers } from '../fixtures'

// ---------------------------------------------------------------------------
// Who is looking at the mockup.
// ---------------------------------------------------------------------------
// Mirrors exactly what the real app can know: `user.roles` off GET /auth/me.
// isAdmin === roles includes admin OR root (matches authStore.isAdmin and
// middleware.RequireAdmin). isRoot is a SERVICE-level distinction only — there
// is no root-only route group in the backend — so it gates two controls
// (delegate/revoke admin) and one label ("Approve (final)"), nothing more.

const ViewerCtx = createContext(null)

export function ViewerProvider({ children }) {
  const [role, setRole] = useState('admin')

  const value = useMemo(() => {
    const viewer = viewers[role]
    const roles = viewer.roles
    const isAdmin = roles.includes('admin') || roles.includes('root')
    const isRoot = roles.includes('root')
    return {
      role,
      setRole,
      viewer,
      roles,
      isAdmin,
      isRoot,
      // Only meaningful for an admin/root — GET /admin/stats is RequireAdmin.
      pendingCount: isAdmin ? adminStats.pending_approvals : 0,
    }
  }, [role])

  return <ViewerCtx.Provider value={value}>{children}</ViewerCtx.Provider>
}

export function useViewer() {
  const ctx = useContext(ViewerCtx)
  if (!ctx) throw new Error('useViewer must be used inside <ViewerProvider>')
  return ctx
}
