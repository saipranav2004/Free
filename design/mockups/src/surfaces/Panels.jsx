import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Copy, Download, FileText, Gauge, Laptop, Maximize2, Pause, Play, RotateCcw,
  Search, ShieldAlert, ShieldCheck, Smartphone, SkipBack, Terminal,
} from 'lucide-react'
import { Dialog, StepRail } from '../ui/overlay'
import {
  AlarmBand, Button, Field, FieldSet, Meta, Panel, RuledLabel, StatusDot,
  inputClass, selectClass, textareaClass,
} from '../ui/primitives'
import { recordings, resources } from '../fixtures'
import { duration } from '../lib/format'

// ===========================================================================
// The embedded panels pass 1 skipped
// ===========================================================================

// ── Connect ───────────────────────────────────────────────────────────────
// ConnectPanel.jsx offers up to three routes into a resource and the current
// build presents them as three peer buttons. They are not peers: one opens a
// session here, one hands off to a paired device, one is just a link. The
// redesign ranks them and says what each actually does.
export function ConnectPanel({ resource, hasDevice = true }) {
  const r = resource || resources[0]
  const noCred = !r.vault_entry_id
  return (
    <Panel className="p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-base font-semibold text-primary">Connect</p>
          <p className="mt-1 max-w-prose text-sm text-secondary">
            {noCred
              ? 'No credential is stored for this resource, so a session cannot be brokered yet.'
              : r.always_record
                ? 'This session is recorded from the first keystroke.'
                : 'This session is not recorded.'}
          </p>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
          <Button variant="primary" size="lg" icon={Terminal} disabled={noCred}>
            Web terminal
          </Button>
          <Button
            size="lg"
            icon={Laptop}
            disabled={noCred || !hasDevice}
            title={hasDevice ? undefined : 'No paired device — pair one in Settings'}
          >
            Open in desktop client
          </Button>
          {r.console_url && (
            <Button size="lg">Open console</Button>
          )}
        </div>
      </div>

      <dl className="mt-4 grid gap-x-8 gap-y-2 border-t border-line pt-4 sm:grid-cols-2">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-micro font-semibold uppercase text-tertiary">Endpoint</dt>
          <dd className="truncate font-mono text-xs text-primary">{r.host}:{r.port}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-micro font-semibold uppercase text-tertiary">Mode</dt>
          <dd className="font-mono text-xs text-primary">{r.connect_mode}</dd>
        </div>
      </dl>

      <div className="mt-3 flex items-center gap-2 rounded border border-line bg-subtle px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-primary">
          pam connect {r.name}
        </code>
        <Button size="sm" icon={Copy} aria-label="Copy the CLI command" />
      </div>
      <p className="mt-2 text-xs text-tertiary">
        The desktop route issues a single-use launch token from{' '}
        <span className="font-mono text-primary">POST /pam/resources/:id/launch</span> and hands it to a paired
        device. The token expires in seconds and is consumed once.
      </p>
    </Panel>
  )
}

// ── Pair a device ─────────────────────────────────────────────────────────
// The live code + countdown is the whole point: a stale code left on screen
// produces a confusing 401 on the CLI side.
export function PairAgentPanel() {
  const [code, setCode] = useState(null)
  const [left, setLeft] = useState(0)

  useEffect(() => {
    if (!code) return undefined
    const t = setInterval(() => setLeft((s) => (s <= 1 ? 0 : s - 1)), 1000)
    return () => clearInterval(t)
  }, [code])

  const expired = code && left === 0

  return (
    <Panel className="p-4">
      <p className="text-base font-semibold text-primary">Pair a device</p>
      <p className="mt-1 max-w-prose text-sm text-secondary">
        Run <span className="font-mono text-xs text-primary">pam pair</span> on the machine you want to launch
        sessions from, then enter this code. Pairing requires MFA on this session.
      </p>

      {!code ? (
        <div className="mt-4">
          <Button
            variant="primary"
            onClick={() => {
              setCode('4KQ7-2WMB')
              setLeft(120)
            }}
          >
            Generate a pairing code
          </Button>
        </div>
      ) : (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-3">
            <code
              className={clsx(
                'rounded border px-3 py-2 font-mono text-lg tracking-[0.2em]',
                expired ? 'border-line bg-subtle text-tertiary line-through' : 'border-line-strong bg-subtle text-primary'
              )}
            >
              {code}
            </code>
            <Button size="sm" icon={Copy} disabled={expired}>Copy</Button>
            <span className={clsx('text-xs tabular', expired ? 'text-danger' : left < 30 ? 'text-warn' : 'text-tertiary')}>
              {expired ? 'expired' : `expires in ${left}s`}
            </span>
            {expired && (
              <Button size="sm" onClick={() => { setCode('9TR3-8HXQ'); setLeft(120) }}>
                Generate another
              </Button>
            )}
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
            <div
              className={clsx('h-full rounded-full transition-[width] duration-1000 ease-linear', left < 30 ? 'bg-warn' : 'bg-line-strong')}
              style={{ width: `${(left / 120) * 100}%` }}
            />
          </div>
        </div>
      )}
    </Panel>
  )
}

