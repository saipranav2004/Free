import { AlarmClock } from 'lucide-react'
import { Button } from './Button'

/**
 * The last minute before an idle session ends.
 *
 * Says what is about to happen, why, and offers the one action that stops it.
 * Distinct from SessionExpiryNotice, which is about a token reaching the end of
 * its life: this one is about nobody being at the keyboard, and unlike token
 * expiry it CAN be cancelled, so it has a button that does something real.
 */
export function IdleTimeoutNotice({ secondsLeft, onStay }) {
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-50/70 px-4 py-3 dark:bg-red-950/20"
    >
      <AlarmClock className="h-4 w-4 flex-none text-red-600 dark:text-red-400" strokeWidth={1.9} />
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-red-800 dark:text-red-300/90">
        <span className="font-semibold">Signing you out in {secondsLeft}s.</span> This console has
        been idle, and privileged sessions are not left open unattended.
      </p>
      <Button variant="secondary" size="sm" onClick={onStay}>
        I am still here
      </Button>
    </div>
  )
}
