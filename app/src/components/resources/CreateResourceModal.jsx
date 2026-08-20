import { useCallback, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import clsx from 'clsx'
import { Boxes, Check, ChevronLeft, ChevronRight, KeyRound, Radio, Terminal } from 'lucide-react'
import { createResource } from '../../api/adminResources'
import { RESOURCE_TYPES, CONNECT_MODES } from '../../config/constants'
import { Field, inputClass, selectClass } from '../common/FormFields'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { Checkbox } from '../common/Checkbox'
import { ResourceTypeIcon } from './ResourceTypeIcon'
import { apiErrorMessage } from '../../lib/apiError'

// ---------------------------------------------------------------------------
// Register a resource.
// ---------------------------------------------------------------------------
// The same eleven fields, the same zod schema, the same single POST, but
// staged into the three decisions an operator actually makes (what is it,
// how do we reach it, how is access governed) with a review step before the
// write. Registering a privileged system is a consequential action; a flat
// stack of eleven inputs invites you to tab through it without reading.
//
// Validation is per-step via react-hook-form's trigger(), so you can't carry
// a bad host into the access step and discover it at the end.

const schema = z.object({
  name: z.string().trim().min(1, 'Required').max(255),
  description: z.string().optional(),
  resource_type: z.string().min(1, 'Select a resource type'),
  host: z.string().trim().min(1, 'Required'),
  // react-hook-form gives us a string from the input; coerce here rather
  // than trusting the browser's <input type="number"> (which can still
  // submit an empty string, "e", or "-" on some browsers/keyboards).
  port: z.coerce
    .number({ invalid_type_error: 'Port must be a number' })
    .int('Port must be a whole number')
    .min(1, 'Port must be between 1 and 65535')
    .max(65535, 'Port must be between 1 and 65535'),
  database_name: z.string().optional(),
  connect_mode: z.string().optional(),
  console_url: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\//.test(v), 'Must start with http:// or https://'),
  extra_config: z
    .string()
    .optional()
    .refine((v) => {
      if (!v || v.trim() === '') return true
      try {
        JSON.parse(v)
        return true
      } catch {
        return false
      }
    }, 'Must be valid JSON'),
  requires_jit: z.boolean().optional(),
  always_record: z.boolean().optional(),
})

const STEPS = [
  { key: 'identity', label: 'Identity', fields: ['name', 'resource_type', 'description'] },
  {
    key: 'connection',
    label: 'Connection',
    fields: ['host', 'port', 'database_name', 'connect_mode', 'console_url', 'extra_config'],
  },
  { key: 'access', label: 'Access', fields: ['requires_jit', 'always_record'] },
]

// Common defaults, so the port field isn't a memory test. Selecting a type
// pre-fills it; typing over the suggestion always wins.
const DEFAULT_PORTS = {
  postgresql: 5432,
  mongodb: 27017,
  redis: 6379,
  clickhouse: 8123,
  minio: 9000,
  qdrant: 6333,
  metabase: 3000,
  langfuse: 3000,
  oracle: 1521,
  web: 443,
}

function StepRail({ step }) {
  return (
    <ol className="mb-6 flex items-center gap-2">
      {STEPS.map((s, i) => {
        const done = i < step
        const current = i === step
        return (
          <li key={s.key} className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={clsx(
                'flex h-6 w-6 flex-none items-center justify-center rounded-full text-2xs font-semibold ring-1 ring-inset transition-colors',
                done && 'bg-blue-600 text-white ring-blue-500/50',
                current &&
                  'bg-blue-50 text-blue-700 ring-blue-600/30 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-400/30',
                !done && !current && 'bg-surface-800 text-ink-500 ring-surface-700'
              )}
            >
              {done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
            </span>
            <span
              className={clsx(
                'truncate text-xs font-medium transition-colors',
                current ? 'text-ink-50' : done ? 'text-ink-300' : 'text-ink-500'
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="h-px min-w-4 flex-1 bg-surface-700" aria-hidden="true" />
            )}
          </li>
        )
      })}
    </ol>
  )
}

function ReviewRow({ label, value }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-4 border-t border-surface-800 px-3.5 py-2 first:border-t-0">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="min-w-0 break-words text-xs font-medium text-ink-100">{value || '-'}</dd>
    </div>
  )
}

export function CreateResourceModal({ open, onClose }) {
  const queryClient = useQueryClient()
  const [step, setStep] = useState(0)

  const {
    register,
    handleSubmit,
    reset,
    watch,
    trigger,
    setValue,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { connect_mode: 'web_terminal', requires_jit: false, always_record: false },
  })

  // Watches every field, so this component re-renders on every keystroke ,
  // necessary, because the review step and the default-port logic both read
  // live values.
  const values = watch()
  const isReview = step === STEPS.length

  // MUST be memoized. `close` is handed to <Modal onClose>, and an unmemoized
  // version is a new function identity on every one of those keystroke
  // re-renders. Modal used to key its open-effect on that identity, so the
  // effect re-ran per keystroke and pulled focus back to the first field
  // mid-typing, the "I'm typing in field three and it jumps to field one"
  // bug. Modal is now hardened against this independently (see its header
  // comment), but a handler passed to a dialog should be stable regardless.
  const close = useCallback(() => {
    reset()
    setStep(0)
    onClose()
  }, [reset, onClose])

  const mutation = useMutation({
    mutationFn: createResource,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources'] })
      toast.success('Resource registered')
      close()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const next = async () => {
    const ok = await trigger(STEPS[step].fields)
    if (ok) setStep((s) => s + 1)
  }

  const typeLabel = RESOURCE_TYPES.find((t) => t.value === values.resource_type)?.label
  const modeLabel = CONNECT_MODES.find((m) => m.value === values.connect_mode)?.label

  return (
    <Modal
      open={open}
      onClose={close}
      size="xl"
      icon={Boxes}
      title="Register a resource"
      description="Make a system available for brokered, audited access."
      busy={mutation.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          {step > 0 && (
            <Button
              variant="secondary"
              icon={ChevronLeft}
              onClick={() => setStep((s) => s - 1)}
              disabled={mutation.isPending}
            >
              Back
            </Button>
          )}
          {isReview ? (
            <Button
              variant="primary"
              icon={Check}
              loading={mutation.isPending}
              onClick={handleSubmit((v) => mutation.mutate(v))}
            >
              Register resource
            </Button>
          ) : (
            <Button variant="primary" iconRight={ChevronRight} onClick={next}>
              Continue
            </Button>
          )}
        </>
      }
    >
      <StepRail step={step} />

      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate>
        {step === 0 && (
          <div className="space-y-4">
            <Field
              label="Name"
              error={errors.name?.message}
              required
              htmlFor="res-name"
              hint="How this system appears in the catalogue, requests and audit trail."
            >
              <input
                id="res-name"
                className={inputClass(!!errors.name)}
                placeholder="prod-analytics-primary"
                {...register('name')}
              />
            </Field>

            <Field label="Resource type" error={errors.resource_type?.message} required htmlFor="res-type">
              <select
                id="res-type"
                className={selectClass(!!errors.resource_type)}
                {...register('resource_type', {
                  onChange: (e) => {
                    const port = DEFAULT_PORTS[e.target.value]
                    if (port && !values.port) setValue('port', port)
                  },
                })}
              >
                <option value="">Select…</option>
                {RESOURCE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Description"
              hint="Optional. What this system is for, and who owns it."
              htmlFor="res-desc"
            >
              <textarea id="res-desc" rows={2} className={inputClass(false)} {...register('description')} />
            </Field>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Field label="Host" error={errors.host?.message} required htmlFor="res-host">
                  <input
                    id="res-host"
                    className={inputClass(!!errors.host) + ' font-mono'}
                    placeholder="db.internal.example.com"
                    {...register('host')}
                  />
                </Field>
              </div>
              <Field label="Port" error={errors.port?.message} required htmlFor="res-port">
                <input
                  id="res-port"
                  inputMode="numeric"
                  className={inputClass(!!errors.port) + ' font-mono tabular-nums'}
                  {...register('port')}
                />
              </Field>
            </div>

            <Field
              label="Database name"
              hint="Optional. Only meaningful for database resources."
              htmlFor="res-db"
            >
              <input
                id="res-db"
                className={inputClass(false) + ' font-mono'}
                {...register('database_name')}
              />
            </Field>

            <Field label="Connect mode" htmlFor="res-mode">
              <select id="res-mode" className={selectClass(false)} {...register('connect_mode')}>
                {CONNECT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Console URL"
              error={errors.console_url?.message}
              htmlFor="res-url"
              hint={
                values.connect_mode === 'embed_redirect'
                  ? 'Required for embed/redirect mode, the target opened when a user connects.'
                  : 'Optional, shown as a shortcut link if set.'
              }
            >
              <input
                id="res-url"
                className={inputClass(!!errors.console_url) + ' font-mono'}
                placeholder="https://…"
                {...register('console_url')}
              />
            </Field>

            <Field
              label="Extra config (JSON)"
              error={errors.extra_config?.message}
              htmlFor="res-extra"
              hint="Optional protocol-specific settings, as a JSON object."
            >
              <textarea
                id="res-extra"
                rows={3}
                className={inputClass(!!errors.extra_config) + ' font-mono'}
                placeholder="{}"
                {...register('extra_config')}
              />
            </Field>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            {/* Policy choices read as decisions with consequences, not as two
 unlabelled checkboxes at the bottom of a form. */}
            <label
              className={clsx(
                'flex cursor-pointer gap-3.5 rounded-xl border p-4 transition-colors',
                values.requires_jit
                  ? 'border-amber-500/45 bg-amber-50/70 dark:bg-amber-950/20'
                  : 'border-surface-700 bg-surface-850 hover:border-surface-600'
              )}
            >
              <Checkbox
                checked={!!values.requires_jit}
                onChange={(v) => setValue('requires_jit', v)}
                srLabel="Require JIT approval"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-semibold text-ink-50">
                  <KeyRound
                    className="h-4 w-4 flex-none text-amber-600 dark:text-amber-400"
                    strokeWidth={1.75}
                  />
                  Require just-in-time approval
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-ink-400">
                  No standing access. Users must raise a request and hold an approved, time-boxed grant before
                  this resource will broker a session.
                </span>
              </span>
            </label>

            <label
              className={clsx(
                'flex cursor-pointer gap-3.5 rounded-xl border p-4 transition-colors',
                values.always_record
                  ? 'border-purple-500/45 bg-purple-50/70 dark:bg-purple-950/20'
                  : 'border-surface-700 bg-surface-850 hover:border-surface-600'
              )}
            >
              <Checkbox
                checked={!!values.always_record}
                onChange={(v) => setValue('always_record', v)}
                srLabel="Always record sessions"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-semibold text-ink-50">
                  <Radio
                    className="h-4 w-4 flex-none text-purple-600 dark:text-purple-400"
                    strokeWidth={1.75}
                  />
                  Always record sessions
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-ink-400">
                  Recording is never optional for this resource, regardless of what an individual request asks
                  for.
                </span>
              </span>
            </label>

            <p className="px-1 pt-1 text-xs leading-relaxed text-ink-500">
              A credential can be attached after registration, from the resource&apos;s Credentials tab.
            </p>
          </div>
        )}

        {isReview && (
          <div>
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-surface-700 bg-surface-850 px-3.5 py-3">
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-900">
                <ResourceTypeIcon type={values.resource_type} className="h-[1.05rem] w-[1.05rem]" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink-50">
                  {values.name || 'Unnamed resource'}
                </p>
                <p className="truncate font-mono text-xs text-ink-500">
                  {values.host}:{values.port}
                </p>
              </div>
            </div>

            <dl className="rounded-xl border border-surface-700 bg-surface-900">
              <ReviewRow label="Type" value={typeLabel} />
              <ReviewRow label="Description" value={values.description} />
              <ReviewRow label="Database" value={values.database_name} />
              <ReviewRow label="Connect mode" value={modeLabel} />
              <ReviewRow label="Console URL" value={values.console_url} />
              <ReviewRow
                label="Elevation"
                value={
                  values.requires_jit ? (
                    <span className="text-amber-700 dark:text-amber-300">Approved JIT request required</span>
                  ) : (
                    'Standing access'
                  )
                }
              />
              <ReviewRow
                label="Recording"
                value={
                  values.always_record ? (
                    <span className="text-purple-700 dark:text-purple-300">Always recorded</span>
                  ) : (
                    'Per session policy'
                  )
                }
              />
              <ReviewRow
                label="Extra config"
                value={values.extra_config ? <span className="font-mono">{values.extra_config}</span> : null}
              />
            </dl>

            <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-ink-500">
              <Terminal className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
              Registration is written to the audit chain. The resource becomes browsable immediately; it will
              only broker sessions once a credential is attached.
            </p>
          </div>
        )}
      </form>
    </Modal>
  )
}
