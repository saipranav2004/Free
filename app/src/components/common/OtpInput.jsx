import { useEffect, useMemo, useRef } from 'react'
import clsx from 'clsx'

// ---------------------------------------------------------------------------
// OtpInput, exactly six digits, six boxes
// ---------------------------------------------------------------------------
// Replaces the single free-text field that accepted up to EIGHT characters.
// A TOTP code from any authenticator this backend supports is six digits;
// accepting eight meant the field would happily hold an unsubmittable value
// and the Verify button stayed enabled on a code that could never be right.
//
// The length rule lives HERE, not in each caller: `length` defaults to 6, the
// value is clamped to it, and `onComplete` fires exactly once per full code.
// Every MFA surface in the console (sign-in challenge, enrolment confirm)
// mounts this same component, so the two can't drift apart again.
//
// Behaviour matches what people expect from an OTP field in Okta/Entra:
// type to advance, Backspace on an empty box steps back and clears, arrows
// move, paste fills from wherever you paste, non-digits are dropped rather
// than rejected with an error, and the whole thing is one tab stop.
// `tone` exists because the two surfaces this mounts on are genuinely
// different planes: the console (themed surface-*/ink-* tokens) and the
// sign-in/verification brand surface, which is a fixed white card on navy and
// must look identical regardless of the viewer's theme. Without this, a user
// with dark mode on gets dark boxes on a white card.
const TONES = {
  console: {
    base: 'h-[3.25rem] w-full rounded-xl border bg-surface-800 text-center font-mono text-xl font-semibold tabular-nums text-ink-50 shadow-sm',
    invalid: 'border-red-500/70 focus:border-red-500 focus:ring-red-500/20',
    filled: 'border-blue-500/45 focus:border-blue-500 focus:ring-blue-500/20',
    empty: 'border-surface-700 hover:border-surface-600 focus:border-blue-500 focus:ring-blue-500/20',
  },
  brand: {
    base: 'h-[3.5rem] w-full rounded-xl border bg-white text-center font-mono text-[1.4rem] font-semibold tabular-nums text-slate-900 shadow-[0_1px_2px_rgb(15_23_42/0.05)]',
    invalid: 'border-red-400 focus:border-red-500 focus:ring-red-500/15',
    filled: 'border-[#29A8E0]/70 focus:border-[#29A8E0] focus:ring-[#29A8E0]/20',
    empty: 'border-slate-200 hover:border-slate-300 focus:border-[#29A8E0] focus:ring-[#29A8E0]/20',
  },
}

export function OtpInput({
  value = '',
  onChange,
  onComplete,
  length = 6,
  disabled = false,
  invalid = false,
  autoFocus = false,
  ariaLabel = 'Verification code',
  tone = 'console',
  id,
}) {
  const t = TONES[tone] || TONES.console
  const refs = useRef([])
  const digits = useMemo(() => {
    const clean = String(value || '')
      .replace(/\D/g, '')
      .slice(0, length)
    return Array.from({ length }, (_, i) => clean[i] || '')
  }, [value, length])

  const filled = digits.filter(Boolean).length

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus()
  }, [autoFocus])

  // Fire onComplete on the transition into "full", not on every render at
  // full length, otherwise a failed code that stays in the boxes would
  // resubmit itself on the next unrelated re-render.
  const completedFor = useRef(null)
  useEffect(() => {
    const code = digits.join('')
    if (code.length === length && completedFor.current !== code) {
      completedFor.current = code
      onComplete?.(code)
    }
    if (code.length < length) completedFor.current = null
  }, [digits, length, onComplete])

  const commit = (next, focusIndex) => {
    onChange?.(next.slice(0, length))
    if (focusIndex !== undefined) {
      const i = Math.max(0, Math.min(length - 1, focusIndex))
      requestAnimationFrame(() => {
        refs.current[i]?.focus()
        refs.current[i]?.select?.()
      })
    }
  }

  const handleChange = (i, raw) => {
    const typed = raw.replace(/\D/g, '')
    if (!typed) return
    // Typing into a box overwrites that position; a multi-character burst
    // (fast typing, autofill, mobile OTP suggestion) fills forward.
    const next = digits.slice()
    for (let k = 0; k < typed.length && i + k < length; k++) next[i + k] = typed[k]
    commit(next.join(''), i + typed.length)
  }

  const handleKeyDown = (i, e) => {
    if (e.key === 'Backspace') {
      e.preventDefault()
      const next = digits.slice()
      if (next[i]) {
        next[i] = ''
        commit(next.join(''), i)
      } else {
        next[Math.max(0, i - 1)] = ''
        commit(next.join(''), i - 1)
      }
      return
    }
    if (e.key === 'Delete') {
      e.preventDefault()
      const next = digits.slice()
      next[i] = ''
      commit(next.join(''), i)
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      refs.current[Math.max(0, i - 1)]?.focus()
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      refs.current[Math.min(length - 1, i + 1)]?.focus()
    }
  }

  const handlePaste = (i, e) => {
    const text = (e.clipboardData?.getData('text') || '').replace(/\D/g, '')
    if (!text) return
    e.preventDefault()
    const next = digits.slice()
    for (let k = 0; k < text.length && i + k < length; k++) next[i + k] = text[k]
    commit(next.join(''), i + text.length)
  }

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex items-center gap-2 sm:gap-2.5"
      onClick={() => {
        if (!disabled) refs.current[Math.min(filled, length - 1)]?.focus()
      }}
    >
      {digits.map((d, i) => (
        <div key={i} className="relative flex-1">
          <input
            id={i === 0 ? id : undefined}
            ref={(el) => (refs.current[i] = el)}
            type="text"
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            pattern="[0-9]*"
            maxLength={length}
            disabled={disabled}
            value={d}
            aria-label={`Digit ${i + 1} of ${length}`}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={(e) => handlePaste(i, e)}
            onFocus={(e) => e.target.select()}
            className={clsx(
              t.base,
              'transition-[border-color,box-shadow,background-color] duration-150',
              'focus:outline-none focus:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
              invalid ? t.invalid : d ? t.filled : t.empty
            )}
          />
        </div>
      ))}
    </div>
  )
}

// The one place that decides whether a code is submittable. Callers use it
// for the submit button's disabled state so "looks complete" and "will be
// accepted" are the same condition.
export function isCompleteOtp(code, length = 6) {
  return new RegExp(`^\\d{${length}}$`).test(String(code || ''))
}
