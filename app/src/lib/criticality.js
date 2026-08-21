// Shared vocabulary for role criticality, so the table column, the facets, the
// distribution bar and the detail page cannot disagree about what "HIGH" looks
// like or what it means.
//
// TWO SCALES, TWO VOCABULARIES, KEPT APART
// ────────────────────────────────────────
// Criticality is INTRINSIC: what the role could do if compromised. It is
// banded, and the bands map to the tier model Entra ID uses for privileged
// roles, where Tier 0 is protected hardest.
//
// Exposure is CONTEXTUAL: how many people hold it and whether anyone uses it.
// It gets its own words (none / limited / broad / wide) precisely so it is
// never mistaken for a criticality band. Reusing "High" for both is what made
// the previous version confusing.

export const CRITICALITY_BANDS = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW']

// BAND FILLS. These are chart marks, not text, and they are NOT the app's text
// tokens: --warn is tuned as dark amber for contrast on white, which under
// deuteranopia sits 4.9 ΔE from --danger, meaning a red-green colourblind
// reader cannot separate Critical from High in a stacked bar.
//
// These four were picked by running the palette validator against the real
// surfaces (#ffffff light, #161d26 dark). Light passes CVD separation at 10.9
// ΔE, dark at 8.2, both above the 8 target. The neutral for Low is deliberate:
// "nothing to worry about" should read as absent, not as a fifth hue, and the
// chroma-floor check that flags it exists to catch a categorical slot that
// accidentally reads grey, which is not this case.
//
// Colour is never the only channel: every segment carries a label and a count,
// segments are separated by a surface gap, and the legend pairs a swatch with
// the band name. Status colour alone is not allowed to carry meaning.
const BAND_META = {
  CRITICAL: {
    label: 'Critical',
    tier: 0,
    tone: 'danger',
    fill: '#cd0a0a',
    fillDark: '#e0484d',
    blurb: 'Unrestricted or self-escalating access. Treat a compromise here as a full control plane compromise.',
  },
  HIGH: {
    label: 'High',
    tier: 1,
    tone: 'warn',
    fill: '#b8860b',
    fillDark: '#c0941c',
    blurb: 'Broad administrative reach over production secrets or sessions, but bounded.',
  },
  MODERATE: {
    label: 'Moderate',
    tier: 2,
    tone: 'accent',
    fill: '#006ce0',
    fillDark: '#3b8ef0',
    blurb: 'Real write access, scoped to one domain.',
  },
  LOW: {
    label: 'Low',
    tier: 3,
    tone: 'muted',
    fill: '#667085',
    fillDark: '#8a8578',
    blurb: 'Read mostly. No standing path to a secret.',
  },
}

export function bandMeta(band) {
  return BAND_META[String(band || '').toUpperCase()] || BAND_META.LOW
}

export const bandLabel = (b) => bandMeta(b).label
export const bandTone = (b) => bandMeta(b).tone
export const bandTier = (b) => bandMeta(b).tier

// Exposure keeps its own words on purpose, see the note at the top.
const EXPOSURE_META = {
  wide: { label: 'Wide', blurb: 'Held broadly and actively used.' },
  broad: { label: 'Broad', blurb: 'Held by several accounts.' },
  limited: { label: 'Limited', blurb: 'Held narrowly, or rarely exercised.' },
  none: { label: 'None', blurb: 'Nobody holds this role today.' },
}

export function exposureMeta(level) {
  return EXPOSURE_META[String(level || '').toLowerCase()] || EXPOSURE_META.limited
}

// The factor bar is a proportion, so a factor scoring 12 of 15 reads as nearly
// full rather than as "12".
export function factorPercent(factor) {
  const max = Number(factor?.max) || 0
  if (max <= 0) return 0
  const pct = ((Number(factor?.score) || 0) / max) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

// Sort helper: most critical first, then by the COMPUTED score, then by name.
// Computed rather than published, because an overridden role has no published
// number of its own and inventing one would report a calculation that never
// happened. Mirrors sortByCriticality in the Go service.
export function compareByCriticality(a, b) {
  const ta = bandTier(a?.band)
  const tb = bandTier(b?.band)
  if (ta !== tb) return ta - tb
  const sa = a?.computed_score ?? 0
  const sb = b?.computed_score ?? 0
  if (sa !== sb) return sb - sa
  return String(a?.role_name || '').localeCompare(String(b?.role_name || ''))
}

// "Needs attention" is the combination this feature exists to surface: a role
// that could do real damage and that nobody is actually exercising. Unused
// privileged access is the standard candidate for removal.
export function needsAttention(c) {
  if (!c) return false
  const tier = bandTier(c.band)
  return tier <= 1 && (c.exposure?.dormant || c.exposure?.holders === 0)
}
