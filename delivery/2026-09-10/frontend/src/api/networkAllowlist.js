import { http } from '../lib/http'

// Which source networks may reach this console at all.
// (internal/api/handlers/network_allowlist_handler.go)
//
// Root only, on the server, by middleware.RequireRoot on top of the Admin
// Center's existing RequireAdmin. An admin able to edit this could lock root
// out or open the console to a range root never sanctioned, so the console
// hides the panel from anyone who is not root AND the server refuses them —
// the hidden UI is a courtesy, the 403 is the control.
//
// These same ranges are rendered as nginx allow/deny directives for the
// console container (allowlist.conf, fetched by its entrypoint). Both
// enforcement points read this one list; neither keeps a copy.

const BASE = '/api/v1/pam/admin/network/allowlist'

// { enabled, entries, your_ip, your_ip_is_allowed,
//   your_ip_is_infrastructure, proxy_state }
//
// your_ip is the address the API actually sees, which behind a load balancer
// is the only one that matters and the only one the browser cannot work out
// for itself. It is what the "this is you" marker and the lockout warnings
// are built from.
//
// proxy_state is what the DEPLOYMENT has decided about the hop in front of
// the API, and it is the difference between this panel being safe and being
// a trap:
//
//   configured  proxy ranges given, so your_ip is genuinely the operator
//   direct      the operator asserted nothing sits in front, so the socket
//               peer is the operator, private range or not
//   undecided   nobody answered, so behind a load balancer your_ip is the
//               BALANCER. Adding it and enabling would admit every network
//               that can reach the balancer, while the switch reads
//               Enforcing.
//
// your_ip_is_infrastructure says whether that address looks like a hop
// (RFC1918, carrier-grade NAT, link-local) rather than a person. Together
// they are what the warning below is built from.
export async function getNetworkAllowlist(signal) {
  const { data } = await http.get(BASE, { signal })
  const payload = data?.data ?? {}
  return {
    enabled: Boolean(payload.enabled),
    entries: Array.isArray(payload.entries) ? payload.entries : [],
    yourIp: payload.your_ip || '',
    yourIpIsAllowed: Boolean(payload.your_ip_is_allowed),
    yourIpIsInfrastructure: Boolean(payload.your_ip_is_infrastructure),
    // Defaults to the safe reading when an older backend omits it: an
    // unknown state is treated as answered, so the panel does not shout at
    // a deployment it cannot actually assess.
    proxyState: payload.proxy_state || 'configured',
  }
}

// True when the API cannot vouch for the address it is showing.
//
// This is the state where the panel's most inviting control was also the one
// that silently opened the product to everyone. Exported so the panel and
// its test agree on the condition rather than each spelling it out.
export function proxyAddressUnreliable(data) {
  return data?.proxyState === 'undecided' && Boolean(data?.yourIpIsInfrastructure)
}

export async function addNetworkAllowlistEntry({ cidr, label }) {
  const { data } = await http.post(BASE, { cidr, label: label || '' })
  return data?.data ?? null
}

export async function removeNetworkAllowlistEntry(id) {
  const { data } = await http.delete(`${BASE}/${id}`)
  return data?.data ?? null
}

// The server refuses to turn this ON from an address no entry covers, and
// answers 409. That is not a validation nicety: enabling it is the one
// action here that can make the console unreachable for the person taking
// it, and undoing that needs a redeploy or a database edit.
export async function setNetworkAllowlistEnabled(enabled) {
  const { data } = await http.put(`${BASE}/enabled`, { enabled })
  return data?.data ?? null
}
