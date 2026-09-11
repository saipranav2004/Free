import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Vault as VaultIcon, Clock, Info } from 'lucide-react'
import clsx from 'clsx'
import { createSafe } from '../../api/vault'
import { Modal } from '../common/Modal'
import { Field, inputClass, FieldSet } from '../common/FormFields'
import { Button } from '../common/Button'
import { apiErrorMessage } from '../../lib/apiError'
import { objectNameRules } from '../../lib/validators'

// Retention presets rather than a bare number box: the value is a policy
// decision with well-known conventional answers, and typing "3650" into an
// unlabelled field tells you nothing about what you just chose.
const PRESETS = [
  { days: 30, label: '30 days', note: 'Short-lived / test' },
  { days: 90, label: '90 days', note: 'Quarterly review' },
  { days: 365, label: '1 year', note: 'Common default' },
  { days: 2555, label: '7 years', note: 'Regulated retention' },
]

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Give this safe a name of at least 2 characters')
    .max(120, 'Keep the name under 120 characters'),
  description: z.string().trim().max(500, 'Keep the description under 500 characters').optional(),
  retention_days: z.coerce
    .number({ invalid_type_error: 'Enter a number of days' })
    .int('Whole days only')
    .min(1, 'At least 1 day')
    .max(3650, 'At most 3650 days (10 years)'),
})

export function CreateSafeModal({ open, onClose }) {
  const queryClient = useQueryClient()
  const [custom, setCustom] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitted },
  } = useForm({
    resolver: zodResolver(schema),
    mode: 'onBlur',
    defaultValues: { name: '', description: '', retention_days: 365 },
  })

  const retention = Number(watch('retention_days'))
  const name = watch('name') || ''

  useEffect(() => {
    if (open) {
      reset({ name: '', description: '', retention_days: 365 })
      setCustom(false)
    }
  }, [open, reset])

  const mutation = useMutation({
    mutationFn: createSafe,
    onSuccess: (safe) => {
      queryClient.invalidateQueries({ queryKey: ['vault', 'safes'] })
      toast.success(`Safe “${safe?.name || name}” created`)
      onClose()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={VaultIcon}
      title="Create a safe"
      description="A safe is the container credentials live in. Its retention policy governs how long deleted versions survive before permanent purge."
      size="lg"
      busy={mutation.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            form="create-safe-form"
            type="submit"
            variant="primary"
            icon={VaultIcon}
            loading={mutation.isPending}
          >
            Create safe
          </Button>
        </>
      }
    >
      <form
        id="create-safe-form"
        onSubmit={handleSubmit((v) => mutation.mutate(v))}
        noValidate
        className="space-y-6"
      >
        <FieldSet title="Identity">
          <Field label="Name" error={errors.name?.message} required htmlFor="safe-name">
            <input
              id="safe-name"
              autoComplete="off"
              placeholder="Production databases"
              className={inputClass(!!errors.name)}
              {...register('name', {
                onChange: (e) => {
                  e.target.value = objectNameRules.sanitize(e.target.value)
                },
              })}
            />
          </Field>

          <Field
            label="Description"
            hint="Optional, shown in the safes list and in audit exports."
            error={errors.description?.message}
            htmlFor="safe-description"
          >
            <textarea
              id="safe-description"
              rows={2}
              placeholder="What belongs in this safe, and who owns it."
              className={inputClass(!!errors.description)}
              {...register('description')}
            />
          </Field>
        </FieldSet>

        <FieldSet
          title="Retention"
          description="How long deleted credential versions are kept before they are permanently purged."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {PRESETS.map((p) => {
              const active = !custom && retention === p.days
              return (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => {
                    setCustom(false)
                    setValue('retention_days', p.days, { shouldValidate: true })
                  }}
                  className={clsx(
                    'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors duration-150',
                    active
                      ? 'border-blue-500/50 bg-blue-50 dark:bg-blue-500/[0.09]'
                      : 'border-surface-700 bg-surface-850 hover:border-surface-600'
                  )}
                  aria-pressed={active}
                >
                  <span
                    className={clsx(
                      'flex h-8 w-8 flex-none items-center justify-center rounded-lg',
                      active
                        ? 'bg-blue-600 text-white'
                        : 'border border-surface-700 bg-surface-900 text-ink-500'
                    )}
                  >
                    <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0">
                    <span
                      className={clsx(
                        'block text-sm font-medium',
                        active ? 'text-blue-700 dark:text-blue-200' : 'text-ink-100'
                      )}
                    >
                      {p.label}
                    </span>
                    <span className="block truncate text-2xs text-ink-500">{p.note}</span>
                  </span>
                </button>
              )
            })}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <button
              type="button"
              onClick={() => setCustom(true)}
              className={clsx(
                'h-9 flex-none rounded-lg border px-3 text-xs font-medium transition-colors',
                custom
                  ? 'border-blue-500/50 bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-200'
                  : 'border-surface-700 bg-surface-900 text-ink-300 hover:border-surface-600'
              )}
              aria-pressed={custom}
            >
              Custom
            </button>
            {custom && (
              <div className="min-w-[9rem] flex-1">
                <Field label="Days" error={errors.retention_days?.message} htmlFor="safe-retention">
                  <input
                    id="safe-retention"
                    inputMode="numeric"
                    autoFocus
                    className={inputClass(!!errors.retention_days)}
                    {...register('retention_days', {
                      onChange: (e) => {
                        e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 4)
                      },
                    })}
                  />
                </Field>
              </div>
            )}
            {!custom && errors.retention_days && isSubmitted && (
              <p className="text-xs font-medium text-red-600 dark:text-red-400">
                {errors.retention_days.message}
              </p>
            )}
          </div>
        </FieldSet>

        <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-surface-600 bg-surface-850/70 px-3.5 py-3">
          <Info className="mt-px h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
          <p className="text-xs leading-relaxed text-ink-400">
            Retention can only be set here at creation time, this backend exposes no safe-update endpoint, so
            the value is fixed once the safe exists. Choose deliberately.
          </p>
        </div>
      </form>
    </Modal>
  )
}
