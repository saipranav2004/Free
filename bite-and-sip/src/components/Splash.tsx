import { useEffect, useRef, useState } from 'react'

const SEEN_KEY = 'bitesip-intro-seen'

function seen() {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}

function markSeen() {
  try {
    window.sessionStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* storage blocked: the intro may replay, which is harmless */
  }
}

/** Student entry points get the intro; staff pages and order links never do. */
export function shouldShowIntro(pathname: string) {
  if (seen()) return false
  return pathname === '/' || pathname.startsWith('/t/')
}

const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)'

/**
 * Brand intro: the logo sharpens into focus and a yellow ring draws around it;
 * then the black panel shrinks into the menu's black hero band.
 * It doubles as the loading screen (waits for `ready`, at most ~4 s), can be
 * skipped with a tap or key, plays once per browser session and is reduced to
 * a short fade for people who prefer reduced motion.
 */
export function Splash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  const logo = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<'intro' | 'exit'>('intro')
  const [minTimeDone, setMinTimeDone] = useState(false)
  const exiting = useRef(false)
  const doneRef = useRef(onDone)
  useEffect(() => {
    doneRef.current = onDone
  }, [onDone])

  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    markSeen()
    const t = setTimeout(() => setMinTimeDone(true), reduced ? 500 : 1900)
    return () => clearTimeout(t)
  }, [reduced])

  useEffect(() => {
    if (!minTimeDone) return
    if (ready) {
      exit()
      return
    }
    // Never hold students hostage to a slow network: leave after ~4 s regardless.
    const cap = setTimeout(exit, 2100)
    return () => clearTimeout(cap)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minTimeDone, ready])

  function exit() {
    if (exiting.current) return
    exiting.current = true
    setPhase('exit')
    const el = root.current
    if (!el) return doneRef.current()
    if (reduced) {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' }).finished.then(() => doneRef.current(), () => doneRef.current())
      return
    }
    const hero = document.querySelector<HTMLElement>('[data-hero]')
    const bottom = hero ? Math.max(0, hero.getBoundingClientRect().bottom) : 0
    const h = window.innerHeight
    const inset = bottom > 0 ? `inset(0px 0px ${h - bottom}px 0px round 0px 0px 28px 28px)` : 'inset(0px 0px 100% 0px round 0px 0px 28px 28px)'
    logo.current?.animate(
      [
        { transform: 'translateY(0) scale(1)', opacity: 1, filter: 'blur(0px)' },
        { transform: `translateY(${-Math.min(h * 0.25, 220)}px) scale(0.55)`, opacity: 0, filter: 'blur(6px)' },
      ],
      { duration: 520, easing: EASE_IN_OUT, fill: 'forwards' },
    )
    const panel = el.animate(
      [
        { clipPath: 'inset(0px 0px 0px 0px round 0px 0px 0px 0px)', backgroundColor: '#050505' },
        { clipPath: inset, backgroundColor: '#111111', offset: 0.85 },
        { clipPath: inset, backgroundColor: '#111111', opacity: 0 },
      ],
      { duration: 780, delay: 120, easing: EASE_IN_OUT, fill: 'forwards' },
    )
    panel.finished.then(() => doneRef.current(), () => doneRef.current())
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['Escape', 'Enter', ' '].includes(e.key)) exit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={root}
      className="intro fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden bg-[#050505] text-white select-none"
      onClick={exit}
      data-phase={phase}
      data-testid="intro"
    >
      <div className="intro-glow pointer-events-none absolute size-[min(110vw,620px)] rounded-full" aria-hidden="true" />
      <div ref={logo} className="relative grid place-items-center">
        <svg className="intro-ring absolute size-[min(86vw,400px)]" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="48" fill="none" stroke="#FCC014" strokeWidth="0.8" strokeLinecap="round" pathLength="100" />
        </svg>
        <img
          src={`${import.meta.env.BASE_URL}brand/logo-splash.webp`}
          width={320}
          height={320}
          alt="Bite & Sip College Café"
          className="intro-logo size-[min(72vw,320px)] rounded-full"
          draggable={false}
        />
      </div>
      <p className="intro-tagline mt-8 text-center text-sm font-bold tracking-[0.3em] text-white/80 uppercase">
        Order from your seat
      </p>
      <div className="intro-bar mt-5 h-1 w-28 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
        <span className="block h-full w-1/3 rounded-full bg-brand" />
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          exit()
        }}
        className="intro-skip absolute right-4 bottom-[max(1.25rem,env(safe-area-inset-bottom))] rounded-full px-4 py-2 text-xs font-bold tracking-wider text-white/60 uppercase hover:text-white focus-visible:text-white"
      >
        Skip
      </button>
      <span className="sr-only" role="status">Loading Bite &amp; Sip…</span>
    </div>
  )
}
