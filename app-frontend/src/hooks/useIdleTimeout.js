import { useEffect, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// Inactivity timeout
// ---------------------------------------------------------------------------
// WHY THE CONSOLE ENFORCES THIS AND NOT THE SERVER.
//
// The session used to survive an unattended browser for the full refresh-token
// lifetime, seven days. Not because anything was misconfigured: the console
// polls /auth/me every 60 seconds and the notification count every 30, and
// every one of those requests renewed the session on its way past. From the
// server's side they are indistinguishable from somebody working. Nothing in
// the stack was measuring whether a person was there, so a privileged console
// left open on an unlocked workstation stayed usable indefinitely.
//
// Only the browser can answer that question, so the split is: the server owns
// the policy and publishes it on /auth/me as idle_timeout_min, and this hook
// enforces it against real input. The refresh-token lifetime stays underneath
// as the absolute cap.
//
// WHAT COUNTS AS BEING THERE. Pointer, keyboard, wheel, touch and bringing the
// tab back to the foreground. Deliberately NOT mousemove: a nudged desk or a
// mouse resting against a monitor stand keeps a session alive forever, which is
// the exact scenario this exists to end.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart']

// The last minute is shown as a countdown so the warning is actionable rather
// than a surprise mid-sentence.
const WARN_MS = 60_000
const TICK_MS = 1000

/**
 * Watches for real interaction and reports when a session has gone idle.
 *
 * @param {number} timeoutMin  minutes of inactivity before the session ends. 0
 *                             or undefined disables the check entirely, which
 *                             is what a deployment that has not set a policy
 *                             gets.
 * @param {() => void} onTimeout  called once, when the window runs out.
 * @returns {{ warning: boolean, secondsLeft: number, stayActive: () => void }}
 */
export function useIdleTimeout(timeoutMin, onTimeout) {
  const enabled = Number.isFinite(timeoutMin) && timeoutMin > 0
  const timeoutMs = enabled ? timeoutMin * 60_000 : 0

  const lastActive = useRef(Date.now())
  const firedRef = useRef(false)
  // Held in a ref so a caller passing an inline arrow does not restart the
  // listeners on every render.
  const onTimeoutRef = useRef(onTimeout)
  onTimeoutRef.current = onTimeout

  const [remaining, setRemaining] = useState(timeoutMs)

  useEffect(() => {
    if (!enabled) return undefined

    const mark = () => {
      // Once it has fired, further input must not resurrect the session: the
      // sign-out is already in flight and the person needs to authenticate.
      if (firedRef.current) return
      lastActive.current = Date.now()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') mark()
    }

    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, mark, { passive: true }))
    document.addEventListener('visibilitychange', onVisible)

    const id = setInterval(() => {
      const left = timeoutMs - (Date.now() - lastActive.current)
      setRemaining(left)
      if (left <= 0 && !firedRef.current) {
        firedRef.current = true
        onTimeoutRef.current?.()
      }
    }, TICK_MS)

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, mark))
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(id)
    }
  }, [enabled, timeoutMs])

  return {
    warning: enabled && remaining <= WARN_MS && remaining > 0,
    secondsLeft: Math.max(0, Math.ceil(remaining / 1000)),
    stayActive: () => {
      if (firedRef.current) return
      lastActive.current = Date.now()
      setRemaining(timeoutMs)
    },
  }
}
