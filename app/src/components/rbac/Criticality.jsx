import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ShieldAlert, Check, Info, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import clsx from 'clsx'
import { setRoleCriticality } from '../../api/criticality'
import { CRITICALITY_BANDS, bandMeta, factorPercent } from '../../lib/criticality'
import { StatusDot } from '../ui/bits'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { Field, inputClass } from '../common/FormFields'
import { apiErrorMessage } from '../../lib/apiError'

// ---------------------------------------------------------------------------
// Criticality, the shared pieces
// ---------------------------------------------------------------------------
// The rule everything here follows: a score with no explanation is a number
// people learn to ignore. The band is never rendered alone. In the table it is
// a dot plus a word; on the detail page it opens into the scored factors with
// the evidence that produced each one.

// ── Row level mark ─────────────────────────────────────────────────────────

/**
 * Band as a dot plus word for a table cell, with the score in a tabular figure
 * so a column of them lines up. An overridden row says so, because "a person
 * decided this" and "the engine computed this" are different claims.
 */
export function CriticalityCell({ classification }) {
  if (!classification) return <span className="text-sm text-tertiary">Not classified</span>
  const meta = bandMeta(classification.band)
  return (
    <span className="flex items-center gap-2">
      <StatusDot tone={meta.tone} label={meta.label} />
      <span className="tabular text-xs text-tertiary">{classification.computed_score}</span>
      {classification.is_overridden && (
        <span
          title="Classified by a reviewer, not computed"
          className="rounded bg-subtle px-1 py-0.5 text-2xs font-medium text-secondary"
        >
          set
        </span>
      )}
    </span>
  )
}

/**
 * Exposure as plain words. Deliberately not a coloured band: exposure is not
 * severity, and giving it the criticality palette would imply a ranking it
 * does not have.
 */
export function ExposureCell({ classification }) {
  const e = classification?.exposure
  if (!e) return <span className="text-sm text-tertiary">-</span>
  if (e.holders === 0) {
    return <span className="text-sm text-tertiary">Nobody</span>
  }
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-sm text-secondary">
        <span className="tabular text-primary">{e.holders}</span>{' '}
        {e.holders === 1 ? 'account' : 'accounts'}
      </span>
      {!e.usage_known ? (
        <span className="text-xs text-tertiary">usage unknown</span>
      ) : e.dormant ? (
        <span className="text-xs font-medium text-warn">unused</span>
      ) : null}
    </span>
  )
}

// ── Factor rendering ───────────────────────────────────────────────────────

/**
 * One scored axis with its evidence. The bar is deliberately neutral: the BAND
 * carries the colour, and colouring every bar as well would read as four
 * competing alarms rather than one score with several inputs.
 */
export function FactorRow({ factor }) {
  const pct = factorPercent(factor)
  return (
    <div className="py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-primary">{factor.label}</span>
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
              <span className="min-w-0 break-words">{e}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Compensating controls, rendered as credits rather than as findings. */
export function MitigationList({ mitigations }) {
  if (!Array.isArray(mitigations) || mitigations.length === 0) return null
  return (
    <ul className="space-y-2.5">
      {mitigations.map((m) => (
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
  )
}

/** The standing override, shown with what it replaced. */
export function OverrideNote({ classification }) {
  const c = classification
  if (!c?.is_overridden || !c.override) return null
  const meta = bandMeta(c.band)
  const computed = bandMeta(c.computed_band)
  return (
    <div className="rounded-lg border border-line-soft bg-subtle px-3.5 py-3">
      <p className="flex items-start gap-2 text-sm leading-relaxed text-secondary">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-none text-tertiary" strokeWidth={1.9} />
        <span>
          Classified <span className="font-semibold text-primary">{meta.label}</span> by{' '}
          <span className="font-medium text-primary">
            {c.override.set_by_username || 'an administrator'}
          </span>
          . The engine computes{' '}
          <span className="font-medium text-primary">{computed.label}</span> at{' '}
          <span className="tabular">{c.computed_score}</span>. Automatic reclassification stays
          suspended while this override stands.
        </span>
      </p>
      {c.override.reason && (
        <p className="mt-2 border-t border-line-soft pt-2 text-sm leading-relaxed text-secondary">
          <span className="font-medium text-primary">Reason: </span>
          {c.override.reason}
        </p>
      )}
    </div>
  )
}

/**
 * The one banner this feature earns: a role that could do real damage which
 * nobody is actually exercising. Unused privileged access is the standard
 * candidate for removal, and pointing at it is the most useful thing the
 * classification can do.
 */
export function AttentionBanner({ classification }) {
  const c = classification
  const e = c?.exposure
  if (!e) return null
  const tier = bandMeta(c.band).tier
  if (tier > 1) return null
  if (!e.dormant && e.holders !== 0) return null

  const why =
    e.holders === 0
      ? 'Nobody holds it, so it grants nothing today while still carrying the blast radius below.'
      : 'No holder has exercised a permission it grants inside the review window.'

  return (
    <div className="flex items-start gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-warn" strokeWidth={1.9} />
      <p className="text-sm leading-relaxed text-primary">
        <span className="font-semibold">
          {bandMeta(c.band).label} criticality, and unused.
        </span>{' '}
        {why} This is the usual candidate for removal or for tightening.
      </p>
    </div>
  )
}

// ── Override dialog ────────────────────────────────────────────────────────

/**
 * A focused, single-decision form, which is what a modal is for. The band and
 * a mandatory reason: an override with no recorded justification cannot be
 * told apart from a mistake once the person who made it has moved on. The
 * server enforces the same rule; this form just refuses to waste a round trip.
 */
export function OverrideDialog({ open, onClose, roleId, roleName, current, onDone }) {
  const [band, setBand] = useState(current?.band || 'HIGH')
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)

  const mutation = useMutation({
    mutationFn: () => setRoleCriticality(roleId, { band, reason: reason.trim() }),
    onSuccess: (data) => {
      toast.success('Criticality set', {
        description: `${roleName} is classified ${bandMeta(data?.band).label}. Your reason is in the audit trail.`,
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
      busy={mutation.isPending}
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
          Your classification replaces the computed one and stops the engine reclassifying this role
          until it is cleared. The engine currently computes{' '}
          <span className="font-semibold text-primary">{bandMeta(current?.computed_band).label}</span>{' '}
          at <span className="tabular font-semibold text-primary">{current?.computed_score}</span> of
          100.
        </p>

        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-primary">Band</legend>
          <div className="space-y-1.5">
            {CRITICALITY_BANDS.map((b) => {
              const meta = bandMeta(b)
              const on = band === b
              return (
                <label
                  key={b}
                  className={clsx(
                    'flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors',
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
                    <span className="mt-0.5 block text-xs leading-relaxed text-tertiary">
                      {meta.blurb}
                    </span>
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
