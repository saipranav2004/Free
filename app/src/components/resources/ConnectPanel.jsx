import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ExternalLink, KeyRound, Laptop, Play, Square, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { getConnectInfo, startSession } from '../../api/resources'
import { endSession } from '../../api/sessions'
import { createLaunch } from '../../api/agent'
import { normalizeApiError, apiErrorMessage } from '../../lib/apiError'
import { Spinner } from '../common/Spinner'
import { CopyButton } from '../common/CopyButton'
import { PairAgentPanel } from '../agent/PairAgentPanel'

// The backend has no live SSH/RDP/DB proxy (see IMPLEMENTED_FEATURES.md §3)
//, connect-info returns metadata only, and starting a "session" here
// creates a TRACKED ROW for audit/JIT-expiry purposes, not an actual live
// connection. This panel is deliberately honest about that rather than
// pretending to be a terminal: it shows the connection details for the
// user's own client tool, plus a copy-pasteable CLI hint, and separately
// tracks the session lifecycle so grant-expiry/kill/audit all still work.
const CLI_HINTS = {
  postgresql: (i) =>
    `psql -h ${i.host} -p ${i.port}${i.database_name ? ` -d ${i.database_name}` : ''} -U <username>`,
  mongodb: (i) => `mongosh "mongodb://${i.host}:${i.port}${i.database_name ? `/${i.database_name}` : ''}"`,
  redis: (i) => `redis-cli -h ${i.host} -p ${i.port}`,
  clickhouse: (i) => `clickhouse-client --host ${i.host} --port ${i.port}`,
}

export function ConnectPanel({ resourceId }) {
  const queryClient = useQueryClient()
  const [activeSession, setActiveSession] = useState(null)
  const [needsPairing, setNeedsPairing] = useState(false)

  const connectInfoQuery = useQuery({
    queryKey: ['resources', resourceId, 'connect-info'],
    queryFn: ({ signal }) => getConnectInfo(resourceId, signal),
    retry: false,
  })

  const startMutation = useMutation({
    mutationFn: () => startSession(resourceId),
    onSuccess: (data) => {
      setActiveSession(data.session)
      if (data.notice) toast.info(data.notice)
      else toast.success('Session started')
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const endMutation = useMutation({
    mutationFn: (sessionId) => endSession(sessionId),
    onSuccess: () => {
      setActiveSession(null)
      toast.success('Session ended')
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  // Hands off to the already-installed pam-agent CLI via a signed,
  // single-use pam-agent:// URL, see api/agent.js. A 409 here means
  // specifically "no device paired yet" (agent_handler.go's CreateLaunch),
  // not a real failure, so it opens the inline pairing flow instead of a
  // toast.
  const launchMutation = useMutation({
    mutationFn: () => createLaunch(resourceId),
    onSuccess: (data) => {
      toast.success('Handing off to the local agent…')
      window.location.href = data.launch_url
    },
    onError: (err) => {
      const normalized = normalizeApiError(err)
      if (normalized.status === 409) {
        setNeedsPairing(true)
        return
      }
      toast.error(normalized.message)
    },
  })

  if (connectInfoQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-ink-400">
        <Spinner /> <span className="text-sm">Checking access…</span>
      </div>
    )
  }

  if (connectInfoQuery.isError) {
    const err = normalizeApiError(connectInfoQuery.error)
    if (err.code === 'jit_grant_required') {
      return (
        <div className="flex flex-col gap-3 rounded-md border border-amber-300 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-950/20 p-4">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400" />
            <p className="text-sm text-amber-700 dark:text-amber-200">
              This resource requires time-boxed access. You don&apos;t currently hold an active grant.
            </p>
          </div>
          <Link
            to={`/jit?resourceId=${resourceId}`}
            className="self-start rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
          >
            Request access
          </Link>
        </div>
      )
    }
    return (
      <div className="rounded-lg border border-red-300 transition-colors dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 p-4 text-sm text-red-700 dark:text-red-300">
        {err.message}
      </div>
    )
  }

  const info = connectInfoQuery.data
  const cliHint = CLI_HINTS[info.type]?.(info)

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[100px_1fr] gap-y-2 text-sm">
        <dt className="text-ink-500">Host</dt>
        <dd className="text-ink-100">{info.host}</dd>
        <dt className="text-ink-500">Port</dt>
        <dd className="text-ink-100">{info.port}</dd>
        {info.database_name && (
          <>
            <dt className="text-ink-500">Database</dt>
            <dd className="text-ink-100">{info.database_name}</dd>
          </>
        )}
        <dt className="text-ink-500">Credential</dt>
        <dd className="text-ink-100">
          {info.has_credential ? (
            'Configured in vault'
          ) : (
            <span className="text-amber-700 dark:text-amber-300">Not configured</span>
          )}
        </dd>
      </dl>

      {cliHint && (
        <div>
          <p className="mb-1 text-xs font-medium text-ink-400">Connect with your own client:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg bg-surface-800 transition-colors px-2 py-1.5 text-xs text-ink-200">
              {cliHint}
            </code>
            <CopyButton value={cliHint} />
          </div>
        </div>
      )}

      {info.console_url && (
        <a
          href={info.console_url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open console
        </a>
      )}

      <div className="border-t border-surface-800 pt-4">
        {activeSession ? (
          <div className="flex items-center justify-between rounded-md bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2">
            <span className="text-sm text-emerald-700 dark:text-emerald-300">
              Session tracked (#{activeSession.id.slice(0, 8)})
            </span>
            <button
              onClick={() => endMutation.mutate(activeSession.id)}
              disabled={endMutation.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-surface-800 transition-colors px-3 py-1.5 text-xs font-medium text-ink-100 hover:bg-surface-700 disabled:opacity-60"
            >
              {endMutation.isPending ? <Spinner size="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
              End session
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending || !info.has_credential}
              className="flex items-center gap-2 h-10 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white shadow-sm ring-1 ring-inset ring-blue-500/50 transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:pointer-events-none disabled:opacity-60"
              title={!info.has_credential ? 'Store a credential for this resource first' : undefined}
            >
              {startMutation.isPending ? (
                <Spinner size="h-4 w-4" className="text-white" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Start tracked session
            </button>
            <button
              onClick={() => {
                setNeedsPairing(false)
                launchMutation.mutate()
              }}
              disabled={launchMutation.isPending || !info.has_credential}
              className="flex items-center gap-2 rounded-md border border-surface-700 bg-surface-800 px-4 py-2 text-sm font-medium text-ink-100 hover:bg-surface-700 disabled:pointer-events-none disabled:opacity-60"
              title={!info.has_credential ? 'Store a credential for this resource first' : undefined}
            >
              {launchMutation.isPending ? <Spinner size="h-4 w-4" /> : <Laptop className="h-4 w-4" />}
              Open in Desktop App
            </button>
          </div>
        )}
        {!info.has_credential && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-500">
            <KeyRound className="h-3.5 w-3.5" /> Store a credential below before starting a session.
          </p>
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
      </div>
    </div>
  )
}
