import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert, Pencil, RotateCcw, Info, Check } from 'lucide-react'
import { toast } from 'sonner'
import clsx from 'clsx'
import {
  getRoleCriticality,
  setRoleCriticality,
  clearRoleCriticality,
} from '../../api/criticality'
import { CRITICALITY_BANDS, bandMeta, factorPercent } from '../../lib/criticality'
import { StatusDot } from '../ui/bits'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { Field, inputClass } from '../common/FormFields'
import { apiErrorMessage } from '../../lib/apiError'
import { formatDateTime } from '../../lib/format'

// ---------------------------------------------------------------------------
// Role criticality, the read surface
// ---------------------------------------------------------------------------
// The rule this whole component follows: a score with no explanation is a
// number people learn to ignore. Every governance product that ships risk
// scoring and gets adopted shows the WHY next to the WHAT, and the ones that
// only show a number end up with a column nobody filters on.
//
// So the band is never rendered alone. In the table it rides as a dot plus a
// word (the same mark every other piece of state in this console uses). In the
// drawer it opens into the four scored factors, each carrying the evidence
// that produced it: which actions, which resources, how many holders.

// ── The row level mark ─────────────────────────────────────────────────────

/**
 * Band as a dot plus word, for a table cell. `score` is shown beside it in a
 * tabular figure so a column of them lines up and can be compared at a glance.
 * `overridden` marks a reviewer decision, because "a person decided this" and
 * "the engine computed this" are different claims and must not look identical.
 */
export function CriticalityCell({ classification }) {
  if (!classification) return <span className="text-sm text-tertiary">Not classified</span>
  const meta = bandMeta(classification.band)
  return (
    <span className="flex items-center gap-2">
      <StatusDot tone={meta.tone} label={meta.label} />
      <span className="tabular text-xs text-tertiary">{classification.score}</span>
      {classification.is_overridden && (
        <span
          title="Set by a reviewer, not computed"
          className="rounded bg-subtle px-1 py-0.5 text-2xs font-medium text-secondary"
        >
          set
        </span>
      )}
    </span>
  )
}

// ── The evidence panel ─────────────────────────────────────────────────────

