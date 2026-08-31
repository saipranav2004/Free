import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, ShieldCheck, KeyRound, Radio } from 'lucide-react'
import { toast } from 'sonner'
import { updateResource } from '../../api/adminResources'
import { apiErrorMessage } from '../../lib/apiError'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { Field, inputClass, selectClass } from '../common/FormFields'
import { DataProtectionFields, ToggleCard, BROKERED_ONLY } from './DataProtectionFields'
import { CONNECT_MODES } from '../../config/constants'

// ---------------------------------------------------------------------------
// Edit a registered resource
// ---------------------------------------------------------------------------
// Every setting that could previously only be changed with a hand-written
// PATCH: connection details, access policy, and the data-protection controls.
//
// WHY THIS SENDS A DIFF RATHER THAN THE WHOLE OBJECT. The endpoint is a PATCH
// and writes only the keys it receives. Posting every field on every save
// would mean a value the operator never looked at silently overwriting a
// change someone else made since this form loaded — the classic last-writer-
// wins edit. So the payload is built by comparing against the values the form
// opened with, and an untouched field is simply absent.
//
// The empty string is a real value for two of these fields, not "unset":
// clearing console_url means "this resource has no web console", and clearing
// denied_commands means "use the built-in patterns for this resource type".
// That is why the diff compares against the initial value instead of testing
// for truthiness.

// Byte presets rather than a raw number field: nobody should be typing
// 52428800, and a free-text byte count invites an off-by-1000 that silently
// makes the cap useless.
function toForm(r) {
  return {
    name: r?.name ?? '',
    description: r?.description ?? '',
    host: r?.host ?? '',
    port: String(r?.port ?? ''),
    database_name: r?.database_name ?? '',
    connect_mode: r?.connect_mode ?? 'web_terminal',
    console_url: r?.console_url ?? '',
    extra_config: r?.extra_config ?? '',
    is_active: Boolean(r?.is_active),
    requires_jit: Boolean(r?.requires_jit),
    always_record: Boolean(r?.always_record),
    block_clipboard: Boolean(r?.block_clipboard),
    block_devtools: Boolean(r?.block_devtools),
    block_download: Boolean(r?.block_download),
    watermark: Boolean(r?.watermark),
    max_egress_bytes: Number(r?.max_egress_bytes ?? 0),
    denied_commands: r?.denied_commands ?? '',
    brokered_only: String(r?.allowed_connect_methods ?? '').includes('web_proxy'),
  }
}

// Built once from the values the form opened with, so an untouched field never
// appears in the payload. Numbers are compared numerically because the port
// input hands back a string.
function buildPatch(initial, current) {
  const patch = {}
  const stringFields = ['name', 'description', 'host', 'database_name', 'connect_mode', 'console_url', 'extra_config', 'denied_commands']
  for (const key of stringFields) {
    if (current[key] !== initial[key]) patch[key] = current[key]
  }
  const boolFields = [
    'is_active',
    'requires_jit',
    'always_record',
    'block_clipboard',
    'block_devtools',
    'block_download',
    'watermark',
  ]
  for (const key of boolFields) {
    if (current[key] !== initial[key]) patch[key] = current[key]
  }
  if (Number(current.port) !== Number(initial.port)) patch.port = Number(current.port)
  if (Number(current.max_egress_bytes) !== Number(initial.max_egress_bytes)) {
    patch.max_egress_bytes = Number(current.max_egress_bytes)
  }
  // brokered_only is a UI-level control over allowed_connect_methods: an
  // administrator should not have to compose a CSV of internal method names
  // when the only meaningful choice is whether this may be opened outside the
  // broker.
  if (current.brokered_only !== initial.brokered_only) {
    patch.allowed_connect_methods = current.brokered_only ? BROKERED_ONLY : ''
  }
  return patch
}

