import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ShieldCheck,
  ShieldOff,
  AlertTriangle,
  RefreshCw,
  KeyRound,
  Clock,
  Info,
  HelpCircle,
} from 'lucide-react'
import { mfaSetupInitiate, mfaSetupVerify, regenerateBackupCodes } from '../../api/auth'
import { apiErrorMessage } from '../../lib/apiError'
import { formatEnabledAt } from '../../lib/mfaStatus'
import { recordMfaEnrolled, recordMfaSetupRestarted } from '../../lib/mfaEvidence'
import { useAuthStore } from '../../store/authStore'
import { CopyButton } from '../common/CopyButton'
import { Card, CardHeader, CardTitle, CardFooter, DetailList } from '../common/Layout'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { OtpInput, isCompleteOtp } from '../common/OtpInput'

// ---------------------------------------------------------------------------
// Multi-factor authentication
// ---------------------------------------------------------------------------
// THE BACKEND FACT THAT DRIVES THIS ENTIRE FILE, found by reading
// auth_service.go's SetupMFAInitiate:
//
//     // Delete any existing PENDING device, then create a new one.
// s.db.Unscoped().Where("user_id = ?", userID).Delete(&models.PAMMFA{})
//
// The comment says PENDING. The query has NO STATUS FILTER. So calling
// POST /auth/mfa/setup/initiate hard-deletes whatever MFA device the account
// has, ACTIVE included, and replaces it with a fresh PENDING row. Login
// only issues a challenge when `mfa.Status == "ACTIVE"`, so the moment that
// endpoint returns, THE ACCOUNT HAS NO SECOND FACTOR, whether or not the user
// ever confirms a code.
//
// Two consequences the old UI got wrong:
//
//   1. "Manage MFA, replace authenticator" was a plain secondary button with
// no warning. Clicking it and then closing the dialog silently removed
// the user's second factor while the console kept showing "MFA enabled".
//      That is the status bug as actually experienced. It now warns first, in
// the words of what really happens.
//
//   2. "Disable MFA" was rendered permanently disabled with "not
// self-service", because there is no DELETE endpoint. But there IS a
// supported path, the deletion above, and it is exactly what disabling
// means: the active device is destroyed and the account stops being
// challenged. So the button now WORKS, behind a typed-confirmation
// dialog that states plainly what it does.
//
// Both paths record evidence (lib/mfaEvidence) so every MFA surface in the
// console tells the truth on the next render, without waiting for a
// sign-out, /auth/me still reports no enrolment field at all.
//
// STATUS DETECTION IS UNCHANGED AND STILL CORRECT: `mfa_verified` is NOT
// enrolment. auth_service.go issues tokens with the same verified flag for an
// account that has no MFA at all (`// No MFA → issue tokens directly` →
// `issueTokensForUser(user, true, clientIP)`), so treating it as enrolment
// would tell an operator they are protected when they are not. See
// lib/mfaStatus.js.
//
// The six-digit field is OtpInput, which clamps to exactly six digits, drops
// non-digits, and is the single source of `isCompleteOtp`, the same
// condition that gates the submit button. Nothing here can submit a code of
// any other length.

