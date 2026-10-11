import { useEffect, useState } from 'react'

// Ticks once a second while `targetIso` is in the future. Used for grant
// expiry countdowns, the break-glass cooling-off timer, and the credential
// reveal window.
//
// The returned value is always computed FRESH from `targetIso` and the
// current clock on every call, it is never read back out of state that an
// effect updates asynchronously. That distinction matters: an earlier
// version stored the countdown in useState and relied on a useEffect
// (keyed on `targetIso`) to recompute it when the target changed. Effects
// run strictly after render, so on the exact render where a caller flips
// `targetIso` from undefined to a real timestamp (e.g. RevealCredentialModal
// going from "no result yet" to "just revealed"), this hook's return value
// for THAT render was still the stale pre-effect number, 0, since the
// initial mount had no target. Any sibling effect in the same component
// that reads this hook's return value in the same commit (e.g. "if result
// is set and remainingMs <= 0, treat it as expired") would see that stale 0
// and immediately treat a just-revealed, 60-minutes-from-expiry credential
// as already expired. Computing inline eliminates the staleness entirely ,
// there is no cached value to be behind.
//
// Bugs this still specifically guards against:
// - Leaked interval: the useEffect's cleanup return clears the interval on
// unmount or when `targetIso` changes, so remounting/re-targeting never
// stacks a second interval on top of the first.
// - Runs forever after expiry: once remaining <= 0 the interval clears
// itself instead of ticking a dummy re-render forever.
export function useCountdown(targetIso) {
  // This state's VALUE is never read, it exists purely to force a re-render
  // once a second so the inline computeRemaining() below picks up the
  // passage of time. The actual countdown number always comes from that
  // fresh computation, never from here.
  const [, tick] = useState(0)

  useEffect(() => {
    if (!targetIso) return undefined
    if (computeRemaining(targetIso) <= 0) return undefined

    const interval = setInterval(() => {
      tick((t) => t + 1)
      if (computeRemaining(targetIso) <= 0) clearInterval(interval)
    }, 1000)

    return () => clearInterval(interval)
  }, [targetIso])

  return computeRemaining(targetIso)
}

function computeRemaining(targetIso) {
  if (!targetIso) return 0
  const target = new Date(targetIso).getTime()
  if (Number.isNaN(target)) return 0
  return target - Date.now()
}
