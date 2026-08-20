import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Search, CornerDownLeft, Loader2, Boxes, Vault, Users, SearchX, X } from 'lucide-react'
import { quickJumpTargets } from '../../config/nav'
import { listResources } from '../../api/resources'
import { listSafes } from '../../api/vault'
import { listUsers } from '../../api/identity'
import { SEARCH_DEBOUNCE_MS } from '../../config/constants'

// ---------------------------------------------------------------------------
// Global search, an anchored navbar dropdown, not a centred palette
// ---------------------------------------------------------------------------
// WHAT CHANGED AND WHY. This used to be a command-palette overlay: clicking
// the navbar field dimmed the whole console, locked body scroll, and floated
// a 38rem panel at 10vh. Three problems with that for THIS product:
//
//   1. It broke the mental model. The control is a search FIELD sitting in
// the navbar. Clicking a field should put a cursor in that field, not
// hide the page and open a different field somewhere else. Users
// reported it as "it opens a popup", which is exactly right.
//   2. It was disproportionate. A full-screen modal is the correct weight for
// a command palette that can run destructive actions. This searches
// pages, resources, safes and accounts and then navigates. That is a
// lookup, and a lookup does not earn a scrim.
//   3. It destroyed context. Dimming the table you were reading in order to
// find a row in it is backwards.
//
// The shape now is the one Stripe, Linear, Google Cloud and Amazon all use
// for exactly this job: type in place, results drop from the field, page
// stays lit and readable behind. The panel is anchored to the input, matched
// to its width (with a sensible minimum), and closes on Escape, on blur-out,
// or on selection.
//
// KEPT FROM THE PREVIOUS VERSION, because these were right:
//   · ⌘K / "/" focus the field (they no longer open a separate surface).
//   · Pages resolve instantly and locally; resources, safes and accounts are
// fetched ONCE on first focus, cached 60s, and matched in the browser ,
// those endpoints return whole collections and take no query parameter,
// so per-keystroke requests would be strictly slower.
//   · Deterministic ranking: exact, prefix, word-boundary, substring, with
// pages weighted above records.
//   · Not a command palette. Page-level ACTIONS still need an action registry
// that doesn't exist; offering actions we can't run would be worse than a
// search that says exactly what it searches.

const GROUP_META = {
  Console: { icon: null, hint: 'Page' },
  'Admin Center': { icon: null, hint: 'Page' },
  Account: { icon: null, hint: 'Page' },
  Resources: { icon: Boxes, hint: 'Resource' },
  Vault: { icon: Vault, hint: 'Safe' },
  Accounts: { icon: Users, hint: 'User' },
}

// Higher is better. Returns 0 for "no match" so callers can filter on it.
function score(haystack, needle) {
  if (!haystack) return 0
  const h = String(haystack).toLowerCase()
  if (h === needle) return 100
  if (h.startsWith(needle)) return 80 - Math.min(h.length - needle.length, 20)
  const wordStart = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  if (wordStart.test(h)) return 60
  if (h.includes(needle)) return 40
  return 0
}

function bestScore(fields, needle) {
  let best = 0
  for (const f of fields) {
    const s = score(f, needle)
    if (s > best) best = s
  }
  return best
}

