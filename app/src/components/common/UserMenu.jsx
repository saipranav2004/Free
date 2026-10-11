import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import clsx from 'clsx'
import {
  LogOut,
  Settings as SettingsIcon,
  UserRound,
  ShieldCheck,
  ShieldAlert,
  HelpCircle,
  ChevronDown,
} from 'lucide-react'
import { ROLE_BADGE } from '../../config/constants'
import { mfaSummary } from '../../lib/mfaStatus'

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

const AVATAR_SIZES = {
  sm: 'h-7 w-7 rounded-lg text-2xs',
  md: 'h-8 w-8 rounded-lg text-xs',
  lg: 'h-10 w-10 rounded-xl text-sm',
  xl: 'h-14 w-14 rounded-2xl text-base',
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
function primaryRole(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return null
  if (roles.includes('root')) return 'root'
  if (roles.includes('admin')) return 'admin'
  return roles[0]
}

function MenuItem({ to, onClick, icon: Icon, children, danger = false }) {
  const className = clsx(
    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.8125rem] font-medium transition-colors duration-150',
    'outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
    danger
      ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30'
      : 'text-ink-200 hover:bg-surface-800 hover:text-ink-50'
  )
  const glyph = <Icon className={clsx('h-4 w-4 flex-none', danger ? '' : 'text-ink-500')} strokeWidth={1.6} />
  if (to) {
    return (
      <NavLink to={to} role="menuitem" onClick={onClick} className={className}>
        {glyph}
        {children}
      </NavLink>
    )
  }
  return (
    <button type="button" role="menuitem" onClick={onClick} className={className}>
      {glyph}
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Topbar profile control
// ---------------------------------------------------------------------------
// Trigger: avatar + username + role badge. No chevron, the avatar itself is
// the affordance every enterprise console uses, and a caret next to a photo
// reads as a form control rather than an identity.
export function UserMenu({ user, roles = [], onLogout, loading = false, mfa }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const triggerRef = useRef(null)

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
  // Security posture, stated the way mfaStatus computed it, enrolment and
  // session verification are different facts and this line never conflates
  // them (a session can be marked verified on an account with no MFA).
  const posture = mfaSummary(mfa)

  return (
    <div ref={wrapRef} className="relative flex-none">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={clsx(
          'flex h-10 items-center gap-2.5 rounded-xl border pl-1.5 pr-2 transition-colors duration-150',
          'outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
          open
            ? 'border-surface-600 bg-surface-800'
            : 'border-transparent hover:border-surface-700 hover:bg-surface-850'
        )}
      >
        <Avatar name={user?.username} />
        <span className="hidden max-w-[10rem] truncate text-[0.8125rem] font-medium text-ink-100 sm:block">
          {name}
        </span>
        {/* <ChevronDown
 className={clsx(
            'hidden h-3.5 w-3.5 flex-none text-ink-500 transition-transform duration-200 sm:block',
 open && 'rotate-180'
          )}
 strokeWidth={2}
 aria-hidden="true"
        /> */}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="animate-menu-in absolute right-0 z-50 mt-2 w-[17.5rem] overflow-hidden rounded-2xl border border-surface-700 bg-surface-900 shadow-overlay"
        >
          <div className="flex items-start gap-3 border-b border-surface-800 bg-surface-850/60 px-4 py-3.5">
            <Avatar name={user?.username} size="lg" />
            <div className="min-w-0 pt-0.5">
              <p className="truncate text-sm font-semibold text-ink-50">{user?.username || '-'}</p>
              <p className="mt-0.5 truncate text-xs text-ink-500">{user?.email || '-'}</p>
              {roles.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {roles.map((r) => (
                    <span
                      key={r}
                      className={clsx(
                        'rounded px-1.5 py-0.5 text-2xs font-semibold ring-1 ring-inset',
                        ROLE_BADGE[r] || ROLE_BADGE.user
                      )}
                    >
                      {r}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Session posture, not decoration: whether this session cleared
              MFA decides whether vault reveals will succeed, so it belongs
 where the user checks who they're signed in as. */}
          <div className="flex items-center gap-2 border-b border-surface-800 px-4 py-2.5">
            {posture.tone === 'emerald' ? (
              <ShieldCheck
                className="h-3.5 w-3.5 flex-none text-emerald-600 dark:text-emerald-400"
                strokeWidth={1.75}
              />
            ) : posture.tone === 'amber' ? (
              <ShieldAlert
                className="h-3.5 w-3.5 flex-none text-amber-600 dark:text-amber-400"
                strokeWidth={1.75}
              />
            ) : (
              <HelpCircle className="h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
            )}
            <span className="text-xs text-ink-400">{posture.label}</span>
            {mfa?.loaded && !mfa.enabled && (
              <NavLink
                to="/settings?tab=security"
                onClick={() => setOpen(false)}
                className="ml-auto text-xs font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
              >
                Set up
              </NavLink>
            )}
          </div>

          <div className="p-1.5">
            {/* <MenuItem to="/settings?tab=account" icon={UserRound} onClick={() => setOpen(false)}>
              Profile
            </MenuItem> */}
            <MenuItem to="/settings" icon={SettingsIcon} onClick={() => setOpen(false)}>
              Settings
            </MenuItem>
          </div>
          <div className="border-t border-surface-800 p-1.5">
            <MenuItem
              icon={LogOut}
              danger
              onClick={() => {
                setOpen(false)
                onLogout?.()
              }}
            >
              Sign out
            </MenuItem>
          </div>
        </div>
      )}
    </div>
  )
}
