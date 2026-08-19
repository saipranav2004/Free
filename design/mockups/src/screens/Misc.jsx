import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import {
  Archive, ArrowLeft, Compass, Download, Laptop, Monitor, ShieldCheck, Smartphone, Upload,
} from 'lucide-react'
import { useViewer } from '../state/viewer'
import { agentDevices } from '../fixtures'
import {
  AlarmBand, Button, DetailList, Meta, PageHeader, Panel, RuledLabel, Section,
  StatusDot, inputClass,
} from '../ui/primitives'
import { DeniedState, EmptyState } from '../ui/states'
import { dateTime, relative } from '../lib/format'

// ===========================================================================
// Settings
// ===========================================================================
// WHAT CHANGED: nine cards (plus five more inside the MFA wizard) become four
// sections of ROWS — label left, control right, explanation under the label.
// That is the Stripe/Linear settings shape, and it is what `SettingRow` in the
// current build already wants to be before it gets wrapped in a Card.
// GitHub's "danger zone" band groups the irreversible operations.
function Row({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-3 border-b border-line py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-base font-semibold text-primary">{label}</p>
        {hint && <p className="mt-1 max-w-prose text-sm text-secondary">{hint}</p>}
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  )
}

export function Settings() {
  const { viewer, roles } = useViewer()
  const myDevices = agentDevices.filter((d) => d.user_id === viewer.user_id)

  return (
    <>
      <PageHeader title="Settings" description="Your account, your second factor, and the devices that can launch sessions for you." />

      <Section title="Profile">
        <DetailList
          columns={2}
          items={[
            { label: 'Username', value: viewer.username, mono: true },
            { label: 'Email', value: viewer.email, mono: true },
            { label: 'Full name', value: viewer.full_name },
            { label: 'Roles', value: roles.join(', ') },
            { label: 'Account created', value: dateTime(viewer.created_at) },
            { label: 'Last sign-in', value: `${dateTime(viewer.last_login_at)} from ${viewer.last_login_ip}` },
          ]}
        />
        <p className="mt-3 text-xs text-tertiary">
          Your own roles are read-only here. Changing them is an Identity operation and needs an administrator.
        </p>
      </Section>

      <Section title="Multi-factor authentication">
        {!viewer.mfa_enabled && (
          <div className="mb-4">
            <AlarmBand tone="warn">
              No second factor enrolled. If a policy rule covers one of your roles, you will be blocked at sign-in
              when it moves to enforce.
            </AlarmBand>
          </div>
        )}
        <div>
          <Row
            label="Authenticator app"
            hint="A time-based one-time code from an app on your phone. Scan once, then enter a six-digit code at each sign-in."
          >
            {viewer.mfa_enabled ? (
              <>
                <StatusDot tone="ok" label="Enrolled" />
                <Button size="sm">Re-enrol</Button>
              </>
            ) : (
              <Button size="sm" variant="primary" icon={ShieldCheck}>Enrol</Button>
            )}
          </Row>
          <Row
            label="Backup codes"
            hint="Ten single-use codes for when you don't have your phone. Regenerating invalidates the old set immediately."
          >
            <Button size="sm" disabled={!viewer.mfa_enabled}>Regenerate</Button>
          </Row>
        </div>
      </Section>

      <Section
        title="Desktop agent"
        description="Paired devices can launch a native session (psql, sqlplus, redis-cli) instead of the web terminal."
      >
        {myDevices.length === 0 ? (
          <EmptyState
            title="No devices paired"
            description="Pair a device to launch sessions from your own terminal."
            action={<Button variant="primary">Pair a device</Button>}
          />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {myDevices.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Laptop className="h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold text-primary">{d.device_name}</p>
                      <p className="mt-0.5 text-xs text-tertiary">
                        paired {relative(d.created_at)} · last seen {relative(d.last_seen_at)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-none items-center gap-3">
                    <StatusDot tone={d.status === 'ACTIVE' ? 'ok' : 'neutral'} label={d.status} />
                    <Button size="sm" variant="dangerQuiet">Revoke</Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Button>Pair another device</Button>
            </div>
            <p className="mt-3 max-w-prose text-xs text-tertiary">
              Pairing requires MFA on the current session. The pairing code expires — the panel shows a live
              countdown while it is valid.
            </p>
          </>
        )}
      </Section>

      <Section title="Appearance">
        <Row label="Theme" hint="Follows the toggle in the top bar. Stored per browser, not per account.">
          <Meta>Use the toggle above</Meta>
        </Row>
      </Section>
    </>
  )
}

// ===========================================================================
// Admin Center → Vault Operations
// ===========================================================================
// WHAT CHANGED: backup and restore stop being two equal cards. Backup is
// routine; restore overwrites the vault. AWS Backup's restore flow states the
// blast radius first and requires typed confirmation, and that is what this
// does. Backup history is NOT shown — POST /vault/backup returns a key and no
// endpoint lists keys. Listed under Requires backend support, not invented.
export function VaultOps() {
  const { isAdmin } = useViewer()
  const [confirm, setConfirm] = useState('')
  if (!isAdmin) return <DeniedState requires="admin" what="Vault Operations" />

  return (
    <>
      <PageHeader
        eyebrow="Admin Center"
        title="Vault Operations"
        description="Back the vault up, and — very rarely — restore it."
      />

      <Section title="Backup" description="Encrypts and writes the whole vault to object storage. Safe to run at any time; it takes no locks.">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" icon={Archive}>Take a backup now</Button>
          <Meta>Returns the object key. Keep it — it is the only handle a restore accepts.</Meta>
        </div>
        <Panel className="mt-4 flex items-start gap-3 px-4 py-3">
          <Download className="mt-0.5 h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />
          <p className="max-w-prose text-sm text-secondary">
            There is no backup history on this screen because there is no endpoint that lists backups —
            <span className="font-mono text-xs text-primary"> POST /admin/vault/backup</span> returns a key and
            nothing enumerates them. Showing an invented list would be worse than showing none.
          </p>
        </Panel>
      </Section>

      {/* Isolated, consequence-first, typed confirmation. */}
      <Section title="Restore" className="mt-12 border-t border-line pt-8">
        <AlarmBand>
          Restoring replaces the entire vault with the contents of a backup. Credentials created since that backup
          are gone. Sessions holding those credentials break.
        </AlarmBand>

        <div className="mt-6 max-w-prose space-y-4">
          <div>
            <label htmlFor="key" className="mb-2 block text-micro font-semibold uppercase text-tertiary">
              S3 object key
            </label>
            <input id="key" placeholder="pam-backups/org-1/2026-08-19T09-04-11Z.enc" className={clsx(inputClass, 'font-mono')} />
          </div>
          <div>
            <label htmlFor="confirm" className="mb-2 block text-micro font-semibold uppercase text-tertiary">
              Type <span className="font-mono text-primary">restore the vault</span> to enable the button
            </label>
            <input id="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} />
          </div>
          <Button variant="danger" disabled={confirm !== 'restore the vault'}>
            Restore the vault
          </Button>
        </div>

        <p className="mt-4 max-w-prose text-xs text-tertiary">
          Note for the backend: this endpoint is gated by{' '}
          <span className="font-mono text-primary">RequireAdmin</span>, not root. Given what it does, root-only
          would be the safer contract — raised as a backend decision rather than faked by hiding the button from
          admins who can still call the endpoint directly.
        </p>
      </Section>
    </>
  )
}

// ===========================================================================
// 404 — and the state it must stop being confused with
// ===========================================================================
export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Compass className="h-6 w-6 text-tertiary" strokeWidth={1.5} />
      <h1 className="mt-4 text-xl font-semibold text-primary">Page not found</h1>
      <p className="mt-1 max-w-prose text-base text-secondary">
        There is no page at this address. If you expected one and are being sent here instead, you may not have
        access to it — those are different problems and this console now says which.
      </p>
      <div className="mt-6">
        <Link to="/" className="inline-flex h-8 items-center gap-2 rounded border border-line px-3 text-sm font-semibold text-primary hover:bg-hover">
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Back to the dashboard
        </Link>
      </div>
    </div>
  )
}

// A route that exists purely so the permission-denied state is reviewable.
export function DeniedDemo() {
  return (
    <>
      <PageHeader
        title="Permission denied — state demo"
        description="Rendered instead of silently redirecting to / . Every route guard and every 403 response uses this."
      />
      <DeniedState requires="root" what="admin delegation" fallbackHref="/admin/identity" fallbackLabel="Back to Identity" />
      <Section title="Why this exists">
        <p className="max-w-prose text-base text-secondary">
          Today <span className="font-mono text-sm text-primary">AdminRoute</span> sends a non-admin to{' '}
          <span className="font-mono text-sm text-primary">/</span> with no message, and{' '}
          <span className="font-mono text-sm text-primary">QueryState</span> renders a 403 as &ldquo;Couldn&apos;t
          load this data&rdquo; with a Retry button. Both teach the user that the console is broken rather than
          that they lack a role. Naming the requirement is kinder, and it halves the support load.
        </p>
      </Section>
    </>
  )
}