// ── MFA enrolment wizard ──────────────────────────────────────────────────
// Three steps, and all three are shown from the start: someone about to scan
// a QR code needs to know backup codes are coming, or they close the dialog at
// step two and lock themselves out. That is the reason for the rail.
const MFA_STEPS = ['Scan', 'Verify', 'Backup codes']

export function MfaEnrolmentDialog({ open, onClose, onDone }) {
  const [step, setStep] = useState(0)
  const [code, setCode] = useState(['', '', '', '', '', ''])
  const [saved, setSaved] = useState(false)
  const complete = code.every((d) => d !== '')

  const close = () => {
    setStep(0)
    setCode(['', '', '', '', '', ''])
    setSaved(false)
    onClose?.()
  }

  const backupCodes = [
    '4f2a-91cd', '7b13-load', '0e88-mx4q', '5c72-nn19', '9a01-tt6z',
    '3d45-kk22', '8f19-pp07', '1b60-rr58', '6e34-ww81', '2c97-yy43',
  ]

  return (
    <Dialog
      open={open}
      onClose={close}
      size="md"
      title="Set up two-factor authentication"
      description="A time-based code from an app on your phone."
      steps={MFA_STEPS}
      current={step}
      footer={
        step === 0 ? (
          <>
            <Button variant="primary" size="lg" onClick={() => setStep(1)}>I&apos;ve scanned it</Button>
            <Button size="lg" onClick={close}>Cancel</Button>
            <Meta className="ml-auto hidden sm:inline">POST /auth/mfa/setup/initiate</Meta>
          </>
        ) : step === 1 ? (
          <>
            <Button variant="primary" size="lg" disabled={!complete} onClick={() => setStep(2)}>Verify</Button>
            <Button size="lg" onClick={() => setStep(0)}>Back</Button>
            <Meta className="ml-auto hidden sm:inline">POST /auth/mfa/setup/verify</Meta>
          </>
        ) : (
          <>
            <Button variant="primary" size="lg" disabled={!saved} onClick={() => { onDone?.(); close() }}>
              {saved ? 'Finish' : 'Save them first'}
            </Button>
            <Button size="lg" icon={Download}>Download</Button>
          </>
        )
      }
    >
      {step === 0 && (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          {/* A real QR placeholder — a drawn grid, not a decorative box. */}
          <div className="mx-auto flex h-40 w-40 flex-none items-center justify-center rounded border border-line bg-white p-2 sm:mx-0">
            <svg viewBox="0 0 21 21" className="h-full w-full" role="img" aria-label="QR code for the authenticator app">
              {Array.from({ length: 21 }).map((_, y) =>
                Array.from({ length: 21 }).map((__, x) => {
                  const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13)
                  const ring = finder && (x % 6 === 0 || y % 6 === 0 || (x > 1 && x < 5 && y > 1 && y < 5))
                  const on = finder ? ring : (x * 7 + y * 13 + x * y) % 3 === 0
                  return on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#0F172A" /> : null
                })
              )}
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-sm text-secondary">
              Scan this with Google Authenticator, 1Password, Authy or any TOTP app.
            </p>
            <p className="mt-3 text-micro font-semibold uppercase text-tertiary">Can&apos;t scan?</p>
            <div className="mt-2 flex items-center gap-2 rounded border border-line bg-subtle px-2 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-primary">JBSWY3DPEHPK3PXP</code>
              <Button size="sm" icon={Copy} aria-label="Copy the setup key" />
            </div>
            <p className="mt-3 flex items-start gap-2 text-xs text-tertiary">
              <Smartphone className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
              <span>Ten single-use backup codes come at the end. Don&apos;t close this before saving them.</span>
            </p>
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <p className="max-w-prose text-sm text-secondary">Enter the current six-digit code to prove the app is set up.</p>
          <div className="mt-4 flex gap-2" role="group" aria-label="Six digit code">
            {code.map((d, i) => (
              <input
                key={i}
                inputMode="numeric"
                maxLength={1}
                value={d}
                onChange={(e) => {
                  const next = [...code]
                  next[i] = e.target.value.replace(/\D/g, '')
                  setCode(next)
                }}
                aria-label={`Digit ${i + 1}`}
                className="h-11 w-full rounded border border-line bg-surface text-center font-mono text-lg text-primary focus:border-accent focus:outline-none"
              />
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <AlarmBand tone="warn" icon={ShieldAlert}>
            These are shown once. Without them, losing your phone means an administrator has to reset your MFA.
          </AlarmBand>
          <div className="mt-4 grid grid-cols-2 gap-2 rounded border border-line bg-subtle p-3 sm:grid-cols-2">
            {backupCodes.map((c) => (
              <code key={c} className="font-mono text-sm text-primary">{c}</code>
            ))}
          </div>
          <label className="mt-4 flex cursor-pointer items-start gap-3">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]" />
            <span className="text-sm text-primary">I have saved these somewhere I can reach without my phone.</span>
          </label>
        </div>
      )}
    </Dialog>
  )
}

// ── MFA enforcement gate ──────────────────────────────────────────────────
// A full-screen block, not a banner: the account cannot proceed, and a
// dismissible banner would imply otherwise. It names the rule that caught
// them and the role that rule targets.
export function MfaGate({ role = 'admin', onEnrol }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-app px-4 py-16">
      <div className="w-full max-w-[26rem]">
        <span className="flex h-9 w-9 items-center justify-center rounded bg-warn-soft text-warn">
          <ShieldCheck className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <h1 className="mt-4 text-xl font-semibold text-primary">Two-factor authentication is required</h1>
        <p className="mt-2 max-w-prose text-base text-secondary">
          An MFA policy rule covers the <span className="font-mono text-sm text-primary">{role}</span> role, which
          this account holds. You can&apos;t use the console until a second factor is enrolled.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="lg" onClick={onEnrol}>Enrol now</Button>
          <Button size="lg">Sign out</Button>
        </div>
        <p className="mt-6 text-xs text-tertiary">
          If you have lost your device, an administrator can reset your MFA — that is an audited action and they
          will ask why.
        </p>
      </div>
    </div>
  )
}

