import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Archive, ShieldAlert } from 'lucide-react'
import { createBackup, restoreBackup } from '../../api/adminVault'
import { Card, CardHeader } from '../common/Layout'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { Spinner } from '../common/Spinner'
import { CopyButton } from '../common/CopyButton'
import { formatBytes, formatDateTime } from '../../lib/format'
import { apiErrorMessage } from '../../lib/apiError'
import { useAuthStore } from '../../store/authStore'

// The server refuses either operation without a justification of at least this
// length. Mirrored here so the button is disabled rather than the request
// bouncing back with a 400 the operator has to read to understand.
const MIN_REASON = 10

// Whole-vault backup/restore (Feature 119), a genuinely dangerous operation
// (restore overwrites current Vault state from an encrypted archive), so
// it's kept visually separate from day-to-day safe/credential management
// and gated behind its own explicit confirm dialog rather than a single click.
export function BackupRestorePanel() {
  const isRoot = useAuthStore((s) => s.isRoot())
  const [lastBackup, setLastBackup] = useState(null)
  const [restoreKey, setRestoreKey] = useState('')
  const [backupReason, setBackupReason] = useState('')
  const [restoreReason, setRestoreReason] = useState('')
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false)

  const backupMutation = useMutation({
    mutationFn: () => createBackup(backupReason.trim()),
    onSuccess: (meta) => {
      setLastBackup(meta)
      setBackupReason('')
      toast.success('Backup created', {
        description: 'An encrypted snapshot of the vault was written to object storage.',
      })
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const restoreMutation = useMutation({
    mutationFn: (key) => restoreBackup(key, restoreReason.trim()),
    onSuccess: () => {
      toast.success('Vault restored from backup')
      setRestoreReason('')
      setConfirmRestoreOpen(false)
    },
    onError: (err) => {
      toast.error(apiErrorMessage(err))
      setConfirmRestoreOpen(false)
    },
  })

  return (
    <Card className="mt-6">
      <CardHeader>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink-50">
          <Archive className="h-4 w-4" /> Backup &amp; restore
        </h3>
      </CardHeader>
      {/* SAID OUT LOUD, not discovered by clicking. Both operations are root
          only on the server, so an administrator who is not root is told why
          the controls are dead rather than being handed a 403. */}
      {!isRoot && (
        <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-50/60 px-3.5 py-3 dark:bg-amber-950/15">
          <ShieldAlert
            className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400"
            strokeWidth={1.9}
          />
          <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300/90">
            Backing up and restoring the vault touches every secret at once, so both are restricted
            to the root account and require a verified second factor. Ask root to run this.
          </p>
        </div>
      )}

      <div className="grid gap-6 p-4 sm:grid-cols-2">
        <div className="space-y-3">
          <p className="text-xs text-ink-400">
            Creates an envelope-encrypted archive of the entire Vault state, uploaded to object storage.
            Every export is recorded against your name with the reason you give.
          </p>
          <div>
            <label htmlFor="vault-backup-reason" className="mb-1 block text-xs font-medium text-ink-300">
              Reason for this export
            </label>
            <input
              id="vault-backup-reason"
              value={backupReason}
              onChange={(e) => setBackupReason(e.target.value)}
              disabled={!isRoot}
              placeholder="Why the whole vault is being exported"
              className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 shadow-sm transition-[border-color,box-shadow] duration-150 hover:border-surface-600 text-xs text-ink-50 placeholder:text-ink-500 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <button
            onClick={() => backupMutation.mutate()}
            disabled={!isRoot || backupMutation.isPending || backupReason.trim().length < MIN_REASON}
            className="flex items-center gap-1.5 rounded-lg bg-surface-800 transition-colors px-3 py-1.5 text-xs font-medium text-ink-100 hover:bg-surface-700 disabled:opacity-60"
          >
            {backupMutation.isPending && <Spinner size="h-3.5 w-3.5" />}
            Create backup now
          </button>
          {lastBackup && (
            <div className="rounded-md border border-surface-800 bg-surface-950/40 p-3 text-xs text-ink-300">
              <p>
                <span className="text-ink-500">Backup ID:</span> {lastBackup.backup_id}
              </p>
              <p>
                <span className="text-ink-500">Created:</span> {formatDateTime(lastBackup.timestamp)}
              </p>
              <p>
                <span className="text-ink-500">Size:</span> {formatBytes(lastBackup.size_bytes)}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-surface-800 px-2 py-1">
                  {lastBackup.s3_object_key}
                </code>
                <CopyButton value={lastBackup.s3_object_key} label="Copy key" />
              </div>
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-surface-800 pt-4 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
          <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
            <ShieldAlert className="h-3.5 w-3.5" /> Restoring overwrites current Vault state.
          </p>
          {/* LABELLED, not placeholder-only. A placeholder disappears the
              moment you type and is not reliably announced, and this is the
              field that decides which archive overwrites the live vault. */}
          <div>
            <label htmlFor="vault-restore-key" className="mb-1 block text-xs font-medium text-ink-300">
              Backup to restore
            </label>
            <input
              id="vault-restore-key"
              value={restoreKey}
              onChange={(e) => setRestoreKey(e.target.value)}
              disabled={!isRoot}
              placeholder="Object key of the backup archive"
              className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 shadow-sm transition-[border-color,box-shadow] duration-150 hover:border-surface-600 text-xs text-ink-50 placeholder:text-ink-500 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <div>
            <label htmlFor="vault-restore-reason" className="mb-1 block text-xs font-medium text-ink-300">
              Reason for this restore
            </label>
            <input
              id="vault-restore-reason"
              value={restoreReason}
              onChange={(e) => setRestoreReason(e.target.value)}
              disabled={!isRoot}
              placeholder="Why the vault is being rolled back"
              className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 shadow-sm transition-[border-color,box-shadow] duration-150 hover:border-surface-600 text-xs text-ink-50 placeholder:text-ink-500 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <button
            onClick={() => setConfirmRestoreOpen(true)}
            disabled={
              !isRoot || restoreKey.trim().length === 0 || restoreReason.trim().length < MIN_REASON
            }
            className="rounded-lg border border-red-300 transition-colors dark:border-red-900/50 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:pointer-events-none disabled:opacity-40"
          >
            Restore from this key
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRestoreOpen}
        title="Restore Vault from backup?"
        description={`This overwrites current Vault state from "${restoreKey}". This cannot be undone.`}
        confirmLabel="Restore"
        destructive
        isLoading={restoreMutation.isPending}
        onConfirm={() => restoreMutation.mutate(restoreKey.trim())}
        onCancel={() => setConfirmRestoreOpen(false)}
      />
    </Card>
  )
}
