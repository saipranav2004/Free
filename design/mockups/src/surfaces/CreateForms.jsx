import { useState } from 'react'
import clsx from 'clsx'
import { Eye, EyeOff, RefreshCw, ShieldAlert, Wand2 } from 'lucide-react'
import { Dialog } from '../ui/overlay'
import {
  Button, Field, FieldSet, Meta, ReviewRow, StrengthMeter, StatusDot,
  inputClass, selectClass, textareaClass,
} from '../ui/primitives'
import { credentials, folders, resources, roles, safes } from '../fixtures'

// ===========================================================================
// Create / edit forms
// ===========================================================================
// Every field below is one the real endpoint accepts. Nothing else is drawn.
// Where the API takes a field the current UI omits, it is added and marked;
// where the UI offers a field the API ignores, it is removed.
//
// Field sources (zod schemas in the current build, cross-checked against the
// Go handlers' bind structs):
//   CreateUserModal      full_name · username · email · password · role
//   CreateRoleModal      name · description
//   CreatePolicyModal    name · description · effect · actions[] · resources[]
//   CreateResourceModal  name · resource_type · description · host · port ·
//                        database_name · connect_mode · console_url ·
//                        extra_config · requires_jit · always_record
//   CreateSafeModal      name · description · retention_days
//   CreateFolderModal    name · parent_folder_id
//   CreateCredentialModal name · account_name · credential_type ·
//                        secret_plaintext · description · folder_id ·
//                        rotation_interval_days
//   CreateJitRequest     resource_id · duration_minutes · reason · action ·
//                        ticket_ref
//   DelegateAdmin        reason · expires_at · scope_resource_ids · replace_admin
//
// RESPONSIVE: all of these use <Dialog>, which is a centred panel ≥640px and
// a full-height bottom sheet below — so a nine-field form on a phone is a
// full-screen form, not a 60%-height box with the keyboard over the submit.

const RESOURCE_TYPES = [
  'postgresql', 'mongodb', 'redis', 'clickhouse', 'minio',
  'qdrant', 'metabase', 'langfuse', 'web', 'oracle',
]
const CONNECT_MODES = ['web_terminal', 'console_url', 'desktop_agent']
const CREDENTIAL_TYPES = [
  ['password', 'Password'],
  ['ssh_key', 'SSH private key'],
  ['x509_cert', 'X.509 certificate'],
  ['api_key', 'API key / bearer token'],
  ['token', 'OAuth / OIDC token'],
  ['connection_string', 'Connection string'],
  ['kerberos_keytab', 'Kerberos keytab'],
]
const DEFAULT_PORTS = {
  postgresql: 5432, mongodb: 27017, redis: 6379, clickhouse: 9000,
  minio: 9000, qdrant: 6333, metabase: 3000, langfuse: 3000, web: 443, oracle: 1521,
}

// ── Create user ───────────────────────────────────────────────────────────
export function CreateUserDialog({ open, onClose, onDone }) {
  const [v, setV] = useState({ full_name: '', username: '', email: '', password: '', role: 'user' })
  const [show, setShow] = useState(false)
  const [touched, setTouched] = useState(false)
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })

  const errors = {
    username: !v.username.trim()
      ? 'A username is required — it is what this person signs in with.'
      : /[^a-z0-9._-]/.test(v.username)
        ? 'Lower-case letters, numbers, dot, underscore and hyphen only.'
        : null,
    email: !v.email.trim() ? 'An email address is required.' : !v.email.includes('@') ? 'That is not a valid email address.' : null,
    password: v.password.length < 12 ? 'At least 12 characters.' : null,
  }
  const score = v.password.length >= 20 ? 3 : v.password.length >= 16 ? 2 : v.password.length >= 12 ? 1 : 0
  const invalid = Object.values(errors).some(Boolean)

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="New user"
      description="Creates the account and, optionally, gives it a starting role."
      footer={
        <>
          <Button
            variant="primary"
            size="lg"
            disabled={invalid}
            onClick={() => {
              setTouched(true)
              if (!invalid) onDone?.(v.username)
            }}
          >
            Create user
          </Button>
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Meta className="ml-auto hidden sm:inline">POST /admin/identity/users</Meta>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <FieldSet title="Identity">
          <Field label="Full name" htmlFor="cu-name" hint="Optional. Shown wherever this account appears.">
            <input id="cu-name" value={v.full_name} onChange={set('full_name')} className={inputClass} />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Username" htmlFor="cu-user" required error={touched ? errors.username : null} hint="Used to sign in. Cannot be changed later.">
              <input id="cu-user" value={v.username} onChange={set('username')} onBlur={() => setTouched(true)} className={clsx(inputClass, 'font-mono')} />
            </Field>
            <Field label="Email" htmlFor="cu-email" required error={touched ? errors.email : null}>
              <input id="cu-email" type="email" value={v.email} onChange={set('email')} onBlur={() => setTouched(true)} className={clsx(inputClass, 'font-mono')} />
            </Field>
          </div>
        </FieldSet>

        <FieldSet title="First password" hint="The account signs in with this once. There is no self-service password change endpoint, so a reset goes through an administrator.">
          <Field label="Password" htmlFor="cu-pass" required error={touched ? errors.password : null}>
            <div className="relative">
              <input
                id="cu-pass"
                type={show ? 'text' : 'password'}
                value={v.password}
                onChange={set('password')}
                onBlur={() => setTouched(true)}
                className={clsx(inputClass, 'pr-16 font-mono')}
              />
              <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
                <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} className="flex h-7 w-7 items-center justify-center rounded text-tertiary hover:text-primary">
                  {show ? <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />}
                </button>
                <button
                  type="button"
                  onClick={() => setV({ ...v, password: 'Kx7-quiet-harbour-9134' })}
                  aria-label="Generate a strong password"
                  className="flex h-7 w-7 items-center justify-center rounded text-tertiary hover:text-primary"
                >
                  <Wand2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </div>
            </div>
          </Field>
          <StrengthMeter score={score} />
        </FieldSet>

        <FieldSet title="Starting role">
          <Field
            label="Role"
            htmlFor="cu-role"
            hint="admin and root are refused by this endpoint — admin is granted through delegation, and root cannot be granted at all."
          >
            <select id="cu-role" value={v.role} onChange={set('role')} className={selectClass}>
              <option value="">No role</option>
              {roles.filter((r) => !['admin', 'root'].includes(r.name)).map((r) => (
                <option key={r.id} value={r.name}>{r.name}</option>
              ))}
            </select>
          </Field>
        </FieldSet>
      </div>
    </Dialog>
  )
}

