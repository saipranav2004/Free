import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import {
  Laptop,
  Terminal,
  Globe,
  AlertCircle,
  KeyRound,
  Square,
  CheckCircle2,
  Copy,
  Check,
  ShieldAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { getConnectInfo, startSession } from '../../api/resources'
import { endSession } from '../../api/sessions'
import { createLaunch } from '../../api/agent'
import { normalizeApiError, apiErrorMessage } from '../../lib/apiError'
import { Button } from '../common/Button'
import { Card, CardHeader, CardTitle } from '../common/Layout'
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

const CLI_HINTS = {
  postgresql: (i) =>
    `psql -h ${i.host} -p ${i.port}${i.database_name ? ` -d ${i.database_name}` : ''} -U <username>`,
  mongodb: (i) => `mongosh "mongodb://${i.host}:${i.port}${i.database_name ? `/${i.database_name}` : ''}"`,
  redis: (i) => `redis-cli -h ${i.host} -p ${i.port}`,
  clickhouse: (i) => `clickhouse-client --host ${i.host} --port ${i.port}`,
  mysql: (i) =>
    `mysql -h ${i.host} -P ${i.port}${i.database_name ? ` -D ${i.database_name}` : ''} -u <username> -p`,
  ssh: (i) => `ssh <username>@${i.host} -p ${i.port}`,
}

function cliCommand(info) {
  if (!info) return null
  return CLI_HINTS[info.type]?.(info) || `${info.host}:${info.port}`
}

// ---------------------------------------------------------------------------
// Shared launch logic
// ---------------------------------------------------------------------------
// Exported so the page header's primary "Open in Desktop" button and the
// panel's own copy of it drive the identical mutation, one code path, so the
// pairing flow and the 409 handling can't diverge between the two entry
// points.
export function useDesktopLaunch(resourceId, { onNeedsPairing } = {}) {
  const mutation = useMutation({
    mutationFn: () => createLaunch(resourceId),
    onSuccess: (data) => {
      toast.success('Handing off to the desktop agent…')
      window.location.href = data.launch_url
    },
    onError: (err) => {
      const normalized = normalizeApiError(err)
      // A 409 here means specifically "no device paired yet"
      // (agent_handler.go's CreateLaunch), not a real failure.
      if (normalized.status === 409) {
        onNeedsPairing?.()
        return
      }
      toast.error(normalized.message)
    },
  })
  return mutation
}

function CopyRow({ value }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <code
        className="min-w-0 flex-1 truncate rounded-lg border border-surface-700 bg-surface-850 px-2.5 py-2 font-mono text-xs text-ink-200"
        title={value}
      >
        {value}
      </code>
      <Button
        size="sm"
        variant="secondary"
        icon={copied ? Check : Copy}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          } catch {
            toast.error('Clipboard unavailable in this browser')
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function ResourceAccessPanel({ resource, resourceId, compact = false }) {
  const queryClient = useQueryClient()
  const [activeSession, setActiveSession] = useState(null)
  const [needsPairing, setNeedsPairing] = useState(false)
  const [cliOpen, setCliOpen] = useState(false)

  const connectInfoQuery = useQuery({
    queryKey: ['resources', resourceId, 'connect-info'],
    queryFn: ({ signal }) => getConnectInfo(resourceId, signal),
    retry: false,
  })

  const launchMutation = useDesktopLaunch(resourceId, { onNeedsPairing: () => setNeedsPairing(true) })

  const startMutation = useMutation({
    mutationFn: () => startSession(resourceId),
    onSuccess: (data) => {
      setActiveSession(data.session)
      setCliOpen(true)
      if (data.notice) toast.info(data.notice)
      else toast.success('Session started and recorded')
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const endMutation = useMutation({
    mutationFn: (sessionId) => endSession(sessionId),
    onSuccess: () => {
      setActiveSession(null)
      setCliOpen(false)
      toast.success('Session ended')
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
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
    if (err.code === 'jit_grant_required') {
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
  const command = cliCommand(info)
  const hasCredential = !!info?.has_credential
  const consoleUrl = info?.console_url || resource?.console_url
  const busy = launchMutation.isPending || startMutation.isPending

  const blockedReason = !hasCredential ? 'No credential is attached to this resource yet' : undefined

  // return (
  // <Card className="overflow-hidden">
  //   <CardHeader>
  //     <CardTitle icon={Laptop}>Connect</CardTitle>
  //     <span className="ml-auto flex items-center gap-1.5 text-2xs font-medium uppercase tracking-[0.08em] text-ink-500">
  //       <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" strokeWidth={1.9} />
  //       Brokered &amp; recorded
  //     </span>
  //   </CardHeader>

  //   <div className="px-4 py-4">
  //     {/* Exactly three ways in, in the order of how brokered they are. The
  // primary is the agent, because that is the path that actually
  // carries the credential without ever exposing it. */}
  //     <div className="flex flex-wrap items-center gap-2.5">
  //       <Button
  // variant="primary"
  // size="lg"
  // icon={Laptop}
  // loading={launchMutation.isPending}
  // disabled={busy || !hasCredential}
  // title={blockedReason}
  // onClick={() => {
  // setNeedsPairing(false)
  // launchMutation.mutate()
  //         }}
  //       >
  //         Open in Desktop
  //       </Button>

  //       <Button
  // variant="secondary"
  // size="lg"
  // icon={Terminal}
  // loading={startMutation.isPending}
  // disabled={busy || !hasCredential || !!activeSession}
  // title={blockedReason}
  // onClick={() => startMutation.mutate()}
  //       >
  //         Open in CLI
  //       </Button>

  //       {consoleUrl ? (
  //         <a href={consoleUrl} target="_blank" rel="noreferrer noopener">
  //           <Button variant="secondary" size="lg" icon={Globe}>
  //             Open in Browser
  //           </Button>
  //         </a>
  //       ) : (
  //         <Button
  // variant="secondary"
  // size="lg"
  // icon={Globe}
  // disabled
  // title="This resource has no console URL registered"
  //         >
  //           Open in Browser
  //         </Button>
  //       )}
  //     </div>

  //     {!hasCredential && (
  //       <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-ink-500">
  //         <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.9} />
  //         No credential is attached to this resource, so PAM has nothing to broker on your behalf.
  //         Ask an administrator to store one.
  //       </p>
  //     )}

  //     {/* A tracked session is open, this is the state that matters most,
  // so it gets a plate rather than a line of text. */}
  //     {activeSession && (
  //       <div className="mt-4 rounded-xl border border-emerald-600/25 bg-emerald-50/70 p-3.5 dark:bg-emerald-950/15">
  //         <div className="flex flex-wrap items-center justify-between gap-3">
  //           <span className="flex items-center gap-2 text-sm font-medium text-emerald-800 dark:text-emerald-300">
  //             <span className="relative flex h-2 w-2 flex-none rounded-full bg-emerald-500 text-emerald-500">
  //               <span className="dot-live absolute inset-0 rounded-full bg-emerald-500" />
  //             </span>
  //             Session open and recording · #{String(activeSession.id).slice(0, 8)}
  //           </span>
  //           <Button
  // size="sm"
  // variant="secondary"
  // icon={Square}
  // loading={endMutation.isPending}
  // onClick={() => endMutation.mutate(activeSession.id)}
  //           >
  //             End session
  //           </Button>
  //         </div>
  //         {cliOpen && command && (
  //           <div className="mt-3">
  //             <p className="mb-1.5 text-xs font-semibold text-emerald-800/80 dark:text-emerald-300/75">
  //               Run this in your own client
  //             </p>
  //             <CopyRow value={command} />
  //           </div>
  //         )}
  //       </div>
  //     )}

  //     {needsPairing && (
  //       <div className="mt-4">
  //         <PairAgentPanel
  // onPaired={() => {
  // setNeedsPairing(false)
  // toast.success('Agent paired, opening…')
  // launchMutation.mutate()
  //           }}
  //         />
  //       </div>
  //     )}

  //     {!compact && !activeSession && command && (
  //       <p className="mt-4 text-xs leading-relaxed text-ink-500">
  //         <span className="font-medium text-ink-400">Open in CLI</span> records a session against
  // this resource before showing you the connection command, so the access appears in the
  // audit trail and counts against any grant expiry.
  //       </p>
  //     )}
  //   </div>
  // </Card>
  // )
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
