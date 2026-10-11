import { useMemo } from 'react'
import { prefersReducedMotion } from '../lib/motion'

const COLORS = ['#FCC014', '#111111', '#FFFFFF', '#E5A800', '#12723A']

/** One-shot confetti burst centred on its (relatively positioned) parent. */
export function Confetti({ count = 26, spread = 170 }: { count?: number; spread?: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4
        const dist = spread * (0.55 + Math.random() * 0.6)
        return {
          x: `${Math.cos(angle) * dist}px`,
          y: `${Math.sin(angle) * dist - 30}px`,
          r: `${Math.round(Math.random() * 540 - 270)}deg`,
          color: COLORS[i % COLORS.length],
          delay: `${Math.round(Math.random() * 120)}ms`,
        }
      }),
    [count, spread],
  )
  if (prefersReducedMotion()) return null
  return (
    <span className="confetti pointer-events-none absolute inset-0 overflow-visible" aria-hidden="true">
      {pieces.map((p, i) => (
        <i
          key={i}
          style={{ background: p.color, animationDelay: p.delay, ['--x' as string]: p.x, ['--y' as string]: p.y, ['--r' as string]: p.r, outline: p.color === '#FFFFFF' ? '1px solid rgb(17 17 17 / 0.15)' : undefined }}
        />
      ))}
    </span>
  )
}

/** Animated check mark (circle then tick draw in). */
export function CheckBurst({ className = 'size-16' }: { className?: string }) {
  return (
    <svg className={`check-draw ${className}`} viewBox="0 0 56 56" aria-hidden="true">
      <circle cx="28" cy="28" r="25" fill="none" stroke="#12723A" strokeWidth="4" strokeLinecap="round" transform="rotate(-90 28 28)" />
      <path d="M17 29 25 37 40 20" fill="none" stroke="#12723A" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
