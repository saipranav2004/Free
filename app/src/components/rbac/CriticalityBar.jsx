import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { CRITICALITY_BANDS, bandMeta } from '../../lib/criticality'

// ---------------------------------------------------------------------------
// Estate criticality distribution
// ---------------------------------------------------------------------------
// FORM: part-to-whole over four ordered classes, so a horizontal stacked bar,
// not a pie and not four separate tiles. Horizontal because the class names are
// words rather than dates.
//
// COLOUR JOB: status, not categorical. Criticality is a severity ramp, so the
// fills come from the band vocabulary in lib/criticality.js, which was picked
// by running the palette validator against this app's real light and dark
// surfaces rather than by eye.
//
// Colour never carries the meaning alone: each segment is separated by a
// surface gap, the legend pairs a swatch with the band name and count, and a
// hidden table below states the same numbers for a screen reader. Segments
// double as filters, which is the point of showing the distribution at all,
// "show me the four Critical ones" is the reason to render this.

function useDarkMode() {
  // The published fills differ per theme because they were validated against
  // each surface separately, so the component has to know which one is live.
  // Three states to handle: explicit dark, explicit light, and the default
  // where only the OS preference decides.
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const read = () => {
      const attr = document.documentElement.getAttribute('data-theme')
      if (attr === 'dark') return true
      if (attr === 'light') return false
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    }
    setDark(read())
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onMedia = () => setDark(read())
    mq?.addEventListener?.('change', onMedia)
    const obs = new MutationObserver(onMedia)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      mq?.removeEventListener?.('change', onMedia)
      obs.disconnect()
    }
  }, [])
  return dark
}

export function CriticalityBar({ byBand, total, active, onSelect, className }) {
  const dark = useDarkMode()
  const counts = CRITICALITY_BANDS.map((band) => ({
    band,
    meta: bandMeta(band),
    count: Number(byBand?.[band]) || 0,
  })).filter((s) => s.count > 0)

  const sum = total || counts.reduce((n, s) => n + s.count, 0)
  if (sum === 0) return null

  return (
    <div className={className}>
      <div
        className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full"
        // A GROUP, NOT AN IMG. role="img" declares the subtree to be a single
        // graphic, so the buttons inside it were interactive controls nested
        // in a element that says it has no interior: assistive technology is
        // entitled to hide them entirely, which would make every band
        // unreachable without a mouse. role="group" carries the same summary
        // label and leaves the segments as the real controls they are.
        role="group"
        aria-label={`Criticality across ${sum} roles: ${counts
          .map((s) => `${s.count} ${s.meta.label}`)
          .join(', ')}. Select a band to filter.`}
      >
        {counts.map((s) => (
          <button
            key={s.band}
            type="button"
            onClick={() => onSelect?.(active === s.band ? 'all' : s.band)}
            title={`${s.count} ${s.meta.label}. Click to filter.`}
            aria-label={`Filter to ${s.count} ${s.meta.label} roles`}
            style={{
              width: `${(s.count / sum) * 100}%`,
              backgroundColor: dark ? s.meta.fillDark : s.meta.fill,
              // The active segment keeps full strength; the rest step back so
              // the filtered class is obvious without repainting anything.
              opacity: !active || active === 'all' || active === s.band ? 1 : 0.35,
            }}
            className="h-full min-w-[3px] cursor-pointer transition-opacity first:rounded-l-full last:rounded-r-full hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
          />
        ))}
      </div>

      {/* Legend. Always present, because a status colour must never be the
          only channel carrying the meaning. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {counts.map((s) => {
          const on = active === s.band
          return (
            <button
              key={s.band}
              type="button"
              onClick={() => onSelect?.(on ? 'all' : s.band)}
              className={clsx(
                'group flex items-center gap-1.5 rounded text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                on ? 'text-primary' : 'text-secondary hover:text-primary'
              )}
            >
              <span
                aria-hidden="true"
                style={{ backgroundColor: dark ? s.meta.fillDark : s.meta.fill }}
                className="h-2.5 w-2.5 flex-none rounded-sm"
              />
              <span className={on ? 'font-semibold' : undefined}>{s.meta.label}</span>
              <span className="tabular text-tertiary">{s.count}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
