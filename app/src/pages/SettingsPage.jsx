import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  UserRound,
  ShieldCheck,
  Bell,
  Plug,
  Palette,
  Building2,
  Info,
  Clock,
  Terminal,
  KeyRound,
  RotateCcw,
  Save,
  Copy,
  Check,
} from 'lucide-react'
import clsx from 'clsx'
import { me } from '../api/auth'
import { useAuthStore } from '../store/authStore'
import { mfaSummary } from '../lib/mfaStatus'
import { useMfaStatus } from '../hooks/useMfaStatus'
import {
  PageHeader,
  Card,
  CardHeader,
  CardTitle,
  CardFooter,
  Section,
  DetailList,
} from '../components/common/Layout'
import { QueryState } from '../components/common/QueryState'
import { TabBar } from '../components/common/TabBar'
import { Button } from '../components/common/Button'
import { Switch, SettingRow } from '../components/common/Switch'
import { ThemeSegmented } from '../components/common/ThemeToggle'
import { Avatar } from '../components/common/UserMenu'
import { MfaEnrollment } from '../components/auth/MfaEnrollment'
import { AgentDevicesPanel } from '../components/agent/AgentDevicesPanel'
import { Field, inputClass } from '../components/common/FormFields'
import { ROLE_BADGE, API_BASE_URL, JIT_DEFAULTS } from '../config/constants'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// Sectioned into tabs because settings is the one page where a single stacked
// column stops working: account facts, security posture, delivery
// preferences, integrations and appearance are read at different times, by
// different people, for different reasons.
//
// HONESTY RULE FOR THIS PAGE: a control that cannot persist does not pretend
// to. Account, Security and Appearance are wired to real endpoints/stores.
// Notification preferences persist in this browser and say so. Organization
// and API keys have no endpoints yet, so they render as read-only with the
// reason stated instead of as inputs that silently discard what you type.

const NOTIFICATION_PREFS_KEY = 'pam_notification_prefs'

const NOTIFICATION_DEFAULTS = {
  approvalsQueue: true,
  requestDecided: true,
  accessExpiring: true,
  sessionKilled: true,
  weeklyDigest: false,
}

