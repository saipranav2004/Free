import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { AlertTriangle, Inbox, Lock, PlugZap, RefreshCw, SearchX } from 'lucide-react'
import { Button, Panel } from './primitives'

// ---------------------------------------------------------------------------
// The mandatory states (Phase 4.7).
// ---------------------------------------------------------------------------
// Every data view must define all four — and 403 is NOT an error. The current
// build renders a 403 as "Couldn't load this data" with a Retry button, which
// invites the user to retry a permission failure forever, and `AdminRoute`
// silently redirects a non-admin to `/` with no explanation at all.

// Skeleton in the SHAPE of the final layout, not a centred spinner.
export function SkeletonRows({ rows = 6, cols = 5 }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface" aria-hidden="true">
      <div className="h-8 border-b border-line bg-subtle" />
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex h-9 items-center gap-3 border-b border-line px-3 last:border-b-0">
          {Array.from({ length: cols }).map((_, c) => (
            <span
              key={c}
              className="skeleton h-2 flex-1"
              style={{ maxWidth: c === 0 ? '30%' : `${12 + ((r + c) % 3) * 6}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export function SkeletonMetric() {
  return (
    <div aria-hidden="true">
      <span className="skeleton block h-2 w-24" />
      <span className="skeleton mt-3 block h-7 w-16" />
      <span className="skeleton mt-2 block h-2 w-40" />
    </div>
  )
}

// ── Empty ────────────────────────────────────────────────────────────────
// Two distinct variants, because "nothing exists yet" and "nothing matches
// your filters" need opposite actions. The current build conflates them on
// six pages and offers "Create" to a user who just over-filtered.
export function EmptyState({ variant = 'none-yet', title, description, action, onClearFilters }) {
  const isFiltered = variant === 'no-match'
  const Icon = isFiltered ? SearchX : Inbox
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-line bg-surface px-6 py-12 text-center">
      <Icon className="h-6 w-6 text-tertiary" strokeWidth={1.5} />
      <p className="mt-4 text-base font-semibold text-primary">
        {title || (isFiltered ? 'Nothing matches these filters' : 'Nothing here yet')}
      </p>
      {description && <p className="mt-1 max-w-prose text-sm text-secondary">{description}</p>}
      <div className="mt-4">
        {isFiltered ? (
          onClearFilters && (
            <Button size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          )
        ) : (
          action
        )}
      </div>
    </div>
  )
}

// ── Error ────────────────────────────────────────────────────────────────
// Always shows the server's own message. Never "Something went wrong".
export function ErrorState({ message, requestId, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-danger/30 bg-danger-soft px-6 py-12 text-center">
      <AlertTriangle className="h-6 w-6 text-danger" strokeWidth={1.5} />
      <p className="mt-4 text-base font-semibold text-primary">Couldn&apos;t load this</p>
      <p className="mt-1 max-w-prose text-sm text-secondary">{message}</p>
      {requestId && (
        <p className="mt-2 font-mono text-xs text-tertiary">request {requestId}</p>
      )}
      {onRetry && (
        <div className="mt-4">
          <Button size="sm" icon={RefreshCw} onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Permission denied ────────────────────────────────────────────────────
// Names the requirement. Offers the route the viewer CAN use. No Retry —
// retrying a 403 will never succeed and offering it is a design failure.
// `requires` names a ROLE and produces the standard sentence. When the reason
// isn't a missing role (e.g. an admin hitting the self-service page, which is
// a routing decision rather than a permission one), pass `explanation` and the
// role sentence is not used at all — the wrong explanation is worse than none.
export function DeniedState({
  requires = 'admin',
  what = 'this area',
  explanation,
  title,
  fallbackHref = '/',
  fallbackLabel = 'Go to your dashboard',
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-line bg-surface px-6 py-12 text-center">
      <Lock className="h-6 w-6 text-tertiary" strokeWidth={1.5} />
      <p className="mt-4 text-base font-semibold text-primary">
        {title || <>You don&apos;t have access to {what}</>}
      </p>
      <p className="mt-1 max-w-prose text-sm text-secondary">
        {explanation || (
          <>
            This needs the <span className="font-mono text-primary">{requires}</span> role. Your account
            doesn&apos;t hold it. An administrator can grant it — for the{' '}
            <span className="font-mono text-primary">admin</span> role, only a root account can.
          </>
        )}
      </p>
      <div className="mt-4">
        <Link
          to={fallbackHref}
          className="inline-flex h-8 items-center rounded border border-line px-3 text-sm font-semibold text-primary hover:bg-hover"
        >
          {fallbackLabel}
        </Link>
      </div>
    </div>
  )
}

// ── Degraded ─────────────────────────────────────────────────────────────
// For the version-skew endpoints flagged in Phase 1: if a deployment predates
// e.g. /admin/mfa-policy, the page says so instead of showing a red error.
export function DegradedState({ feature, endpoint }) {
  return (
    <Panel className="flex items-start gap-3 px-4 py-3">
      <PlugZap className="mt-0.5 h-4 w-4 flex-none text-warn" strokeWidth={1.75} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-primary">{feature} isn&apos;t available on this deployment</p>
        <p className="mt-1 text-sm text-secondary">
          The API didn&apos;t answer <span className="font-mono text-xs text-primary">{endpoint}</span>. Everything
          else on this page still works.
        </p>
      </div>
    </Panel>
  )
}

// A live-data freshness marker. The backend has no push channel
// (SESSIONS_POLL_MS = 15000, "no push channel on the backend yet"), so the
// honest thing is to say when we last looked rather than imply streaming.
export function FreshnessMarker({ seconds = 4, className }) {
  return (
    <span className={clsx('inline-flex items-center gap-2 text-xs text-tertiary', className)}>
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok">
        <span className="dot-live absolute inset-0 rounded-full bg-ok" />
      </span>
      updated {seconds}s ago · polls every 15s
    </span>
  )
}
