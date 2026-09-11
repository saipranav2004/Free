import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { CalendarRange, ChevronDown, SlidersHorizontal, X, Search, Check } from 'lucide-react'
import { Button } from '../common/Button'
import { RefreshControl, ExportMenu } from '../common/TableControls'
import { RANGE_PRESETS, rangeLabel, CATEGORIES, OUTCOMES } from './auditFields'
import { todayDateInputValue } from '../../lib/format'
import { SEARCH_DEBOUNCE_MS } from '../../config/constants'

// ---------------------------------------------------------------------------
// Audit filter bar
// ---------------------------------------------------------------------------
// REBUILT AS A TOOLBAR, NOT A CARD. The previous version was a bordered,
// shadowed panel sitting directly above another bordered, shadowed panel
// (the table), two competing containers, and the filters looked heavier than
// the data they filter. Every console that does this well (CloudTrail, Okta's
// System Log, Entra sign-in logs) treats filters as *chrome attached to the
// table*: one quiet rule-separated strip, no card of its own.
//
// The other change is what the controls ARE. Native <select>s in a row read
// as a form you submit. These are facets: a labelled trigger that shows the
// current value, opens a small menu, and adds a removable chip when set ,
// so at a glance you can see what is filtered without reading five dropdowns.

function useDismiss(open, onClose) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && onClose()
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open, onClose])
  return ref
}

function triggerClass(active) {
  return clsx(
    'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors duration-150',
    'outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
    active
      ? 'border-blue-500/45 bg-blue-50 text-blue-700 dark:bg-blue-500/[0.12] dark:text-blue-200'
      : 'border-surface-700 bg-surface-900 text-ink-300 hover:border-surface-600 hover:text-ink-100'
  )
}

