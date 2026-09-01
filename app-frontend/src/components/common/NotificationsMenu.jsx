import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck } from 'lucide-react'
import clsx from 'clsx'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
} from '../../api/notifications'
import { categoryIcon, severityTone, timeAgo } from '../../lib/notificationDisplay'
import { passesMutes, readMutes } from '../../lib/notificationPrefs'
import { describeNotificationError } from '../../lib/notificationError'

// ---------------------------------------------------------------------------
// The bell
// ---------------------------------------------------------------------------
// REWRITTEN ONTO A REAL BACKEND. This used to run three JIT queries every 60
// seconds and assemble a list on the client, which had three consequences that
// all showed up as bug reports: nothing could be marked read, anything that
// stopped being pending disappeared without trace, and the badge only agreed
// with reality once a minute.
//
// The shape it settles on is the one AWS Console Notifications, Okta and
// ServiceNow all converge on, for reasons that hold here too:
//
//   THE PANEL IS A PREVIEW, NOT THE ARCHIVE.  It shows the most recent few and
//     sends you to the page for the rest. A panel that tries to be the archive
//     is a scrolling box that is worse than the page at the same job.
//   THE BADGE COUNTS UNREAD WORK.             Capped at 9+ because the
//     difference between 40 and 60 changes nothing a person does next.
//   OPENING IS NOT READING.                   Clicking an item marks it read,
//     because that is the moment attention was actually paid. Opening the panel
//     does not, or the badge would clear itself before anybody looked.
//   EVERY ITEM GOES SOMEWHERE.                Each row is a link to the object
//     it is about. A notification you cannot act on is an alert, and alerts
//     nobody can act on train people to ignore the bell.
//   THE PANEL RESPECTS MUTES, THE PAGE DOES NOT. Settings > Notifications lets
//     somebody quiet a category here; /notifications still shows everything,
//     because an archive with a hole in it is not one. CRITICAL and anything in
//     the Security category ignore mutes entirely. See lib/notificationPrefs.

const PREVIEW_COUNT = 6
const COUNT_POLL_MS = 30000
const LIST_POLL_MS = 60000

