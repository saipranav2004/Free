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
import { startWebSession, listMyWebSessions, endWebSession } from '../../api/webSessions'
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
//   OPEN IN WEB     , the BROKERED browser path. PAM performs the target
// application's own login SERVER-SIDE and reverse-proxies
// it, so the operator lands in the app already
// authenticated and the credential never reaches their
// browser at all. The session is bound, recorded, and
// killable like any other.
//   OPEN CONSOLE    , the resource's registered console URL, unbrokered. This
// opens the app's OWN login page and leaves the operator to
// authenticate themselves: no PAM session binding, no
// activity trail, no kill switch, and a credential they now
// know. Shown only when the brokered path is unavailable,
// because offering both side by side invites the wrong one.
//
// A NOTE ON A COMMENT THAT USED TO BE HERE. This file previously said "there
// is no server-side proxy on this backend, so pretending to be a terminal
// would be a lie". That was true when it was written and is not any more:
// internal/webproxy is exactly that proxy. OPEN IN WEB above is it, and it is
// the reason the raw console link has been demoted rather than removed.

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

// EXPORTED so the resources table's own connect menu builds its command from
// the same map. A second copy in another file is a second map, and the two
// drift the first time a resource type is added to one of them.
//
// NOTE THE KEY. connect-info returns the resource type as `type`, not
// `resource_type`. The catalogue row and the connect payload spell it
// differently, and reading the wrong one silently falls through to the
// host:port default for every resource.
export function cliCommand(info) {
  if (!info) return null
  return CLI_HINTS[info.type]?.(info) || `${info.host}:${info.port}`
}

