// Formatting helpers. Deliberately tiny — the mockups render real-shaped
// values, and these only decide how a timestamp or a duration reads.

export function relative(isoString) {
  if (!isoString) return '—'
  const diff = new Date(isoString).getTime() - Date.now()
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60_000)
  const hours = Math.round(abs / 3_600_000)
  const days = Math.round(abs / 86_400_000)
  const unit = mins < 60 ? `${mins}m` : hours < 48 ? `${hours}h` : `${days}d`
  return diff < 0 ? `${unit} ago` : `in ${unit}`
}

// Countdown text for a grant/request expiry. Returns the string plus a tone,
// so a caller never has to re-derive "is this urgent".
export function countdown(isoString) {
  if (!isoString) return { text: '—', tone: 'neutral' }
  const diff = new Date(isoString).getTime() - Date.now()
  if (diff <= 0) return { text: 'expired', tone: 'neutral' }
  const mins = Math.floor(diff / 60_000)
  const hours = Math.floor(mins / 60)
  const text = hours >= 1 ? `${hours}h ${mins % 60}m left` : `${mins}m left`
  const tone = mins <= 30 ? 'danger' : mins <= 12 * 60 ? 'warn' : 'neutral'
  return { text, tone }
}

export function duration(seconds) {
  if (seconds == null) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function dateTime(isoString) {
  if (!isoString) return '—'
  return new Date(isoString).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function bytes(n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}

// Status → tone. The single mapping, so no screen invents its own.
export const JIT_TONE = {
  PENDING: 'warn',
  PARTIALLY_APPROVED: 'warn',
  WAITING: 'warn',
  APPROVED: 'ok',
  DENIED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
}

export const JIT_LABEL = {
  PENDING: 'Pending',
  PARTIALLY_APPROVED: '1 of 2 approved',
  WAITING: 'Waiting period',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
}

export const GRANT_TONE = { ACTIVE: 'ok', EXPIRED: 'neutral', REVOKED: 'danger' }
export const SESSION_TONE = { ACTIVE: 'ok', ENDED: 'neutral', KILLED: 'danger' }
export const OUTCOME_TONE = { SUCCESS: 'ok', DENIED: 'danger', ERROR: 'danger', PENDING: 'warn', FAILURE: 'danger' }
export const USER_STATUS_TONE = { ACTIVE: 'ok', LOCKED: 'warn', SUSPENDED: 'danger', DISABLED: 'neutral' }
