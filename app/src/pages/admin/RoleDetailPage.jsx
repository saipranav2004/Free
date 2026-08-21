import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import {
  FileKey2,
  Pencil,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Users,
  X,
  Plus,
  Clock,
} from 'lucide-react'
import { toast } from 'sonner'
import clsx from 'clsx'
import {
  getRole,
  listPolicies,
  attachPolicyToRole,
  detachPolicyFromRole,
  deleteRole,
} from '../../api/rbac'
import { getRoleCriticality, clearRoleCriticality } from '../../api/criticality'
import { bandMeta } from '../../lib/criticality'
import { PageHeader } from '../../components/common/Layout'
import { Container, Section, Stack } from '../../components/ui/layout'
import { StatusDot } from '../../components/ui/bits'
import { Button } from '../../components/common/Button'
import { TabBar } from '../../components/common/TabBar'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { DeniedState, EmptyState, ErrorState, OfflineState } from '../../components/ui/states'
import { selectClass } from '../../components/common/FormFields'
import { Badge } from '../../components/common/Badge'
import {
  AttentionBanner,
  FactorRow,
  MitigationList,
  OverrideDialog,
  OverrideNote,
} from '../../components/rbac/Criticality'
import { apiErrorMessage, normalizeApiError } from '../../lib/apiError'
import { formatDateTime, formatRelativeToNow } from '../../lib/format'
import { isSystemRole, POLICY_EFFECT_BADGE } from '../../config/constants'

// ---------------------------------------------------------------------------
// Role detail
// ---------------------------------------------------------------------------
// THIS PAGE EXISTS BECAUSE THE DRAWER WAS THE WRONG CONTAINER.
//
// Criticality carries a headline, four scored factors each with its own
// evidence, the compensating controls, a separate exposure reading, an
// override with its justification, and the attached policies. That is a
// resource's full detail, and Cloudscape is unambiguous about where full
// detail goes: "Always use details pages to display full resource details of a
// single resource. A split view should never replace details pages in the
// service information architecture." A panel sliding over the list it came
// from is for identifying a row, not for reading it.
//
// So the list keeps a criticality column for scanning and filtering, and the
// reading happens here, on a real page with a real URL that can be linked in a
// ticket, opened in a new tab, and reached by the back button.
//
// Layout follows the details-page pattern: breadcrumbs, title, resource-wide
// actions in the header, then containers grouping the content. Criticality
// leads because "how dangerous is this" is the question that brings people
// here; the grant surface follows because it is the answer's evidence.

const TABS = [
  { key: 'criticality', label: 'Criticality', icon: ShieldAlert },
  { key: 'policies', label: 'Policies', icon: FileKey2 },
]

/**
 * The headline. Band, score, tier and what the band means, on one rule, in the
 * pattern every other detail page in this console uses.
 */
function CriticalityHeadline({ c }) {
  const meta = bandMeta(c.band)
  return (
    <div className="rounded-xl border border-line-soft px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-tertiary">Criticality</p>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <StatusDot tone={meta.tone} label={meta.label} className="text-xl font-bold" />
            {/* An override asserts a BAND, not a number, so the headline does
                not put a computed score next to a reviewer's band: "Critical 0
                of 100" reads as a contradiction. The computed figure is still
                shown, in the override note directly below, where it is framed
                as what the reviewer overrode. */}
            {c.is_overridden ? (
              <span className="text-sm font-medium text-secondary">Set by a reviewer</span>
            ) : (
              <span className="tabular text-lg font-semibold text-secondary">
                {c.computed_score}
                <span className="text-sm font-normal text-tertiary"> of 100</span>
              </span>
            )}
            <span className="text-sm text-tertiary">Tier {meta.tier}</span>
          </div>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-secondary">{meta.blurb}</p>
        </div>

        {/* Exposure is a SEPARATE reading, deliberately in its own column and
            in its own vocabulary. It answers how much live surface the danger
            has, which is a property of the deployment, not of the role. */}
        <div className="min-w-0 border-line-soft sm:border-l sm:pl-8">
          <p className="text-xs font-semibold uppercase tracking-wide text-tertiary">Exposure</p>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xl font-bold capitalize text-primary">
              {c.exposure?.level || 'unknown'}
            </span>
            <span className="tabular text-lg font-semibold text-secondary">
              {c.exposure?.score ?? 0}
              <span className="text-sm font-normal text-tertiary"> of 100</span>
            </span>
          </div>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-secondary">
            {c.exposure?.summary}
          </p>
        </div>
      </div>
    </div>
  )
}