// ── Report builder ────────────────────────────────────────────────────────
// The endpoint REQUIRES from/to as RFC3339 and 400s without them, so the form
// always carries a concrete range, seeded from whatever the list is filtered
// to. Formats are the three the API produces — nothing else is offered.
const FORMATS = [
  ['csv', 'CSV', 'Row-per-event, for a spreadsheet or a pipeline'],
  ['xlsx', 'Excel', 'Same rows, formatted, with the filter set on a cover sheet'],
  ['pdf', 'PDF', 'A signed-off summary for an auditor'],
]

export function ReportBuilderDialog({ open, onClose, seededFrom = '2026-07-20', seededTo = '2026-08-19', filterSummary }) {
  const [format, setFormat] = useState('csv')
  const [from, setFrom] = useState(seededFrom)
  const [to, setTo] = useState(seededTo)
  const days = Math.max(0, Math.round((new Date(to) - new Date(from)) / 86_400_000))

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Generate a compliance report"
      description="Runs server-side over the whole matching range, not just the rows on screen."
      footer={
        <>
          <Button variant="primary" size="lg" icon={FileText} disabled={days === 0}>Generate</Button>
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Meta className="ml-auto hidden sm:inline">POST /pam/audit/report</Meta>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <FieldSet title="Range" hint="Required by the endpoint — it refuses a report without both ends.">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="From" htmlFor="rb-from" required>
              <input id="rb-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
            </Field>
            <Field label="To" htmlFor="rb-to" required error={days === 0 ? 'The range must cover at least one day.' : null}>
              <input id="rb-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
            </Field>
          </div>
          <p className="text-xs text-tertiary tabular">{days} days selected.</p>
        </FieldSet>

        <FieldSet title="Format">
          <div className="flex flex-col gap-1">
            {FORMATS.map(([val, label, copy]) => (
              <label
                key={val}
                className={clsx(
                  'flex cursor-pointer items-start gap-3 rounded border px-3 py-2',
                  format === val ? 'border-line-strong bg-subtle' : 'border-line hover:bg-hover'
                )}
              >
                <input type="radio" name="rb-format" checked={format === val} onChange={() => setFormat(val)} className="mt-1 h-3.5 w-3.5 accent-[rgb(var(--accent))]" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-primary">{label}</span>
                  <span className="mt-0.5 block text-xs text-secondary">{copy}</span>
                </span>
              </label>
            ))}
          </div>
        </FieldSet>

        {filterSummary && (
          <div>
            <p className="mb-2 text-micro font-semibold uppercase text-tertiary">Filters carried over</p>
            <p className="rounded border border-line bg-subtle px-3 py-2 font-mono text-xs text-primary">{filterSummary}</p>
          </div>
        )}

        <p className="flex items-start gap-2 text-xs text-tertiary">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
          <span>
            Generating a report is itself audited as{' '}
            <span className="font-mono text-primary">pam:report:Generate</span> and requires MFA on this session.
            Wide ranges take a while — the request streams rather than paging.
          </span>
        </p>
      </div>
    </Dialog>
  )
}

