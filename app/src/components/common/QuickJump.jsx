import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Search, CornerDownLeft } from 'lucide-react'
import { quickJumpTargets } from '../../config/nav'

// ---------------------------------------------------------------------------
// Jump to… (⌘K)
// ---------------------------------------------------------------------------
// NAVIGATION ONLY, on purpose. A full command palette needs an action
// registry (every page publishing its own actions) which doesn't exist yet;
// listing actions a palette can't run would be worse than not offering them.
// What this does do is real: type, filter, Enter, you're there, and it's the
// shell the action registry can later plug into.
export function QuickJump({ isAdmin = false }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const targets = useMemo(() => quickJumpTargets(isAdmin), [isAdmin])
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return targets
    return targets.filter(
      (t) => t.label.toLowerCase().includes(needle) || t.group.toLowerCase().includes(needle)
    )
  }, [q, targets])

  // Global shortcut. Guarded against firing while the user is typing in a
  // form field elsewhere only for the plain-key case, ⌘K/Ctrl-K is
  // unambiguous, so it works from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    setQ('')
    setCursor(0)
    // Focus after paint so the input is actually in the document.
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    setCursor(0)
  }, [q])

  const go = (to) => {
    setOpen(false)
    navigate(to)
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
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
    <>
      {/* Wide trigger on large screens, icon-only below, the topbar's right
 cluster has to survive a 768px viewport without wrapping. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Jump to… (⌘K)"
        className="hidden h-9 w-[13.5rem] items-center gap-2 rounded-lg border border-surface-700 bg-surface-800/70 pl-2.5 pr-1.5 text-xs text-ink-500 transition-colors duration-150 hover:border-surface-600 hover:text-ink-300 focus-visible:ring-2 focus-visible:ring-blue-500/40 lg:flex"
      >
        <Search className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
        <span className="flex-1 text-left">Jump to…</span>
        <kbd className="flex-none rounded border border-surface-600 bg-surface-900 px-1.5 py-0.5 font-mono text-[0.625rem] leading-4 text-ink-500">
          ⌘K
        </kbd>
      </button>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Jump to a page"
        className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-ink-400 transition-colors duration-150 hover:bg-surface-800 hover:text-ink-50 lg:hidden"
      >
        <Search className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.5} />
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]">
          <div
            className="animate-overlay-in absolute inset-0 bg-slate-950/45 backdrop-blur-[3px] dark:bg-black/65"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Jump to a page"
            className="animate-panel-in relative w-full max-w-[34rem] overflow-hidden rounded-2xl border border-surface-700 bg-surface-900 shadow-overlay"
          >
            <div className="flex items-center gap-3 border-b border-surface-800 px-4">
              <Search className="h-4 w-4 flex-none text-ink-500" strokeWidth={1.75} />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Jump to a page…"
                className="h-12 w-full flex-1 border-0 bg-transparent text-sm text-ink-50 placeholder:text-ink-500 focus:outline-none"
              />
            </div>

            <div ref={listRef} className="max-h-[19rem] overflow-y-auto p-1.5">
              {results.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-ink-500">Nothing matches “{q}”.</p>
              )}
              {results.map((t, i) => {
                const showGroup = t.group !== lastGroup
                lastGroup = t.group
                const active = i === cursor
                return (
                  <div key={t.to}>
                    {showGroup && (
                      <p className="px-2.5 pb-1 pt-2.5 text-2xs font-semibold uppercase tracking-[0.11em] text-ink-600">
                        {t.group}
                      </p>
                    )}
                    <button
                      type="button"
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => go(t.to)}
                      className={clsx(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-100',
                        active ? 'bg-surface-800 text-ink-50' : 'text-ink-200 hover:bg-surface-850'
                      )}
                    >
                      <t.icon
                        className={clsx(
                          'h-4 w-4 flex-none',
                          active ? 'text-blue-600 dark:text-blue-300' : 'text-ink-500'
                        )}
                        strokeWidth={1.5}
                      />
                      <span className="flex-1 truncate font-medium">{t.label}</span>
                      {active && (
                        <CornerDownLeft className="h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
                      )}
                    </button>
                  </div>
                )
              })}
            </div>

            <div className="flex items-center gap-4 border-t border-surface-800 bg-surface-850/60 px-4 py-2.5 text-2xs text-ink-500">
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-surface-600 bg-surface-900 px-1.5 py-0.5 font-mono">
                  ↑↓
                </kbd>
                navigate
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-surface-600 bg-surface-900 px-1.5 py-0.5 font-mono">
                  ↵
                </kbd>
                open
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-surface-600 bg-surface-900 px-1.5 py-0.5 font-mono">
                  esc
                </kbd>
                close
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
