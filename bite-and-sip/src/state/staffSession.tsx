import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { backend } from '../backend'
import type { StaffProfile } from '../lib/types'

interface SessionState {
  profile: StaffProfile | null
  loading: boolean
  signIn(email: string, password: string): Promise<StaffProfile>
  signOut(): Promise<void>
  refresh(): Promise<void>
}

const Ctx = createContext<SessionState | null>(null)

export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<StaffProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setProfile(await backend.getStaffSession())
    } catch {
      setProfile(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    return backend.onAuthChange(() => void refresh())
  }, [refresh])

  const signIn = useCallback(async (email: string, password: string) => {
    const p = await backend.signIn(email, password)
    setProfile(p)
    return p
  }, [])

  const signOut = useCallback(async () => {
    await backend.signOut()
    setProfile(null)
  }, [])

  const value = useMemo(() => ({ profile, loading, signIn, signOut, refresh }), [profile, loading, signIn, signOut, refresh])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStaffSession() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useStaffSession must be used inside StaffSessionProvider')
  return ctx
}
