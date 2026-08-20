import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Lock, Plus, Search, Check, Info, AlertTriangle, ShieldCheck } from 'lucide-react'
import clsx from 'clsx'
import { createRole, attachPolicyToRole, listPolicies } from '../../api/rbac'
import { Modal } from '../common/Modal'
import { Field, inputClass, FieldSet } from '../common/FormFields'
import { Button } from '../common/Button'
import { Badge } from '../common/Badge'
import { apiErrorMessage } from '../../lib/apiError'
import { roleNameRules } from '../../lib/validators'
import { POLICY_EFFECT_BADGE, SYSTEM_ROLES } from '../../config/constants'

// ---------------------------------------------------------------------------
// Create role
// ---------------------------------------------------------------------------
// A role is an identifier the policy engine matches on, not a display label ,
// so the name field enforces identifier shape (lowercase, digits, underscore,
// hyphen) live, the same way the username field does on Create User. Typing
// "Database Admins" yields "database-admins" as you go rather than being
// accepted and then rejected by the server.
//
// The step the old modal was missing: a role with no policies grants nothing.
// Creating one and landing back on an empty list is the most common way to
// end up with a role that silently does nothing, so policies can be attached
// here, at creation, from the same list the Roles page shows.

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'A role name is required')
    .refine(roleNameRules.test, roleNameRules.message)
    .refine(
      (v) => !SYSTEM_ROLES.includes(v.toLowerCase()),
      'That name is reserved by a built-in system role'
    ),
  description: z.string().trim().max(500, 'Keep it under 500 characters').optional(),
})

