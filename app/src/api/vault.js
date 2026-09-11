import { http } from '../lib/http'

// NOTE ON RESPONSE SHAPE: unlike resources.js/jit.js, vault_handler.go's
// list endpoints return the array/object directly as `data` (no extra
// `{safes: [...]}` wrapper key), verified against the actual handler code.
// Mixing this convention up with the other modules' is an easy, silent bug
// (you'd get `undefined.map is not a function` instead of the array), so
// each function below is a thin, deliberate pass-through of exactly what
// that specific handler returns, don't "fix" these to look like
// resources.js's shape without checking the backend first.

export async function listCredentialTypes(signal) {
  const { data } = await http.get('/api/v1/pam/credential-types', { signal })
  return data.data // array
}

export async function listSafes(signal) {
  const { data } = await http.get('/api/v1/pam/safes', { signal })
  return data.data // array
}

export async function createSafe(payload) {
  const { data } = await http.post('/api/v1/pam/safes', payload)
  return data.data
}

export async function getSafe(safeId, signal) {
  const { data } = await http.get(`/api/v1/pam/safes/${safeId}`, { signal })
  return data.data
}

export async function listFolders(safeId, signal) {
  const { data } = await http.get(`/api/v1/pam/safes/${safeId}/folders`, { signal })
  return data.data // array
}

export async function createFolder(safeId, payload) {
  const { data } = await http.post(`/api/v1/pam/safes/${safeId}/folders`, payload)
  return data.data
}

export async function listCredentials(safeId, signal) {
  const { data } = await http.get(`/api/v1/pam/safes/${safeId}/credentials`, { signal })
  return data.data // array
}

export async function createCredential(safeId, payload) {
  const { data } = await http.post(`/api/v1/pam/safes/${safeId}/credentials`, payload)
  return data.data
}

export async function getCredential(credentialId, signal) {
  const { data } = await http.get(`/api/v1/pam/credentials/${credentialId}`, { signal })
  return data.data
}

// Requires MFA on the backend (RequireMFA middleware), a 403 here most
// likely means "log in with MFA" rather than "no permission"; components
// should surface that distinction (see RevealCredentialModal).
export async function revealCredential(credentialId, reason) {
  const { data } = await http.post(`/api/v1/pam/credentials/${credentialId}/reveal`, { reason })
  return data.data // CheckoutResult { entry_id, account_name, credential_type, plaintext, expires_at }
}

export async function createCredentialVersion(credentialId, secretPlaintext, reason) {
  const { data } = await http.post(`/api/v1/pam/credentials/${credentialId}/versions`, {
    secret_plaintext: secretPlaintext,
    reason,
  })
  return data.data
}

export async function passwordChange(credentialId, secretPlaintext) {
  const { data } = await http.post(`/api/v1/pam/credentials/${credentialId}/password-change`, {
    secret_plaintext: secretPlaintext,
  })
  return data.data
}

export async function requestCredentialRotation(credentialId) {
  const { data } = await http.post(`/api/v1/pam/credentials/${credentialId}/rotate`)
  return data.data
}

// NOTE: whole-vault backup/restore moved to the Admin Center
// (POST /api/v1/pam/admin/vault/backup, /restore), admin/root only. See
// api/adminVault.js. These no longer exist as self-service routes.
