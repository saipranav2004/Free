import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate, useLocation } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  Lock,
  Mail,
  ShieldCheck,
  Star,
  CheckCircle2,
} from 'lucide-react'
import { toast } from 'sonner'
import { login } from '../../api/auth'
import { useAuthStore } from '../../store/authStore'
import { resetSessionExpiredGuard } from '../../lib/http'
import { apiErrorMessage } from '../../lib/apiError'
import { Spinner } from '../../components/common/Spinner'
import logoWordmark from '../../assets/logo-wordmark.png'

// ---------------------------------------------------------------------------
// Sign-in, matched to the company's platform login (nav.cf.adapid.link).
// ---------------------------------------------------------------------------
// Deliberately theme-independent: the platform's sign-in is a fixed brand
// surface (deep navy field, white credential card), not a themed console
// screen, so it does not follow the light/dark token set the rest of the app
// uses. That's why the colours here are literal brand values rather than
// surface-*/ink-* classes, this one screen is the brand, and it must look
// identical on every machine regardless of the viewer's theme preference.
//
// AUTH BEHAVIOUR IS UNCHANGED. Same schema, same react-hook-form wiring, same
// mutation, same MFA-challenge branch, same redirect-to-`from` logic as
// before, only the presentation is new.

const schema = z.object({
  identifier: z.string().trim().min(1, 'Required'),
  password: z.string().min(1, 'Required'),
})

const NAVY = '#0A1729'
const CYAN = '#29A8E0'

const ASSURANCES = [
  { icon: ShieldCheck, label: 'SOC 2 Type II Certified' },
  { icon: Star, label: 'ISO 27001 Compliant' },
  { icon: CheckCircle2, label: '24/7 Monitoring' },
]

const fieldClass = (hasError) =>
  [
    'h-[3.125rem] w-full rounded-xl border bg-white px-4 text-[0.9375rem] text-slate-900 shadow-[0_1px_2px_rgb(15_23_42/0.04)]',
    'transition-[border-color,box-shadow] duration-150 placeholder:text-slate-400',
    'focus:outline-none focus-visible:outline-none',
    hasError
      ? 'border-red-400 focus:border-red-500 focus:ring-[3px] focus:ring-red-500/15'
      : 'border-slate-200 hover:border-slate-300 focus:border-[#29A8E0] focus:ring-[3px] focus:ring-[#29A8E0]/20',
  ].join(' ')

