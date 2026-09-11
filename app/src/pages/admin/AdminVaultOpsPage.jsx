import { PageHeader } from '../../components/common/Layout'
import { BackupRestorePanel } from '../../components/vault/BackupRestorePanel'

// BackupRestorePanel already renders its own Card (with its own `mt-6` top
// margin), this page is just the shell + header around it, no extra Card
// wrapper (that would just double up the border).
export default function AdminVaultOpsPage() {
  return (
    <div>
      <PageHeader
        title="Vault Operations"
        description="Whole-vault backup and restore a separate, higher-blast-radius operation from day-to-day safe/credential management in the Vault section."
      />

      <BackupRestorePanel />
    </div>
  )
}
