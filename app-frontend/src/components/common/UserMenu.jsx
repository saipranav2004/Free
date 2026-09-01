import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import clsx from 'clsx'
import {
  Settings as SettingsIcon,
  ShieldCheck,
  ShieldAlert,
  HelpCircle,
  ChevronRight,
  Sun,
  Moon,
} from 'lucide-react'
import { mfaSummary } from '../../lib/mfaStatus'
import { useThemeStore } from '../../store/themeStore'

// ---------------------------------------------------------------------------
// Identity avatar
// ---------------------------------------------------------------------------
// Initials on a two-stop brand gradient with an inset light edge. The
// gradient is the same navy->cyan pairing the login screen uses, which is
// what ties the signed-in chrome back to the front door.
export function initialsOf(name) {
  if (!name) return '-'
  const parts = String(name)
    .replace(/[._@-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) return '-'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// Round, not rounded-rect. A circle is what every console uses for a person
// and a squircle for an application or a tenant, so the shape alone says which
// kind of thing this is before the initials are read.
const AVATAR_SIZES = {
  sm: 'h-7 w-7 rounded-full text-2xs',
  md: 'h-9 w-9 rounded-full text-xs',
  lg: 'h-11 w-11 rounded-full text-sm',
  xl: 'h-14 w-14 rounded-full text-base',
}

export function Avatar({ name, size = 'md', className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'flex flex-none items-center justify-center bg-gradient-to-br from-blue-600 to-sky-500',
        'font-semibold uppercase tracking-wide text-white shadow-sm ring-1 ring-inset ring-white/20',
        AVATAR_SIZES[size] || AVATAR_SIZES.md,
        className
      )}
    >
      {initialsOf(name)}
    </span>
  )
}

// Highest-privilege role wins the trigger badge, root outranks admin
// outranks everything else. Showing three badges in the topbar is noise;
// the full set lives in the dropdown header.
// The role badge is NOT shown on the trigger. A saturated "ROOT" chip in the
// navbar is the loudest thing on a screen whose job is to be calm, and it
// tells the signed-in user something they already know. Okta, CyberArk, the
// AWS console and Google Cloud all do the same: avatar and name in the bar,
// full role detail one click away in the menu. Kept as a helper because the
// dropdown header still orders roles by privilege.
// The word shown on the role line. "Administrator" rather than "admin",
// because the header is addressed to a person, not to the API.
const ROLE_TITLE = {
  root: 'Root',
  admin: 'Administrator',
  user: 'Standard user',
}

