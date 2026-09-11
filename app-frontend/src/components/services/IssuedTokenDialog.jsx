import { useState } from 'react'
import { KeyRound, AlertTriangle, Check } from 'lucide-react'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { CopyButton } from '../common/CopyButton'
import { formatDateTime } from '../../lib/format'

// ---------------------------------------------------------------------------
// The one and only sight of a service token
// ---------------------------------------------------------------------------
// The server hands the secret half back exactly once, at mint time, and stores
// only an HMAC of it. This dialog is therefore the single moment in the entire
// product where that string exists somewhere a person can read it.
//
// WHAT THAT MEANS FOR THIS COMPONENT:
//
//   The value arrives as a prop and is never lifted into a query cache, a
//   store, localStorage or a URL. It lives in the parent's state for as long
//   as the dialog is open and is dropped on close, so a re-render, a refetch
//   or a navigation cannot bring it back.
//
//   Closing is deliberate, not incidental. There is no backdrop dismiss and no
//   Escape, because a stray click on the page behind is exactly how somebody
//   loses a credential they have not written down yet. The only way out is the
//   acknowledgement, which is disabled until it has been ticked.
//
//   It is shown in full rather than masked. Masking a value the reader is
//   being asked to copy protects nothing (it is on their clipboard either way)
//   and adds a reveal click to the one screen where fumbling has a real cost.
export function IssuedTokenDialog({ open, issued, onClose }) {
  const [acknowledged, setAcknowledged] = useState(false)

  const close = () => {
    setAcknowledged(false)
    onClose?.()
  }

  return (
    <Modal
      open={open}
      onClose={() => {}}
      closeOnBackdrop={false}
      busy={!acknowledged}
      title="Store this token now"
      description="This is the only time it will be shown. The server keeps a hash, never the token, so it cannot be shown again or recovered."
      icon={KeyRound}
      tone="warning"
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="h-4 w-4 rounded border-line text-accent focus:ring-2 focus:ring-blue-500/40"
            />
            I have stored this token somewhere safe
          </label>
          <Button variant="primary" icon={Check} disabled={!acknowledged} onClick={close}>
            Done
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-50/60 px-3.5 py-3 dark:bg-amber-950/15">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400"
            strokeWidth={1.9}
          />
          <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300/90">
            Anything holding this token can read every secret the identity is granted, until the
            token is revoked or expires. Put it straight into your secret manager or your
            deployment environment. Do not paste it into a ticket, a chat message or a source
            file.
          </p>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium text-secondary">Service token</p>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg border border-line bg-subtle px-3 py-2.5 font-mono text-xs leading-relaxed text-primary">
              {issued?.token}
            </code>
            <CopyButton value={issued?.token || ''} label="Copy token" />
          </div>
        </div>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-tertiary">Identity</dt>
            <dd className="mt-0.5 text-primary">{issued?.service_name || '-'}</dd>
          </div>
          <div>
            <dt className="text-tertiary">Token id</dt>
            <dd className="mt-0.5 font-mono text-primary">{issued?.token_id || '-'}</dd>
          </div>
          <div>
            <dt className="text-tertiary">Expires</dt>
            <dd className="mt-0.5 text-primary">
              {issued?.expires_at ? formatDateTime(issued.expires_at) : 'Does not expire'}
            </dd>
          </div>
          <div>
            <dt className="text-tertiary">Sent as</dt>
            <dd className="mt-0.5 font-mono text-primary">X-Service-Token</dd>
          </div>
        </dl>
      </div>
    </Modal>
  )
}
