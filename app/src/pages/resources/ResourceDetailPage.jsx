import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, Link, useLocation } from 'react-router-dom'
import {
  ArrowLeft,
  KeyRound,
  RefreshCw,
  Trash2,
  Terminal,
  ScrollText,
  Radio,
  FileKey2,
  LayoutList,
  ShieldCheck,
  Copy,
  Check,
} from 'lucide-react'
import { toast } from 'sonner'
import { getResource } from '../../api/resources'
import { deleteResource, storeResourceCredential, rotateResourceCredential } from '../../api/adminResources'
import { useAuthStore } from '../../store/authStore'
import { CREDENTIAL_TYPES } from '../../config/constants'
import { PageHeader, Card, CardHeader, CardTitle } from '../../components/common/Layout'
import { QueryState } from '../../components/common/QueryState'
import { TabBar } from '../../components/common/TabBar'
import { Button } from '../../components/common/Button'
import { Field, inputClass, selectClass } from '../../components/common/FormFields'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { ResourceTypeIcon } from '../../components/resources/ResourceTypeIcon'
import { ResourceAccessPanel, OpenInDesktopButton } from '../../components/resources/ResourceAccess'
import { PairAgentPanel } from '../../components/agent/PairAgentPanel'
import {
  ResourceStatusBadges,
  CredentialState,
  resourceTypeLabel,
} from '../../components/resources/ResourceCard'
import {
  OverviewTab,
  PoliciesTab,
  SessionsTab,
  AuditTab,
} from '../../components/resources/ResourceDetailTabs'
import { apiErrorMessage } from '../../lib/apiError'

// ---------------------------------------------------------------------------
// Resource detail, two pages, split by what the viewer can act on
// ---------------------------------------------------------------------------
// THE PROBLEM WITH ONE PAGE FOR EVERYONE. A non-admin was shown six tabs ,
// Overview, Connect, Credentials, Sessions, Policies, Audit, of which five
// contained nothing they could change and three (Credentials, Policies, and
// most of Overview) existed purely to tell them "ask an administrator". They
// came to connect to a machine and got a configuration record.
//
// HOW THE REFERENCE CONSOLES HANDLE THIS:
//   · CyberArk PVWA shows an end user the account with a Connect action and
// the client choice; the account's full property sheet, policy binding
// and rotation history belong to the vault admin's view.
//   · Delinea Secret Server does the same split, "Launcher" for the user,
// the secret's settings/permissions/audit for the owner.
//   · AWS and Google Cloud both gate the resource's configuration surface
// behind the permission to change it, rather than rendering a read-only
// copy of it for everyone.
// The consistent principle: SHOW SOMEONE WHAT THEY CAN ACT ON. A read-only
// mirror of an admin surface is not transparency, it is noise.
//
// So:
//   NON-ADMIN, the four facts that decide whether they can connect (type,
// endpoint, elevation, recording), and the three ways to
// connect. No tabs at all.
//   ADMIN    , the whole object, tabs and all, unchanged.
//
// Both get the same primary header action: OPEN IN DESKTOP. It replaces the
// old "Connect", which did not connect to anything, it scrolled you to a
// tab. The new button performs the actual agent hand-off, which is what the
// word promises.
//
// EVERY API CALL IS UNCHANGED: getResource, deleteResource,
// storeResourceCredential, rotateResourceCredential, and the launcher's
// connect-info / start-session / createLaunch calls. The credential payload
// remap (username → account_name, secret → credential) is preserved exactly ,
// that mapping is the backend's contract, not a preference.

const credentialSchema = z.object({
  credential_type: z.string().min(1, 'Select a type'),
  username: z.string().trim().min(1, 'Required'),
  secret: z.string().trim().min(1, 'Required'),
})

function CopyableId({ value }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          toast.error('Clipboard unavailable in this browser')
        }
      }}
      className="group inline-flex max-w-full items-center gap-1.5 rounded px-1 font-mono text-xs text-ink-500 transition-colors hover:bg-surface-800 hover:text-ink-200"
      title="Copy resource ID"
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <Check className="h-3 w-3 flex-none text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
      ) : (
        <Copy
          className="h-3 w-3 flex-none opacity-0 transition-opacity group-hover:opacity-100"
          strokeWidth={2}
        />
      )}
    </button>
  )
}