export function MfaEnrollment({ status, onEnrolled, onDisabled }) {
  const setSession = useAuthStore((s) => s.setSession)
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const identity = user?.username || user?.email
  const enabled = status?.enabled === true
  const unknown = status?.unknown === true

  const [step, setStep] = useState('idle') // idle | qr | backup-codes
  const [setupData, setSetupData] = useState(null)
  const [code, setCode] = useState('')
  const [backupCodes, setBackupCodes] = useState(null)
  const [error, setError] = useState(null)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)
  const [disableConfirm, setDisableConfirm] = useState('')

  // /auth/me resolves after first paint. If an in-flight enrolment is not in
  // progress, always follow the server's answer.
  useEffect(() => {
    if (step === 'qr' || step === 'backup-codes') return
    setStep('idle')
  }, [enabled, step])

  // One mutation, three call sites (first enrolment, replace, disable) ,
  // because on this backend they are all literally the same request. What
  // differs is what we do afterwards, so the caller passes that in.
  const initiate = useMutation({
    mutationFn: mfaSetupInitiate,
    onError: (err) => setError(apiErrorMessage(err)),
  })

  const startEnrolment = ({ wasEnabled }) => {
    setError(null)
    initiate.mutate(undefined, {
      onSuccess: (data) => {
        // If a device existed, the server has just destroyed it. Record that
        // before anything else so a user who abandons this screen is not
        // shown a false "protected" state.
        if (wasEnabled) {
          recordMfaSetupRestarted(identity)
          queryClient.invalidateQueries({ queryKey: ['me'] })
        }
        setSetupData(data)
        setCode('')
        setStep('qr')
      },
    })
  }

  const verify = useMutation({
    mutationFn: (c) => mfaSetupVerify(setupData.mfa_device_id, c),
    onSuccess: (data) => {
      setBackupCodes(data.backup_codes || [])
      setStep('backup-codes')
      setError(null)
      recordMfaEnrolled(identity)

      // ADOPT THE REPLACEMENT SESSION, if enrolment issued one.
      //
      // Under an enforce rule the token in this tab was minted before the
      // account had a factor and carries mfa_enrolment_required, so the server
      // refuses everything with it except these endpoints. Enrolling does not
      // change that token. The endpoint now returns a fresh, unrestricted one
      // and swapping it here is what lets the person carry on from where the
      // interrupt caught them rather than being sent back to the sign-in
      // screen for doing exactly what was asked.
      //
      // Guarded: the field is absent on the ordinary Settings path and when a
      // reissue failed, and in both cases the existing session is the right
      // one to keep.
      if (data?.access_token) {
        //
        // NO `user` KEY, deliberately. This is a token swap inside a session
        // that already knows who is signed in, so passing null here (which is
        // what it used to do) threw the profile away and left the navbar, the
        // profile menu and the MFA chip showing "-" and "Checking MFA" until
        // the page was reloaded by hand. See setSession in store/authStore.js:
        // omitting the key keeps the account exactly as it was.
        setSession({
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: data.expires_at,
          identifier: identity,
          viaMfaChallenge: true,
        })
      }
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (err) => {
      setError(apiErrorMessage(err))
      setCode('')
    },
  })

  // Backup codes are single use, spending one really does remove it now ,
  // so an account that used its last code needs a way to top up WITHOUT
  // re-enrolling the authenticator. Voids the previous set server-side.
  const regenerate = useMutation({
    mutationFn: regenerateBackupCodes,
    onSuccess: (data) => {
      setBackupCodes(data?.backup_codes || [])
      setStep('backup-codes')
      setError(null)
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (err) => setError(apiErrorMessage(err)),
  })

  // Disabling is the initiate call with no follow-up verify: the ACTIVE
  // device is gone, the replacement row stays PENDING forever, and login
  // stops challenging. That is a real disable, performed by the backend.
  const disable = useMutation({
    mutationFn: mfaSetupInitiate,
    onSuccess: () => {
      recordMfaSetupRestarted(identity)
      setDisableOpen(false)
      setDisableConfirm('')
      setStep('idle')
      setSetupData(null)
      queryClient.invalidateQueries({ queryKey: ['me'] })
      onDisabled?.()
    },
    onError: (err) => {
      setError(apiErrorMessage(err))
      setDisableOpen(false)
    },
  })

  const submitCode = (c) => {
    if (!isCompleteOtp(c) || verify.isPending) return
    verify.mutate(c)
  }

  // --- enrolment in progress ------------------------------------------------
  if (step === 'qr') {
    return (
      <Card>
        <CardHeader>
          <CardTitle icon={ShieldCheck}>
            {enabled ? 'Replace authenticator' : 'Set up your authenticator'}
          </CardTitle>
          <span className="ml-auto flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-2xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
            Unprotected until confirmed
          </span>
        </CardHeader>
        <div className="px-4 py-4">
          {/* Stated in the imperative because it is true right now, not a
 hypothetical: the old device is already gone. */}
          <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-50/60 px-3.5 py-3 dark:bg-amber-950/15">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400"
              strokeWidth={1.9}
            />
            <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300/90">
              This account currently has <strong className="font-semibold">no second factor</strong>.
              Confirming a code below activates the new authenticator. If you leave now, sign-in will not ask
              for a code until you come back and finish.
            </p>
          </div>

          <p className="text-sm leading-relaxed text-ink-400">
            Scan this code with Google Authenticator, 1Password, Microsoft Authenticator or any TOTP app.
          </p>
          <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
            {setupData?.qr_code_base64 && (
              <img
                // SetupMFAInitiate returns a full `data:image/png;base64,…`
                // URI already, prepending the prefix again produced an
                // invalid data URI that silently failed to render.
                src={setupData.qr_code_base64}
                alt="MFA enrollment QR code"
                className="h-40 w-40 flex-none rounded-xl border border-surface-700 bg-white p-2"
              />
            )}
            <div className="w-full min-w-0 space-y-2">
              <p className="text-xs font-medium text-ink-300">Or enter this key manually</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-surface-700 bg-surface-800 px-2.5 py-2 font-mono text-xs text-ink-200">
                  {setupData?.secret}
                </code>
                <CopyButton value={setupData?.secret || ''} />
              </div>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              submitCode(code)
            }}
            className="mt-5 border-t border-surface-800 pt-5"
          >
            <p className="mb-2 text-xs font-medium text-ink-300">Enter the 6-digit code from your app</p>
            <div className="max-w-[22rem]">
              <OtpInput
                value={code}
                onChange={setCode}
                onComplete={submitCode}
                invalid={!!error}
                disabled={verify.isPending}
                autoFocus
                ariaLabel="Confirmation code"
              />
            </div>
            {error && (
              <p className="mt-2.5 text-sm font-medium text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
            <div className="mt-4 flex items-center gap-2.5">
              <Button
                type="submit"
                variant="primary"
                loading={verify.isPending}
                disabled={!isCompleteOtp(code)}
              >
                Activate
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setCode('')
                  setError(null)
                  setStep('idle')
                }}
              >
                Finish later
              </Button>
            </div>
          </form>
        </div>
      </Card>
    )
  }

  // --- codes shown exactly once --------------------------------------------
  if (step === 'backup-codes') {
    return (
      <Card className="border-emerald-300/70 dark:border-emerald-800/50">
        <CardHeader className="border-emerald-200/70 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20">
          <CardTitle icon={KeyRound}>Save your backup codes now</CardTitle>
        </CardHeader>
        <div className="px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-amber-50 text-amber-600 ring-1 ring-inset ring-amber-600/15 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25">
              <AlertTriangle className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.75} />
            </span>
            <p className="text-sm leading-relaxed text-ink-400">
              MFA is now active. These codes will <strong className="font-semibold text-ink-100">not</strong>{' '}
              be shown again, each can be used once if you lose access to your authenticator app.
            </p>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-surface-700 bg-surface-800 p-3 font-mono text-sm text-ink-100 sm:grid-cols-3">
            {(backupCodes || []).map((c) => (
              <span key={c} className="tabular-nums">
                {c}
              </span>
            ))}
          </div>
        </div>
        <CardFooter className="justify-between">
          <CopyButton value={(backupCodes || []).join('\n')} label="Copy all codes" />
          <Button
            variant="primary"
            icon={ShieldCheck}
            onClick={() => {
              setStep('idle')
              onEnrolled?.()
            }}
          >
            I&apos;ve saved these codes
          </Button>
        </CardFooter>
      </Card>
    )
  }

  // --- MFA is ON ------------------------------------------------------------
  if (enabled) {
    const on = formatEnabledAt(status?.enabledAt)
    return (
      <>
        <Card>
          <CardHeader>
            <CardTitle icon={ShieldCheck}>Multi-factor authentication</CardTitle>
            <span className="ml-auto flex items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-1 text-2xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              MFA enabled
            </span>
          </CardHeader>

          <div className="flex items-start gap-3.5 px-4 py-4">
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 ring-1 ring-inset ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25">
              <ShieldCheck className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-100">
                This account is protected by a second factor
              </p>
              <p className="mt-1 text-sm leading-relaxed text-ink-400">
                A code from your authenticator app is required on every new sign-in, and for privileged
                actions such as revealing a vault credential.
              </p>
            </div>
          </div>

          <DetailList
            className="border-t border-surface-800"
            items={[
              {
                label: 'Method',
                value: (
                  <span className="flex items-center gap-2">
                    {/* TOTP is a TIME-based code, and a clock reads as that at
                        14px. The phone glyph this used to carry is a bare
                        rounded rectangle plus a dot, which at this size is
                        indistinguishable from an empty box. */}
                    <Clock className="h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
                    {status?.method || 'Authenticator app (TOTP)'}
                  </span>
                ),
              },
              {
                label: 'Enabled',
                value: on || (
                  <span className="text-ink-500">Active, enrolment date not reported by the API</span>
                ),
              },
              ...(status?.sourceNote
                ? [
                    {
                      label: 'Confirmed by',
                      value: <span className="text-ink-300">{status.sourceNote}</span>,
                    },
                  ]
                : []),
              {
                label: 'This session',
                value: status?.verifiedThisSession ? (
                  <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25">
                    Verified
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-md bg-surface-800 px-2 py-0.5 text-xs font-medium text-ink-400 ring-1 ring-inset ring-surface-700">
                    Not verified, sign in again to unlock reveals
                  </span>
                ),
              },
            ]}
          />

          {error && (
            <p className="border-t border-surface-800 px-4 py-3 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <CardFooter className="flex-wrap justify-between gap-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                loading={initiate.isPending}
                onClick={() => setReplaceOpen(true)}
              >
                Replace authenticator
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={KeyRound}
                loading={regenerate.isPending}
                onClick={() => regenerate.mutate()}
                title="Issues a new set and voids the old one"
              >
                New backup codes
              </Button>
            </div>
            <Button
              variant="dangerGhost"
              size="sm"
              icon={ShieldOff}
              loading={disable.isPending}
              onClick={() => {
                setDisableConfirm('')
                setDisableOpen(true)
              }}
            >
              Disable MFA
            </Button>
          </CardFooter>
        </Card>

        {/* Replace: warn BEFORE the request, because the request is the
 destructive step, not the confirmation that follows it. */}
        <Modal
          open={replaceOpen}
          onClose={() => setReplaceOpen(false)}
          busy={initiate.isPending}
          tone="warning"
          icon={AlertTriangle}
          size="lg"
          title="Replace your authenticator?"
          description="Your current authenticator stops working immediately, before you scan the new one."
          footer={
            <>
              <Button variant="ghost" onClick={() => setReplaceOpen(false)} disabled={initiate.isPending}>
                Keep current authenticator
              </Button>
              <Button
                variant="primary"
                icon={RefreshCw}
                loading={initiate.isPending}
                onClick={() => {
                  setReplaceOpen(false)
                  startEnrolment({ wasEnabled: true })
                }}
              >
                Replace it
              </Button>
            </>
          }
        >
          <p className="text-sm leading-relaxed text-ink-300">
            This deployment removes the existing device the moment enrolment starts, so there is a window
            where the account has no second factor. Have your phone in hand and finish in one sitting, if you
            stop halfway, sign-in will not ask for a code until you complete it.
          </p>
        </Modal>

        {/* Disable: real, and typed-confirmation gated. */}
        <Modal
          open={disableOpen}
          onClose={() => setDisableOpen(false)}
          busy={disable.isPending}
          tone="danger"
          icon={ShieldOff}
          size="lg"
          title="Disable multi-factor authentication?"
          description="Your account will be protected by a password alone."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDisableOpen(false)} disabled={disable.isPending}>
                Cancel
              </Button>
              <Button
                variant="danger"
                icon={ShieldOff}
                loading={disable.isPending}
                disabled={disableConfirm.trim().toUpperCase() !== 'DISABLE'}
                onClick={() => disable.mutate()}
              >
                Disable MFA
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="flex items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-50/60 px-3.5 py-3 dark:bg-red-950/15">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 flex-none text-red-600 dark:text-red-400"
                strokeWidth={1.9}
              />
              <ul className="space-y-1 text-xs leading-relaxed text-red-800 dark:text-red-300/90">
                <li>· Your registered authenticator is deleted and cannot be recovered.</li>
                <li>· Sign-in stops asking for a code.</li>
                <li>
                  · Actions that require a verified session, revealing a vault credential, pairing a device,
                  approving break-glass, will start refusing once your current session ends.
                </li>
                <li>· Your existing backup codes stop working.</li>
              </ul>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-ink-300">
                Type <span className="font-mono font-semibold text-ink-100">DISABLE</span> to confirm
              </span>
              <input
                value={disableConfirm}
                onChange={(e) => setDisableConfirm(e.target.value)}
                autoComplete="off"
                spellCheck="false"
                placeholder="DISABLE"
                className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-sm text-ink-50 shadow-sm transition-[border-color,box-shadow] duration-150 placeholder:text-ink-600 hover:border-surface-600 focus:border-red-500 focus:outline-none focus:ring-[3px] focus:ring-red-500/20"
              />
            </label>
          </div>
        </Modal>
      </>
    )
  }

  // --- status genuinely unknown --------------------------------------------
  // Neither an enabled flag nor a device came back, and this browser has
  // never seen a sign-in for the account. Offering a confident "Enable MFA"
  // here would be a guess in the same shape as the original bug.
  if (unknown) {
    return (
      <Card>
        <CardHeader>
          <CardTitle icon={ShieldCheck}>Multi-factor authentication</CardTitle>
          <span className="ml-auto text-2xs font-medium uppercase tracking-[0.08em] text-ink-500">
            Status unavailable
          </span>
        </CardHeader>
        <div className="flex items-start gap-3.5 px-4 py-4">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-surface-700 bg-surface-850 text-ink-400">
            <HelpCircle className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink-100">
              This deployment doesn&apos;t report MFA enrolment
            </p>
            <p className="mt-1 text-sm leading-relaxed text-ink-400">
              The account endpoint returns no enrolment flag and no device list, so the console can&apos;t
              tell you whether a second factor is already active. Sign out and back in and the answer becomes
              definite, the server either challenges you for a code or it doesn&apos;t.
              {status?.verifiedThisSession && (
                <>
                  {' '}
                  Your session is marked MFA-verified, but this backend sets that flag for accounts without
                  MFA too, so it is not proof.
                </>
              )}
            </p>
          </div>
        </div>
        {error && <p className="px-4 pb-1 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <CardFooter className="flex-wrap gap-y-2">
          <Button
            variant="secondary"
            icon={ShieldCheck}
            loading={initiate.isPending}
            onClick={() => startEnrolment({ wasEnabled: true })}
          >
            Set up an authenticator
          </Button>
          <span className="flex items-center gap-1.5 text-2xs text-ink-500">
            <Info className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
            Starting replaces any device already on the account
          </span>
        </CardFooter>
      </Card>
    )
  }

  // --- MFA is OFF -----------------------------------------------------------
  return (
    <Card>
      <CardHeader>
        <CardTitle icon={ShieldCheck}>Multi-factor authentication</CardTitle>
        <span className="ml-auto flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-2xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
          Not enabled
        </span>
      </CardHeader>
      <div className="flex items-start gap-3.5 px-4 py-4">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-amber-50 text-amber-600 ring-1 ring-inset ring-amber-600/15 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25">
          <AlertTriangle className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-100">Add a second factor</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-400">
            Without MFA, privileged actions that require a verified session, revealing vault credentials,
            pairing a device, approving break-glass, will be refused.
          </p>
          {status?.source === 'setup-restarted' && (
            <p className="mt-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
              Enrolment was started and not completed, which removed the previous authenticator. Finish
              setting one up to restore protection.
            </p>
          )}
        </div>
      </div>
      {error && <p className="px-4 pb-1 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <CardFooter>
        <Button
          variant="primary"
          icon={ShieldCheck}
          loading={initiate.isPending}
          onClick={() => startEnrolment({ wasEnabled: false })}
        >
          Enable MFA
        </Button>
      </CardFooter>
    </Card>
  )
}
