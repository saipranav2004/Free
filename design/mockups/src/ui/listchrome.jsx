import { useState } from 'react'
import clsx from 'clsx'
import {
  Bookmark, ChevronLeft, ChevronRight, Columns3, Download, MoreHorizontal,
  Rows3, RefreshCw, Settings2, X,
} from 'lucide-react'
import { Button } from './primitives'
import { Menu, MenuButton, MenuDivider, MenuItem, MenuLabel } from './overlay'
import { useDensity } from './table'

// ===========================================================================
// List chrome — the layer pass 1 removed and shouldn't have.
// ===========================================================================
// Sort, pagination, column choice, export, saved views, refresh and active
// filters all exist in the app being redesigned (TableControls.jsx, used by
// six pages). Dropping them made the mockups look calmer while making them
// LESS CAPABLE than the product they replace. That is not restraint.
//
// The structural fix is the one AWS Console, Azure Portal and Salesforce all
// converge on: a COMMAND BAR — a single horizontal strip directly under the
// page title carrying the primary action on the left and the view utilities
// on the right, with a separate filter row beneath. Pass 1 scattered these
// into the page header, which is why headers grew three and four peer
// buttons.

/**
 * CommandBar — one strip, three zones.
 *   left:    the primary action and any secondary object-level actions
 *   middle:  count / selection summary (the "what am I looking at" line)
 *   right:   view utilities that change presentation, never data
 */
