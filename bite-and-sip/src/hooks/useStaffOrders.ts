import { useCallback, useEffect, useRef, useState } from 'react'
import { backend } from '../backend'
import type { LiveStatus } from '../backend/types'
import { cafeDayStartIso } from '../lib/format'
import type { StaffOrder } from '../lib/types'

/**
 * Today's orders plus anything still open, kept fresh by realtime nudges,
 * with polling as a fallback whenever the realtime channel is down.
 * Every change triggers a refetch, so the board always shows database truth
 * and duplicate or out-of-order events can't corrupt it.
 */
export function useStaffOrders(onNewOrders?: (orders: StaffOrder[]) => void) {
  const [orders, setOrders] = useState<StaffOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveStatus>('connecting')
  const [lastSync, setLastSync] = useState<number | null>(null)
  const seen = useRef<Set<string> | null>(null)
  const inflight = useRef(false)
  const queued = useRef(false)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onNewRef = useRef(onNewOrders)
  useEffect(() => {
    onNewRef.current = onNewOrders
  }, [onNewOrders])

  const refetch = useCallback(async () => {
    if (inflight.current) {
      queued.current = true
      return
    }
    inflight.current = true
    try {
      const list = await backend.listOrdersSince(cafeDayStartIso())
      if (seen.current) {
        const fresh = list.filter((o) => !seen.current!.has(o.id) && o.status === 'placed')
        if (fresh.length) onNewRef.current?.(fresh)
      }
      seen.current = new Set(list.map((o) => o.id))
      setOrders(list)
      setError(null)
      setLastSync(Date.now())
    } catch {
      setError(navigator.onLine ? 'Couldn’t refresh orders.' : 'You’re offline. Orders will refresh when you reconnect.')
    } finally {
      inflight.current = false
      if (queued.current) {
        queued.current = false
        void refetch()
      }
    }
  }, [])

  const nudge = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void refetch(), 250)
  }, [refetch])

  useEffect(() => {
    void refetch()
    const stop = backend.watchOrders(nudge, (s) => {
      setLive(s)
      // Catch up on anything missed while disconnected.
      if (s === 'live') nudge()
    })
    return () => {
      stop()
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [refetch, nudge])

  useEffect(() => {
    const interval = live === 'live' ? 60000 : 10000
    const timer = setInterval(() => void refetch(), interval)
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
  }, [live, refetch])

  /** Apply a confirmed server row immediately (the realtime echo will refetch anyway). */
  const applyRow = useCallback((row: StaffOrder) => {
    setOrders((prev) => (prev ? prev.map((o) => (o.id === row.id ? row : o)) : prev))
  }, [])

  return { orders, error, live, lastSync, refetch, applyRow }
}

/** Short beep using Web Audio (no audio files needed). Must be unlocked by a user gesture. */
export class Chime {
  private ctx: AudioContext | null = null
  async unlock() {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return false
    this.ctx ??= new Ctor()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    return this.ctx.state === 'running'
  }
  get ready() {
    return this.ctx?.state === 'running'
  }
  play() {
    const ctx = this.ctx
    if (!ctx || ctx.state !== 'running') return
    const t = ctx.currentTime
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = freq
      osc.type = 'sine'
      gain.gain.setValueAtTime(0.0001, t + i * 0.18)
      gain.gain.exponentialRampToValueAtTime(0.35, t + i * 0.18 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t + i * 0.18)
      osc.stop(t + i * 0.18 + 0.18)
    }
  }
}
