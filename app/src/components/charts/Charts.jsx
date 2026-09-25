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

// THEME TOKENS, NOT LITERALS.
//
// These were five hard-coded hex values shared by both themes, and every one
// of them failed contrast in one of the two: the blue measured 3.07:1 on the
// dark card, the emerald 2.54:1 and the amber 2.15:1 on the white one. A dark
// palette has to be SELECTED against the dark surface rather than inherited
// from the light one, so the values now live in index.css as two validated
// sets and the charts just read whichever is active.
//
// The vocabulary is deliberately small. `series` is volume and `denied` is the
// exception inside it: an emphasis pair, not two peer categories. A green for
// "succeeded" against a red for "denied" was the obvious thing to reach for
// and is the one thing that cannot be used, because the two measure 5.0 dE
// apart under deuteranopia.
const TONES = {
  blue: { stroke: 'rgb(var(--chart-series))', fill: 'rgb(var(--chart-series))' },
  red: { stroke: 'rgb(var(--chart-denied))', fill: 'rgb(var(--chart-denied))' },
  ink: { stroke: 'rgb(var(--chart-muted))', fill: 'rgb(var(--chart-muted))' },
  // Kept as aliases so any caller still naming them renders in the validated
  // vocabulary rather than in a colour that exists nowhere else.
  emerald: { stroke: 'rgb(var(--chart-series))', fill: 'rgb(var(--chart-series))' },
  amber: { stroke: 'rgb(var(--chart-denied))', fill: 'rgb(var(--chart-denied))' },
}

const SEQ = [
  'rgb(var(--chart-seq-1))',
  'rgb(var(--chart-seq-2))',
  'rgb(var(--chart-seq-3))',
  'rgb(var(--chart-seq-4))',
]

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

