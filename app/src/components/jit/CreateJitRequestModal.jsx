import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import clsx from 'clsx'
import { ShieldAlert, KeyRound, Clock, AlertTriangle, UsersRound } from 'lucide-react'
import { createJitRequest, createBreakglassRequest } from '../../api/jit'
import { listResources } from '../../api/resources'
import { JIT_DEFAULTS } from '../../config/constants'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { Field, inputClass, selectClass } from '../common/FormFields'
import { apiErrorMessage } from '../../lib/apiError'
import { userFacingNext } from '../../lib/fourEyes'

// ---------------------------------------------------------------------------
// Request access
// ---------------------------------------------------------------------------
// TWO THINGS WERE WRONG WITH THE OLD FORM.
//
//   1. IT WAS A HAND-ROLLED DIALOG. Its own backdrop, its own close button,
// its own raw <button> elements with inline colour classes, so it had
// none of the console's modal behaviour (Escape, scroll lock, focus
// handling, the focus-stealing fix) and none of its button system. It is
// now the shared Modal and the shared Button.
//
//   2. A CHECKBOX TURNED A NORMAL REQUEST INTO AN EMERGENCY ONE. One click on
// an unassuming checkbox re-pointed the submit at the break-glass
// endpoint, which raises a CRITICAL security alert, is always recorded,
// and gets reviewed after the fact. No enterprise PAM does this:
//      CyberArk, Delinea and AWS all put emergency access behind a SEPARATE
//      DOOR with its own friction, because the cost of raising one by
// accident is a security incident and a conversation with your manager.
//      The mode is now fixed by which button you pressed on the JIT page, and
// break-glass additionally requires an explicit acknowledgement before
// the submit button will enable.
//
// The other change is DURATION. It was a free-text number box against a
// server maximum stated only in helper text, so the most common failure was
// typing 600, submitting, and getting a server rejection. Entra PIM and GCP
// PAM both present duration as policy-bounded presets, which is what this
// does; the custom field is still there for the case a preset doesn't fit,
// and it is still validated against the same maximum.
//
// The API contract is untouched: same two endpoints, same payload keys, same
// per-open Idempotency-Key.

const PRESETS_STANDARD = [15, 30, 60, 120, 240, 480]
const PRESETS_BREAKGLASS = [15, 30, 60]

