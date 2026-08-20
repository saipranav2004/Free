import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { UserRound, ShieldCheck, Bell, Laptop, Palette, RotateCcw, Save, Check } from 'lucide-react'
import clsx from 'clsx'
import { me } from '../api/auth'
import { useAuthStore } from '../store/authStore'
import { mfaSummary } from '../lib/mfaStatus'
import { useMfaStatus } from '../hooks/useMfaStatus'
import { Container, PageTitle, KeyValueGrid, Stack } from '../components/ui/layout'
import { StatusDot } from '../components/ui/bits'
import { QueryState } from '../components/common/QueryState'
import { Button } from '../components/common/Button'
import { Switch, SettingRow } from '../components/common/Switch'
import { ThemeSegmented } from '../components/common/ThemeToggle'
import { MfaEnrollment } from '../components/auth/MfaEnrollment'
import { AgentDevicesPanel } from '../components/agent/AgentDevicesPanel'
import { JIT_DEFAULTS } from '../config/constants'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// REBUILT AROUND A NAV RAIL, NOT A TAB BAR, and that is the change that makes
// this read like an enterprise settings surface rather than a form page.
//
// Why the rail. Tabs are a 2-to-6 item control: past that they wrap, they
// compete with the page title for the top of the screen, and there is nowhere
// to group them. Settings is the one surface in every product that only ever
// grows. So GitHub, Stripe, Okta, Vercel, Slack's admin and AWS account
// settings all use the same arrangement instead: a vertical rail down the left
// of the CONTENT area (not the product sidebar), sticky, with the panel beside
// it. The rail names the whole surface at once, so you can see that "Devices"
// exists without leaving the section you are on.
//
// Why no card walls. The previous version drew a bordered card around every
// group, then a second header with an icon inside each card, then a footer
// note under that. Ten borders around nothing. A section here is a heading, a
// sentence saying what the section is FOR, and hairline-separated rows, which
// is what Cloudscape's key-value grid and GitHub's settings panels both do.
//
// Why the rows look like this. A setting is a name, its consequence, and the
// control that changes it. Description under the label, never in a tooltip:
// the thing people need before flipping a switch is exactly what a tooltip
// hides. See SettingRow in components/common/Switch.jsx.
//
// HONESTY RULE, UNCHANGED: a control that cannot persist does not pretend to.
// Profile, Security, Devices and Appearance are wired to real endpoints or
// stores. Notification preferences persist in this browser and say so on the
// section header. Nothing renders as an editable input unless something is
// listening on the other end.

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

function formatExpiry(expiresAt) {
  if (!expiresAt) return null
  const d = new Date(expiresAt)
  if (Number.isNaN(d.getTime())) return null
  const mins = Math.round((d.getTime() - Date.now()) / 60000)
  const stamp = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  if (mins <= 0) return `${stamp}, expired`
  if (mins < 60) return `${stamp}, ${mins}m left`
  return `${stamp}, ${Math.floor(mins / 60)}h ${mins % 60}m left`
}