function readPrefs() {
  try {
    const raw = localStorage.getItem(NOTIFICATION_PREFS_KEY)
    if (!raw) return NOTIFICATION_DEFAULTS
    const parsed = JSON.parse(raw)
    return { ...NOTIFICATION_DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return NOTIFICATION_DEFAULTS
  }
}

function ApiPendingNotice({ children }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-surface-600 bg-surface-850/70 px-3.5 py-3">
      <Info className="mt-px h-3.5 w-3.5 flex-none text-ink-500" strokeWidth={1.75} />
      <p className="text-xs leading-relaxed text-ink-400">{children}</p>
    </div>
  )
}

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-xs text-ink-200">
          {value}
        </code>
        <Button
          variant="secondary"
          size="md"
          icon={copied ? Check : Copy}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value)
              setCopied(true)
            } catch {
              toast.error('Clipboard unavailable in this browser')
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </Field>
  )
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return '-'
  const d = new Date(expiresAt)
  if (Number.isNaN(d.getTime())) return '-'
  const mins = Math.round((d.getTime() - Date.now()) / 60000)
  const stamp = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  if (mins <= 0) return `${stamp} · expired`
  if (mins < 60) return `${stamp} · ${mins}m left`
  return `${stamp} · ${Math.floor(mins / 60)}h ${mins % 60}m left`
}

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const expiresAt = useAuthStore((s) => s.expiresAt)
  const isAdmin = useAuthStore((s) => s.isAdmin())
  const [params, setParams] = useSearchParams()

  const meQuery = useQuery({ queryKey: ['me'], queryFn: ({ signal }) => me(signal) })
  // LIVE, not "after a refresh". useMfaStatus subscribes to the enrolment
  // evidence map as well as reading the /auth/me payload, so enabling or
  // disabling MFA repaints this page (Security card AND the Account tab's
  // posture chip) in the same tick as the change. See hooks/useMfaStatus.js
  // for why invalidating ['me'] alone could never do it on this backend.
  const mfa = useMfaStatus(meQuery.data)
  const posture = mfaSummary(mfa)

  const [prefs, setPrefs] = useState(readPrefs)
  const [savedPrefs, setSavedPrefs] = useState(readPrefs)
  const dirty = useMemo(
    () => Object.keys(NOTIFICATION_DEFAULTS).some((k) => prefs[k] !== savedPrefs[k]),
    [prefs, savedPrefs]
  )

  const TABS = useMemo(
    () =>
      [
        { key: 'account', label: 'Account', icon: UserRound },
        { key: 'security', label: 'Security', icon: ShieldCheck },
        { key: 'notifications', label: 'Notifications', icon: Bell },
        { key: 'integrations', label: 'Local Agent', icon: Plug },
        // { key: 'appearance', label: 'Appearance', icon: Palette },
        // isAdmin ? { key: 'organization', label: 'Organization', icon: Building2 } : null,
      ].filter(Boolean),
    [isAdmin]
  )

  const requested = params.get('tab')
  const active = TABS.some((t) => t.key === requested) ? requested : 'account'
  const setActive = (key) => {
    const next = new URLSearchParams(params)
    if (key === 'account') next.delete('tab')
    else next.set('tab', key)
    setParams(next, { replace: true })
  }

  const savePrefs = () => {
    try {
      localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(prefs))
      setSavedPrefs(prefs)
      toast.success('Notification preferences saved')
    } catch {
      toast.error('Could not save - storage is unavailable in this browser')
    }
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Your identity and second factor, how this console reaches you, and the machines paired to your account."
      />

      <TabBar tabs={TABS} active={active} onChange={setActive} className="mb-7" />

      {active === 'account' && (
        <div className="space-y-7">
          <QueryState query={meQuery} skeletonRows={4}>
            {(data) => (
              <>
                <Card>
                  <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
                    <Avatar name={data.username} size="xl" />
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-lg font-semibold leading-tight text-ink-50">
                        {data.username}
                      </h2>
                      <p className="mt-1 truncate text-sm text-ink-400">{data.email || '-'}</p>
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {(data.roles || []).length === 0 && (
                          <span className="text-xs text-ink-500">No roles assigned</span>
                        )}
                        {(data.roles || []).map((r) => (
                          <span
                            key={r}
                            className={clsx(
                              'rounded px-1.5 py-0.5 text-2xs font-semibold ring-1 ring-inset',
                              ROLE_BADGE[r] || ROLE_BADGE.user
                            )}
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex-none sm:self-start">
                      <span
                        className={clsx(
                          'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 ring-inset',
                          posture.tone === 'emerald' &&
                            'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25',
                          posture.tone === 'amber' &&
                            'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25',
                          posture.tone === 'ink' && 'bg-surface-800 text-ink-400 ring-surface-700'
                        )}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
                        {posture.label}
                      </span>
                    </div>
                  </div>
                </Card>

                <Section label="Identity">
                  <Card>
                    <DetailList
                      items={[
                        { label: 'Username', value: data.username },
                        { label: 'Email', value: data.email },
                        { label: 'User ID', value: data.id || data.user_id || '-' },
                        {
                          label: 'Organization',
                          value: data.org_id || data.organization_id || '-',
                        },
                        {
                          label: 'Roles',
                          value: (data.roles || []).join(', ') || '-',
                        },
                      ]}
                    />
                  </Card>
                </Section>

                <Section label="Current session">
                  <Card>
                    <DetailList
                      items={[
                        { label: 'Access token', value: formatExpiry(expiresAt) },
                        {
                          label: 'MFA',
                          value: mfa.verifiedThisSession
                            ? 'Verified this session - privileged actions allowed'
                            : 'Not verified this session',
                        },
                        {
                          label: 'Enrolment',
                          value: mfa.unknown
                            ? 'Not reported by this deployment'
                            : mfa.enabled
                              ? 'A second factor is registered on this account'
                              : 'No second factor registered',
                        },
                      ]}
                    />
                    <CardFooter className="justify-between">
                      <p className="text-xs text-ink-500">
                        Sessions end when the access token expires or you sign out.
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={RotateCcw}
                        onClick={() => {
                          queryClient.invalidateQueries({ queryKey: ['me'] })
                          toast.success('Account refreshed')
                        }}
                      >
                        Refresh
                      </Button>
                    </CardFooter>
                  </Card>
                </Section>
              </>
            )}
          </QueryState>
        </div>
      )}

      {active === 'security' && (
        <div className="space-y-7">
          <Section label="Second factor">
            <MfaEnrollment
              status={mfa}
              onEnrolled={() => {
                queryClient.invalidateQueries({ queryKey: ['me'] })
                toast.success('MFA enabled')
              }}
              // Disabling is a real, backend-performed removal on this
              // deployment (see MfaEnrollment for exactly which call does it),
              // so it gets the same re-read and the same confirmation weight
              // as enabling.
              onDisabled={() => {
                queryClient.invalidateQueries({ queryKey: ['me'] })
                toast.success('MFA disabled - this account is now password-only')
              }}
            />
          </Section>

          <Section label="Policy in force">
            <Card>
              <CardHeader>
                <CardTitle icon={ShieldCheck}>Access policy</CardTitle>
                <span className="ml-auto text-2xs font-medium uppercase tracking-[0.08em] text-ink-500">
                  Server-configured
                </span>
              </CardHeader>
              <DetailList
                items={[
                  { label: 'Vault reveal', value: 'Requires an MFA-verified session' },
                  {
                    label: 'JIT duration',
                    value: `${JIT_DEFAULTS.DEFAULT_DURATION_MIN} min default · ${JIT_DEFAULTS.MAX_DURATION_MIN} min maximum`,
                  },
                  {
                    label: 'Break-glass',
                    value: `${JIT_DEFAULTS.BREAKGLASS_WAIT_MIN} min waiting period · ${JIT_DEFAULTS.BREAKGLASS_MAX_DURATION_MIN} min maximum`,
                  },
                  {
                    label: 'Justification',
                    value: `At least ${JIT_DEFAULTS.MIN_REASON_LENGTH} characters on every request`,
                  },
                ]}
              />
              <CardFooter>
                <p className="text-xs leading-relaxed text-ink-500">
                  These are the deployment&apos;s configured defaults, shown for reference. Changing them is a
                  server-side configuration change, not a console setting.
                </p>
              </CardFooter>
            </Card>
          </Section>
        </div>
      )}

      {active === 'notifications' && (
        <div className="space-y-7">
          <Section label="In-console alerts">
            <Card>
              <CardHeader>
                <CardTitle icon={Bell}>What you get told about</CardTitle>
              </CardHeader>
              <div className="divide-y divide-surface-800">
                {isAdmin && (
                  <SettingRow
                    label="Approval queue"
                    description="A JIT or break-glass request is waiting on you to approve or deny."
                    control={
                      <Switch
                        checked={prefs.approvalsQueue}
                        onChange={(v) => setPrefs((p) => ({ ...p, approvalsQueue: v }))}
                        label="Approval queue alerts"
                      />
                    }
                  />
                )}
                <SettingRow
                  label="Decisions on your requests"
                  description="One of your access requests is approved, denied, or cancelled."
                  control={
                    <Switch
                      checked={prefs.requestDecided}
                      onChange={(v) => setPrefs((p) => ({ ...p, requestDecided: v }))}
                      label="Request decision alerts"
                    />
                  }
                />
                <SettingRow
                  label="Access expiring"
                  description="An active grant of yours is within 30 minutes of expiry."
                  control={
                    <Switch
                      checked={prefs.accessExpiring}
                      onChange={(v) => setPrefs((p) => ({ ...p, accessExpiring: v }))}
                      label="Expiring access alerts"
                    />
                  }
                />
                <SettingRow
                  label="Session terminated"
                  description="An administrator kills one of your active sessions."
                  control={
                    <Switch
                      checked={prefs.sessionKilled}
                      onChange={(v) => setPrefs((p) => ({ ...p, sessionKilled: v }))}
                      label="Session termination alerts"
                    />
                  }
                />
                <SettingRow
                  label="Weekly access digest"
                  description="A Monday summary of what you accessed and what expired."
                  control={
                    <Switch
                      checked={prefs.weeklyDigest}
                      onChange={(v) => setPrefs((p) => ({ ...p, weeklyDigest: v }))}
                      label="Weekly digest"
                    />
                  }
                />
              </div>
            </Card>
          </Section>

          {/* <ApiPendingNotice>
            Delivery is in-console only for now, the notifications bell in the top bar reads live
            JIT data directly. These switches are stored in this browser and will be sent to the
 server the moment a preferences endpoint exists; no email or webhook is dispatched yet.
          </ApiPendingNotice> */}

          {/* The save affordance only exists when there is something to save , 
 a permanently-enabled Save button teaches people to ignore it. */}
          {dirty && (
            <div className="animate-panel-in sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-surface-700/70 bg-surface-900/92 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
              <p className="text-xs text-ink-400">Unsaved preference changes</p>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPrefs(savedPrefs)}>
                  Discard
                </Button>
                <Button variant="primary" size="sm" icon={Save} onClick={savePrefs}>
                  Save preferences
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {active === 'integrations' && (
        <div className="space-y-7">
          {/* <Section label="Local agent">
            <Card>
              <CardHeader>
                <CardTitle icon={Terminal}>pam-agent CLI</CardTitle>
              </CardHeader>
              <div className="space-y-4 p-4">
                <p className="text-sm leading-relaxed text-ink-400">
                  Pair a machine to launch connections through the CLI instead of the browser. The
 agent authenticates against this deployment:
                </p>
                <CopyField label="API endpoint" value={API_BASE_URL} />
              </div>
            </Card>
          </Section> */}

          <Section label="Paired devices">
            <AgentDevicesPanel />
          </Section>

          {/* <Section label="Programmatic access">
            <Card>
              <CardHeader>
                <CardTitle icon={KeyRound}>API keys</CardTitle>
                <span className="ml-auto text-2xs font-medium uppercase tracking-[0.08em] text-ink-500">
                  Not available
                </span>
              </CardHeader>
              <div className="space-y-4 p-4">
                <p className="text-sm leading-relaxed text-ink-400">
                  Service accounts and long-lived API keys are issued by an administrator through
                  Identity, not self-service. Agent pairing above is the supported way to
 authenticate a machine as yourself.
                </p>
                <ApiPendingNotice>
                  There is no self-service key-issuance endpoint on this backend. This section is
 designed and ready for one, it stays read-only until it ships.
                </ApiPendingNotice>
              </div>
            </Card>
          </Section> */}
        </div>
      )}

      {active === 'appearance' && (
        <div className="space-y-7">
          <Section label="Theme">
            <Card>
              <CardHeader>
                <CardTitle icon={Palette}>Appearance</CardTitle>
              </CardHeader>
              <div className="divide-y divide-surface-800">
                <SettingRow
                  label="Console theme"
                  description="Applies immediately and is remembered in this browser. Light and dark are the only modes - the console follows your operating system only until you pick one."
                  control={<ThemeSegmented />}
                />
                <SettingRow
                  label="Reduced motion"
                  description="Transitions and overlay animations are already suppressed automatically when your operating system asks for reduced motion."
                  control={
                    <span className="flex items-center gap-1.5 rounded-lg bg-surface-800 px-2.5 py-1.5 text-xs font-medium text-ink-400 ring-1 ring-inset ring-surface-700">
                      <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />
                      Follows your OS
                    </span>
                  }
                />
              </div>
            </Card>
          </Section>
        </div>
      )}

      {/* {active === 'organization' && (
        <div className="space-y-7">
          <Section label="Tenant">
            <Card>
              <CardHeader>
                <CardTitle icon={Building2}>Organization</CardTitle>
                <span className="ml-auto text-2xs font-medium uppercase tracking-[0.08em] text-ink-500">
                  Read-only
                </span>
              </CardHeader>
              <div className="space-y-4 p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Display name" hint="Shown in audit exports and reports.">
                    <input
 className={inputClass(false)}
 disabled
 placeholder="Not exposed by the API"
                    />
                  </Field>
                  <Field label="Security contact" hint="Where break-glass alerts would be sent.">
                    <input
 className={inputClass(false)}
 disabled
 placeholder="Not exposed by the API"
                    />
                  </Field>
                </div>
                <DetailList
 items={[
                    {
 label: 'Organization ID',
 value:
 meQuery.data?.org_id || meQuery.data?.organization_id || '-',
                    },
                    { label: 'Audit chain', value: 'Hash-chained · verifiable in Admin Center' },
                    { label: 'Session recording', value: 'Enabled per resource policy' },
                  ]}
                />
                <ApiPendingNotice>
                  Tenant administration has no endpoints on this backend yet, nothing here can be
 edited from the console. Organization-level facts that <em>are</em> available live
 in Admin Center → Overview and Audit &amp; Compliance.
                </ApiPendingNotice>
              </div>
            </Card>
          </Section>
        </div>
      )} */}
    </div>
  )
}
