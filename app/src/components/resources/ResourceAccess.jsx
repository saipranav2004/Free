import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import {
  Laptop,
  Globe,
  KeyRound,
  CheckCircle2,
  ShieldAlert,
  Download,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { getConnectInfo } from '../../api/resources'
import { createLaunch, getLaunchStatus, isNotPairedError } from '../../api/agent'
import { normalizeApiError } from '../../lib/apiError'
import { Button } from '../common/Button'
import { Card } from '../common/Layout'
import { Spinner } from '../common/Spinner'
import { PairAgentPanel } from '../agent/PairAgentPanel'

// ---------------------------------------------------------------------------
// Resource access launcher
// ---------------------------------------------------------------------------
// WHAT THIS REPLACES. The detail page used to hide connecting behind a
// "Connect" tab that opened a panel of loose <button>s, a dl of host/port, a
// "Start tracked session" and an "Open in Desktop App", none of which came
// from the console's button system. So the single most important thing a
// non-admin comes to this page to DO was two clicks deep, and looked like a
// debug panel when they got there.
//
// HOW ENTERPRISE PAM CONSOLES ACTUALLY SHAPE THIS, and what we took:
//   · CyberArk PVWA puts "Connect" as the primary object action with the
// client choice (RDP file / PSM web / native) as siblings under it. We
// take the three-way client choice.
//   · Delinea Secret Server surfaces the launcher as the object's own header
// action, not a tab. We take that placement.
//   · AWS Systems Manager and GCP both show a role-appropriate surface: an
// operator gets "Connect" and nothing else; an owner gets the whole
// configuration object. We take the ROLE SPLIT, a non-admin sees the
// four facts that decide whether they can connect, and the three ways to
// connect. Nothing else, because nothing else is theirs to act on.
//
// Three launch paths, and the honest difference between them:
//
//   OPEN IN DESKTOP , hands off to the already-installed pam-agent via a
// signed single-use pam-agent:// URL. This is the real
// brokered path and is therefore the primary action.
//   OPEN IN CLI     , opens a TRACKED session row (audit + JIT expiry) and
// reveals the exact command for the user's own client.
//                      There is no server-side proxy on this backend, so
// pretending to be a terminal would be a lie; giving the
// correct command and recording the session is not.
//   OPEN IN BROWSER , the resource's registered console URL. Disabled, with
// the reason stated, when the resource has none.

// ---------------------------------------------------------------------------
// Shared launch logic
// ---------------------------------------------------------------------------
// How long to keep asking the backend what became of a launch.
//
// The window has to outlast a cold agent start (the OS resolves the
// pam-agent:// handler, the binary starts, it signs and redeems the token)
// without leaving a spinner on screen forever when nothing is listening at
// all. The launch token's own lifetime is the real ceiling: once it expires
// unredeemed the backend reports "expired", which is the answer, so polling
// past that point learns nothing new.
const LAUNCH_POLL_MS = 1200
const LAUNCH_POLL_TIMEOUT_MS = 45000

// Exported so the page header's primary "Open in Desktop" button and the
// panel's own copy of it drive the identical mutation, one code path, so the
// pairing flow and the failure handling can't diverge between the two entry
// points.
//
// WHAT THIS HOOK IS FOR, beyond firing the request. Navigating to a
// pam-agent:// URL is a one-way door for the browser: the OS hands off and
// nothing comes back. So both of the failures operators actually hit were
// invisible here.
//
//   · No device paired. The backend answers 409, and this used to call
// onNeedsPairing with no message at all. Where the caller rendered a
// pairing panel that was survivable; where it did not (and one caller
// rendered nothing), clicking Connect did nothing visible whatsoever.
//   · The tool is not installed. The agent knows this precisely, and said so
// on the stderr of a process the OS started with no terminal, so it went
// nowhere. Now it reports the reason to PAM against the launch, and this
// polls for it.
//
// onLaunchState receives every state change so a caller can render progress
// and the final outcome; the toasts here are the floor, not the ceiling.
export function useDesktopLaunch(resourceId, { onNeedsPairing, onLaunchState } = {}) {
  // Held in a ref rather than state: the poll loop must not restart when a
  // re-render happens, and nothing renders directly from it.
  const pollRef = useRef(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current.timer)
      pollRef.current.cancelled = true
      pollRef.current = null
    }
  }, [])

  // Stop polling when the component goes away, or an unmounted panel keeps
  // asking the backend about a launch nobody is looking at.
  useEffect(() => stopPolling, [stopPolling])

  const pollLaunch = useCallback(
    (launchId) => {
      stopPolling()
      const ctl = { cancelled: false, timer: null, startedAt: Date.now() }
      pollRef.current = ctl

      const tick = async () => {
        if (ctl.cancelled) return
        try {
          const status = await getLaunchStatus(launchId)
          if (ctl.cancelled) return

          if (status.state === 'failed') {
            onLaunchState?.(status)
            toast.error(status.failure_reason || 'The desktop agent could not open this resource.')
            stopPolling()
            return
          }
          if (status.state === 'opened' || status.state === 'completed') {
            // The agent took the handoff and a session exists. Report it and
            // stop: from here the session's own lifecycle is the story, and
            // a long-lived poll would outlive the page.
            onLaunchState?.(status)
            stopPolling()
            return
          }
          if (status.state === 'expired') {
            onLaunchState?.(status)
            stopPolling()
            return
          }
          onLaunchState?.(status)
        } catch {
          // A failed poll is not a failed launch. The operator's session may
          // be opening perfectly well; only the reporting channel is
          // unavailable, so keep trying until the window closes.
        }
        if (ctl.cancelled) return
        if (Date.now() - ctl.startedAt > LAUNCH_POLL_TIMEOUT_MS) {
          stopPolling()
          return
        }
        ctl.timer = setTimeout(tick, LAUNCH_POLL_MS)
      }
      ctl.timer = setTimeout(tick, LAUNCH_POLL_MS)
    },
    [onLaunchState, stopPolling]
  )

  const mutation = useMutation({
    mutationFn: () => createLaunch(resourceId),
    onSuccess: (data) => {
      toast.success('Handing off to the desktop agent')
      onLaunchState?.({ state: 'waiting', launch_id: data.launch_id })
      // launch_id is absent on a backend older than this feature. Navigate
      // anyway: the handoff is what matters, and losing the progress report
      // is the old behaviour, not a new failure.
      if (data.launch_id) pollLaunch(data.launch_id)
      window.location.href = data.launch_url
    },
    onError: (err) => {
      const normalized = normalizeApiError(err)
      if (isNotPairedError(normalized)) {
        // Say it out loud. This is the reported bug: the console handed off
        // to an agent that was not there and showed nothing at all.
        toast.error('Device not paired. Pair this device before opening resources in a desktop app.')
        onNeedsPairing?.()
        return
      }
      toast.error(normalized.message)
    },
  })

  return { ...mutation, stopPolling }
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function ResourceAccessPanel({ resource, resourceId }) {
  const [needsPairing, setNeedsPairing] = useState(false)
  const [launch, setLaunch] = useState(null)

  const connectInfoQuery = useQuery({
    queryKey: ['resources', resourceId, 'connect-info'],
    queryFn: ({ signal }) => getConnectInfo(resourceId, signal),
    retry: false,
  })

  const launchMutation = useDesktopLaunch(resourceId, {
    onNeedsPairing: () => setNeedsPairing(true),
    onLaunchState: setLaunch,
  })

  if (connectInfoQuery.isLoading) {
    return (
      <Card>
        <div className="flex items-center gap-2.5 px-4 py-8 text-ink-400">
          <Spinner /> <span className="text-sm">Checking your access…</span>
        </div>
      </Card>
    )
  }

  // JIT gating is not an error state, it is the product working. It gets its
  // own plate with the one action that resolves it.
  if (connectInfoQuery.isError) {
    const err = normalizeApiError(connectInfoQuery.error)
    if (err.code === 'jit_grant_required' || err.code === 'JIT_REQUIRED') {
      return (
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-4 border-l-[3px] border-amber-500 bg-amber-50/60 px-4 py-4 dark:bg-amber-950/15 sm:flex-row sm:items-center">
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-amber-100 text-amber-600 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25">
              <KeyRound className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Time-boxed access required
              </p>
              <p className="mt-1 text-sm leading-relaxed text-amber-800/90 dark:text-amber-300/85">
                This resource has no standing access. Raise a just-in-time request and connect once an
                approver has granted it.
              </p>
            </div>
            <Link to={`/jit?resourceId=${resourceId}`} className="flex-none">
              <Button variant="primary" icon={KeyRound}>
                Request access
              </Button>
            </Link>
          </div>
        </Card>
      )
    }
    return (
      <Card className="overflow-hidden">
        <div className="flex items-start gap-3 border-l-[3px] border-red-500 bg-red-50/60 px-4 py-4 dark:bg-red-950/15">
          <ShieldAlert
            className="mt-0.5 h-4 w-4 flex-none text-red-600 dark:text-red-400"
            strokeWidth={1.9}
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-red-800 dark:text-red-200">Access check failed</p>
            <p className="mt-1 text-sm leading-relaxed text-red-700/90 dark:text-red-300/85">{err.message}</p>
          </div>
        </div>
      </Card>
    )
  }

  const info = connectInfoQuery.data
  const consoleUrl = info?.console_url || resource?.console_url

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            variant="primary"
            size="lg"
            icon={Laptop}
            loading={launchMutation.isPending}
            onClick={() => {
              setNeedsPairing(false)
              setLaunch(null)
              launchMutation.mutate()
            }}
          >
            Open in desktop
          </Button>

          {consoleUrl ? (
            <a href={consoleUrl} target="_blank" rel="noreferrer noopener">
              <Button variant="secondary" size="lg" icon={Globe}>
                Open in browser
              </Button>
            </a>
          ) : null}
        </div>

        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          The credential is delivered to the tool on your machine by the paired PAM agent. It is never
          shown here and never reaches this browser.
        </p>

        <LaunchOutcome state={launch} />
      </div>

      {needsPairing && (
        <div className="border-t border-surface-800 px-4 py-4">
          <PairAgentPanel
            onPaired={() => {
              setNeedsPairing(false)
              toast.success('Device paired, opening')
              launchMutation.mutate()
            }}
          />
        </div>
      )}
    </Card>
  )
}

