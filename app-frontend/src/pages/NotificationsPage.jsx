import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck } from 'lucide-react'
import clsx from 'clsx'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../api/notifications'
import { categoryIcon, categoryLabel, groupByDay, severityTone, timeAgo } from '../lib/notificationDisplay'
import { Container, PageTitle, Stack } from '../components/ui/layout'
import { EmptyState } from '../components/common/Layout'
import { Pagination } from '../components/common/Pagination'
import { SkeletonRows } from '../components/common/Spinner'

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
// WHY A PAGE AND NOT JUST THE PANEL.
//
// The question was worth asking, and the answer is that the panel and the page
// serve two different needs that fight each other in one surface:
//
//   THE PANEL answers "what is new right now". It is opened mid-task, read in
//     three seconds, and closed. It must be short, or it stops being glanceable.
//   THE PAGE answers "what happened, and what did I miss". Filtering, history,
//     and reading a week back are all things you sit down to do, and none of
//     them fit in a dropdown without turning it into a bad page.
//
// Every console measured against — AWS Console Notifications, Okta, GitHub's
// inbox, ServiceNow — ships both, for exactly this split. The panel that tries
// to be the archive becomes a scrolling box that is worse at both jobs.
//
// GROUPED BY DAY, NOT PAGED FLAT. "What happened today" is the question people
// arrive with, and a date heading answers it without anyone reading a single
// timestamp.
//
// UNREAD IS A FILTER, NOT THE DEFAULT HERE. The bell is already the unread
// view; someone who navigated to the page usually wants the history. The filter
// is one click away for when they do not.

const PAGE_SIZE = 25

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
]

export default function NotificationsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(1)

  // Same ticking clock as the bell, so "2m ago" stays true while the page is
  // open rather than freezing at the moment it rendered.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

  const query = useQuery({
    queryKey: ['notifications', 'page', filter, page],
    queryFn: ({ signal }) =>
      listNotifications(
        { page, page_size: PAGE_SIZE, ...(filter === 'unread' ? { status: 'unread' } : {}) },
        signal
      ),
    placeholderData: (prev) => prev,
    retry: false,
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications'] })
  const readOne = useMutation({ mutationFn: markNotificationRead, onSuccess: refresh })
  const readAll = useMutation({ mutationFn: markAllNotificationsRead, onSuccess: refresh })

  const items = useMemo(() => query.data?.items || [], [query.data])
  const groups = useMemo(() => groupByDay(items, now), [items, now])
  const unread = query.data?.unread_total ?? 0
  const pagination = query.data

  const openItem = (item) => {
    if (!item?.read_at) readOne.mutate(item.id)
    if (item?.link) navigate(item.link)
  }

  return (
    <Stack gap="lg">
      <PageTitle
        title="Notifications"
        description="Approvals waiting on you, decisions on what you asked for, and security events on your account."
        counter={unread > 0 ? `${unread} unread` : undefined}
        actions={
          <button
            type="button"
            onClick={() => readAll.mutate()}
            disabled={unread === 0 || readAll.isPending}
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-secondary transition-colors hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <CheckCheck className="h-4 w-4" strokeWidth={2} />
            Mark all read
          </button>
        }
      />

      <Container padded={false}>
        <div className="flex items-center gap-1 border-b border-line-soft px-4 py-2.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                setFilter(f.key)
                setPage(1)
              }}
              className={clsx(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                filter === f.key ? 'bg-subtle text-primary' : 'text-tertiary hover:bg-hover hover:text-secondary'
              )}
            >
              {f.label}
              {f.key === 'unread' && unread > 0 && (
                <span className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-2xs font-bold text-white">
                  {unread}
                </span>
              )}
            </button>
          ))}
        </div>

        {query.isLoading ? (
          <SkeletonRows rows={6} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Bell}
            title={filter === 'unread' ? 'Nothing unread' : 'No notifications yet'}
            description={
              filter === 'unread'
                ? 'You have read everything. Switch to All to see the history.'
                : 'Approvals, access decisions and security events will appear here.'
            }
          />
        ) : (
          <div>
            {groups.map(([label, rows]) => (
              <section key={label}>
                <h2 className="sticky top-0 z-10 border-b border-line-soft bg-subtle/80 px-4 py-1.5 text-2xs font-bold uppercase tracking-[0.08em] text-tertiary backdrop-blur">
                  {label}
                </h2>
                <ul className="divide-y divide-line-soft">
                  {rows.map((item) => {
                    const Icon = categoryIcon(item.category)
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => openItem(item)}
                          className={clsx(
                            'flex w-full items-start gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-hover',
                            !item.read_at && 'bg-accent-soft/30'
                          )}
                        >
                          <span
                            className={clsx(
                              'mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg',
                              severityTone(item.severity)
                            )}
                          >
                            <Icon className="h-4 w-4" strokeWidth={2} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span
                                className={clsx(
                                  'text-sm leading-snug',
                                  item.read_at ? 'text-secondary' : 'font-semibold text-primary'
                                )}
                              >
                                {item.title}
                              </span>
                              <span className="rounded border border-line-soft bg-subtle px-1.5 py-0.5 text-2xs font-medium text-tertiary">
                                {categoryLabel(item.category)}
                              </span>
                            </span>
                            {item.body && (
                              <span className="mt-1 block text-xs leading-relaxed text-tertiary">
                                {item.body}
                              </span>
                            )}
                          </span>
                          <span className="ml-2 flex flex-none items-center gap-2 pt-0.5">
                            <span className="whitespace-nowrap text-2xs text-tertiary">
                              {timeAgo(item.created_at, now)}
                            </span>
                            {!item.read_at && (
                              <span aria-label="Unread" className="h-2 w-2 rounded-full bg-accent" />
                            )}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {pagination && pagination.total > PAGE_SIZE && (
          <Pagination
            page={pagination.page}
            pageSize={pagination.page_size}
            total={pagination.total}
            totalPages={pagination.total_pages}
            onPageChange={setPage}
            label="notifications"
          />
        )}
      </Container>
    </Stack>
  )
}
