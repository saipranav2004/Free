import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import clsx from 'clsx'

// ---------------------------------------------------------------------------
// Pagination, the console's one pager.
// ---------------------------------------------------------------------------
// Layout follows the enterprise convention (Okta, Entra ID, SailPoint all
// land on the same three zones):
//
//   Showing 1–25 of 1,284        Rows: [25 ▾]        ⏮ ◀ 1 2 3 … 52 ▶ ⏭
//
// It is presentation only: it never fetches, never mutates, and never
// clamps state behind the caller's back, it just refuses to emit an
// out-of-range page. Works identically for client-side paging (the current
// reality, since these endpoints return whole collections) and for
// server-side paging later, because the props are the same shape the
// backend's paged() helper already returns: { page, page_size, total,
// total_pages }.

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

// Windowed page numbers with ellipses. Always shows first and last so the
// ends of a long result set stay one click away.
function pageWindow(page, totalPages, span = 1) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const out = new Set([1, totalPages, page])
  for (let i = 1; i <= span; i++) {
    if (page - i > 1) out.add(page - i)
    if (page + i < totalPages) out.add(page + i)
  }
  // Keep the window a constant width so the control doesn't resize as you
  // walk through pages, jitter in a pager reads as a bug.
  if (page <= 3) [2, 3, 4].forEach((p) => p < totalPages && out.add(p))
  if (page >= totalPages - 2)
    [totalPages - 1, totalPages - 2, totalPages - 3].forEach((p) => p > 1 && out.add(p))

  const sorted = [...out].sort((a, b) => a - b)
  const withGaps = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) withGaps.push('gap-' + p)
    withGaps.push(p)
  })
  return withGaps
}

const NAV_BTN =
  'inline-flex h-7 min-w-[1.75rem] flex-none items-center justify-center rounded-md px-1.5 text-xs font-medium ' +
  'transition-colors duration-150 disabled:pointer-events-none disabled:opacity-35'

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
  className,
  label = 'items',
}) {
  const pages = Math.max(totalPages || 0, 0)

  // A single page of results still shows the count and the page-size
  // selector, hiding the whole bar means the user loses "how many are
  // there?" and "show me more per page" the moment a filter narrows things.
  if (!total) return null

  const canPrev = page > 1
  const canNext = page < pages
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  const go = (p) => {
    if (p >= 1 && p <= pages && p !== page) onPageChange(p)
  }

  return (
    <div
      className={clsx(
        'flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-surface-800 bg-surface-850/50 px-4 py-2.5',
        className
      )}
    >
      <p className="text-xs tabular-nums text-ink-400">
        Showing <span className="font-semibold text-ink-100">{start.toLocaleString()}</span>–
        <span className="font-semibold text-ink-100">{end.toLocaleString()}</span> of{' '}
        <span className="font-semibold text-ink-100">{total.toLocaleString()}</span> {label}
      </p>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {onPageSizeChange && (
          <label className="flex items-center gap-2 text-xs text-ink-400">
            <span className="whitespace-nowrap">Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-8 cursor-pointer rounded-lg border border-line-strong bg-surface pl-2.5 pr-8 text-xs font-medium text-primary transition-colors hover:border-primary/40 focus:border-accent focus:outline-none"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}

        {pages > 1 && (
          <nav className="flex items-center gap-1" aria-label="Pagination">
            <button
              type="button"
              onClick={() => go(1)}
              disabled={!canPrev}
              aria-label="First page"
              className={clsx(NAV_BTN, 'text-ink-400 hover:bg-surface-800 hover:text-ink-50')}
            >
              <ChevronsLeft className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => go(page - 1)}
              disabled={!canPrev}
              aria-label="Previous page"
              className={clsx(NAV_BTN, 'text-ink-400 hover:bg-surface-800 hover:text-ink-50')}
            >
              <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
            </button>

            <span className="flex items-center gap-1">
              {pageWindow(page, pages).map((p) =>
                typeof p === 'string' ? (
                  <span key={p} className="px-1 text-xs text-ink-600" aria-hidden="true">
                    …
                  </span>
                ) : (
                  <button
                    key={p}
                    type="button"
                    onClick={() => go(p)}
                    aria-current={p === page ? 'page' : undefined}
                    className={clsx(
                      NAV_BTN,
                      'tabular-nums',
                      p === page
                        ? 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-400/25'
                        : 'text-ink-400 hover:bg-surface-800 hover:text-ink-50'
                    )}
                  >
                    {p}
                  </button>
                )
              )}
            </span>

            <button
              type="button"
              onClick={() => go(page + 1)}
              disabled={!canNext}
              aria-label="Next page"
              className={clsx(NAV_BTN, 'text-ink-400 hover:bg-surface-800 hover:text-ink-50')}
            >
              <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => go(pages)}
              disabled={!canNext}
              aria-label="Last page"
              className={clsx(NAV_BTN, 'text-ink-400 hover:bg-surface-800 hover:text-ink-50')}
            >
              <ChevronsRight className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </nav>
        )}
      </div>
    </div>
  )
}
