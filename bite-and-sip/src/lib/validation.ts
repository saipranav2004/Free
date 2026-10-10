export function cleanText(value: string) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Returns a 10-digit Indian mobile number, or null. Accepts +91 / 0 prefixes and spaces. */
export function normalizePhone(value: string) {
  const digits = value.replace(/[\s()-]/g, '').replace(/^(\+91|91|0)(?=[6-9]\d{9}$)/, '')
  return /^[6-9]\d{9}$/.test(digits) ? digits : null
}

export function validateName(value: string): string | null {
  const v = cleanText(value)
  if (!v) return 'Please enter your name so we can call you at the counter.'
  if (v.length > 40) return 'Please keep your name under 40 characters.'
  return null
}

export function validatePhone(value: string): string | null {
  if (!value.trim()) return 'Please enter your mobile number.'
  if (!normalizePhone(value)) return 'Enter a valid 10-digit Indian mobile number.'
  return null
}

export function normalizeTableLabel(value: string | null | undefined) {
  if (!value) return null
  const v = value.trim().toUpperCase()
  return /^[A-Z0-9-]{1,10}$/.test(v) ? v : null
}