// What became of the launch, in the browser that started it.
//
// This is the surface the round added. A handoff to pam-agent:// is one-way,
// so until the backend started recording launch outcomes there was nothing to
// render here and nothing rendered: a missing psql, a missing agent and a
// perfectly good session all looked the same from the console.
//
// Deliberately quiet on success. An operator whose tool just opened is looking
// at the tool, not at this page, and a persistent green banner on a page they
// have left is noise.
function LaunchOutcome({ state }) {
  if (!state) return null

  if (state.state === 'waiting') {
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-ink-400">
        <Loader2 className="h-3.5 w-3.5 flex-none animate-spin" aria-hidden="true" />
        Waiting for the desktop agent to pick this up…
      </p>
    )
  }

  // Deliberately does NOT promise that closing the tool ends the session.
  // It does for a terminal or a desktop application, where the agent is still
  // watching. It does not for a resource whose candidate opens the operator's
  // own browser at a console URL: nothing can observe that tab, which is what
  // PAM's brokered web proxy exists for. The console cannot tell the two apart
  // from here, so it states only what it knows.
  if (state.state === 'opened') {
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5 flex-none" strokeWidth={1.9} aria-hidden="true" />
        Opened on your machine.
      </p>
    )
  }

  if (state.state === 'completed') {
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-ink-500">
        <CheckCircle2 className="h-3.5 w-3.5 flex-none" strokeWidth={1.9} aria-hidden="true" />
        The session has ended.
      </p>
    )
  }

  // An expired handoff is how "no agent is installed or running here" actually
  // looks from the server: the token simply ages out untouched. Saying that
  // plainly is the whole difference between a diagnosable problem and a button
  // that does nothing.
  if (state.state === 'expired') {
    return (
      <LaunchProblem
        title="The desktop agent did not respond"
        detail="Nothing on this machine picked up the handoff, so the PAM agent is probably not installed or not running here."
        hint="Install the agent from Settings > Devices, then try again."
      />
    )
  }

  if (state.state === 'failed') {
    return (
      <LaunchProblem
        title="The desktop agent could not open this resource"
        detail={state.failure_reason}
        hint={state.failure_hint}
      />
    )
  }

  return null
}

