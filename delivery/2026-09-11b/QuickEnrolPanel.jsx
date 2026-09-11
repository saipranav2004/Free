import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Check, Copy, Laptop, ShieldCheck, Clock, AlertCircle } from 'lucide-react'
import clsx from 'clsx'
import { toast } from 'sonner'
import { listAgentInstallTargets, createAgentInstaller, listAgentDevices } from '../../api/agent'
import { apiErrorMessage } from '../../lib/apiError'
import { Button } from '../common/Button'
import { Spinner } from '../common/Spinner'

// ---------------------------------------------------------------------------
// One-click agent enrolment
// ---------------------------------------------------------------------------
// WHAT THIS REPLACES. Enrolling the agent used to be six steps: find the
// download, unpack it, put it on PATH, run `pam-agent pair`, read an
// 8-character code off this page, and type it before a five-minute timer ran
// out. The two in the middle are the ones people get wrong and the last is a
// race.
//
// WHAT IT IS NOW. Pick your platform; the server mints a one-time code and
// renders an installer that already knows the download URL, the expected
// checksum and the code. One line to paste, or one file to double-click, and
// it downloads, verifies, registers the pam-agent:// handler and pairs.
//
// WHY THERE IS STILL ONE MANUAL STEP, since the request is always "make it
// fully automatic": a web page cannot execute an installer on your machine.
// That is the browser sandbox, and it is the same boundary that makes loading
// this console safe. Every product that advertises one-click agent enrolment —
// Tailscale, Teleport, Datadog — is describing exactly this shape. What we can
// remove is every step that is a *decision*, and that is what this does.

// Best-effort platform detection, used only to pre-select a button. Deliberately
// not trusted for anything else: userAgent is spoofable and increasingly
// reduced, and the cost of guessing wrong is one extra click rather than a
// broken install.
function detectTarget(targets) {
  if (!targets.length) return null
  const ua = `${navigator.userAgent} ${navigator.platform || ''}`.toLowerCase()

  // Apple silicon cannot be read from userAgent — Safari and Chrome both
  // report Intel on ARM Macs — so a Mac defaults to Apple Silicon, which is
  // every Mac sold since 2020. An Intel user picks the other button.
  const guess = ua.includes('win')
    ? { os: 'windows', arch: 'amd64' }
    : ua.includes('mac')
      ? { os: 'darwin', arch: 'arm64' }
      : ua.includes('linux') || ua.includes('x11')
        ? { os: 'linux', arch: 'amd64' }
        : null
  if (!guess) return null
  return targets.find((t) => t.os === guess.os && t.arch === guess.arch) || null
}

function formatSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return null
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function clock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function QuickEnrolPanel({ onPaired }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState(null)
  const [copied, setCopied] = useState(false)
  const [remaining, setRemaining] = useState(null)

  const targetsQuery = useQuery({
    queryKey: ['agent', 'install', 'targets'],
    queryFn: ({ signal }) => listAgentInstallTargets(signal),
    retry: false,
  })

  const targets = targetsQuery.data?.targets || []
  const detected = useMemo(() => detectTarget(targets), [targets])

  // Pre-select the detected platform once the list arrives, without stomping a
  // choice the operator has already made.
  useEffect(() => {
    if (!selected && detected) setSelected(detected)
  }, [detected, selected])

  const installer = useMutation({
    mutationFn: ({ os, arch }) => createAgentInstaller({ os, arch }),
    onSuccess: (data) => setRemaining(data.ttl_seconds),
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  // Counted down client-side: ttl_seconds is a snapshot from the moment the
  // code was issued, and a stale command left on screen would fail with a
  // confusing 401 in the terminal.
  useEffect(() => {
    if (remaining == null || remaining <= 0) return undefined
    const id = setInterval(() => setRemaining((s) => (s == null ? s : s - 1)), 1000)
    return () => clearInterval(id)
  }, [remaining])

  // While an installer is live, watch for the device appearing. This is what
  // makes the flow feel finished without the operator coming back to click
  // anything: the moment the agent pairs, the panel says so.
  const armed = Boolean(installer.data) && remaining != null && remaining > 0
  const devicesQuery = useQuery({
    queryKey: ['agent', 'devices'],
    queryFn: ({ signal }) => listAgentDevices(signal),
    enabled: armed,
    refetchInterval: armed ? 4000 : false,
  })
  const devices = useMemo(() => devicesQuery.data?.devices || [], [devicesQuery.data])

  // COUNTING DEVICES IS NOT ENOUGH TO SPOT A PAIRING.
  //
  // This used to be `deviceCount > baseline`, and that only ever worked for a
  // machine pairing for the FIRST time. Re-pairing a machine that is already
  // enrolled updates its row rather than adding one (see the server's
  // CompletePairing), so the count does not move, and the panel sat on
  // "waiting for the agent" for ever while the agent had in fact paired
  // seconds earlier. Re-pairing is the common case, not the rare one: it is
  // what happens every time somebody re-runs the installer.
  //
  // So the baseline is a SNAPSHOT, and either kind of change counts: a device
  // id that was not there before, or a device whose last_seen_at has moved
  // forward. The second is what the server stamps when it recognises a
  // returning machine.
  const baselineRef = useRef(null)
  useEffect(() => {
    if (!installer.data) return
    if (baselineRef.current != null) return
    baselineRef.current = new Map(devices.map((d) => [d.id, d.last_seen_at || '']))
  }, [installer.data, devices])

  const paired = useMemo(() => {
    const before = baselineRef.current
    if (before == null) return false
    return devices.some((d) => {
      if (!before.has(d.id)) return true
      const was = before.get(d.id) || ''
      const now = d.last_seen_at || ''
      return now !== '' && now !== was
    })
  }, [devices])

  useEffect(() => {
    if (!paired) return
    toast.success('This machine is paired. The agent is ready to use.')
    queryClient.invalidateQueries({ queryKey: ['agent', 'devices'] })
    onPaired?.()
  }, [paired, queryClient, onPaired])

  const expired = remaining != null && remaining <= 0
  const data = installer.data

  if (targetsQuery.isLoading) {
    return (
      <div className="rounded-xl border border-surface-700/70 bg-surface-900 p-5">
        <Spinner size="h-4 w-4" className="text-ink-400" />
      </div>
    )
  }

  // Nothing to offer: the server has no agent builds on disk. Say why, so an
  // administrator knows what to fix instead of assuming the feature is broken.
  if (!targetsQuery.data?.enabled) {
    return (
      <div className="rounded-xl border border-surface-700/70 bg-surface-900 p-5">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400" />
          <div>
            <h3 className="text-sm font-semibold text-ink-50">One-click setup is unavailable</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-400">
              This server has no agent builds to hand out. An administrator can enable it by
              building the agents and pointing <code className="text-ink-300">PAM_AGENT_BINARY_DIR</code>{' '}
              at them. Until then, pair manually with a one-time code below.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-surface-700/70 bg-surface-900 shadow-card p-5">
      <div className="flex items-start gap-3">
        <Laptop className="mt-0.5 h-5 w-5 flex-none text-blue-600 dark:text-blue-400" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink-50">Set up this machine</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">
            Pick your platform. You&apos;ll get one command that installs the agent, verifies it,
            and pairs it with your account — no code to copy, nothing to configure.
          </p>
        </div>
      </div>

      {/* Platform picker. Only platforms the server can actually serve appear,
          so every button here is guaranteed to work. */}
      <div className="mt-4 flex flex-wrap gap-2">
        {targets.map((t) => {
          const active = selected && selected.os === t.os && selected.arch === t.arch
          return (
            <button
              key={`${t.os}/${t.arch}`}
              type="button"
              onClick={() => {
                setSelected(t)
                setRemaining(null)
                // Picking a different platform starts a new enrolment, so the
                // snapshot the pairing check compares against has to be taken
                // again rather than carried over from the previous attempt.
                baselineRef.current = null
                installer.reset()
              }}
              className={clsx(
                'flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors',
                active
                  ? 'border-blue-500/50 bg-blue-50/70 dark:bg-blue-950/20'
                  : 'border-surface-700 bg-surface-850 hover:border-surface-600'
              )}
            >
              <span className="text-xs font-semibold text-ink-50">{t.label}</span>
              <span className="font-mono text-2xs text-ink-500">
                {formatSize(t.size_bytes) || `${t.os}/${t.arch}`}
                {t.version ? ` · v${t.version}` : ''}
                {detected && detected.os === t.os && detected.arch === t.arch ? ' · detected' : ''}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-4">
        <Button
          variant="primary"
          icon={Download}
          loading={installer.isPending}
          disabled={!selected || installer.isPending}
          onClick={() => selected && installer.mutate({ os: selected.os, arch: selected.arch })}
        >
          {data ? 'Generate a new installer' : 'Get the install command'}
        </Button>
      </div>

      {paired && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-600/30 bg-emerald-50/70 px-3 py-2.5 dark:bg-emerald-950/15">
          <ShieldCheck className="h-4 w-4 flex-none text-emerald-700 dark:text-emerald-400" />
          <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
            Paired. This machine is ready. &quot;Connect&quot; will now open your local tools.
          </span>
        </div>
      )}

      {data && !paired && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink-300">
              Run this on {data.target?.label || 'the machine'}:
            </span>
            <span
              className={clsx(
                'flex items-center gap-1.5 font-mono text-2xs',
                expired ? 'text-red-600 dark:text-red-400' : 'text-ink-500'
              )}
            >
              <Clock className="h-3 w-3" />
              {expired ? 'expired — generate a new one' : `valid for ${clock(remaining ?? 0)}`}
            </span>
          </div>

          <div className="flex items-start gap-2">
            <code
              className={clsx(
                'min-w-0 flex-1 break-all rounded-lg border px-2.5 py-2 font-mono text-2xs leading-relaxed',
                expired
                  ? 'border-surface-700 bg-surface-850 text-ink-600 line-through'
                  : 'border-surface-700 bg-surface-850 text-ink-200'
              )}
            >
              {data.command}
            </code>
            <Button
              size="sm"
              variant="secondary"
              icon={copied ? Check : Copy}
              disabled={expired}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(data.command)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                } catch {
                  toast.error('Clipboard unavailable. Select the command and copy it manually.')
                }
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Saved from the body already in hand rather than by navigating to
                the script URL: that URL carries the enrolment code, and a
                browser navigation would put it in history. */}
            <button
              type="button"
              disabled={expired}
              onClick={() => {
                const blob = new Blob([data.script], { type: 'text/plain' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = data.filename
                document.body.appendChild(a)
                a.click()
                a.remove()
                URL.revokeObjectURL(url)
              }}
              className="text-xs font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
            >
              or download {data.filename} and run it
            </button>
            {armed && (
              <span className="flex items-center gap-1.5 text-2xs text-ink-500">
                <Spinner size="h-3 w-3" /> waiting for this machine to pair…
              </span>
            )}
          </div>

          <p className="text-2xs leading-relaxed text-ink-500">
            The command contains a single-use enrolment code. Treat it like a password: run it,
            then clear it from your terminal history. It expires on its own either way.
          </p>
        </div>
      )}
    </div>
  )
}