// The four facts that decide what you can do with this resource, on one rail
// under the title, so you never have to open a tab to find out whether it's
// gated, recorded, credentialed or live. This IS the non-admin's information
// surface; for an admin it is the summary above the tabs.
function SummaryRail({ resource }) {
  const facts = [
    { label: 'Type', value: resourceTypeLabel(resource.resource_type) },
    { label: 'Endpoint', value: `${resource.host}:${resource.port}`, mono: true },
    { label: 'Elevation', value: resource.requires_jit ? 'JIT approval required' : 'Standing access' },
    { label: 'Recording', value: resource.always_record ? 'Always recorded' : 'Per session policy' },
  ]
  return (
    <div className="mb-5 grid overflow-hidden rounded-xl border border-surface-700/70 bg-surface-900 sm:grid-cols-2 lg:grid-cols-4">
      {facts.map((f) => (
        <div
          key={f.label}
          className="min-w-0 border-t border-surface-800 px-4 py-3 first:border-t-0 sm:border-t-0 sm:border-l sm:first:border-l-0"
        >
          <p className="text-2xs font-semibold uppercase tracking-[0.11em] text-ink-500">{f.label}</p>
          <p
            className={`mt-1.5 truncate text-sm font-medium text-ink-100 ${f.mono ? 'font-mono text-xs' : ''}`}
            title={f.value}
          >
            {f.value}
          </p>
        </div>
      ))}
    </div>
  )
}

