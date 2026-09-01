import { AlertTriangle } from 'lucide-react'

/**
 * Says out loud that a list is showing a prefix of the data rather than all of
 * it.
 *
 * WHY THIS EXISTS. Four list endpoints (identity, roles, policies and the
 * resource catalogue) take no page parameters and used to answer with every
 * matching row, so one request read a whole table into memory and then into the
 * browser. They are now capped server-side and report `truncated` when the cap
 * bit. A cap nobody is told about is the same failure as a count of zero for a
 * read that errored: the screen looks complete and is not, and somebody
 * concludes an account does not exist because it fell off the end.
 *
 * Render it only when the flag is true. When the list fits, there is nothing to
 * say and nothing is drawn.
 */
export function TruncationNotice({ limit, noun = 'rows', hint = 'Search to narrow the list.' }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-50/60 px-3.5 py-2.5 dark:bg-amber-950/15"
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400"
        strokeWidth={1.9}
      />
      <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300/90">
        Showing the first {limit?.toLocaleString?.() ?? limit} {noun}. There are more than this
        install returns in one read, so what you see below is not the whole set. {hint}
      </p>
    </div>
  )
}
