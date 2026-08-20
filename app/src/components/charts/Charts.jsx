import { useMemo, useRef, useState } from 'react'
import clsx from 'clsx'

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
// Hand-drawn SVG, no charting dependency. Three reasons that is the right
// call here rather than a limitation:
//
//   1. No new npm dependency can be added to this project, and a chart
// library is a large one to take for four small visualisations.
//   2. Every chart renders from data the console has ALREADY fetched for
// another purpose, so there is no extra request and nothing can disagree
// with the tables.
//   3. These are read-at-a-glance instruments, not exploratory analytics.
//
// WHAT MAKES THEM READ AS INSTRUMENTS RATHER THAN DECORATION (this pass):
//   · A real value axis. The old area chart had three unlabelled gridlines,
// so a peak of 4 and a peak of 400 looked identical. Magnitude is now
// readable without hovering.
//   · Two series, not one. Plotting only "events" hid the single thing the
// shape is for, whether the denials are climbing. Denied volume is now
// stacked in red on top of successful volume.
//   · Hover readout. A crosshair with the bucket's exact figures, which is
// what turns "a wiggly line" into something you can quote in a ticket.
//   · Proper baselines and end caps, tabular figures, and a legend that also
// carries the totals, so the chart answers "how much" without the eye
// having to travel to a caption.
//
// What they still deliberately do NOT do: extrapolate, forecast, draw a trend
// line, or compare against a previous period. The sample is the most recent N
// events, and a "+12% vs last week" on top of that would be an invented fact.

const TONES = {
  blue: { stroke: 'rgb(37 99 235)', fill: 'rgb(37 99 235)' },
  red: { stroke: 'rgb(239 68 68)', fill: 'rgb(239 68 68)' },
  emerald: { stroke: 'rgb(16 185 129)', fill: 'rgb(16 185 129)' },
  amber: { stroke: 'rgb(245 158 11)', fill: 'rgb(245 158 11)' },
  ink: { stroke: 'rgb(148 163 184)', fill: 'rgb(148 163 184)' },
}

function niceMax(v) {
  if (v <= 5) return 5
  const mag = 10 ** Math.floor(Math.log10(v))
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * mag
    if (candidate >= v) return candidate
  }
  return 10 * mag
}

// --- area / volume over time -------------------------------------------------
//
// `points` is [{ label, value, denied? }]. When any bucket carries a `denied`
// count the chart splits into two stacked bands; otherwise it draws one.

