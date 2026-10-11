import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  FileKey2,
  Plus,
  Check,
  X,
  Search,
  ShieldCheck,
  ShieldX,
  AlertTriangle,
  Globe,
  Info,
} from 'lucide-react'
import clsx from 'clsx'
import { createPolicy } from '../../api/rbac'
import { listResources } from '../../api/resources'
import { COMMON_ACTIONS } from '../../config/constants'
import { Modal } from '../common/Modal'
import { Field, inputClass, FieldSet } from '../common/FormFields'
import { Button } from '../common/Button'
import { apiErrorMessage } from '../../lib/apiError'
import { policyNameRules } from '../../lib/validators'

// ---------------------------------------------------------------------------
// Create policy
// ---------------------------------------------------------------------------
// The old form was two free-text boxes holding comma-separated strings, which
// put the burden of knowing both the action vocabulary AND the resource ARN
// format on the person filling it in. This is a builder instead:
//
//   Effect two mutually exclusive cards, because allow vs deny is the
// single most consequential choice on the form and a <select>
// hides it among four other fields.
//   Actions the catalogue grouped by service, click to toggle, with a
// free-text escape hatch for actions not in the catalogue ,
// the server, not this list, is the source of truth.
//   Resources pick real resources by name; the `pam:resource/<uuid>` string
// the engine actually matches on is built for you. That format
// is undiscoverable without reading backend source.
//
// Selections render as removable chips, so what the policy WILL contain is
// visible at all times rather than encoded in a comma-separated string.

const ALL_RESOURCES = '*'

function resourcePattern(id) {
  return `pam:resource/${id}`
}

// Catalogue grouped by the segment between the two colons, pam:vault:Reveal
// groups under "vault". Derived rather than hardcoded so adding an action to
// COMMON_ACTIONS needs no change here.
function groupActions(actions) {
  const groups = new Map()
  for (const a of actions) {
    const parts = a.split(':')
    const key = parts.length >= 3 ? parts[1] : 'other'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(a)
  }
  return [...groups.entries()].map(([key, items]) => ({ key, items }))
}

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'A policy name is required')
    .refine(policyNameRules.test, policyNameRules.message),
  description: z.string().trim().max(500, 'Keep it under 500 characters').optional(),
  effect: z.enum(['allow', 'deny']),
})

function Chip({ label, onRemove, mono, tone = 'default' }) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-full items-center gap-1.5 rounded-lg border py-1 pl-2.5 pr-1 text-xs font-medium',
        tone === 'blue'
          ? 'border-blue-500/40 bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-200'
          : 'border-surface-700 bg-surface-850 text-ink-200'
      )}
    >
      <span className={clsx('min-w-0 truncate', mono && 'font-mono')}>{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="flex h-4 w-4 flex-none items-center justify-center rounded text-ink-500 transition-colors hover:bg-surface-700 hover:text-ink-100"
      >
        <X className="h-3 w-3" strokeWidth={2.5} />
      </button>
    </span>
  )
}

