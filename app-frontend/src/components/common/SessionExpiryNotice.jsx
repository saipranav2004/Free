import { useEffect, useState } from 'react'
import { AlarmClock, LogOut } from 'lucide-react'
import clsx from 'clsx'
import { useAuthStore } from '../../store/authStore'
import { formatDateTime } from '../../lib/format'
import { Button } from './Button'

// ---------------------------------------------------------------------------
// Session expiry notice
// ---------------------------------------------------------------------------
// A PAM access token lives one hour. Without this, the first thing that tells
// an administrator their session ended is a 401 on the button they just
// pressed, and in this product that button is often an approval: they read a
// justification, decided, clicked, and got an error with no way to tell
// whether the decision landed. Every console that holds a short session warns
// before it lapses rather than after.
//
// WHAT IT DELIBERATELY DOES NOT DO: offer to extend. There is no refresh
// endpoint on this backend, so a "stay signed in" button would either do
// nothing or silently fail, which is worse than no button. It says when the
// session ends and offers the one action that actually helps, signing out
// cleanly and back in, at a moment the reader chooses rather than mid-task.
//
// Two stages, because five minutes and thirty seconds are different problems:
//   WARN      inside 5 minutes, an amber strip, dismissible
//   IMMINENT  inside 60 seconds, red, not dismissible, counts down
const WARN_MS = 5 * 60_000
const IMMINENT_MS = 60_000

function remainingLabel(ms) {
  if (ms <= 0) return 'now'
  const s = Math.ceil(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

export function SessionExpiryNotice({ onSignOut }) {
  const expiresAt = useAuthStore((s) => s.expiresAt)
  // SILENCED WHEN THE SESSION CAN RENEW ITSELF. This strip was written when
  // the access token's expiry WAS the end of the session. It now renews
  // silently on the next request (lib/http.js), so warning "5 minutes left"
  // every twenty-five minutes would be both wrong and constant, and a warning
  // that is always wrong is how people learn to ignore the real one.
  //
  // It still fires for a session with no refresh token, which is any session
  // whose renewal has already failed.
  const canRenew = useAuthStore((s) => !!s.refreshToken)
  const [now, setNow] = useState(() => Date.now())
  const [dismissed, setDismissed] = useState(false)

  const expiry = expiresAt ? new Date(expiresAt).getTime() : null
  const valid = expiry && !Number.isNaN(expiry)
  const left = valid ? expiry - now : Infinity

  // Ticks only while it matters. Polling every second for a session that has
  // fifty minutes left is a wakeup a laptop does not need, so the interval
  // steps down as the deadline approaches.
  useEffect(() => {
    if (!valid) return undefined
    const ms = expiry - Date.now()
    if (ms > WARN_MS) {
      // Sleep until the warning threshold, then re-evaluate.
      const t = setTimeout(() => setNow(Date.now()), Math.max(1000, ms - WARN_MS))
      return () => clearTimeout(t)
    }
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
    // `now` is in the dependency list on purpose: each tick re-runs this and
    // re-picks the right cadence, which is what steps the timer down from a
    // single long sleep to a one second interval as the deadline arrives.
  }, [expiry, valid, now])

  // A new session resets the dismissal, otherwise signing back in inherits the
  // previous session's "I have seen this" and warns about nothing.
  useEffect(() => {
    setDismissed(false)
  }, [expiresAt])

  if (canRenew) return null
  if (!valid || left > WARN_MS) return null
  const imminent = left <= IMMINENT_MS
  if (dismissed && !imminent) return null

  return (
    <div
      role="status"
      aria-live={imminent ? 'assertive' : 'polite'}
      className={clsx(
        'mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3.5 py-2.5',
        imminent ? 'border-danger/40 bg-danger-soft' : 'border-warn/40 bg-warn-soft'
      )}
    >
      <AlarmClock
        className={clsx('h-4 w-4 flex-none', imminent ? 'text-danger' : 'text-warn')}
        strokeWidth={2}
      />
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-primary">
        <span className="font-semibold">
          {left <= 0
            ? 'This session has expired.'
            : `This session ends in ${remainingLabel(left)}.`}
        </span>{' '}
        <span className="text-secondary">
          {left <= 0
            ? 'Sign in again to continue.'
            : `Anything unsaved will be lost at ${formatDateTime(expiresAt)}. Finish what you are doing, then sign in again.`}
        </span>
      </p>
      <span className="flex flex-none items-center gap-2">
        <Button size="sm" variant="secondary" icon={LogOut} onClick={onSignOut}>
          Sign out
        </Button>
        {!imminent && (
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            Dismiss
          </Button>
        )}
      </span>
    </div>
  )
}