// ── Session recording player ──────────────────────────────────────────────
// The biggest omission of pass 1: SessionRecordingViewer.jsx is 1265 lines and
// already implements the shape every serious replay product converges on —
// a SYNCHRONISED DUAL PANE (replay left, searchable command log right, one
// shared timeline). Clicking a command seeks the replay; the replay highlights
// the command as it passes. Pass 1 replaced all of that with a Play button.
//
// ENDPOINTS  GET /admin/recordings/:id/cast · /commands   (both called
// directly from the component today, not through src/api — see audit C-01)
const CAST_LINES = [
  { t: 0, text: 'psql (16.2) — connected to pg-prod-01.internal:5432/core' },
  { t: 4, text: 'core=# \\dt orders*' },
  { t: 7, text: '            List of relations' },
  { t: 8, text: ' public | orders          | table | pam_admin' },
  { t: 9, text: ' public | orders_archive  | table | pam_admin' },
  { t: 14, text: 'core=# EXPLAIN ANALYZE SELECT * FROM orders WHERE created_at > now() - interval \'1 day\';' },
  { t: 22, text: ' Seq Scan on orders  (cost=0.00..48210.00 rows=1204 width=312)' },
  { t: 23, text: ' Planning Time: 0.412 ms' },
  { t: 24, text: ' Execution Time: 3821.004 ms' },
  { t: 31, text: 'core=# CREATE INDEX CONCURRENTLY idx_orders_created_at ON orders (created_at);' },
  { t: 58, text: 'CREATE INDEX' },
  { t: 61, text: 'core=# \\q' },
]

const COMMANDS = CAST_LINES.filter((l) => l.text.startsWith('core=#')).map((l) => ({
  t: l.t,
  cmd: l.text.replace('core=# ', ''),
}))