export function CommandBar({ primary, actions, summary, children, className }) {
  return (
    <div
      className={clsx(
        'mb-3 flex flex-wrap items-center gap-2 border-b border-line pb-3',
        className
      )}
    >
      {primary}
      {actions}
      {summary && <span className="ml-1 text-xs tabular text-tertiary">{summary}</span>}
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

/** Density toggle — comfortable 32px rows / compact 26px. Persisted. */
export function DensityToggle() {
  const { density, setDensity } = useDensity()
  return (
    <Menu
      label="Row density"
      width="w-44"
      trigger={(open) => (
        <MenuButton icon={Rows3} open={open}>
          {density === 'compact' ? 'Compact' : 'Comfortable'}
        </MenuButton>
      )}
    >
      <MenuItem checked={density === 'comfortable'} onClick={() => setDensity('comfortable')} hint="32px">
        Comfortable
      </MenuItem>
      <MenuItem checked={density === 'compact'} onClick={() => setDensity('compact')} hint="26px">
        Compact
      </MenuItem>
    </Menu>
  )
}

/** Column chooser. Columns marked `locked` are the row's identity and stay. */
export function ColumnChooser({ columns, visible, onChange }) {
  return (
    <Menu
      label="Columns"
      width="w-52"
      trigger={(open) => (
        <MenuButton icon={Columns3} open={open} count={visible.length}>
          Columns
        </MenuButton>
      )}
    >
      <MenuLabel>Show columns</MenuLabel>
      {columns.map((c) => (
        <MenuItem
          key={c.key}
          checked={c.locked || visible.includes(c.key)}
          onClick={() => {
            if (c.locked) return
            onChange(visible.includes(c.key) ? visible.filter((k) => k !== c.key) : [...visible, c.key])
          }}
          hint={c.locked ? 'locked' : undefined}
        >
          {c.label}
        </MenuItem>
      ))}
    </Menu>
  )
}

/**
 * Export. CSV and JSON only — those are the two the existing `exportRows.js`
 * produces client-side from rows already on screen. There is no server-side
 * export endpoint, so there is no "export all matching" option: it would
 * promise something the API cannot do.
 */
export function ExportMenu({ count }) {
  return (
    <Menu
      label="Export"
      width="w-56"
      trigger={(open) => (
        <MenuButton icon={Download} open={open}>
          Export
        </MenuButton>
      )}
    >
      <MenuItem>Download CSV</MenuItem>
      <MenuItem>Download JSON</MenuItem>
      <MenuDivider />
      <p className="px-3 pb-2 pt-1 text-xs leading-relaxed text-tertiary">
        Exports the {count} rows currently loaded. There is no server-side export endpoint, so a wider export
        means paging further first.
      </p>
    </Menu>
  )
}

/** Saved views — a named filter set, stored per browser (as it is today). */
export function SavedViewsMenu({ views, active, onApply, onSave, canSave }) {
  return (
    <Menu
      label="Saved views"
      width="w-60"
      trigger={(open) => (
        <MenuButton icon={Bookmark} open={open}>
          {active || 'Views'}
        </MenuButton>
      )}
    >
      <MenuLabel>Saved views</MenuLabel>
      {views.length === 0 ? (
        <p className="px-3 py-2 text-xs text-tertiary">None yet. Filter the list, then save it.</p>
      ) : (
        views.map((v) => (
          <MenuItem key={v.name} checked={active === v.name} onClick={() => onApply(v)}>
            {v.name}
          </MenuItem>
        ))
      )}
      <MenuDivider />
      <MenuItem onClick={onSave} icon={Bookmark}>
        {canSave ? 'Save current filters…' : 'Nothing to save'}
      </MenuItem>
      <p className="px-3 pb-2 pt-1 text-xs leading-relaxed text-tertiary">
        Stored in this browser. No endpoint persists views per account.
      </p>
    </Menu>
  )
}

/**
 * Refresh + freshness. The backend has no push channel, so the honest control
 * is a manual refresh with a visible "as of", plus an auto-refresh the user
 * opts into — not a spinner that implies streaming.
 */
export function RefreshControl({ seconds = 4, auto, onAutoChange, onRefresh }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="hidden text-xs text-tertiary sm:inline">updated {seconds}s ago</span>
      <Button size="md" icon={RefreshCw} onClick={onRefresh} aria-label="Refresh" />
      <Menu
        label="Auto refresh"
        width="w-48"
        trigger={(open) => <MenuButton open={open}>{auto ? 'Auto 15s' : 'Auto off'}</MenuButton>}
      >
        <MenuItem checked={!auto} onClick={() => onAutoChange(false)}>
          Off
        </MenuItem>
        <MenuItem checked={auto} onClick={() => onAutoChange(true)} hint="15s">
          On
        </MenuItem>
        <p className="px-3 pb-2 pt-1 text-xs leading-relaxed text-tertiary">
          Polling, not streaming — there is no push channel on this API yet.
        </p>
      </Menu>
    </span>
  )
}

/** Active filters as removable chips, with a clear-all. */
export function ActiveFilters({ chips, onClearAll }) {
  if (!chips || chips.length === 0) return null
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-micro font-semibold uppercase text-tertiary">Filters</span>
      {chips.map((c) => (
        <button
          key={c.label}
          type="button"
          onClick={c.onRemove}
          className="inline-flex h-6 items-center gap-1 rounded border border-line-strong bg-subtle px-2 text-xs text-primary hover:border-danger/50 hover:text-danger"
        >
          {c.label}
          <X className="h-3 w-3" strokeWidth={2} />
        </button>
      ))}
      <button type="button" onClick={onClearAll} className="text-xs text-accent hover:underline">
        Clear all
      </button>
    </div>
  )
}

/**
 * Pagination. Every list in a real console has one, because every list in a
 * real console eventually has thousands of rows. Page size is a control, not
 * a constant, and the range read-out is what tells an operator whether their
 * filter actually narrowed anything.
 */
export function Pagination({ page, pageSize, total, onPage, onPageSize, sizes = [25, 50, 100] }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <span className="text-xs tabular text-tertiary">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="md"
          icon={ChevronLeft}
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        />
        <span className="px-2 text-xs tabular text-secondary">
          {page} / {pages}
        </span>
        <Button
          size="md"
          icon={ChevronRight}
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        />
      </div>
    </div>
  )
}

/**
 * Bulk action bar. There is no bulk endpoint anywhere in this API, so this
 * never implies one call: it names the per-item loop, and after running it
 * reports partial success honestly.
 */
