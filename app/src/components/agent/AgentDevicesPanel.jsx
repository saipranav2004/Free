import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Laptop, Trash2 } from 'lucide-react'
import { listAgentDevices, revokeAgentDevice } from '../../api/agent'
import { apiErrorMessage } from '../../lib/apiError'
import { QueryState } from '../common/QueryState'
import { Spinner } from '../common/Spinner'
import { Badge } from '../common/Badge'
import { PairAgentPanel } from './PairAgentPanel'

function formatLastSeen(iso) {
  if (!iso) return 'Never'
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diffMs / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString()
}

// Settings-page section: the full device-management view (list + revoke +
// pair-a-new-one). ConnectPanel embeds only PairAgentPanel inline for the
// "no device yet" case, this is the fuller picture for someone managing
// multiple machines over time.
export function AgentDevicesPanel() {
  const queryClient = useQueryClient()
  const [showPairing, setShowPairing] = useState(false)

  const devicesQuery = useQuery({
    queryKey: ['agent', 'devices'],
    queryFn: ({ signal }) => listAgentDevices(signal),
  })

  const revokeMutation = useMutation({
    mutationFn: (deviceId) => revokeAgentDevice(deviceId),
    onSuccess: () => {
      toast.success('Device revoked')
      queryClient.invalidateQueries({ queryKey: ['agent', 'devices'] })
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  return (
    <div className="rounded-xl border border-surface-700/70 bg-surface-900 p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink-50">Local agent devices</h3>
          <p className="mt-1 text-xs text-ink-400">
            Machines paired to launch connections directly through the{' '}
            <code className="text-ink-300">pam-agent</code> CLI instead of the browser.
          </p>
        </div>
        <button
          onClick={() => setShowPairing((s) => !s)}
          className="flex-none rounded-lg bg-surface-800 transition-colors px-3 py-1.5 text-xs font-medium text-ink-100 hover:bg-surface-700"
        >
          {showPairing ? 'Hide' : 'Pair a device'}
        </button>
      </div>

      {showPairing && (
        <div className="mt-4">
          <PairAgentPanel
            onPaired={() => {
              setShowPairing(false)
              queryClient.invalidateQueries({ queryKey: ['agent', 'devices'] })
              toast.success('Agent paired')
            }}
          />
        </div>
      )}

      <div className="mt-4">
        <QueryState
          query={devicesQuery}
          empty={(data) => (data?.devices || []).filter((d) => d.status === 'ACTIVE').length === 0}
          emptyMessage="No agent devices paired yet."
        >
          {(data) => (
            <ul className="divide-y divide-surface-800">
              {data.devices
                .filter((d) => d.status === 'ACTIVE')
                .map((d) => (
                  <li key={d.id} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <Laptop className="h-4 w-4 flex-none text-ink-500" />
                      <div>
                        <p className="text-sm text-ink-100">{d.device_name}</p>
                        <p className="text-xs text-ink-500">Last seen: {formatLastSeen(d.last_seen_at)}</p>
                      </div>
                      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30">
                        Active
                      </Badge>
                    </div>
                    <button
                      onClick={() => revokeMutation.mutate(d.id)}
                      disabled={revokeMutation.isPending}
                      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30 disabled:opacity-60"
                    >
                      {revokeMutation.isPending && revokeMutation.variables === d.id ? (
                        <Spinner size="h-3.5 w-3.5" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      Revoke
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </QueryState>
      </div>
    </div>
  )
}
