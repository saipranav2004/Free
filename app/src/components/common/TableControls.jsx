import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Search,
  X,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  Columns3,
  Download,
  RefreshCw,
  Check,
  Bookmark,
  BookmarkPlus,
  Trash2,
  Play,
  Pause,
} from 'lucide-react'
import { Button, IconButton } from './Button'
import { Checkbox } from './Checkbox'
import { formatRelativeToNow } from '../../lib/format'

// ---------------------------------------------------------------------------
// Table chrome.
// ---------------------------------------------------------------------------
// The controls that sit around a list: search, sort headers, density, column
// visibility, export, refresh, saved views. Every one is presentational or
// operates on local UI preferences, none of them fetch, and none of them
// change what a row means.

// --- popover ---------------------------------------------------------------

function Popover({ trigger, children, align = 'right', width = 'w-56', label }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="relative flex-none" ref={ref}>
      {trigger({ open, toggle: () => setOpen((v) => !v), 'aria-expanded': open })}
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="menu"
            aria-label={label}
            className={clsx(
              'animate-menu-in absolute z-40 mt-1.5 overflow-hidden rounded-xl border border-surface-700 bg-surface-900 shadow-overlay',
              width,
              align === 'right' ? 'right-0' : 'left-0'
            )}
          >
            {typeof children === 'function' ? children({ close: () => setOpen(false) }) : children}
          </div>
        </>
      )}
    </div>
  )
}

// --- search ----------------------------------------------------------------

