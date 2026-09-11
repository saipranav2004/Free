import clsx from 'clsx'
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import { Menu, MenuButton, MenuDivider, MenuItem, MenuLabel, MenuNote } from './menu'
import { useDensity } from './grid'
import { Button } from '../common/Button'

// ---------------------------------------------------------------------------
// List chrome
// ---------------------------------------------------------------------------
// The AWS Console list page puts these in a fixed order, and the order is the
// point: header, then actions, then filtering, then preferences, then the
// table, then pagination. Our previous build scattered them, so a page header
// grew four peer buttons and the filter bar carried search, views, columns,
// density, export, refresh and a timestamp on one line.
//
// CommandBar is one strip with three zones. Primary action and object actions
// on the left, the count next to them, and view utilities pushed right. A
// utility never changes data, only how it is shown, which is why they are
// kept away from the actions that do.

export function CommandBar({ primary, actions, summary, children, className }) {
  return (
    <div className={clsx('flex flex-wrap items-center gap-2', className)}>
      {primary}
      {actions}
      {summary != null && <span className="text-sm tabular text-tertiary">{summary}</span>}
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

/** Search field. One per list, always the leftmost thing in the filter row. */
export function SearchField({ value, onChange, placeholder = 'Search', label, className, autoFocus }) {
  return (
    <div className={clsx('relative min-w-[13rem] flex-1 sm:max-w-[22rem]', className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-tertiary"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        aria-label={label || placeholder}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-8 pr-8 text-sm text-primary transition-colors placeholder:text-tertiary hover:border-primary/40 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-tertiary transition-colors hover:bg-hover hover:text-primary"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}

/**
 * One gear, three groups: density, page size, columns. AWS puts all three
 * behind a single preferences control for the same reason, they are all "how
 * do I want to look at this list", and giving each its own toolbar button
 * spends three controls' worth of attention on presentation.
 */
export function PreferencesMenu({
  columns,
  visible,
  onVisibleChange,
  pageSize,
  onPageSize,
  sizes = [25, 50, 100],
}) {
  const { density, setDensity } = useDensity()
  const isVisible = (c) => c.required || !visible || visible.includes(c.key)
  return (
    <Menu
      label="List preferences"
      width="w-64"
      trigger={(open) => (
        <span
          className={clsx(
            'inline-flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-lg border transition-colors',
            open
              ? 'border-line-strong bg-hover text-primary'
              : 'border-line-strong bg-surface text-secondary hover:bg-hover'
          )}
          title="List preferences"
        >
          <Settings2 className="h-4 w-4" strokeWidth={1.75} />
        </span>
      )}
    >
      <MenuLabel>Row density</MenuLabel>
      <MenuItem checked={density === 'comfortable'} onClick={() => setDensity('comfortable')} hint="44px">
        Comfortable
      </MenuItem>
      <MenuItem checked={density === 'compact'} onClick={() => setDensity('compact')} hint="36px">
        Compact
      </MenuItem>

      {onPageSize && (
        <>
          <MenuDivider />
          <MenuLabel>Rows per page</MenuLabel>
          {sizes.map((n) => (
            <MenuItem key={n} checked={pageSize === n} onClick={() => onPageSize(n)}>
              {n}
            </MenuItem>
          ))}
        </>
      )}

      {columns && columns.length > 0 && (
        <>
          <MenuDivider />
          <MenuLabel>Columns</MenuLabel>
          <div className="max-h-56 overflow-y-auto">
            {columns.map((c) => (
              <MenuItem
                key={c.key}
                checked={isVisible(c)}
                disabled={c.required}
                hint={c.required ? 'always' : undefined}
                onClick={() => {
                  if (c.required) return
                  const current = visible || columns.map((x) => x.key)
                  onVisibleChange(
                    current.includes(c.key) ? current.filter((k) => k !== c.key) : [...current, c.key]
                  )
                }}
              >
                {c.label}
              </MenuItem>
            ))}
          </div>
        </>
      )}
    </Menu>
  )
}

/**
 * Export. CSV and JSON only, because those are the two `lib/exportRows.js`
 * produces client-side from rows already on screen. There is no server-side
 * export endpoint, so there is no "export everything matching" option: it
 * would promise something the API cannot do, and the note says so.
 */
export function ExportMenu({ onExportCsv, onExportJson, count, disabled }) {
  return (
    <Menu
      label="Export"
      width="w-60"
      trigger={(open) => (
        <MenuButton icon={Download} open={open}>
          Export
        </MenuButton>
      )}
    >
      <MenuItem onClick={onExportCsv} disabled={disabled}>
        Download CSV
      </MenuItem>
      <MenuItem onClick={onExportJson} disabled={disabled}>
        Download JSON
      </MenuItem>
      <MenuDivider />
      <MenuNote>
        Exports the {count ?? 0} rows currently loaded. There is no server side export route, so a wider
        export means paging further first.
      </MenuNote>
    </Menu>
  )
}

/**
 * Saved views. A named filter set, stored per browser, which is all this
 * backend supports: no endpoint persists a view per account, and the menu says
 * so rather than implying it syncs.
 */
export function SavedViewsMenu({ views, activeName, canSave, onApply, onSave, onRemove }) {
  return (
    <Menu
      label="Saved views"
      width="w-64"
      trigger={(open) => (
        <MenuButton icon={Bookmark} open={open}>
          {activeName || 'Views'}
        </MenuButton>
      )}
    >
      <MenuLabel>Saved views</MenuLabel>
      {(!views || views.length === 0) && <MenuNote>None yet. Filter the list, then save it.</MenuNote>}
      {(views || []).map((v) => (
        <div key={v.name} className="flex items-center">
          <MenuItem className="flex-1" checked={activeName === v.name} onClick={() => onApply(v)}>
            {v.name}
          </MenuItem>
          <button
            type="button"
            onClick={() => onRemove(v.name)}
            aria-label={`Delete view ${v.name}`}
            className="mr-2 flex h-7 w-7 flex-none items-center justify-center rounded text-tertiary hover:bg-danger-soft hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      ))}
      <MenuDivider />
      <MenuItem
        icon={Bookmark}
        disabled={!canSave}
        onClick={() => {
          const name = window.prompt('Name this view')
          if (name && name.trim()) onSave(name.trim())
        }}
      >
        {canSave ? 'Save current filters' : 'Nothing to save yet'}
      </MenuItem>
      <MenuNote>Stored in this browser. No endpoint persists views per account.</MenuNote>
    </Menu>
  )
}

/**
 * Refresh with a visible "as of". The backend has no push channel, so a
 * spinner that implies streaming would be a lie. This says when the data was
 * last fetched and lets you fetch again.
 */
export function RefreshControl({ onRefresh, isFetching, updatedAt, className }) {
  const label = updatedAt ? relativeShort(updatedAt) : null
  return (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      {label && <span className="hidden text-xs text-tertiary sm:inline">Updated {label}</span>}
      <Button
        variant="subtle"
        size="md"
        icon={RefreshCw}
        onClick={onRefresh}
        loading={isFetching}
        aria-label="Refresh"
        title="Refresh"
        className="w-8 px-0"
      />
    </span>
  )
}

function relativeShort(ts) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  return `${Math.round(secs / 3600)}h ago`
}

/** Active filters as removable chips, with a clear-all. */
export function ActiveFilters({ chips, onClearAll, className }) {
  if (!chips || chips.length === 0) return null
  return (
    <div className={clsx('flex flex-wrap items-center gap-2', className)}>
      <span className="text-xs font-bold text-tertiary">Filters</span>
      {chips.map((c) => (
        <button
          key={c.key || c.label}
          type="button"
          onClick={c.onClear || c.onRemove}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-subtle px-2 text-xs text-primary transition-colors hover:border-danger/50 hover:text-danger"
        >
          {c.label}
          {c.value != null && <span className="text-tertiary">{String(c.value)}</span>}
          <X className="h-3 w-3" strokeWidth={2.5} />
        </button>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="text-xs font-semibold text-accent hover:underline"
      >
        Clear all
      </button>
    </div>
  )
}

// "safes" to "safe", "policies" to "policy". Every label this component is
// given is a plain English plural (accounts, credentials, events, grants,
// notifications, policies, recordings, requests, resources, roles, safes,
// sessions), so two rules cover the vocabulary; anything unrecognised is left
// exactly as it was passed rather than guessed at.
function singular(label) {
  if (/ies$/.test(label)) return label.replace(/ies$/, 'y')
  if (/(ss|us|is)$/.test(label)) return label
  if (/s$/.test(label)) return label.replace(/s$/, '')
  return label
}

/**
 * Pagination. The range read-out stays whatever happens, because it is what
 * tells an operator whether their filter narrowed anything.
 *
 * THE PAGE CONTROLS DO NOT. A tenant with four resources in it was getting
 * "1 to 4 of 4 resources" beside a "1 of 1" and two arrows that can never be
 * clicked, which is the product filling a footer with the shape of an
 * interaction that does not exist. Below one page the read-out says the
 * simple true thing ("4 resources", "1 safe") and the controls are gone.
 *
 * This is the state a demo tenant is always in, and it was the state the
 * console handled worst.
 */
export function Pagination({ page, pageSize, total, totalPages, onPageChange, label = 'items', className }) {
  const pages = Math.max(1, totalPages || Math.ceil((total || 0) / (pageSize || 1)))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total || 0)
  const count = total || 0
  const onePage = pages <= 1
  return (
    <div
      className={clsx(
        'flex flex-wrap items-center justify-between gap-3 border-t border-line-soft px-4 py-2.5',
        className
      )}
    >
      <span className="text-sm tabular text-secondary">
        {onePage ? (
          <>
            {count.toLocaleString()} {count === 1 ? singular(label) : label}
          </>
        ) : (
          <>
            {from.toLocaleString()} to {to.toLocaleString()} of {count.toLocaleString()} {label}
          </>
        )}
      </span>
      {!onePage && (
      <div className="flex items-center gap-1">
        <Button
          variant="subtle"
          size="md"
          icon={ChevronLeft}
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="w-8 px-0"
        />
        <span className="px-2 text-sm tabular text-secondary">
          {page} of {pages}
        </span>
        <Button
          variant="subtle"
          size="md"
          icon={ChevronRight}
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
          className="w-8 px-0"
        />
      </div>
      )}
    </div>
  )
}

/**
 * Bulk action bar. There is no batch endpoint anywhere in this API, so this
 * never implies one call: it names the per item loop and reports partial
 * success honestly afterwards.
 */
export function BulkBar({ count, onClear, children, result, className }) {
  if (!count && !result) return null
  return (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-3 rounded-lg border border-line bg-subtle px-3 py-2',
        className
      )}
    >
      {result ? (
        <>
          <span className="text-sm font-bold tabular text-primary">
            {result.ok} of {result.total} {result.verb}
          </span>
          {result.failed > 0 && <span className="text-sm tabular text-danger">{result.failed} failed</span>}
          <button
            type="button"
            onClick={onClear}
            className="ml-auto text-xs font-semibold text-accent hover:underline"
          >
            Dismiss
          </button>
        </>
      ) : (
        <>
          <span className="text-sm font-bold tabular text-primary">{count} selected</span>
          {children}
          <span className="hidden text-xs text-tertiary lg:inline">
            One request per row. Each result is reported separately.
          </span>
          <button
            type="button"
            onClick={onClear}
            className="ml-auto text-xs font-semibold text-accent hover:underline"
          >
            Clear
          </button>
        </>
      )}
    </div>
  )
}
