import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { UserRound, ShieldCheck, Bell, Laptop, Palette, RotateCcw, Save, Lock } from 'lucide-react'
import clsx from 'clsx'
import { me } from '../api/auth'
import { useAuthStore } from '../store/authStore'
import { mfaSummary, sessionPosture } from '../lib/mfaStatus'
import { useMfaStatus } from '../hooks/useMfaStatus'
import { Container, PageTitle, KeyValueGrid, Stack } from '../components/ui/layout'
import { StatusDot } from '../components/ui/bits'
import { QueryState } from '../components/common/QueryState'
import { Button } from '../components/common/Button'
import { Switch, SettingRow } from '../components/common/Switch'
import { ThemeSegmented } from '../components/common/ThemeToggle'
import { MfaEnrollment } from '../components/auth/MfaEnrollment'
import { AgentDevicesPanel } from '../components/agent/AgentDevicesPanel'
import { QuickEnrolPanel } from '../components/agent/QuickEnrolPanel'
import { JIT_DEFAULTS } from '../config/constants'
import { categoryIcon } from '../lib/notificationDisplay'
import {
  ALWAYS_ON_CATEGORIES,
  categoryTitle,
  notificationTypesFor,
  readMutes,
  writeMutes,
} from '../lib/notificationPrefs'

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