function durationLabel(min) {
  if (min < 60) return `${min}m`
  const h = min / 60
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`
}

// Generates a fresh idempotency key exactly once per OPEN of the modal (not
// per render, and not per mount, reopening for a second, genuinely different
// request must get a NEW key or the backend would dedupe it as a replay).
function useIdempotencyKey(open) {
  const ref = useRef(null)
  useEffect(() => {
    if (open) ref.current = crypto.randomUUID()
  }, [open])
  return ref
}

export function CreateJitRequestModal({ open, onClose, defaultResourceId, defaultBreakglass = false }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const idempotencyKeyRef = useIdempotencyKey(open)

  // Mode is decided by the entry point and never changes inside the form.
  const isBreakglass = defaultBreakglass
  const maxMinutes = isBreakglass ? JIT_DEFAULTS.BREAKGLASS_MAX_DURATION_MIN : JIT_DEFAULTS.MAX_DURATION_MIN
  const presets = isBreakglass ? PRESETS_BREAKGLASS : PRESETS_STANDARD
  const defaultDuration = isBreakglass
    ? JIT_DEFAULTS.BREAKGLASS_MAX_DURATION_MIN
    : JIT_DEFAULTS.DEFAULT_DURATION_MIN

  const [acknowledged, setAcknowledged] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)

  const schema = useMemo(
    () =>
      z.object({
        resource_id: z.string().min(1, 'Select a resource'),
        action: z.string().optional(),
        duration_minutes: z.coerce
          .number()
          .int('Whole minutes only')
          .min(1, 'Must be at least 1 minute')
          .max(
            maxMinutes,
            `This deployment caps ${isBreakglass ? 'emergency' : 'standard'} access at ${maxMinutes} minutes`
          ),
        reason: z
          .string()
          .trim()
          .min(
            JIT_DEFAULTS.MIN_REASON_LENGTH,
            `At least ${JIT_DEFAULTS.MIN_REASON_LENGTH} characters, this is what an approver and a future auditor read`
          ),
        ticket_ref: z.string().optional(),
      }),
    [maxMinutes, isBreakglass]
  )

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      resource_id: defaultResourceId || '',
      action: '',
      duration_minutes: defaultDuration,
      reason: '',
      ticket_ref: '',
    },
  })

  // Every open starts clean: a stale justification from the last request is
  // exactly the kind of thing that ends up in an audit record verbatim.
  useEffect(() => {
    if (!open) return
    setAcknowledged(false)
    setCustomOpen(false)
    reset({
      resource_id: defaultResourceId || '',
      action: '',
      duration_minutes: isBreakglass
        ? JIT_DEFAULTS.BREAKGLASS_MAX_DURATION_MIN
        : JIT_DEFAULTS.DEFAULT_DURATION_MIN,
      reason: '',
      ticket_ref: '',
    })
  }, [open, defaultResourceId, isBreakglass, reset])

  const resourcesQuery = useQuery({
    queryKey: ['resources', 'flat'],
    queryFn: ({ signal }) => listResources({ signal }),
    enabled: open,
    staleTime: 30_000,
  })

  const mutation = useMutation({
    mutationFn: (values) => {
      const payload = {
        resource_id: values.resource_id,
        action: values.action || undefined,
        duration_minutes: Number(values.duration_minutes),
        reason: values.reason,
        ticket_ref: values.ticket_ref || undefined,
      }
      return isBreakglass
        ? createBreakglassRequest(payload, idempotencyKeyRef.current)
        : createJitRequest(payload, idempotencyKeyRef.current)
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['jit'] })
      // The API's `next` is preferred WHEN IT IS PROSE, because then it is the
      // server's own account of its workflow and stays right if that workflow
      // changes. It is not always prose: this endpoint returns
      // "Poll GET /api/v1/pam/jit/requests/<uuid>", which is written for a
      // program and showed an end user an HTTP verb and a route after they
      // clicked Request access. userFacingNext drops those. See its note.
      toast.success(isBreakglass ? 'Emergency access raised' : 'Access request submitted', {
        description: isBreakglass
          ? undefined
          : userFacingNext(data?.next) ||
            'Two different administrators must approve before access is granted.',
      })
      reset()
      onClose()
      if (data?.request?.id) navigate(`/jit/requests/${data.request.id}`)
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const resources = resourcesQuery.data?.resources || []
  // JIT-gated systems first: they are the ones that actually require this
  // form, and on a long catalogue they would otherwise be scattered.
  const [gated, standing] = useMemo(() => {
    const g = resources.filter((r) => r.requires_jit)
    const s = resources.filter((r) => !r.requires_jit)
    return [g, s]
  }, [resources])

  const duration = Number(watch('duration_minutes')) || 0
  const reason = watch('reason') || ''
  const resourceId = watch('resource_id')
  const chosen = resources.find((r) => r.id === resourceId)
  const expiresAt = duration > 0 ? new Date(Date.now() + duration * 60_000) : null
  const blocked = isBreakglass && !acknowledged

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={mutation.isPending}
      size="xl"
      tone={isBreakglass ? 'danger' : 'default'}
      icon={isBreakglass ? ShieldAlert : KeyRound}
      title={isBreakglass ? 'Emergency (break-glass) access' : 'Request time-boxed access'}
      description={
        isBreakglass
          ? 'For incidents where waiting for an approver is not an option. Every use is alerted on and reviewed.'
          : 'Elevation is granted for a fixed window and ends automatically. Two approvers see exactly what you write here.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="jit-request-form"
            variant={isBreakglass ? 'danger' : 'primary'}
            icon={isBreakglass ? ShieldAlert : KeyRound}
            loading={mutation.isPending}
            disabled={blocked}
            title={blocked ? 'Acknowledge the consequences first' : undefined}
          >
            {isBreakglass ? 'Raise emergency access' : 'Submit request'}
          </Button>
        </>
      }
    >
      {isBreakglass && (
        <div className="mb-5 rounded-xl border border-l-[3px] border-red-500 bg-red-50/60 px-4 py-3.5 dark:bg-red-950/15">
          <p className="flex items-center gap-2 text-sm font-semibold text-red-900 dark:text-red-200">
            <AlertTriangle className="h-4 w-4 flex-none" strokeWidth={1.9} />
            This bypasses approval
          </p>
          <ul className="mt-2 space-y-1 text-sm leading-relaxed text-red-800/90 dark:text-red-300/85">
            <li>· A CRITICAL security alert is raised the moment you submit.</li>
            <li>
              · Access does not start immediately, a {JIT_DEFAULTS.BREAKGLASS_WAIT_MIN}-minute cooling-off
              period runs first, during which an administrator can revoke it.
            </li>
            <li>· The session is always recorded and reviewed after the fact.</li>
          </ul>
          <label className="mt-3.5 flex cursor-pointer items-start gap-2.5 rounded-lg border border-red-600/25 bg-surface-900/60 px-3 py-2.5">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 flex-none rounded border-surface-600 bg-surface-800 text-red-600 focus:ring-red-500/30"
            />
            <span className="text-xs leading-relaxed text-ink-200">
              I understand this raises a security incident and that my use of it will be reviewed.
            </span>
          </label>
        </div>
      )}

      {/* FOUR-EYES, said before the form rather than discovered afterwards.
          A requester who does not know two people have to agree reads
          "Awaiting second approver" as something having gone wrong, and
 chases the first approver who has already done their part. */}
      {!isBreakglass && (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-surface-700/70 bg-surface-850/60 px-4 py-3">
          <UsersRound className="mt-0.5 h-4 w-4 flex-none text-ink-500" strokeWidth={1.75} />
          <p className="text-xs leading-relaxed text-ink-400">
            <span className="font-medium text-ink-200">Two administrators must approve this.</span> The first
            approval does not grant anything, access starts only when a second, different administrator agrees
            (a root approval counts on its own). You can withdraw the request at any point before that.
          </p>
        </div>
      )}

      <form
        id="jit-request-form"
        onSubmit={handleSubmit((v) => mutation.mutate(v))}
        noValidate
        className="space-y-5"
      >
        <Field label="Resource" error={errors.resource_id?.message} required htmlFor="jit-resource">
          <select
            id="jit-resource"
            className={selectClass(!!errors.resource_id)}
            disabled={resourcesQuery.isLoading}
            {...register('resource_id')}
          >
            <option value="">{resourcesQuery.isLoading ? 'Loading resources…' : 'Select a resource…'}</option>
            {gated.length > 0 && (
              <optgroup label="Requires just-in-time approval">
                {gated.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}, {r.host}:{r.port}
                  </option>
                ))}
              </optgroup>
            )}
            {standing.length > 0 && (
              <optgroup label="Standing access (a request is usually unnecessary)">
                {standing.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}, {r.host}:{r.port}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>

        {chosen && !chosen.requires_jit && (
          <p className="-mt-2 flex items-start gap-2 text-xs leading-relaxed text-ink-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none text-amber-500" strokeWidth={1.9} />
            This resource allows standing access, you may already be able to connect without a request.
          </p>
        )}

        {/* Duration as policy-bounded presets. The old free number box let you
 type past the server maximum and find out only on submit. */}
        <div>
          <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-ink-300">
            Duration{' '}
            <span className="text-red-600 dark:text-red-400" aria-hidden="true">
              *
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            {presets.map((m) => {
              const active = !customOpen && duration === m
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setCustomOpen(false)
                    setValue('duration_minutes', m, { shouldValidate: true })
                  }}
                  className={clsx(
                    'h-9 min-w-[3.25rem] rounded-lg border px-3 text-xs font-semibold tabular-nums transition-colors',
                    active
                      ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-500/25 dark:bg-blue-500/15 dark:text-blue-200'
                      : 'border-surface-700 bg-surface-900 text-ink-300 hover:border-surface-600 hover:bg-surface-850'
                  )}
                >
                  {durationLabel(m)}
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => setCustomOpen(true)}
              className={clsx(
                'h-9 rounded-lg border px-3 text-xs font-semibold transition-colors',
                customOpen
                  ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-500/25 dark:bg-blue-500/15 dark:text-blue-200'
                  : 'border-surface-700 bg-surface-900 text-ink-300 hover:border-surface-600 hover:bg-surface-850'
              )}
            >
              Custom
            </button>
          </div>

          {customOpen && (
            <div className="mt-2.5">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={maxMinutes}
                aria-label="Custom duration in minutes"
                className={inputClass(!!errors.duration_minutes)}
                {...register('duration_minutes')}
              />
            </div>
          )}

          {errors.duration_minutes ? (
            <p className="mt-1.5 text-xs font-medium text-red-600 dark:text-red-400" role="alert">
              {errors.duration_minutes.message}
            </p>
          ) : (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-500">
              <Clock className="h-3 w-3 flex-none" strokeWidth={2} />
              {expiresAt
                ? `Ends around ${expiresAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${
                    isBreakglass
                      ? `, after the ${JIT_DEFAULTS.BREAKGLASS_WAIT_MIN}-minute cooling-off period`
                      : ''
                  }. Maximum ${maxMinutes} minutes.`
                : `Maximum ${maxMinutes} minutes on this deployment.`}
            </p>
          )}
        </div>

        <Field
          label="Justification"
          error={errors.reason?.message}
          required
          htmlFor="jit-reason"
          hint={`What you are doing and why it needs elevation. ${reason.trim().length}/${JIT_DEFAULTS.MIN_REASON_LENGTH} characters minimum.`}
        >
          <textarea
            id="jit-reason"
            rows={3}
            placeholder="e.g. Investigating elevated error rate on checkout, need read access to the orders table."
            className={inputClass(!!errors.reason)}
            {...register('reason')}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Action" hint="Optional, narrow the grant, e.g. read." htmlFor="jit-action">
            <input id="jit-action" className={inputClass(false)} placeholder="read" {...register('action')} />
          </Field>
          <Field
            label="Ticket reference"
            hint="Optional, links this to your change record."
            htmlFor="jit-ticket"
          >
            <input
              id="jit-ticket"
              className={inputClass(false)}
              placeholder="JIRA-1234"
              {...register('ticket_ref')}
            />
          </Field>
        </div>

        {!isBreakglass && (
          <p className="border-t border-surface-800 pt-3.5 text-xs leading-relaxed text-ink-500">
            Nothing is granted until an approver decides. If this is an incident and you cannot wait, close
            this and use
            <span className="font-medium text-ink-400"> Emergency access</span> instead, it bypasses approval
            and is alerted on.
          </p>
        )}
      </form>
    </Modal>
  )
}