function UsageRow({ exposure }) {
  if (!exposure) return null
  let body
  if (!exposure.usage_known) {
    body = 'Usage is unknown. The audit trail could not be read, so this is neither confirmed active nor confirmed dormant.'
  } else if (exposure.holders === 0) {
    body = 'Nobody holds this role, so there is nothing to exercise.'
  } else if (!exposure.last_used_at) {
    body = 'No holder has successfully used a permission this role grants inside the retained trail.'
  } else {
    body = `Last exercised ${formatRelativeToNow(exposure.last_used_at)}, on ${formatDateTime(
      exposure.last_used_at
    )}.`
  }

  return (
    <div className="flex items-start gap-3 border-t border-line-soft pt-3.5">
      <Clock className="mt-0.5 h-4 w-4 flex-none text-tertiary" strokeWidth={1.8} />
      <div className="min-w-0">
        <p className="text-sm leading-relaxed text-secondary">{body}</p>
        {/* The caveat is stated wherever the figure is, not buried in docs.
            The audit trail records the action, not which role authorised it. */}
        <p className="mt-1 text-xs leading-relaxed text-tertiary">
          Indicative, not attributable. The trail records the action rather than which of the
          caller&apos;s roles authorised it, so a holder who has the same permission through another
          role cannot be told apart here.
        </p>
      </div>
    </div>
  )
}