// ── Create resource (wizard) ──────────────────────────────────────────────
const RES_STEPS = ['Identity', 'Connection', 'Governance', 'Review']

export function CreateResourceDialog({ open, onClose, onDone }) {
  const [step, setStep] = useState(0)
  const [v, setV] = useState({
    name: '', resource_type: '', description: '', host: '', port: '',
    database_name: '', connect_mode: 'web_terminal', console_url: '',
    extra_config: '', requires_jit: true, always_record: true,
  })
  const [touched, setTouched] = useState(false)
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })

  const stepErrors = [
    { name: !v.name.trim() ? 'Give this resource a name people will recognise.' : null, resource_type: !v.resource_type ? 'Pick the type — it sets the default port and the connect mode.' : null },
    { host: !v.host.trim() ? 'A hostname or IP is required.' : null, port: !v.port ? 'A port is required.' : Number(v.port) < 1 || Number(v.port) > 65535 ? 'Between 1 and 65535.' : null },
    {},
    {},
  ][step]
  const stepInvalid = Object.values(stepErrors || {}).some(Boolean)

  const advance = () => {
    setTouched(true)
    if (stepInvalid) return
    setTouched(false)
    setStep((s) => s + 1)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Add a resource"
      description="Register a system this console can broker access to."
      steps={RES_STEPS}
      current={step}
      footer={
        <>
          {step < RES_STEPS.length - 1 ? (
            <Button variant="primary" size="lg" onClick={advance}>Continue</Button>
          ) : (
            <Button variant="primary" size="lg" onClick={() => onDone?.(v.name)}>Create resource</Button>
          )}
          {step > 0 && <Button size="lg" onClick={() => setStep((s) => s - 1)}>Back</Button>}
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Meta className="ml-auto hidden sm:inline">POST /admin/resources</Meta>
        </>
      }
    >
      {step === 0 && (
        <FieldSet title="What is it">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Name" htmlFor="cr-name" required error={touched ? stepErrors.name : null} hint="How it appears in the catalog.">
              <input id="cr-name" value={v.name} onChange={set('name')} className={inputClass} />
            </Field>
            <Field label="Type" htmlFor="cr-type" required error={touched ? stepErrors.resource_type : null} hint="Sets the default port.">
              <select
                id="cr-type"
                value={v.resource_type}
                onChange={(e) => setV({ ...v, resource_type: e.target.value, port: v.port || String(DEFAULT_PORTS[e.target.value] || '') })}
                className={selectClass}
              >
                <option value="">Choose…</option>
                {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Description" htmlFor="cr-desc" hint="Optional. What this system is for, and who owns it.">
            <textarea id="cr-desc" rows={2} value={v.description} onChange={set('description')} className={textareaClass} />
          </Field>
        </FieldSet>
      )}

      {step === 1 && (
        <FieldSet title="How we reach it">
          <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
            <Field label="Host" htmlFor="cr-host" required error={touched ? stepErrors.host : null}>
              <input id="cr-host" value={v.host} onChange={set('host')} className={clsx(inputClass, 'font-mono')} placeholder="pg-prod-01.internal" />
            </Field>
            <Field label="Port" htmlFor="cr-port" required error={touched ? stepErrors.port : null}>
              <input id="cr-port" inputMode="numeric" value={v.port} onChange={set('port')} className={clsx(inputClass, 'font-mono')} />
            </Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Database name" htmlFor="cr-db" hint="Only meaningful for database types.">
              <input id="cr-db" value={v.database_name} onChange={set('database_name')} className={clsx(inputClass, 'font-mono')} />
            </Field>
            <Field label="Connect mode" htmlFor="cr-mode" hint="How a session is opened.">
              <select id="cr-mode" value={v.connect_mode} onChange={set('connect_mode')} className={selectClass}>
                {CONNECT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
          </div>
          {v.connect_mode === 'console_url' && (
            <Field label="Console URL" htmlFor="cr-url" hint="Opened in a new tab instead of a terminal.">
              <input id="cr-url" value={v.console_url} onChange={set('console_url')} className={clsx(inputClass, 'font-mono')} placeholder="https://metabase.internal" />
            </Field>
          )}
          <Field label="Extra config (JSON)" htmlFor="cr-extra" hint="Optional. Passed through to the connector verbatim.">
            <textarea id="cr-extra" rows={3} value={v.extra_config} onChange={set('extra_config')} className={clsx(textareaClass, 'font-mono text-xs')} placeholder='{"sslmode":"require"}' />
          </Field>
        </FieldSet>
      )}

      {step === 2 && (
        <FieldSet title="How access is governed" hint="These two flags are what an operator later filters the catalog by, so they are worth getting right now.">
          <label className="flex cursor-pointer items-start gap-3 rounded border border-line px-3 py-3">
            <input type="checkbox" checked={v.requires_jit} onChange={(e) => setV({ ...v, requires_jit: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-primary">Require just-in-time access</span>
              <span className="mt-1 block text-xs text-secondary">Nobody connects without an approved request. Standard requests need two different approvers.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded border border-line px-3 py-3">
            <input type="checkbox" checked={v.always_record} onChange={(e) => setV({ ...v, always_record: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-primary">Always record sessions</span>
              <span className="mt-1 block text-xs text-secondary">Every session produces an asciicast recording with a SHA-256 over the stored object.</span>
            </span>
          </label>
        </FieldSet>
      )}

      {step === 3 && (
        <div>
          <p className="mb-4 max-w-prose text-sm text-secondary">
            A resource has no stored credential until you add one — it will appear in the catalog with{' '}
            <span className="font-mono text-xs text-primary">No credential</span> and refuse connections until then.
          </p>
          <ReviewRow label="Name" value={v.name} />
          <ReviewRow label="Type" value={v.resource_type} />
          <ReviewRow label="Endpoint" value={v.host ? `${v.host}:${v.port}` : null} />
          <ReviewRow label="Database" value={v.database_name} />
          <ReviewRow label="Connect mode" value={v.connect_mode} />
          <ReviewRow label="Console URL" value={v.console_url} />
          <ReviewRow label="Elevation" value={v.requires_jit ? 'JIT required' : 'Standing access'} />
          <ReviewRow label="Recording" value={v.always_record ? 'Always recorded' : 'Not recorded'} />
          <ReviewRow label="Extra config" value={v.extra_config ? <span className="font-mono text-xs">{v.extra_config}</span> : null} />
        </div>
      )}
    </Dialog>
  )
}

// ── Create role / policy ──────────────────────────────────────────────────
export function CreateRoleDialog({ open, onClose, onDone }) {
  const [v, setV] = useState({ name: '', description: '' })
  const err = !v.name.trim() ? null : /[^a-z0-9-]/.test(v.name) ? 'Lower-case letters, numbers and hyphens.' : null
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="New role"
      description="A role is a bundle of policies. Attach the policies after it exists."
      footer={
        <>
          <Button variant="primary" size="lg" disabled={!v.name.trim() || !!err} onClick={() => onDone?.(v.name)}>Create role</Button>
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Meta className="ml-auto hidden sm:inline">POST /admin/rbac/roles</Meta>
        </>
      }
    >
      <FieldSet title="Definition">
        <Field label="Role name" htmlFor="rl-name" required error={err} hint="Rules and policies target this name, so it cannot be renamed later.">
          <input id="rl-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} className={clsx(inputClass, 'font-mono')} placeholder="db-operator" />
        </Field>
        <Field label="Description" htmlFor="rl-desc" hint="What someone holding this role is expected to do.">
          <textarea id="rl-desc" rows={3} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} className={textareaClass} />
        </Field>
      </FieldSet>
      <p className="mt-4 max-w-prose text-xs text-tertiary">
        A new role grants nothing until a policy is attached to it. MFA rules also target a role — check{' '}
        <span className="font-mono text-primary">MFA Policy</span> after creating one.
      </p>
    </Dialog>
  )
}

const COMMON_ACTIONS = [
  'pam:resource:List', 'pam:resource:Read', 'pam:resource:Connect',
  'pam:session:Start', 'pam:session:End',
  'pam:vault:List', 'pam:vault:Read', 'pam:vault:Reveal', 'pam:vault:Rotate',
  'pam:jit:Request', 'pam:jit:Cancel',
  'pam:audit:Read', 'pam:report:Generate',
]

export function CreatePolicyDialog({ open, onClose, onDone }) {
  const [v, setV] = useState({ name: '', description: '', effect: 'allow', actions: [], resources: ['*'] })
  const toggle = (a) => setV((s) => ({ ...s, actions: s.actions.includes(a) ? s.actions.filter((x) => x !== a) : [...s.actions, a] }))

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="New policy"
      description="An allow or deny rule over a set of actions and resources. A deny always beats an allow."
      footer={
        <>
          <Button variant="primary" size="lg" disabled={!v.name.trim() || v.actions.length === 0} onClick={() => onDone?.(v.name)}>Create policy</Button>
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Meta className="ml-auto hidden sm:inline">POST /admin/rbac/policies</Meta>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <FieldSet title="Definition">
          <Field label="Policy name" htmlFor="pl-name" required hint="Lower-case, hyphenated. Appears in the effective-access trail.">
            <input id="pl-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} className={clsx(inputClass, 'font-mono')} placeholder="analytics-read" />
          </Field>
          <Field label="Description" htmlFor="pl-desc">
            <textarea id="pl-desc" rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} className={textareaClass} />
          </Field>
        </FieldSet>

        <FieldSet title="Effect">
          <div className="flex gap-2">
            {['allow', 'deny'].map((eff) => (
              <button
                key={eff}
                type="button"
                onClick={() => setV({ ...v, effect: eff })}
                className={clsx(
                  'flex-1 rounded border px-3 py-2 text-left',
                  v.effect === eff ? 'border-line-strong bg-subtle' : 'border-line hover:bg-hover'
                )}
              >
                <span className="flex items-center gap-2">
                  <StatusDot tone={eff === 'deny' ? 'danger' : 'ok'} />
                  <span className="font-mono text-sm font-semibold uppercase text-primary">{eff}</span>
                </span>
                <span className="mt-1 block text-xs text-secondary">
                  {eff === 'allow' ? 'Grants these actions.' : 'Refuses them, overriding any allow.'}
                </span>
              </button>
            ))}
          </div>
        </FieldSet>

        <FieldSet title="Actions" hint={`${v.actions.length} selected. These are the action strings the policy engine matches.`}>
          <div className="flex flex-wrap gap-1">
            {COMMON_ACTIONS.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => toggle(a)}
                className={clsx(
                  'rounded border px-2 py-1 font-mono text-xs',
                  v.actions.includes(a) ? 'border-line-strong bg-subtle text-primary' : 'border-line text-tertiary hover:text-primary'
                )}
              >
                {a}
              </button>
            ))}
          </div>
        </FieldSet>

        <FieldSet title="Resources" hint="One per line. * matches everything.">
          <textarea
            rows={3}
            value={v.resources.join('\n')}
            onChange={(e) => setV({ ...v, resources: e.target.value.split('\n') })}
            className={clsx(textareaClass, 'font-mono text-xs')}
            aria-label="Resources, one per line"
          />
        </FieldSet>

        {/* The preview is the point: a policy is a document, and this is what
            it will read as on the Policies page. */}
        <div>
          <p className="mb-2 text-micro font-semibold uppercase text-tertiary">Resulting rules</p>
          <div className="max-h-32 overflow-auto rounded border border-line bg-subtle px-3 py-2">
            {v.actions.length === 0 ? (
              <p className="font-mono text-xs text-tertiary">Select at least one action.</p>
            ) : (
              v.actions.map((a) =>
                v.resources.filter(Boolean).map((r) => (
                  <p key={`${a}|${r}`} className="font-mono text-xs">
                    <span className={v.effect === 'deny' ? 'text-danger' : 'text-ok'}>{v.effect.toUpperCase()}</span>{' '}
                    <span className="text-primary">{a}</span> <span className="text-tertiary">ON</span>{' '}
                    <span className="text-primary">{r}</span>
                  </p>
                ))
              )
            )}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

// ── Vault: safe / folder / credential ─────────────────────────────────────
export function CreateSafeDialog({ open, onClose, onDone }) {
  const [v, setV] = useState({ name: '', description: '', retention_days: 365 })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="New safe"
      description="A safe holds credentials and sets how long their history is kept."
      footer={
        <>
          <Button variant="primary" size="lg" disabled={!v.name.trim()} onClick={() => onDone?.(v.name)}>Create safe</Button>
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Meta className="ml-auto hidden sm:inline">POST /pam/safes</Meta>
        </>
      }
    >
      <FieldSet title="Identity">
        <Field label="Name" htmlFor="sf-name" required hint="Unique across the vault.">
          <input id="sf-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} className={inputClass} placeholder="production" />
        </Field>
        <Field label="Description" htmlFor="sf-desc">
          <textarea id="sf-desc" rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} className={textareaClass} />
        </Field>
        <Field label="Retention (days)" htmlFor="sf-ret" hint="How long credential versions are kept after they are superseded.">
          <input id="sf-ret" inputMode="numeric" value={v.retention_days} onChange={(e) => setV({ ...v, retention_days: e.target.value })} className={clsx(inputClass, 'w-32 font-mono')} />
        </Field>
      </FieldSet>
    </Dialog>
  )
}

export function CreateFolderDialog({ open, onClose, safeId = 'safe-1', currentPath = '/', onDone }) {
  const [v, setV] = useState({ name: '', parent_folder_id: '' })
  const parent = folders.find((f) => f.id === v.parent_folder_id)
  const path = `${parent ? parent.path : ''}/${v.name || '…'}`.replace('//', '/')
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="New folder"
      description="Folders organise a safe. The path is what a credential is addressed by."
      footer={
        <>
          <Button variant="primary" size="lg" disabled={!v.name.trim()} onClick={() => onDone?.(v.name)}>Create folder</Button>
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Meta className="ml-auto hidden sm:inline">POST /pam/safes/:id/folders</Meta>
        </>
      }
    >
      <FieldSet title="Location">
        <Field label="Name" htmlFor="fd-name" required>
          <input id="fd-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} className={inputClass} placeholder="postgres" />
        </Field>
        <Field label="Parent folder" htmlFor="fd-parent" hint="Leave at the safe root for a top-level folder.">
          <select id="fd-parent" value={v.parent_folder_id} onChange={(e) => setV({ ...v, parent_folder_id: e.target.value })} className={selectClass}>
            <option value="">{safes.find((s) => s.id === safeId)?.name} (root)</option>
            {folders.filter((f) => f.safe_id === safeId).map((f) => (
              <option key={f.id} value={f.id}>{f.path}</option>
            ))}
          </select>
        </Field>
        <Field label="Resulting path" htmlFor="fd-path" hint="Read-only — the server derives it from the parent and the name.">
          <input id="fd-path" readOnly value={path} className={clsx(inputClass, 'font-mono text-tertiary')} />
        </Field>
      </FieldSet>
    </Dialog>
  )
}

