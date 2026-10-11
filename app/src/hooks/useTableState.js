import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

// ---------------------------------------------------------------------------
// useTableState, search / filter / sort / paginate / select, in one hook.
// ---------------------------------------------------------------------------
// WHY CLIENT-SIDE: every list endpoint in this backend returns its whole
// collection (GET /pam/resources, /admin/identity/users, /pam/audit/... take
// no page params). So the honest implementation is to fetch once and do the
// paging here, no fake "page 2" request that the server would ignore.
//
// WHY IT'S SHAPED LIKE A SERVER PAGER ANYWAY: the return value is exactly
// { page, pageSize, total, totalPages, pageRows }. When the backend grows
// `page`/`page_size`, pass `serverMode: true` and hand it the page the
// server returned plus `total`, every consumer component keeps working
// unchanged. That's the difference between a stopgap and a seam.
//
// Nothing here fetches, mutates or transforms row content: it only decides
// which of the caller's own rows are visible, in what order, and which are
// ticked.

const PERSIST_VERSION = 1

function readStored(storageKey) {
  if (!storageKey) return null
  try {
    const raw = localStorage.getItem(`pam_table_${storageKey}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && parsed.v === PERSIST_VERSION ? parsed : null
  } catch {
    return null
  }
}

function writeStored(storageKey, patch) {
  if (!storageKey) return
  try {
    const current = readStored(storageKey) || { v: PERSIST_VERSION }
    localStorage.setItem(
      `pam_table_${storageKey}`,
      JSON.stringify({ ...current, ...patch, v: PERSIST_VERSION })
    )
  } catch {
    // Storage unavailable (private mode, locked-down profile): preferences
    // simply don't persist. Never a thrown error in a table.
  }
}

// ---------------------------------------------------------------------------
// VIEW STATE LIVES IN THE URL. This is the difference between a dashboard and
// a console.
// ---------------------------------------------------------------------------
// Search, filters, sort and page are not preferences, they are WHERE YOU ARE.
// Keeping them in React state alone means "every locked account" is a place
// you can reach but cannot send to anyone, cannot bookmark, and cannot get
// back to after a reload. Every console of this class puts them in the query
// string for exactly that reason: AWS puts its table filters there, Okta's
// System Log encodes the whole search into the URL, Entra does the same on
// its user list. It is what makes "here, look at this" possible in a chat
// message to a colleague.
//
// The split matters, and it is not arbitrary:
//
//   URL          search, filters, sort, page   -> WHERE you are, shareable
//   localStorage page size, density, columns   -> HOW you like tables, yours
//
// Sending density to a colleague in a link would impose your preferences on
// them; sending a filter is the entire point. So the two stay separate.
//
// Writes are replace-mode: typing four characters into a search box must not
// bury the previous page under four history entries. The address bar stays
// correct and shareable, which is what people actually use it for.

const RESERVED_PARAMS = new Set(['q', 'sort', 'dir', 'page'])

function parseSortParam(params, fallback) {
  const key = params.get('sort')
  if (!key) return fallback
  return { key, dir: params.get('dir') === 'desc' ? 'desc' : 'asc' }
}

function parseFiltersParam(params, initialFilters) {
  const out = { ...initialFilters }
  for (const key of Object.keys(initialFilters)) {
    // A filter never claims a param name the table already owns, otherwise a
    // filter called "page" would silently eat the pager.
    if (RESERVED_PARAMS.has(key)) continue
    const raw = params.get(key)
    if (raw !== null) out[key] = raw
  }
  return out
}

// Comparator that behaves sensibly for the five value kinds these tables
// actually hold: numbers, ISO timestamps, booleans, strings, and nullish.
// Nullish always sorts last regardless of direction, an empty cell is not
// "before A", it's "no answer".
//
// TIMESTAMPS ARE COMPARED AS TIME, NOT AS TEXT. This is what broke the JIT
// approvals queue's Oldest/Newest control. Go marshals time.Time as RFC3339
// with VARIABLE-PRECISION fractional seconds and trailing zeros stripped, so
// two rows in the same second look like:
//
//     2026-08-13T15:34:12.123456789Z
//     2026-08-13T15:34:12.5Z
//
// `localeCompare(..., { numeric: true })` treats each digit run as a NUMBER,
// so it compares 123456789 against 5 and puts the earlier timestamp last.
// Rows also arrive from the API already ordered by time, which made the
// mis-ordering read as "the sort does nothing". Parsing to epoch removes the
// whole class of problem, and it costs one Date.parse per comparison on
// lists that are page-sized, which is nothing.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

function asTime(v) {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' && ISO_DATE.test(v)) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

function compare(a, b) {
  const aNil = a === null || a === undefined || a === ''
  const bNil = b === null || b === undefined || b === ''
  if (aNil && bNil) return 0
  if (aNil) return 1
  if (bNil) return -1

  const at = asTime(a)
  const bt = asTime(b)
  if (at !== null && bt !== null) return at - bt

  if (typeof a === 'boolean' || typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0)
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

export function useTableState({
  rows,
  storageKey,
  initialSort = null, // { key, dir: 'asc' | 'desc' }
  initialPageSize = 25,
  initialFilters = {},
  initialDensity = 'comfortable', // 'comfortable' | 'compact'
  initialColumns = null, // array of column keys visible by default
  searchFields = [], // field names, or accessor fns (row) => string
  filterFn = null, // (row, filters) => boolean
  sortAccessor = null, // (row, key) => comparable
  rowId = (row) => row.id,
  serverMode = false,
  total: serverTotal,
  // Opt-in, because a page may run more than one table and only one of them
  // can own the address bar. The main list on a page turns it on.
  urlSync = false,
} = {}) {
  const stored = useRef(readStored(storageKey)).current
  const [searchParams, setSearchParams] = useSearchParams()

  // Read once, at mount. After that the URL is written FROM state rather than
  // read back into it, so a keystroke does not race its own address-bar
  // update. A fresh navigation remounts the page and re-reads.
  const fromUrl = useRef(
    urlSync
      ? {
          query: searchParams.get('q') || '',
          filters: parseFiltersParam(searchParams, initialFilters),
          sort: parseSortParam(searchParams, stored?.sort ?? initialSort),
          page: Math.max(1, Number(searchParams.get('page')) || 1),
        }
      : null
  ).current

  const [query, setQuery] = useState(fromUrl?.query ?? '')
  const [filters, setFilters] = useState(fromUrl?.filters ?? initialFilters)
  const [sort, setSort] = useState(fromUrl?.sort ?? stored?.sort ?? initialSort)
  const [page, setPage] = useState(fromUrl?.page ?? 1)
  const [pageSize, setPageSizeRaw] = useState(stored?.pageSize ?? initialPageSize)
  const [density, setDensityRaw] = useState(stored?.density ?? initialDensity)
  const [visibleColumns, setVisibleColumnsRaw] = useState(stored?.columns ?? initialColumns)

  // Selection. Two modes, because "select all 1,284 matching" and "select
  // these 3" are genuinely different intents, conflating them is how you
  // get a bulk action that silently applies to the current page only.
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [allMatchingSelected, setAllMatchingSelected] = useState(false)

  const setPageSize = useCallback(
    (n) => {
      setPageSizeRaw(n)
      setPage(1)
      writeStored(storageKey, { pageSize: n })
    },
    [storageKey]
  )

  const setDensity = useCallback(
    (d) => {
      setDensityRaw(d)
      writeStored(storageKey, { density: d })
    },
    [storageKey]
  )

  const setVisibleColumns = useCallback(
    (cols) => {
      setVisibleColumnsRaw(cols)
      writeStored(storageKey, { columns: cols })
    },
    [storageKey]
  )

  const toggleSort = useCallback((key) => {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: 'asc' }
      if (s.dir === 'asc') return { key, dir: 'desc' }
      return null // third click clears, back to the API's own order
    })
    setPage(1)
  }, [])

  useEffect(() => {
    if (sort) writeStored(storageKey, { sort })
  }, [sort, storageKey])

  // State -> URL. Only the keys this table owns are touched, so a page that
  // also uses the query string for something else (?tab=, ?new=1) keeps it.
  // A default value writes NOTHING: a pristine list should have a clean
  // address, not ?q=&status=all&page=1 trailing behind it.
  useEffect(() => {
    if (!urlSync) return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)

        if (query) next.set('q', query)
        else next.delete('q')

        for (const [key, value] of Object.entries(filters)) {
          if (RESERVED_PARAMS.has(key)) continue
          if (value === undefined || value === null || value === initialFilters[key]) next.delete(key)
          else next.set(key, String(value))
        }

        if (sort?.key) {
          next.set('sort', sort.key)
          next.set('dir', sort.dir === 'desc' ? 'desc' : 'asc')
        } else {
          next.delete('sort')
          next.delete('dir')
        }

        if (page > 1) next.set('page', String(page))
        else next.delete('page')

        return next
      },
      { replace: true }
    )
    // initialFilters is a literal at every call site, so depending on it by
    // identity would rewrite the URL on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSync, query, filters, sort, page, setSearchParams])

  const setFilter = useCallback((key, value) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }, [])

  const resetFilters = useCallback(() => {
    setFilters(initialFilters)
    setQuery('')
    setPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const all = useMemo(() => (Array.isArray(rows) ? rows : []), [rows])

  const filtered = useMemo(() => {
    if (serverMode) return all
    const q = query.trim().toLowerCase()
    let out = all

    if (q) {
      out = out.filter((row) =>
        searchFields.some((f) => {
          const v = typeof f === 'function' ? f(row) : row?.[f]
          return v !== null && v !== undefined && String(v).toLowerCase().includes(q)
        })
      )
    }

    if (filterFn) out = out.filter((row) => filterFn(row, filters))

    if (sort?.key) {
      const get = sortAccessor ? (row) => sortAccessor(row, sort.key) : (row) => row?.[sort.key]
      // Copy before sorting: mutating the query cache's array in place makes
      // react-query hand out re-ordered data to every other consumer.
      //
      // Ties keep their incoming order. Array.prototype.sort is specified as
      // stable, so equal keys stay in whatever order the API returned, which
      // is the behaviour an approver expects when two requests share a second.
      out = [...out].sort((a, b) =>
        sort.dir === 'desc' ? -compare(get(a), get(b)) : compare(get(a), get(b))
      )
    }

    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, query, filters, sort, serverMode])

  const total = serverMode ? (serverTotal ?? 0) : filtered.length
  const totalPages = Math.max(Math.ceil(total / pageSize) || 0, 0)

  // If a filter shrinks the result set while the user sits on page 9, clamp
  // instead of rendering an empty table with "Page 9 of 3".
  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const pageRows = useMemo(() => {
    if (serverMode) return filtered
    const from = (page - 1) * pageSize
    return filtered.slice(from, from + pageSize)
  }, [filtered, page, pageSize, serverMode])

  // --- selection -----------------------------------------------------------

  const pageIds = useMemo(() => pageRows.map(rowId), [pageRows, rowId])

  const isSelected = useCallback(
    (row) => (allMatchingSelected ? !selectedIds.has(rowId(row)) : selectedIds.has(rowId(row))),
    // In allMatching mode the Set holds EXCLUSIONS, which is what makes
    // "select all 1,284, except these two" expressible.
    [allMatchingSelected, selectedIds, rowId]
  )

  const toggleRow = useCallback(
    (row) => {
      const id = rowId(row)
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    [rowId]
  )

  const selectedCount = allMatchingSelected ? Math.max(total - selectedIds.size, 0) : selectedIds.size

  const selectedRows = useMemo(() => {
    if (allMatchingSelected) return filtered.filter((r) => !selectedIds.has(rowId(r)))
    return filtered.filter((r) => selectedIds.has(rowId(r)))
  }, [allMatchingSelected, filtered, selectedIds, rowId])

  const allOnPageSelected = pageIds.length > 0 && pageRows.every((r) => isSelected(r))
  const someOnPageSelected = !allOnPageSelected && pageRows.some((r) => isSelected(r))

  const toggleAllOnPage = useCallback(() => {
    if (allOnPageSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        pageIds.forEach((id) => (allMatchingSelected ? next.add(id) : next.delete(id)))
        return next
      })
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        pageIds.forEach((id) => (allMatchingSelected ? next.delete(id) : next.add(id)))
        return next
      })
    }
  }, [allOnPageSelected, pageIds, allMatchingSelected])

  const selectAllMatching = useCallback(() => {
    setAllMatchingSelected(true)
    setSelectedIds(new Set())
  }, [])

  const clearSelection = useCallback(() => {
    setAllMatchingSelected(false)
    setSelectedIds(new Set())
  }, [])

  // A selection that survived a filter change would apply to rows the user
  // can no longer see, always a bug, never a feature.
  useEffect(() => {
    clearSelection()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filters])

  const activeFilterCount = useMemo(
    () =>
      Object.entries(filters).filter(([k, v]) => {
        const initial = initialFilters[k]
        if (Array.isArray(v)) return v.length > 0
        return v !== initial && v !== '' && v !== null && v !== undefined && v !== 'all'
      }).length + (query.trim() ? 1 : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters, query]
  )

  return {
    // querying
    query,
    setQuery,
    filters,
    setFilter,
    setFilters,
    resetFilters,
    activeFilterCount,
    // ordering
    sort,
    setSort,
    toggleSort,
    // paging (same shape as the backend's paged() response)
    page,
    setPage,
    pageSize,
    setPageSize,
    total,
    totalPages,
    pageRows,
    filteredRows: filtered,
    allRows: all,
    // presentation prefs
    density,
    setDensity,
    visibleColumns,
    setVisibleColumns,
    // selection
    isSelected,
    toggleRow,
    toggleAllOnPage,
    selectAllMatching,
    clearSelection,
    selectedCount,
    selectedRows,
    allMatchingSelected,
    allOnPageSelected,
    someOnPageSelected,
  }
}