export default function RoleDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [newPolicyId, setNewPolicyId] = useState('')

  const requested = params.get('tab')
  const tab = TABS.some((t) => t.key === requested) ? requested : 'criticality'
  const setTab = (key) => {
    const next = new URLSearchParams(params)
    if (key === 'criticality') next.delete('tab')
    else next.set('tab', key)
    setParams(next, { replace: true })
  }

  const roleQuery = useQuery({
    queryKey: ['admin', 'roles', id],
    queryFn: ({ signal }) => getRole(id, signal),
  })
  const criticalityQuery = useQuery({
    queryKey: ['admin', 'roles', id, 'criticality'],
    queryFn: ({ signal }) => getRoleCriticality(id, signal),
  })
  const policiesQuery = useQuery({
    queryKey: ['admin', 'policies'],
    queryFn: ({ signal }) => listPolicies(signal),
  })

  // Every mutation on this page changes the classification, because the
  // classification is derived from exactly these rows. One invalidate covers
  // the role, its criticality, and the list behind it.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] })
    queryClient.invalidateQueries({ queryKey: ['admin', 'rbac', 'criticality'] })
  }

  const attach = useMutation({
    mutationFn: (policyId) => attachPolicyToRole(id, policyId),
    onSuccess: () => {
      toast.success('Policy attached', {
        description: 'The criticality below has been recalculated against the new reach.',
      })
      invalidate()
      setNewPolicyId('')
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const detach = useMutation({
    mutationFn: (policyId) => detachPolicyFromRole(id, policyId),
    onSuccess: () => {
      toast.success('Policy detached', {
        description: 'The criticality below has been recalculated against the reduced reach.',
      })
      invalidate()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const clearOverride = useMutation({
    mutationFn: () => clearRoleCriticality(id),
    onSuccess: (data) => {
      toast.success('Override cleared', {
        description: `Classified by the engine again, currently ${bandMeta(data?.band).label}.`,
      })
      invalidate()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const removeRole = useMutation({
    mutationFn: () => deleteRole(id),
    onSuccess: () => {
      toast.success('Role deleted', {
        description: 'Accounts that held it lose the policies it granted.',
      })
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] })
      navigate('/admin/roles')
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setConfirmDelete(false)
    },
  })

  const role = roleQuery.data?.role
  const attached = useMemo(() => roleQuery.data?.policies || [], [roleQuery.data])
  const attachedIds = useMemo(() => new Set(attached.map((p) => p.id)), [attached])
  const available = useMemo(
    () => (policiesQuery.data || []).filter((p) => !attachedIds.has(p.id)),
    [policiesQuery.data, attachedIds]
  )
  const c = criticalityQuery.data
  const system = role ? isSystemRole(role) : false

  // Breadcrumbs are rendered globally by AppLayout, above every page, so
  // this one does not add its own.

  if (roleQuery.isError) {
    const err = normalizeApiError(roleQuery.error)
    return (
      <Stack gap="lg">
        <Container>
          {err.status === 403 ? (
            <DeniedState description={err.message} />
          ) : err.code === 'network_error' ? (
            <OfflineState onRetry={() => roleQuery.refetch()} retrying={roleQuery.isFetching} />
          ) : (
            <ErrorState
              description={err.message}
              onRetry={() => roleQuery.refetch()}
              retrying={roleQuery.isFetching}
            />
          )}
        </Container>
      </Stack>
    )
  }

  if (roleQuery.isLoading || !role) {
    return (
      <Stack gap="lg">
        <div className="space-y-3" role="status" aria-label="Loading role">
          <span className="skeleton block h-8 w-64 rounded" />
          <span className="skeleton block h-24 w-full rounded-xl" />
          <span className="skeleton block h-48 w-full rounded-xl" />
        </div>
      </Stack>
    )
  }

  return (
    <div>
      <PageHeader
        title={role.name}
        description={role.description || 'No description recorded for this role.'}
        actions={
          <>
            {c && (
              <Button variant="secondary" icon={Pencil} onClick={() => setOverrideOpen(true)}>
                {c.is_overridden ? 'Change band' : 'Override band'}
              </Button>
            )}
            <Button
              variant="dangerGhost"
              icon={Trash2}
              disabled={system}
              title={system ? 'Built in roles cannot be deleted' : undefined}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </>
        }
      />

      {/* Fact rail, the same horizontal rule every other detail page uses. */}
      <div className="mb-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-line-soft py-3">
        <span className="text-sm text-secondary">
          {system ? 'Built in role' : 'Custom role'}
        </span>
        <span className="text-sm text-secondary">
          <span className="tabular text-primary">{attached.length}</span>{' '}
          {attached.length === 1 ? 'policy' : 'policies'}
        </span>
        <span className="inline-flex items-center gap-1.5 text-sm text-secondary">
          <Users className="h-3.5 w-3.5 text-tertiary" strokeWidth={1.8} />
          <span className="tabular text-primary">{c?.exposure?.holders ?? 0}</span> holding
        </span>
        {c && (
          <span className="text-sm text-secondary">
            Reaches <span className="tabular text-primary">{c.resource_reach}</span>{' '}
            {c.resource_reach === 1 ? 'resource' : 'resources'}
          </span>
        )}
        <span className="ml-auto font-mono text-xs text-tertiary">{role.id}</span>
      </div>

      <TabBar tabs={TABS} active={tab} onChange={setTab} className="mb-6" />

      {tab === 'criticality' && (
        <Stack gap="lg">
          {criticalityQuery.isLoading ? (
            <span className="skeleton block h-40 w-full rounded-xl" role="status" aria-label="Classifying" />
          ) : criticalityQuery.isError ? (
            <Container>
              <ErrorState
                description={apiErrorMessage(criticalityQuery.error)}
                onRetry={() => criticalityQuery.refetch()}
                retrying={criticalityQuery.isFetching}
              />
            </Container>
          ) : c ? (
            <>
              <AttentionBanner classification={c} />
              <CriticalityHeadline c={c} />
              {c.is_overridden && (
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <OverrideNote classification={c} />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={RotateCcw}
                    loading={clearOverride.isPending}
                    onClick={() => clearOverride.mutate()}
                  >
                    Use computed
                  </Button>
                </div>
              )}

              <Section
                title="How this score was reached"
                description="Each factor states what it found and why that scored. Check the reasoning rather than the number: this is a prioritisation ranking, not a risk measurement."
              >
                <Container>
                  <div className="divide-y divide-line-soft">
                    {(c.factors || []).map((f) => (
                      <FactorRow key={f.key} factor={f} />
                    ))}
                  </div>
                  {Array.isArray(c.mitigations) && c.mitigations.length > 0 && (
                    <div className="mt-4 border-t border-line-soft pt-4">
                      <h4 className="mb-1 text-sm font-semibold text-primary">
                        Compensating controls
                      </h4>
                      <p className="mb-3 text-sm leading-relaxed text-secondary">
                        These reduced the score. The same permissions behind a gate are genuinely
                        safer than the same permissions standing open.
                      </p>
                      <MitigationList mitigations={c.mitigations} />
                    </div>
                  )}
                </Container>
              </Section>

              <Section
                title="Exposure"
                description="How much live surface that danger currently has. Reported separately because a role is exactly as dangerous whether nobody holds it or forty people do."
              >
                <Container>
                  <div className="divide-y divide-line-soft">
                    {(c.exposure?.factors || []).map((f) => (
                      <FactorRow key={f.key} factor={f} />
                    ))}
                  </div>
                  <div className="mt-3.5">
                    <UsageRow exposure={c.exposure} />
                  </div>
                </Container>
              </Section>

              <p className="text-xs leading-relaxed text-tertiary">
                Evaluated {formatDateTime(c.evaluated_at)} against live policy and resource records,
                under model {c.model_version}. Nothing is cached, so this reflects the role as it
                stands right now.
              </p>
            </>
          ) : null}
        </Stack>
      )}

      {tab === 'policies' && (
        <Section
          title="Attached policies"
          description="A role bundles policies. These are what produced the blast radius and privilege scored on the Criticality tab."
          actions={
            <Link
              to="/admin/policies"
              className="text-sm font-semibold text-accent transition-colors hover:underline"
            >
              Manage policies
            </Link>
          }
        >
          <Container padded={false}>
            {attached.length === 0 ? (
              <EmptyState
                icon={FileKey2}
                title="No policies attached"
                description="This role grants nothing until a policy is attached to it."
              />
            ) : (
              <ul className="divide-y divide-line-soft">
                {attached.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-primary">{p.name}</span>
                        {p.effect && (
                          <Badge className={POLICY_EFFECT_BADGE[p.effect]}>{p.effect}</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-tertiary">
                        {p.description ||
                          `${(p.actions || []).length} action${
                            (p.actions || []).length === 1 ? '' : 's'
                          } over ${(p.resources || []).length} resource pattern${
                            (p.resources || []).length === 1 ? '' : 's'
                          }`}
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={X}
                      loading={detach.isPending && detach.variables === p.id}
                      onClick={() => detach.mutate(p.id)}
                      aria-label={`Detach ${p.name}`}
                    >
                      Detach
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-line-soft px-4 py-3">
              <select
                className={clsx(selectClass(false), 'h-9 !w-auto min-w-[15rem] py-0 text-sm')}
                value={available.some((p) => p.id === newPolicyId) ? newPolicyId : ''}
                onChange={(e) => setNewPolicyId(e.target.value)}
                aria-label="Policy to attach"
                disabled={available.length === 0}
              >
                <option value="">
                  {available.length === 0 ? 'Every policy is attached' : 'Attach a policy…'}
                </option>
                {available.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.effect ? ` (${p.effect})` : ''}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="primary"
                icon={Plus}
                disabled={!newPolicyId}
                loading={attach.isPending}
                onClick={() => newPolicyId && attach.mutate(newPolicyId)}
              >
                Attach
              </Button>
              <p className="min-w-0 text-xs leading-relaxed text-tertiary">
                Attaching or detaching recalculates the criticality immediately, since it is derived
                from exactly these rows.
              </p>
            </div>
          </Container>
        </Section>
      )}

      {system && (
        <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-line-soft bg-subtle px-4 py-3">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-none text-tertiary" strokeWidth={1.8} />
          <p className="text-xs leading-relaxed text-secondary">
            Built in role. It ships with every install and the console&apos;s own route guards depend
            on it. Its policies can be changed; the role itself cannot be deleted.
          </p>
        </div>
      )}

      {c && (
        <OverrideDialog
          open={overrideOpen}
          onClose={() => setOverrideOpen(false)}
          roleId={id}
          roleName={role.name}
          current={c}
          onDone={invalidate}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete "${role.name}"?`}
        description="Accounts that hold this role lose the policies it granted, immediately."
        confirmLabel="Delete role"
        destructive
        isLoading={removeRole.isPending}
        onConfirm={() => removeRole.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}