export function CreateRoleModal({ open, onClose }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState([])
  const [filter, setFilter] = useState('')

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    mode: 'onBlur',
    defaultValues: { name: '', description: '' },
  })

  const policiesQuery = useQuery({
    queryKey: ['admin', 'policies'],
    queryFn: ({ signal }) => listPolicies(signal),
    enabled: open,
  })

  useEffect(() => {
    if (open) {
      reset({ name: '', description: '' })
      setSelected([])
      setFilter('')
    }
  }, [open, reset])

  const name = watch('name') || ''
  const policies = policiesQuery.data || []
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return policies
    return policies.filter(
      (p) => p.name?.toLowerCase().includes(needle) || p.description?.toLowerCase().includes(needle)
    )
  }, [policies, filter])

  const mutation = useMutation({
    mutationFn: async (values) => {
      const role = await createRole({
        name: values.name,
        description: values.description?.trim() || undefined,
      })
      // Attachment is a separate endpoint per policy, there is no bulk
      // route. Sequential rather than parallel so a partial failure reports
      // which policy failed instead of a race of unattributable errors.
      const failed = []
      for (const policyId of selected) {
        try {
          await attachPolicyToRole(role.id, policyId)
        } catch {
          failed.push(policies.find((p) => p.id === policyId)?.name || policyId)
        }
      }
      return { role, failed }
    },
    onSuccess: ({ role, failed }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] })
      if (failed.length > 0) {
        toast.warning(
          `Role “${role.name}” created, but ${failed.length} polic${failed.length === 1 ? 'y' : 'ies'} could not be attached: ${failed.join(', ')}`
        )
      } else {
        toast.success(
          selected.length > 0
            ? `Role “${role.name}” created with ${selected.length} polic${selected.length === 1 ? 'y' : 'ies'}`
            : `Role “${role.name}” created`
        )
      }
      onClose()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={Lock}
      title="Create a role"
      description="A role bundles policies into one assignable unit. Accounts are given roles; roles carry the permissions."
      size="xl"
      busy={mutation.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            form="create-role-form"
            type="submit"
            variant="primary"
            icon={Plus}
            loading={mutation.isPending}
          >
            Create role
          </Button>
        </>
      }
    >
      <form
        id="create-role-form"
        onSubmit={handleSubmit((v) => mutation.mutate(v))}
        noValidate
        className="space-y-6"
      >
        <FieldSet title="Definition">
          <Field
            label="Role name"
            hint={roleNameRules.hint}
            error={errors.name?.message}
            required
            htmlFor="cr-name"
          >
            <input
              id="cr-name"
              autoComplete="off"
              spellCheck={false}
              placeholder="database-operators"
              className={clsx(inputClass(!!errors.name), 'font-mono')}
              {...register('name', {
                onChange: (e) => {
                  e.target.value = roleNameRules.sanitize(e.target.value)
                },
              })}
            />
          </Field>

          <Field
            label="Description"
            hint="Who this role is for and what it is meant to allow. Shown wherever the role is assigned."
            error={errors.description?.message}
            htmlFor="cr-desc"
          >
            <textarea
              id="cr-desc"
              rows={2}
              placeholder="On-call engineers who need read access to production databases."
              className={inputClass(!!errors.description)}
              {...register('description')}
            />
          </Field>
        </FieldSet>

        <FieldSet
          title="Policies"
          description="A role with no policies grants nothing. Attach them now, or later from the role's own row."
        >
          {policiesQuery.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-xl bg-surface-850" />
              ))}
            </div>
          ) : policies.length === 0 ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-surface-600 bg-surface-850/70 px-3.5 py-3">
              <Info className="mt-px h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
              <p className="text-xs leading-relaxed text-ink-400">
                No policies exist yet. Create the role now and attach policies once you&apos;ve defined some
                under Policies.
              </p>
            </div>
          ) : (
            <>
              {policies.length > 6 && (
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-500"
                    strokeWidth={1.75}
                  />
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter policies…"
                    className={clsx(inputClass(false), 'pl-9')}
                  />
                </div>
              )}

              <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-xl border border-surface-700 bg-surface-850/50 p-1.5">
                {visible.length === 0 && (
                  <p className="px-3 py-6 text-center text-xs text-ink-500">Nothing matches “{filter}”.</p>
                )}
                {visible.map((p) => {
                  const on = selected.includes(p.id)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggle(p.id)}
                      aria-pressed={on}
                      className={clsx(
                        'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150',
                        on
                          ? 'border-blue-500/50 bg-blue-50 dark:bg-blue-500/[0.09]'
                          : 'border-transparent hover:bg-surface-800'
                      )}
                    >
                      <span
                        className={clsx(
                          'mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded border transition-colors',
                          on ? 'border-blue-600 bg-blue-600 text-white' : 'border-surface-600 bg-surface-900'
                        )}
                      >
                        {on && <Check className="h-3 w-3" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-ink-100">{p.name}</span>
                          <Badge className={POLICY_EFFECT_BADGE[p.effect]}>{p.effect || 'unknown'}</Badge>
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-ink-500">
                          {p.description ||
                            `${(p.actions || []).length} actions · ${(p.resources || []).length} resource patterns`}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>

              {selected.some((id) => policies.find((p) => p.id === id)?.effect === 'deny') && (
                <div className="flex items-start gap-2.5 rounded-xl border border-amber-300/70 bg-amber-50 px-3.5 py-3 dark:border-amber-900/40 dark:bg-amber-950/25">
                  <AlertTriangle
                    className="mt-px h-3.5 w-3.5 flex-none text-amber-600 dark:text-amber-400"
                    strokeWidth={1.75}
                  />
                  <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                    This role includes a <span className="font-semibold">deny</span> policy. Deny always wins
                    over allow, including allows granted by other roles the account holds.
                  </p>
                </div>
              )}
            </>
          )}
        </FieldSet>

        {name && (
          <div className="flex items-start gap-2.5 rounded-xl border border-surface-700 bg-surface-850/70 px-3.5 py-3">
            <ShieldCheck className="mt-px h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
            <p className="text-xs leading-relaxed text-ink-400">
              Accounts assigned <span className="font-mono font-medium text-ink-100">{name}</span> will
              receive{' '}
              {selected.length === 0
                ? 'no permissions until a policy is attached.'
                : `the ${selected.length} selected polic${selected.length === 1 ? 'y' : 'ies'}.`}
            </p>
          </div>
        )}
      </form>
    </Modal>
  )
}
