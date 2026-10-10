// Maps backend error codes (raised by the database functions) to friendly copy.
const MESSAGES: Record<string, string> = {
  cafe_closed: 'The café is closed right now, so orders are paused.',
  upi_unavailable: 'UPI is not available right now. Please choose cash.',
  item_unavailable: 'Something in your cart just sold out. Please review your cart.',
  addon_unavailable: 'An add-on in your cart is no longer available. Please review your cart.',
  item_not_found: 'An item in your cart is no longer on the menu. Please review your cart.',
  invalid_items: 'Your cart could not be read. Please review it and try again.',
  invalid_quantity: 'Please check the quantities (up to 20 of each item, 50 items per order).',
  invalid_addons: 'Please check the add-ons you selected.',
  invalid_note: 'Notes can be up to 120 characters.',
  invalid_name: 'Please enter your name.',
  invalid_phone: 'Enter a valid 10-digit Indian mobile number.',
  invalid_payment_method: 'Please choose how you will pay.',
  too_many_open_orders: 'You already have 3 orders in progress. Please collect them before ordering more.',
  invalid_request: 'Something went wrong with this order. Please try again.',
  order_not_found: 'We couldn’t find this order on this device.',
  cannot_cancel: 'This order can no longer be cancelled here. Please speak to the counter.',
  not_allowed: 'You don’t have permission to do that.',
  owner_only: 'Only the owner can do that.',
  invalid_transition: 'This order was already updated. The board has been refreshed.',
  payment_required: 'Confirm the payment before handing over the order.',
  cancel_reason_required: 'Please give a reason for cancelling.',
  order_cancelled: 'This order is cancelled.',
  reference_requires_paid: 'Add a reference only when marking the order paid.',
  kitchen_can_only_change_availability: 'Kitchen accounts can only change availability.',
  cannot_change_own_role_or_status: 'You can’t change your own role or deactivate yourself.',
  invalid_range: 'Choose a date range of up to 92 days.',
  conflict: 'Someone else updated this order first. The board has been refreshed.',
  network: 'You seem to be offline. Check your connection and try again.',
  invalid_credentials: 'Email or password is incorrect.',
  not_staff: 'This account doesn’t have staff access. Ask the owner to add you.',
}

export class AppError extends Error {
  code: string
  constructor(code: string, message?: string) {
    super(message ?? MESSAGES[code] ?? 'Something went wrong. Please try again.')
    this.code = code
  }
}

export function friendlyError(err: unknown): string {
  if (err instanceof AppError) return err.message
  if (err instanceof Error && MESSAGES[err.message]) return MESSAGES[err.message]
  if (typeof navigator !== 'undefined' && !navigator.onLine) return MESSAGES.network
  return 'Something went wrong. Please try again.'
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err
  const raw = err as { message?: string; code?: string } | null
  const msg = raw?.message ?? ''
  if (MESSAGES[msg]) return new AppError(msg)
  if (/fetch|network|Failed to fetch|Load failed/i.test(msg)) return new AppError('network')
  if (raw?.code === '42501') return new AppError('not_allowed')
  if (raw?.code === '23505') return new AppError('duplicate', 'That name is already in use.')
  if (raw?.code === '23503') return new AppError('in_use', 'This is still in use and can’t be deleted.')
  if (raw?.code === '23514') return new AppError('invalid', 'Please check the values you entered.')
  return new AppError('unknown')
}
