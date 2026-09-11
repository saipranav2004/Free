import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Bell, KeyRound, Clock, ShieldCheck, UsersRound } from 'lucide-react'
import { listMyJitRequests, listMyGrants } from '../../api/jit'
import { listJitRequests } from '../../api/admin'
import { JIT_STATUS } from '../../config/constants'

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
// Built from data the backend actually has, not from an invented
// notifications feed: there is no notifications endpoint and no push channel,
// so this derives the three things that are genuinely time-sensitive in a PAM
// console from existing list endpoints ,
//   1. JIT requests waiting on YOU to approve (admins/root only)
//   1b. …and, since four-eyes, the ones that already have ONE approval and
// need a second, different admin. These are separated because they are
// the fastest to clear, one click from live access, and because a
// combined count would tell an admin nothing about which is which.
//   2. YOUR requests still waiting on an approver
//   3. YOUR active grants about to expire
// Polled on a slow interval (60s) for the same reason SESSIONS_POLL_MS
// exists: no server push.
const POLL_MS = 60000
const EXPIRING_SOON_MS = 30 * 60 * 1000

function minutesUntil(iso) {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.round((t - Date.now()) / 60000)
}

function relative(mins) {
  if (mins === null) return ''
  if (mins <= 0) return 'now'
  if (mins < 60) return `in ${mins}m`
  const h = Math.floor(mins / 60)
  return `in ${h}h ${mins % 60}m`
}

export function NotificationsMenu({ isAdmin = false }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
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

  // retry:false throughout, a topbar bell must never turn a permissions or
  // network hiccup into a retry storm or a visible error; it just shows
  // nothing.
  const approvals = useQuery({
    queryKey: ['notifications', 'admin-jit-pending'],
    queryFn: ({ signal }) => listJitRequests({ status: 'PENDING', page: 1, page_size: 5 }, signal),
    enabled: isAdmin,
    refetchInterval: POLL_MS,
    retry: false,
  })

  const secondApprovals = useQuery({
    queryKey: ['notifications', 'admin-jit-partial'],
    queryFn: ({ signal }) =>
      listJitRequests({ status: JIT_STATUS.PARTIALLY_APPROVED, page: 1, page_size: 5 }, signal),
    enabled: isAdmin,
    refetchInterval: POLL_MS,
    retry: false,
  })

  const myRequests = useQuery({
    queryKey: ['notifications', 'my-jit-pending'],
    queryFn: ({ signal }) => listMyJitRequests({ status: 'PENDING', pageSize: 5, signal }),
    refetchInterval: POLL_MS,
    retry: false,
  })

  const myGrants = useQuery({
    queryKey: ['notifications', 'my-grants-active'],
    queryFn: ({ signal }) => listMyGrants({ activeOnly: true, pageSize: 25, signal }),
    refetchInterval: POLL_MS,
    retry: false,
  })

  const items = useMemo(() => {
    const out = []

    const pendingApprovals = approvals.data?.pagination?.total ?? approvals.data?.requests?.length ?? 0
    if (isAdmin && pendingApprovals > 0) {
      out.push({
        id: 'approvals',
        icon: KeyRound,
        tone: 'amber',
        title: `${pendingApprovals} JIT request${pendingApprovals === 1 ? '' : 's'} awaiting approval`,
        meta: 'Admin Center · JIT Approvals',
        to: '/admin/jit',
      })
    }

    const needSecond = secondApprovals.data?.pagination?.total ?? secondApprovals.data?.requests?.length ?? 0
    if (isAdmin && needSecond > 0) {
      out.push({
        id: 'second-approvals',
        icon: UsersRound,
        tone: 'blue',
        title: `${needSecond} request${needSecond === 1 ? '' : 's'} need${needSecond === 1 ? 's' : ''} a second approval`,
        meta: 'Four-eyes · one approval already given',
        to: '/admin/jit',
      })
    }

    const mine = myRequests.data?.pagination?.total ?? myRequests.data?.requests?.length ?? 0
    if (mine > 0) {
      out.push({
        id: 'mine',
        icon: Clock,
        tone: 'blue',
        title: `${mine} of your request${mine === 1 ? '' : 's'} pending approval`,
        meta: 'JIT Access · My requests',
        to: '/jit',
      })
    }

    const grants = myGrants.data?.grants || []
    const expiring = grants
      .map((g) => ({ g, mins: minutesUntil(g.expires_at) }))
      .filter(({ mins }) => mins !== null && mins * 60000 <= EXPIRING_SOON_MS && mins >= 0)
      .sort((a, b) => a.mins - b.mins)
    if (expiring.length > 0) {
      const soonest = expiring[0]
      out.push({
        id: 'expiring',
        icon: Clock,
        tone: 'red',
        title:
          expiring.length === 1
            ? `Access expires ${relative(soonest.mins)}`
            : `${expiring.length} grants expire within 30 minutes`,
        meta: soonest.g.resource_name || soonest.g.resource_id || 'JIT Access · Grants',
        to: '/jit',
      })
    }

    return out
  }, [approvals.data, secondApprovals.data, myRequests.data, myGrants.data, isAdmin])

  const count = items.length

  return (
    <div ref={wrapRef} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={count > 0 ? `Notifications (${count})` : 'Notifications'}
        title="Notifications"
        className={clsx(
          'relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-150',
          'outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
          open ? 'bg-surface-800 text-ink-50' : 'text-ink-400 hover:bg-surface-800 hover:text-ink-50'
        )}
      >
        <Bell className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.5} />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 flex h-2 w-2 rounded-full bg-amber-500 ring-2 ring-surface-900"
          />
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="animate-menu-in absolute right-0 z-50 mt-2 w-[20rem] overflow-hidden rounded-2xl border border-surface-700 bg-surface-900 shadow-overlay"
        >
          <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
            <p className="text-sm font-semibold text-ink-50">Notifications</p>
            {count > 0 && (
              <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-2xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30">
                {count} to action
              </span>
            )}
          </div>

          {count === 0 ? (
            <div className="flex flex-col items-center px-6 py-9 text-center">
              <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-surface-700 bg-surface-850 text-ink-400">
                <ShieldCheck className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.5} />
              </span>
              <p className="text-sm font-medium text-ink-100">Nothing needs you</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                Pending approvals and expiring access appear here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-surface-800">
              {items.map((it) => (
                <li key={it.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false)
                      navigate(it.to)
                    }}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-850"
                  >
                    <span
                      className={clsx(
                        'mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg ring-1 ring-inset',
                        it.tone === 'amber' &&
                          'bg-amber-50 text-amber-600 ring-amber-600/15 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25',
                        it.tone === 'red' &&
                          'bg-red-50 text-red-600 ring-red-600/15 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25',
                        it.tone === 'blue' &&
                          'bg-blue-50 text-blue-600 ring-blue-600/15 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/25'
                      )}
                    >
                      <it.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[0.8125rem] font-medium leading-snug text-ink-100">
                        {it.title}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-ink-500">{it.meta}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-surface-800 bg-surface-850/60 px-4 py-2 text-2xs text-ink-500">
            Derived from live JIT data · refreshed every minute
          </div>
        </div>
      )}
    </div>
  )
}
