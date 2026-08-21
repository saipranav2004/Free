// Shared vocabulary for role criticality, so the table column, the facet
// chips, the drawer and the override dialog cannot disagree about what
// "HIGH" looks like or what it means.
//
// The four bands mirror the backend's models.CriticalityBand and the tier
// model Entra ID uses for privileged roles, where Tier 0 is the set that has
// to be protected hardest. Keeping the tier number visible matters because
// tiers are what security teams actually speak in, and because a tier sorts
// correctly where the band string does not.

export const CRITICALITY_BANDS = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW']

// tone maps onto the app's semantic status tones (see components/ui/bits.jsx),
// NOT onto raw colours: criticality has to read the same as every other piece
// of state in the console, and it has to survive a theme change.
//
// Note that MODERATE is 'accent' rather than a third warning colour. Three
// shades of red-to-amber next to each other is how a severity column turns
// into an unreadable heat wall, which is the specific failure AWS calls out
// when it tells you to filter findings rather than colour them all.
const BAND_META = {
  CRITICAL: {
    label: 'Critical',
    tier: 0,
    tone: 'danger',
    blurb: 'Unrestricted or self-escalating access. Treat a compromise here as a full control plane compromise.',
  },
  HIGH: {
    label: 'High',
    tier: 1,
    tone: 'warn',
    blurb: 'Broad administrative reach over production secrets or sessions, but bounded.',
  },
  MODERATE: {
    label: 'Moderate',
    tier: 2,
    tone: 'accent',
    blurb: 'Real write access, scoped to one domain.',
  },
  LOW: {
    label: 'Low',
    tier: 3,
    tone: 'muted',
    blurb: 'Read mostly. No standing path to a secret.',
  },
}

export function bandMeta(band) {
  return BAND_META[String(band || '').toUpperCase()] || BAND_META.LOW
}

export function bandLabel(band) {
  return bandMeta(band).label
}

export function bandTone(band) {
  return bandMeta(band).tone
}

export function bandTier(band) {
  return bandMeta(band).tier
}

// Sort helper: most critical first, then by score, then by name. Total and
// stable, so two tables sorted the same way always agree.
export function compareByCriticality(a, b) {
  const ta = bandTier(a?.band)
  const tb = bandTier(b?.band)
  if (ta !== tb) return ta - tb
  const sa = a?.score ?? 0
  const sb = b?.score ?? 0
  if (sa !== sb) return sb - sa
  return String(a?.role_name || '').localeCompare(String(b?.role_name || ''))
}

// The factor bar in the drawer is a proportion, so a factor that scored 12 of
// 15 reads as nearly full rather than as "12".
export function factorPercent(factor) {
  const max = Number(factor?.max) || 0
  if (max <= 0) return 0
  const pct = (Number(factor?.score) || 0) / max
  return Math.max(0, Math.min(100, Math.round(pct * 100)))
}
