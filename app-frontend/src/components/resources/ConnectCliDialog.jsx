import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Square, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { startSession } from '../../api/resources'
import { endSession } from '../../api/sessions'
import { apiErrorMessage } from '../../lib/apiError'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { CopyButton } from '../common/CopyButton'

// ---------------------------------------------------------------------------
// Open in CLI
// ---------------------------------------------------------------------------
// The third way in, and the one PAM brokers least: the operator connects with
// their own client, so what this does is RECORD that the access happened
// before handing over the command.
//
// POST /pam/resources/:id/sessions creates the tracked session. That row is
// what makes the access appear in the audit trail, what a grant expiry
// cascades to when it revokes, and what an administrator kills. Showing the
// command without it would hand out a connection nothing knows about, which is
// the exact posture this product exists to remove.
//
// ENDING THE SESSION IS OFFERED HERE because the operator is the only one who
// knows when they are done: nothing else can observe a client that PAM is not
// in the data path of.

function CommandRow({ value }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-900 px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs text-primary">
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  )
}

export function ConnectCliDialog({ target, onClose }) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState(null)

  const resourceId = target?.resource?.id

  const start = useMutation({
    mutationFn: () => startSession(resourceId),
    onSuccess: (data) => {
      setSession(data.session)
      if (data.notice) toast.info(data.notice)
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const end = useMutation({
    mutationFn: (id) => endSession(id),
    onSuccess: () => {
      setSession(null)
      toast.success('Session ended')
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      onClose()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  // One start per opening. The dependency is the resource id rather than the
  // whole target so re-rendering the parent cannot fire a second session.
  useEffect(() => {
    if (!resourceId) return
    setSession(null)
    start.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId])

  if (!target) return null

  const { resource, info, command } = target
  const endpoint = info?.port ? `${info.host}:${info.port}` : info?.host

  return (
    <Modal
      open
      onClose={onClose}
      title={`Connect to ${resource.name}`}
      icon={Terminal}
      size="md"
    >
      <div className="flex flex-col gap-4">
        {start.isPending && <p className="text-sm text-secondary">Recording the session…</p>}

        {start.isError && (
          <p className="text-sm text-danger">{apiErrorMessage(start.error)}</p>
        )}

        {session && (
          <>
            <p className="flex items-center gap-2 text-sm text-secondary">
              <span className="relative flex h-2 w-2 flex-none rounded-full bg-emerald-500">
                <span className="dot-live absolute inset-0 rounded-full bg-emerald-500" />
              </span>
              Session {String(session.id).slice(0, 8)} is open and on the audit trail.
            </p>

            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-tertiary">
                Run this in your own client
              </p>
              <CommandRow value={command} />
            </div>

            {endpoint && (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-tertiary">
                  Endpoint
                </p>
                <CommandRow value={endpoint} />
              </div>
            )}

            <p className="text-xs leading-relaxed text-tertiary">
              The credential is not shown here. Ask an administrator if you do not already hold the
              account this resource expects.
            </p>
          </>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {session && (
          <Button
            variant="secondary"
            icon={Square}
            loading={end.isPending}
            onClick={() => end.mutate(session.id)}
          >
            End session
          </Button>
        )}
      </div>
    </Modal>
  )
}
