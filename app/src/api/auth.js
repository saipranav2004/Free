import { http } from '../lib/http'

// POST /api/v1/auth/login
// Returns either a full session ({access_token, refresh_token, expires_at,
// user...}) or an MFA challenge ({challenge_token}), auth_service.go's
// LoginResult omits fields with `omitempty`, so the caller must check which
// shape came back rather than assuming access_token is always present.
export async function login(identifier, password) {
  const { data } = await http.post('/api/v1/auth/login', { identifier, password })
  return data.data
}

export async function verifyMfa(challengeToken, code) {
  const { data } = await http.post('/api/v1/auth/mfa/verify', {
    challenge_token: challengeToken,
    code,
  })
  return data.data
}

export async function me(signal) {
  const { data } = await http.get('/api/v1/auth/me', { signal })
  return data.data
}

export async function logout() {
  const { data } = await http.post('/api/v1/auth/logout')
  return data.data
}

export async function mfaSetupInitiate() {
  const { data } = await http.post('/api/v1/auth/mfa/setup/initiate')
  return data.data // { mfa_device_id, secret, qr_code_base64 }
}

export async function mfaSetupVerify(mfaDeviceId, code) {
  const { data } = await http.post('/api/v1/auth/mfa/setup/verify', {
    mfa_device_id: mfaDeviceId,
    code,
  })
  return data.data // { backup_codes, message }
}

// Fresh single-use recovery codes, voiding the previous set. Behind
// RequireMFA on the server: only a session that actually presented a second
// factor may mint new recovery material.
export async function regenerateBackupCodes() {
  const { data } = await http.post('/api/v1/auth/mfa/backup-codes/regenerate')
  return data.data // { backup_codes, count }
}
