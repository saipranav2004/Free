import clsx from 'clsx'
import { AlertTriangle, Inbox, RefreshCw, SearchX, ShieldOff, Unplug } from 'lucide-react'
import { Button } from '../common/Button'

// ---------------------------------------------------------------------------
// The states a data view can be in
// ---------------------------------------------------------------------------
// Five, and they are genuinely different situations that want different
// sentences and different ways out. Collapsing them is how "Couldn't load this
// data. Retry." ends up in front of someone who is simply not allowed to see
// it, and will never be, no matter how many times they press Retry.
//
// Every one of them renders at the same footprint and INSIDE the container, so
// a panel does not change shape or position between loading and loaded.

function Plate({ icon: Icon, tone = 'neutral', title, body, actions, className }) {
  const tile = {
    neutral: 'bg-subtle text-tertiary',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger',
  }[tone]
  return (
    <div className={clsx('flex flex-col items-center px-6 py-14 text-center', className)}>
      {Icon && (
        <span className={clsx('mb-4 flex h-11 w-11 items-center justify-center rounded-xl', tile)}>
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </span>
      )}
      <p className="text-base font-bold text-primary">{title}</p>
      {body && <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-secondary">{body}</p>}
      {actions && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  )
}

/** Nothing exists yet. The way out is to create the first one. */
export function EmptyState({ icon = Inbox, title, description, action, className }) {
  return <Plate icon={icon} title={title} body={description} actions={action} className={className} />
}

/**
 * Things exist, but none match. A different situation from empty, and it needs
 * a different way out: clear the filters, not "create your first one".
 */
export function NoMatchState({
  title = 'No matches',
  description,
  onClear,
  clearLabel = 'Clear filters',
  className,
}) {
  return (
    <Plate
      icon={SearchX}
      title={title}
      body={description || 'Nothing matches the current search and filter combination.'}
      actions={
        onClear ? (
          <Button variant="subtle" onClick={onClear}>
            {clearLabel}
          </Button>
        ) : null
      }
      className={className}
    />
  )
}

/** The request failed. Retrying is a reasonable thing to try. */
export function ErrorState({ title = 'That did not load', description, onRetry, retrying, className }) {
  return (
    <Plate
      icon={AlertTriangle}
      tone="danger"
      title={title}
      body={description}
      actions={
        onRetry ? (
          <Button variant="subtle" icon={RefreshCw} onClick={onRetry} loading={retrying}>
            Try again
          </Button>
        ) : null
      }
      className={className}
    />
  )
}

/** The server is unreachable. Not the same event as a 500, and not the user's fault. */
export function OfflineState({ onRetry, retrying, className }) {
  return (
    <Plate
      icon={Unplug}
      tone="danger"
      title="Cannot reach the server"
      body="The console could not reach the PAM backend. Check your connection, then try again."
      actions={
        onRetry ? (
          <Button variant="subtle" icon={RefreshCw} onClick={onRetry} loading={retrying}>
            Try again
          </Button>
        ) : null
      }
      className={className}
    />
  )
}

/**
 * Permission denied. There is deliberately no Retry: the request succeeded in
 * reaching the server and the answer was no, so retrying will fail identically
 * forever. What helps is knowing which role this needs and where to go instead.
 */
export function DeniedState({ title = 'You do not have access to this', description, actions, className }) {
  return (
    <Plate
      icon={ShieldOff}
      tone="warn"
      title={title}
      body={
        description ||
        'This area is limited to administrators. Ask an administrator to grant you access, or open something else from the sidebar.'
      }
      actions={actions}
      className={className}
    />
  )
}

/**
 * The route exists in this console but not on the deployed backend. This is a
 * real situation here: `backend.zip` is an older snapshot than the API the UI
 * targets, and eight endpoints the frontend calls are missing from its route
 * table. Saying "not deployed on this backend" is honest; showing a generic
 * error is not.
 */
export function DegradedState({ feature, description, className }) {
  return (
    <Plate
      icon={AlertTriangle}
      tone="warn"
      title={`${feature} is not available on this deployment`}
      body={
        description ||
        'The console supports this, but the server it is talking to does not expose the route yet. Nothing is broken on your side.'
      }
      className={className}
    />
  )
}

/** Skeleton lines sized to the shape of what is loading. */
export function SkeletonLines({ rows = 6, className }) {
  return (
    <div className={clsx('space-y-3 p-4', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <span
          key={i}
          className="skeleton block h-4 w-full rounded"
          style={{ maxWidth: `${90 - (i % 4) * 12}%` }}
        />
      ))}
    </div>
  )
}
