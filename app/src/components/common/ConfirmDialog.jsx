import { useEffect, useState } from 'react'
import { AlertTriangle, ShieldCheck } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'

// A real confirm() modal, not window.confirm(), window.confirm is
// synchronous and blocks the whole tab (including any pending fetch/timer
// callbacks), renders inconsistently across browsers, and can't show a
// reason-required text field for the destructive actions here (revoke
// grant, kill session, deny request) that the backend requires an
// audit-logged reason for anyway.
//
// requireReason: when true, the confirm button stays disabled until the
// user types something, this exists because several backend endpoints
// (deny, revoke) 400 with "a reason is required for the audit record" if
// the reason is blank, and surfacing that as a disabled button beats a
// round-trip just to learn the field was required.
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = true,
  requireReason = false,
  reasonLabel = 'Reason',
  isLoading = false,
  onConfirm,
  onCancel,
}) {
  const [reason, setReason] = useState('')

  // Reset the typed reason whenever the dialog closes, so the next
  // destructive action never opens pre-filled with the previous one's text.
  useEffect(() => {
    if (!open) setReason('')
  }, [open])

  const canConfirm = !requireReason || reason.trim().length > 0

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      icon={destructive ? AlertTriangle : ShieldCheck}
      tone={destructive ? 'danger' : 'default'}
      busy={isLoading}
      size="md"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            size="md"
            onClick={() => onConfirm(reason.trim())}
            disabled={!canConfirm}
            loading={isLoading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {requireReason ? (
        <div>
          <label htmlFor="confirm-reason" className="mb-1.5 block text-xs font-medium text-ink-300">
            {reasonLabel}
          </label>
          <textarea
            id="confirm-reason"
            autoFocus
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-ink-50 shadow-sm transition-[border-color,box-shadow] duration-150 placeholder:text-ink-500 hover:border-surface-600 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/20"
            placeholder="Recorded in the tamper-evident audit log"
          />
          <p className="mt-1.5 text-xs text-ink-500">
            This text is written to the audit record for this action and cannot be edited afterwards.
          </p>
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-ink-400">
          {destructive
            ? 'This action is recorded in the audit log and cannot be undone.'
            : 'This action is recorded in the audit log.'}
        </p>
      )}
    </Modal>
  )
}
