import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Laptop, RefreshCw } from 'lucide-react'
import { initAgentPairing, listAgentDevices } from '../../api/agent'
import { apiErrorMessage } from '../../lib/apiError'
import { CopyButton } from '../common/CopyButton'
import { Spinner } from '../common/Spinner'

// The pairing code is a one-time bootstrap secret (5 min default TTL,
// hashed at rest server-side, see AgentService.InitPairing) that proves
// "I am at the keyboard of a machine I control" exactly once. After the CLI
// redeems it via `pam-agent pair`, all further trust is the device's own
// Ed25519 keypair, never the code again. That's why this panel shows a
// countdown instead of a static value, a stale code left on screen after
// it expires would just produce a confusing 401 on the CLI side.
export function PairAgentPanel({ onPaired, publicBaseURLHint }) {
  const queryClient = useQueryClient()
  const [remainingSeconds, setRemainingSeconds] = useState(null)

  const pairInit = useMutation({
    mutationFn: () => initAgentPairing(),
    onSuccess: (data) => setRemainingSeconds(data.expires_in_seconds),
  })

  // Tick the countdown client-side rather than re-querying the server every
  // second, expires_in_seconds is just a snapshot from the moment the code
  // was issued.
  useEffect(() => {
    if (remainingSeconds == null) return
    if (remainingSeconds <= 0) return
    const id = setInterval(() => setRemainingSeconds((s) => (s == null ? s : s - 1)), 1000)
    return () => clearInterval(id)
  }, [remainingSeconds])

  const checkPaired = useMutation({
    mutationFn: () => listAgentDevices(),
    onSuccess: (data) => {
      if ((data.devices || []).length > 0) {
        queryClient.invalidateQueries({ queryKey: ['agent', 'devices'] })
        onPaired?.()
      }
    },
  })

  const code = pairInit.data?.pairing_code
  const expired = remainingSeconds != null && remainingSeconds <= 0
  const server = publicBaseURLHint || window.location.origin

  return (
    <div className="rounded-xl border border-surface-700/70 bg-surface-900 p-5">
      <div className="flex items-center gap-3">
        <Laptop className="h-5 w-5 text-blue-600 dark:text-blue-400" />
        <div>
          <h3 className="text-sm font-semibold text-ink-50">Pair the local agent</h3>
          <p className="text-xs text-ink-400">
            Install <code className="text-ink-300">pam-agent</code> once, then pair it to your account with a
            one-time code.
          </p>
        </div>
      </div>

      {!code || expired ? (
        <button
          onClick={() => pairInit.mutate()}
          disabled={pairInit.isPending}
          className="mt-4 flex items-center gap-2 h-10 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white shadow-sm ring-1 ring-inset ring-blue-500/50 transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:opacity-60"
        >
          {pairInit.isPending && <Spinner size="h-4 w-4" className="text-white" />}
          {expired ? 'Generate a new code' : 'Generate pairing code'}
        </button>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2">
            <code className="rounded-lg bg-surface-800 transition-colors px-3 py-2 text-lg font-semibold tracking-widest text-ink-50">
              {code}
            </code>
            <CopyButton value={code} />
            <span className="text-xs text-ink-500">expires in {Math.max(remainingSeconds, 0)}s</span>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-400">Run on your machine:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg bg-surface-800 transition-colors px-2 py-1.5 text-xs text-ink-200">
                pam-agent pair --code {code} --server {server}
              </code>
              <CopyButton value={`pam-agent pair --code ${code} --server ${server}`} />
            </div>
          </div>
          <button
            onClick={() => checkPaired.mutate()}
            disabled={checkPaired.isPending}
            className="flex items-center gap-2 rounded-lg bg-surface-800 transition-colors px-3 py-1.5 text-xs font-medium text-ink-100 hover:bg-surface-700 disabled:opacity-60"
          >
            {checkPaired.isPending ? <Spinner size="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
            I&apos;ve run this, check
          </button>
          {checkPaired.isSuccess && (checkPaired.data?.devices || []).length === 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              No paired device seen yet, make sure the command above finished successfully.
            </p>
          )}
        </div>
      )}

      {pairInit.isError && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{apiErrorMessage(pairInit.error)}</p>
      )}
    </div>
  )
}