export function GlobalSearch({ isAdmin = false }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState('')
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const wrapRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  // Only start fetching once the field has been focused at least once, the
  // navbar must not pull three collections on every page load.
  const [primed, setPrimed] = useState(false)

  // ⌘K and "/" now FOCUS the field rather than opening a separate surface.
  // The shortcut and the click land in the same place, which is the whole
  // point of moving the search into the navbar.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        setOpen(true)
        return
      }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = document.activeElement
        const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        if (!typing) {
          e.preventDefault()
          inputRef.current?.focus()
          setOpen(true)
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Dismiss on a click anywhere outside the field+panel. Pointerdown rather
  // than click so the panel closes before a click on the page behind it lands
  //, otherwise selecting a row underneath feels like it took two clicks.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  // Debounce: the input is immediate, the matcher runs after typing settles.
  useEffect(() => {
    const t = setTimeout(() => setQuery(raw.trim().toLowerCase()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [raw])

  useEffect(() => setCursor(0), [query])

  const common = { enabled: primed, staleTime: 60_000, retry: false }
  const resourcesQuery = useQuery({
    queryKey: ['search', 'resources'],
    queryFn: ({ signal }) => listResources({ signal }),
    ...common,
  })
  const safesQuery = useQuery({
    queryKey: ['search', 'safes'],
    queryFn: ({ signal }) => listSafes(signal),
    ...common,
  })
  const usersQuery = useQuery({
    queryKey: ['search', 'users'],
    queryFn: ({ signal }) => listUsers(undefined, signal),
    ...common,
    enabled: primed && isAdmin,
  })

  const pages = useMemo(() => quickJumpTargets(isAdmin), [isAdmin])

  const records = useMemo(() => {
    const out = []
    for (const r of resourcesQuery.data?.resources || []) {
      out.push({
        id: `resource-${r.id}`,
        group: 'Resources',
        label: r.name || r.id,
        meta: [r.type, r.host].filter(Boolean).join(' · '),
        fields: [r.name, r.type, r.host, r.description],
        to: `/resources/${r.id}`,
      })
    }
    for (const s of safesQuery.data || []) {
      out.push({
        id: `safe-${s.id}`,
        group: 'Vault',
        label: s.name || s.id,
        meta: s.description || 'Safe',
        fields: [s.name, s.description],
        to: `/vault/${s.id}`,
      })
    }
    for (const u of usersQuery.data?.users || []) {
      out.push({
        id: `user-${u.user_id}`,
        group: 'Accounts',
        label: u.username,
        meta: [u.email, u.status].filter(Boolean).join(' · '),
        fields: [u.username, u.email, u.full_name],
        to: `/admin/identity/${u.user_id}`,
      })
    }
    return out
  }, [resourcesQuery.data, safesQuery.data, usersQuery.data])

  const results = useMemo(() => {
    if (!query) {
      // An empty dropdown is a shortlist, not a directory. Six destinations,
      // which is what an empty search field is actually good for.
      return pages.slice(0, 6).map((p) => ({
        id: `page-${p.to}`,
        group: p.group,
        label: p.label,
        icon: p.icon,
        to: p.to,
        meta: null,
      }))
    }

    const scored = []
    for (const p of pages) {
      const s = score(p.label, query)
      // Pages outrank records at equal relevance: typing "audit" means the
      // Audit page far more often than an audit-named resource.
      if (s)
        scored.push({
          id: `page-${p.to}`,
          group: p.group,
          label: p.label,
          icon: p.icon,
          to: p.to,
          meta: null,
          _s: s + 12,
        })
    }
    for (const r of records) {
      const s = bestScore(r.fields, query)
      if (s) scored.push({ ...r, _s: s })
    }

    scored.sort((a, b) => b._s - a._s || a.label.localeCompare(b.label))
    return scored.slice(0, 24)
  }, [query, pages, records])

  const loading =
    primed && (resourcesQuery.isLoading || safesQuery.isLoading || (isAdmin && usersQuery.isLoading))

  const go = (to) => {
    setOpen(false)
    setRaw('')
    setQuery('')
    inputRef.current?.blur()
    navigate(to)
  }

  // Keep the highlighted row inside the scroll viewport when navigating by
  // keyboard through a long result set.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]')
    if (!el || !listRef.current) return
    const box = listRef.current.getBoundingClientRect()
    const row = el.getBoundingClientRect()
    if (row.bottom > box.bottom) listRef.current.scrollTop += row.bottom - box.bottom
    else if (row.top < box.top) listRef.current.scrollTop -= box.top - row.top
  }, [cursor, results, open])

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (raw) setRaw('')
      else {
        setOpen(false)
        inputRef.current?.blur()
      }
      return
    }
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (results.length === 0 ? 0 : (c + 1) % results.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (results.length === 0 ? 0 : (c - 1 + results.length) % results.length))
      return
    }
    if (e.key === 'Enter' && results[cursor]) {
      e.preventDefault()
      go(results[cursor].to)
    }
  }

  let lastGroup = null

  return (
    <div ref={wrapRef} className="relative flex-none">
      <div
        className={clsx(
          'relative flex h-9 items-center rounded-lg border transition-[width,border-color,background-color] duration-200 ease-emphasis',
          // The field grows on focus rather than opening a bigger surface ,
          // the extra room appears exactly where the typing is happening.
          open ? 'w-[15rem] sm:w-[21rem]' : 'w-9 sm:w-[15rem] lg:w-[17rem]',
          open
            ? 'border-blue-500 bg-surface-900 ring-[3px] ring-blue-500/20'
            : 'border-surface-700 bg-surface-850 hover:border-surface-600 hover:bg-surface-800'
        )}
      >
        {loading ? (
          <Loader2
            className="pointer-events-none absolute left-[0.7rem] h-3.5 w-3.5 animate-spin text-ink-500"
            strokeWidth={2}
            aria-hidden="true"
          />
        ) : (
          <Search
            className="pointer-events-none absolute left-[0.7rem] h-3.5 w-3.5 text-ink-500"
            strokeWidth={1.9}
            aria-hidden="true"
          />
        )}
        <input
          ref={inputRef}
          type="text"
          value={raw}
          role="combobox"
          aria-expanded={open}
          aria-controls="global-search-results"
          aria-autocomplete="list"
          aria-label="Search the console"
          autoComplete="off"
          spellCheck="false"
          placeholder="Search the console…"
          title="Search (⌘K)"
          onFocus={() => {
            setPrimed(true)
            setOpen(true)
          }}
          onChange={(e) => {
            setRaw(e.target.value)
            setOpen(true)
          }}
          onKeyDown={onKeyDown}
          className={clsx(
            'h-full w-full min-w-0 rounded-lg border-0 bg-transparent pl-8 text-xs text-ink-50 placeholder:text-ink-500 focus:outline-none',
            raw ? 'pr-8' : 'pr-2.5',
            // On the narrowest widths the field collapses to its icon; a tap
            // focuses it and the focus state expands it.
            !open && 'max-sm:cursor-pointer max-sm:text-transparent max-sm:placeholder:text-transparent'
          )}
        />
        {raw && (
          <button
            type="button"
            onClick={() => {
              setRaw('')
              inputRef.current?.focus()
            }}
            aria-label="Clear search"
            className="absolute right-2 flex h-5 w-5 items-center justify-center rounded text-ink-500 transition-colors hover:bg-surface-800 hover:text-ink-100"
          >
            <X className="h-3 w-3" strokeWidth={2.5} />
          </button>
        )}
      </div>

      {open && (
        // Anchored to the field, right-aligned so it can never run off the
        // edge of the navbar, and wider than the trigger because result rows
        // carry two lines. No scrim: the console behind stays readable, which
        // is the entire reason this stopped being a modal.
        <div
          id="global-search-results"
          role="listbox"
          aria-label="Search results"
          className="animate-menu-in absolute right-0 top-[calc(100%+0.45rem)] z-50 w-[min(26rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-surface-700 bg-surface-900 shadow-overlay"
        >
          <div ref={listRef} className="max-h-[19rem] overflow-y-auto p-1.5">
            {results.length === 0 && (
              <div className="flex flex-col items-center px-6 py-8 text-center">
                <span className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-xl border border-surface-700 bg-surface-850 text-ink-400">
                  <SearchX className="h-4 w-4" strokeWidth={1.6} />
                </span>
                <p className="text-sm font-medium text-ink-100">No matches for “{raw.trim()}”</p>
                <p className="mt-1.5 max-w-[17rem] text-xs leading-relaxed text-ink-500">
                  Search covers console pages, resources, vault safes
                  {isAdmin ? ' and user accounts' : ''}. Sessions, grants and audit entries are searched on
                  their own pages.
                </p>
              </div>
            )}

            {!query && results.length > 0 && (
              <p className="px-2.5 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-[0.11em] text-ink-600">
                Jump to
              </p>
            )}

            {results.map((r, i) => {
              const showGroup = !!query && r.group !== lastGroup
              lastGroup = r.group
              const active = i === cursor
              const meta = GROUP_META[r.group] || {}
              const Icon = r.icon || meta.icon || Search
              return (
                <div key={r.id}>
                  {showGroup && (
                    <p className="px-2.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.11em] text-ink-600">
                      {r.group}
                    </p>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-active={active}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => go(r.to)}
                    className={clsx(
                      'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-100',
                      active ? 'bg-surface-800' : 'hover:bg-surface-850'
                    )}
                  >
                    <span
                      className={clsx(
                        'flex h-7 w-7 flex-none items-center justify-center rounded-lg border transition-colors',
                        active
                          ? 'border-blue-500/40 bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300'
                          : 'border-surface-700 bg-surface-850 text-ink-500'
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={clsx(
                          'block truncate text-sm font-medium',
                          active ? 'text-ink-50' : 'text-ink-100'
                        )}
                      >
                        {r.label}
                      </span>
                      {r.meta && (
                        <span className="mt-0.5 block truncate text-2xs text-ink-500">{r.meta}</span>
                      )}
                    </span>
                    {active && (
                      <CornerDownLeft className="h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
                    )}
                  </button>
                </div>
              )
            })}
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-surface-800 bg-surface-850/60 px-3 py-2 text-2xs text-ink-500">
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-surface-600 bg-surface-900 px-1 py-0.5 font-mono">
                  ↑↓
                </kbd>
                move
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-surface-600 bg-surface-900 px-1 py-0.5 font-mono">
                  ↵
                </kbd>
                open
              </span>
              <span className="hidden items-center gap-1.5 sm:flex">
                <kbd className="rounded border border-surface-600 bg-surface-900 px-1 py-0.5 font-mono">
                  esc
                </kbd>
                close
              </span>
            </span>
            <span className="tabular-nums">
              {query ? `${results.length} result${results.length === 1 ? '' : 's'}` : '⌘K'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
