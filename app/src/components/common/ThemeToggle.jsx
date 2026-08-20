import { Sun, Moon } from 'lucide-react'
import clsx from 'clsx'
import { useThemeStore } from '../../store/themeStore'

const OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

// Topbar control: one button that flips light <-> dark. Two modes means a
// single toggle is unambiguous, the icon shows the mode you'll get, the
// tooltip says it in words.
export function ThemeToggle({ compact = false }) {
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggleTheme)
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const Icon = theme === 'dark' ? Sun : Moon

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={`Switch to ${nextTheme} appearance`}
      aria-label={`Switch to ${nextTheme} appearance`}
      className={clsx(
        'inline-flex flex-none select-none items-center justify-center font-medium transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        compact
          ? 'h-9 w-9 rounded-lg text-ink-400 hover:bg-surface-800 hover:text-ink-50'
          : 'h-9 gap-2 rounded-lg border border-surface-700 bg-surface-900 px-3 text-xs text-ink-200 hover:border-surface-600 hover:bg-surface-850'
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={1.75} />
      {!compact && (theme === 'dark' ? 'Dark' : 'Light')}
    </button>
  )
}

// Settings > Appearance control: both modes visible at once, current one
// selected. No "system" option, see themeStore for why.
export function ThemeSegmented({ className = '' }) {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className={clsx(
        'inline-flex items-center gap-1 rounded-xl border border-surface-700 bg-surface-800 p-1',
        className
      )}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = theme === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(value)}
            className={clsx(
              'inline-flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors duration-150',
              'outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
              active
                ? 'bg-surface-900 text-ink-50 ring-1 ring-inset ring-surface-700'
                : 'text-ink-400 hover:text-ink-100'
            )}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            {label}
          </button>
        )
      })}
    </div>
  )
}