function FieldLabel({ icon: Icon, children, htmlFor }) {
  return (
    <label htmlFor={htmlFor} className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
      <Icon className="h-4 w-4 flex-none text-slate-400" strokeWidth={1.75} />
      {children}
    </label>
  )
}

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const setSession = useAuthStore((s) => s.setSession)
  const setMfaChallenge = useAuthStore((s) => s.setMfaChallenge)
  const [formError, setFormError] = useState(null)
  const [showPassword, setShowPassword] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({ resolver: zodResolver(schema) })

  const mutation = useMutation({
    mutationFn: ({ identifier, password }) => login(identifier, password),
    onSuccess: (result, variables) => {
      setFormError(null)
      // LoginResult's fields are `omitempty` on the Go side, the only
      // reliable way to tell "full session" from "MFA challenge" apart is
      // whether access_token actually came back, not the HTTP status (both
      // paths return 200, see auth_handler.go's Login: ErrMFARequired is
      // deliberately treated as a *success* response, not an error one).
      if (result?.access_token) {
        resetSessionExpiredGuard()
        // A session carrying mfa_enrollment_required is RESTRICTED: role-gated
        // MFA policy says this account must hold a second factor and it does
        // not, so the server issued a token that reaches the enrolment
        // endpoints and nothing else. It is still a real session and is stored
        // like one, MfaEnforcementGate reads the same flag off /auth/me and
        // shows the enrolment interrupt instead of the console. Refusing to
        // store it here would strand the user with no way to enrol.
        setSession({
          accessToken: result.access_token,
          expiresAt: result.expires_at,
          user: null, // populated by the dashboard's `me()` fetch
          // A full session with NO challenge is the backend stating this
          // account has no enrolled MFA device. Recorded as evidence, it is
          // the only reliable "MFA is off" signal this API gives, since
          // /auth/me carries no enrolment field. See lib/mfaEvidence.js.
          identifier: variables?.identifier,
        })
        const from = location.state?.from?.pathname || '/'
        navigate(from, { replace: true })
        return
      }
      if (result?.challenge_token) {
        // Conversely, a challenge can only be issued for an account that HAS
        // an enrolled device, proof of enrolment, recorded by the store.
        setMfaChallenge({
          challengeToken: result.challenge_token,
          identifier: variables?.identifier,
        })
        navigate('/mfa-verify', { replace: true })
        return
      }
      // Defensive: neither shape came back. Don't silently do nothing ,
      // that's the kind of bug where the user clicks Login, sees no error
      // and no navigation, and assumes the app is frozen.
      setFormError('Unexpected response from the server. Please try again.')
    },
    onError: (err) => setFormError(apiErrorMessage(err)),
  })

  const onSubmit = (values) => {
    setFormError(null)
    mutation.mutate(values)
  }

  return (
    <div className="relative min-h-screen overflow-hidden" style={{ backgroundColor: NAVY }}>
      {/* Brand field: a lit navy plane. Two soft radial washes (not a linear
 gradient sweep) is what gives the reference its depth without
 reading as a decorative gradient background. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(1100px 720px at 18% 8%, rgba(41,120,196,0.42), transparent 62%), radial-gradient(900px 600px at 8% 96%, rgba(12,32,58,0.9), transparent 70%)',
        }}
      />
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
        {/* ---------------------------------------------------------------
            Positioning panel
 --------------------------------------------------------------- */}
        <section className="flex min-w-0 flex-1 flex-col justify-between gap-12 px-6 pb-10 pt-10 sm:px-10 lg:py-14 lg:pl-14 lg:pr-8 xl:pl-20">
          <div className="inline-flex w-fit items-center gap-2.5 rounded-full border border-white/[0.14] bg-white/[0.05] py-2 pl-3 pr-4 backdrop-blur-sm">
            <span
              className="h-1.5 w-1.5 flex-none rounded-full"
              style={{ backgroundColor: CYAN }}
              aria-hidden="true"
            />
            <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-slate-200">
              Enterprise Security Platform
            </span>
          </div>

          <div className="max-w-2xl">
            <h1 className="text-[2.75rem] font-bold leading-[1.04] tracking-[-0.03em] text-white sm:text-6xl lg:text-[4.25rem]">
              Privileged
              <br />
              Access
              <br />
              <span style={{ color: CYAN }}>Management</span>
            </h1>

            <p className="mt-8 max-w-xl text-base font-medium leading-relaxed text-slate-300/90 sm:text-lg">
              Brokered sessions, just-in-time elevation and tamper-evident audit, engineered for enterprises
              that can&apos;t afford standing privilege.
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

        {/* ---------------------------------------------------------------
            Credential card
 --------------------------------------------------------------- */}
        {/* THE CARD IS A CONTAINED PANEL, NOT A FULL-HEIGHT SLAB.
            It used to be a white plane bolted to the right edge, stretched to
 the full viewport height, with a 26rem column of content floating
 in the middle of it. On a laptop that reads as an unfinished
 layout: most of the white is empty, the form has no perceptible
 edges, and the brand field it is supposed to sit on top of is
 hidden behind it.

            Every enterprise sign-in built to feel considered - Okta, Azure AD,
            CyberArk, Auth0, Duo - does the same thing instead: ONE modest card,
 sized to its own content, optically centred, floating clear of the
 brand field on all four sides. The card gets a real edge, the field
 stays visible as context, and the eye lands on the form because it
 is the only object with a boundary rather than because it is the
 largest area of white.

            So: a 28rem measure, height driven by the content, a two-layer
 shadow for lift instead of one very large soft one, and a hairline
 ring so the white edge stays crisp against the navy.

            TWO THINGS THIS GETS RIGHT THAT THE FIRST ATTEMPT DID NOT.

            SIZE. 25rem was too tight - at a 15px type scale it made a card
 that read as a modal fragment rather than the primary object on the
 screen. 28rem (448px) with 50px fields and a 20-24px internal step
 is the size the enterprise consoles actually ship: substantial
 enough to carry the brand mark and a three-line legal footer
 without feeling cramped, still far short of the full-height slab.

            HORIZONTAL POSITION. The column had BOTH a percentage width and a
            33rem max-width. Past about 1400px viewport the cap won, so the
 column stopped growing while the page kept getting wider - which
 pinned the card to the right edge with a widening gutter of navy
 to its left. The cap is gone: the column is now a fixed share of
 the viewport (46%) and the card is centred inside it, so it sits in
 the middle of the right half at every width, which is what it
 should have been doing. Colours are untouched. */}
        <div className="flex w-full flex-none items-center justify-center px-5 pb-10 pt-2 lg:w-[46%] lg:px-10 lg:py-10">
          <div className="w-full max-w-[28rem] rounded-2xl bg-white px-7 py-9 shadow-[0_28px_64px_-22px_rgba(3,10,22,0.62),0_2px_8px_-3px_rgba(3,10,22,0.30)] ring-1 ring-slate-900/[0.06] sm:px-9">
            <div className="w-full">
              <img
                src={logoWordmark}
                alt="Deep Algorithms"
                className="mx-auto mb-8 h-9 w-auto object-contain"
              />

              <h2 className="text-[1.625rem] font-bold tracking-[-0.02em] text-slate-900">Welcome</h2>
              <p className="mt-1.5 text-[0.9375rem] text-slate-500">Sign in to access the platform</p>

              <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-7">
                {formError && (
                  <div
                    role="alert"
                    className="mb-5 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 flex-none" strokeWidth={2} />
                    <span className="leading-relaxed">{formError}</span>
                  </div>
                )}

                <div>
                  <FieldLabel icon={Mail} htmlFor="identifier">
                    Username
                  </FieldLabel>
                  <input
                    id="identifier"
                    autoFocus
                    autoComplete="username"
                    placeholder="name@example.com"
                    aria-invalid={!!errors.identifier}
                    className={fieldClass(!!errors.identifier)}
                    {...register('identifier')}
                  />
                  {errors.identifier && (
                    <p className="mt-1.5 text-xs font-medium text-red-600" role="alert">
                      {errors.identifier.message}
                    </p>
                  )}
                </div>

                <div className="mt-5">
                  <FieldLabel icon={Lock} htmlFor="password">
                    Password
                  </FieldLabel>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder="••••••••"
                      aria-invalid={!!errors.password}
                      className={fieldClass(!!errors.password) + ' pr-12'}
                      {...register('password')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                    >
                      {showPassword ? (
                        <EyeOff className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.75} />
                      ) : (
                        <Eye className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.75} />
                      )}
                    </button>
                  </div>
                  {errors.password && (
                    <p className="mt-1.5 text-xs font-medium text-red-600" role="alert">
                      {errors.password.message}
                    </p>
                  )}
                </div>

                <div className="mt-4 flex justify-end">
                  {/* There is no self-service reset route in this platform , 
 administrators issue password resets through Identity
                      Management. The link tells the user that instead of
 navigating them to a dead end. */}
                  <button
                    type="button"
                    onClick={() =>
                      toast.info('Password resets are issued by your administrator', {
                        description:
                          'Contact your PAM administrator to have a temporary password created for you.',
                      })
                    }
                    className="text-sm font-medium transition-colors hover:opacity-80"
                    style={{ color: '#1E7CC8' }}
                  >
                    Forgot password?
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={mutation.isPending}
                  className="mt-7 flex h-[3.25rem] w-full items-center justify-center gap-2.5 rounded-xl text-[0.9375rem] font-semibold text-white shadow-[0_10px_24px_-10px_rgba(30,124,200,0.75)] transition-[filter,box-shadow] duration-150 hover:brightness-[1.06] active:brightness-95 disabled:cursor-not-allowed disabled:opacity-70"
                  style={{ backgroundImage: 'linear-gradient(90deg, #2FA8E0 0%, #1C79C6 100%)' }}
                >
                  {mutation.isPending ? (
                    <>
                      <Spinner size="h-4 w-4" className="text-white" />
                      Signing in…
                    </>
                  ) : (
                    <>
                      Sign in securely
                      <ArrowRight className="h-[1.05rem] w-[1.05rem]" strokeWidth={2.25} />
                    </>
                  )}
                </button>
              </form>

              <p className="mt-7 text-center text-[0.8125rem] leading-relaxed text-slate-500">
                Authorized use only. Every access attempt is logged and monitored.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