export function CreateCredentialDialog({ open, onClose, safeId = 'safe-1', onDone }) {
  const [v, setV] = useState({
    name: '', account_name: '', credential_type: 'password', secret_plaintext: '',
    description: '', folder_id: '', rotation_interval_days: 30,
  })
  const [show, setShow] = useState(false)
  const ok = v.name.trim() && v.account_name.trim() && v.secret_plaintext

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="New credential"
      description="The secret is encrypted on arrival and never returned by a list endpoint."
      footer={
        <>
          <Button variant="primary" size="lg" disabled={!ok} onClick={() => onDone?.(v.name)}>Store credential</Button>
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Meta className="ml-auto hidden sm:inline">POST /pam/safes/:id/credentials</Meta>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <FieldSet title="What this is">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Name" htmlFor="cd-name" required hint="How it appears in the safe.">
              <input id="cd-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Account name" htmlFor="cd-acct" required hint="The account on the target system.">
              <input id="cd-acct" value={v.account_name} onChange={(e) => setV({ ...v, account_name: e.target.value })} className={clsx(inputClass, 'font-mono')} />
            </Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Type" htmlFor="cd-type" required>
              <select id="cd-type" value={v.credential_type} onChange={(e) => setV({ ...v, credential_type: e.target.value })} className={selectClass}>
                {CREDENTIAL_TYPES.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
              </select>
            </Field>
            <Field label="Folder" htmlFor="cd-folder" hint="Optional.">
              <select id="cd-folder" value={v.folder_id} onChange={(e) => setV({ ...v, folder_id: e.target.value })} className={selectClass}>
                <option value="">Safe root</option>
                {folders.filter((f) => f.safe_id === safeId).map((f) => <option key={f.id} value={f.id}>{f.path}</option>)}
              </select>
            </Field>
          </div>
        </FieldSet>

        <FieldSet title="Secret">
          <Field label="Secret value" htmlFor="cd-secret" required hint="Encrypted immediately. Revealing it later requires a reason and is audited.">
            {v.credential_type === 'ssh_key' || v.credential_type === 'kerberos_keytab' ? (
              <textarea id="cd-secret" rows={4} value={v.secret_plaintext} onChange={(e) => setV({ ...v, secret_plaintext: e.target.value })} className={clsx(textareaClass, 'font-mono text-xs')} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
            ) : (
              <div className="relative">
                <input
                  id="cd-secret"
                  type={show ? 'text' : 'password'}
                  value={v.secret_plaintext}
                  onChange={(e) => setV({ ...v, secret_plaintext: e.target.value })}
                  className={clsx(inputClass, 'pr-16 font-mono')}
                />
                <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
                  <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide secret' : 'Show secret'} className="flex h-7 w-7 items-center justify-center rounded text-tertiary hover:text-primary">
                    {show ? <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />}
                  </button>
                  <button type="button" onClick={() => setV({ ...v, secret_plaintext: 'jH4$mn2-Pq81_vTz' })} aria-label="Generate a strong value" className="flex h-7 w-7 items-center justify-center rounded text-tertiary hover:text-primary">
                    <Wand2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            )}
          </Field>
        </FieldSet>

        <FieldSet title="Rotation" hint="Zero means manual only. The scheduler reads this to set next_rotation_at.">
          <div className="flex flex-wrap gap-1">
            {[0, 30, 60, 90].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setV({ ...v, rotation_interval_days: d })}
                className={clsx(
                  'h-7 rounded border px-3 text-xs font-semibold',
                  v.rotation_interval_days === d ? 'border-line-strong bg-subtle text-primary' : 'border-line text-tertiary hover:text-primary'
                )}
              >
                {d === 0 ? 'Manual' : `${d} days`}
              </button>
            ))}
          </div>
        </FieldSet>
      </div>
    </Dialog>
  )
}

