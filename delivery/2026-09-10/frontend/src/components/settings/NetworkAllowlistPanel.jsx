import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Globe, Trash2, ShieldAlert } from 'lucide-react'
import {
  getNetworkAllowlist,
  addNetworkAllowlistEntry,
  removeNetworkAllowlistEntry,
  setNetworkAllowlistEnabled,
  proxyAddressUnreliable,
} from '../../api/networkAllowlist'
import { apiErrorMessage } from '../../lib/apiError'
import { QueryState } from '../common/QueryState'
import { Button } from '../common/Button'
import { Badge } from '../common/Badge'
import { Switch, SettingRow } from '../common/Switch'

const QUERY_KEY = ['network', 'allowlist']

// Which source networks may reach this console.
//
// Root only. The server enforces that with middleware.RequireRoot, so this
// panel being hidden from an admin is a courtesy rather than the control —
// SettingsPage only offers the section to root, and the API refuses anyone
// else regardless of what the browser chooses to render.
//
// The list is the single source of truth for both enforcement points: the
// API checks it on every request, and the console container renders it into
// nginx directives. Neither keeps its own copy, which is what the hard-coded
// allow/deny lines in nginx.conf used to be.
export function NetworkAllowlistPanel() {
  const queryClient = useQueryClient()
  const [cidr, setCidr] = useState('')
  const [label, setLabel] = useState('')

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => getNetworkAllowlist(signal),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY })

  const addMutation = useMutation({
    mutationFn: () => addNetworkAllowlistEntry({ cidr, label }),
    onSuccess: () => {
      toast.success('Range added', { description: 'It takes effect within a few seconds.' })
      setCidr('')
      setLabel('')
      invalidate()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const removeMutation = useMutation({
    mutationFn: (id) => removeNetworkAllowlistEntry(id),
    onSuccess: () => {
      toast.success('Range removed')
      invalidate()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const enabledMutation = useMutation({
    mutationFn: (next) => setNetworkAllowlistEnabled(next),
    onSuccess: (_res, next) => {
      toast.success(next ? 'Network allowlist enforced' : 'Network allowlist turned off')
      invalidate()
    },
    // A refusal here is the lockout guard doing its job, not a fault. The
    // server's message already names the address it saw and what to do about
    // it, so it is shown as written rather than replaced with something
    // vaguer.
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const busy = addMutation.isPending || removeMutation.isPending || enabledMutation.isPending

  return (
    <QueryState query={query}>
      {(data) => {
        const entries = data.entries
        const canEnable = entries.length > 0
        const addressUnreliable = proxyAddressUnreliable(data)

        return (
          <div className="space-y-5">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-primary">
                <Globe className="h-4 w-4" aria-hidden="true" />
                Allowed networks
              </h3>
              <p className="mt-1 max-w-prose text-sm leading-relaxed text-secondary">
                Only these source addresses may reach the console and the API. Add every range your
                team connects from before turning enforcement on. Loopback is always permitted, so
                container health checks keep working.
              </p>
            </div>

            {/* The address the API sees cannot be trusted here, so this
                comes BEFORE the switch and the add form: everything below it
                is built on that address meaning the operator, and in this one
                state it does not. See proxyAddressUnreliable. */}
            {addressUnreliable ? (
              <div className="flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
                <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-medium">This API cannot tell whose address it is seeing</p>
                  <p className="mt-1 leading-relaxed">
                    It sees you at <span className="font-mono">{data.yourIp}</span>, which is a
                    private range, and no trusted proxy set is configured. Behind a load balancer
                    that address is the balancer, not you, so adding it would let through every
                    network that can reach the balancer while this panel reads Enforcing.
                  </p>
                  <p className="mt-1 leading-relaxed">
                    Set PAM_NETWORK_TRUSTED_PROXIES on the API to the ranges of whatever sits in
                    front of it, or to the literal <span className="font-mono">none</span> if it is
                    reached directly, then reload this page.
                  </p>
                </div>
              </div>
            ) : null}

            <SettingRow
              label="Enforce the allowlist"
              description={
                addressUnreliable
                  ? 'Unavailable until the API is told which proxies to trust.'
                  : canEnable
                    ? 'Requests from any other address are refused.'
                    : 'Add at least one range before this can be turned on.'
              }
              control={
                <Switch
                  checked={data.enabled}
                  disabled={busy || addressUnreliable || (!data.enabled && !canEnable)}
                  onChange={(next) => enabledMutation.mutate(next)}
                  label="Enforce the network allowlist"
                />
              }
            />

            {data.enabled && !data.yourIpIsAllowed ? (
              <div className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
                <span>
                  Your own address {data.yourIp} is not covered by any range below. You may lose
                  access to this console.
                </span>
              </div>
            ) : null}

            <div className="overflow-hidden rounded-md ring-1 ring-inset ring-line">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-secondary">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Range
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Label
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Added by
                    </th>
                    <th scope="col" className="px-3 py-2">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-secondary">
                        No ranges yet, so every address can reach the console.
                      </td>
                    </tr>
                  ) : (
                    entries.map((entry) => (
                      <tr key={entry.id} className="border-t border-line">
                        <td className="px-3 py-2 font-mono text-primary">
                          {entry.cidr}
                          {isYourAddress(entry, data) ? (
                            <Badge className="ml-2 bg-accent/10 text-accent ring-accent/25">
                              This is you
                            </Badge>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-secondary">{entry.label || 'No label'}</td>
                        <td className="px-3 py-2 text-secondary">
                          {entry.created_by_username || 'Unknown'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            disabled={busy}
                            onClick={() => removeMutation.mutate(entry.id)}
                            aria-label={`Remove ${entry.cidr}`}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (cidr.trim()) addMutation.mutate()
              }}
            >
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-primary">IP address or CIDR range</span>
                <input
                  value={cidr}
                  onChange={(event) => setCidr(event.target.value)}
                  placeholder="203.0.113.9 or 10.0.0.0/8"
                  className="w-60 rounded-md bg-panel px-2 py-1.5 font-mono text-sm text-primary ring-1 ring-inset ring-line"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-primary">Label</span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="Head office"
                  className="w-60 rounded-md bg-panel px-2 py-1.5 text-sm text-primary ring-1 ring-inset ring-line"
                />
              </label>
              <Button type="submit" variant="primary" disabled={busy || !cidr.trim()}>
                Add range
              </Button>
              {/* Offered only when the API can vouch for the address. In the
                  unresolved state this button was the fastest route to a
                  wide-open allowlist: one click filled in the load balancer's
                  address, and the lockout guard then had no objection to
                  enabling, because the list did contain the address the API
                  saw. */}
              {data.yourIp && !addressUnreliable ? (
                <Button type="button" variant="ghost" onClick={() => setCidr(data.yourIp)}>
                  Use my address ({data.yourIp})
                </Button>
              ) : null}
            </form>
          </div>
        )
      }}
    </QueryState>
  )
}

// Marking the operator's own range matters because it is the one they must
// not remove. The server does the authoritative check and refuses the write
// either way; this only decides where to put the badge, so matching the
// exact single-host entry is enough and avoids shipping a CIDR library to
// the browser to do it.
function isYourAddress(entry, data) {
  if (!data.yourIp) return false
  return entry.cidr === `${data.yourIp}/32` || entry.cidr === `${data.yourIp}/128`
}