export function RecordingPlayer({ open, onClose, recording }) {
  const rec = recording || recordings[0]
  const total = 64
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [q, setQ] = useState('')
  const timer = useRef(null)

  useEffect(() => {
    if (!playing) return undefined
    timer.current = setInterval(() => {
      setT((s) => {
        if (s >= total) {
          setPlaying(false)
          return total
        }
        return s + speed
      })
    }, 250)
    return () => clearInterval(timer.current)
  }, [playing, speed])

  useEffect(() => {
    if (open) {
      setT(0)
      setPlaying(false)
    }
  }, [open])

  const visible = CAST_LINES.filter((l) => l.t <= t)
  const activeCmd = useMemo(() => [...COMMANDS].reverse().find((c) => c.t <= t), [t])
  const shownCommands = COMMANDS.filter((c) => !q || c.cmd.toLowerCase().includes(q.toLowerCase()))

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-app">
      {/* Full-bleed, not a dialog: a replay needs the screen, and on mobile a
          centred box would be unusable. */}
      <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-primary">{rec.resource_name}</p>
          <p className="truncate text-xs text-tertiary">
            {rec.username} · {duration(rec.duration_seconds)} · <span className="font-mono">{rec.format}</span>
          </p>
        </div>
        {rec.is_breakglass && (
          <span className="flex-none rounded-sm bg-[rgb(var(--danger-fill))] px-1 py-0.5 text-micro font-semibold uppercase text-white">
            Break-glass
          </span>
        )}
        <div className="ml-auto flex flex-none items-center gap-2">
          <Button size="md" icon={Download}>Download .cast</Button>
          <Button size="md" icon={Maximize2} aria-label="Fullscreen" />
          <Button size="md" onClick={onClose}>Close</Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Replay */}
        <div className="flex min-h-0 flex-1 flex-col border-b border-line lg:border-b-0 lg:border-r">
          <div className="min-h-0 flex-1 overflow-auto bg-[#0B0E14] p-4 font-mono text-xs leading-relaxed text-[#C8D0DC]">
            {visible.map((l, i) => (
              <p key={i} className={clsx(l.text.startsWith('core=#') && 'text-[#7FA5FF]')}>{l.text}</p>
            ))}
            {playing && <span className="inline-block h-3 w-2 animate-pulse bg-[#C8D0DC]" aria-hidden="true" />}
          </div>

          {/* Transport + the shared timeline. Command markers sit ON the
              scrubber, so the shape of the session is visible before you play. */}
          <div className="flex-none border-t border-line bg-surface px-4 py-3">
            <div className="relative">
              <input
                type="range"
                min={0}
                max={total}
                value={t}
                onChange={(e) => setT(Number(e.target.value))}
                aria-label="Seek"
                className="w-full accent-[rgb(var(--accent))]"
              />
              <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2" aria-hidden="true">
                {COMMANDS.map((c) => (
                  <span
                    key={c.t}
                    className="absolute h-2 w-px bg-warn"
                    style={{ left: `${(c.t / total) * 100}%` }}
                  />
                ))}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="md" icon={playing ? Pause : Play} onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'} />
              <Button size="md" icon={SkipBack} onClick={() => setT(0)} aria-label="Restart" />
              <span className="font-mono text-xs tabular text-secondary">
                {String(Math.floor(t / 60)).padStart(2, '0')}:{String(Math.floor(t % 60)).padStart(2, '0')} / 01:04
              </span>
              <span className="ml-auto flex items-center gap-1">
                <Gauge className="h-3.5 w-3.5 text-tertiary" strokeWidth={1.75} />
                {[1, 2, 4].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSpeed(s)}
                    className={clsx(
                      'h-7 rounded px-2 text-xs font-semibold tabular',
                      speed === s ? 'bg-subtle text-primary' : 'text-tertiary hover:text-primary'
                    )}
                  >
                    {s}×
                  </button>
                ))}
              </span>
            </div>
          </div>
        </div>

        {/* Command log — searchable, and clicking seeks. */}
        <aside className="flex min-h-0 w-full flex-none flex-col lg:w-[22rem]">
          <div className="flex-none border-b border-line px-3 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" strokeWidth={1.75} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search commands"
                aria-label="Search commands in this recording"
                className={clsx(inputClass, 'pl-7')}
              />
            </div>
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto">
            {shownCommands.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-tertiary">No command matches “{q}”.</li>
            )}
            {shownCommands.map((c) => (
              <li key={c.t}>
                <button
                  type="button"
                  onClick={() => setT(c.t)}
                  className={clsx(
                    'flex w-full items-start gap-3 border-b border-line px-3 py-2 text-left',
                    activeCmd?.t === c.t ? 'bg-subtle' : 'hover:bg-hover'
                  )}
                >
                  <span className="w-10 flex-none font-mono text-xs tabular text-tertiary">
                    {String(Math.floor(c.t / 60)).padStart(2, '0')}:{String(c.t % 60).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-primary">{c.cmd}</span>
                </button>
              </li>
            ))}
          </ol>
          <p className="flex-none border-t border-line px-3 py-2 text-xs text-tertiary">
            {COMMANDS.length} commands · integrity{' '}
            <span className="font-mono text-primary">{rec.sha256}</span>
          </p>
        </aside>
      </div>
    </div>
  )
}
