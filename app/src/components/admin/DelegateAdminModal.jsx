import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ShieldCheck, AlertTriangle, Info } from 'lucide-react'
import clsx from 'clsx'
import { delegateAdmin } from '../../api/identity'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { Checkbox } from '../common/Checkbox'
import { Field, inputClass, FieldSet } from '../common/FormFields'
import { normalizeApiError } from '../../lib/apiError'

// ---------------------------------------------------------------------------
// Delegate admin
// ---------------------------------------------------------------------------
// The one way administrative access is handed to an account in this console.
// It is deliberately a form and not a dropdown entry, because the endpoint
// takes three things a role assignment cannot carry:
//
// reason required, written into the audit record
// expires_at optional; the delegation lapses on its own
// scope_resource_ids optional; narrows what the delegate can operate on
//
// plus `replace_admin`, which re-records an account that already holds `admin`
// as a revocable delegation. That flag is the answer to the 409 the server
// returns when the target is already an admin, so the dialog offers it up-front
// when we can see the target holds `admin`, and surfaces it as a next step when
// the 409 arrives anyway (the roles list on screen can be a few seconds stale).
//
// Only root can call this successfully. The caller renders this dialog behind
// its own isRoot() check; the 403 branch below exists for the case where the
// session's roles changed since the page loaded.

const schema = z
  .object({
    reason: z.string().trim().min(1, 'A reason is required, it is written to the audit record'),
    expires_at: z.string().optional(),
    scope_resource_ids: z.string().optional(),
    replace_admin: z.boolean().optional(),
  })
  .refine((v) => !v.expires_at || !Number.isNaN(new Date(v.expires_at).getTime()), {
    message: 'That is not a valid date and time',
    path: ['expires_at'],
  })
  .refine((v) => !v.expires_at || new Date(v.expires_at).getTime() > Date.now(), {
    message: 'Expiry must be in the future',
    path: ['expires_at'],
  })

