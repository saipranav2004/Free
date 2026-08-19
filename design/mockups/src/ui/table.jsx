import clsx from 'clsx'
import { createContext, useContext } from 'react'

// ---------------------------------------------------------------------------
// The table — the primary instrument in this product (Phase 4.5).
// ---------------------------------------------------------------------------
// Carried over from the existing build BECAUSE IT IS CORRECT and was hard-won:
//   • table-fixed with declared column widths, so a 36-char hostname and a
//     4-char port don't fight for the same space;
//   • frozen cells paint their OWN opaque background for every row state
//     (the `bg-inherit` version smeared the first column on horizontal scroll);
//   • truncation always carries a title attribute.
// What changed is only styling: no zebra, no blue selection tint, 36/32px rows,
// right-aligned numerics, actions revealed on hover.

const DensityCtx = createContext('default')
export const useDensity = () => useContext(DensityCtx)

// Widths are chosen so the ESSENTIAL columns of every table in the product fit
// inside the 1136px content area a 1440px viewport leaves after the 240px
// sidebar and the 32px gutters. Anything wider scrolls inside the table's own
// container — never the page (Phase 6).
export const COL = {
  select: 'w-10',
  status: 'w-6',
  name: 'w-[13rem] min-w-[13rem]',
  wide: 'w-[13rem]',
  medium: 'w-[9rem]',
  short: 'w-[7.5rem]',
  count: 'w-[5.5rem]',
  timestamp: 'w-[8rem]',
  actions: 'w-[6rem]',
}

export function DataTable({ children, density = 'default', className, minWidth = '68rem' }) {
  return (
    <DensityCtx.Provider value={density}>
      {/* Horizontal scroll lives on THIS container, never on the page body —
          the page must never scroll sideways (Phase 6). */}
      <div className={clsx('overflow-x-auto rounded-lg border border-line bg-surface', className)}>
        <table className="w-full table-fixed border-collapse text-left" style={{ minWidth }}>
          {children}
        </table>
      </div>
    </DensityCtx.Provider>
  )
}

export function Th({ children, className, align = 'left', sticky = false, left = 'left-0', edge = false, width }) {
  return (
    <th
      scope="col"
      className={clsx(
        'sticky top-0 z-20 h-8 border-b border-line bg-subtle px-3 text-micro font-semibold uppercase text-tertiary',
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

export function Td({ children, className, align = 'left', sticky = false, left = 'left-0', edge = false, selected = false }) {
  const density = useDensity()
  return (
    <td
      className={clsx(
        'border-b border-line px-3 text-sm text-primary',
        density === 'compact' ? 'h-8' : 'h-9',
        align === 'right' && 'text-right tabular',
        // A frozen cell must paint its own opaque background for EVERY row
        // state — this is the fix the current build documents at length.
        sticky && clsx('sticky z-10', left),
        sticky && (selected ? 'bg-subtle' : 'bg-surface group-hover:bg-hover'),
        edge && 'after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-line after:content-[""]',
        selected && 'shadow-[inset_2px_0_0_0_rgb(var(--border-strong))]',
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

// Row actions: present in the DOM (so they're keyboard-reachable and readable
// by AT), visually revealed on hover/focus on pointer devices, always visible
// on touch where there is no hover.
export function RowActions({ children }) {
  return (
    <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity duration-100 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
      {children}
    </div>
  )
}