// The rail. Sticky, so it stays put while a long panel scrolls beside it, and
// aria-current marks the open one for a screen reader the same way the visual
// state marks it for everyone else.
function SettingsNav({ sections, active, onSelect }) {
  return (
    <nav aria-label="Settings sections" className="lg:sticky lg:top-6 lg:self-start">
      <ul className="flex gap-1 overflow-x-auto pb-1 lg:block lg:space-y-0.5 lg:overflow-visible lg:pb-0">
        {sections.map((s) => {
          const on = s.key === active
          return (
            <li key={s.key} className="flex-none">
              <button
                type="button"
                onClick={() => onSelect(s.key)}
                aria-current={on ? 'page' : undefined}
                className={clsx(
                  'flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  on
                    ? 'bg-accent-soft font-semibold text-accent'
                    : 'text-secondary hover:bg-hover hover:text-primary'
                )}
              >
                <s.icon
                  className={clsx('h-4 w-4 flex-none', on ? 'text-accent' : 'text-tertiary')}
                  strokeWidth={1.6}
                />
                {s.label}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

// A group inside a panel: what it is, what it is for, then the rows. The
// heading carries the weight; the box around it went away.
function Group({ title, description, aside, children }) {
  return (
    <section className="mt-9 first:mt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-bold leading-tight text-primary">{title}</h2>
        {aside && <span className="flex-none text-sm text-tertiary">{aside}</span>}
      </div>
      {description && <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-secondary">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

// Rows share one hairline rule between them and nothing around the outside,
// so a list of settings reads as a list rather than as a stack of boxes.
function Rows({ children }) {
  return <div className="divide-y divide-line-soft border-y border-line-soft">{children}</div>
}

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const expiresAt = useAuthStore((s) => s.expiresAt)
  const isAdmin = useAuthStore((s) => s.isAdmin())
  const [params, setParams] = useSearchParams()

  const meQuery = useQuery({ queryKey: ['me'], queryFn: ({ signal }) => me(signal) })
  // LIVE, not "after a refresh". useMfaStatus subscribes to the enrolment
  // evidence map as well as reading the /auth/me payload, so enabling or
  // disabling MFA repaints this page in the same tick as the change. See
  // hooks/useMfaStatus.js for why invalidating ['me'] alone could never do it
  // on this backend.
  const mfa = useMfaStatus(meQuery.data)
  const posture = mfaSummary(mfa)

  const [prefs, setPrefs] = useState(readPrefs)
  const [savedPrefs, setSavedPrefs] = useState(readPrefs)
  const dirty = useMemo(
    () => Object.keys(NOTIFICATION_DEFAULTS).some((k) => prefs[k] !== savedPrefs[k]),
    [prefs, savedPrefs]
  )

  const SECTIONS = useMemo(
    () => [
      { key: 'profile', label: 'Profile', icon: UserRound },
      { key: 'security', label: 'Security', icon: ShieldCheck },
      { key: 'notifications', label: 'Notifications', icon: Bell },
      { key: 'devices', label: 'Devices', icon: Laptop },
      { key: 'appearance', label: 'Appearance', icon: Palette },
    ],
    []
  )

  // `?tab=` keeps its name so links that already point at a settings section
  // still land. Legacy values from the old tab bar are mapped rather than
  // dropped on the floor.
  const LEGACY = { account: 'profile', integrations: 'devices' }
  const requested = params.get('tab')
  const resolved = LEGACY[requested] || requested
  const active = SECTIONS.some((s) => s.key === resolved) ? resolved : 'profile'
  const setActive = (key) => {
    const next = new URLSearchParams(params)
    if (key === 'profile') next.delete('tab')
    else next.set('tab', key)
    setParams(next, { replace: true })
  }

  const savePrefs = () => {
    try {
      localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(prefs))
      setSavedPrefs(prefs)
      toast.success('Notification preferences saved', {
        description: 'Applied to this browser straight away.',
      })
    } catch {
      toast.error('Could not save your preferences', {
        description: 'Browser storage is unavailable, so this setting cannot be remembered.',
      })
    }
  }

  return (
    <Stack gap="lg">
      <PageTitle
        title="Settings"
        description="Your identity and second factor, what this console tells you about, and the machines paired to your account."
      />

      {/* Rail beside panel. Below `lg` the rail becomes a horizontal strip
          above the panel rather than collapsing into a select, so every
          section stays one tap away on a phone. */}
      <div className="grid gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-10">
        <SettingsNav sections={SECTIONS} active={active} onSelect={setActive} />

        {/* Capped, not fluid. A settings row is label-and-description on the
            left with its control on the right edge, so letting the panel grow
            to a 2560px monitor strands the switch a foot from the sentence it
            belongs to. Every settings surface of this class caps the column
            for the same reason. */}
        <div className="min-w-0 max-w-4xl">
          {active === 'profile' && (
            <QueryState query={meQuery} skeletonRows={4}>
              {(data) => (
                <>
                  <Group
                    title="Your account"
                    description="Who this console knows you as. These come from the directory and are changed by an administrator, not here."
                  >
                    <Container>
                      <KeyValueGrid
                        columns={3}
                        items={[
                          { label: 'Username', value: data.username },
                          { label: 'Email', value: data.email },
                          {
                            label: 'Roles',
                            value:
                              (data.roles || []).length > 0 ? (data.roles || []).join(', ') : 'None assigned',
                          },
                          {
                            label: 'User ID',
                            value: <span className="font-mono text-xs">{data.id || data.user_id || '-'}</span>,
                          },
                          {
                            label: 'Organization',
                            value: (
                              <span className="font-mono text-xs">
                                {data.org_id || data.organization_id || '-'}
                              </span>
                            ),
                          },
                          {
                            label: 'Second factor',
                            value: (
                              <StatusDot
                                tone={
                                  posture.tone === 'emerald' ? 'ok' : posture.tone === 'amber' ? 'warn' : 'muted'
                                }
                                label={posture.label}
                              />
                            ),
                          },
                        ]}
                      />
                    </Container>
                  </Group>

                  <Group
                    title="This session"
                    description="The token in this browser tab, and whether it has cleared a second factor. Signing out or letting it expire ends it."
                    aside={
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={RotateCcw}
                        onClick={() => {
                          queryClient.invalidateQueries({ queryKey: ['me'] })
                          toast.success('Account refreshed', {
                            description: 'Read again from the directory just now.',
                          })
                        }}
                      >
                        Refresh
                      </Button>
                    }
                  >
                    <Container>
                      <KeyValueGrid
                        columns={3}
                        items={[
                          {
                            label: 'Access token',
                            value: formatExpiry(expiresAt),
                            hint: 'Sessions end when this expires or you sign out.',
                          },
                          {
                            label: 'MFA this session',
                            value: mfa.verifiedThisSession ? (
                              <StatusDot tone="ok" label="Verified" />
                            ) : (
                              <StatusDot tone="muted" label="Not verified" />
                            ),
                            hint: mfa.verifiedThisSession
                              ? 'Privileged actions are allowed.'
                              : 'A reveal or a break-glass action will ask you to verify.',
                          },
                          {
                            label: 'Enrolment',
                            value: mfa.unknown
                              ? 'Not reported by this deployment'
                              : mfa.enabled
                                ? 'A second factor is registered'
                                : 'No second factor registered',
                          },
                        ]}
                      />
                    </Container>
                  </Group>
                </>
              )}
            </QueryState>
          )}

          {active === 'security' && (
            <>
              <Group
                title="Second factor"
                description="A time-based code from an authenticator app. Required for revealing a credential and for break-glass access, whatever your account's other permissions are."
              >
                <MfaEnrollment
                  status={mfa}
                  onEnrolled={() => {
                    queryClient.invalidateQueries({ queryKey: ['me'] })
                    toast.success('Second factor enabled', {
                      description: 'Your authenticator is registered and will be asked for at sign-in.',
                    })
                  }}
                  // Disabling is a real, backend-performed removal on this
                  // deployment (see MfaEnrollment for exactly which call does
                  // it), so it gets the same re-read and the same
                  // confirmation weight as enabling.
                  onDisabled={() => {
                    queryClient.invalidateQueries({ queryKey: ['me'] })
                    toast.success('Second factor removed', {
                      description: 'This account signs in with its password alone from now on.',
                    })
                  }}
                />
              </Group>

              <Group
                title="Policy in force"
                description="What this deployment enforces on every account, yours included. These are server-side configuration, shown here so you know the rules before you hit them."
                aside="Set by your administrator"
              >
                <Container>
                  <KeyValueGrid
                    columns={2}
                    items={[
                      {
                        label: 'Vault reveal',
                        value: 'Requires an MFA-verified session',
                        hint: 'Revealing a secret re-checks your second factor even mid-session.',
                      },
                      {
                        label: 'JIT duration',
                        value: `${JIT_DEFAULTS.DEFAULT_DURATION_MIN} min by default, ${JIT_DEFAULTS.MAX_DURATION_MIN} min maximum`,
                        hint: 'Elevation ends on its own. Nothing keeps standing access.',
                      },
                      {
                        label: 'Break-glass',
                        value: `${JIT_DEFAULTS.BREAKGLASS_WAIT_MIN} min waiting period, ${JIT_DEFAULTS.BREAKGLASS_MAX_DURATION_MIN} min maximum`,
                        hint: 'The wait is deliberate, and every break-glass grant is reviewed after the fact.',
                      },
                      {
                        label: 'Justification',
                        value: `At least ${JIT_DEFAULTS.MIN_REASON_LENGTH} characters on every request`,
                        hint: 'Written into the audit record against your name.',
                      },
                    ]}
                  />
                </Container>
              </Group>
            </>
          )}

          {active === 'notifications' && (
            <>
              <Group
                title="What this console tells you about"
                description="In-console alerts, shown on the bell in the top bar. Nothing here sends email or webhooks yet."
                aside="Saved in this browser"
              >
                <Rows>
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
                    description="An administrator ends one of your active sessions."
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
                    description="A Monday summary of what you reached and what expired."
                    control={
                      <Switch
                        checked={prefs.weeklyDigest}
                        onChange={(v) => setPrefs((p) => ({ ...p, weeklyDigest: v }))}
                        label="Weekly digest"
                      />
                    }
                  />
                </Rows>
              </Group>

              {/* The save affordance only exists when there is something to
                  save. A permanently enabled Save button teaches people to
                  ignore it, and an auto-saving toggle row gives you nothing to
                  undo. */}
              {dirty && (
                <div className="animate-panel-in sticky bottom-0 z-10 -mx-4 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
                  <p className="text-sm font-medium text-secondary">You have unsaved changes</p>
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
            </>
          )}

          {active === 'devices' && (
            <Group
              title="Paired devices"
              description="Machines allowed to act as you through the pam-agent CLI, so a connection can be opened from a terminal instead of the browser. Unpair anything you no longer recognise."
            >
              <AgentDevicesPanel />
            </Group>
          )}

          {active === 'appearance' && (
            <Group
              title="Appearance"
              description="How this console looks on this machine. Remembered in this browser, not on your account, so a shared workstation keeps its own setting."
            >
              <Rows>
                <SettingRow
                  label="Theme"
                  description="Light and dark are the only modes. The console follows your operating system until you pick one, and keeps your choice after that."
                  control={<ThemeSegmented />}
                />
                <SettingRow
                  label="Reduced motion"
                  description="Transitions and overlay animations are suppressed automatically when your operating system asks for reduced motion, so there is nothing to switch on here."
                  control={
                    <span className="inline-flex items-center gap-2 text-sm text-secondary">
                      <Check className="h-4 w-4 flex-none text-ok" strokeWidth={2} />
                      Follows your system
                    </span>
                  }
                />
              </Rows>
            </Group>
          )}
        </div>
      </div>
    </Stack>
  )
}
