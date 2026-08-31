import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  KeyRound,
  LifeBuoy,
  Smartphone,
  Star,
  CheckCircle2,
  Clock3,
} from 'lucide-react'
import { toast } from 'sonner'
import { recoverWithBackupCode, verifyMfa } from '../../api/auth'
import { useAuthStore } from '../../store/authStore'
import { resetSessionExpiredGuard } from '../../lib/http'
import { apiErrorMessage } from '../../lib/apiError'
import { Spinner } from '../../components/common/Spinner'
import { OtpInput, isCompleteOtp } from '../../components/common/OtpInput'
import logoWordmark from '../../assets/logo-wordmark.png'

// ---------------------------------------------------------------------------
// Two-factor verification, step 2 of the sign-in flow
// ---------------------------------------------------------------------------
// This screen uses the same brand surface and card treatment as the login
// screen so the authentication flow feels like one continuous experience.
//
// The verification card is intentionally minimal:
//   · centered company logo
//   · clear verification heading
//   · account being verified
//   · authenticator / recovery method switch
//   · OTP or recovery code input
//   · primary verification action
//   · secondary navigation / recovery assistance
//
// Authentication behavior is unchanged.
// ---------------------------------------------------------------------------

const NAVY = '#0A1729'
const CYAN = '#29A8E0'

const ASSURANCES = [
  { icon: Star, label: 'SOC 2 Type II Certified' },
  { icon: CheckCircle2, label: 'ISO 27001 Compliant' },
  { icon: CheckCircle2, label: '24/7 Monitoring' },
]

const STEPS = ['Credentials', 'Verification', 'Console']

const METHODS = [
  { key: 'totp', label: 'Authenticator app', icon: Smartphone },
  { key: 'recovery', label: 'Recovery code', icon: KeyRound },
]