function FactorBar({ factor }) {
  const pct = factorPercent(factor)
  // The bar is deliberately neutral rather than colour coded per factor. The
  // BAND carries the colour; if every bar were also coloured the panel would
  // read as four competing alarms instead of one score with four inputs.
  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-primary">{factor.label}</span>
        <span className="flex-none tabular text-xs text-tertiary">
          {factor.score} of {factor.max}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-subtle">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      {factor.summary && (
        <p className="mt-2 text-sm leading-relaxed text-secondary">{factor.summary}</p>
      )}
      {Array.isArray(factor.evidence) && factor.evidence.length > 0 && (
        <ul className="mt-2 space-y-1">
          {factor.evidence.map((e) => (
            <li key={e} className="flex items-start gap-2 text-xs leading-relaxed text-tertiary">
              <span className="mt-1.5 h-1 w-1 flex-none rounded-full bg-line-strong" aria-hidden="true" />
              <span className="min-w-0 break-words font-mono">{e}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The full classification for one role: headline band, the four scored
 * factors with their evidence, the compensating controls that reduced the
 * score, and the override controls.
 *
 * Rendered inside the role drawer rather than on a page of its own, because
 * the question "how dangerous is this role" is only ever asked while looking
 * at the role.
 */
export function CriticalityPanel({ roleId, roleName, canOverride = true }) {
  const queryClient = useQueryClient()
  const [overrideOpen, setOverrideOpen] = useState(false)

  const query = useQuery({
    queryKey: ['admin', 'roles', roleId, 'criticality'],
    queryFn: ({ signal }) => getRoleCriticality(roleId, signal),
    enabled: !!roleId,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'roles', roleId, 'criticality'] })
    queryClient.invalidateQueries({ queryKey: ['admin', 'rbac', 'criticality'] })
  }

  const clearMutation = useMutation({
    mutationFn: () => clearRoleCriticality(roleId),
    onSuccess: (data) => {
      toast.success('Override cleared', {
        description: `${roleName} is classified by the engine again, currently ${bandMeta(data?.band).label}.`,
      })
      invalidate()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  if (query.isLoading) {
    return (
      <div className="space-y-2 py-2" role="status" aria-label="Classifying role">
        <span className="skeleton block h-4 w-1/3 rounded" />
        <span className="skeleton block h-4 w-2/3 rounded" />
        <span className="skeleton block h-4 w-1/2 rounded" />
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className="flex flex-wrap items-center gap-3 py-2">
        <p className="min-w-0 text-sm text-danger">{apiErrorMessage(query.error)}</p>
        <Button size="xs" variant="secondary" icon={RotateCcw} onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    )
  }

  const c = query.data
  if (!c) return null
  const meta = bandMeta(c.band)
  const computedMeta = bandMeta(c.computed_band)

  return (
    <div>
      {/* Headline. Band, score, and what the band actually means, because
          "High" on its own is a word, not information. */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-y border-line-soft py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusDot tone={meta.tone} label={meta.label} className="text-base font-semibold" />
            <span className="tabular text-sm text-secondary">{c.score} of 100</span>
            <span className="text-sm text-tertiary">Tier {meta.tier}</span>
          </div>
          <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-secondary">{meta.blurb}</p>
        </div>
        {canOverride && (
          <div className="flex flex-none flex-wrap gap-2">
            <Button size="xs" variant="secondary" icon={Pencil} onClick={() => setOverrideOpen(true)}>
              {c.is_overridden ? 'Change band' : 'Override band'}
            </Button>
            {c.is_overridden && (
              <Button
                size="xs"
                variant="ghost"
                icon={RotateCcw}
                loading={clearMutation.isPending}
                onClick={() => clearMutation.mutate()}
              >
                Use computed
              </Button>
            )}
          </div>
        )}
      </div>

      {/* A reviewer decision replaces the computed band, so both are shown.
          Hiding what was overridden is how an override becomes unauditable. */}
      {c.is_overridden && c.override && (
        <div className="mt-3 rounded-lg border border-line-soft bg-subtle px-3 py-2.5">
          <p className="flex items-start gap-2 text-sm leading-relaxed text-secondary">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-none text-tertiary" strokeWidth={1.9} />
            <span>
              Set to <span className="font-medium text-primary">{meta.label}</span> by{' '}
              <span className="font-medium text-primary">{c.override.set_by_username || 'an administrator'}</span>
              {c.override.updated_at ? ` on ${formatDateTime(c.override.updated_at)}` : ''}. The engine
              computes <span className="font-medium text-primary">{computedMeta.label}</span> ({c.computed_score}
              ). Automatic reclassification is suspended while this override stands.
            </span>
          </p>
          {c.override.reason && (
            <p className="mt-2 border-t border-line-soft pt-2 text-sm leading-relaxed text-secondary">
              <span className="font-medium text-primary">Reason: </span>
              {c.override.reason}
            </p>
          )}
        </div>
      )}

      {/* Counts an administrator wants before reading the factors. */}
      <dl className="mt-4 grid grid-cols-3 gap-3">
        {[
          { label: 'Policies', value: c.policy_count },
          { label: 'Held by', value: c.member_count },
          { label: 'Resources reached', value: c.resource_reach },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-line-soft px-3 py-2">
            <dt className="text-xs text-tertiary">{s.label}</dt>
            <dd className="mt-0.5 tabular text-base font-semibold text-primary">{s.value}</dd>
          </div>
        ))}
      </dl>

      <h4 className="mt-5 text-sm font-semibold text-primary">How this score was reached</h4>
      <div className="divide-y divide-line-soft">
        {(c.factors || []).map((f) => (
          <FactorBar key={f.key} factor={f} />
        ))}
      </div>

      {Array.isArray(c.mitigations) && c.mitigations.length > 0 && (
        <>
          <h4 className="mt-5 text-sm font-semibold text-primary">Compensating controls</h4>
          <p className="mt-1 text-sm leading-relaxed text-secondary">
            These reduced the score. The same permissions behind a gate are genuinely safer than the same
            permissions standing open.
          </p>
          <ul className="mt-2 space-y-2">
            {c.mitigations.map((m) => (
              <li key={m.key} className="flex items-start gap-2.5">
                <Check className="mt-0.5 h-4 w-4 flex-none text-ok" strokeWidth={2} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-primary">
                    {m.label} <span className="tabular font-normal text-tertiary">minus {m.points}</span>
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-tertiary">{m.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {c.evaluated_at && (
        <p className="mt-5 border-t border-line-soft pt-3 text-xs leading-relaxed text-tertiary">
          Evaluated {formatDateTime(c.evaluated_at)} against live policy and resource records. Nothing is
          cached, so this reflects the role as it stands right now.
        </p>
      )}

      <OverrideDialog
        open={overrideOpen}
        onClose={() => setOverrideOpen(false)}
        roleId={roleId}
        roleName={roleName}
        current={c}
        onDone={invalidate}
      />
    </div>
  )
}

// ── Override ───────────────────────────────────────────────────────────────

/**
 * The reviewer override. A band and a mandatory reason, because an override
 * with no recorded justification is indistinguishable from a mistake once the
 * person who made it has moved on. The server enforces the same rule, this
 * form just refuses to waste a round trip on it.
 */
function OverrideDialog({ open, onClose, roleId, roleName, current, onDone }) {
  const [band, setBand] = useState(current?.band || 'HIGH')
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)

  const mutation = useMutation({
    mutationFn: () => setRoleCriticality(roleId, { band, reason: reason.trim() }),
    onSuccess: (data) => {
      toast.success('Criticality set', {
        description: `${roleName} is now classified ${bandMeta(data?.band).label}. The decision and your reason are in the audit trail.`,
      })
      onDone?.()
      close()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const close = () => {
    setReason('')
    setTouched(false)
    onClose()
  }

  const reasonError = touched && !reason.trim() ? 'A reason is required' : undefined

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Classify ${roleName}`}
      icon={ShieldAlert}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            onClick={() => {
              setTouched(true)
              if (!reason.trim()) return
              mutation.mutate()
            }}
          >
            Set classification
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-secondary">
          Your classification replaces the computed one and stops the engine from reclassifying this role
          until the override is cleared. The engine currently computes{' '}
          <span className="font-medium text-primary">{bandMeta(current?.computed_band).label}</span> at{' '}
          <span className="tabular font-medium text-primary">{current?.computed_score}</span> of 100.
        </p>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-primary">Band</legend>
          <div className="space-y-1.5">
            {CRITICALITY_BANDS.map((b) => {
              const meta = bandMeta(b)
              const on = band === b
              return (
                <label
                  key={b}
                  className={clsx(
                    'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                    on ? 'border-accent bg-accent-soft' : 'border-line-soft hover:bg-hover'
                  )}
                >
                  <input
                    type="radio"
                    name="criticality-band"
                    value={b}
                    checked={on}
                    onChange={() => setBand(b)}
                    className="mt-1 h-3.5 w-3.5 flex-none accent-current text-accent"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <StatusDot tone={meta.tone} label={meta.label} />
                      <span className="text-xs text-tertiary">Tier {meta.tier}</span>
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-tertiary">{meta.blurb}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>

        <Field label="Reason" error={reasonError} required htmlFor="criticality-reason">
          <textarea
            id="criticality-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="Why the computed band is wrong for this role"
            className={clsx(inputClass(!!reasonError), 'resize-y')}
          />
        </Field>
      </div>
    </Modal>
  )
}