// A row's bar can carry a second, DENIED portion. When it does the bar becomes
// a small stacked bar rather than changing colour wholesale, which is the fix
// for the "red = contains a denial" legend this used to need: a red row said
// only that a denial existed somewhere in the category, not how much of it was
// denied, and it said even that in colour alone.
export function BarList({
  items,
  emptyLabel = 'Nothing recorded',
  mono = false,
  onSelect,
  showRank = true,
}) {
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
        const denied = Math.min(r.value, Math.max(0, Number(r.denied) || 0))
        const deniedShare = r.value > 0 ? (denied / r.value) * 100 : 0
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
                className="absolute inset-y-1 left-0 flex overflow-hidden rounded-r-md transition-[width] duration-500 ease-emphasis"
                style={{ width: `${Math.max(pct, 3)}%` }}
              >
                <span
                  className="h-full"
                  style={{
                    width: `${100 - deniedShare}%`,
                    background: 'rgb(var(--chart-series) / 0.14)',
                  }}
                />
                {deniedShare > 0 && (
                  <span
                    className="h-full"
                    style={{
                      width: `${deniedShare}%`,
                      background: 'rgb(var(--chart-denied) / 0.24)',
                      // 2px surface gap between the two fills, per the mark
                      // spec, rather than a border drawn around them.
                      borderLeft: '2px solid rgb(var(--bg-surface))',
                    }}
                  />
                )}
              </span>
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
                {denied > 0 && (
                  <span
                    className="flex-none tabular-nums text-2xs font-semibold"
                    style={{ color: 'rgb(var(--chart-denied))' }}
                    title={`${denied} denied or failed`}
                  >
                    {denied} denied
                  </span>
                )}
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

// --- column chart: counts per time bucket ------------------------------------
//
// WHY A COLUMN AND NOT THE AREA CHART THIS REPLACES.
//
// Audit events are counted into discrete buckets: how many things happened
// between 09:00 and 10:00. A line or an area draws a continuous slope between
// two of those counts, which asserts something that is not in the data, that
// activity ramped smoothly from one bucket to the next. On a busy sample it
// looks fine and reads wrong; on a sparse one, which is the normal case for a
// PAM console, it collapses into a flat line with a single spike and reads as
// broken. Columns say the true thing: this bucket held four, that one held
// none. It is what every log tool draws over a histogram for the same reason.
//
// Two series stacked, and they are an EMPHASIS pair rather than two
// categories: the bar is the volume and the red cap is the part of it that was
// denied. That is the question the chart exists to answer, and it is answered
// inside one mark instead of asking the reader to compare two.
export function ColumnChart({ points, height = 168, valueLabel = 'Events' }) {
  const [hover, setHover] = useState(null)
  const bars = useMemo(() => points || [], [points])

  const model = useMemo(() => {
    if (!bars.length) return null
    const totals = bars.map((p) => Math.max(0, Number(p.value) || 0))
    const max = niceMax(Math.max(1, ...totals))
    const totalEvents = totals.reduce((a, b) => a + b, 0)
    const totalDenied = bars.reduce((a, p) => a + (Number(p.denied) || 0), 0)
    return { max, totalEvents, totalDenied, hasDenied: totalDenied > 0 }
  }, [bars])

  if (!model) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-tertiary">
        Nothing recorded in this window
      </div>
    )
  }

  const { max, totalEvents, totalDenied, hasDenied } = model
  // Ticks are 0, half, full. Three solid hairlines, because a value axis with
  // no numbers on it makes a peak of 4 and a peak of 400 look identical.
  const ticks = [0, max / 2, max]
  const active = hover != null ? bars[hover] : null

  return (
    <div className="relative">
      <div className="flex gap-2" style={{ height }}>
        {/* value axis */}
        <div className="flex w-8 flex-none flex-col justify-between py-px text-right">
          {[...ticks].reverse().map((t) => (
            <span key={t} className="tabular text-2xs leading-none text-tertiary">
              {t}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          {/* Solid hairlines, one shade off the surface. Dashed grid reads as a
              threshold or a projection when it is only a grid. */}
          {ticks.map((t) => (
            <span
              key={t}
              aria-hidden="true"
              className="absolute inset-x-0 h-px"
              style={{ bottom: `${(t / max) * 100}%`, background: 'rgb(var(--chart-grid))' }}
            />
          ))}

          <div
            className="absolute inset-0 flex items-end gap-px"
            onMouseLeave={() => setHover(null)}
          >
            {bars.map((p, i) => {
              const total = Math.max(0, Number(p.value) || 0)
              const denied = Math.min(total, Math.max(0, Number(p.denied) || 0))
              const ok = total - denied
              const isOn = hover === i
              return (
                <button
                  key={p.label ?? i}
                  type="button"
                  tabIndex={-1}
                  aria-label={`${p.label}: ${total} ${valueLabel.toLowerCase()}${denied ? `, ${denied} denied` : ''}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  className="group relative flex h-full min-w-0 flex-1 cursor-default flex-col justify-end"
                >
                  {/* The hit target is the whole column, so a one-event bucket
                      two pixels tall is still hoverable. */}
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'absolute inset-0 transition-colors',
                      isOn ? 'bg-hover' : 'bg-transparent'
                    )}
                  />
                  {total > 0 && (
                    <span
                      className="chart-rise relative flex w-full flex-col justify-end"
                      style={{ height: `${(total / max) * 100}%` }}
                    >
                      {denied > 0 && (
                        <span
                          className="w-full rounded-t-[3px]"
                          style={{
                            height: `${(denied / total) * 100}%`,
                            background: 'rgb(var(--chart-denied))',
                            opacity: isOn ? 1 : 0.92,
                          }}
                        />
                      )}
                      <span
                        className={clsx('w-full', denied > 0 ? '' : 'rounded-t-[3px]')}
                        style={{
                          height: `${(ok / total) * 100}%`,
                          // A 2px surface gap between stacked fills, drawn as a
                          // border rather than a stroke around the marks.
                          borderTop: denied > 0 ? '2px solid rgb(var(--bg-surface))' : undefined,
                          background: 'rgb(var(--chart-series))',
                          opacity: isOn ? 1 : 0.92,
                        }}
                      />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* time axis: first, middle and last only. A label under every column is
          unreadable and goes unread. */}
      <div className="ml-10 mt-1.5 flex justify-between text-2xs tabular text-tertiary">
        <span>{bars[0]?.label}</span>
        {bars.length > 2 && <span>{bars[Math.floor(bars.length / 2)]?.label}</span>}
        <span>{bars[bars.length - 1]?.label}</span>
      </div>

      {/* legend, always present for two series, carrying the totals so the
          chart answers "how much" without the eye leaving it */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-soft pt-2.5">
        <span className="flex items-center gap-1.5 text-xs text-secondary">
          <span
            className="h-2 w-2 rounded-sm"
            style={{ background: 'rgb(var(--chart-series))' }}
            aria-hidden="true"
          />
          {valueLabel}
          <span className="tabular font-semibold text-primary">{totalEvents}</span>
        </span>
        {hasDenied && (
          <span className="flex items-center gap-1.5 text-xs text-secondary">
            <span
              className="h-2 w-2 rounded-sm"
              style={{ background: 'rgb(var(--chart-denied))' }}
              aria-hidden="true"
            />
            Denied or failed
            <span className="tabular font-semibold text-primary">{totalDenied}</span>
          </span>
        )}
        {active && (
          <span className="ml-auto tabular text-xs text-secondary">
            <span className="font-semibold text-primary">{active.label}</span>
            {'  '}
            {active.value} {valueLabel.toLowerCase()}
            {active.denied ? `, ${active.denied} denied` : ''}
          </span>
        )}
      </div>
    </div>
  )
}

// --- activity heatmap: day of week by hour ----------------------------------
//
// THE ONE CHART A PRIVILEGED ACCESS CONSOLE SHOULD HAVE AND DID NOT.
//
// Volume over time answers "how much"; this answers "when", and in a PAM
// product when is most of the signal. Privileged work has a shape: a team
// works weekday daytimes, batch jobs run at 02:00, and the cell that lights up
// at 03:00 on a Sunday is the one worth a question. No amount of totals
// surfaces that, because the total is the same however it is distributed.
//
// A grid of magnitudes takes a SEQUENTIAL ramp, one hue, more is more. Zero is
// drawn as an empty cell rather than as a fifth pale step, which is honest
// (nothing happened, it is not a small amount of something) and is also what
// keeps the pale end of the ramp above the contrast floor.
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function ActivityHeatmap({ cells, emptyLabel = 'Nothing recorded yet' }) {
  const [hover, setHover] = useState(null)

  const model = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0))
    let total = 0
    for (const c of cells || []) {
      const d = Number(c.day)
      const h = Number(c.hour)
      if (!Number.isInteger(d) || !Number.isInteger(h)) continue
      if (d < 0 || d > 6 || h < 0 || h > 23) continue
      grid[d][h] += Number(c.count) || 0
      total += Number(c.count) || 0
    }
    // Thresholds from the QUANTILES of the occupied cells, not from the max.
    // One 40-event spike against a floor of ones would otherwise push every
    // real cell into the palest step and flatten the whole picture.
    const occupied = grid.flat().filter((v) => v > 0).sort((a, b) => a - b)
    const q = (f) => (occupied.length ? occupied[Math.min(occupied.length - 1, Math.floor(occupied.length * f))] : 0)
    const stops = [q(0.25), q(0.5), q(0.75)]
    return { grid, total, stops, busiest: occupied[occupied.length - 1] || 0 }
  }, [cells])

  if (!model.total) {
    return <div className="flex h-32 items-center justify-center text-sm text-tertiary">{emptyLabel}</div>
  }

  const level = (v) => {
    if (v <= 0) return -1
    if (v <= model.stops[0]) return 0
    if (v <= model.stops[1]) return 1
    if (v <= model.stops[2]) return 2
    return 3
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[22rem]">
          {/* hour axis, every six hours so the labels never collide */}
          <div className="mb-1 flex pl-8">
            {Array.from({ length: 24 }).map((_, h) => (
              <span key={h} className="flex-1 text-center text-2xs tabular text-tertiary">
                {h % 6 === 0 ? String(h).padStart(2, '0') : ''}
              </span>
            ))}
          </div>

          <div className="space-y-[3px]" onMouseLeave={() => setHover(null)}>
            {model.grid.map((row, d) => (
              <div key={d} className="flex items-center">
                <span className="w-8 flex-none pr-1.5 text-right text-2xs text-tertiary">
                  {DAY_LABELS[d]}
                </span>
                <div className="flex flex-1 gap-[3px]">
                  {row.map((v, h) => {
                    const lv = level(v)
                    const on = hover && hover.d === d && hover.h === h
                    return (
                      <span
                        key={h}
                        role="img"
                        aria-label={`${DAY_LABELS[d]} ${String(h).padStart(2, '0')}:00, ${v} events`}
                        onMouseEnter={() => setHover({ d, h, v })}
                        className={clsx(
                          'cell-in h-4 flex-1 rounded-[2px] transition-transform',
                          lv < 0 && 'border border-line-soft',
                          on && 'scale-[1.35]'
                        )}
                        style={lv >= 0 ? { background: SEQ[lv] } : undefined}
                      />
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line-soft pt-2.5">
        <span className="text-2xs text-tertiary">Less</span>
        <span className="flex items-center gap-[3px]">
          <span className="h-3 w-3 rounded-[2px] border border-line-soft" aria-hidden="true" />
          {SEQ.map((c) => (
            <span key={c} className="h-3 w-3 rounded-[2px]" style={{ background: c }} aria-hidden="true" />
          ))}
        </span>
        <span className="text-2xs text-tertiary">More</span>
        <span className="ml-auto tabular text-xs text-secondary">
          {hover ? (
            <>
              <span className="font-semibold text-primary">
                {DAY_LABELS[hover.d]} {String(hover.h).padStart(2, '0')}:00
              </span>{' '}
              {hover.v} {hover.v === 1 ? 'event' : 'events'}
            </>
          ) : (
            <>
              Busiest hour <span className="font-semibold text-primary">{model.busiest}</span> events
            </>
          )}
        </span>
      </div>
    </div>
  )
}
