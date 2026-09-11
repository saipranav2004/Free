import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import {
  Eye,
  History,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  Clock,
  Hash,
  FileText,
  Wand2,
  EyeOff,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import clsx from 'clsx'
import {
  getCredential,
  createCredentialVersion,
  passwordChange,
  requestCredentialRotation,
} from '../../api/vault'
import {
  PageHeader,
  Card,
  CardHeader,
  CardTitle,
  CardFooter,
  DetailList,
} from '../../components/common/Layout'
import { QueryState } from '../../components/common/QueryState'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { Field, inputClass } from '../../components/common/FormFields'
import { SegmentedControl } from '../../components/common/SegmentedControl'
import { RevealCredentialModal } from '../../components/vault/RevealCredentialModal'
import { formatDateTime, formatDate } from '../../lib/format'
import { apiErrorMessage } from '../../lib/apiError'
import { passwordStrength, suggestPassword } from '../../lib/validators'

// ---------------------------------------------------------------------------
// Credential detail
// ---------------------------------------------------------------------------
// Two jobs, given equal weight: read the credential's posture (what it is,
// how it rotates, whether it's overdue) and change its secret. The old page
// stacked two near-identical forms with no explanation of when to use which;
// they are now one panel with an explicit mode switch and the difference
// stated in words.

const versionSchema = z.object({
  secret_plaintext: z.string().min(1, 'The new secret is required'),
  reason: z.string().trim().max(300).optional(),
})

function SecretField({ register, name, error, showGenerate = true, setValue, rows = 3 }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      {show ? (
        <textarea
          rows={rows}
          spellCheck={false}
          className={clsx(inputClass(!!error), 'pr-20 font-mono text-xs')}
          {...register(name)}
        />
      ) : (
        <input
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          className={clsx(inputClass(!!error), 'pr-20 font-mono')}
          {...register(name)}
        />
      )}
      <div className="absolute right-1.5 top-2 flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? 'Hide secret' : 'Show secret'}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-surface-700 hover:text-ink-100"
        >
          {show ? (
            <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} />
          ) : (
            <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
        </button>
        {showGenerate && (
          <button
            type="button"
            onClick={() => {
              setValue(name, suggestPassword(24), { shouldValidate: true })
              setShow(true)
            }}
            aria-label="Generate a strong value"
            title="Generate a strong value"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-surface-700 hover:text-ink-100"
          >
            <Wand2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>
    </div>
  )
}

function UpdateSecretPanel({ credentialId }) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState('version')

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm({ resolver: zodResolver(versionSchema), mode: 'onBlur' })

  const secret = watch('secret_plaintext') || ''
  const strength = passwordStrength(secret)

  const mutation = useMutation({
    mutationFn: (values) =>
      mode === 'version'
        ? createCredentialVersion(credentialId, values.secret_plaintext, values.reason)
        : passwordChange(credentialId, values.secret_plaintext),
    onSuccess: () => {
      toast.success(mode === 'version' ? 'New version stored' : 'Password changed')
      queryClient.invalidateQueries({ queryKey: ['vault', 'credentials', credentialId] })
      reset({ secret_plaintext: '', reason: '' })
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={History}>Update the secret</CardTitle>
        <SegmentedControl
          size="sm"
          className="ml-auto"
          ariaLabel="Update mode"
          value={mode}
          onChange={setMode}
          options={[
            { key: 'version', label: 'New version' },
            { key: 'quick', label: 'Quick change' },
          ]}
        />
      </CardHeader>

      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="space-y-4 p-4">
        <p className="text-xs leading-relaxed text-ink-500">
          {mode === 'version'
            ? 'Stores a new version with your own reason attached. Previous versions stay retrievable until the safe’s retention window expires.'
            : 'Same audit trail, with a fixed reason of “Manual password change”. Use it when you’re rotating in a hurry and the reason adds nothing.'}
        </p>

        <Field label="New secret" error={errors.secret_plaintext?.message} required>
          <SecretField
            register={register}
            name="secret_plaintext"
            error={errors.secret_plaintext}
            setValue={setValue}
          />
        </Field>

        {secret && (
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

        {mode === 'version' && (
          <Field
            label="Reason"
            hint="Optional, recorded with the version in the audit trail."
            error={errors.reason?.message}
          >
            <input
              className={inputClass(!!errors.reason)}
              placeholder="Quarterly rotation"
              {...register('reason')}
            />
          </Field>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" variant="primary" size="sm" icon={ShieldCheck} loading={mutation.isPending}>
            {mode === 'version' ? 'Store new version' : 'Change password'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => reset({ secret_plaintext: '', reason: '' })}
            disabled={mutation.isPending}
          >
            Clear
          </Button>
        </div>
      </form>
    </Card>
  )
}

export default function CredentialDetailPage() {
  const { credentialId } = useParams()
  const queryClient = useQueryClient()
  const [revealOpen, setRevealOpen] = useState(false)

  const credentialQuery = useQuery({
    queryKey: ['vault', 'credentials', credentialId],
    queryFn: ({ signal }) => getCredential(credentialId, signal),
  })

  const rotationMutation = useMutation({
    mutationFn: () => requestCredentialRotation(credentialId),
    onSuccess: (job) => {
      toast.success(`Rotation job ${job?.status === 'pending' ? 'queued' : job?.status || 'submitted'}`)
      queryClient.invalidateQueries({ queryKey: ['vault', 'credentials', credentialId] })
    },
    // A 409 means a rotation is already in progress
    // (services.ErrRotationInProgress); the normalized message covers it, and
    // disabling the button while pending stops most double-submits reaching
    // the server at all.
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  return (
    <div>
      <QueryState query={credentialQuery} skeletonRows={5}>
        {(cred) => {
          const overdue = cred.next_rotation_at && new Date(cred.next_rotation_at).getTime() < Date.now()
          return (
            <>
              <PageHeader
                title={cred.name}
                description={cred.description || `${cred.account_name} · ${cred.credential_type}`}
                meta={
                  <>
                    <Badge
                      className={
                        String(cred.status).toLowerCase() === 'active'
                          ? 'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30'
                          : 'bg-slate-100 text-slate-600 ring-slate-600/20 dark:bg-ink-500/15 dark:text-ink-400 dark:ring-ink-500/30'
                      }
                    >
                      {cred.status}
                    </Badge>
                    {cred.is_breakglass && (
                      <Badge className="bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30">
                        Break-glass
                      </Badge>
                    )}
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-850 px-2 py-1 font-mono text-2xs text-ink-400">
                      <Hash className="h-3 w-3 text-ink-500" strokeWidth={1.75} />v{cred.version}
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-surface-700 bg-surface-850 px-2 py-1 text-2xs font-medium text-ink-400">
                      <FileText className="h-3 w-3 text-ink-500" strokeWidth={1.75} />
                      {cred.account_name}
                    </span>
                  </>
                }
                actions={
                  <Button variant="primary" icon={Eye} onClick={() => setRevealOpen(true)}>
                    Reveal secret
                  </Button>
                }
              />

              {overdue && (
                <div className="mb-5 flex items-start gap-3 rounded-xl border border-amber-300/70 bg-amber-50 px-4 py-3 dark:border-amber-900/40 dark:bg-amber-950/25">
                  <ShieldAlert
                    className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400"
                    strokeWidth={1.75}
                  />
                  <p className="text-sm leading-relaxed text-amber-800 dark:text-amber-200">
                    <span className="font-semibold">Rotation is overdue.</span> This credential was due for
                    rotation on {formatDate(cred.next_rotation_at)}.
                  </p>
                </div>
              )}

              <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
                <div className="min-w-0 space-y-5">
                  <Card>
                    <CardHeader>
                      <CardTitle icon={KeyRound}>Credential</CardTitle>
                    </CardHeader>
                    <DetailList
                      items={[
                        { label: 'Account', value: cred.account_name },
                        { label: 'Type', value: cred.credential_type },
                        { label: 'Status', value: cred.status },
                        { label: 'Current version', value: `v${cred.version}` },
                        { label: 'Description', value: cred.description || '-' },
                        {
                          label: 'Break-glass',
                          value: cred.is_breakglass
                            ? cred.breakglass_note || 'Emergency-access credential'
                            : 'No',
                        },
                        {
                          label: 'Credential ID',
                          value: <span className="font-mono text-xs">{cred.id}</span>,
                        },
                      ]}
                    />
                  </Card>

                  <UpdateSecretPanel credentialId={credentialId} />
                </div>

                <div className="space-y-5">
                  <Card>
                    <CardHeader>
                      <CardTitle icon={RefreshCw}>Rotation</CardTitle>
                    </CardHeader>
                    <DetailList
                      items={[
                        {
                          label: 'Schedule',
                          value:
                            cred.rotation_interval_days > 0
                              ? `Every ${cred.rotation_interval_days} days`
                              : 'Manual only',
                        },
                        { label: 'Last rotated', value: formatDateTime(cred.last_rotated_at) },
                        {
                          label: 'Next due',
                          value: cred.next_rotation_at ? (
                            <span
                              className={
                                overdue ? 'font-medium text-amber-600 dark:text-amber-400' : undefined
                              }
                            >
                              {formatDateTime(cred.next_rotation_at)}
                            </span>
                          ) : (
                            '-'
                          ),
                        },
                      ]}
                    />
                    <CardFooter>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={RefreshCw}
                        block
                        loading={rotationMutation.isPending}
                        onClick={() => rotationMutation.mutate()}
                      >
                        Request rotation now
                      </Button>
                    </CardFooter>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle icon={Clock}>Access rules</CardTitle>
                    </CardHeader>
                    <div className="space-y-3 p-4 text-xs leading-relaxed text-ink-400">
                      <p>
                        Revealing this secret requires an MFA-verified session and records an audit entry
                        naming you, the reason you gave, and the time.
                      </p>
                      <p>
                        The plaintext is released once, to you, and is never returned by any list endpoint.
                      </p>
                    </div>
                  </Card>
                </div>
              </div>

              <RevealCredentialModal
                open={revealOpen}
                onClose={() => setRevealOpen(false)}
                credentialId={credentialId}
                accountName={cred.account_name}
              />
            </>
          )
        }}
      </QueryState>
    </div>
  )
}