function Facet({ label, value, options, onChange, allLabel = 'Any' }) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const active = !!value

  return (
    <div ref={ref} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={triggerClass(active)}
      >
        <span className={active ? 'opacity-70' : 'text-ink-500'}>{label}</span>
        <span className="font-semibold">{active ? value : allLabel}</span>
        <ChevronDown className="h-3 w-3 flex-none opacity-60" strokeWidth={2.5} />
      </button>
      {open && (
        <div className="animate-menu-in absolute left-0 z-40 mt-1.5 min-w-[11rem] overflow-hidden rounded-xl border border-surface-700 bg-surface-900 p-1.5 shadow-overlay">
          <button
            type="button"
            onClick={() => {
              onChange('')
              setOpen(false)
            }}
            className={clsx(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
              !active ? 'bg-surface-800 font-medium text-ink-50' : 'text-ink-200 hover:bg-surface-850'
            )}
          >
            <Check className={clsx('h-3.5 w-3.5 flex-none', active && 'opacity-0')} strokeWidth={2.5} />
            {allLabel}
          </button>
          {options.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => {
                onChange(o)
                setOpen(false)
              }}
              className={clsx(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                value === o ? 'bg-surface-800 font-medium text-ink-50' : 'text-ink-200 hover:bg-surface-850'
              )}
            >
              <Check
                className={clsx('h-3.5 w-3.5 flex-none', value !== o && 'opacity-0')}
                strokeWidth={2.5}
              />
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function RangePicker({ range, onRangeChange, customFrom, customTo, onCustomFrom, onCustomTo }) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const active = range !== 'all'

  return (
    <div ref={ref} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={triggerClass(active)}
      >
        <CalendarRange className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
        <span className="font-semibold">
          {range === 'custom' && customFrom ? `${customFrom} → ${customTo || 'now'}` : rangeLabel(range)}
        </span>
        <ChevronDown className="h-3 w-3 flex-none opacity-60" strokeWidth={2.5} />
      </button>

      {open && (
        <div className="animate-menu-in absolute left-0 z-40 mt-1.5 w-60 overflow-hidden rounded-xl border border-surface-700 bg-surface-900 shadow-overlay">
          <div className="p-1.5">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  onRangeChange(p.key)
                  if (p.key !== 'custom') setOpen(false)
                }}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                  range === p.key
                    ? 'bg-surface-800 font-medium text-ink-50'
                    : 'text-ink-200 hover:bg-surface-850'
                )}
              >
                <Check
                  className={clsx('h-3.5 w-3.5 flex-none', range !== p.key && 'opacity-0')}
                  strokeWidth={2.5}
                />
                {p.label}
              </button>
            ))}
          </div>
          {range === 'custom' && (
            <div className="grid grid-cols-2 gap-2 border-t border-surface-800 bg-surface-850/60 p-3">
              <label className="flex flex-col gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-ink-500">From</span>
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || todayDateInputValue()}
                  onChange={(e) => onCustomFrom(e.target.value)}
                  className="h-8 rounded-lg border border-surface-700 bg-surface-900 px-2 text-xs text-ink-100 focus:border-blue-500 focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-ink-500">To</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom}
                  max={todayDateInputValue()}
                  onChange={(e) => onCustomTo(e.target.value)}
                  className="h-8 rounded-lg border border-surface-700 bg-surface-900 px-2 text-xs text-ink-100 focus:border-blue-500 focus:outline-none"
                />
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Chip({ label, value, onClear }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-surface-700 bg-surface-850 py-0.5 pl-2 pr-1 text-2xs">
      <span className="text-ink-500">{label}</span>
      <span className="min-w-0 truncate font-medium text-ink-200">{value}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label} filter`}
        className="flex h-4 w-4 flex-none items-center justify-center rounded text-ink-500 transition-colors hover:bg-surface-700 hover:text-ink-100"
      >
        <X className="h-2.5 w-2.5" strokeWidth={3} />
      </button>
    </span>
  )
}

export function AuditFilterBar({
  filters,
  set,
  reset,
  onRefresh,
  isFetching,
  updatedAt,
  onExportCsv,
  onExportJson,
  exportCount,
  actions,
  resultLabel,
}) {
  const [advanced, setAdvanced] = useState(false)
  const [searchInput, setSearchInput] = useState(filters.q)

  // Debounced free text: the field responds on every keystroke, the query key
  // only moves once typing settles.
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== filters.q) set('q', searchInput.trim())
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  // Keep the input honest when a chip or a drawer action clears the query
  // from outside this component.
  useEffect(() => {
    if (filters.q !== searchInput.trim()) setSearchInput(filters.q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.q])

  const chips = []
  if (filters.q)
    chips.push({ key: 'q', label: 'Search', value: filters.q, onClear: () => setSearchInput('') })
  if (filters.range !== 'all')
    chips.push({
      key: 'range',
      label: 'Range',
      value: rangeLabel(filters.range),
      onClear: () => set('range', 'all'),
    })
  if (filters.category)
    chips.push({
      key: 'category',
      label: 'Category',
      value: filters.category,
      onClear: () => set('category', ''),
    })
  if (filters.outcome)
    chips.push({
      key: 'outcome',
      label: 'Outcome',
      value: filters.outcome,
      onClear: () => set('outcome', ''),
    })
  if (filters.actor)
    chips.push({ key: 'actor', label: 'Actor', value: filters.actor, onClear: () => set('actor', '') })
  if (filters.action)
    chips.push({ key: 'action', label: 'Action', value: filters.action, onClear: () => set('action', '') })

  return (
    // Rounded top, no bottom border and no shadow: it is the top of the
    // table's own container, not a separate card floating above it.
    <div className="rounded-t-xl border border-b-0 border-surface-700/70 bg-surface-900">
      {/* Row 1, the search field spans the width, the way a log search should. */}
      <div className="flex items-center gap-2.5 border-b border-surface-800 px-3 py-2">
        <Search className="h-4 w-4 flex-none text-ink-500" strokeWidth={1.75} />
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search actions, actors, resources…"
          aria-label="Search audit entries"
          className="h-8 min-w-0 flex-1 border-0 bg-transparent text-sm text-ink-50 placeholder:text-ink-500 focus:outline-none"
        />
        {searchInput && (
          <button
            type="button"
            onClick={() => setSearchInput('')}
            className="flex-none rounded-md px-2 py-1 text-2xs font-medium text-ink-500 transition-colors hover:bg-surface-800 hover:text-ink-200"
          >
            Clear
          </button>
        )}
        <span className="flex flex-none items-center gap-1.5 border-l border-surface-800 pl-2.5">
          {onExportCsv && (
            <ExportMenu
              count={exportCount}
              disabled={!exportCount}
              onExportCsv={onExportCsv}
              onExportJson={onExportJson}
            />
          )}
          {actions}
          <RefreshControl onRefresh={onRefresh} isFetching={isFetching} updatedAt={updatedAt} />
        </span>
      </div>

      {/* Row 2, facets. */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        <RangePicker
          range={filters.range}
          onRangeChange={(v) => set('range', v)}
          customFrom={filters.from}
          customTo={filters.to}
          onCustomFrom={(v) => set('from', v)}
          onCustomTo={(v) => set('to', v)}
        />
        <Facet
          label="Category"
          value={filters.category}
          options={CATEGORIES}
          onChange={(v) => set('category', v)}
          allLabel="All"
        />
        <Facet
          label="Outcome"
          value={filters.outcome}
          options={OUTCOMES}
          onChange={(v) => set('outcome', v)}
          allLabel="All"
        />
        {/* Severity had a facet here. It is gone with the column: on this
 backend it restates Outcome in a second vocabulary, and a facet
 that narrows to what another facet already narrowed is a way to
 get zero results by accident. */}

        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          className={triggerClass(advanced || !!filters.actor || !!filters.action)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
          Advanced
        </button>

        {resultLabel && (
          <span className="ml-auto flex-none text-2xs tabular-nums text-ink-500">{resultLabel}</span>
        )}
      </div>

      {advanced && (
        <div className="flex flex-wrap items-end gap-3 border-t border-surface-800 bg-surface-850/40 px-3 py-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium uppercase tracking-[0.06em] text-ink-500">Actor</span>
            <input
              value={filters.actor}
              onChange={(e) => set('actor', e.target.value)}
              placeholder="username or ID"
              className="h-8 w-44 rounded-lg border border-surface-700 bg-surface-900 px-2.5 text-xs text-ink-100 placeholder:text-ink-500 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/20"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium uppercase tracking-[0.06em] text-ink-500">
              Exact action
            </span>
            <input
              value={filters.action}
              onChange={(e) => set('action', e.target.value)}
              placeholder="pam:vault:Reveal"
              className="h-8 w-56 rounded-lg border border-surface-700 bg-surface-900 px-2.5 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/20"
            />
          </label>
          <p className="ml-auto max-w-sm pb-1 text-2xs leading-relaxed text-ink-500">
            Search matches free text across the record.{' '}
            <span className="font-medium text-ink-400">Exact action</span> is a whole-string match , use one
            or the other, not both.
          </p>
        </div>
      )}

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-surface-800 bg-surface-850/40 px-3 py-2">
          <span className="text-xs font-semibold text-ink-600">Filtered by</span>
          {chips.map((c) => (
            <Chip key={c.key} label={c.label} value={c.value} onClear={c.onClear} />
          ))}
          <Button
            size="xs"
            variant="ghost"
            className="ml-1"
            onClick={() => {
              setSearchInput('')
              reset()
            }}
          >
            Clear all
          </Button>
        </div>
      )}
    </div>
  )
}

// The page owns this so the values sit in the react-query key.
export const EMPTY_AUDIT_FILTERS = {
  q: '',
  range: '7d',
  from: '',
  to: '',
  category: '',
  outcome: '',
  actor: '',
  action: '',
}