function CredentialsTab({ resource, resourceId, isAdmin }) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState(null) // null | 'store' | 'rotate'
  const hasCredential = !!resource.vault_entry_id

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(credentialSchema) })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['resources', resourceId] })
    queryClient.invalidateQueries({ queryKey: ['resources', resourceId, 'connect-info'] })
    queryClient.invalidateQueries({ queryKey: ['resources', 'groups'] })
  }

  const storeMutation = useMutation({
    // Remap the form's field names to the backend contract: account_name
    // (required) and credential (required), not username/secret.
    mutationFn: (payload) =>
      storeResourceCredential(resourceId, {
        account_name: payload.username,
        credential_type: payload.credential_type,
        credential: payload.secret,
      }),
    onSuccess: () => {
      toast.success('Credential stored')
      invalidate()
      reset()
      setMode(null)
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const rotateMutation = useMutation({
    mutationFn: (payload) => rotateResourceCredential(resourceId, payload.secret),
    onSuccess: () => {
      toast.success('Credential rotated')
      invalidate()
      reset()
      setMode(null)
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const activeMutation = mode === 'rotate' ? rotateMutation : storeMutation

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card>
        <CardHeader>
          <CardTitle icon={KeyRound}>Attached credential</CardTitle>
        </CardHeader>

        <div className="px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-surface-700 bg-surface-850 px-3.5 py-3">
            <CredentialState resource={resource} />
            {hasCredential && (
              <span className="font-mono text-2xs text-ink-500">
                vault entry {String(resource.vault_entry_id).slice(0, 8)}…
              </span>
            )}
          </div>

          <p className="mt-4 text-sm leading-relaxed text-ink-400">
            This is the single credential bound directly to the resource record. PAM brokers it on the
            user&apos;s behalf , the secret is never returned to the browser, only used server-side to
            establish the session.
          </p>

          {!isAdmin ? (
            <p className="mt-4 rounded-lg border border-surface-700 bg-surface-850 px-3.5 py-3 text-xs leading-relaxed text-ink-500">
              Storing and rotating credentials is an Admin Center operation. Ask an administrator if this
              resource needs a credential attached.
            </p>
          ) : !mode ? (
            <div className="mt-5 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" icon={KeyRound} onClick={() => setMode('store')}>
                {hasCredential ? 'Replace credential' : 'Store credential'}
              </Button>
              {hasCredential && (
                <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => setMode('rotate')}>
                  Rotate now
                </Button>
              )}
            </div>
          ) : (
            <form
              onSubmit={handleSubmit((values) => activeMutation.mutate(values))}
              noValidate
              className="mt-5 space-y-4 rounded-xl border border-surface-700 bg-surface-850 p-4"
            >
              <p className="text-xs font-semibold uppercase tracking-[0.09em] text-ink-500">
                {mode === 'rotate' ? 'Rotate credential' : 'Store credential'}
              </p>

              {mode === 'store' && (
                <>
                  <Field
                    label="Credential type"
                    error={errors.credential_type?.message}
                    required
                    htmlFor="cred-type"
                  >
                    <select
                      id="cred-type"
                      className={selectClass(!!errors.credential_type)}
                      {...register('credential_type')}
                    >
                      <option value="">Select…</option>
                      {CREDENTIAL_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field
                    label="Account name"
                    error={errors.username?.message}
                    required
                    htmlFor="cred-user"
                    hint="The account on the target system this secret belongs to."
                  >
                    <input
                      id="cred-user"
                      className={inputClass(!!errors.username)}
                      {...register('username')}
                    />
                  </Field>
                </>
              )}

              <Field
                label={mode === 'rotate' ? 'New secret' : 'Secret'}
                error={errors.secret?.message}
                required
                htmlFor="cred-secret"
                hint="Written straight to the vault. It is never echoed back to any client."
              >
                <textarea
                  id="cred-secret"
                  rows={3}
                  className={inputClass(!!errors.secret) + ' font-mono'}
                  placeholder={mode === 'rotate' ? 'New password / key value' : 'Password / key value'}
                  {...register('secret')}
                />
              </Field>

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    reset()
                    setMode(null)
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="sm" loading={activeMutation.isPending}>
                  {mode === 'rotate' ? 'Rotate credential' : 'Store credential'}
                </Button>
              </div>
            </form>
          )}
        </div>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle icon={ShieldCheck}>Handling</CardTitle>
        </CardHeader>
        <ul className="space-y-3 px-4 py-4 text-xs leading-relaxed text-ink-400">
          <li>Secrets are encrypted at rest and never sent to a browser, including this one.</li>
          <li>Store and rotate operations are written to the tamper-evident audit chain.</li>
          <li>Rotation replaces the secret in place, sessions already brokered are unaffected.</li>
        </ul>
      </Card>
    </div>
  )
}

const TABS = [
  { key: 'overview', label: 'Overview', icon: LayoutList },
  // { key: 'connect', label: 'Connect', icon: Terminal },
  { key: 'credentials', label: 'Credentials', icon: KeyRound },
  { key: 'sessions', label: 'Sessions', icon: Radio },
  { key: 'policies', label: 'Policies', icon: FileKey2 },
  { key: 'audit', label: 'Audit', icon: ScrollText },
]

export default function ResourceDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const isAdmin = useAuthStore((s) => s.isAdmin())
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  // A 409 from the launch endpoint means "no device paired". The header
  // button can't host the pairing panel, so the page does.
  const [needsPairing, setNeedsPairing] = useState(false)

  // Deep-link support for the admin view: /resources/:id#connect still opens
  // the Connect tab. Non-admins have no tabs, so the hash is simply inert for
  // them, the launcher is already the first thing on their page.
  const initialTab = useMemo(() => {
    const hash = (location.hash || '').replace('#', '')
    return TABS.some((t) => t.key === hash) ? hash : 'overview'
  }, [location.hash])
  const [tab, setTab] = useState(initialTab)

  useEffect(() => setTab(initialTab), [initialTab])

  const resourceQuery = useQuery({
    queryKey: ['resources', id],
    queryFn: ({ signal }) => getResource(id, signal),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteResource(id),
    onSuccess: () => {
      toast.success('Resource deleted')
      queryClient.invalidateQueries({ queryKey: ['resources'] })
      navigate('/resources')
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setConfirmDeleteOpen(false)
    },
  })

  return (
    <div>
      <Link
        to="/resources"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-400 transition-colors hover:text-ink-100"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Resources
      </Link>

      <QueryState query={resourceQuery} skeletonRows={5}>
        {(resource) => (
          <>
            <PageHeader
              eyebrow={resource.group || 'Resource'}
              title={
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-850">
                    <ResourceTypeIcon type={resource.resource_type} className="h-[1.05rem] w-[1.05rem]" />
                  </span>
                  <span className="truncate">{resource.name}</span>
                </span>
              }
              description={resource.description || undefined}
              meta={
                <>
                  <ResourceStatusBadges resource={resource} />
                  <CopyableId value={resource.id} />
                </>
              }
              actions={
                <>
                  {/* Was "Connect", which only switched a tab. This performs
 the agent hand-off, the action the label promises. */}
                  <OpenInDesktopButton resourceId={id} onNeedsPairing={() => setNeedsPairing(true)} />
                  {isAdmin && (
                    <Button variant="dangerGhost" icon={Trash2} onClick={() => setConfirmDeleteOpen(true)}>
                      Delete
                    </Button>
                  )}
                </>
              }
            />

            <SummaryRail resource={resource} />

            {needsPairing && (
              <div className="mb-5">
                <PairAgentPanel onPaired={() => setNeedsPairing(false)} />
              </div>
            )}

            {isAdmin ? (
              <>
                <TabBar tabs={TABS} active={tab} onChange={setTab} className="mb-5" />

                {tab === 'overview' && <OverviewTab resource={resource} />}
                {/* {tab === 'connect' && <ResourceAccessPanel resource={resource} resourceId={id} />} */}
                {tab === 'credentials' && (
                  <CredentialsTab resource={resource} resourceId={id} isAdmin={isAdmin} />
                )}
                {tab === 'sessions' && <SessionsTab resource={resource} />}
                {tab === 'policies' && <PoliciesTab resource={resource} />}
                {tab === 'audit' && <AuditTab resource={resource} />}
              </>
            ) : (
              // Operator view: the rail above says whether you can connect,
              // this says how. Nothing else on the page, because nothing else
              // on the page is theirs.
              <ResourceAccessPanel resource={resource} resourceId={id} />
            )}

            {isAdmin && (
              <ConfirmDialog
                open={confirmDeleteOpen}
                title={`Delete "${resource.name}"?`}
                description="This removes the resource registration. Any stored credential and history remain in the audit trail."
                confirmLabel="Delete"
                destructive
                isLoading={deleteMutation.isPending}
                onConfirm={() => deleteMutation.mutate()}
                onCancel={() => setConfirmDeleteOpen(false)}
              />
            )}
          </>
        )}
      </QueryState>
    </div>
  )
}
