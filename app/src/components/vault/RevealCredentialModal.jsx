import { useEffect, useState } from 'react'
import { X, ShieldAlert, Eye, EyeOff } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { revealCredential } from '../../api/vault'
import { normalizeApiError } from '../../lib/apiError'
import { Spinner } from '../common/Spinner'
import { CopyButton } from '../common/CopyButton'
import { useCountdown } from '../../hooks/useCountdown'
import { formatDuration } from '../../lib/format'

// The backend's RequireMFA middleware (internal/middleware/auth.go) returns
// a plain-string 403 ("MFA verification required for this action") with no
// machine-readable `code` field, unlike the JIT grant-required case, this
// one has to be detected by matching the message text. If that ever breaks
// (message copy changes upstream), the fallback is still a correct, if
// slightly less specific, 403 message, never a crash.
function isMfaRequiredError(err) {
  return err.status === 403 && typeof err.message === 'string' && /mfa/i.test(err.message)
}

export function RevealCredentialModal({ open, onClose, credentialId, accountName }) {
  const [reason, setReason] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [result, setResult] = useState(null)
  const remainingMs = useCountdown(result?.expires_at)

  // Never let a decrypted secret linger in memory longer than it has to:
  // clear it whenever the modal closes (cancel, backdrop-adjacent close, or
  // unmount from route navigation) rather than only on an explicit "Done".
  useEffect(() => {
    if (!open) {
      setResult(null)
      setRevealed(false)
      setReason('')
    }
  }, [open])

  useEffect(() => {
    if (result && remainingMs <= 0) {
      setResult(null)
      toast.info('The revealed credential view expired.')
    }
  }, [remainingMs, result])

  const mutation = useMutation({
    mutationFn: () => revealCredential(credentialId, reason.trim()),
    onSuccess: (data) => setResult(data),
    onError: (err) => {
      const normalized = normalizeApiError(err)
      if (isMfaRequiredError(normalized)) {
        toast.error('This action requires MFA verification. Complete MFA in Settings, then try again.')
      } else {
        toast.error(normalized.message)
      }
    },
  })

  if (!open) return null

  const close = () => {
    if (mutation.isPending) return
    onClose()
  }

  return (
    <div
      className="animate-overlay-in fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/55 p-4 backdrop-blur-[3px] dark:bg-black/70"
      onKeyDown={(e) => e.key === 'Escape' && close()}
    >
      <div className="animate-panel-in w-full max-w-md rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-overlay">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-50">
            <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" /> Reveal credential
          </h3>
          <button
            onClick={close}
            disabled={mutation.isPending}
            className="text-ink-500 hover:text-ink-200 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!result ? (
          <div className="space-y-4">
            <p className="text-sm text-ink-400">
              Revealing <span className="text-ink-100">{accountName}</span> is written to the audit log with
              the reason you provide. This requires MFA to have been verified this session.
            </p>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-300">Reason</label>
              <textarea
                autoFocus
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 shadow-sm transition-[border-color,box-shadow] duration-150 hover:border-surface-600 text-sm text-ink-50 placeholder:text-ink-500 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/20"
                placeholder="Required, recorded in the audit log"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={close}
                disabled={mutation.isPending}
                className="h-9 rounded-lg px-3 text-sm font-medium text-ink-300 transition-colors hover:bg-surface-800 hover:text-ink-50 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending || reason.trim().length === 0}
                className="flex items-center gap-2 rounded-md bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:pointer-events-none disabled:opacity-40"
              >
                {mutation.isPending && <Spinner size="h-3.5 w-3.5" className="text-white" />}
                Reveal
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border border-amber-300 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-700 dark:text-amber-200">
              This view expires in {formatDuration(remainingMs / 1000)}. It will not be shown again without
              another reveal + audit entry.
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-400">
                {result.account_name} · {result.credential_type}
              </label>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-lg bg-surface-800 transition-colors px-2 py-1.5 text-xs text-ink-100">
                  {revealed ? result.plaintext : '•'.repeat(Math.min(24, result.plaintext.length || 12))}
                </code>
                <button
                  onClick={() => setRevealed((v) => !v)}
                  className="rounded-md border border-surface-700 bg-surface-800 p-1.5 text-ink-300 hover:bg-surface-700"
                  aria-label={revealed ? 'Hide' : 'Show'}
                  title={revealed ? 'Hide' : 'Show'}
                >
                  {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                <CopyButton value={result.plaintext} />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={close}
                className="rounded-lg bg-surface-800 transition-colors px-3 py-1.5 text-sm font-medium text-ink-100 hover:bg-surface-700"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
