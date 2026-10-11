import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { ChevronRight, KeyRound, ShieldCheck, ShieldOff, Terminal } from 'lucide-react'
import { StatusIndicator, MetaTag } from '../common/Badge'
import { ResourceTypeIcon } from './ResourceTypeIcon'
import { RESOURCE_TYPES } from '../../config/constants'

const TYPE_LABEL = Object.fromEntries(RESOURCE_TYPES.map((t) => [t.value, t.label]))

export function resourceTypeLabel(type) {
  return TYPE_LABEL[type] || type || '-'
}

// The three status facts that decide whether someone can actually use a
// resource, rendered identically in the card, the table and the drawer so
// the three surfaces can never disagree.
//
// THESE ARE NO LONGER FILLED PILLS. Every resource has all three values, so
// as coloured chips they produced three saturated blocks per card and per
// row, dozens per screen, which in dark mode glow and pull the eye onto the
// decoration instead of the resource name. AWS, Google Cloud and Okta all
// render per-row state as a dot plus plain text for exactly this reason.
// Filled badges are now reserved for exceptions (a denial, a critical event,
// a deny policy), which is what makes them worth noticing. "Recorded" stays
// a tag rather than an indicator because it is a property, not a state.
export function ResourceStatusBadges({ resource, size = 'md' }) {
  return (
    <div
      className={clsx(
        'flex flex-wrap items-center',
        size === 'sm' ? 'gap-x-3 gap-y-1' : 'gap-x-3.5 gap-y-1.5'
      )}
    >
      {resource.is_active ? (
        <StatusIndicator tone="emerald">Active</StatusIndicator>
      ) : (
        <StatusIndicator tone="neutral">Inactive</StatusIndicator>
      )}
      {resource.requires_jit ? (
        <StatusIndicator tone="amber" title="Requires an approved just-in-time request">
          JIT required
        </StatusIndicator>
      ) : (
        <StatusIndicator tone="blue" title="Available without a request">
          Standing
        </StatusIndicator>
      )}
      {resource.always_record && <MetaTag>Recorded</MetaTag>}
    </div>
  )
}

// A credential is either attached to the resource record or it isn't ,
// `vault_entry_id` is the only field on PAMResource that says so (there is no
// has_credential field; see resource.go).
export function CredentialState({ resource }) {
  const attached = !!resource.vault_entry_id
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 text-xs font-medium',
        attached ? 'text-emerald-700 dark:text-emerald-400' : 'text-ink-500'
      )}
    >
      {attached ? (
        <ShieldCheck className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      ) : (
        <ShieldOff className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      )}
      {attached ? 'Credential attached' : 'No credential'}
    </span>
  )
}

export function ResourceCard({ resource, onPeek }) {
  return (
    <div
      className={clsx(
        ' group relative flex flex-col rounded-xl border border-surface-700/70 bg-surface-900 transition-[border-color,box-shadow,transform] duration-200 ease-emphasis',
        'hover:border-line-strong'
      )}
    >
      <div className="flex items-start gap-3.5 px-4 pb-3 pt-4">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-850 transition-colors group-hover:border-surface-600">
          <ResourceTypeIcon type={resource.resource_type} className="h-[1.15rem] w-[1.15rem]" />
        </span>

        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onPeek(resource)}
            className="block max-w-full truncate text-left text-sm font-semibold text-ink-50 outline-none transition-colors hover:text-blue-600 dark:hover:text-blue-300"
            title={resource.name}
          >
            {resource.name}
          </button>
          <p
            className="mt-0.5 truncate font-mono text-xs text-ink-500"
            title={`${resource.host}:${resource.port}`}
          >
            {resource.host}:{resource.port}
          </p>
        </div>
      </div>

      <div className="px-4 pb-3">
        <ResourceStatusBadges resource={resource} />
      </div>

      <dl className="mx-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-surface-800 py-3 text-xs">
        <div className="min-w-0">
          <dt className="text-xs font-semibold text-ink-600">Type</dt>
          <dd className="mt-0.5 truncate text-ink-200">{resourceTypeLabel(resource.resource_type)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-semibold text-ink-600">
            {resource.database_name ? 'Database' : 'Group'}
          </dt>
          <dd className="mt-0.5 truncate text-ink-200">{resource.database_name || resource.group || '-'}</dd>
        </div>
      </dl>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-surface-800 bg-surface-850/40 px-4 py-2.5">
        <CredentialState resource={resource} />
        <div className="flex flex-none items-center gap-1">
          {/* Quick connect: the one action a browsing user actually wants,
 reachable without opening the resource first. It routes to the
 resource's own page, where the launcher now sits at the top for
 every role, no separate code path, so JIT gating and credential
 checks behave identically. */}
          <Link
            to={`/resources/${resource.id}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-500/10"
          >
            {resource.requires_jit ? (
              <KeyRound className="h-3.5 w-3.5" strokeWidth={2} />
            ) : (
              <Terminal className="h-3.5 w-3.5" strokeWidth={2} />
            )}
            Connect
          </Link>
          <Link
            to={`/resources/${resource.id}`}
            aria-label={`Open ${resource.name}`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-surface-800 hover:text-ink-100"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </Link>
        </div>
      </div>
    </div>
  )
}
