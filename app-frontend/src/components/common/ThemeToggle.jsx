import { Sun, Moon } from 'lucide-react'
import clsx from 'clsx'
import { useThemeStore } from '../../store/themeStore'

const OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

// THE COMPACT TOPBAR BUTTON IS GONE. Appearance had two controls, this one in
// the navbar and the segmented control below in Settings, and one preference
// with two homes puts the busiest strip of the page to work saying something
// that was already said. The row now lives in the profile menu (see
// UserMenu.jsx), which is where the rest of the signed-in account's own
// settings are, and this file keeps only the canonical Settings control.
//
// Deleted rather than left exported: an unused export invites the next person
// to reintroduce the duplicate.

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