// `<input type="datetime-local">` speaks local wall-clock time with no zone;
// the API wants RFC3339. new Date("2026-09-01T10:30") is parsed as LOCAL time
// by every browser, so this is the correct conversion and not a UTC-shift bug.
function toRfc3339(value) {
  if (!value) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

// A `min` for the picker so the browser itself discourages a past expiry.
function nowLocalInputValue() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function parseIdList(text) {
  return String(text || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const DEFAULTS = { reason: '', expires_at: '', scope_resource_ids: '', replace_admin: false }

export function DelegateAdminModal({ open, onClose, userId, username, holdsAdminRole = false, onDelegated }) {
  // Server-side failure shown in the dialog rather than only as a toast: the
  // 409 and 403 cases both need the user to change something HERE.
  const [serverError, setServerError] = useState(null)

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm({ resolver: zodResolver(schema), mode: 'onBlur', defaultValues: DEFAULTS })

  useEffect(() => {
    if (open) {
      reset({ ...DEFAULTS, replace_admin: holdsAdminRole })
      setServerError(null)
    }
  }, [open, holdsAdminRole, reset])

  const replaceAdmin = watch('replace_admin')
  const expiresAt = watch('expires_at')

  const mutation = useMutation({
    mutationFn: (values) =>
      delegateAdmin(userId, {
        reason: values.reason.trim(),
        ...(toRfc3339(values.expires_at) ? { expires_at: toRfc3339(values.expires_at) } : {}),
        ...(parseIdList(values.scope_resource_ids).length
          ? { scope_resource_ids: parseIdList(values.scope_resource_ids) }
          : {}),
        ...(values.replace_admin ? { replace_admin: true } : {}),
      }),
    onSuccess: (data) => {
      toast.success(
        data?.replaced_admin
          ? `${username} now holds delegated admin, the existing admin role was replaced`
          : `Delegated admin granted to ${username}`
      )
      onDelegated?.(data)
      onClose()
    },
    onError: (err) => {
      const normalized = normalizeApiError(err)
      if (normalized.status === 403) {
        setServerError({
          status: 403,
          message: 'Only root users can delegate admin access.',
        })
      } else if (normalized.status === 409) {
        setServerError({
          status: 409,
          message: normalized.message || 'This account already holds the admin role.',
          hint: 'Tick “Replace the existing admin role” to convert it into a revocable delegation.',
        })
      } else {
        setServerError({ status: normalized.status, message: normalized.message })
      }
      // The toast keeps the failure visible if the dialog is scrolled away
      // from the banner on a short viewport.
      toast.error(
        normalized.status === 403 ? 'Only root users can delegate admin access.' : normalized.message
      )
    },
  })

  const submit = (values) => {
    setServerError(null)
    mutation.mutate(values)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={ShieldCheck}
      tone="warning"
      title={`Delegate admin to ${username || 'this account'}`}
      description="Grants the admin role: Admin Center access that root can take back at any time. An admin cannot pass administrative access on to anyone else."
      size="xl"
      busy={mutation.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            form="delegate-admin-form"
            type="submit"
            variant="primary"
            icon={ShieldCheck}
            loading={mutation.isPending}
          >
            Delegate admin
          </Button>
        </>
      }
    >
      <form id="delegate-admin-form" onSubmit={handleSubmit(submit)} noValidate className="space-y-6">
        {serverError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-xl border border-red-300/70 bg-red-50 px-3.5 py-3 dark:border-red-900/50 dark:bg-red-950/25"
          >
            <AlertTriangle
              className="mt-px h-3.5 w-3.5 flex-none text-red-600 dark:text-red-400"
              strokeWidth={1.75}
            />
            <div className="min-w-0">
              <p className="text-xs font-semibold leading-relaxed text-red-800 dark:text-red-200">
                {serverError.message}
              </p>
              {serverError.hint && (
                <p className="mt-1 text-xs leading-relaxed text-red-700/90 dark:text-red-300/90">
                  {serverError.hint}
                </p>
              )}
            </div>
          </div>
        )}

        <FieldSet
          title="Why"
          description="Recorded against the delegation and in the audit trail. It is the only durable record of why this account was given administrative access."
        >
          <Field label="Reason" error={errors.reason?.message} required htmlFor="delegate-reason">
            <textarea
              id="delegate-reason"
              rows={3}
              placeholder="Covering platform on-call while the primary admin is on leave"
              className={clsx(inputClass(!!errors.reason), 'resize-y')}
              {...register('reason')}
            />
          </Field>
        </FieldSet>

        <FieldSet
          title="Limits"
          description="Both optional. An expiry is the difference between access you have to remember to take back and access that ends on its own."
        >
          <Field
            label="Expires at"
            error={errors.expires_at?.message}
            hint={expiresAt ? undefined : 'Leave empty for a delegation with no end date.'}
            htmlFor="delegate-expires"
          >
            <input
              id="delegate-expires"
              type="datetime-local"
              min={nowLocalInputValue()}
              className={inputClass(!!errors.expires_at)}
              {...register('expires_at')}
            />
          </Field>

          <Field
            label="Scope to resource IDs"
            error={errors.scope_resource_ids?.message}
            hint="Optional. Comma- or newline-separated resource IDs. Leave empty for unscoped delegated admin."
            htmlFor="delegate-scope"
          >
            <textarea
              id="delegate-scope"
              rows={2}
              spellCheck={false}
              placeholder="8f14e45f-…, 3c59dc04-…"
              className={clsx(inputClass(!!errors.scope_resource_ids), 'resize-y font-mono text-xs')}
              {...register('scope_resource_ids')}
            />
          </Field>
        </FieldSet>

        <FieldSet title="Existing admin role">
          <Checkbox
            checked={!!replaceAdmin}
            onChange={(next) => setValue('replace_admin', next, { shouldValidate: false })}
            disabled={mutation.isPending}
            label="Replace the existing admin role"
          />
          <div className="flex items-start gap-2.5 text-xs leading-relaxed text-ink-500">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
            <p>
              {holdsAdminRole ? (
                <>
                  This account already holds the <span className="font-semibold">admin</span> role. Delegation
                  is refused with a conflict unless this is ticked, with it, the existing role is re-recorded
                  as a revocable delegation with a reason behind it.
                </>
              ) : (
                <>
                  Only needed if the account already holds the <span className="font-semibold">admin</span>{' '}
                  role. With it ticked, that role is re-recorded as a revocable delegation instead of the
                  request being refused.
                </>
              )}
            </p>
          </div>
        </FieldSet>
      </form>
    </Modal>
  )
}
