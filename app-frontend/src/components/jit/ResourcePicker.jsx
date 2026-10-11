import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown, KeyRound, Search, X } from 'lucide-react'
import clsx from 'clsx'
import { ResourceTypeIcon } from '../resources/ResourceTypeIcon'
import { resourceTypeLabel } from '../resources/ResourceCard'

// ---------------------------------------------------------------------------
// Resource picker
// ---------------------------------------------------------------------------
// A combobox, replacing the native <select> this form used to carry.
//
// TWO REASONS IT HAD TO CHANGE, and the first one was a real bug.
//
// 1. THE PRESELECTION SILENTLY FAILED. Opening this form from a resource row
//    passes that resource in as the default. The form reset ran the moment the
//    dialog opened, which is the same moment the resource list STARTED
//    loading, so react-hook-form set the select's value against a list that
//    was still empty. A browser drops a value with no matching option, and
//    nothing re-applied it when the options finally arrived, so a user who
//    clicked "Request access" on one specific database landed on "Select a
//    resource..." and had to find it again. A combobox renders its selection
//    from the value itself rather than from a matching child, so the race
//    cannot happen: the id is held in state and the label fills in when the
//    list arrives.
//
// 2. A NATIVE SELECT IS UNUSABLE AT THIS LENGTH. A real estate is dozens of
//    entries whose names differ in the last few characters of a long RDS
//    hostname. A native dropdown offers no search, only first-letter jump, so
//    finding one meant scrolling a list of near-identical strings.
//
// Search matches name, host, type and database, because people remember
// different things about the same machine: one person knows it as "orders",
// another as the box on 13.206.221.6.

function matches(resource, q) {
  if (!q) return true
  const needle = q.toLowerCase()
  return [
    resource.name,
    resource.host,
    resource.database_name,
    resource.resource_type,
    resourceTypeLabel(resource.resource_type),
  ].some((v) => String(v || '').toLowerCase().includes(needle))
}

// The endpoint is a disambiguator, not data: two machines can share a name.
// The port is not part of a standard user's view of the catalogue and the API
// does not send them one, so it is only appended when it is actually there.
export function resourceEndpoint(r) {
  if (!r) return ''
  return r.port ? `${r.host}:${r.port}` : r.host || ''
}

export function ResourcePicker({
  id,
  resources = [],
  value,
  onChange,
  loading = false,
  invalid = false,
  disabled = false,
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const wrapRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const selected = resources.find((r) => r.id === value) || null

  // JIT-gated systems first: they are the ones that actually require this
  // form, and on a long catalogue they would otherwise be scattered through it.
  const groups = useMemo(() => {
    const hits = resources.filter((r) => matches(r, query))
    const gated = hits.filter((r) => r.requires_jit)
    const standing = hits.filter((r) => !r.requires_jit)
    return [
      { key: 'gated', label: 'Requires just-in-time approval', rows: gated },
      { key: 'standing', label: 'Standing access (a request is usually unnecessary)', rows: standing },
    ].filter((g) => g.rows.length > 0)
  }, [resources, query])

  // One flat list behind the grouped rendering, so the keyboard can walk the
  // options without caring which heading they sit under.
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Focus the search box on open, which is the whole point of opening it.
  useEffect(() => {
    if (open) inputRef.current?.focus()
    else setQuery('')
  }, [open])

  // Keep the highlighted row in view when the keyboard moves past the fold.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const choose = (r) => {
    onChange(r.id)
    setOpen(false)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (flat[active]) choose(flat[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  let index = -1

  return (
    <div ref={wrapRef} className="relative">
      <button
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${id}-listbox`}
        disabled={disabled || loading}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'flex h-10 w-full items-center gap-2.5 rounded-lg border px-3 text-left text-sm transition-colors',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent/25',
          'disabled:cursor-not-allowed disabled:opacity-60',
          invalid
            ? 'border-danger bg-surface text-primary focus-visible:border-danger'
            : 'border-line-strong bg-surface text-primary hover:border-primary/40 focus-visible:border-accent'
        )}
      >
        {selected ? (
          <>
            <ResourceTypeIcon
              type={selected.resource_type}
              className="h-4 w-4 flex-none text-tertiary"
            />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{selected.name}</span>
              {resourceEndpoint(selected) && (
                <span className="ml-2 font-mono text-xs text-tertiary">
                  {resourceEndpoint(selected)}
                </span>
              )}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-tertiary">
            {loading ? 'Loading resources…' : 'Select a resource…'}
          </span>
        )}
        <ChevronsUpDown className="h-4 w-4 flex-none text-ink-600" strokeWidth={1.75} />
      </button>

      {open && (
        <div className="animate-menu-in absolute left-0 right-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-line bg-surface shadow-overlay">
          <div className="flex items-center gap-2 border-b border-line-soft px-3">
            <Search className="h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search by name, host or type"
              aria-label="Search resources"
              aria-autocomplete="list"
              className="h-10 min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-tertiary"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
                aria-label="Clear search"
                className="flex h-6 w-6 flex-none items-center justify-center rounded text-tertiary transition-colors hover:bg-hover hover:text-primary"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            )}
          </div>

          <div
            ref={listRef}
            id={`${id}-listbox`}
            role="listbox"
            className="max-h-72 overflow-y-auto p-1.5"
          >
            {flat.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-tertiary">
                {resources.length === 0
                  ? 'No resources are available to you.'
                  : `Nothing matches "${query}".`}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.key} className="pb-1 last:pb-0">
                  <p className="px-2.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.06em] text-tertiary">
                    {group.label}
                  </p>
                  {group.rows.map((r) => {
                    index += 1
                    const i = index
                    const isActive = i === active
                    const isSelected = r.id === value
                    return (
                      <button
                        key={r.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        data-active={isActive}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(r)}
                        className={clsx(
                          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                          isActive ? 'bg-hover' : 'bg-transparent'
                        )}
                      >
                        <ResourceTypeIcon
                          type={r.resource_type}
                          className="h-4 w-4 flex-none text-tertiary"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 truncate text-sm font-medium text-primary">
                              {r.name}
                            </span>
                            {r.requires_jit && (
                              <KeyRound
                                className="h-3.5 w-3.5 flex-none text-warn"
                                strokeWidth={1.9}
                                aria-label="Requires just-in-time approval"
                              />
                            )}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-2xs text-tertiary">
                            {resourceEndpoint(r)}
                          </span>
                        </span>
                        {isSelected && (
                          <Check className="h-4 w-4 flex-none text-accent" strokeWidth={2.25} />
                        )}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