function FlowSteps({ current = 1 }) {
  return (
    <ol className="flex items-center gap-3" aria-label="Sign-in progress">
      {STEPS.map((label, i) => {
        const done = i < current
        const active = i === current

        return (
          <li key={label} className="flex items-center gap-3">
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex h-5 w-5 flex-none items-center justify-center rounded-full text-[0.625rem] font-bold"
                style={{
                  backgroundColor: done ? 'rgba(16,185,129,0.18)' : active ? CYAN : 'rgba(255,255,255,0.08)',
                  color: done ? '#34d399' : active ? '#04121f' : 'rgba(226,232,240,0.55)',
                  boxShadow: active ? `0 0 0 4px rgba(41,168,224,0.16)` : 'none',
                }}
              >
                {done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
              </span>

              <span
                className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em]"
                style={{
                  color: active ? '#E2E8F0' : 'rgba(226,232,240,0.5)',
                }}
              >
                {label}
              </span>
            </span>

            {i < STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className="h-px w-6 flex-none"
                style={{
                  backgroundColor: 'rgba(226,232,240,0.18)',
                }}
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}

export default function MfaVerifyPage() {
  const navigate = useNavigate()

  const challenge = useAuthStore((s) => s.mfaChallenge)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated())
  const setSession = useAuthStore((s) => s.setSession)
  const clearMfaChallenge = useAuthStore((s) => s.clearMfaChallenge)

  const [method, setMethod] = useState('totp')
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState('')
  const [error, setError] = useState(null)
  const [attempts, setAttempts] = useState(0)

  const recoveryRef = useRef(null)

  // -------------------------------------------------------------------------
  // Guard against reaching this screen without a valid MFA challenge.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!challenge?.challengeToken && !isAuthenticated) {
      navigate('/login', { replace: true })
    }
  }, [challenge, isAuthenticated, navigate])

  // -------------------------------------------------------------------------
  // MFA verification mutation
  // -------------------------------------------------------------------------
  const mutation = useMutation({
    // The two factors are two endpoints. Which one gets called is the whole
    // difference between a recovery code working and a recovery code being
    // told it is invalid.
    mutationFn: (c) =>
      method === 'recovery'
        ? recoverWithBackupCode(challenge.challengeToken, c)
        : verifyMfa(challenge.challengeToken, c),

    onSuccess: (result) => {
      resetSessionExpiredGuard()
      clearMfaChallenge()

      // A backup code is single use and now genuinely spent, so the count
      // only goes down. Saying so at the moment it happens is the difference
      // between "I have codes somewhere" and discovering the set is empty on
      // the day the phone is already lost.
      // backup_codes_remaining is the signal, and it is set ONLY by the
      // recover route. There is no `used_backup_code` field; the previous
      // check was for something the API never sends, so even a successful
      // recovery would have passed in silence.
      if (result?.backup_codes_remaining != null) {
        const left = result.backup_codes_remaining
        toast.warning(
          left > 0
            ? `Signed in with a backup code, ${left} left. Generate a new set in Settings.`
            : 'Signed in with your last backup code. Generate a new set in Settings now.',
          { duration: 10000 }
        )
      }

      setSession({
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: result.expires_at,
        user: null,
        identifier: challenge?.identifier,
        viaMfaChallenge: true,
      })

      navigate('/', { replace: true })
    },

    onError: (err) => {
      setError(apiErrorMessage(err))
      setAttempts((n) => n + 1)

      // Clear rejected values so the user re-enters the code.
      setCode('')
      setRecovery('')
    },
  })

  const value = method === 'totp' ? code : recovery.trim()

  const submittable = method === 'totp' ? isCompleteOtp(code) : recovery.trim().length >= 6

  const submit = (c) => {
    const next = c ?? value

    const ok = method === 'totp' ? isCompleteOtp(next) : String(next).trim().length >= 6

    if (!ok || mutation.isPending) return

    setError(null)
    mutation.mutate(String(next).trim())
  }

  const switchMethod = (next) => {
    if (next === method) return

    setMethod(next)
    setError(null)
    setCode('')
    setRecovery('')

    if (next === 'recovery') {
      requestAnimationFrame(() => recoveryRef.current?.focus())
    }
  }

  if (!challenge?.challengeToken) return null

  return (
    <div className="relative min-h-screen overflow-hidden" style={{ backgroundColor: NAVY }}>
      {/* Background lighting */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(1100px 720px at 18% 8%, rgba(41,120,196,0.42), transparent 62%), radial-gradient(900px 600px at 8% 96%, rgba(12,32,58,0.9), transparent 70%)',
        }}
      />

      {/* Subtle background grid */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(148,183,226,0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,183,226,0.07) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse at 25% 15%, black 5%, transparent 65%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 25% 15%, black 5%, transparent 65%)',
        }}
      />

      <div className="relative flex min-h-screen flex-col lg:flex-row">
        {/* -----------------------------------------------------------------
            Assurance panel
 ----------------------------------------------------------------- */}
        <section className="flex min-w-0 flex-1 flex-col justify-between gap-12 px-6 pb-10 pt-10 sm:px-10 lg:py-14 lg:pl-14 lg:pr-8 xl:pl-20">
          <div className="flex flex-col items-start gap-7">
            <div className="inline-flex w-fit items-center gap-2.5 rounded-full border border-white/[0.14] bg-white/[0.05] py-2 pl-3 pr-4 backdrop-blur-sm">
              <span
                className="h-1.5 w-1.5 flex-none rounded-full"
                style={{ backgroundColor: CYAN }}
                aria-hidden="true"
              />

              <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-slate-200">
                Step 2 of 2 · Identity Verification
              </span>
            </div>

            <FlowSteps current={1} />
          </div>

          <div className="max-w-2xl">
            <h1 className="text-[2.5rem] font-bold leading-[1.06] tracking-[-0.03em] text-white sm:text-5xl lg:text-[3.75rem]">
              One more
              <br />
              <span style={{ color: CYAN }}>proof of identity</span>
            </h1>

            <p className="mt-8 max-w-xl text-base font-medium leading-relaxed text-slate-300/90 sm:text-lg">
              Your password alone does not open a privileged session. Confirm the second factor from a device
              you control and the console will be unlocked for this session only.
            </p>

            <ul className="mt-10 flex flex-wrap items-center gap-x-9 gap-y-4">
              {ASSURANCES.map((a) => (
                <li
                  key={a.label}
                  className="flex items-center gap-2.5 text-sm font-medium text-slate-200 sm:text-[0.9375rem]"
                >
                  <a.icon className="h-[1.15rem] w-[1.15rem] flex-none text-emerald-400" strokeWidth={1.75} />
                  {a.label}
                </li>
              ))}
            </ul>
          </div>

          <p className="text-xs text-slate-400/80 sm:text-sm">
            © {new Date().getFullYear()} Deep Algorithms · Fostering AI. Connecting Minds.
          </p>
        </section>

        {/* -----------------------------------------------------------------
            Verification card
 ----------------------------------------------------------------- */}
        <div className="flex w-full flex-none items-center justify-center px-5 pb-10 pt-2 lg:w-[46%] lg:px-10 lg:py-10">
          <div className="w-full max-w-[29rem] rounded-2xl bg-white px-7 py-9 shadow-[0_28px_64px_-22px_rgba(3,10,22,0.62),0_2px_8px_-3px_rgba(3,10,22,0.30)] ring-1 ring-slate-900/[0.06] sm:px-9">
            <div className="w-full">
              {/* -----------------------------------------------------------
                  Centered company logo + heading
 ----------------------------------------------------------- */}
              <div className="text-center">
                <img
                  src={logoWordmark}
                  alt="Deep Algorithms"
                  className="mx-auto mb-8 h-9 w-auto object-contain"
                />

                <h2 className="text-[1.5rem] font-bold leading-tight tracking-[-0.02em] text-slate-900">
                  Two-factor verification
                </h2>

                <p className="mx-auto mt-2 max-w-[28rem] text-sm leading-relaxed text-slate-500">
                  {method === 'totp'
                    ? 'Enter the 6-digit code shown in your authenticator app.'
                    : 'Enter one unused recovery code from when you enrolled.'}
                </p>
              </div>

              {/* -----------------------------------------------------------
                  Account being verified
 ----------------------------------------------------------- */}
              {challenge?.identifier && (
                <div className="mx-auto mt-6 flex max-w-[28rem] items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-left">
                  <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-slate-900 text-[0.625rem] font-bold uppercase text-white">
                    {String(challenge.identifier).charAt(0)}
                  </span>

                  <span className="min-w-0 flex-1 truncate text-sm text-slate-600">
                    Verifying <span className="font-semibold text-slate-900">{challenge.identifier}</span>
                  </span>
                </div>
              )}

              {/* -----------------------------------------------------------
                  Authentication method switch
 ----------------------------------------------------------- */}
              <div className="mt-6 inline-flex w-full items-center gap-1 rounded-xl border border-slate-200 bg-slate-100/70 p-1">
                {METHODS.map((m) => {
                  const selected = method === m.key

                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => switchMethod(m.key)}
                      aria-pressed={selected}
                      className={[
                        'inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg text-[0.8125rem] font-semibold transition-all duration-150',
                        selected
                          ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgb(15_23_42/0.10)] ring-1 ring-slate-200'
                          : 'text-slate-500 hover:text-slate-800',
                      ].join(' ')}
                    >
                      <m.icon className="h-4 w-4 flex-none" strokeWidth={1.75} />
                      {m.label}
                    </button>
                  )
                })}
              </div>

              {/* -----------------------------------------------------------
                  Verification form
 ----------------------------------------------------------- */}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  submit()
                }}
                className="mt-6"
                noValidate
              >
                {method === 'totp' ? (
                  <OtpInput
                    value={code}
                    onChange={setCode}
                    onComplete={submit}
                    invalid={!!error}
                    disabled={mutation.isPending}
                    autoFocus
                    tone="brand"
                    ariaLabel="Six digit verification code"
                  />
                ) : (
                  <div>
                    <label
                      htmlFor="recovery-code"
                      className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800"
                    >
                      <KeyRound className="h-4 w-4 flex-none text-slate-400" strokeWidth={1.75} />
                      Recovery code
                    </label>

                    <input
                      id="recovery-code"
                      ref={recoveryRef}
                      value={recovery}
                      onChange={(e) => setRecovery(e.target.value)}
                      autoComplete="one-time-code"
                      spellCheck="false"
                      autoCapitalize="off"
                      placeholder="xxxx-xxxx-xxxx"
                      aria-invalid={!!error}
                      disabled={mutation.isPending}
                      className={[
                        // auth-field: same always-white card, same autofill fix.
                        'auth-field h-[3.25rem] w-full rounded-xl border bg-white px-4 text-center font-mono text-lg tracking-[0.12em] text-slate-900 shadow-[0_1px_2px_rgb(15_23_42/0.04)]',
                        'transition-[border-color,box-shadow] duration-150 placeholder:tracking-normal placeholder:text-slate-300',
                        'focus:outline-none focus:ring-[3px] disabled:opacity-60',
                        error
                          ? 'border-red-400 focus:border-red-500 focus:ring-red-500/15'
                          : 'border-slate-200 hover:border-slate-300 focus:border-[#29A8E0] focus:ring-[#29A8E0]/20',
                      ].join(' ')}
                    />

                    <p className="mt-2 text-xs leading-relaxed text-slate-500">
                      Each recovery code works once. Using one here does not disable your authenticator.
                    </p>
                  </div>
                )}

                {/* Error message */}
                {error && (
                  <div
                    role="alert"
                    className="mt-5 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 flex-none" strokeWidth={2} />

                    <span className="leading-relaxed">{error}</span>
                  </div>
                )}

                {/* Clock drift guidance after repeated failures */}
                {attempts >= 2 && method === 'totp' && (
                  <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
                    <Clock3 className="mt-0.5 h-4 w-4 flex-none" strokeWidth={2} />

                    <span className="leading-relaxed">
                      Codes rejected repeatedly? Check that automatic time is enabled on the device running
                      your authenticator, a clock more than 30 seconds out generates codes this server will
                      refuse.
                    </span>
                  </div>
                )}

                {/* Primary action */}
                <button
                  type="submit"
                  disabled={!submittable || mutation.isPending}
                  className="mt-6 flex h-[3.25rem] w-full items-center justify-center gap-2.5 rounded-xl text-[0.9375rem] font-semibold text-white shadow-[0_10px_24px_-10px_rgba(30,124,200,0.75)] transition-[filter,box-shadow] duration-150 hover:brightness-[1.06] active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
                  style={{
                    backgroundImage: 'linear-gradient(90deg, #2FA8E0 0%, #1C79C6 100%)',
                  }}
                >
                  {mutation.isPending ? (
                    <>
                      <Spinner size="h-4 w-4" className="text-white" />
                      Verifying…
                    </>
                  ) : (
                    <>
                      Verify and continue
                      <ArrowRight className="h-[1.05rem] w-[1.05rem]" strokeWidth={2.25} />
                    </>
                  )}
                </button>
              </form>

              {/* -----------------------------------------------------------
                  Secondary navigation
 ----------------------------------------------------------- */}
              <div className="mt-7 flex flex-col gap-3 border-t border-slate-200 pt-5">
                <button
                  type="button"
                  onClick={() => {
                    clearMfaChallenge()
                    navigate('/login', { replace: true })
                  }}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-800"
                >
                  <ArrowLeft className="h-[0.95rem] w-[0.95rem]" strokeWidth={2} />
                  Back to sign in
                </button>

                <span className="flex items-center gap-1.5 text-sm text-slate-500">
                  <LifeBuoy className="h-[0.95rem] w-[0.95rem] flex-none text-slate-400" strokeWidth={1.75} />
                  Lost both? Your administrator can re-enrol you.
                </span>
              </div>

              {/* -----------------------------------------------------------
                  Authorized-use notice intentionally hidden for this screen.
                  Kept here for easy restoration if required later.
 ----------------------------------------------------------- */}
              {/*
              <p className="mt-6 text-center text-[0.8125rem] leading-relaxed text-slate-500">
                Authorized use only. Every verification attempt is recorded in
 the audit log.
              </p>
              */}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