function validate(v) {
  const errors = {}
  if (!v.name.trim()) errors.name = 'Required'
  if (!v.host.trim()) errors.host = 'Required'
  const port = Number(v.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'Port must be between 1 and 65535'
  if (v.extra_config.trim()) {
    try {
      JSON.parse(v.extra_config)
    } catch {
      errors.extra_config = 'Must be valid JSON'
    }
  }
  if (v.console_url.trim() && !/^https?:\/\//i.test(v.console_url.trim())) {
    errors.console_url = 'Must start with http:// or https://'
  }
  return errors
}

export function EditResourceModal({ open, onClose, resource }) {
  const queryClient = useQueryClient()
  const initial = useMemo(() => toForm(resource), [resource])
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState({})

  // Re-seed when a different resource is opened, or when the underlying record
  // is refetched — otherwise the form would keep editing a stale snapshot.
  useEffect(() => {
    if (open) {
      setValues(initial)
      setErrors({})
    }
  }, [open, initial])

  const set = (key) => (value) => setValues((v) => ({ ...v, [key]: value }))

  const patch = useMemo(() => buildPatch(initial, values), [initial, values])
  const changedCount = Object.keys(patch).length

  const mutation = useMutation({
    mutationFn: () => updateResource(resource.id, patch),
    onSuccess: () => {
      toast.success(changedCount === 1 ? '1 change saved' : `${changedCount} changes saved`)
      // Both the detail record and any list that shows this resource.
      queryClient.invalidateQueries({ queryKey: ['resource', resource.id] })
      queryClient.invalidateQueries({ queryKey: ['resources'] })
      queryClient.invalidateQueries({ queryKey: ['resource', resource.id, 'connect-info'] })
      onClose?.()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const submit = (e) => {
    e.preventDefault()
    const found = validate(values)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    if (changedCount === 0) {
      toast.info('Nothing to save — no fields changed.')
      return
    }
    mutation.mutate()
  }


  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit resource"
      description={resource?.name}
      icon={Pencil}
      size="lg"
      busy={mutation.isPending}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-xs text-ink-500">
            {changedCount === 0
              ? 'No changes yet'
              : `${changedCount} field${changedCount === 1 ? '' : 's'} will be updated`}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              loading={mutation.isPending}
              disabled={changedCount === 0}
            >
              Save changes
            </Button>
          </div>
        </div>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-6">
        {/* ── Identity ─────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Field label="Name" error={errors.name} required htmlFor="edit-name"
                 hint="How this system appears in the catalogue, requests and audit trail.">
            <input id="edit-name" className={inputClass(!!errors.name)}
                   value={values.name} onChange={(e) => set('name')(e.target.value)} />
          </Field>

          <Field label="Description" htmlFor="edit-desc">
            <textarea id="edit-desc" rows={2} className={inputClass(false)}
                      value={values.description} onChange={(e) => set('description')(e.target.value)} />
          </Field>

          {/* Type is deliberately read-only: it decides the connector, the
              command deny list and the launch templates, so changing it on a
              live resource would silently repoint all three. Re-register
              instead. */}
          <Field label="Resource type" hint="Fixed after registration — it determines the connector and launch templates.">
            <input className={inputClass(false) + ' font-mono opacity-60'} value={resource?.resource_type ?? ''} readOnly />
          </Field>
        </div>

        {/* ── Connection ───────────────────────────────────────────────── */}
        <div className="border-t border-surface-800 pt-5 space-y-4">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-500">Connection</p>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Host" error={errors.host} required htmlFor="edit-host">
                <input id="edit-host" className={inputClass(!!errors.host) + ' font-mono'}
                       value={values.host} onChange={(e) => set('host')(e.target.value)} />
              </Field>
            </div>
            <Field label="Port" error={errors.port} required htmlFor="edit-port">
              <input id="edit-port" inputMode="numeric"
                     className={inputClass(!!errors.port) + ' font-mono tabular-nums'}
                     value={values.port} onChange={(e) => set('port')(e.target.value)} />
            </Field>
          </div>

          <Field label="Database name" htmlFor="edit-db" hint="Optional — for engines where a connection targets one database.">
            <input id="edit-db" className={inputClass(false) + ' font-mono'}
                   value={values.database_name} onChange={(e) => set('database_name')(e.target.value)} />
          </Field>

          <Field label="Connect mode" htmlFor="edit-mode"
                 hint="How the in-browser path presents this resource.">
            <select id="edit-mode" className={selectClass(false)}
                    value={values.connect_mode} onChange={(e) => set('connect_mode')(e.target.value)}>
              {CONNECT_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </Field>

          <Field
            label="Console URL"
            error={errors.console_url}
            htmlFor="edit-console"
            hint="The web console PAM signs in to and proxies. Must be the CONSOLE port — for MinIO that is 9001, not the 9000 S3 API port. Clear it to remove browser access."
          >
            <input id="edit-console" className={inputClass(!!errors.console_url) + ' font-mono'}
                   placeholder="http://10.0.0.5:9001"
                   value={values.console_url} onChange={(e) => set('console_url')(e.target.value)} />
          </Field>

          <Field label="Extra config" error={errors.extra_config} htmlFor="edit-extra"
                 hint="JSON passed to the connector — auth strategy, login field names, TLS options.">
            <textarea id="edit-extra" rows={3} className={inputClass(!!errors.extra_config) + ' font-mono text-xs'}
                      placeholder='{"web_auth_strategy":"minio_console"}'
                      value={values.extra_config} onChange={(e) => set('extra_config')(e.target.value)} />
          </Field>
        </div>

        {/* ── Access ───────────────────────────────────────────────────── */}
        <div className="border-t border-surface-800 pt-5 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-500">Access</p>

          <ToggleCard
            checked={values.is_active}
            onChange={set('is_active')}
            icon={ShieldCheck}
            title="Active"
            tone="emerald"
            description="Inactive resources stay in the catalogue and the audit trail but refuse every new session."
          />
          <ToggleCard
            checked={values.requires_jit}
            onChange={set('requires_jit')}
            icon={KeyRound}
            title="Require just-in-time approval"
            tone="amber"
            description="No standing access. Users must hold an approved, time-boxed grant before this resource will broker a session."
          />
          <ToggleCard
            checked={values.always_record}
            onChange={set('always_record')}
            icon={Radio}
            title="Always record sessions"
            tone="purple"
            description="Recording is never optional for this resource, whatever an individual request asks for."
          />
        </div>

        <DataProtectionFields values={values} set={set} />

      </form>
    </Modal>
  )
}
