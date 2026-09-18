import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Download, FileText, Sheet, Info } from 'lucide-react'
import clsx from 'clsx'
import { generateComplianceReport } from '../../api/audit'
import { Card, CardHeader, CardTitle } from '../common/Layout'
import { Button } from '../common/Button'
import { apiErrorMessage } from '../../lib/apiError'
import { dateInputToRFC3339, todayDateInputValue, daysAgoDateInputValue } from '../../lib/format'
import { resolveRange, rangeLabel } from './auditFields'

// ---------------------------------------------------------------------------
// Compliance report builder
// ---------------------------------------------------------------------------
// audit_handler.go's Generate() REQUIRES from/to as RFC3339 and 400s without
// them, so this panel always has a concrete range, it seeds from whatever
// date window the list is already filtered to, falling back to the last 30
// days when the list is unfiltered. That means "what I'm looking at" and
// "what I'm exporting" start out identical, which is the whole point of
// putting the builder under the filters rather than behind a modal.

const FORMATS = [
  { key: 'pdf', label: 'PDF', icon: FileText, note: 'Signed-off summary for auditors' },
  { key: 'csv', label: 'CSV', icon: Sheet, note: 'Raw rows for your own analysis' },
]

export function ReportBuilder({ filters, onClose }) {
  const seeded = resolveRange(filters.range, filters.from, filters.to)
  const [from, setFrom] = useState(() =>
    seeded.fromISO ? seeded.fromISO.slice(0, 10) : daysAgoDateInputValue(30)
  )
  const [to, setTo] = useState(() => (seeded.toISO ? seeded.toISO.slice(0, 10) : todayDateInputValue()))
  const [format, setFormat] = useState('pdf')

  const mutation = useMutation({
    mutationFn: () => {
      const fromTime = dateInputToRFC3339(from, false)
      const toTime = dateInputToRFC3339(to, true)
      if (!fromTime || !toTime) throw new Error('Pick a start and an end date.')
      if (new Date(fromTime) > new Date(toTime))
        throw new Error('The start date must come before the end date.')
      return generateComplianceReport({
        q: filters.q || undefined,
        category: filters.category || undefined,
        outcome: filters.outcome || undefined,
        fromTime,
        toTime,
        format,
      })
    },
    onSuccess: (r) => toast.success(r?.filename ? `Report downloaded, ${r.filename}` : 'Report downloaded'),
    // Client-side validation above throws a plain Error with no HTTP
    // response; apiErrorMessage would flatten that to a generic message.
    onError: (err) => toast.error(err?.response ? apiErrorMessage(err) : err.message || 'Report failed'),
  })

  const scope = [
    filters.q && `search “${filters.q}”`,
    filters.category && `category ${filters.category}`,
    filters.outcome && `outcome ${filters.outcome}`,
  ].filter(Boolean)

  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader>
        <CardTitle icon={Download}>Compliance report</CardTitle>
        {onClose && (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={onClose}>
            Close
          </Button>
        )}
      </CardHeader>

      <div className="grid gap-5 p-4 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-ink-300">From</span>
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 rounded-lg border border-surface-700 bg-surface-800 px-2.5 text-sm text-ink-50 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/20"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-ink-300">To</span>
              <input
                type="date"
                value={to}
                min={from}
                max={todayDateInputValue()}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 rounded-lg border border-surface-700 bg-surface-800 px-2.5 text-sm text-ink-50 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/20"
              />
            </label>
            <p className="pb-2 text-2xs text-ink-500">
              Seeded from the list&apos;s range ({rangeLabel(filters.range)})
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {FORMATS.map((f) => {
              const active = format === f.key
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFormat(f.key)}
                  aria-pressed={active}
                  className={clsx(
                    'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors duration-150',
                    active
                      ? 'border-blue-500/50 bg-blue-50 dark:bg-blue-500/[0.09]'
                      : 'border-surface-700 bg-surface-850 hover:border-surface-600'
                  )}
                >
                  <span
                    className={clsx(
                      'flex h-8 w-8 flex-none items-center justify-center rounded-lg',
                      active
                        ? 'bg-blue-600 text-white'
                        : 'border border-surface-700 bg-surface-900 text-ink-500'
                    )}
                  >
                    <f.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0">
                    <span
                      className={clsx(
                        'block text-sm font-medium',
                        active ? 'text-blue-700 dark:text-blue-200' : 'text-ink-100'
                      )}
                    >
                      {f.label}
                    </span>
                    <span className="block truncate text-2xs text-ink-500">{f.note}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-dashed border-surface-600 bg-surface-850/70 p-3.5">
          <p className="text-xs font-semibold text-ink-500">Report scope</p>
          <ul className="space-y-1 text-xs leading-relaxed text-ink-400">
            <li>
              {from} → {to}
            </li>
            {scope.length === 0 ? (
              <li className="text-ink-500">Every category and outcome</li>
            ) : (
              scope.map((s) => <li key={s}>{s}</li>)
            )}
          </ul>
          <div className="flex items-start gap-2 border-t border-surface-700 pt-2.5">
            <Info className="mt-px h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
            <p className="text-2xs leading-relaxed text-ink-500">
              Generated server-side from the audit chain, not from the rows on this page.
            </p>
          </div>
          <Button
            variant="primary"
            icon={Download}
            block
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Download report
          </Button>
        </div>
      </div>
    </Card>
  )
}