export function SearchField({ value, onChange, placeholder = 'Search…', className, autoFocus }) {
  return (
    <div className={clsx('relative min-w-0 flex-1', className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-500"
        strokeWidth={2}
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-surface-700 bg-surface-900 pl-9 pr-8 text-sm text-ink-50 shadow-sm transition-colors placeholder:text-ink-500 hover:border-surface-600 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/20 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-ink-500 transition-colors hover:bg-surface-800 hover:text-ink-100"
        >
          <X className="h-3 w-3" strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}

// --- sortable column header ------------------------------------------------

export function SortHeader({ label, columnKey, sort, onSort, align = 'left', className, srOnly }) {
  const active = sort?.key === columnKey
  const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th
      scope="col"
      className={clsx(
        // Sentence case, 12px, medium weight. The uppercase 11px wide, tracked
        // header is the single loudest "admin template" tell in a data grid:
        // it shouts a label that nobody needs to read twice, and it costs
        // legibility at exactly the size where legibility is thin. AWS
        // Console, Azure Portal and Salesforce all set headers in sentence
        // case at body-adjacent size, and the column reads as a field name
        // rather than as a banner.
        'sticky top-0 z-10 whitespace-nowrap border-b border-surface-700 bg-surface-850 px-3 py-2 text-micro font-semibold tracking-normal text-ink-400',
        align === 'right' ? 'text-right' : 'text-left',
        className
      )}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {srOnly ? (
        <span className="sr-only">{label}</span>
      ) : onSort ? (
        <button
          type="button"
          onClick={() => onSort(columnKey)}
          title={`Sort by ${label}`}
          className={clsx(
            'group -mx-1 inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-ink-50',
            active && 'text-ink-50',
            align === 'right' && 'flex-row-reverse'
          )}
        >
          <span className="truncate">{label}</span>
          {/* The affordance is always present, at a third of its opacity when
 the column is not the sort. A control that appears only on hover
 is a control most people never find. */}
          <Icon
            className={clsx(
              'h-3 w-3 flex-none transition-opacity',
              active ? 'opacity-100' : 'opacity-30 group-hover:opacity-70'
            )}
            strokeWidth={2.5}
          />
        </button>
      ) : (
        label
      )}
    </th>
  )
}

// --- density ---------------------------------------------------------------
//
// DensityToggle USED TO LIVE HERE AND IS DELIBERATELY GONE.
//
// It was a two-icon segmented control, two nearly identical row glyphs, no
// text label, sitting in the toolbar of every list in the console. Three
// things were wrong with it:
//
//   1. NOBODY COULD TELL WHAT IT WAS. Two 14px icons differing by one line,
// with no label and no tooltip copy that survived translation. A control
// whose function you have to click to discover is decoration.
//   2. IT SOLVED A PROBLEM WE HAVE NOW SOLVED GLOBALLY. Its entire job was
//      "make the rows tighter", which is what the console's new base density
// does by default, everywhere, without a control (see src/index.css).
//   3. IT CROWDED THE ONE ROW THAT SHOULD BE CALM. Every filter bar carried
// search + views + columns + density + export + refresh + timestamp. The
// premium consoles this is measured against (CloudTrail, Okta System
//      Log, Entra) keep that row down to: find, narrow, refresh.
//
// The `density` state itself is untouched in useTableState, tables still read
// it, it still persists, and a future user-level preference can drive it. What
// is gone is the per-page control.

// --- column chooser --------------------------------------------------------

// columns: [{ key, label, required? }] visible: array of keys (null = all)
export function ColumnChooser({ columns, visible, onChange }) {
  const isVisible = (key) => !visible || visible.includes(key)
  const toggle = (key) => {
    const current = visible || columns.map((c) => c.key)
    onChange(current.includes(key) ? current.filter((k) => k !== key) : [...current, key])
  }
  const hiddenCount = columns.filter((c) => !isVisible(c.key)).length

  return (
    <Popover
      label="Choose columns"
      trigger={({ toggle: t, ...aria }) => (
        <Button size="sm" variant="secondary" icon={Columns3} onClick={t} {...aria}>
          Columns
          {hiddenCount > 0 && (
            <span className="ml-0.5 rounded bg-surface-800 px-1 text-2xs font-semibold tabular-nums text-ink-400">
              {columns.length - hiddenCount}/{columns.length}
            </span>
          )}
        </Button>
      )}
    >
      <div className="max-h-80 overflow-y-auto p-1.5">
        {columns.map((c) => (
          <label
            key={c.key}
            className={clsx(
              'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
              c.required ? 'cursor-not-allowed text-ink-500' : 'text-ink-200 hover:bg-surface-800'
            )}
          >
            <Checkbox
              checked={isVisible(c.key)}
              disabled={c.required}
              onChange={() => !c.required && toggle(c.key)}
              srLabel={c.label}
            />
            <span className="truncate">{c.label}</span>
            {c.required && (
              <span className="ml-auto text-2xs uppercase tracking-wide text-ink-600">fixed</span>
            )}
          </label>
        ))}
      </div>
      <div className="border-t border-surface-800 p-1.5">
        <button
          type="button"
          onClick={() => onChange(null)}
          className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-ink-400 transition-colors hover:bg-surface-800 hover:text-ink-100"
        >
          Show all columns
        </button>
      </div>
    </Popover>
  )
}

// --- export ----------------------------------------------------------------

export function ExportMenu({ onExportCsv, onExportJson, count, disabled }) {
  return (
    <Popover
      label="Export"
      width="w-52"
      trigger={({ toggle, ...aria }) => (
        <Button size="sm" variant="secondary" icon={Download} onClick={toggle} disabled={disabled} {...aria}>
          Export
        </Button>
      )}
    >
      {({ close }) => (
        <div className="p-1.5">
          <p className="px-2.5 pb-1.5 pt-1 text-xs font-semibold text-ink-500">
            {typeof count === 'number' ? `${count.toLocaleString()} rows in view` : 'Current view'}
          </p>
          <button
            type="button"
            onClick={() => {
              onExportCsv()
              close()
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink-200 transition-colors hover:bg-surface-800 hover:text-ink-50"
          >
            <Download className="h-3.5 w-3.5 text-ink-500" strokeWidth={1.75} /> Export as CSV
          </button>
          <button
            type="button"
            onClick={() => {
              onExportJson()
              close()
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink-200 transition-colors hover:bg-surface-800 hover:text-ink-50"
          >
            <Download className="h-3.5 w-3.5 text-ink-500" strokeWidth={1.75} /> Export as JSON
          </button>
        </div>
      )}
    </Popover>
  )
}

// --- refresh ---------------------------------------------------------------

// Shows when the data on screen was last fetched. In a security console the
// difference between "no active sessions" and "no active sessions as of nine
// minutes ago" is the whole message.
export function RefreshControl({ onRefresh, isFetching, updatedAt, autoRefresh, onAutoRefreshChange }) {
  const [, force] = useState(0)
  useEffect(() => {
    // Re-render once a minute so "2m ago" doesn't quietly become a lie.
    const t = setInterval(() => force((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="flex flex-none items-center gap-2">
      {onAutoRefreshChange && (
        <Button
          size="sm"
          variant={autoRefresh ? 'subtle' : 'secondary'}
          icon={autoRefresh ? Pause : Play}
          onClick={() => onAutoRefreshChange(!autoRefresh)}
          aria-pressed={autoRefresh}
        >
          Auto-refresh
        </Button>
      )}
      <span className="hidden whitespace-nowrap text-xs text-ink-500 sm:inline">
        {updatedAt
          ? `Updated ${formatRelativeToNow(new Date(updatedAt).toISOString())}`
          : 'Not refreshed yet'}
      </span>
      <IconButton
        icon={RefreshCw}
        variant="secondary"
        size="sm"
        onClick={onRefresh}
        aria-label="Refresh"
        title="Refresh"
        className={isFetching ? 'animate-spin' : undefined}
      />
    </div>
  )
}

// --- saved views -----------------------------------------------------------

// A saved view is a named snapshot of this table's own query state (search,
// filters, sort). It is a local UI preference, nothing is stored server-side
// and no view can grant visibility of a row the API wouldn't have returned
// anyway.
export function useSavedViews(storageKey) {
  const key = `pam_views_${storageKey}`
  const [views, setViews] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })

  const persist = (next) => {
    setViews(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // Preferences just don't persist when storage is unavailable.
    }
  }

  return {
    views,
    saveView: (name, state) => persist([...views.filter((v) => v.name !== name), { name, state }]),
    removeView: (name) => persist(views.filter((v) => v.name !== name)),
  }
}

export function SavedViewsMenu({ views, activeName, onApply, onSave, onRemove, canSave }) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  return (
    <Popover
      label="Saved views"
      width="w-64"
      align="left"
      trigger={({ toggle, ...aria }) => (
        <Button size="sm" variant="secondary" icon={Bookmark} onClick={toggle} {...aria}>
          {activeName || 'Views'}
          {views.length > 0 && !activeName && (
            <span className="ml-0.5 rounded bg-surface-800 px-1 text-2xs font-semibold tabular-nums text-ink-400">
              {views.length}
            </span>
          )}
        </Button>
      )}
    >
      {({ close }) => (
        <div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {views.length === 0 ? (
              <p className="px-2.5 py-3 text-xs leading-relaxed text-ink-500">
                No saved views yet. Filter the list the way you like, then save it here.
              </p>
            ) : (
              views.map((v) => (
                <div key={v.name} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onApply(v)
                      close()
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink-200 transition-colors hover:bg-surface-800 hover:text-ink-50"
                  >
                    {activeName === v.name ? (
                      <Check
                        className="h-3.5 w-3.5 flex-none text-blue-600 dark:text-blue-400"
                        strokeWidth={2.5}
                      />
                    ) : (
                      <Bookmark className="h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
                    )}
                    <span className="truncate">{v.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(v.name)}
                    aria-label={`Delete view ${v.name}`}
                    className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-ink-600 opacity-0 transition-all hover:bg-surface-800 hover:text-red-600 group-hover:opacity-100 dark:hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="border-t border-surface-800 p-1.5">
            {naming ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!name.trim()) return
                  onSave(name.trim())
                  setName('')
                  setNaming(false)
                  close()
                }}
                className="flex items-center gap-1.5 p-1"
              >
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="View name"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-800 px-2.5 text-sm text-ink-50 placeholder:text-ink-500 focus:border-blue-500 focus:outline-none"
                />
                <Button size="sm" variant="primary" type="submit">
                  Save
                </Button>
              </form>
            ) : (
              <button
                type="button"
                disabled={!canSave}
                onClick={() => setNaming(true)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-ink-300 transition-colors hover:bg-surface-800 hover:text-ink-50 disabled:pointer-events-none disabled:opacity-45"
              >
                <BookmarkPlus className="h-3.5 w-3.5 text-ink-500" strokeWidth={1.75} />
                {canSave ? 'Save current filters as a view' : 'Filter the list to save a view'}
              </button>
            )}
          </div>
        </div>
      )}
    </Popover>
  )
}

// --- active filter chips ---------------------------------------------------

export function ActiveFilters({ chips, onClearAll }) {
  if (!chips || chips.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-ink-500">Filtered by</span>
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-850 py-1 pl-2 pr-1 text-xs font-medium text-ink-200"
        >
          <span className="text-ink-500">{c.label}</span>
          <span className="max-w-[12rem] truncate">{c.value}</span>
          <button
            type="button"
            onClick={c.onClear}
            aria-label={`Clear ${c.label} filter`}
            className="flex h-4 w-4 flex-none items-center justify-center rounded text-ink-500 transition-colors hover:bg-surface-700 hover:text-ink-50"
          >
            <X className="h-2.5 w-2.5" strokeWidth={3} />
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs font-medium text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
        >
          Clear all
        </button>
      )}
    </div>
  )
}