function primaryRole(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return null
  if (roles.includes('root')) return 'root'
  if (roles.includes('admin')) return 'admin'
  return roles[0]
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------
// THE MENU HAS NO INTERNAL DIVIDERS ANY MORE, and that is the whole change.
//
// It used to be four compartments stacked behind three horizontal rules: an
// identity block, a filled role chip that spanned the full width, a bordered
// posture strip, a settings well, and a red sign-out well. Five containers to
// hold four facts. Every rule drew another edge, so a panel about one person
// read as a stack of unrelated boxes.
//
// What replaces the rules is SPACE. One card, one border, and generous
// padding between three groups: who you are, what you can do, and the way out.
// The only edge that ever appears is the soft tint under the row your pointer
// is on, which is the one edge that means something.
//
// Rows are uniform: a muted glyph, a label, and an optional trailing slot for
// either the current value or a chevron. Uniform rows are what let a menu grow
// without being redesigned, and they are why this one can absorb the theme
// control below without gaining a compartment.
function MenuRow({ to, onClick, icon: Icon, children, value, chevron = false, tone }) {
  const className = clsx(
    'group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors duration-150',
    'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
    'text-primary hover:bg-hover'
  )

  const inner = (
    <>
      <Icon
        className={clsx('h-[1.05rem] w-[1.05rem] flex-none', tone || 'text-tertiary')}
        strokeWidth={1.75}
      />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {value && <span className="flex-none text-xs text-tertiary">{value}</span>}
      {chevron && (
        <ChevronRight
          className="h-4 w-4 flex-none text-ink-600 transition-transform duration-150 group-hover:translate-x-0.5"
          strokeWidth={1.75}
        />
      )}
    </>
  )

  if (to) {
    return (
      <NavLink to={to} role="menuitem" onClick={onClick} className={className}>
        {inner}
      </NavLink>
    )
  }
  return (
    <button type="button" role="menuitem" onClick={onClick} className={className}>
      {inner}
    </button>
  )
}

// Role as a WORD, not a filled pill. The pill was a saturated, full-width
// block sitting directly under the person's name, which made the loudest
// element in a panel about identity the one fact the reader already knew. The
// colour survives on the text, where it still separates root from admin at a
// glance and costs no area.
const ROLE_TONE = {
  root: 'text-purple-700 dark:text-purple-300',
  admin: 'text-blue-700 dark:text-blue-300',
  user: 'text-secondary',
}

// ---------------------------------------------------------------------------
// Topbar profile control
// ---------------------------------------------------------------------------
// Trigger is the avatar alone. No chevron: a caret beside a photo reads as a
// form control rather than an identity, and every console of this class does
// the same.
export function UserMenu({ user, roles = [], onLogout, loading = false, mfa }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const triggerRef = useRef(null)

  const theme = useThemeStore((st) => st.theme)
  const toggleTheme = useThemeStore((st) => st.toggleTheme)

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onPointerDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  const name = user?.username || (loading ? '…' : 'Signed in')
  // Security posture, as mfaStatus computed it. Enrolment and session
  // verification are different facts and this line never conflates them: a
  // session can be marked verified on an account that holds no second factor.
  const posture = mfaSummary(mfa)
  const role = primaryRole(roles)
  const PostureIcon =
    posture.tone === 'emerald' ? ShieldCheck : posture.tone === 'amber' ? ShieldAlert : HelpCircle
  const postureTone =
    posture.tone === 'emerald'
      ? 'text-emerald-600 dark:text-emerald-400'
      : posture.tone === 'amber'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-tertiary'
  const needsMfa = mfa?.loaded && !mfa.enabled

  return (
    <div ref={wrapRef} className="relative flex-none">
      {/* JUST THE AVATAR.
          The bar used to carry the avatar AND the username AND a bordered
          well around both, which is three ways of saying one thing in the most
          crowded strip of the page. Who you are signed in as is not something
          you need restated at all times; it is something you need to be able
          to CHECK, which is one click away and now has room to answer
          properly. The accessible name still carries the username. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${name}`}
        title={name}
        className={clsx(
          'flex h-10 w-10 items-center justify-center rounded-full transition-colors duration-150',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          open ? 'ring-2 ring-accent/40' : 'hover:opacity-90'
        )}
      >
        <Avatar name={user?.username} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="animate-menu-in absolute right-0 z-50 mt-2 w-[20.5rem] overflow-hidden rounded-2xl border border-line bg-surface shadow-overlay"
        >
          {/* SIGN OUT LIVES AT THE TOP, opposite the tenant name. It was a red
              block at the bottom in a compartment of its own, which gave the
              most destructive control in the menu the most visual weight and
              ended the panel on an alarm. Up here it is a quiet text control
              in the corner people already look at to confirm which account
              and which tenant they are in, which is exactly the moment
              somebody decides to leave. */}
          <div className="flex items-center gap-3 px-4 pb-1 pt-3.5">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
              Deep Algorithms
            </p>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onLogout?.()
              }}
              className="flex-none rounded-md px-1 py-0.5 text-sm text-secondary outline-none transition-colors hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Sign out
            </button>
          </div>

          {/* Identity. The avatar carries the weight so the type does not have
              to, which is why the name can stay at body size. */}
          <div className="flex items-start gap-3.5 px-4 pb-4 pt-3">
            <Avatar name={user?.username} size="xl" />
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="truncate text-[0.95rem] font-semibold leading-tight text-primary">
                {user?.full_name || user?.username || '-'}
              </p>
              <p className="mt-1 truncate text-[0.8125rem] leading-tight text-tertiary">
                {user?.email || '-'}
              </p>
              {/* NO SEPARATOR CHARACTER between these two. A middle dot works
                  on one line and orphans itself at the end of the first when
                  the line wraps, which "Standard user" does at this width and
                  "Root" does not. Spacing separates them at any length, and
                  the pair already differ in weight and colour. */}
              <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs leading-none">
                {role && (
                  <>
                    <span className={clsx('font-semibold', ROLE_TONE[role] || 'text-secondary')}>
                      {ROLE_TITLE[role] || role}
                    </span>
                    {roles.length > 1 && (
                      <span className="text-tertiary">+{roles.length - 1} more</span>
                    )}
                  </>
                )}
                <NavLink
                  to="/settings"
                  onClick={() => setOpen(false)}
                  className="rounded text-accent outline-none transition-colors hover:text-accent-hover hover:underline focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  View account
                </NavLink>
              </p>
            </div>
          </div>

          {/* Three uniform rows. Posture first because it is the only one that
              can be wrong, appearance second because it is the one people
              reach for most, settings last because it is the way out to
              everything else. */}
          <div className="p-2 pt-0">
            <MenuRow
              to={needsMfa ? '/settings?tab=security' : undefined}
              onClick={needsMfa ? () => setOpen(false) : undefined}
              icon={PostureIcon}
              tone={postureTone}
              chevron={!!needsMfa}
              value={needsMfa ? 'Set up' : undefined}
            >
              {posture.label}
            </MenuRow>

            {/* THE APPEARANCE CONTROL MOVED HERE FROM THE TOP BAR, and this is
                the deduplication: it was a standalone moon button in the
                navbar AND a segmented control in Settings > Appearance, so the
                same preference had two homes and the busiest strip of the page
                carried one of them. Settings keeps the full control, since
                that is where preferences live. The navbar gives its slot back
                to search, notifications and identity. */}
            <MenuRow
              icon={theme === 'dark' ? Moon : Sun}
              onClick={toggleTheme}
              value={theme === 'dark' ? 'Dark' : 'Light'}
            >
              Appearance
            </MenuRow>

            <MenuRow to="/settings" icon={SettingsIcon} onClick={() => setOpen(false)} chevron>
              Settings
            </MenuRow>
          </div>
        </div>
      )}
    </div>
  )
}
