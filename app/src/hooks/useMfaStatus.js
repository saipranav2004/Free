import { useMemo, useSyncExternalStore } from 'react'
import { subscribeMfaEvidence, getMfaEvidenceVersion } from '../lib/mfaEvidence'
import { readMfaStatus, mfaSummary } from '../lib/mfaStatus'

// ---------------------------------------------------------------------------
// useMfaStatus
// ---------------------------------------------------------------------------
// The one way any surface should ask "does this account have a second
// factor?". It is readMfaStatus() plus a live subscription, and the
// subscription is the whole point.
//
// readMfaStatus is pure: it reads the /auth/me payload AND the login/enrolment
// evidence map (lib/mfaEvidence). Calling it inline in a component, which is
// what every MFA surface used to do, means the answer is only recomputed when
// that component happens to re-render for some other reason. Enabling or
// disabling MFA changes the evidence map but not the /auth/me payload on this
// deployment, so after a refetch React Query hands back the identical data
// reference, the component does not re-render, and the screen keeps showing
// the previous state until a full page reload. That is exactly the reported
// "only updates after refresh" bug.
//
// Subscribing to the evidence map fixes it at the source: the moment
// enrolment completes or a device is removed, every component using this hook
// recomputes, in the same tick, without a network round trip. The ['me']
// invalidations elsewhere are still correct and still wanted (a deployment
// that DOES report enrolment must win), they are just no longer the only
// trigger.
export function useMfaStatus(me) {
  const version = useSyncExternalStore(subscribeMfaEvidence, getMfaEvidenceVersion, getMfaEvidenceVersion)
  // `version` is deliberately a dependency even though it does not appear in
  // the body. readMfaStatus reads the evidence map that `version` tracks, and
  // the lint rule cannot see through the call. Removing it is what caused the
  // "only updates after refresh" bug this hook exists to fix.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readMfaStatus(me), [me, version])
}

// Convenience for surfaces that only render the one-line posture label
// (profile menu, settings header chip) so they cannot drift from the card.
export function useMfaPosture(me) {
  const status = useMfaStatus(me)
  return useMemo(() => ({ status, posture: mfaSummary(status) }), [status])
}
