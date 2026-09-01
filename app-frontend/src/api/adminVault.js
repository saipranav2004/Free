import { http } from '../lib/http'

// Whole-vault backup/restore (Feature 119), infra-level, root only.
//
// The hardcoded local MinIO endpoint this note used to warn about is gone: the
// backup service now takes the deployment's real PAM_S3_* settings, so a
// connection error here means object storage is genuinely unreachable or
// misconfigured rather than the code ignoring what it was told. Surface the
// server's error message as-is either way.

// BOTH TAKE A REASON, and the server rejects either without one. These are the
// two operations that touch every secret at once, so they are root only, they
// re-check the second factor, and the justification is what the audit row is
// worth reading for. See vault_handler.go.
export async function createBackup(reason) {
  const { data } = await http.post('/api/v1/pam/admin/vault/backup', { reason })
  return data.data
}

export async function restoreBackup(s3ObjectKey, reason) {
  const { data } = await http.post('/api/v1/pam/admin/vault/restore', {
    s3_object_key: s3ObjectKey,
    reason,
  })
  return data.data
}