export function NotificationsMenu() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  // A clock, so "2m ago" becomes "3m ago" without a refresh. The data polls on
  // its own schedule; this only re-reads the timestamps already held.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

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

  // The badge is its own query: it is asked for constantly and costs one
  // indexed count, where the list costs a page of rows.
  const countQuery = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: ({ signal }) => unreadNotificationCount(signal),
    refetchInterval: COUNT_POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
  })

  // The list is only fetched while the panel is open, plus a slow background
  // refresh so opening it is instant rather than a spinner.
  const listQuery = useQuery({
    queryKey: ['notifications', 'preview'],
    queryFn: ({ signal }) => listNotifications({ page: 1, page_size: PREVIEW_COUNT }, signal),
    refetchInterval: open ? LIST_POLL_MS : false,
    retry: false,
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['notifications'] })
  }

  const readOne = useMutation({ mutationFn: markNotificationRead, onSuccess: refresh })
  const readAll = useMutation({ mutationFn: markAllNotificationsRead, onSuccess: refresh })

  // Read once per open rather than on every render: the value only changes on
  // another tab's Settings page, and re-reading localStorage inside a render
  // is a synchronous disk-backed call in a hot path.
  const [mutes, setMutes] = useState(() => readMutes())
  useEffect(() => {
    if (open) setMutes(readMutes())
  }, [open])
  // ...and when another tab changes them, so two open tabs do not disagree.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'pam_notification_mutes') setMutes(readMutes())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const allItems = useMemo(() => listQuery.data?.items || [], [listQuery.data])
  const items = useMemo(() => allItems.filter((i) => passesMutes(i, mutes)), [allItems, mutes])
  const hiddenByMutes = allItems.length - items.length

  // THE BADGE COUNTS WHAT THE SERVER HAS, NOT WHAT THIS PANEL SHOWS. Muting is
  // a preference about interruption, not a claim that the item did not happen,
  // and a badge that quietly stopped counting muted rows would leave "3 unread"
  // beside a panel showing one and no way to reconcile them.
  const unread = countQuery.data ?? listQuery.data?.unread_total ?? 0
  const badge = unread > 9 ? '9+' : String(unread)

  const openItem = (item) => {
    setOpen(false)
    if (!item?.read_at) readOne.mutate(item.id)
    if (item?.link) navigate(item.link)
  }

  return (
    <div ref={wrapRef} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        className={clsx(
          'relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-150',
          'text-chrome-muted hover:bg-chrome-hover hover:text-chrome-fg',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40'
        )}
      >
        <Bell className="h-[18px] w-[18px]" strokeWidth={1.75} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-[22rem] overflow-hidden rounded-xl border border-line bg-surface shadow-pop sm:w-[24rem]"
        >
          <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
            <p className="text-sm font-semibold text-primary">Notifications</p>
            {unread > 0 && (
              <span className="rounded-full bg-subtle px-1.5 py-0.5 text-2xs font-semibold text-secondary">
                {unread} unread
              </span>
            )}
            <button
              type="button"
              onClick={() => readAll.mutate()}
              disabled={unread === 0 || readAll.isPending}
              className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:text-tertiary disabled:hover:bg-transparent"
            >
              <CheckCheck className="h-3.5 w-3.5" strokeWidth={2} />
              Mark all read
            </button>
          </div>

          <div className="max-h-[26rem] overflow-y-auto">
            {listQuery.isLoading ? (
              <p className="px-4 py-8 text-center text-xs text-tertiary">Loading…</p>
            ) : listQuery.isError ? (
              /* NAMES WHAT ACTUALLY FAILED. This used to say the console could
                 not reach the notification service, which describes exactly one
                 of the ways it fails and guessed at the rest. A 404 is not
                 unreachable: it is a server that does not have the endpoint,
                 which points at a backend older than this console and is a
                 different thing to go and fix. See lib/notificationError.js. */
              <div className="px-4 py-10 text-center">
                <Bell className="mx-auto h-6 w-6 text-tertiary" strokeWidth={1.5} />
                <p className="mt-2 text-sm font-medium text-secondary">
                  {describeNotificationError(listQuery.error).title}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-tertiary">
                  {describeNotificationError(listQuery.error).detail}
                </p>
                <button
                  type="button"
                  onClick={() => listQuery.refetch()}
                  className="mt-3 rounded-md px-2 py-1 text-xs font-semibold text-accent transition-colors hover:bg-hover"
                >
                  Try again
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <Bell className="mx-auto h-6 w-6 text-tertiary" strokeWidth={1.5} />
                <p className="mt-2 text-sm font-medium text-secondary">
                  {hiddenByMutes > 0 ? 'Nothing here right now' : 'You are all caught up'}
                </p>
                <p className="mt-1 text-xs text-tertiary">
                  {hiddenByMutes > 0
                    ? 'Recent notifications are in categories you have muted. They are all on the notifications page.'
                    : 'Approvals, access decisions and security events land here.'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-line-soft">
                {items.map((item) => {
                  const Icon = categoryIcon(item.category)
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => openItem(item)}
                        className={clsx(
                          'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-hover',
                          !item.read_at && 'bg-accent-soft/40'
                        )}
                      >
                        <span
                          className={clsx(
                            'mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg',
                            severityTone(item.severity)
                          )}
                        >
                          <Icon className="h-4 w-4" strokeWidth={2} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start gap-2">
                            <span
                              className={clsx(
                                'block min-w-0 flex-1 text-sm leading-snug',
                                item.read_at ? 'text-secondary' : 'font-semibold text-primary'
                              )}
                            >
                              {item.title}
                            </span>
                            {!item.read_at && (
                              <span
                                aria-hidden="true"
                                className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-accent"
                              />
                            )}
                          </span>
                          {item.body && (
                            <span className="mt-0.5 block truncate text-xs text-tertiary">{item.body}</span>
                          )}
                          <span className="mt-1 block text-2xs text-tertiary">
                            {timeAgo(item.created_at, now)}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="border-t border-line-soft px-4 py-2.5">
            {hiddenByMutes > 0 && items.length > 0 && (
              <p className="mb-1.5 text-center text-2xs text-tertiary">
                {hiddenByMutes} more in muted categories
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                navigate('/notifications')
              }}
              className="w-full rounded-md py-1 text-center text-xs font-semibold text-accent transition-colors hover:bg-hover"
            >
              View all notifications
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