function LaunchProblem({ title, detail, hint }) {
  return (
    <div className="mt-3 flex items-start gap-3 rounded-lg border-l-[3px] border-red-500 bg-red-50/60 px-3 py-3 dark:bg-red-950/15">
      <Download className="mt-0.5 h-4 w-4 flex-none text-red-600 dark:text-red-400" strokeWidth={1.9} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-red-800 dark:text-red-200">{title}</p>
        {detail ? (
          <p className="mt-1 text-sm leading-relaxed text-red-700/90 dark:text-red-300/85">{detail}</p>
        ) : null}
        {hint ? (
          <p className="mt-1.5 text-sm leading-relaxed text-ink-500 dark:text-ink-400">{hint}</p>
        ) : null}
      </div>
    </div>
  )
}

// The one-line variant used in the page header. Same mutation, same pairing
// path, it just needs somewhere to put the pairing panel when a 409 comes
// back, which is why it accepts the setter rather than owning the state.
export function OpenInDesktopButton({ resourceId, onNeedsPairing, className, size = 'md' }) {
  const launch = useDesktopLaunch(resourceId, { onNeedsPairing })
  return (
    <Button
      variant="primary"
      size={size}
      icon={Laptop}
      className={clsx(className)}
      loading={launch.isPending}
      onClick={() => launch.mutate()}
    >
      Connect
    </Button>
  )
}