// ── JIT request (two variants) ────────────────────────────────────────────
const STANDARD_PRESETS = [15, 30, 60, 120, 240]
const BREAKGLASS_PRESETS = [15, 30, 60]

export function JitRequestDialog({ open, onClose, breakglass = false, onDone }) {
  const [v, setV] = useState({ resource_id: '', duration_minutes: breakglass ? 60 : 60, reason: '', action: '', ticket_ref: '' })
  const presets = breakglass ? BREAKGLASS_PRESETS : STANDARD_PRESETS
  const ok = v.resource_id && v.reason.trim().length >= 10
  const jitResources = resources.filter((r) => r.requires_jit && r.is_active)
  const standing = resources.filter((r) => !r.requires_jit && r.is_active)

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={breakglass ? 'Break-glass request' : 'Request access'}
      description={
        breakglass
          ? 'Emergency elevation. It does not wait for an approver — it waits out a mandatory cooling-off period, and everything you do under it is recorded.'
          : 'Time-boxed access. Two different administrators must approve, or root alone.'
      }
      footer={
        <>
          <Button variant={breakglass ? 'danger' : 'primary'} size="lg" disabled={!ok} onClick={() => onDone?.(v)}>
            {breakglass ? 'Raise break-glass request' : 'Submit request'}
          </Button>
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Meta className="ml-auto hidden sm:inline">{breakglass ? 'POST /pam/jit/breakglass' : 'POST /pam/jit/requests'}</Meta>
        </>
      }
    >
      {breakglass && (
        <div className="mb-4 flex items-start gap-3 rounded border border-danger/30 bg-danger-soft px-3 py-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-none text-danger" strokeWidth={1.75} />
          <p className="text-sm text-danger">
            A 15-minute cooling-off period runs before access starts. An administrator can deny it during that
            window. Every break-glass grant appears on the admin dashboard as an alarm while it is live.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-6">
        <FieldSet title="What you need">
          <Field label="Resource" htmlFor="jr-res" required hint="Only active resources can be requested.">
            <select id="jr-res" value={v.resource_id} onChange={(e) => setV({ ...v, resource_id: e.target.value })} className={selectClass}>
              <option value="">Choose…</option>
              <optgroup label="Requires just-in-time approval">
                {jitResources.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.resource_type}</option>)}
              </optgroup>
              <optgroup label="Standing access (a request is usually unnecessary)">
                {standing.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.resource_type}</option>)}
              </optgroup>
            </select>
          </Field>

          <Field label="Duration" htmlFor="jr-dur" hint={breakglass ? 'Break-glass is capped shorter than a standard request.' : 'Ask for the task, not the day. Long requests get denied.'}>
            <div className="flex flex-wrap gap-1">
              {presets.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setV({ ...v, duration_minutes: m })}
                  className={clsx(
                    'h-7 rounded border px-3 text-xs font-semibold tabular',
                    v.duration_minutes === m ? 'border-line-strong bg-subtle text-primary' : 'border-line text-tertiary hover:text-primary'
                  )}
                >
                  {m < 60 ? `${m}m` : `${m / 60}h`}
                </button>
              ))}
              <input
                id="jr-dur"
                inputMode="numeric"
                aria-label="Custom duration in minutes"
                value={v.duration_minutes}
                onChange={(e) => setV({ ...v, duration_minutes: e.target.value })}
                className={clsx(inputClass, 'h-7 w-20 font-mono')}
              />
            </div>
          </Field>
        </FieldSet>

        <FieldSet title="Why">
          <Field
            label="Justification"
            htmlFor="jr-reason"
            required
            hint="Approvers see this first, and it stays on the audit record. Ten characters minimum."
            error={v.reason.length > 0 && v.reason.trim().length < 10 ? 'Say what you are going to do, not just “access needed”.' : null}
          >
            <textarea id="jr-reason" rows={3} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} className={textareaClass} />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Action" htmlFor="jr-action" hint="Optional — narrows the grant, e.g. read.">
              <input id="jr-action" value={v.action} onChange={(e) => setV({ ...v, action: e.target.value })} className={clsx(inputClass, 'font-mono')} />
            </Field>
            <Field label="Ticket reference" htmlFor="jr-ticket" hint="Optional — links this to your change record.">
              <input id="jr-ticket" value={v.ticket_ref} onChange={(e) => setV({ ...v, ticket_ref: e.target.value })} className={clsx(inputClass, 'font-mono')} placeholder="OPS-4412" />
            </Field>
          </div>
        </FieldSet>
      </div>
    </Dialog>
  )
}