// True when the command above is a real client invocation rather than the
// bare endpoint fallback. The menu uses it to label the action honestly.
export function hasCliClient(info) {
  return !!info && !!CLI_HINTS[info.type]
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

// Brokered web sessions, the counterpart to useDesktopLaunch above.
//
// Exported for the same reason: the page header's button and the panel's own
// copy must drive one mutation, so the popup handling and the error mapping
// cannot drift apart between two entry points.
export function useWebSessionLaunch(resourceId) {
  const queryClient = useQueryClient()

  return useMutation({
    // The tab is opened SYNCHRONOUSLY, before the request, and only pointed at
    // launch_url once it returns. Calling window.open() from onSuccess would be
    // a popup outside a user gesture that has already ended, which browsers
    // block, and the handoff token expires in about 30 seconds, so there is no
    // second attempt.
    //
    // A separate tab is also what makes the session's lifecycle correct: PAM
    // detects a closed tab and ends the session, finalising its recording, so
    // "close the tab when you are done" is a real end-of-session action.
    mutationFn: async () => {
      // No 'noopener' here, deliberately: with that flag window.open returns
      // null by specification, leaving nothing to point at the launch URL.
      // Opener isolation is enforced instead by the Cross-Origin-Opener-Policy
      // header the proxy sets on its own responses.
      const opened = window.open('about:blank', '_blank')
      try {
        const result = await startWebSession(resourceId)
        return { result, opened }
      } catch (err) {
        try {
          opened?.close()
        } catch {
          /* a tab that never opened needs no closing */
        }
        throw err
      }
    },
    onSuccess: ({ result, opened }) => {
      queryClient.invalidateQueries({ queryKey: ['web-sessions', 'mine'] })
      if (opened && !opened.closed) {
        opened.location.href = result.launch_url
        toast.success('Opened in a new tab. Close it when you are done and the session ends.')
        return
      }
      // Popup blocked. Navigating THIS tab would take the operator out of the
      // console and make tab-close detection apply to the tab they are working
      // in, so the session would end the moment they came back.
      toast.error('Your browser blocked the new tab. Allow pop-ups for this site, then try again.', {
        duration: 10000,
      })
    },
    onError: (err) => {
      const normalized = normalizeApiError(err)
      // Each of these is a configuration answer, not a fault, and saying which
      // one stops the operator retrying a button that cannot work.
      if (normalized.code === 'connect_method_not_allowed') {
        toast.error('This resource does not permit brokered browser access.')
        return
      }
      if (normalized.code === 'web_proxy_disabled') {
        toast.error('The brokered web gateway is not enabled on this server.')
        return
      }
      if (normalized.code === 'web_proxy_upstream_login_failed') {
        toast.error(
          normalized.message || 'PAM could not sign in to the application with the stored credential.'
        )
        return
      }
      toast.error(normalized.message)
    },
  })
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

// `compact` is read only by the parked CLI paragraph below, so it is unused
// while that block is commented out. Kept in the signature because callers
// still pass it and it comes back with the block.
// eslint-disable-next-line no-unused-vars
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
  const webLaunch = useWebSessionLaunch(resourceId)

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

  // What the SERVER says is possible right now. available_methods already
  // accounts for every precondition (a console URL, a stored credential, the
  // gateway being enabled, and the resource's connect-method policy) so a
  // button is absent rather than present-and-failing.
  const methods = Array.isArray(info?.available_methods) ? info.available_methods : []
  const canBrokerWeb = methods.includes('web_proxy')

  // The raw console link is the UNBROKERED fallback and is deliberately hidden
  // whenever the brokered path exists. Offering both side by side asks the
  // operator to know the difference between "PAM logs you in and records it"
  // and "here is the app's login page, good luck", and the wrong choice is
  // the one that leaks a credential.
  const showRawConsole = !!consoleUrl && !canBrokerWeb

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle icon={Laptop}>Connect</CardTitle>
        <span className="ml-auto flex items-center gap-1.5 text-2xs font-medium uppercase tracking-[0.08em] text-ink-500">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" strokeWidth={1.9} />
          Brokered &amp; recorded
        </span>
      </CardHeader>

      <div className="px-4 py-4">
        {/* Ordered by how brokered each path is. The agent is primary because
            it carries the credential without ever exposing it; the brokered
            web path is second because PAM is genuinely in the data flow there
            too; the CLI hint is last because the operator's own client does
            the connecting and PAM only records that it happened. */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* THE AGENT BUTTON IS "OPEN IN DESKTOP", which is what it does:
              POST /resources/:id/launch issues a one-time token that the OS
              hands to the locally installed pam-agent, which opens the
              operator's own desktop client. It was labelled "Open in CLI",
              which is a different action with a different endpoint, and having
              it here is what forced the real CLI hand-off below to be commented
              out to avoid two buttons with one name. The component has always
              been called OpenInDesktopButton. */}
          <Button
            variant="primary"
            size="lg"
            icon={Laptop}
            loading={launchMutation.isPending}
            disabled={busy || !hasCredential}
            title={blockedReason}
            onClick={() => launchMutation.mutate()}
          >
            Open in Desktop
          </Button>

          {canBrokerWeb && (
            <Button
              variant="secondary"
              size="lg"
              icon={Globe}
              loading={webLaunch.isPending}
              disabled={busy || webLaunch.isPending}
              title="PAM signs in to the application server-side and proxies it, so the credential never reaches your browser"
              onClick={() => webLaunch.mutate()}
            >
              Open in Web
            </Button>
          )}

          {/* RESTORED, now that the label it needs is free again. This is the
              third way in and the one PAM brokers least: it records a tracked
              session (POST /resources/:id/sessions) and then shows the command
              for the operator's own client. The session row is what puts the
              access on the audit trail, what a grant expiry cascades to, and
              what an administrator can kill. */}
          {command && (
            <Button
              variant="secondary"
              size="lg"
              icon={Terminal}
              loading={startMutation.isPending}
              disabled={busy || !hasCredential}
              title={blockedReason}
              onClick={() => startMutation.mutate()}
            >
              Open in CLI
            </Button>
          )}

          {showRawConsole && (
            <Button
              variant="secondary"
              size="lg"
              icon={Globe}
              to={undefined}
              onClick={() => window.open(consoleUrl, '_blank', 'noopener')}
              title="Opens the application's own login page. You authenticate yourself, and PAM does not broker or record it"
            >
              Open console
            </Button>
          )}
        </div>

        {!hasCredential && (
          <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-ink-500">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.9} />
            No credential is attached to this resource, so PAM has nothing to broker on your behalf.
            Ask an administrator to store one.
          </p>
        )}

        {showRawConsole && (
          <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-ink-500">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.9} />
            <span>
              <span className="font-medium text-ink-400">Open console</span> is not brokered. It opens
              the application&apos;s own sign-in page, so there is no PAM session, no activity trail and
              no kill switch. Ask an administrator to enable brokered access for this resource.
            </span>
          </p>
        )}

        {/* A tracked session is open. This is the state that matters most, so
            it gets a plate rather than a line of text. */}
        {activeSession && (
          <div className="mt-4 rounded-xl border border-emerald-600/25 bg-emerald-50/70 p-3.5 dark:bg-emerald-950/15">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-medium text-emerald-800 dark:text-emerald-300">
                <span className="relative flex h-2 w-2 flex-none rounded-full bg-emerald-500 text-emerald-500">
                  <span className="dot-live absolute inset-0 rounded-full bg-emerald-500" />
                </span>
                Session open and recording · #{String(activeSession.id).slice(0, 8)}
              </span>
              <Button
                size="sm"
                variant="secondary"
                icon={Square}
                loading={endMutation.isPending}
                onClick={() => endMutation.mutate(activeSession.id)}
              >
                End session
              </Button>
            </div>
            {cliOpen && command && (
              <div className="mt-3">
                <p className="mb-1.5 text-xs font-semibold text-emerald-800/80 dark:text-emerald-300/75">
                  Run this in your own client
                </p>
                <CopyRow value={command} />
              </div>
            )}
          </div>
        )}

        {needsPairing && (
          <div className="mt-4">
            <PairAgentPanel
              onPaired={() => {
                setNeedsPairing(false)
                toast.success('Agent paired, opening…')
                launchMutation.mutate()
              }}
            />
          </div>
        )}

        {!compact && !activeSession && command && (
          <p className="mt-4 text-xs leading-relaxed text-ink-500">
            <span className="font-medium text-ink-400">Open in CLI</span> records a session against
            this resource before showing you the connection command, so the access appears in the
            audit trail and counts against any grant expiry.
          </p>
        )}
      </div>
    </Card>
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

// The one-line brokered-web variant for the page header, mirroring
// OpenInDesktopButton above.
//
// Rendered only when the backend says this resource can actually be brokered
// right now: available_methods accounts for all four preconditions (a console
// URL, a stored credential, the gateway enabled server-side, and the policy
// permitting it), so the button is absent rather than present-and-failing.
export function OpenInWebButton({ resourceId, className, size = 'md' }) {
  const launch = useWebSessionLaunch(resourceId)

  const connectInfoQuery = useQuery({
    queryKey: ['resources', resourceId, 'connect-info'],
    queryFn: ({ signal }) => getConnectInfo(resourceId, signal),
    retry: false,
    // A 403 here is the JIT gate, not a transient failure; the button just
    // stays hidden and the page's own gate messaging handles it.
    throwOnError: false,
  })

  const methods = connectInfoQuery.data?.available_methods
  if (!Array.isArray(methods) || !methods.includes('web_proxy')) return null

  return (
    <Button
      variant="secondary"
      size={size}
      icon={Globe}
      className={clsx(className)}
      loading={launch.isPending}
      onClick={() => launch.mutate()}
      title="PAM signs in to the application server-side and proxies it, so the credential never reaches your browser"
    >
      Open in Web
    </Button>
  )
}

// A live brokered session for one resource, with the two actions that matter:
// go back into it, or end it.
//
// It is a separate bar rather than part of the Connect card because a brokered
// session outlives the page: the operator is working in another tab, and what
// they need on returning here is re-entry and a kill switch, not the launcher
// they already used.
export function LiveWebSessionBar({ resourceId }) {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ['web-sessions', 'mine'],
    queryFn: ({ signal }) => listMyWebSessions(signal),
    staleTime: 10_000,
  })
  const endMutation = useMutation({
    mutationFn: (id) => endWebSession(id),
    onSuccess: () => {
      toast.success('Brokered web session ended')
      queryClient.invalidateQueries({ queryKey: ['web-sessions', 'mine'] })
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const live = (data || []).find((ws) => ws.resource_id === resourceId)
  if (!live) return null

  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-600/25 bg-blue-50/70 px-3.5 py-3 dark:bg-blue-950/15">
      <span className="flex items-center gap-2 text-sm font-medium text-blue-800 dark:text-blue-300">
        <span className="relative flex h-2 w-2 flex-none rounded-full bg-blue-500">
          <span className="dot-live absolute inset-0 rounded-full bg-blue-500" />
        </span>
        Brokered web session open
        <code className="font-mono text-xs text-blue-700/80 dark:text-blue-400/80">
          #{String(live.id).slice(0, 8)}
        </code>
      </span>
      <span className="flex items-center gap-2">
        <a href={live.app_url} target="_blank" rel="noreferrer noopener">
          <Button variant="secondary" size="sm" icon={Globe}>
            Re-open
          </Button>
        </a>
        <Button
          variant="secondary"
          size="sm"
          icon={Square}
          loading={endMutation.isPending}
          onClick={() => endMutation.mutate(live.id)}
        >
          End session
        </Button>
      </span>
    </div>
  )
}
