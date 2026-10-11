import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowLeft, Eye, EyeOff, Lock } from 'lucide-react'
import { Button, Meta, inputClass } from '../ui/primitives'

// ===========================================================================
// Sign-in and MFA
// ===========================================================================
// WHAT CHANGED
//
//  • The split marketing hero is gone. It used a second, hard-coded palette
//    (slate-900 / white) and 44–68px display type that exists nowhere else in
//    the product — so a user's first two screens didn't look like the product
//    they were signing in to. One centred frame on the token background,
//    identical for both steps, so /login → /mfa-verify reads as a CONTENT
//    change rather than a page change (1Password's unlock model).
//  • The MFA step gets a route back. Today the only way out is browser Back.
//  • The error copy never distinguishes "no such user" from "wrong password" —
//    that is deliberate and stays.
//
// ENDPOINTS  POST /api/v1/auth/login · POST /api/v1/auth/mfa/verify

function AuthFrame({ children, footer }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-app px-4 py-16">
      <div className="w-full max-w-[22rem]">
        <div className="mb-8 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-accent text-sm font-semibold text-white">P</span>
          <span className="text-lg font-semibold text-primary">PAM Console</span>
        </div>
        {children}
        {footer && <div className="mt-8 border-t border-line pt-4">{footer}</div>}
      </div>
    </div>
  )
}

export function Login() {
  const [show, setShow] = useState(false)
  const [error, setError] = useState(false)

  return (
    <AuthFrame
      footer={
        <p className="text-xs text-tertiary">
          Access to this console is logged. Sessions are recorded where policy requires it.
        </p>
      }
    >
      <h1 className="text-xl font-semibold text-primary">Sign in</h1>
      <p className="mt-1 text-base text-secondary">Use your organisation account.</p>

      <form className="mt-6 space-y-4" onSubmit={(e) => e.preventDefault()}>
        <div>
          <label htmlFor="identifier" className="mb-2 block text-micro font-semibold uppercase text-tertiary">
            Username or email
          </label>
          <input id="identifier" autoComplete="username" className={inputClass} defaultValue="m.sharma" />
        </div>

        <div>
          <label htmlFor="password" className="mb-2 block text-micro font-semibold uppercase text-tertiary">
            Password
          </label>
          <div className="relative">
            <input
              id="password"
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              className={clsx(inputClass, 'pr-9')}
              defaultValue="••••••••••••"
            />
            <button
              type="button"
              onClick={() => setShow(!show)}
              aria-label={show ? 'Hide password' : 'Show password'}
              className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-tertiary hover:text-primary"
            >
              {show ? <EyeOff className="h-4 w-4" strokeWidth={1.75} /> : <Eye className="h-4 w-4" strokeWidth={1.75} />}
            </button>
          </div>
        </div>

        {error && (
          <p className="rounded border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            Those credentials weren&apos;t accepted.
          </p>
        )}

        <Button variant="primary" size="lg" className="w-full" to="/mfa-verify">
          Continue
        </Button>
      </form>

      <button type="button" onClick={() => setError(!error)} className="mt-4 text-xs text-tertiary underline">
        {error ? 'hide' : 'preview'} the error state
      </button>
    </AuthFrame>
  )
}

export function MfaVerify() {
  const [code, setCode] = useState(['', '', '', '', '', ''])
  const [useBackup, setUseBackup] = useState(false)

  return (
    <AuthFrame
      footer={
        <Link to="/login" className="inline-flex items-center gap-2 text-sm text-accent hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          Use a different account
        </Link>
      }
    >
      <h1 className="text-xl font-semibold text-primary">Two-factor</h1>
      <p className="mt-1 text-base text-secondary">
        {useBackup ? 'Enter one of your single-use backup codes.' : 'Enter the six-digit code from your authenticator app.'}
      </p>

      <div className="mt-6">
        {useBackup ? (
          <input aria-label="Backup code" placeholder="xxxx-xxxx" className={clsx(inputClass, 'h-10 text-center font-mono')} />
        ) : (
          <div className="flex gap-2" role="group" aria-label="Six digit code">
            {code.map((d, i) => (
              <input
                key={i}
                inputMode="numeric"
                maxLength={1}
                value={d}
                onChange={(e) => {
                  const next = [...code]
                  next[i] = e.target.value.replace(/\D/g, '')
                  setCode(next)
                }}
                aria-label={`Digit ${i + 1}`}
                className="h-11 w-full rounded border border-line bg-surface text-center font-mono text-lg text-primary focus:border-accent focus:outline-none"
              />
            ))}
          </div>
        )}
      </div>

      <Button variant="primary" size="lg" className="mt-4 w-full" to="/">
        Verify
      </Button>

      <button type="button" onClick={() => setUseBackup(!useBackup)} className="mt-4 text-sm text-accent hover:underline">
        {useBackup ? 'Use my authenticator app instead' : 'I don’t have my phone — use a backup code'}
      </button>

      <p className="mt-6 flex items-start gap-2 text-xs text-tertiary">
        <Lock className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
        <span>
          Approving a JIT request also requires this factor — the approve endpoint is MFA-gated server-side, so an
          admin without one cannot approve at all.
        </span>
      </p>
      <Meta className="mt-4 block">Mockup: the frame is identical to the sign-in step, so the transition is a content swap.</Meta>
    </AuthFrame>
  )
}