export function BulkBar({ count, onClear, children, result }) {
  if (count === 0 && !result) return null
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line-strong bg-subtle px-3 py-2">
      {result ? (
        <>
          <span className="text-sm font-semibold text-primary tabular">
            {result.ok} of {result.total} {result.verb}
          </span>
          {result.failed > 0 && (
            <span className="text-sm text-danger tabular">{result.failed} failed</span>
          )}
          <button type="button" onClick={onClear} className="ml-auto text-xs text-accent hover:underline">
            Dismiss
          </button>
        </>
      ) : (
        <>
          <span className="text-sm font-semibold text-primary tabular">{count} selected</span>
          {children}
          <span className="hidden text-xs text-tertiary lg:inline">
            One request per row — each result is reported separately.
          </span>
          <button type="button" onClick={onClear} className="ml-auto text-xs text-accent hover:underline">
            Clear
          </button>
        </>
      )}
    </div>
  )
}

/**
 * Preferences — AWS Console's gear, and for the same reason: density, column
 * visibility and page size are all "how do I want to look at this list",
 * and giving each its own toolbar button spends three controls' worth of
 * attention on presentation. One gear, three groups.
 */
export function PreferencesMenu({ columns, visible, onVisibleChange, pageSize, onPageSize, sizes = [25, 50, 100] }) {
  const { density, setDensity } = useDensity()
  return (
    <Menu
      label="List preferences"
      width="w-60"
      trigger={(open) => (
        <span
          className={clsx(
            'flex h-8 w-8 cursor-pointer items-center justify-center rounded border transition-colors duration-100',
            open ? 'border-line-strong bg-hover text-primary' : 'border-line bg-surface text-tertiary hover:text-primary'
          )}
          role="button"
          aria-label="List preferences"
        >
          <Settings2 className="h-4 w-4" strokeWidth={1.75} />
        </span>
      )}
    >
      <MenuLabel>Row density</MenuLabel>
      <MenuItem checked={density === 'comfortable'} onClick={() => setDensity('comfortable')} hint="32px">
        Comfortable
      </MenuItem>
      <MenuItem checked={density === 'compact'} onClick={() => setDensity('compact')} hint="26px">
        Compact
      </MenuItem>

      <MenuDivider />
      <MenuLabel>Rows per page</MenuLabel>
      {sizes.map((s) => (
        <MenuItem key={s} checked={s === pageSize} onClick={() => onPageSize(s)}>
          {s}
        </MenuItem>
      ))}

      {columns && (
        <>
          <MenuDivider />
          <MenuLabel>Columns</MenuLabel>
          {columns.map((c) => (
            <MenuItem
              key={c.key}
              checked={c.locked || visible.includes(c.key)}
              onClick={() => {
                if (c.locked) return
                onVisibleChange(visible.includes(c.key) ? visible.filter((k) => k !== c.key) : [...visible, c.key])
              }}
              hint={c.locked ? 'locked' : undefined}
            >
              {c.label}
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  )
}

/**
 * The row overflow menu. One quiet glyph per row; the destructive action
 * lives inside it.
 */
export function RowMenu({ children, label = 'Row actions' }) {
  return (
    <Menu
      label={label}
      width="w-52"
      trigger={(open) => (
        <span
          role="button"
          aria-label={label}
          className={clsx(
            'flex h-6 w-6 cursor-pointer items-center justify-center rounded',
            open ? 'bg-hover text-primary' : 'text-tertiary hover:bg-hover hover:text-primary'
          )}
        >
          <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
        </span>
      )}
    >
      {children}
    </Menu>
  )
}

/** Small helper for the client-side paging the mockups do. */
export function usePaging(total, initialSize = 25) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(initialSize)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pages)
  return {
    page: safePage,
    pageSize,
    setPage,
    setPageSize: (s) => {
      setPageSize(s)
      setPage(1)
    },
    slice: (rows) => rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    reset: () => setPage(1),
  }
}