// THE OLD PREFERENCES ARE GONE, and they were the reason this section could
// not be trusted. Five switches (approvalsQueue, requestDecided,
// accessExpiring, sessionKilled, weeklyDigest) were saved to localStorage and
// read back by nothing at all, and one of them ("Weekly access digest")
// described a feature that does not exist anywhere in this product.
//
// What replaces them is lib/notificationPrefs.js: the real catalogue of what
// the server delivers, taken from the Deliver() calls in jit_handler.go,
// jit_service.go's sweeper and admin_handler.go, plus a mute per category that
// the bell actually reads.
//
// Security and anything CRITICAL cannot be muted. See ALWAYS_ON_CATEGORIES.

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

  const [mutes, setMutes] = useState(readMutes)
  const [savedMutes, setSavedMutes] = useState(readMutes)
  const dirty = useMemo(() => {
    const a = [...mutes].sort().join('|')
    const b = [...savedMutes].sort().join('|')
    return a !== b
  }, [mutes, savedMutes])

  const toggleCategory = (category, on) =>
    setMutes((current) =>
      on ? current.filter((c) => c !== category) : [...new Set([...current, category])]
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
    if (writeMutes(mutes)) {
      setSavedMutes(mutes)
      toast.success('Notification preferences saved', {
        description: 'The bell applies them straight away, in this browser.',
      })
      return
    }
    toast.error('Could not save your preferences', {
      description: 'Browser storage is unavailable, so this setting cannot be remembered.',
    })
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
                            // sessionPosture, not the raw flag: this row used
                            // to read "Verified" on accounts the panel directly
                            // above reported as having no second factor.
                            value: (
                              <StatusDot
                                tone={sessionPosture(mfa).tone}
                                label={sessionPosture(mfa).label}
                              />
                            ),
                            hint: sessionPosture(mfa).hint,
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
              {/* WHAT ARRIVES, LISTED IN FULL. Every row below is a real
                  Deliver() call on the server, so the catalogue and the bell
                  cannot describe different products. Rows the reader can never
                  receive are dropped rather than shown greyed out: the
                  approval queue only ever notifies approvers. */}
              <Group
                title="What this console tells you about"
                description="Everything below is delivered to the bell in the top bar and kept on the notifications page. Nothing here sends email or webhooks."
              >
                <div className="flex flex-col gap-5">
                  {notificationTypesFor(isAdmin).map((group) => {
                    const Icon = categoryIcon(group.category)
                    const locked = ALWAYS_ON_CATEGORIES.includes(group.category)
                    const on = !mutes.includes(group.category)
                    return (
                      <section
                        key={group.category}
                        className="overflow-hidden rounded-xl border border-line bg-surface"
                      >
                        <header className="flex items-center gap-3 border-b border-line-soft px-4 py-3">
                          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-line bg-surface-900 text-secondary">
                            <Icon className="h-4 w-4" strokeWidth={1.9} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-primary">
                              {categoryTitle(group.category)}
                            </p>
                            <p className="mt-0.5 text-xs text-tertiary">
                              {locked
                                ? 'Always shown. Security events cannot be muted.'
                                : on
                                  ? 'Shown in the bell.'
                                  : 'Muted in the bell. Still kept on the notifications page.'}
                            </p>
                          </div>
                          {locked ? (
                            <span className="flex flex-none items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-tertiary">
                              <Lock className="h-3.5 w-3.5" strokeWidth={2} />
                              Always on
                            </span>
                          ) : (
                            <Switch
                              checked={on}
                              onChange={(v) => toggleCategory(group.category, v)}
                              label={`Show ${categoryTitle(group.category)} in the bell`}
                            />
                          )}
                        </header>
                        <ul className="divide-y divide-line-soft">
                          {group.items.map((item) => (
                            <li key={item.title} className="flex items-start gap-3 px-4 py-2.5">
                              <span
                                className={clsx(
                                  'mt-1 h-1.5 w-1.5 flex-none rounded-full',
                                  item.severity === 'CRITICAL'
                                    ? 'bg-red-500'
                                    : item.severity === 'WARNING'
                                      ? 'bg-amber-500'
                                      : 'bg-blue-500'
                                )}
                                aria-hidden="true"
                              />
                              <span className="min-w-0">
                                <span className="block text-sm text-primary">{item.title}</span>
                                <span className="mt-0.5 block text-xs leading-relaxed text-tertiary">
                                  {item.when}
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )
                  })}
                </div>
              </Group>

              <Group
                title="Where preferences live"
                description="Muting is remembered in this browser only, so it does not follow you to another machine and it changes nothing about what the server records."
                aside="Saved in this browser"
              >
                <p className="text-sm leading-relaxed text-secondary">
                  A muted category is hidden from the bell, never from your history: everything is
                  still on the notifications page, and the unread count on the bell keeps counting
                  it. Anything marked critical is shown whatever you set here.
                </p>
              </Group>

              {/* The save affordance only exists when there is something to
                  save. A permanently enabled Save button teaches people to
                  ignore it, and an auto-saving toggle row gives you nothing to
                  undo. */}
              {dirty && (
                <div className="animate-panel-in sticky bottom-0 z-10 -mx-4 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
                  <p className="text-sm font-medium text-secondary">You have unsaved changes</p>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setMutes(savedMutes)}>
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
            <>
              {/* Enrolment comes FIRST, because on this screen the common case
                  is someone who has no agent yet, so the device list below is
                  empty for exactly those people, and asking them to find a
                  download, unpack it, put it on PATH and type an 8-character
                  code before a five-minute timer expires is where enrolment
                  used to be lost. Pick a platform, run one command, done. */}
              <Group
                title="Install the desktop agent"
                description="Opens native tools (psql, mongosh, redis-cli, pgAdmin) already connected, without a credential ever reaching your clipboard. Pick your platform and PAM hands you a single command that downloads, installs and pairs in one step."
              >
                <QuickEnrolPanel />
              </Group>

              <Group
                title="Paired devices"
                description="Machines allowed to act as you through the pam-agent CLI, so a connection can be opened from a terminal instead of the browser. Unpair anything you no longer recognise."
              >
                <AgentDevicesPanel />
              </Group>
            </>
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
                {/* <SettingRow
                  label="Reduced motion"
                  description="Transitions and overlay animations are suppressed automatically when your operating system asks for reduced motion, so there is nothing to switch on here."
                  control={
                    <span className="inline-flex items-center gap-2 text-sm text-secondary">
                      <Check className="h-4 w-4 flex-none text-ok" strokeWidth={2} />
                      Follows your system
                    </span>
                  }
                /> */}
              </Rows>
            </Group>
          )}
        </div>
      </div>
    </Stack>
  )
}
