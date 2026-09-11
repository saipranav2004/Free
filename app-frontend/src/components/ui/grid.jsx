import { createContext, useContext, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'

// ---------------------------------------------------------------------------
// The data grid
// ---------------------------------------------------------------------------
// This is the primary instrument in the product, and it is the piece that
// decided whether the console read as an enterprise tool or as an admin
// template. The rules, and what each one is fixing:
//
//   44px ROWS, ONE LINE, 16px CELL PADDING. Measured against the published
// band for enterprise grids, condensed 40px / regular 48px / relaxed 56px,
// and against Cloudscape's rule that comfortable must be the default
// because compact "can hinder readability for users with vision
// impairment". The build this replaces sat at 58 to 63px with a two line
// identity cell, so a 1440x900 screen showed nine resources. The mockup
// this ports from sat at 32px with 12px padding, which is below every
// cited standard: denser is not automatically better, and a 32px row with
// a 12px gutter is a spreadsheet. 44px shows about fifteen rows, keeps a
// real click target, and 16px horizontal padding gives the 32px between
// column gutter the measured rule asks for. Compact is 36px and persists.
//
//   STATUS IS A DOT, IN THE IDENTITY CELL. A dedicated "Status" column that
// is populated on every row spends 8rem of width on a word the colour
// already said. The dot rides next to the name where the eye already is,
// and the word stays in the title attribute and in the detail view.
//
//   MACHINE IDENTIFIERS ARE MONOSPACE. Hostnames, ports, emails, IDs and
// hashes are compared character by character, and a proportional font makes
// that harder for no gain.
//
//   NUMBERS ARE RIGHT ALIGNED AND TABULAR, so digits line up by place value
// and a column of ports or counts can be scanned vertically.
//
//   NO ELEVATION. Amazon's own console update replaced drop shadows with
// thinner strokes on cards, panels and containers and reserved shadow for
// transient elements, because shadow on a static surface is visual noise.
//   A page of soft shadowed rounded rectangles floating on grey is the most
// recognisable signature of an admin template.
//
//   ROW ACTIONS ARE ALWAYS VISIBLE. Revealing them on hover fails for
// keyboard, fails on touch, and makes the list un-scannable because you
// cannot see which rows have an action without pointing at each one. Hover
// raises their emphasis, it does not create them. Destructive actions live
// in the overflow menu: six red buttons down a table's right edge is a red
// stripe, and a red stripe over healthy rows means nothing.
//
// table-fixed WITH DECLARED WIDTHS, so a 36 character hostname and a four
// character port do not fight for the same space. Frozen cells paint their
// own opaque background for every row state, otherwise columns scroll
// visibly underneath them.

const DensityCtx = createContext({ density: 'comfortable', setDensity: () => {} })
export const useDensity = () => useContext(DensityCtx)

const DENSITY_KEY = 'pam_grid_density'

// One preference for every grid in the console. A per page density control
// that forgets itself on navigation is worse than none.
export function DensityProvider({ children }) {
  const [density, setDensityRaw] = useState(() => {
    try {
      return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable'
    } catch {
      return 'comfortable'
    }
  })
  const setDensity = (next) => {
    setDensityRaw(next)
    try {
      localStorage.setItem(DENSITY_KEY, next)
    } catch {
      /* private browsing, the preference just will not persist */
    }
  }
  return <DensityCtx.Provider value={{ density, setDensity }}>{children}</DensityCtx.Provider>
}

const ROW_H = { comfortable: 'h-11', compact: 'h-9' }
const HEAD_H = 'h-10'

// Columns are ordered by importance left to right and sized to their content,
// so the identity column is the only one that has to truncate.
export const COL = {
  select: 'w-11',
  name: 'w-[17rem] min-w-[14rem]',
  wide: 'w-[14rem]',
  medium: 'w-[10rem]',
  short: 'w-[8.5rem]',
  count: 'w-[6.5rem]',
  timestamp: 'w-[10rem]',
  actions: 'w-[7rem]',
}

/**
 * @param {string} [label] Accessible name for the table.
 *
 * A screen reader announces a table by its name, and without one it announces
 * "table" and leaves the listener to infer the rest from the column headers.
 * On a page holding two of them, as the service identity view does with tokens
 * and grants, that is the difference between knowing which list you are in and
 * counting headers. Optional so existing call sites keep working, but every new
 * one should pass it.
 */
export function DataTable({ children, className, minWidth = '68rem', label }) {
  return (
    // Horizontal scroll lives on THIS container, never on the page body.
    <div className={clsx('overflow-x-auto overscroll-x-contain', className)}>
      <table
        aria-label={label}
        // dt-rows is what makes rows arrive in reading order. The stagger is
        // pure CSS off nth-child (see index.css), so it reaches every table in
        // the product from here without a single page passing an index down.
        className="dt-rows w-full table-fixed border-collapse text-left"
        style={{ minWidth }}
      >
        {children}
      </table>
    </div>
  )
}

export function Th({
  children,
  className,
  align = 'left',
  sticky = false,
  left = 'left-0',
  edge = false,
  width,
}) {
  return (
    <th
      scope="col"
      className={clsx(
        // Sentence case at 13px with weight, not 11px uppercase with wide
        // tracking. AWS's own update moved label prominence onto weight and
        // colour rather than onto capitals, and an uppercase micro header is
        // the loudest admin-template tell in a data grid.
        'sticky top-0 z-20 border-b border-line bg-subtle px-4 text-xs font-bold text-primary',
        HEAD_H,
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

// Three states: unsorted, ascending, descending. The glyph is always present
// so a reader can tell which columns are sortable without hovering every one.
export function SortTh({ children, columnKey, sort, onSort, align = 'left', ...rest }) {
  const active = sort?.key === columnKey
  const dir = active ? sort.dir : null
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown
  return (
    // aria-sort BELONGS ON THE HEADER CELL, not on the button inside it. It is
    // only defined for a columnheader/rowheader, so on a <button> it is an
    // unsupported attribute that assistive technology drops: the column
    // announced no sort state at all, which is the one thing the attribute
    // exists to convey. Moving it up one level is the whole fix.
    <Th align={align} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} {...rest}>
      <button
        type="button"
        onClick={() => onSort?.(columnKey)}
        aria-label={`Sort by ${typeof children === 'string' ? children : columnKey}`}
        className={clsx(
          'group -mx-1 inline-flex h-full max-w-full items-center gap-1.5 rounded px-1 text-xs font-bold',
          align === 'right' && 'flex-row-reverse',
          active ? 'text-accent' : 'text-primary hover:text-accent'
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

/**
 * A row. Pass `to` and the WHOLE row opens that record, which is how Okta's
 * People list and Entra's user blade behave: a 44px band that looks entirely
 * clickable should be entirely clickable, not a link occupying 15% of it.
 *
 * Three things it deliberately does not do:
 *
 *   - It never hijacks a click that landed on something which already does
 *     something of its own: a checkbox, a row menu, a link, a button.
 *   - It never swallows a modifier click. Cmd-click, middle-click and
 *     shift-click belong to the identity link inside the row, which is a real
 *     anchor and opens a real new tab.
 *   - It never fires when the click ended a text selection, because dragging
 *     across a cell to copy an ID is not a request to navigate.
 *
 * The row itself is NOT a tab stop. The identity cell already holds a real
 * link, so keyboard users have a path; making the row focusable too would put
 * two stops on every record and read the name twice.
 */
export function Tr({ children, selected = false, onClick, to, tone, className }) {
  const navigate = useNavigate()
  const interactive = !!(to || onClick)

  const handleClick = (event) => {
    if (!interactive) return
    if (event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (event.target.closest('a, button, input, select, textarea, label, [role="menuitem"]')) return
    if (window.getSelection()?.toString()) return
    if (to) navigate(to)
    else onClick?.(event)
  }

  return (
    <tr
      onClick={handleClick}
      className={clsx(
        'group',
        interactive && 'cursor-pointer',
        // A row you can open reserves three pixels at its leading edge and
        // fills them on hover, so the pointer lands on something already
        // shaped for it and nothing shifts. Excluded when selected: that row
        // draws its own spine on the Td below, and two spines in the same
        // three pixels is a fight, not a state.
        //
        // `tone` claims the same three pixels PERMANENTLY for a row that needs
        // to be found rather than hovered: a service identity that can read
        // every path, a grant about to expire under a job. It replaces the
        // hover gutter rather than sitting beside it, for the same reason
        // selection does.
        interactive && !selected && !tone && 'row-spine',
        !selected && tone === 'danger' && 'row-spine-danger',
        !selected && tone === 'warn' && 'row-spine-warn',
        selected ? 'bg-subtle' : 'bg-surface hover:bg-hover',
        className
      )}
    >
      {children}
    </tr>
  )
}

export function Td({
  children,
  className,
  align = 'left',
  sticky = false,
  left = 'left-0',
  edge = false,
  selected = false,
  colSpan,
}) {
  const { density } = useDensity()
  return (
    <td
      colSpan={colSpan}
      className={clsx(
        // 16px horizontal padding, so two adjacent columns are 32px apart.
        // This is the measured minimum, and it is what stops a dense table
        // reading as cramped even though the rows are tight.
        'border-b border-line-soft px-4 text-sm text-primary',
        ROW_H[density],
        align === 'right' && 'text-right tabular',
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

// Truncate plus title. A table cell never wraps to a second line: one tall
// row sets the height of every row around it and the grid stops being a grid.
export function Trunc({ value, mono = false, muted = false, className, title }) {
  const empty = value === null || value === undefined || value === ''
  const text = empty ? '-' : String(value)
  return (
    <span
      title={empty ? undefined : title || text}
      className={clsx(
        'block truncate',
        mono && 'font-mono text-xs',
        empty ? 'text-tertiary' : muted ? 'text-tertiary' : 'text-primary',
        className
      )}
    >
      {text}
    </span>
  )
}

export function RowActions({ children }) {
  return <div className="flex items-center justify-end gap-1">{children}</div>
}

// none / some / all, with the indeterminate box the middle state needs.
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
      onChange={() => onChange(all)}
      aria-label={label}
      className="h-3.5 w-3.5 cursor-pointer accent-[rgb(var(--accent))]"
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
      className="h-3.5 w-3.5 cursor-pointer accent-[rgb(var(--accent))]"
    />
  )
}

// A grid needs a body even when it has no rows, or the header floats over
// nothing and the panel collapses.
export function EmptyRow({ colSpan, children }) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="border-b border-line-soft px-4 py-12 text-center text-sm text-tertiary"
      >
        {children}
      </td>
    </tr>
  )
}

// Skeleton rows that match the grid's own geometry, so the panel does not
// change height between loading and loaded.
export function SkeletonGrid({ colSpan, rows = 10 }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          <td colSpan={colSpan} className="h-11 border-b border-line-soft px-4">
            <span className="skeleton block h-3 w-full max-w-[32rem] rounded" />
          </td>
        </tr>
      ))}
    </>
  )
}

export function nextSort(current, key) {
  if (current?.key !== key) return { key, dir: 'asc' }
  if (current.dir === 'asc') return { key, dir: 'desc' }
  return { key: null, dir: null }
}

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

// Keeps the page from scrolling sideways when a grid is wider than its panel.
export function useGridOverflowGuard(ref) {
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const onWheel = (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.stopPropagation()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref])
}
