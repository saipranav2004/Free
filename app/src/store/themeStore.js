import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Light / dark theme
// ---------------------------------------------------------------------------
// Two modes only. The old third mode ("system") was removed from the theme
// control: an enterprise console's appearance setting reads better as a
// binary the operator owns than as a tri-state where the current appearance
// depends on an OS preference the console can't show. The OS preference is
// still respected, but only as the *initial* value for someone who has
// never chosen, after which their choice sticks.
//
// Persisted to localStorage (not sessionStorage like authStore) deliberately:
// a UI preference like "I use light mode" carries no security sensitivity ,
// unlike a bearer token, there is nothing here worth shrinking the exposure
// window for.
const STORAGE_KEY = 'pam_theme'
const VALID = new Set(['light', 'dark'])

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

// Legacy values (including the retired 'system') resolve to a concrete
// light/dark value rather than throwing the preference away.
function readPersisted() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (VALID.has(v)) return { theme: v, explicit: true }
  } catch {
    /* private-browsing / locked-down profile, fall through to OS default */
  }
  return { theme: systemPrefersDark() ? 'dark' : 'light', explicit: false }
}

function applyToDocument(isDark) {
  const root = document.documentElement
  root.classList.toggle('dark', isDark)
  // Keeps native form controls (checkboxes, scrollbars in some browsers)
  // and the browser's own UI chrome in sync with the resolved theme.
  root.style.colorScheme = isDark ? 'dark' : 'light'
}

const initial = readPersisted()
if (typeof document !== 'undefined') applyToDocument(initial.theme === 'dark')

export const useThemeStore = create((set, get) => ({
  theme: initial.theme, // 'light' | 'dark'
  isDark: initial.theme === 'dark',
  // True once the user has actually picked a theme in this browser. Until
  // then we keep following the OS.
  explicit: initial.explicit,

  setTheme: (theme) => {
    if (!VALID.has(theme)) return
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* non-fatal, the choice still applies for this session */
    }
    applyToDocument(theme === 'dark')
    set({ theme, isDark: theme === 'dark', explicit: true })
  },

  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}))

// Back-compat: the topbar toggle used to call cycleTheme() when there were
// three modes. Kept as an alias so nothing breaks if another caller lingers.
useThemeStore.setState({ cycleTheme: () => useThemeStore.getState().toggleTheme() })

// Follow the OS only for users who have never picked a theme here, once
// they have, flipping the OS must not silently override them.
if (typeof window !== 'undefined' && window.matchMedia) {
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    if (useThemeStore.getState().explicit) return
    const isDark = systemPrefersDark()
    applyToDocument(isDark)
    useThemeStore.setState({ theme: isDark ? 'dark' : 'light', isDark })
  }
  if (mql.addEventListener) mql.addEventListener('change', handler)
  else if (mql.addListener) mql.addListener(handler)
}
