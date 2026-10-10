const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })

export const TIME_ZONE = 'Asia/Kolkata'

export function money(rupees: number) {
  return inr.format(rupees)
}

export function orderCode(orderNo: number) {
  return `BS-${orderNo}`
}

export function timeOfDay(iso: string | null | undefined) {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE }).format(new Date(iso))
}

export function dateLabel(iso: string) {
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TIME_ZONE }).format(new Date(iso))
}

/** Calendar date (YYYY-MM-DD) in the café's time zone. */
export function cafeDate(d: Date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(d)
}

/** Formats a YYYY-MM-DD string without time-zone drift. */
export function formatDay(day: string) {
  const [y, m, d] = day.split('-').map(Number)
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  )
}

export function addDays(day: string, delta: number) {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + delta))
  return dt.toISOString().slice(0, 10)
}

/** Start of the café's business day as an ISO timestamp (IST has no DST). */
export function cafeDayStartIso(day: string = cafeDate()) {
  return new Date(`${day}T00:00:00+05:30`).toISOString()
}

export function minutesSince(iso: string, now: number = Date.now()) {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))
}

export function ago(iso: string, now: number = Date.now()) {
  const m = minutesSince(iso, now)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min ago`
}

export function hourLabel(hour: number) {
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h}${hour < 12 ? 'am' : 'pm'}`
}
