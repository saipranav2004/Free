import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

// ---------------------------------------------------------------------------
// A tab that lives in the URL
// ---------------------------------------------------------------------------
// Every tabbed page in this console used to hold its tab in useState, which
// meant the tab existed only inside one mounted component. Three things a
// person expects from a website did not work:
//
//   A LINK COULD NOT NAME A TAB.  The dashboard's "Break-glass active" tile and
//     its "Open break-glass" finding both linked to /admin/jit, which opens on
//     Requests. Clicking the number for break-glass grants landed you on a
//     different queue and left you to find the right tab yourself. Same for
//     "Active grants" and for the user dashboard's grant tiles.
//   BACK DID NOT COME BACK.       Switching tabs left no history, so the back
//     button skipped past the whole page.
//   A URL COULD NOT BE SHARED.    Pasting someone the break-glass queue meant
//     pasting the page and telling them which tab to click.
//
// SettingsPage already solved this with `?tab=`; this is that solution as one
// hook, so the pages cannot drift apart in how they spell it.
//
// `replace` is the default for the same reason SettingsPage uses it: clicking
// through four tabs on one page should not put four entries in the history and
// make the back button feel broken in the other direction. The entry that
// brought you to the page is the one worth going back to.

/**
 * @param {string[]} keys      valid tab keys, in display order
 * @param {string}   fallback  the tab an absent or unrecognised value means
 * @param {string}   [param]   query parameter name, default 'tab'
 * @returns {[string, (key: string) => void]}
 */
export function useUrlTab(keys, fallback, param = 'tab') {
  const [params, setParams] = useSearchParams()

  const requested = params.get(param)
  // An unknown value falls back rather than rendering nothing, so a stale
  // bookmark or a hand-edited URL opens the page instead of an empty frame.
  const active = keys.includes(requested) ? requested : fallback

  const setActive = useCallback(
    (key) => {
      const next = new URLSearchParams(params)
      // The default tab is spelled by leaving the parameter off, which keeps
      // the bare path canonical: /admin/jit and /admin/jit?tab=requests are
      // the same view and should not be two different URLs.
      if (key === fallback) next.delete(param)
      else next.set(param, key)
      setParams(next, { replace: true })
    },
    [params, setParams, fallback, param]
  )

  return [active, setActive]
}
