import { useCallback, useEffect, useRef, useState } from 'react'
import { backend } from '../backend'
import type { LiveStatus } from '../backend/types'
import { toAppError } from '../lib/errors'
import type { CustomerOrder } from '../lib/types'

const FINAL = new Set(['completed', 'cancelled'])

/**
 * Loads one order with its device secret and keeps it fresh:
 * realtime nudges when connected, polling as a safety net, and an immediate
 * refetch when the tab becomes visible or the network comes back.
 */
export function useOrderTracking(id: string, token: string | null) {
  const [order, setOrder] = useState<CustomerOrder | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveStatus>('connecting')
  const [lastSync, setLastSync] = useState<number | null>(null)
  const inflight = useRef(false)
  const queued = useRef(false)

  const refetch = useCallback(async () => {
    if (!token) return
    if (inflight.current) {
      queued.current = true
      return
    }
    inflight.current = true
    try {
      const o = await backend.getOrder(id, token)
      // Ignore stale responses that arrive out of order.
      setOrder((prev) => (prev && prev.updated_at > o.updated_at ? prev : o))
      setError(null)
      setLastSync(Date.now())
    } catch (err) {
      const e = toAppError(err)
      setError(e.code)
    } finally {
      inflight.current = false
      if (queued.current) {
        queued.current = false
        void refetch()
      }
    }
  }, [id, token])

  useEffect(() => {
    void refetch()
  }, [refetch])

  const trackKey = order?.track_key
  const isFinal = order ? FINAL.has(order.status) && (order.status === 'cancelled' || order.payment_status === 'paid') : false

  useEffect(() => {
    if (!trackKey || isFinal) return
    return backend.watchOrder(trackKey, () => void refetch(), setLive)
  }, [trackKey, isFinal, refetch])

  useEffect(() => {
    if (!token || isFinal) return
    const interval = live === 'live' ? 30000 : 8000
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refetch()
    }, interval)
    const onWake = () => {
      if (document.visibilityState === 'visible') void refetch()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', onWake)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('online', onWake)
    }
  }, [token, live, isFinal, refetch])

  return { order, setOrder, error, live, lastSync, refetch }
}
