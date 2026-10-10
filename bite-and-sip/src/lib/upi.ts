// UPI deep link per the NPCI "UPI Linking Specifications" (upi://pay?pa=&pn=&am=&cu=&tn=).
// pa and pn are mandatory; am is a decimal amount; cu is always INR.

export const UPI_ID_PATTERN = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,63}$/

export function isValidUpiId(value: string) {
  return UPI_ID_PATTERN.test(value.trim())
}

export interface UpiPayment {
  upiId: string
  payeeName: string
  amount: number
  note: string
}

export function buildUpiLink({ upiId, payeeName, amount, note }: UpiPayment) {
  if (!isValidUpiId(upiId)) throw new Error('Invalid UPI ID')
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Invalid amount')
  const params = [
    ['pa', upiId.trim()],
    ['pn', payeeName.trim().slice(0, 50)],
    ['am', amount.toFixed(2)],
    ['cu', 'INR'],
    ['tn', note.trim().slice(0, 50)],
  ]
  return `upi://pay?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
}
