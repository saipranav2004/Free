import clsx from 'clsx'

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------
// TWO different things, deliberately kept apart, because using one for both
// is what made the dark theme unreadable.
//
//   StatusIndicator, for STATE that every row has (Active/Inactive, Standing/
//     JIT, Attached/None). A dot plus plain text. No fill, no ring, no
// uppercase. This is what AWS Console, Google Cloud and Okta all use for
// per-row state, and the reason is arithmetic: a table of 25 rows with a
// filled pill in three columns is 75 saturated blocks competing with the
// data. In dark mode those pills glow, and the eye is pulled to the
// decoration instead of the content, which is exactly the complaint.
//
//   Badge, for EXCEPTIONS and classifications you want to catch the eye:
// a DENIED outcome, a CRITICAL severity, a deny policy. Rare by nature,
// so a filled chip is right; if everything is a badge, nothing is.
//
// Rule of thumb applied across the console: if the column is populated on
// every row, it is an indicator. If it marks the few rows that differ, it is
// a badge.

const TONE_DOT = {
  emerald: 'bg-emerald-500',
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  // Muted states get a hollow ring rather than a filled dot, "off" should
  // not have the same visual weight as "on".
  neutral: 'bg-transparent ring-1 ring-inset ring-ink-500',
}

const TONE_TEXT = {
  emerald: 'text-emerald-700 dark:text-emerald-400',
  red: 'text-red-700 dark:text-red-400',
  amber: 'text-amber-700 dark:text-amber-400',
  blue: 'text-blue-700 dark:text-blue-400',
  violet: 'text-violet-700 dark:text-violet-400',
  neutral: 'text-ink-400',
}

export function StatusIndicator({ tone = 'neutral', children, className, title, pulse = false }) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium',
        TONE_TEXT[tone] || TONE_TEXT.neutral,
        className
      )}
    >
      <span className="relative flex h-1.5 w-1.5 flex-none">
        {pulse && (
          <span
            aria-hidden="true"
            className={clsx(
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
              TONE_DOT[tone]
            )}
          />
        )}
        <span
          aria-hidden="true"
          className={clsx(
            'relative inline-flex h-1.5 w-1.5 rounded-full',
            TONE_DOT[tone] || TONE_DOT.neutral
          )}
        />
      </span>
      {children}
    </span>
  )
}

// Reserved for exceptions, see the note above. Uppercase, tight tracking,
// hairline ring rather than a solid fill so it stays legible on both themes.
export function Badge({ children, className, dot = false }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
        className || 'bg-ink-500/10 text-ink-400 ring-ink-500/25'
      )}
    >
      {dot && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  )
}

// A quiet classification chip: type, category, group. Carries no judgement,
// so it carries no colour, it is a label, not a status.
export function MetaTag({ children, className, mono = false }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center whitespace-nowrap rounded border border-surface-700 bg-surface-850 px-1.5 py-0.5 text-2xs font-medium text-ink-400',
        mono && 'font-mono',
        className
      )}
    >
      {children}
    </span>
  )
}