export function AreaChart({ points, height = 168, valueLabel = 'Events' }) {
  const data = Array.isArray(points) ? points : []
  const wrapRef = useRef(null)
  const [hover, setHover] = useState(null)

  const model = useMemo(() => {
    if (data.length < 2) return null
    const hasSplit = data.some((d) => (d.denied || 0) > 0)
    const max = niceMax(Math.max(...data.map((d) => d.value), 1))
    const n = data.length
    const x = (i) => (i / (n - 1)) * 100
    const y = (v) => 100 - (v / max) * 100

    const path = (accessor) =>
      data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(accessor(d)).toFixed(2)}`).join(' ')

    const totalLine = path((d) => d.value)
    const deniedLine = path((d) => d.denied || 0)

    return {
      hasSplit,
      max,
      n,
      x,
      y,
      totalLine,
      totalArea: `${totalLine} L100,100 L0,100 Z`,
      deniedLine,
      deniedArea: `${deniedLine} L100,100 L0,100 Z`,
      total: data.reduce((s, d) => s + d.value, 0),
      denied: data.reduce((s, d) => s + (d.denied || 0), 0),
    }
  }, [data])

  if (!model) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-lg border border-dashed border-surface-700 text-xs text-ink-500"
      >
        Not enough data to plot
      </div>
    )
  }

  const onMove = (e) => {
    const box = wrapRef.current?.getBoundingClientRect()
    if (!box) return
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
    setHover(Math.round(ratio * (model.n - 1)))
  }

  const hovered = hover != null ? data[hover] : null

  return (
    <div>
      <div className="flex gap-3">
        {/* Value axis. Three labelled steps is the right amount for a strip
 this tall, enough to read magnitude, not so many it becomes a
 table with a line through it. */}
        <div
          className="flex w-8 flex-none flex-col justify-between pb-4 text-right text-2xs tabular-nums text-ink-600"
          style={{ height: height + 16 }}
          aria-hidden="true"
        >
          <span>{model.max.toLocaleString()}</span>
          <span>{(model.max / 2).toLocaleString()}</span>
          <span>0</span>
        </div>

        <div className="relative min-w-0 flex-1">
          <div
            ref={wrapRef}
            className="relative"
            style={{ height }}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="h-full w-full"
              role="img"
              aria-label={`${valueLabel} over time, ${model.total.toLocaleString()} total, ${model.denied.toLocaleString()} denied or failed`}
            >
              <defs>
                <linearGradient id="area-total" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={TONES.blue.fill} stopOpacity="0.28" />
                  <stop offset="100%" stopColor={TONES.blue.fill} stopOpacity="0.02" />
                </linearGradient>
                <linearGradient id="area-denied" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={TONES.red.fill} stopOpacity="0.4" />
                  <stop offset="100%" stopColor={TONES.red.fill} stopOpacity="0.05" />
                </linearGradient>
              </defs>

              {[0, 0.5, 1].map((f) => (
                <line
                  key={f}
                  x1="0"
                  x2="100"
                  y1={100 * f}
                  y2={100 * f}
                  stroke="currentColor"
                  className={f === 1 ? 'text-surface-600' : 'text-surface-800'}
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              ))}

              <path d={model.totalArea} fill="url(#area-total)" />
              <path
                d={model.totalLine}
                fill="none"
                stroke={TONES.blue.stroke}
                strokeWidth="1.75"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />

              {model.hasSplit && (
                <>
                  <path d={model.deniedArea} fill="url(#area-denied)" />
                  <path
                    d={model.deniedLine}
                    fill="none"
                    stroke={TONES.red.stroke}
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              )}
            </svg>

            {/* Crosshair. Positioned in HTML, not SVG, so it stays a true 1px
 line under preserveAspectRatio="none", an SVG line here would
 be stretched horizontally along with the plot. */}
            {hovered && (
              <>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 w-px bg-blue-500/45"
                  style={{ left: `${model.x(hover)}%` }}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-600 ring-2 ring-surface-900"
                  style={{ left: `${model.x(hover)}%`, top: `${model.y(hovered.value)}%` }}
                />
              </>
            )}
          </div>

          {/* Time axis. First / middle / last only, a label under every
 bucket is unreadable at 24 buckets and pointless at 7. */}
          <div className="mt-1.5 flex justify-between text-2xs tabular-nums text-ink-600" aria-hidden="true">
            <span>{data[0].label}</span>
            <span>{data[Math.floor((data.length - 1) / 2)].label}</span>
            <span>{data[data.length - 1].label}</span>
          </div>

          {hovered && (
            <div className="pointer-events-none absolute -top-1 right-0 flex items-center gap-3 rounded-lg border border-surface-700 bg-surface-900 px-2.5 py-1.5 text-2xs shadow-pop">
              <span className="font-semibold tabular-nums text-ink-100">{hovered.label}</span>
              <span className="flex items-center gap-1.5 text-ink-400">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: TONES.blue.fill }} />
                <span className="tabular-nums text-ink-100">{hovered.value.toLocaleString()}</span> total
              </span>
              {model.hasSplit && (
                <span className="flex items-center gap-1.5 text-ink-400">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: TONES.red.fill }} />
                  <span className="tabular-nums text-red-600 dark:text-red-400">
                    {(hovered.denied || 0).toLocaleString()}
                  </span>{' '}
                  denied
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Legend doubles as the totals readout, so the eye never has to travel
 to a caption to answer "how much". */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-surface-800 pt-2.5 text-2xs">
        <span className="flex items-center gap-1.5 text-ink-400">
          <span className="h-2 w-2 rounded-sm" style={{ background: TONES.blue.fill }} aria-hidden="true" />
          {valueLabel}
          <span className="font-semibold tabular-nums text-ink-100">{model.total.toLocaleString()}</span>
        </span>
        {model.hasSplit && (
          <span className="flex items-center gap-1.5 text-ink-400">
            <span className="h-2 w-2 rounded-sm" style={{ background: TONES.red.fill }} aria-hidden="true" />
            Denied or failed
            <span className="font-semibold tabular-nums text-red-600 dark:text-red-400">
              {model.denied.toLocaleString()}
            </span>
          </span>
        )}
      </div>
    </div>
  )
}

// --- donut -------------------------------------------------------------------

export function DonutChart({ segments, size = 148, centerValue, centerLabel }) {
  const [hover, setHover] = useState(null)
  const parts = (segments || []).filter((s) => s.value > 0)
  const total = parts.reduce((sum, s) => sum + s.value, 0)

  const R = 41
  const C = 2 * Math.PI * R
  // A hairline gap between arcs is what separates a chart from a pie sticker.
  const GAP = parts.length > 1 ? 1.2 : 0
  let offset = 0

  const active = hover != null ? parts.find((p) => p.key === hover) : null

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
      <div className="relative flex-none" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" role="img" aria-label={centerLabel}>
          <circle
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke="currentColor"
            className="text-surface-800"
            strokeWidth="10"
          />
          {total > 0 &&
            parts.map((s) => {
              const len = Math.max((s.value / total) * C - GAP, 0.5)
              const el = (
                <circle
                  key={s.key}
                  cx="50"
                  cy="50"
                  r={R}
                  fill="none"
                  stroke={(TONES[s.tone] || TONES.blue).fill}
                  strokeWidth={hover === s.key ? 13 : 10}
                  strokeDasharray={`${len} ${C - len}`}
                  strokeDashoffset={-offset}
                  strokeLinecap="butt"
                  className="cursor-pointer transition-[stroke-width,opacity] duration-150"
                  opacity={hover && hover !== s.key ? 0.35 : 1}
                  onMouseEnter={() => setHover(s.key)}
                  onMouseLeave={() => setHover(null)}
                />
              )
              offset += (s.value / total) * C
              return el
            })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[1.6rem] font-semibold leading-none tracking-tight tabular-nums text-ink-50">
            {active ? active.value.toLocaleString() : centerValue}
          </span>
          <span className="mt-1.5 max-w-[5.5rem] truncate text-2xs font-medium uppercase tracking-[0.08em] text-ink-500">
            {active ? active.label : centerLabel}
          </span>
        </div>
      </div>

      <ul className="min-w-[10rem] flex-1 space-y-2.5">
        {(segments || []).map((s) => {
          const pct = total > 0 ? (s.value / total) * 100 : 0
          return (
            <li
              key={s.key}
              onMouseEnter={() => setHover(s.key)}
              onMouseLeave={() => setHover(null)}
              className={clsx(
                'cursor-default transition-opacity duration-150',
                hover && hover !== s.key && 'opacity-50'
              )}
            >
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 flex-none rounded-full"
                  style={{ background: (TONES[s.tone] || TONES.blue).fill }}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-ink-300">{s.label}</span>
                <span className="flex-none text-xs font-semibold tabular-nums text-ink-100">
                  {s.value.toLocaleString()}
                </span>
                <span className="w-9 flex-none text-right text-2xs tabular-nums text-ink-500">
                  {total > 0 ? `${Math.round(pct)}%` : '-'}
                </span>
              </div>
              {/* A share bar under each legend row, the donut says the split,
 this makes small slices comparable to each other. */}
              <span
                aria-hidden="true"
                className="mt-1.5 block h-[3px] overflow-hidden rounded-full bg-surface-800"
              >
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${Math.max(pct, 1.5)}%`, background: (TONES[s.tone] || TONES.blue).fill }}
                />
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// --- ranked bar list ---------------------------------------------------------

