// ---------------------------------------------------------------------------
// Export the rows a user is currently looking at.
// ---------------------------------------------------------------------------
// Client-side on purpose: there is no export endpoint, and the value of this
// feature is "give me exactly the filtered/sorted view I built", which only
// the browser knows. Nothing is fetched, nothing is sent anywhere, the file
// is assembled from rows already on screen and handed to the download shelf.

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

// RFC 4180: quote when the value contains a comma, quote or newline, and
// escape embedded quotes by doubling them. Also prefixes a leading =, +, -
// or @ with a single quote, without that, a cell like "=CMD()" is a formula
// injection the moment the file is opened in Excel, and this app exports
// attacker-influenced strings (usernames, resource names, audit details).
function csvCell(value) {
  if (value === null || value === undefined) return ''
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

// columns: [{ key, label, value?: (row) => any }]
export function exportRowsToCsv(rows, columns, basename = 'export') {
  const header = columns.map((c) => csvCell(c.label ?? c.key)).join(',')
  const body = rows.map((row) => columns.map((c) => csvCell(c.value ? c.value(row) : row?.[c.key])).join(','))
  // BOM so Excel opens UTF-8 names (accented, CJK) correctly rather than as
  // mojibake, the single most common complaint about CSV exports.
  const blob = new Blob(['\uFEFF' + [header, ...body].join('\r\n')], {
    type: 'text/csv;charset=utf-8',
  })
  triggerDownload(blob, `${basename}-${stamp()}.csv`)
}

export function exportRowsToJson(rows, columns, basename = 'export') {
  const shaped = columns
    ? rows.map((row) =>
        Object.fromEntries(columns.map((c) => [c.key, c.value ? c.value(row) : row?.[c.key]]))
      )
    : rows
  const blob = new Blob([JSON.stringify(shaped, null, 2)], { type: 'application/json' })
  triggerDownload(blob, `${basename}-${stamp()}.json`)
}
