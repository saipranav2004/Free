import { useId, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { isDemo } from '../../backend'
import { DEMO_ACCOUNTS } from '../../backend/demo'
import { Banner, Button, Spinner } from '../../components/ui'
import { friendlyError } from '../../lib/errors'
import { useStaffSession } from '../../state/staffSession'

export function LoginPage() {
  const { profile, loading, signIn } = useStaffSession()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/staff'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const emailId = useId()
  const passwordId = useId()

  if (loading) return <div className="grid min-h-dvh place-items-center"><Spinner label="Loading" /></div>
  if (profile) return <Navigate to={from.startsWith('/staff') ? from : '/staff'} replace />

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signIn(email, password)
      navigate(from.startsWith('/staff') ? from : '/staff', { replace: true })
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <img src={`${import.meta.env.BASE_URL}brand/logo-320.webp`} alt="Bite & Sip College Café" width={120} height={120} className="rounded-3xl" />
          <h1 className="mt-5 text-2xl font-extrabold text-white">Staff sign in</h1>
          <p className="mt-1 text-sm text-white/65">Kitchen and owner access only.</p>
        </div>
        <form onSubmit={submit} noValidate className="mt-6 space-y-4 rounded-3xl bg-surface p-5">
          {error && <Banner tone="danger">{error}</Banner>}
          <div>
            <label htmlFor={emailId} className="label">Email</label>
            <input id={emailId} type="email" autoComplete="username" className="field-input" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label htmlFor={passwordId} className="label">Password</label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              className="field-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" size="lg" className="w-full" loading={busy}>
            Sign in
          </Button>
          <p className="text-center text-xs text-muted">Forgot your password? Ask the owner to reset it.</p>
        </form>

        {isDemo && (
          <div className="mt-4 rounded-3xl border border-white/15 p-4 text-sm text-white/80">
            <p className="font-bold text-white">Demo accounts</p>
            <ul className="mt-2 space-y-2">
              {DEMO_ACCOUNTS.map((a) => (
                <li key={a.email}>
                  <button
                    type="button"
                    className="w-full rounded-xl bg-white/10 px-3 py-2 text-left hover:bg-white/15"
                    onClick={() => {
                      setEmail(a.email)
                      setPassword(a.password)
                    }}
                  >
                    <span className="font-bold text-white capitalize">{a.role}</span> · {a.email} / {a.password}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-6 text-center text-sm">
          <Link to="/" className="font-semibold text-white/70 underline underline-offset-4 hover:text-white">
            Go to the student menu
          </Link>
        </p>
      </div>
    </main>
  )
}
