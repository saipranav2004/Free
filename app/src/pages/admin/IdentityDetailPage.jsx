import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import {
  ArrowLeft,
  KeyRound,
  Trash2,
  X,
  ShieldCheck,
  UserRound,
  Lock,
  Ban,
  CheckCircle2,
  ScrollText,
  FileKey2,
  Plus,
  Eye,
  EyeOff,
  Wand2,
  AlertTriangle,
  Copy,
  Check,
  History,
  RefreshCw,
  ShieldAlert,
  ShieldOff,
  Clock,
  Info,
  Tag,
  Crown,
  Layers,
  Smartphone,
} from 'lucide-react'
import { toast } from 'sonner'
import clsx from 'clsx'
import {
  getUser,
  setUserStatus,
  deleteUser,
  resetUserPassword,
  assignRole,
  removeRole,
  attachPolicy,
  detachPolicy,
  getDelegationStatus,
  revokeAdminDelegation,
  resetUserMfa,
} from '../../api/identity'
import { listPolicies, listRoles } from '../../api/rbac'
import { auditByUser } from '../../api/audit'
import { useAuthStore } from '../../store/authStore'
import { rolesOfAccess } from '../../lib/roles'
import { DelegateAdminModal } from '../../components/admin/DelegateAdminModal'
import {
  PageHeader,
  Card,
  CardHeader,
  CardTitle,
  CardFooter,
  DetailList,
  EmptyState,
  Section,
} from '../../components/common/Layout'
import { QueryState } from '../../components/common/QueryState'
import { Badge, MetaTag } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { StatusDot } from '../../components/ui/bits'
import { TabBar } from '../../components/common/TabBar'
import { Avatar } from '../../components/common/UserMenu'
import { Field, inputClass, selectClass } from '../../components/common/FormFields'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { AuditTable } from '../../components/audit/AuditTable'
import { AuditEventDrawer } from '../../components/audit/AuditEventDrawer'
import { apiErrorMessage, normalizeApiError } from '../../lib/apiError'
import { formatDateTime, formatRelativeToNow } from '../../lib/format'
import { passwordStrength, suggestPassword, PASSWORD_MIN } from '../../lib/validators'
import {
  USER_STATUS_BADGE,
  POLICY_EFFECT_BADGE,
  roleBadgeClass,
  roleBlurb,
  isSystemRoleName,
  isPrivilegedRoleName,
  normalizeRoleList,
  isAdminRoleName,
  isRootRoleName,
  isAssignableRoleName,
  systemRoleLockReason,
  delegationStatusLabel,
  delegationStatusBadgeClass,
} from '../../config/constants'

// ---------------------------------------------------------------------------
// Admin Center, account detail
// ---------------------------------------------------------------------------
// The old page was two columns of unlabelled boxes: profile on the left,
// roles and policies stacked on the right, a bare "Reset password" button
// wired to an inline form, and delete sitting in the header next to nothing.
//
// Rebuilt as an identity record: a header that states who this is and what
// state they're in, then four tabs that match the four questions an
// administrator opens this page to answer ,
//
//   Overview who is this account, when was it made, when was it last used
//   Access what can it reach (roles, and policies attached directly)
//   Security password, lifecycle state, and the destructive actions
//   Activity what has it actually done (its own slice of the audit trail)
//
// Lifecycle actions all route through ConfirmDialog, and the two truly
// destructive ones require a typed reason, because the backend writes that
// reason into the audit record.

const STATUS_TRANSITIONS = [
  { value: 'ACTIVE', label: 'Activate', icon: CheckCircle2, note: 'Restores the ability to sign in.' },
  {
    value: 'DISABLED',
    label: 'Disable',
    icon: Ban,
    note: 'Keeps the account and its history, denies all access.',
  },
  // LOCKED is commented out on purpose, not removed.
  //
  // Locking is not an administrative state on this backend, it is one the
  // server sets ITSELF after too many failed sign-ins, together with the
  // `locked_until` timestamp that decides when it lifts (see
  // AuthService.handleFailedLogin). An operator setting LOCKED by hand
  // produces a lock with no expiry attached, which the auto-unlock path
  // then treats as already expired. Disable is the deliberate,
  // administrator-owned way to take an account out of service.
  //
  // Restore the line to bring the button back.
  // { value: 'LOCKED', label: 'Lock', icon: Lock, note: 'Blocks sign-in without changing the account.' },
]

const resetSchema = z.object({
  new_password: z.string().min(PASSWORD_MIN, `At least ${PASSWORD_MIN} characters`),
})

function IdChip({ id }) {
  const [copied, setCopied] = useState(false)
  if (!id) return null
  return (
    <button
      type="button"
      title="Copy user ID"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(id)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          /* clipboard unavailable, the id is still selectable on screen */
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-850 px-2 py-1 font-mono text-2xs text-ink-400 transition-colors hover:border-surface-600 hover:text-ink-200"
    >
      {copied ? (
        <Check className="h-3 w-3 flex-none text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
      ) : (
        <Copy className="h-3 w-3 flex-none text-ink-500" strokeWidth={1.75} />
      )}
      {String(id).slice(0, 8)}…
    </button>
  )
}

// --- Security: password ------------------------------------------------------

