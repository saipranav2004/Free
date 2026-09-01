import { http } from '../lib/http'

// Whole-vault backup/restore (Feature 119), infra-level, admin/root only.
// NOTE: these two calls are hardcoded backend-side to a local MinIO/S3
// endpoint (see vault_handler.go, independent of any per-deployment env
// config), so expect them to fail with a connection error in any
// environment that hasn't stood up that endpoint. That's an environment
// gap, not a frontend bug, surface the server's error message as-is.

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
