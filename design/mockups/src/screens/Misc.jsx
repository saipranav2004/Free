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
import { ConfirmDialog, useToast } from '../ui/overlay'
import { MfaEnrolmentDialog, MfaGate, PairAgentPanel } from '../surfaces/Panels'
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
  const toast = useToast()
  const myDevices = agentDevices.filter((d) => d.user_id === viewer.user_id)
  const [enrolOpen, setEnrolOpen] = useState(false)
  const [regenOpen, setRegenOpen] = useState(false)
  const [revokeDevice, setRevokeDevice] = useState(null)
  const [pairOpen, setPairOpen] = useState(false)
  const [gateDemo, setGateDemo] = useState(false)

  // The enforcement gate is a full-page state, so it is previewable here
  // rather than mocked as a screenshot in a document.
  if (gateDemo) {
    return <MfaGate role={roles[0]} onEnrol={() => { setGateDemo(false); setEnrolOpen(true) }} />
  }

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
                <Button size="sm" onClick={() => setEnrolOpen(true)}>Re-enrol</Button>
              </>
            ) : (
              <Button size="sm" variant="primary" icon={ShieldCheck} onClick={() => setEnrolOpen(true)}>Enrol</Button>
            )}
          </Row>
          <Row
            label="Backup codes"
            hint="Ten single-use codes for when you don't have your phone. Regenerating invalidates the old set immediately."
          >
            <Button size="sm" disabled={!viewer.mfa_enabled} onClick={() => setRegenOpen(true)}>Regenerate</Button>
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
            action={<Button variant="primary" onClick={() => setPairOpen(true)}>Pair a device</Button>}
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
                    <Button size="sm" variant="dangerQuiet" onClick={() => setRevokeDevice(d)}>Revoke</Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Button onClick={() => setPairOpen(true)}>Pair another device</Button>
            </div>
            <p className="mt-3 max-w-prose text-xs text-tertiary">
              Pairing requires MFA on the current session. The pairing code expires — the panel shows a live
              countdown while it is valid.
            </p>
          </>
        )}
      </Section>

      {pairOpen && (
        <div className="mt-4">
          <PairAgentPanel />
        </div>
      )}

      <Section title="Appearance">
        <Row label="Theme" hint="Follows the toggle in the top bar. Stored per browser, not per account.">
          <Meta>Use the toggle above</Meta>
        </Row>
        <Row label="Row density" hint="Applies to every table in the console. Set it from the preferences gear on any list.">
          <Meta>Set on any list</Meta>
        </Row>
      </Section>

      <Section title="States you can preview" description="Mockup-only shortcuts so the full-page states are reviewable without arranging the conditions that produce them.">
        <Button size="sm" onClick={() => setGateDemo(true)}>Show the MFA enforcement gate</Button>
      </Section>

      <MfaEnrolmentDialog
        open={enrolOpen}
        onClose={() => setEnrolOpen(false)}
        onDone={() => toast({ title: 'Two-factor is on', description: 'Your backup codes will not be shown again.' })}
      />

      <ConfirmDialog
        open={regenOpen}
        onClose={() => setRegenOpen(false)}
        title="Regenerate your backup codes?"
        consequence="The ten codes you have now stop working the moment the new set is issued. If you have them written down somewhere, that copy becomes useless."
        confirmLabel="Regenerate codes"
        destructive
        onConfirm={() => { setRegenOpen(false); toast({ title: 'New backup codes issued', tone: 'warning', description: 'Save them now — they are shown once.' }) }}
      />

      <ConfirmDialog
        open={!!revokeDevice}
        onClose={() => setRevokeDevice(null)}
        title={`Revoke ${revokeDevice?.device_name}?`}
        consequence="That device can no longer launch sessions for you. Any session it already opened stays open — revoking the pairing does not disconnect anything."
        confirmLabel="Revoke device"
        destructive
        onConfirm={() => { const d = revokeDevice; setRevokeDevice(null); toast({ title: `${d.device_name} revoked`, tone: 'warning' }) }}
      />
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
  const toast = useToast()
  const [backupKey, setBackupKey] = useState(null)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [objectKey, setObjectKey] = useState('')
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
          <Button
            variant="primary"
            icon={Archive}
            onClick={() => {
              const k = `pam-backups/org-1/${new Date().toISOString().replace(/[:.]/g, '-')}.enc`
              setBackupKey(k)
              toast({ title: 'Backup written', description: 'Copy the object key — nothing else can list it back.' })
            }}
          >
            Take a backup now
          </Button>
          <Meta>Returns the object key. Keep it — it is the only handle a restore accepts.</Meta>
        </div>

        {backupKey && (
          <div className="mt-3 flex items-center gap-2 rounded border border-ok/30 bg-ok-soft px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-primary">{backupKey}</code>
            <Button size="sm" onClick={() => setObjectKey(backupKey)}>Use for restore</Button>
            <Button size="sm">Copy</Button>
          </div>
        )}
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
            <input
              id="key"
              value={objectKey}
              onChange={(e) => setObjectKey(e.target.value)}
              placeholder="pam-backups/org-1/2026-08-19T09-04-11Z.enc"
              className={clsx(inputClass, 'font-mono')}
            />
          </div>
          <Button variant="danger" disabled={!objectKey.trim()} onClick={() => setRestoreOpen(true)}>
            Restore the vault…
          </Button>
        </div>

        <p className="mt-4 max-w-prose text-xs text-tertiary">
          Note for the backend: this endpoint is gated by{' '}
          <span className="font-mono text-primary">RequireAdmin</span>, not root. Given what it does, root-only
          would be the safer contract — raised as a backend decision rather than faked by hiding the button from
          admins who can still call the endpoint directly.
        </p>
      </Section>

      <ConfirmDialog
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        title="Restore the vault from this backup?"
        consequence="Every credential created or rotated since that backup is gone. Sessions holding those credentials break. There is no undo, and no endpoint that lists what you are about to lose."
        confirmLabel="Restore the vault"
        destructive
        requireReason
        reasonLabel="Why is this being restored"
        typeToConfirm="restore the vault"
        extra={
          <div className="rounded border border-line bg-subtle px-3 py-2">
            <p className="text-micro font-semibold uppercase text-tertiary">Restoring from</p>
            <code className="mt-1 block break-all font-mono text-xs text-primary">{objectKey}</code>
          </div>
        }
        onConfirm={() => { setRestoreOpen(false); toast({ title: 'Restore started', tone: 'error', description: 'The vault is being replaced from that object.' }) }}
      />
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