function ResetPasswordCard({ userId, username }) {
  const [show, setShow] = useState(false)
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm({ resolver: zodResolver(resetSchema), mode: 'onBlur', defaultValues: { new_password: '' } })

  const pw = watch('new_password') || ''
  const strength = passwordStrength(pw)

  const mutation = useMutation({
    mutationFn: ({ new_password }) => resetUserPassword(userId, new_password),
    onSuccess: () => {
      toast.success(`Password reset for ${username}`)
      reset({ new_password: '' })
      setShow(false)
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={KeyRound}>Password</CardTitle>
      </CardHeader>
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="space-y-4 p-4">
        <p className="text-sm leading-relaxed text-ink-400">
          Sets a new password immediately. The account is not signed out, and there is no email-delivery step
          on this backend - you hand the new password over yourself.
        </p>

        <Field label="New password" error={errors.new_password?.message} required htmlFor="reset-pw">
          <div className="relative">
            <input
              id="reset-pw"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              spellCheck={false}
              className={clsx(inputClass(!!errors.new_password), 'pr-20 font-mono')}
              {...register('new_password')}
            />
            <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-surface-700 hover:text-ink-100"
              >
                {show ? (
                  <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} />
                ) : (
                  <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setValue('new_password', suggestPassword(20), { shouldValidate: true })
                  setShow(true)
                }}
                aria-label="Generate a strong password"
                title="Generate a strong password"
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-surface-700 hover:text-ink-100"
              >
                <Wand2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>
          </div>
        </Field>

        {pw && (
          <div className="flex items-center gap-3">
            <div className="flex h-1.5 flex-1 gap-1">
              {[1, 2, 3, 4, 5].map((i) => (
                <span
                  key={i}
                  className={clsx(
                    'h-full flex-1 rounded-full transition-colors duration-200',
                    i <= strength.score
                      ? strength.tone === 'red'
                        ? 'bg-red-500'
                        : strength.tone === 'amber'
                          ? 'bg-amber-500'
                          : 'bg-emerald-500'
                      : 'bg-surface-750'
                  )}
                />
              ))}
            </div>
            <span className="flex-none text-2xs font-medium text-ink-400">{strength.label}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" size="sm" icon={KeyRound} loading={mutation.isPending}>
            Reset password
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => reset({ new_password: '' })}
            disabled={mutation.isPending}
          >
            Clear
          </Button>
        </div>
      </form>
    </Card>
  )
}

// --- Activity ----------------------------------------------------------------

function ActivityTab({ userId }) {
  const [selected, setSelected] = useState(null)
  const query = useQuery({
    queryKey: ['admin', 'users', userId, 'audit'],
    queryFn: ({ signal }) => auditByUser(userId, 100, signal),
    retry: false,
  })

  // auditByUser returns a plain array (no pagination envelope) capped by the
  // `limit` we ask for, so this is the last 100 events, said plainly rather
  // than dressed up as a pager that can't page.
  const rows = useMemo(() => (Array.isArray(query.data) ? query.data : []), [query.data])

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle icon={History}>Recent activity</CardTitle>
          <span className="ml-auto text-2xs font-medium uppercase tracking-[0.08em] text-ink-500">
            Last {rows.length} events
          </span>
        </CardHeader>
        <QueryState
          query={query}
          empty={(d) => !d || d.length === 0}
          emptyTitle="No recorded activity"
          emptyMessage="This account has no audit entries yet - it has not signed in or performed any recorded action."
          skeletonRows={6}
        >
          {() => (
            <AuditTable
              rows={rows}
              density="compact"
              onSelect={setSelected}
              showActor={false}
              emptyTitle="No recorded activity"
              emptyMessage="Nothing has been recorded for this account."
            />
          )}
        </QueryState>
        <CardFooter>
          <p className="text-xs leading-relaxed text-ink-500">
            Scoped to this account. The full org-wide trail, with filters and export, lives in{' '}
            <Link
              to="/admin/audit"
              className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
            >
              Audit &amp; Compliance
            </Link>
            .
          </p>
        </CardFooter>
      </Card>
      <AuditEventDrawer event={selected} onClose={() => setSelected(null)} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Access tab, the grant surface
// ---------------------------------------------------------------------------
// Rebuilt as one system rather than two ad-hoc cards. Roles and policies do the
// same job, hand something out of a catalogue the server owns, so they share
// a shell (GrantCard), a row (GrantRow) and a footer control (GrantFooter).
// One set of states, one visual language, one place to fix a bug in any of it.
//
// What the redesign is actually for, beyond looking better:
//
//   * The tab opens with a SUMMARY, so "what can this account reach" is
// answered before any scrolling. Privilege first, because that is the
// question an auditor came here to ask.
//   * A grant control is ALWAYS present, and always says which of its five
// states it is in, loading, failed, catalogue empty, everything granted,
// or ready. A control that silently disappears reads as a broken one.
//   * System roles render as LOCKED rows carrying the reason they are locked.
//     They are no longer assignable or removable here at all: `user` is set at
// creation, `admin` comes from delegation, `root` owns the install.

function StatTile({ icon: Icon, label, value, hint, accent = false }) {
  return (
    <div
      className={clsx(
        'relative overflow-hidden rounded-xl border px-4 py-3.5 transition-colors',
        accent
          ? 'border-blue-500/30 bg-blue-50/60 dark:border-blue-500/25 dark:bg-blue-500/[0.07]'
          : 'border-surface-700/70 bg-surface-900'
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={clsx(
            'h-3.5 w-3.5 flex-none',
            accent ? 'text-blue-600 dark:text-blue-300' : 'text-ink-500'
          )}
          strokeWidth={1.9}
        />
        <span className="text-xs font-semibold text-ink-500">{label}</span>
      </div>
      <p className="mt-2 truncate text-[0.95rem] font-semibold leading-tight text-ink-50">{value}</p>
      {hint && <p className="mt-1 truncate text-xs text-ink-500">{hint}</p>}
    </div>
  )
}

function GrantCard({ icon: Icon, title, count, badge, action, children, footer }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-surface-800 bg-surface-850/50 px-4 py-3">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-900 text-ink-400">
          <Icon className="h-4 w-4" strokeWidth={1.7} />
        </span>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-50">
          {title}
          {typeof count === 'number' && (
            <span className="rounded-md bg-surface-800 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-ink-400">
              {count}
            </span>
          )}
        </h3>
        <div className="ml-auto flex flex-none items-center gap-3">
          {badge}
          {action}
        </div>
      </div>
      {children}
      {footer}
    </Card>
  )
}

// One row, whether it holds a role or a policy. The action sits at 60% opacity
// until the row is hovered or focused, present for a screen reader and for
// keyboard users at all times, quiet enough that a list of twelve grants does
// not read as a wall of buttons.
function GrantRow({ icon: Icon, title, meta, description, action, muted = false }) {
  return (
    <li className="group flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-850/60">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={clsx(
            'flex h-8 w-8 flex-none items-center justify-center rounded-lg border transition-colors',
            muted
              ? 'border-surface-700/70 bg-surface-850 text-ink-500'
              : 'border-surface-700 bg-surface-900 text-ink-400 group-hover:border-surface-600'
          )}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {title}
            {meta}
          </div>
          {description && <p className="mt-1 truncate text-xs leading-relaxed text-ink-500">{description}</p>}
        </div>
      </div>
      {action && (
        <div className="flex-none opacity-60 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {action}
        </div>
      )}
    </li>
  )
}

// The five states every grant control has. Written once so roles and policies
// cannot disagree about what "nothing to add" looks like.
function GrantFooter({ query, isEmptyCatalogue, emptyCatalogue, isAllGranted, allGranted, hint, children }) {
  let body
  if (query.isLoading) {
    body = <span className="skeleton block h-9 w-64 rounded-lg" role="status" aria-label="Loading" />
  } else if (query.isError) {
    body = (
      <>
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-red-600 dark:text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-none" strokeWidth={2} />
          <span className="truncate">{apiErrorMessage(query.error)}</span>
        </span>
        <Button size="xs" variant="secondary" icon={RefreshCw} onClick={() => query.refetch()}>
          Retry
        </Button>
      </>
    )
  } else if (isEmptyCatalogue) {
    body = emptyCatalogue
  } else if (isAllGranted) {
    body = allGranted
  } else {
    body = children
  }
  return (
    <div className="border-t border-surface-800 bg-surface-850/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">{body}</div>
      {hint && (
        <p className="mt-2 flex items-start gap-2 text-2xs leading-relaxed text-ink-500">
          <Info className="mt-px h-3 w-3 flex-none" strokeWidth={1.9} />
          <span>{hint}</span>
        </p>
      )}
    </div>
  )
}

function GrantNote({ children }) {
  return <p className="min-w-0 text-xs leading-relaxed text-ink-500">{children}</p>
}

// A system role cannot be removed here, and the row says why rather than
// showing a Remove button that would fail.
function LockChip({ reason }) {
  return (
    <span
      title={reason}
      className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-850 px-2 py-1 text-2xs font-medium text-ink-500"
    >
      <Lock className="h-3 w-3 flex-none" strokeWidth={1.9} />
      Managed
    </span>
  )
}

// --- Access: administrative delegation ---------------------------------------
//
// Administrative access is no longer something an admin can hand out from the
// role dropdown. It is delegated by root through /delegate-admin, which is the
// only route that records WHY, for HOW LONG, and over WHAT, and the only one
// that can be revoked as a unit afterwards.
//
// The status itself is readable by any admin (the GET is admin-or-root), so
// this panel always renders: an ordinary admin can see that an account holds
// delegated admin and when it lapses, and simply gets no buttons. Hiding the
// whole panel from non-root would leave admins unable to answer "why does this
// person have Admin Center access?" at all.

// A blocked action never reaches the network. Marked so the error handler can
// tell "the console refused this" from "the request failed", which read as
// "Could not reach the PAM backend" if passed to apiErrorMessage unchanged.
function blockedError(message) {
  const err = new Error(message)
  err.clientBlocked = true
  return err
}

function mutationErrorMessage(err) {
  return err?.clientBlocked ? err.message : apiErrorMessage(err)
}

function DelegationRow({ label, children }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,32%)_1fr] gap-4 px-4 py-2.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-ink-100">{children ?? '-'}</dd>
    </div>
  )
}

function DelegationPanel({ query, viewerIsRoot, username, holdsAdminRole, onDelegate, onRevoke, revoking }) {
  const delegation = query.data
  const status = delegation?.status || 'none'
  const active = !!delegation?.isActive
  const expired = status === 'expired'
  const revoked = status === 'revoked'
  // A delegation that has lapsed or been taken back is history, not state ,
  // but it is history worth showing, because "this account used to be a
  // delegated admin" is the answer to a question people actually ask.
  const hasHistory = active || expired || revoked

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-surface-800 bg-surface-850/50 px-4 py-3">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-900 text-ink-400">
          <ShieldCheck className="h-4 w-4" strokeWidth={1.7} />
        </span>
        <h3 className="text-sm font-semibold text-ink-50">Administrative access</h3>
        {!query.isLoading && !query.isError && (
          <Badge className={clsx('ml-auto', delegationStatusBadgeClass(status))}>
            {delegationStatusLabel(status)}
          </Badge>
        )}
      </div>

      {query.isLoading ? (
        <div className="space-y-2 p-4" role="status" aria-label="Loading delegation status">
          <span className="skeleton block h-4 w-1/3 rounded" />
          <span className="skeleton block h-4 w-1/2 rounded" />
        </div>
      ) : query.isError ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-red-600 dark:text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 flex-none" strokeWidth={2} />
            <span className="truncate">{apiErrorMessage(query.error)}</span>
          </span>
          <Button size="xs" variant="secondary" icon={RefreshCw} onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      ) : !hasHistory ? (
        <EmptyState
          icon={ShieldOff}
          title="No admin delegation"
          description={
            viewerIsRoot
              ? 'This account has no administrative access. Delegate it below - a reason is required, and an expiry is recommended.'
              : 'This account has no administrative access. Only root users can grant it.'
          }
        />
      ) : (
        <dl className="divide-y divide-surface-800">
          <DelegationRow label="Granted role">
            <Badge className={roleBadgeClass(delegation.delegated_role)}>{delegation.delegated_role}</Badge>
          </DelegationRow>
          <DelegationRow label="Granted by">{delegation.granted_by || '-'}</DelegationRow>
          <DelegationRow label="Granted at">
            {delegation.granted_at ? formatDateTime(delegation.granted_at) : '-'}
          </DelegationRow>
          <DelegationRow label="Expires">
            {delegation.expires_at ? (
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
                {formatDateTime(delegation.expires_at)}
                <span className="text-xs text-ink-500">({formatRelativeToNow(delegation.expires_at)})</span>
              </span>
            ) : active ? (
              'No expiry - stays until revoked'
            ) : (
              '-'
            )}
          </DelegationRow>
          <DelegationRow label="Reason">{delegation.reason || '-'}</DelegationRow>
          <DelegationRow label="Scope">
            {delegation.scope_resource_ids.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {delegation.scope_resource_ids.map((rid) => (
                  <MetaTag key={rid} mono>
                    {rid}
                  </MetaTag>
                ))}
              </span>
            ) : (
              'Unscoped - every resource the admin role reaches'
            )}
          </DelegationRow>
          {revoked && (
            <>
              <DelegationRow label="Revoked at">
                {delegation.revoked_at ? formatDateTime(delegation.revoked_at) : '-'}
              </DelegationRow>
              <DelegationRow label="Revoked by">{delegation.revoked_by || '-'}</DelegationRow>
              {delegation.revoke_reason && (
                <DelegationRow label="Revoke reason">{delegation.revoke_reason}</DelegationRow>
              )}
            </>
          )}
        </dl>
      )}

      <CardFooter className="flex-wrap gap-y-2">
        {viewerIsRoot ? (
          <>
            {active ? (
              <Button size="sm" variant="dangerGhost" icon={ShieldOff} loading={revoking} onClick={onRevoke}>
                Revoke delegation
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon={ShieldCheck}
                disabled={query.isLoading || query.isError}
                onClick={onDelegate}
              >
                Delegate admin
              </Button>
            )}
            <p className="min-w-0 text-xs leading-relaxed text-ink-500">
              {active
                ? `Revoking removes the admin role from ${username} immediately. A reason is required.`
                : holdsAdminRole
                  ? 'This account already holds the admin role - delegating records it as a revocable grant with a reason behind it.'
                  : 'You hold root, so you can delegate administrative access. An admin cannot pass it on to anyone else.'}
            </p>
          </>
        ) : (
          <p className="flex min-w-0 items-start gap-2 text-xs leading-relaxed text-ink-500">
            <ShieldAlert className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
            <span>
              Only root users can grant or revoke administrative access. This panel is read-only for your
              account.
            </span>
          </p>
        )}
      </CardFooter>
    </Card>
  )
}