// ── Delegate admin (root only) ────────────────────────────────────────────
export function DelegateAdminDialog({ open, onClose, username, onDone }) {
  const [v, setV] = useState({ reason: '', expires_at: '', scope_resource_ids: '', replace_admin: false })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={`Delegate admin to ${username}`}
      description="Only a root account can do this. The grant is revocable and every part of it is audited."
      footer={
        <>
          <Button variant="primary" size="lg" disabled={!v.reason.trim()} onClick={() => onDone?.()}>Delegate admin</Button>
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Meta className="ml-auto hidden sm:inline">POST /admin/identity/users/:id/delegate-admin</Meta>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <FieldSet title="Justification">
          <Field label="Reason" htmlFor="da-reason" required hint="Written to the audit record. This is the question an auditor asks first.">
            <textarea id="da-reason" rows={3} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} className={textareaClass} />
          </Field>
        </FieldSet>
        <FieldSet title="Limits" hint="Both optional. An unbounded, unscoped admin delegation is the thing this form exists to discourage.">
          <Field label="Expires at" htmlFor="da-exp" hint="Leave empty for no expiry.">
            <input id="da-exp" type="datetime-local" value={v.expires_at} onChange={(e) => setV({ ...v, expires_at: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Scope to resource IDs" htmlFor="da-scope" hint="Comma-separated. Empty means org-wide.">
            <input id="da-scope" value={v.scope_resource_ids} onChange={(e) => setV({ ...v, scope_resource_ids: e.target.value })} className={clsx(inputClass, 'font-mono')} placeholder="res-01, res-03" />
          </Field>
        </FieldSet>
        <label className="flex cursor-pointer items-start gap-3 rounded border border-line px-3 py-3">
          <input type="checkbox" checked={v.replace_admin} onChange={(e) => setV({ ...v, replace_admin: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-primary">Replace an existing admin role</span>
            <span className="mt-1 block text-xs text-secondary">
              If this account already holds admin from outside the delegation system, bring it under this
              delegation so it can be revoked.
            </span>
          </span>
        </label>
      </div>
    </Dialog>
  )
}

// ── MFA rule editor ───────────────────────────────────────────────────────
const MODES = [
  ['off', 'No rule applies.'],
  ['monitor', 'Recorded, never blocked.'],
  ['grace', 'Allowed, with a deadline to enrol.'],
  ['enforce', 'Sign-in is refused without MFA.'],
]

export function MfaRuleDialog({ open, onClose, rule, atRisk = 0, onDone }) {
  const [mode, setMode] = useState(rule?.mode || 'monitor')
  const [grace, setGrace] = useState(rule?.grace_period_days ?? 14)
  const willLock = (mode === 'enforce') && atRisk > 0

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={`MFA rule for ${rule?.role_name || 'a role'}`}
      description="Everyone holding this role falls under the rule."
      footer={
        <>
          <Button variant={willLock ? 'danger' : 'primary'} size="lg" onClick={() => onDone?.(mode)}>
            {willLock ? `Save — locks out ${atRisk}` : 'Save rule'}
          </Button>
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Meta className="ml-auto hidden sm:inline">PUT /admin/mfa-policy/rules/:role</Meta>
        </>
      }
    >
      <FieldSet title="Mode">
        <div className="flex flex-col gap-1">
          {MODES.map(([m, copy]) => (
            <label
              key={m}
              className={clsx(
                'flex cursor-pointer items-start gap-3 rounded border px-3 py-2',
                mode === m ? 'border-line-strong bg-subtle' : 'border-line hover:bg-hover'
              )}
            >
              <input type="radio" name="mfa-mode" checked={mode === m} onChange={() => setMode(m)} className="mt-1 h-3.5 w-3.5 accent-[rgb(var(--accent))]" />
              <span className="min-w-0">
                <span className="block font-mono text-sm font-semibold text-primary">{m}</span>
                <span className="mt-0.5 block text-xs text-secondary">{copy}</span>
              </span>
            </label>
          ))}
        </div>
      </FieldSet>

      {mode === 'grace' && (
        <div className="mt-4">
          <Field label="Grace period (days)" htmlFor="mr-grace" hint="After this, the rule behaves as enforce.">
            <input id="mr-grace" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} className={clsx(inputClass, 'w-24 font-mono')} />
          </Field>
        </div>
      )}

      {/* The impact preview, at the point of the decision — Entra's pattern.
          The data is real: GET /admin/mfa-policy/compliance already returns it. */}
      {willLock && (
        <div className="mt-4 flex items-start gap-3 rounded border border-danger/30 bg-danger-soft px-3 py-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-none text-danger" strokeWidth={1.75} />
          <p className="text-sm text-danger">
            {atRisk} account{atRisk === 1 ? '' : 's'} holding this role has no enrolled device. Saving this signs
            them out and keeps them out until they enrol — and they cannot enrol without signing in.
          </p>
        </div>
      )}
    </Dialog>
  )
}

// ── Reveal a credential ───────────────────────────────────────────────────
// The single most sensitive surface in the product. Three states in one
// dialog: ask (reason required) → revealed (plaintext + expiry countdown) →
// expired. The consequence is stated before the action, not after.
export function RevealDialog({ open, onClose, credential }) {
  const [reason, setReason] = useState('')
  const [state, setState] = useState('ask')
  const [left, setLeft] = useState(60)

  const cred = credential || credentials[0]

  const doReveal = () => {
    setState('revealed')
    setLeft(60)
    const t = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          clearInterval(t)
          setState('expired')
          return 0
        }
        return s - 1
      })
    }, 1000)
  }

  const close = () => {
    setState('ask')
    setReason('')
    onClose?.()
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      size="md"
      title={`Reveal ${cred.name}`}
      description={`${cred.credential_type} for ${cred.account_name}`}
      footer={
        state === 'ask' ? (
          <>
            <Button variant="primary" size="lg" disabled={reason.trim().length === 0} onClick={doReveal}>Reveal secret</Button>
            <Button size="lg" onClick={close}>Cancel</Button>
            <Meta className="ml-auto hidden sm:inline">POST /pam/credentials/:id/reveal</Meta>
          </>
        ) : (
          <Button size="lg" onClick={close}>Done</Button>
        )
      }
    >
      {state === 'ask' && (
        <>
          {cred.is_breakglass && (
            <div className="mb-4 flex items-start gap-3 rounded border border-danger/30 bg-danger-soft px-3 py-3">
              <ShieldAlert className="mt-0.5 h-4 w-4 flex-none text-danger" strokeWidth={1.75} />
              <p className="text-sm text-danger">{cred.breakglass_note}</p>
            </div>
          )}
          <p className="max-w-prose text-base text-secondary">
            This writes <span className="font-mono text-sm text-primary">pam:vault:Reveal</span> to the audit log
            with your identity, this reason and the time. It requires MFA to have been verified on this session.
            The plaintext is returned once and expires.
          </p>
          <div className="mt-4">
            <Field label="Reason" htmlFor="rv-reason" required hint="Someone will read this during an access review.">
              <textarea id="rv-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={textareaClass} />
            </Field>
          </div>
        </>
      )}

      {state === 'revealed' && (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-micro font-semibold uppercase text-tertiary">Secret</p>
            <span className={clsx('text-xs tabular', left <= 15 ? 'text-danger' : 'text-warn')}>
              expires in {left}s
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 rounded border border-line bg-subtle px-3 py-3">
            <code className="min-w-0 flex-1 truncate font-mono text-sm text-primary">jH4$mn2-Pq81_vTz</code>
            <Button size="sm">Copy</Button>
          </div>
          {/* A real progress bar for a real deadline — not decoration. */}
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
            <div
              className={clsx('h-full rounded-full transition-[width] duration-1000 ease-linear', left <= 15 ? 'bg-danger' : 'bg-warn')}
              style={{ width: `${(left / 60) * 100}%` }}
            />
          </div>
          <p className="mt-4 max-w-prose text-sm text-secondary">
            This view will not be shown again. Reveal it a second time and that is a second audit entry.
          </p>
        </>
      )}

      {state === 'expired' && (
        <div className="py-6 text-center">
          <p className="text-base font-semibold text-primary">The reveal has expired</p>
          <p className="mt-1 text-sm text-secondary">Close this and reveal again if you still need it.</p>
        </div>
      )}
    </Dialog>
  )
}
