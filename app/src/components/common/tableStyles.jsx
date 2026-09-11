import clsx from 'clsx'

// ---------------------------------------------------------------------------
// Table styling primitives
// ---------------------------------------------------------------------------
// FIXES THE FROZEN-COLUMN BUG. The tables used `bg-inherit` on their sticky
// cells and set the row colour on the `<tr>`. That does not work: a `<tr>`'s
// own background is `transparent` by default, and `hover:` classes on the row
// don't change what a child inherits at rest, so the frozen cells were
// effectively see-through and every column scrolled *underneath* them,
// producing the smeared, overlapping first column.
//
// A frozen cell must paint its own opaque background for every row state it
// can be in. That is what `stickyCell` does, and because the state lives in
// one place, selected/hover/plain can never disagree between the checkbox
// column and the name column next to it.
//
// It also adds the edge treatment every serious data grid has: a hairline
// plus a soft shadow on the right of the last frozen column, so the boundary
// between "frozen" and "scrolling" is visible rather than implied. Without
// it, a user scrolling right cannot tell why some columns stopped moving.

const ROW_BG = {
  // Explicit backgrounds, not bg-inherit. surface-900 is the panel plane.
  plain: 'bg-surface-900 group-hover:bg-surface-850',
  selected: 'bg-accent-soft group-hover:bg-accent-soft',
}

/**
 * Classes for a frozen (horizontally sticky) body cell.
 * @param {object} o
 * @param {string} o.left       Tailwind left offset class, e.g. 'left-0'
 * @param {boolean} o.selected  Row is selected
 * @param {boolean} o.edge      This is the LAST frozen column (gets the divider)
 */
export function stickyCell({ left = 'left-0', selected = false, edge = false } = {}) {
  return clsx(
    'sticky z-10 border-b border-surface-700/60 transition-colors',
    left,
    selected ? ROW_BG.selected : ROW_BG.plain,
    edge &&
      'after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-surface-700 after:content-[""]',
    edge && 'shadow-[6px_0_8px_-6px_rgba(15,23,42,0.16)] dark:shadow-[6px_0_10px_-6px_rgba(0,0,0,0.55)]'
  )
}

/** Matching classes for the frozen cells in the header row. */
export function stickyHeader({ left = 'left-0', edge = false } = {}) {
  return clsx(
    'sticky top-0 z-30 border-b border-surface-700 bg-surface-850',
    left,
    edge &&
      'after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-surface-700 after:content-[""]',
    edge && 'shadow-[6px_0_8px_-6px_rgba(15,23,42,0.16)] dark:shadow-[6px_0_10px_-6px_rgba(0,0,0,0.55)]'
  )
}

/** Ordinary (non-frozen) body cell. */
export function cell({ selected = false, className } = {}) {
  return clsx(
    'border-b border-surface-700/60 transition-colors',
    selected ? ROW_BG.selected : ROW_BG.plain,
    className
  )
}

// ---------------------------------------------------------------------------
// Column sizing
// ---------------------------------------------------------------------------
// The other half of the complaint: "columns with big data have the same size
// as everything else". An auto-layout table gives every column a share of the
// width based on its *content*, so a 36-character hostname and a 3-character
// port fight for the same space and both end up wrong.
//
// The fix is the one every enterprise grid uses: declare an intended width
// per column, let the browser lay the table out with `table-fixed`, and
// truncate overflow with the full value on `title`. Data-shaped columns
// (host, port, counts, timestamps) get exactly what they need; the name
// column gets the remainder.
// THE WIDTHS CHANGED, and this is the fix for "the table looks empty and the
// name is the only thing truncating".
//
// Before, the identity column was pinned at 18rem while five data columns
// took 9 to 11.5rem each. On a 1080px grid that handed roughly 780px to
// columns whose content is 6 to 12 characters, and left the one column that
// actually varies, the object's name, clipping at 18rem. Every screenshot
// showed the same thing: oceans of empty cell next to a truncated hostname.
//
// Now the data columns are sized to their CONTENT and `name` is `w-auto`, so
// it absorbs whatever is left over. Under `table-fixed` an auto column takes
// the remainder after the fixed ones are satisfied, which is exactly the
// behaviour every serious grid (AWS Console, Azure Portal, Snowflake) uses:
// fixed metadata, flexible identity.
export const COL = {
  select: 'w-10',
  // The identity column gets a generous fixed share rather than "everything
  // left over": on a wide monitor the leftover is 500px of nothing between a
  // hostname and the first data column, which reads as a broken layout.
  name: 'w-[24rem] min-w-[16rem]',
  wide: 'w-[14rem]',
  medium: 'w-[10rem]',
  short: 'w-[8rem]',
  status: 'w-[8.5rem]',
  count: 'w-[5.5rem]',
  timestamp: 'w-[10.5rem]',
  actions: 'w-[6rem]',
  // The slack column. Exactly one per table, always last, so surplus width
  // pools at the trailing edge instead of stretching a column that has
  // nothing to put in it.
  flex: 'w-auto',
}

// Truncating cell content: one class set, so no table forgets the title
// attribute that makes truncation acceptable.
export function TruncCell({ value, className, mono = false, muted = false }) {
  const empty = value === null || value === undefined || value === ''
  const text = empty ? '-' : String(value)
  return (
    <span
      title={empty ? undefined : text}
      className={clsx(
        'block truncate',
        mono && 'font-mono text-xs',
        empty ? 'text-ink-600' : muted ? 'text-ink-400' : 'text-ink-100',
        className
      )}
    >
      {text}
    </span>
  )
}
