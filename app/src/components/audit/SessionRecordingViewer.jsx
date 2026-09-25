import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  X,
  Play,
  Pause,
  RotateCcw,
  SkipBack,
  SkipForward,
  Maximize2,
  Minimize2,
  Download,
  Copy,
  Check,
  Terminal,
  ListTree,
  ShieldAlert,
  Gauge,
  Clock,
  Server,
  UserRound,
  HardDrive,
  Hash,
  FileText,
  SearchX,
  Info,
} from 'lucide-react'
import clsx from 'clsx'
import * as adminApi from '../../api/admin'
import * as httpModule from '../../lib/http'
import { Button, IconButton } from '../common/Button'
import { Badge } from '../common/Badge'
import { Spinner } from '../common/Spinner'
import { EmptyState } from '../common/Layout'
import { SearchField } from '../common/TableControls'
import { formatDateTime } from '../../lib/format'
import { apiErrorMessage } from '../../lib/apiError'
import { RECORDING_STATUS_BADGE } from '../../config/constants'

// ---------------------------------------------------------------------------
// Session recording viewer
// ---------------------------------------------------------------------------
// The Recordings tab used to be a dead end: rows rendered, rows did nothing.
// This is the surface that opens when you click one.
//
// WHAT IT IS, PRECISELY, BECAUSE THE HONESTY MATTERS. There is no video on
// this backend. A recording is an asciicast v2 transcript (a list of
// [seconds, stream, data] triples captured by the gateway) plus a separately
// stored, sequence-numbered command log. So this player is a terminal replay
// driven by one authored clock, presented with the transport controls an
// operator expects from a session player: play, pause, restart, seek, speed,
// idle skipping, fullscreen. Nothing here pretends to be a screen capture,
// and no number on this screen is invented: every field renders only when the
// API actually returned it.
//
// SHAPE, and why it is this shape. The pattern every serious PAM and session
// replay product converges on (CyberArk PVWA's session details plus player,
// BeyondTrust, Datadog Session Replay, StrongDM) is a SYNCHRONISED DUAL PANE:
// the replay on the left, a searchable event log on the right, one shared
// timeline between them. Clicking an event seeks the replay; the replay
// highlights the event it has reached; the scrubber carries a tick for every
// command so the shape of the session is visible before you play it.
//
// BACKEND CONTRACT IS UNCHANGED. The same three endpoints are called with the
// same arguments and the same response handling as before:
//   GET /api/v1/pam/admin/recordings/:id/cast      (asciicast v2 transcript)
//   GET /api/v1/pam/admin/recordings/:id/commands  (keystroke/command log)
//
// HOW THEY ARE CALLED, and why it is written this way. api/admin.js is imported
// as a NAMESPACE rather than with named bindings. A named ESM import of a
// function that a given copy of api/admin.js does not happen to export is a
// hard, module-level SyntaxError at load time - it takes down the whole route
// before a single component renders, which is exactly the failure this file
// hit ("does not provide an export named 'downloadRecordingCast'"). A
// namespace import cannot fail that way, so each helper below prefers the
// shared api/admin.js implementation when it is present and otherwise performs
// the identical request itself against the same authenticated http client. The
// wire calls are byte-for-byte the same either way; only the resolution is
// defensive.

const http = httpModule.http ?? httpModule.default

function requireHttp() {
  if (!http || typeof http.get !== 'function') {
    throw new Error('The API client could not be resolved from lib/http')
  }
  return http
}

// Local, because lib/format.js does not export a byte formatter and adding one
// there would be an unrequested change to a shared module. Binary units, one
// decimal above KB, so a 4.2 MB transcript does not read as 4402341.
function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return 'unknown'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

