import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ShieldAlert, ShieldCheck, LogOut, X } from 'lucide-react'
import clsx from 'clsx'
import { MfaEnrollment } from './MfaEnrollment'
import { Button } from '../common/Button'
import { formatDateTime, formatRelativeToNow } from '../../lib/format'
import { readMfaPolicyPosture, mfaRequirementSentence } from '../../lib/mfaPolicy'

// ---------------------------------------------------------------------------
// Role-gated MFA enforcement, what the person on the other end sees
// ---------------------------------------------------------------------------
// Two states, and the difference between them is the server's, not ours:
//
//   BLOCKED (mfa_enrollment_required on /auth/me)
//     The session is restricted, the API will refuse everything except
// enrolment, so the console shows an interrupt covering the app rather
// than letting the user click into screens that will all 403. This is the
// same shape as Entra's registration interrupt and Okta's enrollment
// redirect.
//
//   IN BREACH BUT ALLOWED (mfa_required, not enrolled, monitor mode or an
// open grace window)
//     A dismissible banner. Nagging beats blocking while an administrator is
// still rolling the policy out, which is the entire reason monitor mode
// exists on the server side.
//
// The console never decides which of these applies. It reads the decision the
// login endpoint already made; see lib/mfaPolicy.js for why re-deriving it
// here would be theatre.

function GraceLine({ deadline }) {
  if (!deadline) return null
  return (
    <>
      {' '}
      You have until <span className="font-semibold">{formatDateTime(deadline)}</span> (
      {formatRelativeToNow(deadline)}) before access is restricted.
    </>
  )
}

export function MfaEnforcementGate({ me, mfaStatus, onSignOut }) {
  const queryClient = useQueryClient()
  const posture = readMfaPolicyPosture(me)
  const [dismissed, setDismissed] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
  const [enrolled, setEnrolled] = useState(false)

  // /auth/me is re-read after enrolment so the posture this component renders
  // from is the server's new answer, not a stale copy of the old one.
  const onEnrolled = () => {
    setEnrolled(true)
    queryClient.invalidateQueries({ queryKey: ['me'] })
  }

  // Nothing to say: no policy in play, or the account already satisfies it.
  if (!posture.required || posture.enrolled) return null

  // ── Blocked: the interrupt ──
  if (posture.blocked) {
    return (
      <div className="fixed inset-0 z-[60] overflow-y-auto bg-surface-950/95 px-4 py-8 backdrop-blur-sm">
        <div className="mx-auto w-full max-w-2xl">
          <div className="mb-5 flex items-start gap-3.5">
            <span className="flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-amber-300/60 bg-amber-50 text-amber-600 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
              <ShieldAlert className="h-5 w-5" strokeWidth={1.8} />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold leading-tight text-ink-50">
                Set up multi-factor authentication to continue
              </h1>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-400">
                {mfaRequirementSentence(posture)} Until you enrol an authenticator, this session can do
                nothing else, every other page and API call is refused by the server.
              </p>
            </div>
          </div>

          <MfaEnrollment status={mfaStatus} onEnrolled={onEnrolled} />

          <div
            className={clsx(
              'mt-5 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3.5',
              enrolled
                ? 'border-emerald-300/70 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/30'
                : 'border-surface-700 bg-surface-900'
            )}
          >
            <ShieldCheck
              className={clsx(
                'h-4 w-4 flex-none',
                enrolled ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-500'
              )}
              strokeWidth={1.8}
            />
            <p
              className={clsx(
                'min-w-0 flex-1 text-xs leading-relaxed',
                enrolled ? 'text-emerald-800 dark:text-emerald-200' : 'text-ink-400'
              )}
            >
              {enrolled ? (
                <>
                  <span className="font-semibold">Authenticator registered.</span> Sign in again to finish,
                  this session was issued before you had a second factor, so it stays restricted until you do.
                </>
              ) : (
                <>
                  When enrolment finishes you will need to{' '}
                  <span className="font-semibold text-ink-200">sign in again</span>: this session was issued
                  before you had a second factor, and the next sign-in is the one that asks for a code.
                </>
              )}
            </p>
            <Button variant={enrolled ? 'primary' : 'secondary'} size="sm" icon={LogOut} onClick={onSignOut}>
              {enrolled ? 'Sign in again' : 'Sign out'}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ── In breach but allowed: the banner ──
  if (dismissed) return null

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 px-4 py-2.5 dark:border-amber-900/50 dark:bg-amber-950/30">
      <div className="mx-auto flex max-w-[100rem] flex-wrap items-center gap-x-3 gap-y-2">
        <ShieldAlert className="h-4 w-4 flex-none text-amber-600 dark:text-amber-400" strokeWidth={1.9} />
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
          <span className="font-semibold">Multi-factor authentication is required for your account.</span>{' '}
          {mfaRequirementSentence(posture)}
          <GraceLine deadline={posture.deadline} />
        </p>
        <Button
          size="xs"
          variant="secondary"
          icon={ShieldCheck}
          className="flex-none"
          onClick={() => setEnrolling((v) => !v)}
        >
          {enrolling ? 'Hide setup' : 'Set up now'}
        </Button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          title="Dismiss until the next page load"
          className={clsx(
            'flex h-6 w-6 flex-none items-center justify-center rounded-md transition-colors',
            'text-amber-700/70 hover:bg-amber-100 hover:text-amber-900',
            'dark:text-amber-300/70 dark:hover:bg-amber-900/40 dark:hover:text-amber-100'
          )}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      {enrolling && (
        <div className="mx-auto mt-3 max-w-[100rem] pb-2">
          <MfaEnrollment status={mfaStatus} onEnrolled={onEnrolled} />
        </div>
      )}
    </div>
  )
}