// --- Page --------------------------------------------------------------------

export default function IdentityDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmStatus, setConfirmStatus] = useState(null)
  const [newRole, setNewRole] = useState('')
  const [newPolicyId, setNewPolicyId] = useState('')
  const [delegateOpen, setDelegateOpen] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [confirmResetMfa, setConfirmResetMfa] = useState(false)

  // The privilege rule this page enforces, read once. Only root may grant or
  // revoke administrative access, the server returns 403 to anybody else, so
  // the console never offers those actions to an ordinary admin.
  const isRoot = useAuthStore((s) => s.isRoot())

  const userQuery = useQuery({
    queryKey: ['admin', 'users', id],
    queryFn: ({ signal }) => getUser(id, signal),
  })

  // Delegation status. Lives under the ['admin','users',id,…] prefix on
  // purpose: the page's own invalidate() already covers ['admin','users'], so
  // one call refreshes the account record AND its delegation after a grant or
  // revoke. `retry: false` because a 403/404 here is an answer, not a blip.
  const delegationQuery = useQuery({
    queryKey: ['admin', 'users', id, 'delegation'],
    queryFn: ({ signal }) => getDelegationStatus(id, signal),
    retry: false,
  })

  // THE FIX FOR "CUSTOM ROLES CANNOT BE ASSIGNED". This is the same query key
  // the Roles screen and the Create-role modal use, so react-query serves all
  // three from one cache entry: creating a role there invalidates
  // ['admin','roles'], which makes the new role selectable HERE on the next
  // render, with no extra request and no page reload.
  const rolesQuery = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: ({ signal }) => listRoles(signal),
  })

  const policiesQuery = useQuery({
    queryKey: ['admin', 'policies'],
    queryFn: ({ signal }) => listPolicies(signal),
  })

  // The ['admin','users'] prefix covers BOTH this account's record
  // (['admin','users',id]) and the Identity list's own key
  // (['admin','users',search]), the list renders a Roles column, so leaving
  // it out meant navigating Back showed access one edit out of date.
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })

  const statusMutation = useMutation({
    mutationFn: (status) => setUserStatus(id, status),
    onSuccess: (_d, status) => {
      toast.success(`Account set to ${status}`)
      invalidate()
      setConfirmStatus(null)
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setConfirmStatus(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteUser(id),
    onSuccess: () => {
      toast.success('Account deleted')
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      navigate('/admin/identity')
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setConfirmDelete(false)
    },
  })

  // Both role mutations re-check the rule at call time rather than trusting
  // that the control which triggered them was correctly hidden. The dropdown
  // and these guards read the same helper, so they cannot drift.
  const assignRoleMutation = useMutation({
    mutationFn: async (roleName) => {
      if (!isAssignableRoleName(roleName)) {
        throw blockedError(
          isAdminRoleName(roleName)
            ? 'Administrative access is granted by root through Delegate admin, not as a plain role.'
            : 'System roles are set when the account is created and cannot be assigned here.'
        )
      }
      return assignRole(id, roleName)
    },
    onSuccess: () => {
      toast.success('Role assigned')
      invalidate()
      setNewRole('')
    },
    onError: (err) => toast.error(mutationErrorMessage(err)),
  })

  const removeRoleMutation = useMutation({
    mutationFn: async (roleName) => {
      if (isSystemRoleName(roleName)) {
        throw blockedError(
          isAdminRoleName(roleName)
            ? 'Administrative access is taken back with “Revoke delegation”, which records a reason.'
            : 'System roles cannot be removed from the console.'
        )
      }
      return removeRole(id, roleName)
    },
    onSuccess: () => {
      toast.success('Role removed')
      invalidate()
    },
    onError: (err) => toast.error(mutationErrorMessage(err)),
  })

  // Revoke delegated admin. Root-only on the server; the confirm dialog that
  // drives it is only rendered for root, and this re-checks anyway.
  const revokeDelegationMutation = useMutation({
    mutationFn: async (reason) => {
      if (!isRoot) throw blockedError('Only root users can revoke admin delegation.')
      return revokeAdminDelegation(id, { reason })
    },
    onSuccess: () => {
      toast.success('Admin delegation revoked')
      invalidate()
      setConfirmRevoke(false)
    },
    onError: (err) => {
      const message = err?.clientBlocked
        ? err.message
        : normalizeApiError(err).status === 403
          ? 'Only root users can revoke admin delegation.'
          : apiErrorMessage(err)
      toast.error(message)
      setConfirmRevoke(false)
    },
  })

  // Administrative MFA reset, the lost-authenticator recovery path. The
  // server decides whether this actor may reset THIS target (root only when
  // the target is privileged); the button is disabled client-side for the
  // same rule so the console does not offer an action it knows will 403.
  const resetMfaMutation = useMutation({
    mutationFn: (reason) => resetUserMfa(id, reason),
    onSuccess: (data) => {
      toast.success(
        data?.enrollment_due
          ? `Second factor reset - ${userQuery.data?.user?.username || 'the account'} must enrol again at the next sign-in`
          : 'Second factor reset - the account can sign in with its password'
      )
      invalidate()
      setConfirmResetMfa(false)
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setConfirmResetMfa(false)
    },
  })

  const attachPolicyMutation = useMutation({
    mutationFn: (policyId) => attachPolicy(id, policyId),
    onSuccess: () => {
      toast.success('Policy attached')
      invalidate()
      setNewPolicyId('')
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const detachPolicyMutation = useMutation({
    mutationFn: (policyId) => detachPolicy(id, policyId),
    onSuccess: () => {
      toast.success('Policy detached')
      invalidate()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const TABS = [
    { key: 'overview', label: 'Overview', icon: UserRound },
    { key: 'access', label: 'Access', icon: FileKey2 },
    { key: 'security', label: 'Security', icon: ShieldCheck },
    { key: 'activity', label: 'Activity', icon: ScrollText },
  ]
  const requested = params.get('tab')
  const tab = TABS.some((t) => t.key === requested) ? requested : 'overview'
  const setTab = (key) => {
    const next = new URLSearchParams(params)
    if (key === 'overview') next.delete('tab')
    else next.set('tab', key)
    setParams(next, { replace: true })
  }

  return (
    <div>
      <QueryState query={userQuery} skeletonRows={5}>
        {(data) => {
          const user = data.user
          // GetEffectiveAccess returns `roles` as full Role objects
          // ({id, name, description, is_system}), not name strings ,
          // rendering one directly as a React child crashes with "Objects are
          // not valid as a React child". Every use here wants the plain name,
          // which is also what assignRole/removeRole send over the wire, so
          // map once up front. Likewise the field is `direct_policies`, not
          // `policies`: reading `access.policies` silently yields undefined
          // and renders an empty list rather than crashing, easy to miss
          // without testing against a real account.
          const roles = rolesOfAccess(data)
          const policies = data.access?.direct_policies || []

          // ROLES. The catalogue is every role the install actually has ,
          // built-in and custom alike, read from GET /admin/rbac/roles, not
          // from the three-name SYSTEM_ROLES constant this used to filter.
          // Assignment is matched case-insensitively because the access
          // record and the catalogue are written by two different handlers.
          const roleCatalogue = normalizeRoleList(rolesQuery.data)
          const roleByName = new Map(roleCatalogue.map((r) => [String(r.name).toLowerCase(), r]))
          const assignedNames = new Set(roles.map((r) => String(r).toLowerCase()))
          const availableRoles = roleCatalogue.filter((r) => !assignedNames.has(String(r.name).toLowerCase()))

          // THE ASSIGN RULE. Custom roles only. No system role is offered here
          // at all, `user` is set when the account is created, `admin` comes
          // from the delegation panel above, and `root` owns the install. This
          // is not a per-viewer gate: custom roles carry no administrative
          // privilege, so a non-root admin and root see exactly the same list.
          // `is_system` from the catalogue counts too: a role the server marks
          // as built-in is never offered here, whatever it is called.
          const offerable = (r) => isAssignableRoleName(r.name) && r.is_system !== true
          const assignableCustomRoles = availableRoles.filter(offerable)
          const customCatalogue = roleCatalogue.filter(offerable)
          // Never leave the select pointing at a role that has since been
          // assigned or deleted elsewhere, fall back to the placeholder.
          const roleSelectValue = assignableCustomRoles.some((r) => r.name === newRole) ? newRole : ''
          const pendingRole = roleSelectValue ? roleByName.get(roleSelectValue.toLowerCase()) : null

          // Assigned roles, split so each half can be rendered on its own terms:
          // system roles are locked rows, custom roles are removable ones.
          const isSystemHeld = (r) =>
            isSystemRoleName(r) || roleByName.get(String(r).toLowerCase())?.is_system === true
          const systemRolesHeld = roles.filter(isSystemHeld)
          const customRolesHeld = roles.filter((r) => !isSystemHeld(r))

          // DELEGATION. `delegation` is normalised in api/identity.js, so it is
          // always an object with a lowercase `status` once the query resolves.
          const delegation = delegationQuery.data
          const delegationActive = !!delegation?.isActive
          const holdsAdminRole = roles.some(isAdminRoleName)
          const holdsRootRole = roles.some(isRootRoleName)

          // POLICIES. Same treatment: the attach control is always present,
          // and says which of the four states it is in.
          const attachedIds = new Set(policies.map((p) => p.id))
          const policyCatalogue = policiesQuery.data || []
          const availablePolicies = policyCatalogue.filter((p) => !attachedIds.has(p.id))
          const policySelectValue = availablePolicies.some((p) => p.id === newPolicyId) ? newPolicyId : ''
          const hasDenyPolicy = policies.some((p) => p.effect === 'deny')
          const denyCount = policies.filter((p) => p.effect === 'deny').length

          const privileged = roles.some(isPrivilegedRoleName)
          const privilegeLabel = holdsRootRole
            ? 'Root'
            : holdsAdminRole || delegationActive
              ? 'Administrator'
              : 'Standard'
          const privilegeHint = holdsRootRole
            ? 'Owns the install'
            : delegationActive
              ? delegation?.expires_at
                ? `Delegated · ends ${formatRelativeToNow(delegation.expires_at)}`
                : 'Delegated by root'
              : holdsAdminRole
                ? 'Runs the Admin Center'
                : 'Self-service access only'

          return (
            <>
              {/* ONE HEADER, NOT A HEADER PLUS A CARD THAT REPEATS IT.
                  This was a page title carrying the username and email, then
                  a row of seven outlined chips (status, five roles, the id),
                  then a bordered card with an avatar and the username and
                  email again. Three treatments of the same identity stacked
                  on top of each other, and a chip wall in the middle of them.

                  Now: the name, the full name and email beside it, the facts
                  that decide whether this account is a live risk on one rule,
                  and the roles as plain text where they read as a sentence
                  rather than as six coloured objects. */}
              <PageHeader
                title={user.username}
                description={user.full_name || undefined}
                actions={
                  <>
                    <Button variant="secondary" icon={KeyRound} onClick={() => setTab('security')}>
                      Reset password
                    </Button>
                    <Button variant="dangerGhost" icon={Trash2} onClick={() => setConfirmDelete(true)}>
                      Delete
                    </Button>
                  </>
                }
              />

              <div className="mb-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-line-soft py-3">
                <StatusDot
                  tone={
                    user.status === 'ACTIVE'
                      ? 'ok'
                      : user.status === 'LOCKED'
                        ? 'warn'
                        : user.status === 'SUSPENDED' || user.status === 'DELETED'
                          ? 'danger'
                          : 'muted'
                  }
                  label={user.status ? user.status.charAt(0) + user.status.slice(1).toLowerCase() : 'Unknown'}
                />

                <span className="text-sm text-secondary">
                  <span className="font-mono text-primary">{user.email || '-'}</span>
                </span>

                <span className="text-sm text-secondary">
                  Last sign-in{' '}
                  <span className={user.last_login_at ? 'text-primary' : 'text-warn'}>
                    {user.last_login_at ? formatRelativeToNow(user.last_login_at) : 'never'}
                  </span>
                </span>

                <span className="text-sm text-secondary">
                  Created <span className="text-primary">{formatRelativeToNow(user.created_at)}</span>
                </span>

                {privileged && (
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium text-warn">
                    <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} /> {privilegeLabel}
                  </span>
                )}

                {/* Delegation is live but the role list has not caught up (two
                    different reads, and the grant is a second call). Say so,
                    rather than showing an account that looks ordinary while it
                    holds administrative access. */}
                {delegationActive && !holdsAdminRole && (
                  <span className="text-sm font-medium text-warn">Delegated admin</span>
                )}
                {delegationActive && delegation.expires_at && (
                  <span className="text-sm text-secondary">
                    Delegation ends {formatRelativeToNow(delegation.expires_at)}
                  </span>
                )}

                <span className="ml-auto">
                  <IdChip id={user.user_id || user.id} />
                </span>
              </div>

              {roles.length > 0 && (
                <p className="-mt-3 mb-6 text-sm text-secondary">
                  Holds{' '}
                  {roles.map((r, i) => (
                    <span key={r}>
                      {i > 0 && ', '}
                      <span className={isPrivilegedRoleName(r) ? 'font-medium text-warn' : 'text-primary'}>
                        {r}
                      </span>
                    </span>
                  ))}
                </p>
              )}

              <TabBar tabs={TABS} active={tab} onChange={setTab} className="mb-6" />

              {tab === 'overview' && (
                <div className="grid gap-5 lg:grid-cols-2">
                  <Card>
                    <CardHeader>
                      <CardTitle icon={UserRound}>Sign-in posture</CardTitle>
                    </CardHeader>
                    {/* THIS CARD USED TO REPEAT THE HEADER: username, email,
                        full name, status and id, every one of which is now on
                        the rule directly above it. A detail page whose first
                        panel restates its own title teaches the reader to skip
                        it. What belongs here is what the header cannot fit and
                        what actually decides whether this account is a risk. */}
                    <DetailList
                      items={[
                        {
                          label: 'Second factor',
                          value: user.mfa_enabled ? (
                            <StatusDot tone="ok" label="Enrolled" />
                          ) : (
                            <StatusDot tone="warn" label="Not set up" />
                          ),
                        },
                        {
                          label: 'Failed sign-ins',
                          value:
                            user.failed_login_attempts > 0 ? (
                              <span className="font-medium text-warn tabular">
                                {user.failed_login_attempts}
                              </span>
                            ) : (
                              <span className="tabular">0</span>
                            ),
                        },
                        user.locked_until
                          ? {
                              label: 'Locked until',
                              value: <span className="text-warn">{formatDateTime(user.locked_until)}</span>,
                            }
                          : null,
                        {
                          label: 'Last sign-in from',
                          value: user.last_login_ip ? (
                            <span className="font-mono text-xs">{user.last_login_ip}</span>
                          ) : (
                            'Never signed in'
                          ),
                        },
                        {
                          label: 'Protected account',
                          value: user.is_protected
                            ? 'Yes, cannot be suspended or deleted from the console'
                            : 'No',
                        },
                        {
                          label: 'Last changed',
                          value: user.updated_at ? formatDateTime(user.updated_at) : '-',
                        },
                      ].filter(Boolean)}
                    />
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle icon={ShieldCheck}>Effective access</CardTitle>
                    </CardHeader>
                    <DetailList
                      items={[
                        { label: 'Roles', value: roles.length ? roles.join(', ') : 'None assigned' },
                        {
                          label: 'Direct policies',
                          value: policies.length ? `${policies.length} attached` : 'None attached',
                        },
                        {
                          label: 'Privilege',
                          value: `${privilegeLabel}, ${privilegeHint.toLowerCase()}`,
                        },
                        {
                          label: 'Admin delegation',
                          value: delegationQuery.isLoading
                            ? 'Checking…'
                            : delegationQuery.isError
                              ? 'Unavailable'
                              : delegationStatusLabel(delegation?.status) +
                                (delegationActive && delegation.expires_at
                                  ? ` · ends ${formatDateTime(delegation.expires_at)}`
                                  : ''),
                        },
                      ]}
                    />
                    <CardFooter>
                      <Button size="sm" variant="secondary" onClick={() => setTab('access')}>
                        Manage access
                      </Button>
                    </CardFooter>
                  </Card>
                </div>
              )}

              {tab === 'access' && (
                <div className="space-y-7">
                  {/* Summary first: privilege, then reach. An auditor opening
 this tab is asking "how much can this account do?" before
 they are asking "which policy said so". */}
                  <div className="grid gap-3 sm:grid-cols-3">
                    <StatTile
                      icon={holdsRootRole ? Crown : privileged || delegationActive ? ShieldCheck : UserRound}
                      label="Privilege"
                      value={privilegeLabel}
                      hint={privilegeHint}
                      accent={privileged || delegationActive}
                    />
                    <StatTile
                      icon={Layers}
                      label="Roles"
                      value={roles.length === 0 ? 'None' : `${roles.length} assigned`}
                      hint={
                        roles.length === 0
                          ? 'Reaches nothing until a role is assigned'
                          : `${systemRolesHeld.length} system · ${customRolesHeld.length} custom`
                      }
                    />
                    <StatTile
                      icon={FileKey2}
                      label="Direct policies"
                      value={policies.length === 0 ? 'None' : `${policies.length} attached`}
                      hint={
                        denyCount > 0
                          ? `${denyCount} deny - overrides every allow`
                          : 'Exceptions attached outside its roles'
                      }
                    />
                  </div>

                  <Section label="Administrative access">
                    <DelegationPanel
                      query={delegationQuery}
                      viewerIsRoot={isRoot}
                      username={user.username}
                      holdsAdminRole={holdsAdminRole}
                      onDelegate={() => setDelegateOpen(true)}
                      onRevoke={() => setConfirmRevoke(true)}
                      revoking={revokeDelegationMutation.isPending}
                    />
                  </Section>

                  <Section
                    label="Roles"
                    action={
                      <Link
                        to="/admin/roles"
                        className="text-xs font-semibold text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400"
                      >
                        Manage roles
                      </Link>
                    }
                  >
                    <GrantCard
                      icon={ShieldCheck}
                      title="Assigned roles"
                      count={roles.length}
                      badge={
                        <span className="text-2xs font-medium uppercase tracking-[0.08em] text-ink-500">
                          RBAC
                        </span>
                      }
                      footer={
                        <GrantFooter
                          query={rolesQuery}
                          isEmptyCatalogue={customCatalogue.length === 0}
                          emptyCatalogue={
                            <GrantNote>
                              No custom roles exist yet.{' '}
                              <Link
                                to="/admin/roles?new=1"
                                className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
                              >
                                Create one
                              </Link>{' '}
                              and it becomes assignable here immediately.
                            </GrantNote>
                          }
                          isAllGranted={assignableCustomRoles.length === 0}
                          allGranted={
                            <GrantNote>
                              All {customCatalogue.length} custom role
                              {customCatalogue.length === 1 ? '' : 's'} in this install are already assigned
                              to this account.
                            </GrantNote>
                          }
                          hint="System roles are not listed here - user is set when the account is created, and administrative access is granted by root above."
                        >
                          <select
                            className={clsx(selectClass(false), 'h-9 !w-auto min-w-[14rem] py-0 text-sm')}
                            value={roleSelectValue}
                            onChange={(e) => setNewRole(e.target.value)}
                            aria-label="Custom role to assign"
                          >
                            <option value="">Add a custom role…</option>
                            {assignableCustomRoles.map((r) => (
                              <option key={r.name} value={r.name}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            variant="primary"
                            icon={Plus}
                            disabled={!roleSelectValue}
                            loading={assignRoleMutation.isPending}
                            onClick={() => roleSelectValue && assignRoleMutation.mutate(roleSelectValue)}
                          >
                            Assign
                          </Button>
                          {pendingRole && <GrantNote>{roleBlurb(pendingRole, pendingRole.name)}</GrantNote>}
                        </GrantFooter>
                      }
                    >
                      {roles.length === 0 ? (
                        <EmptyState
                          icon={ShieldCheck}
                          title="No roles assigned"
                          description="Without a role this account can authenticate but reach nothing. Add a custom role below, or delegate administrative access above."
                        />
                      ) : (
                        <ul className="divide-y divide-surface-800">
                          {roles.map((r) => {
                            const definition = roleByName.get(String(r).toLowerCase())
                            const system = isSystemHeld(r)
                            // Administrative access is taken back through the
                            // delegation route, which records a reason, never
                            // with a bare role removal. Every other system role
                            // is fixed and says so.
                            const revocable = isAdminRoleName(r) && isRoot && delegationActive
                            return (
                              <GrantRow
                                key={r}
                                icon={system ? (isRootRoleName(r) ? Crown : ShieldCheck) : Tag}
                                muted={system}
                                title={<Badge className={roleBadgeClass(r)}>{r}</Badge>}
                                meta={<MetaTag>{system ? 'System' : 'Custom'}</MetaTag>}
                                description={roleBlurb(definition, r)}
                                action={
                                  revocable ? (
                                    <Button
                                      size="xs"
                                      variant="dangerGhost"
                                      icon={ShieldOff}
                                      onClick={() => setConfirmRevoke(true)}
                                      title="Revoke this delegation - a reason is recorded"
                                      aria-label={`Revoke administrative access from ${user.username}`}
                                    >
                                      Revoke
                                    </Button>
                                  ) : system ? (
                                    <LockChip reason={systemRoleLockReason(r)} />
                                  ) : (
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      icon={X}
                                      loading={
                                        removeRoleMutation.isPending && removeRoleMutation.variables === r
                                      }
                                      onClick={() => removeRoleMutation.mutate(r)}
                                      aria-label={`Remove ${r} role`}
                                    >
                                      Remove
                                    </Button>
                                  )
                                }
                              />
                            )
                          })}
                        </ul>
                      )}
                    </GrantCard>
                  </Section>

                  <Section
                    label="Direct policies"
                    action={
                      <Link
                        to="/admin/policies"
                        className="text-xs font-semibold text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400"
                      >
                        Manage policies
                      </Link>
                    }
                  >
                    <GrantCard
                      icon={FileKey2}
                      title="Attached directly"
                      count={policies.length}
                      badge={
                        <span className="text-2xs font-medium uppercase tracking-[0.08em] text-ink-500">
                          PBAC
                        </span>
                      }
                      footer={
                        <GrantFooter
                          query={policiesQuery}
                          isEmptyCatalogue={policyCatalogue.length === 0}
                          emptyCatalogue={
                            <GrantNote>
                              No policies are defined in this install.{' '}
                              <Link
                                to="/admin/policies?new=1"
                                className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
                              >
                                Write one
                              </Link>{' '}
                              to attach it here or to a role.
                            </GrantNote>
                          }
                          isAllGranted={availablePolicies.length === 0}
                          allGranted={
                            <GrantNote>
                              All {policyCatalogue.length} polic{policyCatalogue.length === 1 ? 'y' : 'ies'}{' '}
                              defined in this install are already attached to this account.
                            </GrantNote>
                          }
                          hint="Prefer a role when the same permission is needed by more than one account - direct policies are for exceptions."
                        >
                          <select
                            className={clsx(selectClass(false), 'h-9 !w-auto min-w-[15rem] py-0 text-sm')}
                            value={policySelectValue}
                            onChange={(e) => setNewPolicyId(e.target.value)}
                            aria-label="Policy to attach"
                          >
                            <option value="">Attach a policy…</option>
                            {availablePolicies.map((p) => (
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
                            disabled={!policySelectValue}
                            loading={attachPolicyMutation.isPending}
                            onClick={() =>
                              policySelectValue && attachPolicyMutation.mutate(policySelectValue)
                            }
                          >
                            Attach
                          </Button>
                        </GrantFooter>
                      }
                    >
                      {policies.length === 0 ? (
                        <EmptyState
                          icon={FileKey2}
                          title="No direct policies"
                          description="This account's permissions come entirely from its roles. Direct policies are for exceptions - grant them sparingly."
                        />
                      ) : (
                        <ul className="divide-y divide-surface-800">
                          {policies.map((p) => (
                            <GrantRow
                              key={p.id}
                              icon={FileKey2}
                              title={
                                <span className="truncate text-sm font-medium text-ink-100">{p.name}</span>
                              }
                              meta={
                                p.effect ? (
                                  <Badge className={POLICY_EFFECT_BADGE[p.effect]}>{p.effect}</Badge>
                                ) : null
                              }
                              description={
                                p.description ||
                                `${(p.actions || []).length} action${(p.actions || []).length === 1 ? '' : 's'} · ${(p.resources || []).length} resource pattern${(p.resources || []).length === 1 ? '' : 's'}`
                              }
                              action={
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  icon={X}
                                  loading={
                                    detachPolicyMutation.isPending && detachPolicyMutation.variables === p.id
                                  }
                                  onClick={() => detachPolicyMutation.mutate(p.id)}
                                  aria-label={`Detach ${p.name}`}
                                >
                                  Detach
                                </Button>
                              }
                            />
                          ))}
                        </ul>
                      )}

                      {/* Deny beats every allow the account holds, from any
 role, said here because this is the one other place a
 deny can be granted. */}
                      {hasDenyPolicy && (
                        <div className="flex items-start gap-2.5 border-t border-surface-800 bg-amber-50 px-4 py-3 dark:bg-amber-950/25">
                          <AlertTriangle
                            className="mt-px h-3.5 w-3.5 flex-none text-amber-600 dark:text-amber-400"
                            strokeWidth={1.75}
                          />
                          <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                            A <span className="font-semibold">deny</span> policy is attached directly to this
                            account. Deny wins over every allow it holds, from any role.
                          </p>
                        </div>
                      )}
                    </GrantCard>
                  </Section>
                </div>
              )}

              {tab === 'security' && (
                <div className="space-y-7">
                  <Section label="Credentials">
                    <ResetPasswordCard userId={id} username={user.username} />
                  </Section>

                  <Section label="Second factor">
                    <Card>
                      <CardHeader>
                        <CardTitle icon={Smartphone}>Multi-factor authentication</CardTitle>
                      </CardHeader>
                      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="max-w-xl">
                          <p className="text-sm leading-relaxed text-ink-400">
                            Removes every authenticator registered to this account - the recovery path when
                            someone loses their phone and has no backup codes left. It does not enrol
                            anything: the account signs in with its password alone until it registers a new
                            authenticator
                            {delegationActive || holdsAdminRole || holdsRootRole
                              ? ', and an MFA policy rule may force that at the very next sign-in'
                              : ''}
                            .
                          </p>
                          {!isRoot && privileged && (
                            <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                              <ShieldAlert className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.9} />
                              This is a privileged account, so only a root user can reset its second factor.
                            </p>
                          )}
                        </div>
                        <Button
                          variant="dangerGhost"
                          icon={ShieldOff}
                          className="flex-none"
                          disabled={!isRoot && privileged}
                          loading={resetMfaMutation.isPending}
                          onClick={() => setConfirmResetMfa(true)}
                        >
                          Reset MFA
                        </Button>
                      </div>
                      <CardFooter>
                        <p className="text-xs leading-relaxed text-ink-500">
                          Recorded with your name and the reason you give. Confirm the person&apos;s identity
                          out of band first - this is the one action that removes a second factor without
                          knowing the account&apos;s password.
                        </p>
                      </CardFooter>
                    </Card>
                  </Section>

                  <Section label="Lifecycle">
                    <Card>
                      <CardHeader>
                        <CardTitle icon={UserRound}>Account state</CardTitle>
                        <Badge className={clsx('ml-auto', USER_STATUS_BADGE[user.status])}>
                          {user.status || 'UNKNOWN'}
                        </Badge>
                      </CardHeader>
                      <div className="grid gap-2 p-4 sm:grid-cols-3">
                        {STATUS_TRANSITIONS.filter((s) => s.value !== user.status).map((s) => (
                          <button
                            key={s.value}
                            type="button"
                            onClick={() => setConfirmStatus(s.value)}
                            className="flex items-start gap-3 rounded-xl border border-surface-700 bg-surface-850 px-3 py-2.5 text-left transition-colors hover:border-surface-600 hover:bg-surface-800"
                          >
                            <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-900 text-ink-400">
                              <s.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </span>
                            <span className="min-w-0">
                              <span className="block text-sm font-medium text-ink-100">{s.label}</span>
                              <span className="mt-0.5 block text-2xs leading-relaxed text-ink-500">
                                {s.note}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                      <CardFooter>
                        <p className="text-xs leading-relaxed text-ink-500">
                          Every state change takes effect immediately and is written to the audit log with
                          your name against it.
                        </p>
                      </CardFooter>
                    </Card>
                  </Section>

                  <Section label="Danger zone">
                    <Card className="border-red-300/70 dark:border-red-900/50">
                      <CardHeader className="border-red-200/70 bg-red-50/60 dark:border-red-900/40 dark:bg-red-950/20">
                        <CardTitle icon={Trash2}>Delete this account</CardTitle>
                      </CardHeader>
                      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <p className="max-w-xl text-sm leading-relaxed text-ink-400">
                          Permanently removes the account. Its audit history remains - the trail is
                          append-only - but the account cannot be restored, and any credentials or grants it
                          held stop working immediately. Disabling is almost always the better answer.
                        </p>
                        <Button
                          variant="danger"
                          icon={Trash2}
                          className="flex-none"
                          onClick={() => setConfirmDelete(true)}
                        >
                          Delete account
                        </Button>
                      </div>
                    </Card>
                  </Section>
                </div>
              )}

              {tab === 'activity' && <ActivityTab userId={id} />}

              <ConfirmDialog
                open={!!confirmStatus}
                title={`Set ${user.username} to ${confirmStatus}?`}
                description="This changes the account's ability to sign in immediately."
                confirmLabel={`Set ${confirmStatus}`}
                destructive={confirmStatus === 'DISABLED' || confirmStatus === 'LOCKED'}
                isLoading={statusMutation.isPending}
                onConfirm={() => statusMutation.mutate(confirmStatus)}
                onCancel={() => setConfirmStatus(null)}
              />

              {/* Both delegation surfaces are rendered for root only, the
 server would 403 anybody else, and an action that always
 fails is worse than no action at all. */}
              {isRoot && (
                <>
                  <DelegateAdminModal
                    open={delegateOpen}
                    onClose={() => setDelegateOpen(false)}
                    userId={id}
                    username={user.username}
                    holdsAdminRole={holdsAdminRole}
                    onDelegated={invalidate}
                  />

                  <ConfirmDialog
                    open={confirmRevoke}
                    title={`Revoke delegated admin from “${user.username}”?`}
                    description="The admin role is removed immediately and the account loses Admin Center access."
                    confirmLabel="Revoke delegation"
                    destructive
                    requireReason
                    reasonLabel="Reason for revoking"
                    isLoading={revokeDelegationMutation.isPending}
                    onConfirm={(reason) => revokeDelegationMutation.mutate(reason)}
                    onCancel={() => setConfirmRevoke(false)}
                  />
                </>
              )}

              <ConfirmDialog
                open={confirmResetMfa}
                title={`Reset multi-factor authentication for “${user.username}”?`}
                description="Every registered authenticator is removed. The account signs in with its password until it enrols again."
                confirmLabel="Reset second factor"
                destructive
                requireReason
                reasonLabel="Reason (recorded)"
                isLoading={resetMfaMutation.isPending}
                onConfirm={(reason) => resetMfaMutation.mutate(reason)}
                onCancel={() => setConfirmResetMfa(false)}
              />

              <ConfirmDialog
                open={confirmDelete}
                title={`Delete “${user.username}” permanently?`}
                description="The account is removed and cannot be restored. Its audit history is retained."
                confirmLabel="Delete account"
                destructive
                requireReason
                reasonLabel="Reason for deletion"
                isLoading={deleteMutation.isPending}
                onConfirm={() => deleteMutation.mutate()}
                onCancel={() => setConfirmDelete(false)}
              />
            </>
          )
        }}
      </QueryState>
    </div>
  )
}
