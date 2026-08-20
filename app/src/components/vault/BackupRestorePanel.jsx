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

// Whole-vault backup/restore (Feature 119), a genuinely dangerous operation
// (restore overwrites current Vault state from an encrypted archive), so
// it's kept visually separate from day-to-day safe/credential management
// and gated behind its own explicit confirm dialog rather than a single click.
export function BackupRestorePanel() {
  const [lastBackup, setLastBackup] = useState(null)
  const [restoreKey, setRestoreKey] = useState('')
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false)

  const backupMutation = useMutation({
    mutationFn: createBackup,
    onSuccess: (meta) => {
      setLastBackup(meta)
      toast.success('Encrypted backup created')
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  const restoreMutation = useMutation({
    mutationFn: (key) => restoreBackup(key),
    onSuccess: () => {
      toast.success('Vault restored from backup')
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
      <div className="grid gap-6 p-4 sm:grid-cols-2">
        <div className="space-y-3">
          <p className="text-xs text-ink-400">
            Creates an envelope-encrypted archive of the entire Vault state, uploaded to object storage.
          </p>
          <button
            onClick={() => backupMutation.mutate()}
            disabled={backupMutation.isPending}
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
          <input
            value={restoreKey}
            onChange={(e) => setRestoreKey(e.target.value)}
            placeholder="s3 object key of the backup to restore"
            className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 shadow-sm transition-[border-color,box-shadow] duration-150 hover:border-surface-600 text-xs text-ink-50 placeholder:text-ink-500 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/20"
          />
          <button
            onClick={() => setConfirmRestoreOpen(true)}
            disabled={restoreKey.trim().length === 0}
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
