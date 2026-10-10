/** 256-bit secret, hex encoded. Proves this device owns an order. */
export function newAccessToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function newId() {
  return crypto.randomUUID()
}
