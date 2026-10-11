import { Inbox } from 'lucide-react'
import { normalizeApiError } from '../../lib/apiError'
import { DeniedState, EmptyState, ErrorState, OfflineState, SkeletonLines } from '../ui/states'

// Wraps the loading, error, empty and success branches every data fetching
// view needs. It exists to make it HARD to forget one: a raw `{data.map(...)}`
// with no guard is exactly how a blank screen (loading), a silent no-op (error
// swallowed) or a crash (data undefined on first render) gets into a
// component.
//
// The presentation of each branch lives in components/ui/states.jsx, so a
// change to how a denial reads applies everywhere at once.
export function QueryState({
  query,
  empty, // optional: fn(data) => boolean
  emptyMessage = 'Nothing here yet.',
  emptyTitle,
  emptyAction,
  emptyIcon = Inbox,
  loadingLabel = 'Loading',
  skeletonRows = 6,
  deniedTitle,
  deniedMessage,
  children, // fn(data) => ReactNode
}) {
  if (query.isLoading) return <SkeletonLines rows={skeletonRows} aria-label={loadingLabel} />

  if (query.isError) {
    const err = normalizeApiError(query.error)
    if (err.status === 403) {
      return <DeniedState title={deniedTitle} description={deniedMessage || err.message} />
    }
    if (err.code === 'network_error') {
      return <OfflineState onRetry={() => query.refetch()} retrying={query.isFetching} />
    }
    return (
      <ErrorState description={err.message} onRetry={() => query.refetch()} retrying={query.isFetching} />
    )
  }

  const data = query.data
  if (empty ? empty(data) : false) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle || 'Nothing to show'}
        description={emptyMessage}
        action={emptyAction}
      />
    )
  }

  return children(data)
}