export function CreatePolicyModal({ open, onClose }) {
  const queryClient = useQueryClient()
  const [actions, setActions] = useState([])
  const [resources, setResources] = useState([])
  const [customAction, setCustomAction] = useState('')
  const [resourceFilter, setResourceFilter] = useState('')

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    mode: 'onBlur',
    defaultValues: { name: '', description: '', effect: 'allow' },
  })

  const effect = watch('effect')
  const name = watch('name') || ''

  // Resources are listable by any authenticated user (GET /pam/resources) ,
  // reuse that rather than adding an admin-only endpoint for one dropdown.
  const resourcesQuery = useQuery({
    queryKey: ['resources', 'for-policy-picker'],
    queryFn: ({ signal }) => listResources({ signal }),
    enabled: open,
  })

  useEffect(() => {
    if (open) {
      reset({ name: '', description: '', effect: 'allow' })
      setActions([])
      setResources([])
      setCustomAction('')
      setResourceFilter('')
    }
  }, [open, reset])

  const available = resourcesQuery.data?.resources || []
  const visibleResources = useMemo(() => {
    const needle = resourceFilter.trim().toLowerCase()
    if (!needle) return available
    return available.filter(
      (r) => r.name?.toLowerCase().includes(needle) || r.resource_type?.toLowerCase().includes(needle)
    )
  }, [available, resourceFilter])

  const grouped = useMemo(() => groupActions(COMMON_ACTIONS), [])

  const mutation = useMutation({
    mutationFn: (values) =>
      createPolicy({
        name: values.name,
        description: values.description?.trim() || undefined,
        effect: values.effect,
        actions,
        resources,
      }),
    onSuccess: (policy) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'policies'] })
      toast.success(`Policy “${policy?.name || name}” created`)
      onClose()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const toggleAction = (a) =>
    setActions((list) => (list.includes(a) ? list.filter((x) => x !== a) : [...list, a]))

  const toggleResource = (pattern) =>
    setResources((list) => (list.includes(pattern) ? list.filter((x) => x !== pattern) : [...list, pattern]))

  const addCustomAction = () => {
    const v = customAction.trim()
    if (!v || actions.includes(v)) return
    setActions((list) => [...list, v])
    setCustomAction('')
  }

  // The submit guard is here rather than in zod because both lists live in
  // component state, not the form, a zod refine couldn't see them.
  const incomplete = actions.length === 0 || resources.length === 0

  const onSubmit = handleSubmit((values) => {
    if (incomplete) {
      toast.error(
        actions.length === 0
          ? 'Select at least one action, a policy with no actions matches nothing.'
          : 'Select at least one resource, a policy with no resources matches nothing.'
      )
      return
    }
    mutation.mutate(values)
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={FileKey2}
      title="Create a policy"
      description="A policy is one allow-or-deny rule over a set of actions and resources. Attach it to a role, or directly to an account."
      size="xl"
      busy={mutation.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            form="create-policy-form"
            type="submit"
            variant="primary"
            icon={Plus}
            loading={mutation.isPending}
          >
            Create policy
          </Button>
        </>
      }
    >
      <form id="create-policy-form" onSubmit={onSubmit} noValidate className="space-y-6">
        <FieldSet title="Definition">
          <Field
            label="Policy name"
            hint={policyNameRules.hint}
            error={errors.name?.message}
            required
            htmlFor="cp-name"
          >
            <input
              id="cp-name"
              autoComplete="off"
              spellCheck={false}
              placeholder="Read production databases"
              className={inputClass(!!errors.name)}
              {...register('name')}
            />
          </Field>

          <Field
            label="Description"
            hint="Why this rule exists. Auditors read this before they read the actions."
            error={errors.description?.message}
            htmlFor="cp-desc"
          >
            <textarea
              id="cp-desc"
              rows={2}
              placeholder="Allows on-call engineers to list and connect to production database resources."
              className={inputClass(!!errors.description)}
              {...register('description')}
            />
          </Field>
        </FieldSet>

        {/* Effect as two cards: the most consequential choice on the form
 should not be a dropdown row that reads like every other field. */}
        <FieldSet title="Effect">
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              {
                value: 'allow',
                label: 'Allow',
                icon: ShieldCheck,
                note: 'Grants the selected actions on the selected resources.',
              },
              {
                value: 'deny',
                label: 'Deny',
                icon: ShieldX,
                note: 'Blocks them, and beats any allow, from any other role.',
              },
            ].map((o) => {
              const active = effect === o.value
              const danger = o.value === 'deny'
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setValue('effect', o.value, { shouldValidate: true })}
                  aria-pressed={active}
                  className={clsx(
                    'flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors duration-150',
                    active
                      ? danger
                        ? 'border-red-500/50 bg-red-50 dark:bg-red-500/[0.09]'
                        : 'border-emerald-500/50 bg-emerald-50 dark:bg-emerald-500/[0.09]'
                      : 'border-surface-700 bg-surface-850 hover:border-surface-600'
                  )}
                >
                  <span
                    className={clsx(
                      'mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg',
                      active
                        ? danger
                          ? 'bg-red-600 text-white'
                          : 'bg-emerald-600 text-white'
                        : 'border border-surface-700 bg-surface-900 text-ink-500'
                    )}
                  >
                    <o.icon className="h-4 w-4" strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0">
                    <span
                      className={clsx(
                        'block text-sm font-semibold',
                        active
                          ? danger
                            ? 'text-red-700 dark:text-red-300'
                            : 'text-emerald-700 dark:text-emerald-300'
                          : 'text-ink-100'
                      )}
                    >
                      {o.label}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{o.note}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </FieldSet>

        <FieldSet
          title="Actions"
          description="What this rule covers. The catalogue is a convenience, the server validates action strings, so anything it accepts can be typed below."
        >
          {actions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {actions.map((a) => (
                <Chip key={a} label={a} mono tone="blue" onRemove={() => toggleAction(a)} />
              ))}
            </div>
          )}

          <div className="space-y-3 rounded-xl border border-surface-700 bg-surface-850/50 p-3">
            {grouped.map((g) => (
              <div key={g.key}>
                <p className="mb-1.5 text-xs font-semibold text-ink-500">{g.key}</p>
                <div className="flex flex-wrap gap-1.5">
                  {g.items.map((a) => {
                    const on = actions.includes(a)
                    return (
                      <button
                        key={a}
                        type="button"
                        onClick={() => toggleAction(a)}
                        aria-pressed={on}
                        className={clsx(
                          'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 font-mono text-xs transition-colors duration-150',
                          on
                            ? 'border-blue-500/50 bg-blue-600 text-white'
                            : 'border-surface-700 bg-surface-900 text-ink-300 hover:border-surface-600 hover:text-ink-100'
                        )}
                      >
                        {on && <Check className="h-3 w-3 flex-none" strokeWidth={3} />}
                        {a.split(':').slice(2).join(':') || a}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input
              value={customAction}
              onChange={(e) => setCustomAction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addCustomAction()
                }
              }}
              placeholder="pam:custom:Action"
              spellCheck={false}
              className={clsx(inputClass(false), 'font-mono')}
            />
            <Button
              type="button"
              size="md"
              variant="secondary"
              onClick={addCustomAction}
              disabled={!customAction.trim()}
            >
              Add
            </Button>
          </div>
        </FieldSet>

        <FieldSet
          title="Resources"
          description="Which resources the rule applies to. Picking by name builds the pam:resource/<id> pattern the policy engine matches on."
        >
          {resources.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {resources.map((r) => {
                const match = available.find((x) => resourcePattern(x.id) === r)
                return (
                  <Chip
                    key={r}
                    label={r === ALL_RESOURCES ? 'All resources (*)' : match?.name || r}
                    mono={r !== ALL_RESOURCES && !match}
                    tone="blue"
                    onRemove={() => toggleResource(r)}
                  />
                )
              })}
            </div>
          )}

          <div className="space-y-2 rounded-xl border border-surface-700 bg-surface-850/50 p-3">
            <button
              type="button"
              onClick={() => toggleResource(ALL_RESOURCES)}
              aria-pressed={resources.includes(ALL_RESOURCES)}
              className={clsx(
                'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150',
                resources.includes(ALL_RESOURCES)
                  ? 'border-blue-500/50 bg-blue-50 dark:bg-blue-500/[0.09]'
                  : 'border-surface-700 bg-surface-900 hover:border-surface-600'
              )}
            >
              <span
                className={clsx(
                  'flex h-7 w-7 flex-none items-center justify-center rounded-lg',
                  resources.includes(ALL_RESOURCES)
                    ? 'bg-blue-600 text-white'
                    : 'border border-surface-700 bg-surface-850 text-ink-500'
                )}
              >
                <Globe className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-100">All resources</span>
                <span className="block truncate font-mono text-2xs text-ink-500">*</span>
              </span>
            </button>

            {available.length > 6 && (
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-500"
                  strokeWidth={1.75}
                />
                <input
                  value={resourceFilter}
                  onChange={(e) => setResourceFilter(e.target.value)}
                  placeholder="Filter resources…"
                  className={clsx(inputClass(false), 'pl-9')}
                />
              </div>
            )}

            <div className="max-h-52 space-y-1 overflow-y-auto">
              {resourcesQuery.isLoading && (
                <p className="px-3 py-4 text-center text-xs text-ink-500">Loading resources…</p>
              )}
              {resourcesQuery.isError && (
                <p className="px-3 py-4 text-center text-xs text-red-600 dark:text-red-400">
                  Couldn&apos;t load resources, use “All resources” or add a pattern by hand.
                </p>
              )}
              {!resourcesQuery.isLoading && available.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-ink-500">
                  No resources registered yet, register one under Resources first.
                </p>
              )}
              {visibleResources.map((r) => {
                const pattern = resourcePattern(r.id)
                const on = resources.includes(pattern)
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => toggleResource(pattern)}
                    aria-pressed={on}
                    title={pattern}
                    className={clsx(
                      'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors duration-150',
                      on
                        ? 'border-blue-500/50 bg-blue-50 dark:bg-blue-500/[0.09]'
                        : 'border-transparent hover:bg-surface-800'
                    )}
                  >
                    <span
                      className={clsx(
                        'flex h-4 w-4 flex-none items-center justify-center rounded border transition-colors',
                        on ? 'border-blue-600 bg-blue-600 text-white' : 'border-surface-600 bg-surface-900'
                      )}
                    >
                      {on && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink-100">{r.name}</span>
                      <span className="block truncate text-2xs text-ink-500">{r.resource_type}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </FieldSet>

        {/* Live summary, the policy stated as a sentence, so what you built
 is legible without mentally joining three separate lists. */}
        <div
          className={clsx(
            'flex items-start gap-2.5 rounded-xl border px-3.5 py-3',
            effect === 'deny'
              ? 'border-red-300/70 bg-red-50 dark:border-red-900/40 dark:bg-red-950/25'
              : 'border-surface-700 bg-surface-850/70'
          )}
        >
          {effect === 'deny' ? (
            <AlertTriangle
              className="mt-px h-3.5 w-3.5 flex-none text-red-600 dark:text-red-400"
              strokeWidth={1.75}
            />
          ) : (
            <Info className="mt-px h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
          )}
          <p
            className={clsx(
              'text-xs leading-relaxed',
              effect === 'deny' ? 'text-red-800 dark:text-red-200' : 'text-ink-400'
            )}
          >
            This policy will <span className="font-semibold">{effect === 'deny' ? 'deny' : 'allow'}</span>{' '}
            <span className="font-semibold">{actions.length || 'no'}</span> action
            {actions.length === 1 ? '' : 's'} on{' '}
            <span className="font-semibold">
              {resources.includes(ALL_RESOURCES) ? 'all' : resources.length || 'no'}
            </span>{' '}
            resource{resources.length === 1 && !resources.includes(ALL_RESOURCES) ? '' : 's'}.
            {incomplete && ' Both are required, a policy with an empty list matches nothing.'}
            {effect === 'deny' && ' Deny takes precedence over every allow the account holds.'}
          </p>
        </div>
      </form>
    </Modal>
  )
}
