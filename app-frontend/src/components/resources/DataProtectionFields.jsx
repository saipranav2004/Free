import clsx from 'clsx'
import { ShieldCheck, ShieldOff, ClipboardX, Code2, Radio, Gauge, Terminal } from 'lucide-react'
import { Checkbox } from '../common/Checkbox'
import { inputClass, selectClass } from '../common/FormFields'

// ---------------------------------------------------------------------------
// Data-protection controls, shared by registration and editing
// ---------------------------------------------------------------------------
// WHY THIS IS ITS OWN FILE. These controls existed only in the edit modal, so
// a resource could be registered with none of them and nobody found out until
// someone opened it again to edit. The two surfaces have to offer the same
// settings, described the same way, or the registration form quietly becomes a
// way to create resources with no protection at all.
//
// Extracting it is the fix rather than copying the block into the second modal:
// two copies of a security control's wording and defaults drift, and the drift
// is invisible precisely because each screen looks right on its own.
//
// ORDERING IS DELIBERATE and is the argument the screen makes. "Brokered access
// only" comes first because every control below it is bypassable without it —
// the desktop agent receives the credential and connects straight to the
// target, so PAM never sees that traffic. The egress cap comes last because it
// is the strongest: it bounds the worst case whatever endpoint or command is
// used, where clipboard blocking is a deterrent a determined user defeats.

export const EGRESS_PRESETS = [
  { value: 0, label: 'Unlimited' },
  { value: 10 * 1024 * 1024, label: '10 MB' },
  { value: 50 * 1024 * 1024, label: '50 MB' },
  { value: 250 * 1024 * 1024, label: '250 MB' },
  { value: 1024 * 1024 * 1024, label: '1 GB' },
]

// The value written to allowed_connect_methods when "brokered access only" is
// on: the two paths PAM is genuinely in the data flow for.
export const BROKERED_ONLY = 'web_proxy,web_terminal'

// The default shape, so both modals start from one definition.
export function emptyDataProtection() {
  return {
    brokered_only: false,
    block_download: false,
    block_clipboard: false,
    block_devtools: false,
    watermark: false,
    max_egress_bytes: 0,
    denied_commands: '',
  }
}

// Is this configuration self-defeating — controls on, broker not enforced?
export function isUnenforceable(values) {
  const egressCapped = Number(values.max_egress_bytes) > 0
  const protectionOn =
    values.block_clipboard || values.block_devtools || values.block_download || egressCapped
  return protectionOn && !values.brokered_only
}

const TONES = {
  blue: 'border-blue-500/45 bg-blue-50/70 dark:bg-blue-950/20',
  amber: 'border-amber-500/45 bg-amber-50/70 dark:bg-amber-950/20',
  purple: 'border-purple-500/45 bg-purple-50/70 dark:bg-purple-950/20',
  emerald: 'border-emerald-500/45 bg-emerald-50/70 dark:bg-emerald-950/20',
}
const ICON_TONES = {
  blue: 'text-blue-600 dark:text-blue-400',
  amber: 'text-amber-600 dark:text-amber-400',
  purple: 'text-purple-600 dark:text-purple-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
}

// Policy choices read as decisions with consequences, not as a column of
// unlabelled checkboxes.
export function ToggleCard({ checked, onChange, icon: Icon, title, description, tone = 'blue' }) {
  return (
    <label
      className={clsx(
        'flex cursor-pointer gap-3.5 rounded-xl border p-4 transition-colors',
        checked ? TONES[tone] : 'border-surface-700 bg-surface-850 hover:border-surface-600'
      )}
    >
      <Checkbox checked={checked} onChange={onChange} srLabel={title} />
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-semibold text-ink-50">
          <Icon className={clsx('h-4 w-4 flex-none', ICON_TONES[tone])} strokeWidth={1.75} />
          {title}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-ink-400">{description}</span>
      </span>
    </label>
  )
}

// values: the six data-protection fields.
// set:    (key) => (value) => void, matching both modals' existing setter.
export function DataProtectionFields({ values, set }) {
  const unenforceable = isUnenforceable(values)

  return (
    <div className="border-t border-surface-800 pt-5 space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-500">Data protection</p>

      <ToggleCard
        checked={values.brokered_only}
        onChange={set('brokered_only')}
        icon={ShieldCheck}
        title="Brokered access only"
        tone="blue"
        description="Closes the desktop agent and the direct console link, so every session goes through PAM. Required for the controls below to hold."
      />
      <ToggleCard
        checked={values.block_download}
        onChange={set('block_download')}
        icon={ShieldOff}
        title="Block file downloads"
        tone="blue"
        description="Refuses any response the application serves as a file. Enforced server-side, so it cannot be bypassed from the browser."
      />
      <ToggleCard
        checked={values.block_clipboard}
        onChange={set('block_clipboard')}
        icon={ClipboardX}
        title="Block copy and paste"
        tone="blue"
        description="Suppresses copy, selection and paste in brokered browser and CLI sessions, and audits every attempt. Deterrent only — a determined user can defeat it."
      />
      <ToggleCard
        checked={values.block_devtools}
        onChange={set('block_devtools')}
        icon={Code2}
        title="Block browser developer tools"
        tone="blue"
        description="Suppresses F12, Ctrl+Shift+I, Ctrl+Shift+J and view-source in brokered browser sessions, and blanks the page while developer tools appear to be open. Deterrent only, and it blanks on a heuristic, so leave it off for a console your team keeps open all day."
      />
      <ToggleCard
        checked={values.watermark}
        onChange={set('watermark')}
        icon={Radio}
        title="Watermark the screen"
        tone="blue"
        description="Overlays the operator's username, session ID and time. The only control that discourages photographing the screen."
      />

      <div className="rounded-xl border border-surface-700 bg-surface-850 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink-50">
          <Gauge className="h-4 w-4 flex-none text-blue-600 dark:text-blue-400" strokeWidth={1.75} />
          Session data transfer limit
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-400">
          Caps the total volume one session may pull, whatever endpoint or command is used. The strongest
          control here: it bounds the worst case even when everything else is bypassed.
        </p>
        <select
          className={selectClass(false) + ' mt-3'}
          value={values.max_egress_bytes}
          onChange={(e) => set('max_egress_bytes')(Number(e.target.value))}
        >
          {EGRESS_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-xl border border-surface-700 bg-surface-850 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink-50">
          <Terminal className="h-4 w-4 flex-none text-blue-600 dark:text-blue-400" strokeWidth={1.75} />
          Blocked commands
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-400">
          Comma-separated bulk-extraction patterns refused in a terminal session. Matched at word
          boundaries, so an ordinary query that merely mentions one of these still runs.
          <strong className="text-ink-300"> Leave empty to use the built-in list</strong> for this resource
          type.
        </p>
        <input
          className={inputClass(false) + ' mt-3 font-mono text-xs'}
          placeholder="\copy, pg_dump, \o"
          value={values.denied_commands}
          onChange={(e) => set('denied_commands')(e.target.value)}
        />
      </div>

      {/* The honest warning, shown exactly when the configuration is
          self-defeating: controls on, broker not enforced. */}
      {unenforceable && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs leading-relaxed text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
          <p className="flex items-center gap-1.5 font-semibold">
            <ShieldOff className="h-3.5 w-3.5 flex-none" strokeWidth={2} />
            These controls will not be enforced
          </p>
          <p className="mt-1.5">
            Without <strong>Brokered access only</strong>, a user can open this resource in the desktop
            agent, which receives the credential and connects directly to the target. PAM never sees that
            traffic, so nothing above applies to it.
          </p>
        </div>
      )}
    </div>
  )
}
