// ---------------------------------------------------------------------------
// Will "Open in desktop app" actually work on this machine?
// ---------------------------------------------------------------------------
// Answered BEFORE the operator clicks, from what the agent reported when it
// paired (see the agent's launcher.Inventory and the server's
// AgentDevice.Capabilities).
//
// WHY THIS HAS TO COME FROM THE AGENT. Only the operator's own machine knows
// what is installed on it. Before this existed, the console offered the button
// to everybody and the first anyone heard of a missing mongosh was a launch
// that had already failed: a session row opened, a window never appeared, and
// the reason sat in a log file nobody reads.
//
// THREE ANSWERS, NOT TWO. "Unknown" is a real state and must not be dressed up
// as either of the others:
//
//   not-paired   no device on this account. Nothing can open anything.
//   missing-tool the machine paired and said it cannot open this type.
//   unknown      paired, but reported no capabilities: an older agent, or a
//                scan that failed. Saying "install mongosh" here would be a
//                guess, and telling somebody to install software they may
//                already have is how a product loses their trust.
//   ready        it said it can.

export const READY = 'ready'
export const NOT_PAIRED = 'not-paired'
export const MISSING_TOOL = 'missing-tool'
export const UNKNOWN = 'unknown'

function activeDevices(devices) {
  return (Array.isArray(devices) ? devices : []).filter(
    (d) => String(d?.status || 'ACTIVE').toUpperCase() !== 'REVOKED'
  )
}

/**
 * @param {Array} devices        from listAgentDevices
 * @param {string} resourceType  e.g. "mongodb"
 * @returns {{state: string, tool?: string, kind?: string, installHint?: string, device?: object}}
 */
export function readAgentReadiness(devices, resourceType) {
  const active = activeDevices(devices)
  if (active.length === 0) return { state: NOT_PAIRED }

  const type = String(resourceType || '').toLowerCase()
  if (!type) return { state: UNKNOWN }

  // ANY paired machine being able to open it is enough. The operator may have
  // several, and the agent that answers the launch is whichever one they are
  // sitting at; refusing because their other laptop lacks the tool would be
  // wrong.
  let sawAReport = false
  let hint
  for (const device of active) {
    const caps = device?.capabilities
    if (!Array.isArray(caps) || caps.length === 0) continue
    sawAReport = true
    const match = caps.find((c) => String(c?.resource_type || '').toLowerCase() === type)
    if (!match) continue
    if (match.available) {
      return { state: READY, tool: match.tool, kind: match.kind, device }
    }
    if (!hint && match.install_hint) hint = match.install_hint
  }

  if (!sawAReport) return { state: UNKNOWN, device: active[0] }
  return { state: MISSING_TOOL, installHint: hint, device: active[0] }
}

/**
 * The sentence to put in front of the operator. Kept here so the drawer, the
 * detail page and any toast cannot describe the same machine differently.
 */
export function readinessMessage(readiness, resourceName) {
  const name = resourceName ? `"${resourceName}"` : 'this resource'
  switch (readiness?.state) {
    case NOT_PAIRED:
      return {
        title: 'No paired device',
        body: `Pair the machine you are working on before opening ${name} in a desktop app. It takes one command and about a minute.`,
        action: 'Pair a device',
        to: '/settings?tab=devices',
      }
    case MISSING_TOOL:
      return {
        title: 'The client for this resource is not installed',
        body:
          readiness.installHint ||
          `Your paired machine reported that it has nothing installed that can open ${name}.`,
        action: null,
        to: null,
      }
    default:
      return null
  }
}