export function BarList({ items, emptyLabel = 'Nothing recorded', mono = false, onSelect, showRank = true }) {
  const rows = items || []
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-xs text-ink-500">{emptyLabel}</p>
  }
  const max = Math.max(...rows.map((r) => r.value), 1)
  const total = rows.reduce((s, r) => s + r.value, 0)

  return (
    <ul className="divide-y divide-surface-800">
      {rows.map((r, i) => {
        const pct = (r.value / max) * 100
        const Row = onSelect ? 'button' : 'div'
        return (
          <li key={r.key}>
            <Row
              {...(onSelect
                ? {
                    type: 'button',
                    onClick: () => onSelect(r),
                    className:
                      'group relative block w-full px-4 py-2.5 text-left transition-colors hover:bg-surface-850',
                  }
                : { className: 'relative px-4 py-2.5' })}
            >
              {/* The bar is the row's own background, not a separate column , 
 keeps the label readable at any length and avoids a fixed
 gutter that truncates long action strings. */}
              <span
                aria-hidden="true"
                className={clsx(
                  'absolute inset-y-1 left-0 rounded-r-md transition-[width] duration-500 ease-emphasis',
                  r.tone === 'red'
                    ? 'bg-red-500/[0.15]'
                    : r.tone === 'amber'
                      ? 'bg-amber-500/[0.15]'
                      : 'bg-blue-500/[0.12]'
                )}
                style={{ width: `${Math.max(pct, 3)}%` }}
              />
              <span className="relative flex items-center gap-3">
                {showRank && (
                  <span className="w-3.5 flex-none text-right text-2xs font-semibold tabular-nums text-ink-600">
                    {i + 1}
                  </span>
                )}
                <span
                  className={clsx(
                    'min-w-0 flex-1 truncate text-xs text-ink-100',
                    mono && 'font-mono',
                    onSelect && 'group-hover:text-blue-600 dark:group-hover:text-blue-300'
                  )}
                  title={r.label}
                >
                  {r.label}
                </span>
                {r.meta && <span className="flex-none text-2xs text-ink-500">{r.meta}</span>}
                <span className="flex-none text-xs font-semibold tabular-nums text-ink-200">
                  {r.value.toLocaleString()}
                </span>
                <span className="w-8 flex-none text-right text-2xs tabular-nums text-ink-500">
                  {total > 0 ? `${Math.round((r.value / total) * 100)}%` : '-'}
                </span>
              </span>
            </Row>
          </li>
        )
      })}
    </ul>
  )
}
