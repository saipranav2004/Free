import { useState } from 'react'
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { isDemo } from '../../backend'
import { IconBoard, IconChart, IconLogOut, IconMenuBook, IconSettings } from '../../components/icons'
import { Spinner, Wordmark } from '../../components/ui'
import type { StaffProfile } from '../../lib/types'
import { usePublicData } from '../../state/publicData'
import { useStaffSession } from '../../state/staffSession'

export function RequireStaff({ ownerOnly = false, children }: { ownerOnly?: boolean; children: React.ReactNode }) {
  const { profile, loading } = useStaffSession()
  const location = useLocation()
  if (loading) return <div className="grid min-h-dvh place-items-center"><Spinner label="Checking your session" /></div>
  if (!profile) return <Navigate to="/staff/login" replace state={{ from: location.pathname }} />
  if (ownerOnly && profile.role !== 'owner') return <Navigate to="/staff" replace />
  return <>{children}</>
}

const NAV = [
  { to: '/staff', label: 'Orders', icon: IconBoard, end: true, owner: false },
  { to: '/staff/menu', label: 'Menu', icon: IconMenuBook, end: false, owner: false },
  { to: '/staff/reports', label: 'Reports', icon: IconChart, end: false, owner: true },
  { to: '/staff/settings', label: 'Settings', icon: IconSettings, end: false, owner: true },
]

export function StaffLayout() {
  const { profile, signOut } = useStaffSession()
  const { data } = usePublicData()
  const [signingOut, setSigningOut] = useState(false)
  if (!profile) return null
  const links = NAV.filter((n) => !n.owner || profile.role === 'owner')
  const open = data?.settings.is_open

  return (
    <div className="min-h-dvh bg-sunken">
      {isDemo && (
        <div className="bg-brand px-4 py-1.5 text-center text-xs font-bold text-ink no-print">
          Demo mode — data lives in this browser only. Connect Supabase for the real café.
        </div>
      )}
      <header className="vt-header no-print sticky top-0 z-30 bg-ink text-white">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-3 px-4">
          <Wordmark onDark className="text-[15px]" />
          <span className="hidden rounded-md bg-white/10 px-2 py-0.5 text-xs font-bold sm:inline">Staff</span>
          <nav aria-label="Staff" className="ml-4 hidden items-center gap-1 md:flex">
            {links.map((n) => (
              <NavItem key={n.to} {...n} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {data && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${open ? 'bg-ready text-white' : 'bg-danger text-white'}`}
                title={open ? 'Taking orders' : 'Closed for orders'}
              >
                <span className="size-1.5 rounded-full bg-white" aria-hidden="true" />
                {open ? 'Open' : 'Closed'}
              </span>
            )}
            <ProfileChip profile={profile} />
            <button
              type="button"
              className="grid size-10 place-items-center rounded-full hover:bg-white/10"
              aria-label="Sign out"
              title="Sign out"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true)
                await signOut()
              }}
            >
              <IconLogOut size={18} />
            </button>
          </div>
        </div>
        <nav aria-label="Staff" className="flex gap-1 overflow-x-auto border-t border-white/10 px-2 py-1.5 md:hidden">
          {links.map((n) => (
            <NavItem key={n.to} {...n} />
          ))}
        </nav>
      </header>
      <Outlet />
    </div>
  )
}

function NavItem({ to, label, icon: Icon, end }: { to: string; label: string; icon: typeof IconBoard; end: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      viewTransition
      className={({ isActive }) =>
        `inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-bold transition-colors ${
          isActive ? 'bg-brand text-ink' : 'text-white/80 hover:bg-white/10 hover:text-white'
        }`
      }
    >
      <Icon size={17} />
      {label}
    </NavLink>
  )
}

function ProfileChip({ profile }: { profile: StaffProfile }) {
  return (
    <span className="hidden text-right leading-tight lg:block">
      <span className="block text-sm font-bold">{profile.display_name}</span>
      <span className="block text-xs text-white/60 capitalize">{profile.role}</span>
    </span>
  )
}
