import clsx from 'clsx'
import { createContext, useContext } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'

// ---------------------------------------------------------------------------
// The table — the primary instrument in this product (Phase 4.5).
// ---------------------------------------------------------------------------
// Carried over from the existing build BECAUSE IT IS CORRECT and was hard-won:
//   • table-fixed with declared column widths, so a 36-char hostname and a
//     4-char port don't fight for the same space;
//   • frozen cells paint their OWN opaque background for every row state
//     (the `bg-inherit` version smeared the first column on horizontal scroll);
//   • truncation always carries a title attribute.
//
// REVISION 2 — what pass 1 got wrong here:
//   • Rows were 36px with a 32px header. Against an AWS/Azure/Okta list that
//     is one notch too loose: an operator with 300 privileged accounts sees
//     ~14 rows per screen instead of ~20. Comfortable is now 32px, and a
//     COMPACT mode (26px) is a real, persisted control rather than a line in
//     a spec document.
//   • Row actions were revealed on hover. That fails for keyboard, fails on
//     touch, and — the real cost — makes a list un-scannable, because you
//     cannot see which rows even have an action without pointing at each one.
//     Actions are visible now; hover only changes their emphasis.
//   • There was no sort, and no select-all. Both exist in the app being
//     redesigned (TableControls.jsx), so their absence was a regression.

const DensityCtx = createContext({ density: 'comfortable', setDensity: () => {} })
export const useDensity = () => useContext(DensityCtx)
export const DensityProvider = DensityCtx.Provider

const ROW_H = { comfortable: 'h-8', compact: 'h-[26px]' }

export const COL = {
  select: 'w-9',
  status: 'w-6',
  name: 'w-[13rem] min-w-[13rem]',
  wide: 'w-[13rem]',
  medium: 'w-[9rem]',
  short: 'w-[7.5rem]',
  count: 'w-[5.5rem]',
  timestamp: 'w-[8rem]',
  actions: 'w-[6rem]',
}

export function DataTable({ children, className, minWidth = '68rem' }) {
  return (
    // Horizontal scroll lives on THIS container, never on the page body.
    <div className={clsx('overflow-x-auto rounded-lg border border-line bg-surface', className)}>
      <table className="w-full table-fixed border-collapse text-left" style={{ minWidth }}>
        {children}
      </table>
    </div>
  )
}

export function Th({ children, className, align = 'left', sticky = false, left = 'left-0', edge = false, width }) {
  return (
    <th
      scope="col"
      className={clsx(
        'sticky top-0 z-20 h-7 border-b border-line bg-subtle px-3 text-micro font-semibold uppercase text-tertiary',
        align === 'right' && 'text-right',
        sticky && clsx('z-30', left),
        edge && 'after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-line after:content-[""]',
        width,
        className
      )}
    >
      {children}
    </th>
  )
}

/**
 * A sortable column header. Three states — unsorted, asc, desc — and the
 * glyph is always present so a user can tell which columns are sortable
 * without hovering every one (the AWS/Azure convention).
 */
export function SortTh({ children, columnKey, sort, onSort, align = 'left', ...rest }) {
  const active = sort?.key === columnKey
  const dir = active ? sort.dir : null
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <Th align={align} {...rest}>
      <button
        type="button"
        onClick={() => onSort?.(columnKey)}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={clsx(
          'group -mx-1 inline-flex h-full max-w-full items-center gap-1 rounded px-1 text-micro font-semibold uppercase',
          align === 'right' && 'flex-row-reverse',
          active ? 'text-primary' : 'text-tertiary hover:text-primary'
        )}
      >
        <span className="truncate">{children}</span>
        <Icon
          className={clsx('h-3 w-3 flex-none', active ? 'opacity-100' : 'opacity-40 group-hover:opacity-80')}
          strokeWidth={2}
        />
      </button>
    </Th>
  )
}

export function Tr({ children, selected = false, onClick, className }) {
  return (
    <tr
      onClick={onClick}
      className={clsx(
        'group',
        onClick && 'cursor-pointer',
        selected ? 'bg-subtle' : 'bg-surface hover:bg-hover',
        className
      )}
    >
      {children}
    </tr>
  )
}

export function Td({ children, className, align = 'left', sticky = false, left = 'left-0', edge = false, selected = false, colSpan }) {
  const { density } = useDensity()
  return (
    <td
      colSpan={colSpan}
      className={clsx(
        'border-b border-line px-3 text-sm text-primary',
        ROW_H[density],
        align === 'right' && 'text-right tabular',
        // A frozen cell must paint its own opaque background for EVERY row
        // state — this is the fix the current build documents at length.
        sticky && clsx('sticky z-10', left),
        sticky && (selected ? 'bg-subtle' : 'bg-surface group-hover:bg-hover'),
        edge && 'after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-line after:content-[""]',
        selected && 'shadow-[inset_2px_0_0_0_rgb(var(--accent))]',
        className
      )}
    >
      {children}
    </td>
  )
}

// Truncate + title. Never wrap a table cell to a second line.
export function Trunc({ value, mono = false, muted = false, className }) {
  const text = value === null || value === undefined || value === '' ? '—' : String(value)
  return (
    <span
      title={text !== '—' ? text : undefined}
      className={clsx('block truncate', mono && 'font-mono text-xs', muted ? 'text-tertiary' : 'text-primary', className)}
    >
      {text}
    </span>
  )
}

/**
 * Row actions. Always in the DOM AND always visible — hover only lifts the
 * emphasis. See the revision note at the top of this file.
 *
 * A DESTRUCTIVE row action belongs in the overflow menu, not on the row.
 * Six red buttons stacked down a table's right edge is a red stripe, and a
 * red stripe on a list of healthy sessions means nothing. AWS Console and
 * Azure Portal both put row-level destructive actions behind a "⋯" — the row
 * stays quiet, and reaching the dangerous thing takes one deliberate click.
 */
export function RowActions({ children }) {
  return <div className="flex items-center justify-end gap-1">{children}</div>
}

/** Header checkbox: none / some / all. */
export function SelectAll({ total, selected, onChange, label = 'Select all rows' }) {
  const all = total > 0 && selected === total
  const some = selected > 0 && selected < total
  return (
    <input
      type="checkbox"
      checked={all}
      ref={(el) => {
        if (el) el.indeterminate = some
      }}
      onChange={() => onChange(all ? [] : 'all')}
      aria-label={label}
      className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
    />
  )
}

export function RowCheckbox({ checked, onChange, label }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
    />
  )
}

/** Generic client-side comparator used by every sortable list in the mockups. */
export function sortRows(rows, sort, accessors = {}) {
  if (!sort?.key) return rows
  const get = accessors[sort.key] || ((r) => r[sort.key])
  const dir = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = get(a)
    const bv = get(b)
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir
  })
}

export function nextSort(current, key) {
  if (current?.key !== key) return { key, dir: 'asc' }
  if (current.dir === 'asc') return { key, dir: 'desc' }
  return { key: null, dir: null }
}
