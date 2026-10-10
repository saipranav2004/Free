import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { backend } from '../backend'
import type { PublicData } from '../backend/types'

interface PublicDataState {
  data: PublicData | null
  error: string | null
  loading: boolean
  refresh(): Promise<void>
}

const Ctx = createContext<PublicDataState | null>(null)

/** Menu + café settings. Refreshed on focus, on reconnect, and every minute. */
export function PublicDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<PublicData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const inflight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current
    const p = (async () => {
      try {
        const d = await backend.getPublicData()
        setData(d)
        setError(null)
      } catch {
        setError(navigator.onLine ? 'We couldn’t load the menu.' : 'You’re offline. Check your connection.')
      } finally {
        setLoading(false)
        inflight.current = null
      }
    })()
    inflight.current = p
    return p
  }, [])

  useEffect(() => {
    void refresh()
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 60000)
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('online', onFocus)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('online', onFocus)
    }
  }, [refresh])

  const value = useMemo(() => ({ data, error, loading, refresh }), [data, error, loading, refresh])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePublicData() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePublicData must be used inside PublicDataProvider')
  return ctx
}