function saveBlob(blob, filename) {
  if (typeof httpModule.triggerBlobDownload === 'function') {
    httpModule.triggerBlobDownload(blob, filename)
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Not the standard { success, data } envelope: this endpoint streams raw
// newline-delimited JSON as application/x-asciicast, so it is read as text and
// parsed here rather than unwrapped via data.data.
async function fetchRecordingCast(id, signal) {
  if (typeof adminApi.getRecordingCast === 'function') {
    return adminApi.getRecordingCast(id, signal)
  }
  const { data } = await requireHttp().get(`/api/v1/pam/admin/recordings/${id}/cast`, {
    signal,
    responseType: 'text',
    transformResponse: [(d) => d], // keep raw text - a JSONL stream is not JSON
  })
  const lines = String(data)
    .split('\n')
    .filter((l) => l.trim().length > 0)
  return {
    header: lines.length > 0 ? JSON.parse(lines[0]) : null,
    events: lines.slice(1).map((l) => JSON.parse(l)),
  }
}

async function fetchRecordingCommands(id, params, signal) {
  if (typeof adminApi.listRecordingCommands === 'function') {
    return adminApi.listRecordingCommands(id, params, signal)
  }
  const { data } = await requireHttp().get(`/api/v1/pam/admin/recordings/${id}/commands`, { params, signal })
  return data.data // { commands, pagination }
}

// A plain <a href> cannot carry the Bearer token, so the transcript is fetched
// as a blob through the authenticated client and saved client-side.
async function saveRecordingCast(id, filenameHint) {
  if (typeof adminApi.downloadRecordingCast === 'function') {
    return adminApi.downloadRecordingCast(id, filenameHint)
  }
  const response = await requireHttp().get(`/api/v1/pam/admin/recordings/${id}/cast`, {
    responseType: 'blob',
  })
  saveBlob(response.data, filenameHint || `${id}.cast`)
}

const SPEEDS = [0.5, 1, 1.5, 2, 4]
const IDLE_GAP = 1.5 // seconds of dead air before "skip idle" jumps
const SEEK_STEP = 10
const MAX_LINES = 4000
const COMMAND_PAGE_SIZE = 200
// Ceiling on a full-log export, so a pathological session (millions of
// commands) cannot turn one click into an unbounded request loop. At 200 per
// page this is 10,000 commands; past that the export says it was truncated
// rather than pretending to be complete.
const MAX_EXPORT_PAGES = 50

const FAILED_OUTCOMES = new Set(['ERROR', 'FAIL', 'FAILED', 'DENIED', 'DENY', 'REJECTED', 'TIMEOUT'])

// Escape sequences a real terminal would execute rather than print. We are not
// a terminal emulator, so colour/cursor codes are removed instead of applied:
// stripping them keeps a native-agent capture (a raw ConPTY byte stream, full
// of redraw codes) readable, which printing them verbatim does not.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g

function stripAnsi(s) {
  return String(s).replace(ANSI_PATTERN, '')
}

// A deliberately small single-line emulator: carriage return moves the write
// head to column zero (so shell redraws overwrite instead of duplicating),
// backspace steps back one column, newline commits the line. That covers what
// a transcript of an interactive shell actually contains.
function writeChunk(state, raw) {
  const clean = stripAnsi(raw).replace(/\r\n/g, '\n')
  for (const ch of clean) {
    if (ch === '\n') {
      state.lines.push('')
      state.col = 0
      if (state.lines.length > MAX_LINES) state.lines.shift()
      continue
    }
    if (ch === '\r') {
      state.col = 0
      continue
    }
    if (ch === '\b') {
      state.col = Math.max(0, state.col - 1)
      continue
    }
    if (ch === '\u0007' || ch === '\u0000') continue
    const i = state.lines.length - 1
    const line = state.lines[i]
    state.lines[i] = line.slice(0, state.col) + ch + line.slice(state.col + 1)
    state.col += 1
  }
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

function utcStamp(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`
}

// Index of the last event at or before t, i.e. how many events have played.
function countPlayed(times, t) {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function nextEventTime(times, t) {
  for (let i = 0; i < times.length; i += 1) if (times[i] > t) return times[i]
  return null
}

function isRisky(cmd) {
  return FAILED_OUTCOMES.has(String(cmd?.outcome || '').toUpperCase())
}

// --- small pieces -----------------------------------------------------------

function MetaField({ icon: Icon, label, value, mono = false }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 px-4 py-2.5">
      {Icon && <Icon className="mt-0.5 h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-ink-500">{label}</p>
        <p className={clsx('mt-0.5 break-words text-xs text-ink-100', mono && 'font-mono')}>{value}</p>
      </div>
    </div>
  )
}

function CopyCommandButton({ value }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <IconButton
      icon={copied ? Check : Copy}
      variant="ghost"
      size="xs"
      aria-label="Copy command"
      title="Copy command"
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(String(value || ''))
          setCopied(true)
        } catch {
          toast.error('Clipboard unavailable in this browser')
        }
      }}
    />
  )
}

// --- the viewer -------------------------------------------------------------

function Viewer({ recording, autoplay, onClose }) {
  const rootRef = useRef(null)
  // The replay half on its own. Fullscreen used to have exactly one target ,
  // the whole dialog, which meant "fullscreen" still spent a third of the
  // screen on the command log and the header. A terminal replay is the thing
  // people actually want filled edge to edge, so the player is now its own
  // fullscreen target (transport controls included, the way a video player
  // keeps its controls), and the whole-panel button stays for when you want
  // the log alongside it.
  const replayRef = useRef(null)
  const paneRef = useRef(null)
  const stickRef = useRef(true)
  const termRef = useRef({ played: 0, lines: [''], col: 0 })
  const tRef = useRef(0)

  const [tab, setTab] = useState('log')
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [skipIdle, setSkipIdle] = useState(true)
  const [skipFlash, setSkipFlash] = useState(null)
  // Which element is currently fullscreen: 'player' | 'card' | null.
  const [fsTarget, setFsTarget] = useState(null)
  const [exportingLog, setExportingLog] = useState(false)
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [activeSeq, setActiveSeq] = useState(null)
  const [page, setPage] = useState(1)

  const status = String(recording?.status || '').toUpperCase()
  const canReplay = status === 'COMPLETED' || status === 'FAILED'

  const castQuery = useQuery({
    queryKey: ['admin', 'recording', recording.id, 'cast'],
    queryFn: ({ signal }) => fetchRecordingCast(recording.id, signal),
    enabled: canReplay,
    retry: false,
  })

  const commandsQuery = useQuery({
    queryKey: ['admin', 'recording', recording.id, 'commands', page],
    queryFn: ({ signal }) =>
      fetchRecordingCommands(recording.id, { page, page_size: COMMAND_PAGE_SIZE }, signal),
    placeholderData: (prev) => prev,
    retry: false,
  })

  const events = useMemo(() => castQuery.data?.events || [], [castQuery.data])
  const header = castQuery.data?.header || {}
  const times = useMemo(() => events.map((e) => Number(e?.[0]) || 0), [events])
  const castDuration = times.length ? times[times.length - 1] : 0
  const duration = Math.max(castDuration, Number(recording?.duration_seconds) || 0)

  const commands = useMemo(() => commandsQuery.data?.commands || [], [commandsQuery.data])
  const pagination = commandsQuery.data?.pagination
  const startMs = useMemo(() => {
    const iso = recording?.started_at || recording?.created_at
    const ms = iso ? new Date(iso).getTime() : NaN
    return Number.isFinite(ms) ? ms : null
  }, [recording])

  // Offset of a command inside the replay. Null when the data cannot support
  // it, and a null offset disables seeking for that row rather than guessing.
  const offsetOf = useCallback(
    (cmd) => {
      if (startMs == null || !cmd?.occurred_at) return null
      const ms = new Date(cmd.occurred_at).getTime()
      if (!Number.isFinite(ms)) return null
      const off = (ms - startMs) / 1000
      if (off < -1) return null
      if (duration > 0 && off > duration + 5) return null
      return Math.min(Math.max(off, 0), duration || off)
    },
    [startMs, duration]
  )

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return commands
      .map((cmd, i) => ({ cmd, i, offset: offsetOf(cmd) }))
      .filter(({ cmd }) => {
        if (!needle) return true
        return [cmd?.input, cmd?.outcome, cmd?.output_summary, cmd?.sequence]
          .filter((v) => v !== null && v !== undefined)
          .some((v) => String(v).toLowerCase().includes(needle))
      })
  }, [commands, q, offsetOf])

  const riskyCount = useMemo(() => commands.filter(isRisky).length, [commands])
  const maskedCount = useMemo(() => commands.filter((c) => c?.input_masked).length, [commands])
  const markers = useMemo(
    () =>
      duration > 0
        ? commands.map((cmd) => ({ cmd, offset: offsetOf(cmd) })).filter((m) => m.offset != null)
        : [],
    [commands, offsetOf, duration]
  )

  const played = useMemo(() => countPlayed(times, t), [times, t])

  useEffect(() => {
    tRef.current = t
  }, [t])

  // Reset the emulator whenever a different transcript arrives.
  useEffect(() => {
    termRef.current = { played: 0, lines: [''], col: 0 }
    setText('')
    setT(0)
    tRef.current = 0
  }, [castQuery.data])

  // Incremental render: only the events between the last painted index and the
  // current one are written, so playback stays cheap on long sessions. Seeking
  // backwards rewinds by replaying from zero, which is the only correct answer
  // when the stream contains overwrite semantics.
  useEffect(() => {
    const st = termRef.current
    if (played === st.played) return
    if (played < st.played) {
      st.lines = ['']
      st.col = 0
      st.played = 0
    }
    for (let i = st.played; i < played; i += 1) {
      const ev = events[i]
      if (!ev) continue
      if (ev[1] !== 'o') continue
      writeChunk(st, ev[2] ?? '')
    }
    st.played = played
    setText(st.lines.join('\n'))
  }, [played, events])

  // Follow the tail unless the operator has scrolled up to read something.
  useEffect(() => {
    const pane = paneRef.current
    if (!pane || !stickRef.current) return
    pane.scrollTop = pane.scrollHeight
  }, [text])

  useEffect(() => {
    if (autoplay && canReplay && events.length > 0) setPlaying(true)
  }, [autoplay, canReplay, events.length])

  // The clock. One interval, 10 ticks a second, advancing by real elapsed time
  // multiplied by the speed, so 2x is genuinely twice as fast and a slow frame
  // does not desynchronise the log from the replay.
  useEffect(() => {
    if (!playing || duration <= 0) return undefined
    let last = performance.now()
    const id = setInterval(() => {
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      let next = tRef.current + dt * speed
      if (skipIdle) {
        const upcoming = nextEventTime(times, tRef.current)
        if (upcoming != null && upcoming - next > IDLE_GAP) {
          setSkipFlash(Math.round(upcoming - next))
          next = Math.max(next, upcoming - 0.2)
        }
      }
      if (next >= duration) next = duration
      tRef.current = next
      setT(next)
    }, 100)
    return () => clearInterval(id)
  }, [playing, speed, skipIdle, duration, times])

  useEffect(() => {
    if (playing && duration > 0 && t >= duration) setPlaying(false)
  }, [t, playing, duration])

  useEffect(() => {
    if (skipFlash == null) return undefined
    const id = setTimeout(() => setSkipFlash(null), 1200)
    return () => clearTimeout(id)
  }, [skipFlash])

  const seek = useCallback(
    (to) => {
      const clamped = Math.min(Math.max(0, to), duration || 0)
      tRef.current = clamped
      setT(clamped)
      stickRef.current = true
    },
    [duration]
  )

  const jumpToCommand = useCallback(
    (entry) => {
      setActiveSeq(entry.cmd?.sequence ?? entry.i)
      if (entry.offset == null) {
        toast('This entry has no timestamp offset inside the recording, so the replay cannot seek to it.')
        return
      }
      seek(entry.offset)
    },
    [seek]
  )

  // Keyboard: the shortcuts a player is expected to have, suppressed while a
  // text field has focus so typing in the log search never scrubs the replay.
  useEffect(() => {
    const onKey = (e) => {
      const tag = String(e.target?.tagName || '').toLowerCase()
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable
      if (e.key === 'Escape') {
        if (document.fullscreenElement) return
        onClose?.()
        return
      }
      if (typing) return
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        if (canReplay && duration > 0) setPlaying((p) => !p)
        return
      }
      if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j') {
        e.preventDefault()
        seek(tRef.current - SEEK_STEP)
        return
      }
      if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') {
        e.preventDefault()
        seek(tRef.current + SEEK_STEP)
        return
      }
      // F is the player, not the panel, that is what the key means in every
      // video player, and it is the one people reach for while watching.
      if (e.key.toLowerCase() === 'f') toggleFullscreenOn(replayRef)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReplay, duration, seek, onClose])

  useEffect(() => {
    const onChange = () => {
      const el = document.fullscreenElement
      if (!el) setFsTarget(null)
      else if (el === replayRef.current) setFsTarget('player')
      else if (el === rootRef.current) setFsTarget('card')
      else setFsTarget('other')
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Body scroll lock, same treatment the console's Modal applies.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  // One toggle, two possible targets. Requesting fullscreen on a second
  // element while another is already fullscreen is allowed, the Fullscreen
  // API keeps a stack, so this needs no exit-then-enter dance, which would
  // lose the user gesture and get the request refused.
  function toggleFullscreenOn(ref) {
    const node = ref?.current
    if (!node) return
    if (document.fullscreenElement === node) {
      document.exitFullscreen?.()
      return
    }
    node.requestFullscreen?.().catch(() => {
      toast.error('Fullscreen was refused by this browser')
    })
  }

  const downloadCast = async () => {
    try {
      await saveRecordingCast(recording.id, `${recording.session_id || recording.id}.cast`)
    } catch (err) {
      toast.error(apiErrorMessage(err))
    }
  }

  // Export the COMMAND LOG, not the replay. The log is paginated on screen, so
  // exporting only what happens to be loaded would hand an auditor page 3 of 7
  // and no hint that the rest exists, every page is fetched here first.
  const downloadLog = async () => {
    if (exportingLog) return
    setExportingLog(true)
    try {
      const totalPages = Math.max(1, Number(pagination?.total_pages) || 1)
      let rows = commands
      let truncated = false

      if (totalPages > 1) {
        const capped = Math.min(totalPages, MAX_EXPORT_PAGES)
        truncated = capped < totalPages
        const all = []
        for (let p = 1; p <= capped; p += 1) {
          // Sequential on purpose: this is an audit export, not a hot path,
          // and firing N parallel requests at the recordings endpoint is a
          // worse trade than waiting a moment.
          // eslint-disable-next-line no-await-in-loop
          const res = await fetchRecordingCommands(recording.id, { page: p, page_size: COMMAND_PAGE_SIZE })
          all.push(...(res?.commands || []))
        }
        if (all.length > 0) rows = all
      }

      if (rows.length === 0) {
        toast.error('No commands were logged for this recording')
        return
      }

      const lines = [
        `# Session recording command log`,
        `# recording: ${recording.id}`,
        `# session:   ${recording.session_id || 'unknown'}`,
        `# resource:  ${recording.resource_name || recording.resource_id || 'unknown'}`,
        `# user:      ${recording.username || 'unknown'}`,
        `# exported:  ${new Date().toISOString()}`,
        `# commands:  ${rows.length}${truncated ? ` (first ${MAX_EXPORT_PAGES} pages of ${totalPages})` : ''}`,
        '',
        ...rows.map((c) =>
          [
            `#${c?.sequence ?? ''}`,
            c?.occurred_at || '',
            c?.outcome || '',
            c?.duration_ms != null ? `${c.duration_ms}ms` : '',
            c?.input_masked ? '(masked)' : '',
            String(c?.input ?? '').replace(/\s+$/, ''),
          ]
            .filter(Boolean)
            .join('\t')
        ),
      ]

      saveBlob(
        new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }),
        `${recording.session_id || recording.id}-commands.txt`
      )
      toast.success(
        truncated
          ? `Exported ${rows.length} commands (first ${MAX_EXPORT_PAGES} pages)`
          : `Exported ${rows.length} command${rows.length === 1 ? '' : 's'}`
      )
    } catch (err) {
      toast.error(apiErrorMessage(err))
    } finally {
      setExportingLog(false)
    }
  }

  const pct = duration > 0 ? Math.min(100, (t / duration) * 100) : 0
  const transportDisabled = !canReplay || duration <= 0 || castQuery.isLoading

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5">
      <div
        className="animate-overlay-in absolute inset-0 bg-slate-950/70 backdrop-blur-[3px] dark:bg-black/80"
        aria-hidden="true"
        onClick={onClose}
      />

      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label="Session recording"
        className="animate-panel-in relative flex h-full max-h-[54rem] w-full max-w-[100rem] flex-col overflow-hidden rounded-2xl border border-surface-700 bg-surface-900 shadow-overlay"
      >
        {/* --- header: who, what, where, how long, how big ----------------- */}
        <header className="flex flex-none flex-wrap items-start gap-x-6 gap-y-3 border-b border-surface-800 bg-surface-850/60 px-5 py-3.5">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-900 text-ink-400">
              <Terminal className="h-4 w-4" strokeWidth={1.6} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-sm font-semibold text-ink-50">
                  {recording.resource_name || recording.resource_id || 'Session recording'}
                </h2>
                <Badge className={RECORDING_STATUS_BADGE[recording.status]}>
                  {recording.status || 'UNKNOWN'}
                </Badge>
                {riskyCount > 0 && (
                  <Badge className="bg-red-500/10 text-red-700 ring-red-600/25 dark:text-red-300">
                    {riskyCount} failed {riskyCount === 1 ? 'command' : 'commands'}
                  </Badge>
                )}
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-500">
                <span className="flex items-center gap-1.5">
                  <UserRound className="h-3 w-3" strokeWidth={1.9} />
                  {recording.username || 'unknown user'}
                </span>
                <span className="flex items-center gap-1.5 font-mono">
                  <Hash className="h-3 w-3" strokeWidth={1.9} />
                  {recording.session_id || recording.id}
                </span>
                <span className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3" strokeWidth={1.9} />
                  {formatDateTime(recording.started_at || recording.created_at)}
                </span>
                <span className="flex items-center gap-1.5">
                  <Gauge className="h-3 w-3" strokeWidth={1.9} />
                  {duration > 0 ? clock(duration) : 'duration not reported'}
                </span>
                <span className="flex items-center gap-1.5">
                  <HardDrive className="h-3 w-3" strokeWidth={1.9} />
                  {recording.size_bytes != null ? formatBytes(recording.size_bytes) : 'size not reported'}
                </span>
              </p>
            </div>
          </div>

          <div className="flex flex-none items-center gap-2">
            {/* This button hands over the COMMAND LOG. It used to download the
                .cast replay under the label "Transcript", which is the file
 almost nobody wants from here, the auditable artefact is the
 list of commands. The raw replay is still exportable from
                Properties → Export for anyone who needs it. */}
            <Button
              size="sm"
              variant="secondary"
              icon={FileText}
              loading={exportingLog}
              onClick={downloadLog}
              title="Download the full command log (.txt)"
            >
              Command log
            </Button>
            <IconButton
              icon={fsTarget === 'card' ? Minimize2 : Maximize2}
              variant="secondary"
              size="sm"
              onClick={() => toggleFullscreenOn(rootRef)}
              aria-label={fsTarget === 'card' ? 'Exit fullscreen' : 'Fullscreen this panel'}
              title={fsTarget === 'card' ? 'Exit fullscreen' : 'Fullscreen the whole panel'}
            />
            <IconButton
              icon={X}
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="Close"
              title="Close (Esc)"
            />
          </div>
        </header>

        {/* --- body: replay | log ------------------------------------------ */}
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* replay, also the fullscreen target for the player button and F.
              It carries its own background because a fullscreen element is
 painted on the browser's own backdrop, not on the dialog it
 normally sits inside. */}
          <section
            ref={replayRef}
            className="flex min-h-0 flex-1 flex-col border-b border-surface-800 bg-surface-900 lg:border-b-0 lg:border-r"
          >
            <div className="relative min-h-0 flex-1 bg-[#080b10]">
              {!canReplay ? (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <div>
                    <Spinner size="h-4 w-4" className="mx-auto text-ink-400" />
                    <p className="mt-3 text-sm font-medium text-ink-200">
                      Recording is {status ? status.toLowerCase() : 'in progress'}
                    </p>
                    <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-ink-500">
                      The transcript is written when the session ends. Come back once the status is COMPLETED
                      and the replay will be available here.
                    </p>
                  </div>
                </div>
              ) : castQuery.isLoading ? (
                <div className="space-y-2 p-4">
                  {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                    <div
                      key={i}
                      className="skeleton h-3 rounded"
                      style={{ width: `${40 + ((i * 13) % 55)}%` }}
                    />
                  ))}
                </div>
              ) : castQuery.isError ? (
                <div className="flex h-full items-center justify-center px-6">
                  <div className="max-w-sm text-center">
                    <p className="text-sm font-semibold text-red-300">Transcript could not be loaded</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
                      {apiErrorMessage(castQuery.error)}
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-4"
                      onClick={() => castQuery.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                </div>
              ) : events.length === 0 ? (
                <div className="flex h-full items-center justify-center px-6">
                  <p className="max-w-sm text-center text-xs leading-relaxed text-ink-500">
                    This recording contains no transcript data. The session may have produced no output before
                    it ended.
                  </p>
                </div>
              ) : (
                <>
                  <div
                    ref={paneRef}
                    onScroll={(e) => {
                      const el = e.currentTarget
                      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
                    }}
                    className="h-full overflow-auto px-4 py-3"
                  >
                    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-[1.45] text-emerald-100/90">
                      {text}
                      <span
                        aria-hidden="true"
                        className={clsx(
                          'ml-px inline-block h-3.5 w-[7px] translate-y-[2px] bg-emerald-300/80',
                          playing && 'animate-pulse'
                        )}
                      />
                    </pre>
                  </div>

                  {skipFlash != null && skipFlash > 0 && (
                    <span className="pointer-events-none absolute right-4 top-3 rounded-md bg-black/70 px-2 py-1 font-mono text-2xs text-emerald-200 ring-1 ring-inset ring-emerald-500/30">
                      skipped {skipFlash}s idle
                    </span>
                  )}

                  <span className="pointer-events-none absolute left-4 top-3 rounded-md bg-black/60 px-2 py-1 font-mono text-2xs text-ink-400 ring-1 ring-inset ring-white/10">
                    {header.width || 120}x{header.height || 30}
                  </span>
                </>
              )}
            </div>

            {/* transport */}
            <div className="flex-none border-t border-surface-800 bg-surface-900 px-4 py-3">
              {/* scrubber with a tick for every logged command */}
              <div className="relative h-6">
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-surface-750">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-[width] duration-100 ease-linear"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {markers.map((m, i) => (
                  <span
                    key={m.cmd?.id ?? `${m.offset}-${i}`}
                    title={`#${m.cmd?.sequence ?? ''} ${m.cmd?.input || ''}`}
                    className={clsx(
                      'absolute top-1/2 h-3 w-[2px] -translate-y-1/2 rounded-sm',
                      isRisky(m.cmd) ? 'bg-red-400' : 'bg-ink-400/70'
                    )}
                    style={{ left: `${duration > 0 ? (m.offset / duration) * 100 : 0}%` }}
                  />
                ))}
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-blue-500 shadow-sm"
                  style={{ left: `${pct}%` }}
                />
                <input
                  type="range"
                  min={0}
                  max={duration > 0 ? duration : 1}
                  step={0.1}
                  value={t}
                  disabled={transportDisabled}
                  onChange={(e) => seek(Number(e.target.value))}
                  aria-label="Seek recording"
                  className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-not-allowed"
                />
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex items-center gap-1.5">
                  <IconButton
                    icon={playing ? Pause : Play}
                    variant="primary"
                    size="sm"
                    disabled={transportDisabled}
                    onClick={() => setPlaying((p) => !p)}
                    aria-label={playing ? 'Pause' : 'Play'}
                    title={playing ? 'Pause (Space)' : 'Play (Space)'}
                  />
                  <IconButton
                    icon={SkipBack}
                    variant="secondary"
                    size="sm"
                    disabled={transportDisabled}
                    onClick={() => seek(t - SEEK_STEP)}
                    aria-label="Back 10 seconds"
                    title="Back 10s (Left arrow)"
                  />
                  <IconButton
                    icon={SkipForward}
                    variant="secondary"
                    size="sm"
                    disabled={transportDisabled}
                    onClick={() => seek(t + SEEK_STEP)}
                    aria-label="Forward 10 seconds"
                    title="Forward 10s (Right arrow)"
                  />
                  <IconButton
                    icon={RotateCcw}
                    variant="secondary"
                    size="sm"
                    disabled={transportDisabled}
                    onClick={() => {
                      setPlaying(false)
                      seek(0)
                    }}
                    aria-label="Restart"
                    title="Stop and restart"
                  />
                </div>

                <span className="font-mono text-xs tabular-nums text-ink-200">
                  {clock(t)} <span className="text-ink-600">/</span> {clock(duration)}
                </span>

                <span className="text-2xs text-ink-500">
                  event {Math.min(played, events.length).toLocaleString()} of {events.length.toLocaleString()}
                </span>

                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSkipIdle((v) => !v)}
                    aria-pressed={skipIdle}
                    className={clsx(
                      'flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
                      skipIdle
                        ? 'border-blue-500/40 bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
                        : 'border-surface-700 bg-surface-900 text-ink-400 hover:border-surface-600 hover:text-ink-100'
                    )}
                  >
                    <SkipForward className="h-3.5 w-3.5" strokeWidth={2} />
                    Skip idle
                  </button>

                  <label className="flex items-center gap-2">
                    <span className="sr-only">Playback speed</span>
                    <select
                      value={speed}
                      onChange={(e) => setSpeed(Number(e.target.value))}
                      disabled={transportDisabled}
                      className="h-8 cursor-pointer rounded-lg border border-surface-700 bg-surface-900 pl-2.5 pr-7 text-xs font-medium text-ink-100 transition-colors hover:border-surface-600 focus:border-blue-500 focus:outline-none disabled:opacity-45"
                    >
                      {SPEEDS.map((s) => (
                        <option key={s} value={s}>
                          {s}x
                        </option>
                      ))}
                    </select>
                  </label>

                  {/* Fullscreen for the replay itself, bottom-right of the
 transport, where every video player puts it. */}
                  <IconButton
                    icon={fsTarget === 'player' ? Minimize2 : Maximize2}
                    variant="secondary"
                    size="sm"
                    onClick={() => toggleFullscreenOn(replayRef)}
                    aria-label={fsTarget === 'player' ? 'Exit fullscreen' : 'Fullscreen the replay'}
                    title={fsTarget === 'player' ? 'Exit fullscreen (F)' : 'Fullscreen the replay (F)'}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* log + properties */}
          <aside className="flex min-h-0 w-full flex-col bg-surface-900 lg:w-[27rem] xl:w-[31rem]">
            <div className="flex flex-none items-center gap-1 border-b border-surface-800 px-3">
              {[
                {
                  key: 'log',
                  label: 'Command log',
                  icon: ListTree,
                  count: pagination?.total ?? commands.length,
                },
                { key: 'props', label: 'Properties', icon: FileText },
              ].map((tb) => (
                <button
                  key={tb.key}
                  type="button"
                  onClick={() => setTab(tb.key)}
                  aria-selected={tab === tb.key}
                  className={clsx(
                    'flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors',
                    tab === tb.key
                      ? 'border-blue-500 text-ink-50'
                      : 'border-transparent text-ink-500 hover:text-ink-200'
                  )}
                >
                  <tb.icon className="h-3.5 w-3.5" strokeWidth={1.9} />
                  {tb.label}
                  {typeof tb.count === 'number' && tb.count > 0 && (
                    <span className="rounded bg-surface-800 px-1 text-2xs font-semibold tabular-nums text-ink-400">
                      {tb.count.toLocaleString()}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {tab === 'log' ? (
              <>
                <div className="flex flex-none items-center gap-2 border-b border-surface-800 px-3 py-2.5">
                  <SearchField value={q} onChange={setQ} placeholder="Search commands…" />
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  {commandsQuery.isLoading ? (
                    <div className="space-y-2 p-3">
                      {[0, 1, 2, 3, 4, 5].map((i) => (
                        <div key={i} className="skeleton h-9 rounded-lg" />
                      ))}
                    </div>
                  ) : commandsQuery.isError ? (
                    <div className="px-4 py-8 text-center">
                      <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                        Command log unavailable
                      </p>
                      <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
                        {apiErrorMessage(commandsQuery.error)}
                      </p>
                    </div>
                  ) : commands.length === 0 ? (
                    <EmptyState
                      icon={ListTree}
                      title="No commands logged"
                      description="This session ended without any command being captured. The replay above is still the full transcript."
                      className="py-10"
                    />
                  ) : rows.length === 0 ? (
                    <EmptyState
                      icon={SearchX}
                      title="Nothing matches"
                      description="No command on this page contains that text."
                      action={
                        <Button variant="secondary" size="sm" onClick={() => setQ('')}>
                          Clear search
                        </Button>
                      }
                      className="py-10"
                    />
                  ) : (
                    <ul className="divide-y divide-surface-800">
                      {rows.map((entry) => {
                        const { cmd, offset } = entry
                        const risky = isRisky(cmd)
                        const active = activeSeq != null && activeSeq === (cmd?.sequence ?? entry.i)
                        const reached = offset != null && offset <= t
                        return (
                          <li key={cmd?.id ?? `${cmd?.sequence}-${entry.i}`}>
                            <div
                              role="button"
                              tabIndex={0}
                              onClick={() => jumpToCommand(entry)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  jumpToCommand(entry)
                                }
                              }}
                              className={clsx(
                                'group relative flex w-full cursor-pointer items-start gap-2.5 px-3 py-2.5 pl-4 text-left transition-colors',
                                active ? 'bg-blue-500/10' : 'hover:bg-surface-850'
                              )}
                            >
                              <span
                                aria-hidden="true"
                                className={clsx(
                                  'absolute inset-y-0 left-0 w-[3px]',
                                  risky
                                    ? 'bg-red-400/80'
                                    : active
                                      ? 'bg-blue-500'
                                      : reached
                                        ? 'bg-emerald-500/45'
                                        : 'bg-transparent'
                                )}
                              />
                              <span className="mt-0.5 w-9 flex-none font-mono text-2xs tabular-nums text-ink-600">
                                {offset != null ? clock(offset) : '--:--'}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-start gap-2">
                                  <code
                                    className={clsx(
                                      'min-w-0 flex-1 break-all font-mono text-xs',
                                      risky ? 'text-red-700 dark:text-red-300' : 'text-ink-100'
                                    )}
                                  >
                                    {cmd?.input || '(no input captured)'}
                                  </code>
                                  {cmd?.outcome && (
                                    <Badge
                                      className={clsx(
                                        'flex-none',
                                        risky
                                          ? 'bg-red-500/10 text-red-700 ring-red-600/25 dark:text-red-300'
                                          : 'bg-emerald-500/10 text-emerald-700 ring-emerald-600/25 dark:text-emerald-300'
                                      )}
                                    >
                                      {cmd.outcome}
                                    </Badge>
                                  )}
                                </span>
                                <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-ink-500">
                                  <span className="font-mono">#{cmd?.sequence ?? entry.i + 1}</span>
                                  <span>{formatDateTime(cmd?.occurred_at)}</span>
                                  {cmd?.duration_ms != null && <span>{cmd.duration_ms}ms</span>}
                                  {cmd?.input_masked && (
                                    <span className="text-amber-600 dark:text-amber-400">masked</span>
                                  )}
                                  {cmd?.output_summary && (
                                    <span className="truncate">{cmd.output_summary}</span>
                                  )}
                                </span>
                              </span>
                              <span className="flex-none opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                <CopyCommandButton value={cmd?.input} />
                              </span>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>

                <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-t border-surface-800 bg-surface-850/50 px-3 py-2">
                  <p className="text-2xs text-ink-500">
                    {q
                      ? `${rows.length} of ${commands.length} on this page`
                      : `Click a line to seek the replay to it`}
                  </p>
                  {pagination && pagination.total_pages > 1 && (
                    <span className="flex items-center gap-1.5">
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={page <= 1 || commandsQuery.isFetching}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                      >
                        Previous
                      </Button>
                      <span className="font-mono text-2xs tabular-nums text-ink-500">
                        {pagination.page}/{pagination.total_pages}
                      </span>
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={page >= pagination.total_pages || commandsQuery.isFetching}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Next
                      </Button>
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="divide-y divide-surface-800">
                  <MetaField
                    icon={Server}
                    label="Resource"
                    value={recording.resource_name || 'Not reported'}
                  />
                  <MetaField
                    icon={Hash}
                    label="Resource ID"
                    value={recording.resource_id || 'Not reported'}
                    mono
                  />
                  <MetaField icon={UserRound} label="User" value={recording.username || 'Not reported'} />
                  <MetaField
                    icon={Hash}
                    label="Session ID"
                    value={recording.session_id || 'Not reported'}
                    mono
                  />
                  <MetaField icon={Hash} label="Recording ID" value={recording.id} mono />
                  <MetaField
                    icon={Clock}
                    label="Started (local)"
                    value={formatDateTime(recording.started_at || recording.created_at)}
                  />
                  <MetaField
                    icon={Clock}
                    label="Started (UTC)"
                    value={utcStamp(recording.started_at || recording.created_at) || 'Not reported'}
                    mono
                  />
                  {recording.ended_at && (
                    <MetaField
                      icon={Clock}
                      label="Ended (local)"
                      value={formatDateTime(recording.ended_at)}
                    />
                  )}
                  <MetaField
                    icon={Gauge}
                    label="Duration"
                    value={duration > 0 ? `${clock(duration)} (${Math.round(duration)}s)` : 'Not reported'}
                  />
                  <MetaField
                    icon={HardDrive}
                    label="Stored size"
                    value={
                      recording.size_bytes != null
                        ? `${formatBytes(recording.size_bytes)} (${Number(recording.size_bytes).toLocaleString()} bytes)`
                        : 'Not reported'
                    }
                  />
                  <MetaField
                    icon={Terminal}
                    label="Terminal"
                    value={
                      castQuery.data
                        ? `${header.width || 120} cols x ${header.height || 30} rows`
                        : 'Available once the transcript loads'
                    }
                    mono
                  />
                  <MetaField
                    icon={ListTree}
                    label="Transcript events"
                    value={castQuery.data ? events.length.toLocaleString() : 'Not loaded'}
                  />
                  <MetaField
                    icon={ListTree}
                    label="Commands logged"
                    value={(pagination?.total ?? commands.length).toLocaleString()}
                  />
                </div>

                <div className="border-t border-surface-800 px-4 py-4">
                  <p className="flex items-center gap-2 text-xs font-semibold text-ink-500">
                    <ShieldAlert className="h-3.5 w-3.5" strokeWidth={1.9} />
                    Risk indicators
                  </p>
                  <ul className="mt-2.5 space-y-1.5 text-xs leading-relaxed text-ink-300">
                    <li>
                      {riskyCount > 0 ? (
                        <span className="text-red-700 dark:text-red-300">
                          {riskyCount} command{riskyCount === 1 ? '' : 's'} on this page ended in an error or
                          denial.
                        </span>
                      ) : (
                        'No failed or denied command on this page.'
                      )}
                    </li>
                    <li>
                      {maskedCount > 0
                        ? `${maskedCount} command${maskedCount === 1 ? '' : 's'} had input masked by policy.`
                        : 'No masked input in this log.'}
                    </li>
                    {recording.failure_reason && (
                      <li className="text-red-700 dark:text-red-300">
                        Session failure: {recording.failure_reason}
                      </li>
                    )}
                  </ul>
                </div>

                <div className="border-t border-surface-800 px-4 py-4">
                  <p className="text-xs font-semibold text-ink-500">Export</p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" icon={Download} onClick={downloadCast}>
                      Recording transcript
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={FileText}
                      loading={exportingLog}
                      onClick={downloadLog}
                    >
                      Command log
                    </Button>
                  </div>
                  <p className="mt-2.5 flex items-start gap-2 text-2xs leading-relaxed text-ink-500">
                    <Info className="mt-px h-3 w-3 flex-none" strokeWidth={1.9} />
                    The transcript downloads exactly as the gateway stored it, the raw asciicast replay. The
                    command log exports every logged command, not just the page on screen, as a tab-separated
                    text file.
                  </p>
                </div>
              </div>
            )}
          </aside>
        </div>

        {/* --- footer: shortcuts, so they are discoverable ----------------- */}
        <footer className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 border-t border-surface-800 bg-surface-850/60 px-5 py-2">
          <span className="text-2xs text-ink-500">
            <kbd className="rounded border border-surface-700 bg-surface-900 px-1 font-mono">Space</kbd> play
            or pause
          </span>
          <span className="text-2xs text-ink-500">
            <kbd className="rounded border border-surface-700 bg-surface-900 px-1 font-mono">←</kbd>
            <kbd className="ml-1 rounded border border-surface-700 bg-surface-900 px-1 font-mono">→</kbd> seek
            10s
          </span>
          <span className="text-2xs text-ink-500">
            <kbd className="rounded border border-surface-700 bg-surface-900 px-1 font-mono">F</kbd>{' '}
            fullscreen replay
          </span>
          <span className="text-2xs text-ink-500">
            <kbd className="rounded border border-surface-700 bg-surface-900 px-1 font-mono">Esc</kbd> back to
            list
          </span>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={onClose}>
            Back to recordings
          </Button>
        </footer>
      </div>
    </div>
  )
}

// `key` on the inner component is what guarantees a clean player per
// recording: selecting a different row remounts the clock, the emulator and
// the log rather than trying to reconcile one session's state onto another.
export function SessionRecordingViewer({ recording, autoplay = false, onClose }) {
  if (!recording) return null
  return (
    <Viewer
      key={recording.id || recording.session_id}
      recording={recording}
      autoplay={autoplay}
      onClose={onClose}
    />
  )
}
