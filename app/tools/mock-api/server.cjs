// ---------------------------------------------------------------------------
// Local contract server
// ---------------------------------------------------------------------------
// Stands in for https://das-iam.bharatgen.dev during development and during
// the automated interaction pass. It is NOT a reimplementation of the backend:
// it implements the wire contract only, which is what the console depends on.
//
//   * the same paths and verbs as internal/api/routes.go
//   * the same { success, data } envelope, and the same
//     { success:false, error:{ code, message, fields? } } error envelope
//   * the same status codes, including 401 on a missing bearer token, 403 for
//     an admin route reached by a non admin, 409 for a duplicate name and 422
//     for field level validation
//
// Every request is logged to ./requests.log as one JSON object per line, which
// is what the interaction test asserts against: a button is only wired if the
// request it claims to make actually appears in that log with the right method,
// path and body.
//
// Sign in with any of: root / p.raghavan / d.okonkwo / s.mehta, password
// "password". s.mehta is the non privileged persona.

const http = require('http')
const fs = require('fs')
const path = require('path')
const F = require('./fixtures.cjs')

const PORT = Number(process.env.MOCK_PORT || 8787)
const LOG = path.join(__dirname, 'requests.log')
const LATENCY = Number(process.env.MOCK_LATENCY_MS || 0)

// Mutable copies, so writes made by the console are visible on the next read.
const db = {
  users: F.USERS.map((u) => ({ ...u })),
  roles: F.ROLES.map((r) => ({ ...r })),
  policies: F.POLICIES.map((p) => ({ ...p })),
  resources: F.RESOURCES.map((r) => ({ ...r })),
  safes: F.SAFES.map((s) => ({ ...s })),
  folders: JSON.parse(JSON.stringify(F.FOLDERS)),
  credentials: JSON.parse(JSON.stringify(F.CREDENTIALS)),
  jit: F.JIT_REQUESTS.map((r) => ({ ...r })),
  approvals: JSON.parse(JSON.stringify(F.APPROVALS)),
  grants: F.GRANTS.map((g) => ({ ...g })),
  sessions: F.SESSIONS.map((s) => ({ ...s })),
  recordings: F.RECORDINGS.map((r) => ({ ...r })),
  audit: F.AUDIT.map((a) => ({ ...a })),
  devices: F.AGENT_DEVICES.map((d) => ({ ...d })),
  mfaRules: F.MFA_RULES.map((r) => ({ ...r })),
  rolePolicies: { 'r-4': ['p-4'], 'r-5': ['p-2'], 'r-2': ['p-1'] },
  userPolicies: { 'u-user-0004': ['p-2'] },
  delegations: {},
  tokens: {},
  verified: {},
  seq: 5000,
}

const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`

// The console stores { accessToken, expiresAt, user } and reads user.roles for
// every client side gate, so a session response has to carry all three.
function issueSession(user) {
  const token = uid('tok')
  db.tokens[token] = user.user_id
  auditRow(user, 'AUTH', 'auth.login.success', 'SUCCESS')
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    user,
  }
}

function log(entry) {
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n')
  } catch {
    /* logging must never break a request */
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  })
  res.end(payload)
}
const ok = (res, data, status = 200) => send(res, status, { success: true, data })
const fail = (res, status, code, message, fields) =>
  send(res, status, { success: false, error: { code, message, ...(fields ? { fields } : {}) } })

function paginate(rows, query) {
  const page = Math.max(1, Number(query.page || 1))
  const pageSize = Math.min(200, Math.max(1, Number(query.page_size || query.pageSize || 20)))
  const total = rows.length
  const start = (page - 1) * pageSize
  return {
    items: rows.slice(start, start + pageSize),
    pagination: { page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) },
  }
}

function userOf(req) {
  const auth = req.headers.authorization || ''
  if (!auth.startsWith('Bearer ')) return null
  const id = db.tokens[auth.slice(7)]
  return db.users.find((u) => u.user_id === id) || null
}
const isAdmin = (u) => !!u && (u.roles.includes('admin') || u.roles.includes('root'))
const isRoot = (u) => !!u && u.roles.includes('root')

function auditRow(actor, category, action, outcome, resource, details) {
  const row = {
    id: uid('aud'), org_id: F.ORG, sequence_number: ++db.seq, occurred_at: new Date().toISOString(),
    actor_type: 'USER', user_id: actor ? actor.user_id : null, username: actor ? actor.username : 'anonymous',
    category, action, outcome, severity: outcome === 'SUCCESS' ? 'INFO' : 'WARN',
    resource: resource || '', source_ip: '127.0.0.1', details: details || {},
    prev_hash: 'a'.repeat(64), entry_hash: 'b'.repeat(64), hash_version: 1,
  }
  db.audit.unshift(row)
  return row
}

// --- routing ---------------------------------------------------------------
const routes = []
const on = (method, pattern, handler, guard) => routes.push({ method, pattern, handler, guard })

function match(pattern, pathname) {
  const p = pattern.split('/')
  const a = pathname.split('/')
  if (p.length !== a.length) return null
  const params = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i])
    else if (p[i] !== a[i]) return null
  }
  return params
}

// ===========================================================================
// auth
// ===========================================================================
on('POST', '/api/v1/auth/login', (ctx) => {
  const { identifier, password } = ctx.body || {}
  const fields = {}
  if (!identifier) fields.identifier = 'Enter your username or email'
  if (!password) fields.password = 'Enter your password'
  if (Object.keys(fields).length) return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', fields)
  const user = db.users.find((u) => u.username === identifier || u.email === identifier)
  if (!user || password !== 'password') return fail(ctx.res, 401, 'INVALID_CREDENTIALS', 'That username or password is not right.')
  if (user.status === 'LOCKED') return fail(ctx.res, 423, 'ACCOUNT_LOCKED', 'This account is locked. Ask an administrator to unlock it.')
  if (user.status !== 'ACTIVE') return fail(ctx.res, 403, 'ACCOUNT_DISABLED', 'This account is disabled.')
  if (user.mfa_enabled) {
    const challenge = uid('chal')
    db.tokens[`challenge:${challenge}`] = user.user_id
    return ok(ctx.res, { mfa_required: true, challenge_token: challenge, expires_in_seconds: 300 })
  }
  return ok(ctx.res, issueSession(user))
}, 'public')

on('POST', '/api/v1/auth/mfa/verify', (ctx) => {
  const { challenge_token: ch, code } = ctx.body || {}
  const userId = db.tokens[`challenge:${ch}`]
  if (!userId) return fail(ctx.res, 401, 'CHALLENGE_EXPIRED', 'That verification session has expired. Sign in again.')
  if (!/^\d{6}$/.test(String(code || ''))) return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Enter the 6 digit code.', { code: 'Enter the 6 digit code from your authenticator app.' })
  if (code !== '123456') return fail(ctx.res, 401, 'INVALID_CODE', 'That code is not right. Check your authenticator app and try again.')
  const user = db.users.find((u) => u.user_id === userId)
  const session = issueSession(user)
  session.mfa_verified = true
  db.verified[session.access_token] = true
  auditRow(user, 'AUTH', 'auth.mfa.verified', 'SUCCESS')
  return ok(ctx.res, session)
}, 'public')

// The console does setUser(data.data) straight off this response and then
// reads user.roles, so the payload is the account itself, not a wrapper.
on('GET', '/api/v1/auth/me', (ctx) =>
  ok(ctx.res, { ...ctx.user, mfa_verified: !!db.verified[(ctx.req.headers.authorization || '').slice(7)] }))
on('POST', '/api/v1/auth/logout', (ctx) => {
  delete db.tokens[(ctx.req.headers.authorization || '').slice(7)]
  return ok(ctx.res, { message: 'Signed out' })
})
on('POST', '/api/v1/auth/mfa/setup/initiate', (ctx) =>
  ok(ctx.res, {
    mfa_device_id: uid('mfa'),
    secret: 'JBSWY3DPEHPK3PXP',
    qr_code_base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  }), 'public')
on('POST', '/api/v1/auth/mfa/setup/verify', (ctx) => {
  if (String(ctx.body?.code || '') !== '123456')
    return fail(ctx.res, 400, 'INVALID_CODE', 'That code is not right. Check the clock on your device and try again.')
  if (ctx.user) ctx.user.mfa_enabled = true
  return ok(ctx.res, { backup_codes: ['4KQ2-91MD', '7ZR8-4XCV', 'LM03-88TB', 'QW51-2NDE', 'PP74-6HGA', 'TT19-0JKL', 'BB62-5RQZ', 'XN44-7YUE'], message: 'Two factor authentication is on for this account.' })
}, 'public')
on('POST', '/api/v1/auth/mfa/backup-codes/regenerate', (ctx) =>
  ok(ctx.res, { backup_codes: ['9AA1-33KD', '2BB7-81MN', 'CC40-77QR', 'DD22-19ZX', 'EE68-04VB', 'FF15-52LK', 'GG93-38TY', 'HH07-66PA'], count: 8 }))

// ===========================================================================
// resources, sessions, agent (self service)
// ===========================================================================
on('GET', '/api/v1/pam/resources', (ctx) => {
  let rows = db.resources.filter((r) => r.is_active)
  if (ctx.query.type) rows = rows.filter((r) => r.resource_type === ctx.query.type)
  return ok(ctx.res, { resources: rows, count: rows.length })
})
on('GET', '/api/v1/pam/resources/groups', (ctx) => {
  const groups = {}
  for (const r of db.resources.filter((x) => x.is_active)) (groups[r.resource_type] ||= []).push(r)
  return ok(ctx.res, {
    groups: Object.entries(groups).map(([type, resources]) => ({
      name: type, type, count: resources.length, resources,
    })),
  })
})
on('GET', '/api/v1/pam/resources/:id', (ctx) => {
  const r = db.resources.find((x) => x.id === ctx.params.id)
  return r ? ok(ctx.res, { resource: r }) : fail(ctx.res, 404, 'NOT_FOUND', 'That resource does not exist or has been removed.')
})
on('GET', '/api/v1/pam/resources/:id/connect-info', (ctx) => {
  const r = db.resources.find((x) => x.id === ctx.params.id)
  if (!r) return fail(ctx.res, 404, 'NOT_FOUND', 'That resource does not exist.')
  const grant = db.grants.find((g) => g.resource_id === r.id && g.user_id === ctx.user.user_id && g.status === 'ACTIVE')
  if (r.requires_jit && !grant)
    return fail(ctx.res, 403, 'JIT_REQUIRED', 'This resource needs an approved just in time grant before you can connect.')
  return ok(ctx.res, {
    resource_id: r.id, resource_name: r.name, resource_type: r.resource_type,
    host: r.host, port: r.port, database_name: r.database_name, connect_mode: r.connect_mode,
    console_url: r.console_url || null, username: ctx.user.username,
    expires_at: grant ? grant.expires_at : F.iso(60), recording_required: r.recording_required,
  })
})
on('POST', '/api/v1/pam/resources/:id/sessions', (ctx) => {
  const r = db.resources.find((x) => x.id === ctx.params.id)
  if (!r) return fail(ctx.res, 404, 'NOT_FOUND', 'That resource does not exist.')
  const s = {
    id: uid('sess'), org_id: F.ORG, user_id: ctx.user.user_id, username: ctx.user.username,
    resource_id: r.id, resource_name: r.name, protocol: ctx.body?.protocol || 'tcp',
    status: 'ACTIVE', started_at: new Date().toISOString(), source_ip: '127.0.0.1', recording_id: null,
  }
  db.sessions.unshift(s)
  auditRow(ctx.user, 'SESSION', 'session.started', 'SUCCESS', `resource:${r.name}`)
  return ok(ctx.res, { session: s, notice: r.recording_required ? 'This session is being recorded.' : undefined }, 201)
})
on('POST', '/api/v1/pam/resources/:id/launch', (ctx) =>
  ok(ctx.res, { launch_url: `https://agent.local/launch/${uid('lch')}`, expires_at: F.iso(2), expires_in_seconds: 120 }))

on('GET', '/api/v1/pam/sessions/mine', (ctx) => {
  let rows = db.sessions.filter((s) => s.user_id === ctx.user.user_id)
  if (ctx.query.status) rows = rows.filter((s) => s.status === ctx.query.status)
  if (ctx.query.active_only === 'true') rows = rows.filter((s) => s.status === 'ACTIVE')
  const { items, pagination } = paginate(rows, ctx.query)
  return ok(ctx.res, { sessions: items, pagination })
})
on('POST', '/api/v1/pam/sessions/:id/end', (ctx) => {
  const s = db.sessions.find((x) => x.id === ctx.params.id)
  if (!s) return fail(ctx.res, 404, 'NOT_FOUND', 'That session does not exist.')
  if (s.status !== 'ACTIVE') return fail(ctx.res, 409, 'ALREADY_ENDED', 'That session has already ended.')
  s.status = 'COMPLETED'
  s.ended_at = new Date().toISOString()
  auditRow(ctx.user, 'SESSION', 'session.ended', 'SUCCESS', `resource:${s.resource_name}`)
  return ok(ctx.res, s)
})

on('POST', '/api/v1/pam/agent/pair/init', (ctx) =>
  ok(ctx.res, { pairing_code: 'HK4M-2QPD-91XZ', expires_at: F.iso(Number(ctx.body?.ttl_minutes || 10)), expires_in_seconds: 60 * Number(ctx.body?.ttl_minutes || 10) }))
on('GET', '/api/v1/pam/agent/devices', (ctx) => {
  const rows = db.devices.filter((d) => d.user_id === ctx.user.user_id)
  return ok(ctx.res, { devices: rows, count: rows.length })
})
on('DELETE', '/api/v1/pam/agent/devices/:id', (ctx) => {
  const d = db.devices.find((x) => x.id === ctx.params.id)
  if (!d) return fail(ctx.res, 404, 'NOT_FOUND', 'That device is not paired with this account.')
  d.status = 'REVOKED'
  d.revoked_at = new Date().toISOString()
  return ok(ctx.res, d)
})

// ===========================================================================
// vault
// ===========================================================================
on('GET', '/api/v1/pam/credential-types', (ctx) =>
  ok(ctx.res, ['password', 'ssh_key', 'x509_cert', 'api_key', 'token', 'connection_string', 'kerberos_keytab']))
on('GET', '/api/v1/pam/safes', (ctx) =>
  ok(ctx.res, db.safes.map((s) => ({ ...s, credential_count: (db.credentials[s.id] || []).length }))))
on('POST', '/api/v1/pam/safes', (ctx) => {
  const name = String(ctx.body?.name || '').trim()
  if (!name) return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { name: 'Give the safe a name.' })
  if (db.safes.some((s) => s.name.toLowerCase() === name.toLowerCase()))
    return fail(ctx.res, 409, 'ALREADY_EXISTS', `A safe called "${name}" already exists.`, { name: 'That name is taken.' })
  const s = { id: uid('safe'), org_id: F.ORG, name, description: ctx.body.description || '', owner_id: ctx.user.user_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  db.safes.push(s)
  db.folders[s.id] = []
  db.credentials[s.id] = []
  auditRow(ctx.user, 'VAULT', 'vault.safe.created', 'SUCCESS', `safe:${name}`)
  return ok(ctx.res, s, 201)
})
on('GET', '/api/v1/pam/safes/:id', (ctx) => {
  const s = db.safes.find((x) => x.id === ctx.params.id)
  return s ? ok(ctx.res, s) : fail(ctx.res, 404, 'NOT_FOUND', 'That safe does not exist.')
})
on('GET', '/api/v1/pam/safes/:id/folders', (ctx) => ok(ctx.res, db.folders[ctx.params.id] || []))
on('POST', '/api/v1/pam/safes/:id/folders', (ctx) => {
  const name = String(ctx.body?.name || '').trim()
  if (!name) return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { name: 'Give the folder a name.' })
  const f = { id: uid('fold'), safe_id: ctx.params.id, name, parent_folder_id: ctx.body.parent_folder_id || null, path: `/${name}`, created_at: new Date().toISOString() }
  ;(db.folders[ctx.params.id] ||= []).push(f)
  return ok(ctx.res, f, 201)
})
on('GET', '/api/v1/pam/safes/:id/credentials', (ctx) => ok(ctx.res, db.credentials[ctx.params.id] || []))
on('POST', '/api/v1/pam/safes/:id/credentials', (ctx) => {
  const b = ctx.body || {}
  const fields = {}
  if (!String(b.account_name || '').trim()) fields.account_name = 'Enter the account this credential signs in as.'
  if (!b.credential_type) fields.credential_type = 'Pick a credential type.'
  if (!String(b.secret_plaintext || '').trim()) fields.secret_plaintext = 'Enter the secret to store.'
  if (Object.keys(fields).length) return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', fields)
  const c = {
    id: uid('cred'), safe_id: ctx.params.id, folder_id: b.folder_id || null,
    account_name: b.account_name.trim(), credential_type: b.credential_type,
    resource_id: b.resource_id || null, version: 1,
    rotation_interval_days: Number(b.rotation_interval_days || 0),
    last_rotated_at: null, next_rotation_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  ;(db.credentials[ctx.params.id] ||= []).push(c)
  auditRow(ctx.user, 'VAULT', 'vault.credential.created', 'SUCCESS', `credential:${c.account_name}`)
  return ok(ctx.res, c, 201)
})
function findCred(id) {
  for (const safeId of Object.keys(db.credentials)) {
    const c = (db.credentials[safeId] || []).find((x) => x.id === id)
    if (c) return c
  }
  return null
}
on('GET', '/api/v1/pam/credentials/:id', (ctx) => {
  const c = findCred(ctx.params.id)
  return c ? ok(ctx.res, c) : fail(ctx.res, 404, 'NOT_FOUND', 'That credential does not exist.')
})
on('POST', '/api/v1/pam/credentials/:id/reveal', (ctx) => {
  const c = findCred(ctx.params.id)
  if (!c) return fail(ctx.res, 404, 'NOT_FOUND', 'That credential does not exist.')
  const reason = String(ctx.body?.reason || '').trim()
  if (reason.length < 10)
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { reason: 'Give at least 10 characters of justification. This is written to the audit log.' })
  auditRow(ctx.user, 'VAULT', 'vault.credential.revealed', 'SUCCESS', `credential:${c.account_name}`, { reason })
  return ok(ctx.res, {
    entry_id: c.id, account_name: c.account_name, credential_type: c.credential_type,
    plaintext: c.credential_type === 'ssh_key'
      ? '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gt\ncnNhAAAAAwEAAQAAAYEAxQ2mock0nlyF0rTh3sV3r1f1c4t10nT3st1ngxxxxxxxxxx\n-----END OPENSSH PRIVATE KEY-----'
      : 'Kx7#mQ2vRp9$Lt4wZ0nB',
    expires_at: F.iso(1),
  })
})
on('POST', '/api/v1/pam/credentials/:id/versions', (ctx) => {
  const c = findCred(ctx.params.id)
  if (!c) return fail(ctx.res, 404, 'NOT_FOUND', 'That credential does not exist.')
  if (!String(ctx.body?.secret_plaintext || '').trim())
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { secret_plaintext: 'Enter the new secret.' })
  c.version += 1
  c.updated_at = new Date().toISOString()
  auditRow(ctx.user, 'VAULT', 'vault.credential.version.created', 'SUCCESS', `credential:${c.account_name}`)
  return ok(ctx.res, c, 201)
})
on('POST', '/api/v1/pam/credentials/:id/password-change', (ctx) => {
  const c = findCred(ctx.params.id)
  if (!c) return fail(ctx.res, 404, 'NOT_FOUND', 'That credential does not exist.')
  c.version += 1
  c.last_rotated_at = new Date().toISOString()
  return ok(ctx.res, c)
})
on('POST', '/api/v1/pam/credentials/:id/rotate', (ctx) => {
  const c = findCred(ctx.params.id)
  if (!c) return fail(ctx.res, 404, 'NOT_FOUND', 'That credential does not exist.')
  c.version += 1
  c.last_rotated_at = new Date().toISOString()
  c.next_rotation_at = F.iso(60 * 24 * (c.rotation_interval_days || 30))
  auditRow(ctx.user, 'VAULT', 'vault.credential.rotated', 'SUCCESS', `credential:${c.account_name}`)
  return ok(ctx.res, c)
})

// ===========================================================================
// jit (self service)
// ===========================================================================
on('POST', '/api/v1/pam/jit/requests', (ctx) => {
  const b = ctx.body || {}
  const fields = {}
  if (!b.resource_id) fields.resource_id = 'Pick the resource you need.'
  if (String(b.justification || '').trim().length < 10) fields.justification = 'Give at least 10 characters of justification.'
  const mins = Number(b.duration_minutes || 0)
  if (!mins) fields.duration_minutes = 'Choose how long you need it for.'
  else if (mins > 480) fields.duration_minutes = 'The longest window this deployment allows is 480 minutes.'
  if (Object.keys(fields).length) return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', fields)
  const r = db.resources.find((x) => x.id === b.resource_id)
  const req = {
    id: uid('jit'), org_id: F.ORG, requester_user_id: ctx.user.user_id, requester_username: ctx.user.username,
    resource_id: b.resource_id, resource_name: r ? r.name : b.resource_id, request_type: 'STANDARD',
    status: 'PENDING', justification: b.justification, duration_minutes: mins,
    requested_at: new Date().toISOString(), request_expires_at: F.iso(120), ticket_ref: b.ticket_ref || null,
  }
  db.jit.unshift(req)
  auditRow(ctx.user, 'JIT', 'jit.request.created', 'SUCCESS', `resource:${req.resource_name}`)
  return ok(ctx.res, { request: req, next: 'Two administrators must approve before access is granted.' }, 201)
})
on('POST', '/api/v1/pam/jit/breakglass', (ctx) => {
  const b = ctx.body || {}
  const fields = {}
  if (!b.resource_id) fields.resource_id = 'Pick the resource you need.'
  if (String(b.justification || '').trim().length < 10) fields.justification = 'Give at least 10 characters of justification.'
  if (Object.keys(fields).length) return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', fields)
  const r = db.resources.find((x) => x.id === b.resource_id)
  const req = {
    id: uid('jit'), org_id: F.ORG, requester_user_id: ctx.user.user_id, requester_username: ctx.user.username,
    resource_id: b.resource_id, resource_name: r ? r.name : b.resource_id, request_type: 'BREAKGLASS',
    status: 'WAITING', justification: b.justification, duration_minutes: Number(b.duration_minutes || 60),
    requested_at: new Date().toISOString(), available_at: F.iso(15), request_expires_at: F.iso(75),
    breakglass_note: b.breakglass_note || '', ticket_ref: b.ticket_ref || null,
  }
  db.jit.unshift(req)
  auditRow(ctx.user, 'BREAK_GLASS', 'breakglass.requested', 'SUCCESS', `resource:${req.resource_name}`)
  return ok(ctx.res, { request: req, available_at: req.available_at, waiting_period_min: 15 }, 201)
})
on('GET', '/api/v1/pam/jit/requests', (ctx) => {
  let rows = db.jit.filter((r) => r.requester_user_id === ctx.user.user_id)
  if (ctx.query.status) rows = rows.filter((r) => r.status === ctx.query.status)
  if (ctx.query.type) rows = rows.filter((r) => r.request_type === ctx.query.type)
  if (ctx.query.resource_id) rows = rows.filter((r) => r.resource_id === ctx.query.resource_id)
  if (ctx.query.q) {
    const q = ctx.query.q.toLowerCase()
    rows = rows.filter((r) => `${r.resource_name} ${r.justification}`.toLowerCase().includes(q))
  }
  const { items, pagination } = paginate(rows, ctx.query)
  return ok(ctx.res, { requests: items, pagination })
})
on('GET', '/api/v1/pam/jit/requests/:id', (ctx) => {
  const r = db.jit.find((x) => x.id === ctx.params.id)
  if (!r) return fail(ctx.res, 404, 'NOT_FOUND', 'That request does not exist.')
  return ok(ctx.res, { request: { ...r, grant: db.grants.find((g) => g.jit_request_id === r.id) || null } })
})
on('POST', '/api/v1/pam/jit/requests/:id/cancel', (ctx) => {
  const r = db.jit.find((x) => x.id === ctx.params.id)
  if (!r) return fail(ctx.res, 404, 'NOT_FOUND', 'That request does not exist.')
  if (!['PENDING', 'PARTIALLY_APPROVED', 'WAITING'].includes(r.status))
    return fail(ctx.res, 409, 'ALREADY_DECIDED', `This request is already ${r.status.toLowerCase()}, so it cannot be cancelled.`)
  r.status = 'CANCELLED'
  r.decided_at = new Date().toISOString()
  r.decision_reason = ctx.body?.reason || ''
  auditRow(ctx.user, 'JIT', 'jit.request.cancelled', 'SUCCESS', `resource:${r.resource_name}`)
  return ok(ctx.res, { request: r })
})
on('GET', '/api/v1/pam/jit/grants', (ctx) => {
  let rows = db.grants.filter((g) => g.user_id === ctx.user.user_id)
  if (ctx.query.status) rows = rows.filter((g) => g.status === ctx.query.status)
  if (ctx.query.active_only === 'true') rows = rows.filter((g) => g.status === 'ACTIVE')
  if (ctx.query.resource_id) rows = rows.filter((g) => g.resource_id === ctx.query.resource_id)
  const { items, pagination } = paginate(rows, ctx.query)
  return ok(ctx.res, { grants: items, pagination })
})

// ===========================================================================
// audit (any authenticated caller)
// ===========================================================================
function filterAudit(rows, q) {
  let out = rows
  if (q.category) out = out.filter((r) => r.category === q.category)
  if (q.outcome) out = out.filter((r) => r.outcome === q.outcome)
  if (q.severity) out = out.filter((r) => r.severity === q.severity)
  if (q.user_id) out = out.filter((r) => r.user_id === q.user_id)
  if (q.action) out = out.filter((r) => r.action.includes(q.action))
  if (q.resource) out = out.filter((r) => String(r.resource || '').includes(q.resource))
  if (q.from_time) out = out.filter((r) => r.occurred_at >= q.from_time)
  if (q.to_time) out = out.filter((r) => r.occurred_at <= q.to_time)
  if (q.q) {
    const s = q.q.toLowerCase()
    out = out.filter((r) => `${r.action} ${r.username} ${r.resource}`.toLowerCase().includes(s))
  }
  if (q.sort === 'occurred_at_asc') out = [...out].reverse()
  return out
}
on('GET', '/api/v1/pam/audit', (ctx) => {
  const rows = filterAudit(db.audit, ctx.query)
  const limit = Math.min(500, Number(ctx.query.limit || 50))
  const offset = Number(ctx.query.offset || 0)
  return ok(ctx.res, { total: rows.length, limit, offset, items: rows.slice(offset, offset + limit) })
})
on('GET', '/api/v1/pam/audit/request/:id', (ctx) =>
  ok(ctx.res, db.audit.filter((r) => r.request_id === ctx.params.id)))
on('GET', '/api/v1/pam/audit/user/:id', (ctx) =>
  ok(ctx.res, db.audit.filter((r) => r.user_id === ctx.params.id).slice(0, Number(ctx.query.limit || 50))))
on('GET', '/api/v1/pam/audit/resource/:resource', (ctx) =>
  ok(ctx.res, db.audit.filter((r) => String(r.resource || '').includes(ctx.params.resource)).slice(0, Number(ctx.query.limit || 50))))
on('POST', '/api/v1/pam/reports/compliance', (ctx) => {
  const body = Buffer.from(
    `PAM compliance report\nGenerated ${new Date().toISOString()}\nRows ${db.audit.length}\n`,
    'utf8'
  )
  ctx.res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="pam-compliance-report.csv"',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Disposition',
  })
  ctx.res.end(body)
})

// ===========================================================================
// admin (RequireAdmin)
// ===========================================================================
// Key names come from the console's own reader (DashboardPage picks
// active_sessions, pending_approvals, active_grants, active_resources and
// active_breakglass_grants). Point in time counts only: this endpoint has no
// history, which is why nothing in the console draws a trend from it.
on('GET', '/api/v1/pam/admin/stats', (ctx) =>
  ok(ctx.res, {
    active_sessions: db.sessions.filter((s) => s.status === 'ACTIVE').length,
    pending_approvals: db.jit.filter((r) => ['PENDING', 'PARTIALLY_APPROVED', 'WAITING'].includes(r.status)).length,
    pending_requests: db.jit.filter((r) => r.status === 'PENDING').length,
    partially_approved: db.jit.filter((r) => r.status === 'PARTIALLY_APPROVED').length,
    active_grants: db.grants.filter((g) => g.status === 'ACTIVE').length,
    active_resources: db.resources.filter((r) => r.is_active).length,
    active_breakglass_grants: db.grants.filter((g) => g.status === 'ACTIVE' && g.is_breakglass).length,
    total_users: db.users.length,
    active_users: db.users.filter((u) => u.status === 'ACTIVE').length,
    total_safes: db.safes.length,
    total_credentials: Object.values(db.credentials).reduce((n, a) => n + a.length, 0),
    audit_events: db.audit.length,
  }), 'admin')

on('GET', '/api/v1/pam/admin/jit-requests', (ctx) => {
  let rows = db.jit
  if (ctx.query.status) rows = rows.filter((r) => r.status === ctx.query.status)
  if (ctx.query.type) rows = rows.filter((r) => r.request_type === ctx.query.type)
  const { items, pagination } = paginate(rows, ctx.query)
  return ok(ctx.res, { requests: items, pagination })
}, 'admin')
on('GET', '/api/v1/pam/admin/jit-requests/:id', (ctx) => {
  const r = db.jit.find((x) => x.id === ctx.params.id)
  if (!r) return fail(ctx.res, 404, 'NOT_FOUND', 'That request does not exist.')
  return ok(ctx.res, {
    request: r,
    grant: db.grants.find((g) => g.jit_request_id === r.id) || null,
    approvals: db.approvals[r.id] || [],
    audit_trail: db.audit.filter((a) => a.resource === `resource:${r.resource_name}`).slice(0, 8),
  })
}, 'admin')
on('POST', '/api/v1/pam/admin/actions/jit-requests/:id/approve', (ctx) => {
  const r = db.jit.find((x) => x.id === ctx.params.id)
  if (!r) return fail(ctx.res, 404, 'NOT_FOUND', 'That request does not exist.')
  if (!['PENDING', 'PARTIALLY_APPROVED'].includes(r.status))
    return fail(ctx.res, 409, 'ALREADY_DECIDED', `This request is already ${r.status.toLowerCase()}.`)
  const existing = (db.approvals[r.id] ||= [])
  if (existing.some((a) => a.approver_user_id === ctx.user.user_id))
    return fail(ctx.res, 409, 'DUPLICATE_APPROVER', 'You have already approved this request. A second, different administrator has to approve it.')
  existing.push({
    id: uid('ap'), jit_request_id: r.id, approver_user_id: ctx.user.user_id, approver_username: ctx.user.username,
    approver_rank: isRoot(ctx.user) ? 100 : 80, decision: 'APPROVE', reason: ctx.body?.reason || '',
    decided_at: new Date().toISOString(),
  })
  const final = isRoot(ctx.user) || existing.filter((a) => a.decision === 'APPROVE').length >= 2
  r.status = final ? 'APPROVED' : 'PARTIALLY_APPROVED'
  let grant = null
  if (final) {
    r.decided_at = new Date().toISOString()
    grant = {
      id: uid('gr'), org_id: F.ORG, jit_request_id: r.id, user_id: r.requester_user_id,
      username: r.requester_username, resource_id: r.resource_id, resource_name: r.resource_name,
      status: 'ACTIVE', is_breakglass: r.request_type === 'BREAKGLASS',
      granted_at: new Date().toISOString(), expires_at: F.iso(r.duration_minutes), granted_by: ctx.user.user_id,
    }
    db.grants.unshift(grant)
  }
  auditRow(ctx.user, 'JIT', 'jit.request.approved', 'SUCCESS', `resource:${r.resource_name}`, { reason: ctx.body?.reason })
  return ok(ctx.res, { request: r, approvals: existing, grant })
}, 'admin')
on('POST', '/api/v1/pam/admin/actions/jit-requests/:id/deny', (ctx) => {
  const r = db.jit.find((x) => x.id === ctx.params.id)
  if (!r) return fail(ctx.res, 404, 'NOT_FOUND', 'That request does not exist.')
  if (!['PENDING', 'PARTIALLY_APPROVED', 'WAITING'].includes(r.status))
    return fail(ctx.res, 409, 'ALREADY_DECIDED', `This request is already ${r.status.toLowerCase()}.`)
  const reason = String(ctx.body?.reason || '').trim()
  if (reason.length < 5)
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { reason: 'Say why this is being denied. The requester sees it.' })
  r.status = 'DENIED'
  r.decided_at = new Date().toISOString()
  r.decision_reason = reason
  ;(db.approvals[r.id] ||= []).push({
    id: uid('ap'), jit_request_id: r.id, approver_user_id: ctx.user.user_id, approver_username: ctx.user.username,
    approver_rank: isRoot(ctx.user) ? 100 : 80, decision: 'DENY', reason, decided_at: new Date().toISOString(),
  })
  auditRow(ctx.user, 'JIT', 'jit.request.denied', 'DENIED', `resource:${r.resource_name}`, { reason })
  return ok(ctx.res, { request: r })
}, 'admin')

on('GET', '/api/v1/pam/admin/grants', (ctx) => {
  let rows = db.grants
  if (ctx.query.status) rows = rows.filter((g) => g.status === ctx.query.status)
  if (ctx.query.active_only === 'true') rows = rows.filter((g) => g.status === 'ACTIVE')
  const { items, pagination } = paginate(rows, ctx.query)
  return ok(ctx.res, { grants: items, pagination })
}, 'admin')
on('POST', '/api/v1/pam/admin/actions/grants/:id/revoke', (ctx) => {
  const g = db.grants.find((x) => x.id === ctx.params.id)
  if (!g) return fail(ctx.res, 404, 'NOT_FOUND', 'That grant does not exist.')
  if (g.status !== 'ACTIVE') return fail(ctx.res, 409, 'NOT_ACTIVE', 'That grant is not active any more.')
  const reason = String(ctx.body?.reason || '').trim()
  if (reason.length < 5)
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { reason: 'Say why this access is being taken back.' })
  g.status = 'REVOKED'
  g.revoked_at = new Date().toISOString()
  g.revoked_by = ctx.user.user_id
  g.revoke_reason = reason
  const killed = db.sessions.filter((s) => s.status === 'ACTIVE' && s.grant_id === g.id)
  for (const s of killed) {
    s.status = 'KILLED'
    s.ended_at = new Date().toISOString()
    s.kill_reason = 'Grant revoked'
    s.killed_by = ctx.user.user_id
  }
  auditRow(ctx.user, 'JIT', 'jit.grant.revoked', 'SUCCESS', `resource:${g.resource_name}`, { reason })
  return ok(ctx.res, { grant: g, sessions_killed: killed.length })
}, 'admin')

on('GET', '/api/v1/pam/admin/sessions', (ctx) => {
  let rows = db.sessions
  if (ctx.query.status) rows = rows.filter((s) => s.status === ctx.query.status)
  if (ctx.query.active_only === 'true') rows = rows.filter((s) => s.status === 'ACTIVE')
  const { items, pagination } = paginate(rows, ctx.query)
  return ok(ctx.res, { sessions: items, pagination })
}, 'admin')
on('POST', '/api/v1/pam/admin/actions/sessions/:id/kill', (ctx) => {
  const s = db.sessions.find((x) => x.id === ctx.params.id)
  if (!s) return fail(ctx.res, 404, 'NOT_FOUND', 'That session does not exist.')
  if (s.status !== 'ACTIVE') return fail(ctx.res, 409, 'NOT_ACTIVE', 'That session has already ended.')
  const reason = String(ctx.body?.reason || '').trim()
  if (reason.length < 5)
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { reason: 'Say why this session is being ended.' })
  s.status = 'KILLED'
  s.ended_at = new Date().toISOString()
  s.kill_reason = reason
  s.killed_by = ctx.user.user_id
  auditRow(ctx.user, 'SESSION', 'session.killed', 'SUCCESS', `resource:${s.resource_name}`, { reason })
  return ok(ctx.res, s)
}, 'admin')

on('GET', '/api/v1/pam/admin/recordings', (ctx) => {
  let rows = db.recordings
  if (ctx.query.status) rows = rows.filter((r) => r.status === ctx.query.status)
  const { items, pagination } = paginate(rows, ctx.query)
  return ok(ctx.res, { recordings: items, pagination })
}, 'admin')
on('GET', '/api/v1/pam/admin/recordings/:id/cast', (ctx) => {
  const header = { version: 2, width: 96, height: 28, timestamp: Math.floor(Date.now() / 1000), title: 'psql session' }
  const lines = [JSON.stringify(header)]
  const script = [
    'psql -h pg-payments-prod-01.internal -U payments_app_rw payments\r\n',
    'psql (16.3)\r\nType "help" for help.\r\n\r\n',
    'payments=> SELECT count(*) FROM settlements WHERE created_at::date = DATE 2026-08-18;\r\n',
    '  count\r\n-------\r\n  41822\r\n(1 row)\r\n\r\n',
    'payments=> \\q\r\n',
  ]
  let t = 0.4
  for (const chunk of script) {
    lines.push(JSON.stringify([t, 'o', chunk]))
    t += 1.6
  }
  const body = lines.join('\n')
  ctx.res.writeHead(200, { 'Content-Type': 'application/x-asciicast', 'Access-Control-Allow-Origin': '*' })
  ctx.res.end(body)
}, 'admin')
on('GET', '/api/v1/pam/admin/recordings/:id/commands', (ctx) =>
  ok(ctx.res, {
    commands: [
      { at: 0.4, command: 'psql -h pg-payments-prod-01.internal -U payments_app_rw payments' },
      { at: 3.6, command: 'SELECT count(*) FROM settlements WHERE created_at::date = DATE 2026-08-18;' },
      { at: 8.4, command: '\\q' },
    ],
    count: 3,
  }), 'admin')

on('GET', '/api/v1/pam/admin/audit', (ctx) => {
  const rows = filterAudit(db.audit, ctx.query)
  const { items, pagination } = paginate(rows, ctx.query)
  return ok(ctx.res, { events: items, pagination })
}, 'admin')
on('GET', '/api/v1/pam/admin/audit/verify', (ctx) =>
  ok(ctx.res, { verification: { valid: true, checked: db.audit.length, first_sequence: db.audit[db.audit.length - 1].sequence_number, last_sequence: db.audit[0].sequence_number, broken_at: null, verified_at: new Date().toISOString() } }), 'admin')
on('GET', '/api/v1/pam/admin/breakglass', (ctx) => {
  const rows = db.grants.filter((g) => g.is_breakglass)
  const { items, pagination } = paginate(rows, ctx.query)
  return ok(ctx.res, { grants: items, pagination })
}, 'admin')
on('GET', '/api/v1/pam/admin/breakglass/:id/report', (ctx) => {
  const g = db.grants.find((x) => x.id === ctx.params.id)
  if (!g) return fail(ctx.res, 404, 'NOT_FOUND', 'That break glass grant does not exist.')
  return ok(ctx.res, {
    report: {
      grant: g,
      request: db.jit.find((r) => r.id === g.jit_request_id) || null,
      sessions: db.sessions.filter((s) => s.grant_id === g.id),
      audit_events: db.audit.filter((a) => a.resource === `resource:${g.resource_name}`).slice(0, 20),
    },
  })
}, 'admin')

// resources, admin writes
on('POST', '/api/v1/pam/admin/resources', (ctx) => {
  const b = ctx.body || {}
  const fields = {}
  if (!String(b.name || '').trim()) fields.name = 'Give the resource a name.'
  if (!b.resource_type) fields.resource_type = 'Pick a resource type.'
  if (!String(b.host || '').trim()) fields.host = 'Enter the hostname the console connects to.'
  if (!b.port) fields.port = 'Enter the port.'
  if (Object.keys(fields).length) return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', fields)
  if (db.resources.some((r) => r.name.toLowerCase() === String(b.name).trim().toLowerCase()))
    return fail(ctx.res, 409, 'ALREADY_EXISTS', `A resource called "${b.name}" already exists.`, { name: 'That name is taken.' })
  const r = {
    id: uid('res'), org_id: F.ORG, name: String(b.name).trim(), resource_type: b.resource_type,
    host: b.host, port: Number(b.port), database_name: b.database_name || '',
    description: b.description || '', requires_jit: !!b.requires_jit,
    recording_required: !!b.recording_required, always_record: !!b.always_record,
    connect_mode: b.connect_mode || 'web_terminal', console_url: b.console_url || null,
    is_active: true, created_at: new Date().toISOString(),
  }
  db.resources.push(r)
  auditRow(ctx.user, 'RESOURCE', 'resource.created', 'SUCCESS', `resource:${r.name}`)
  return ok(ctx.res, { resource: r }, 201)
}, 'admin')
on('DELETE', '/api/v1/pam/admin/resources/:id', (ctx) => {
  const i = db.resources.findIndex((r) => r.id === ctx.params.id)
  if (i === -1) return fail(ctx.res, 404, 'NOT_FOUND', 'That resource does not exist.')
  const [r] = db.resources.splice(i, 1)
  auditRow(ctx.user, 'RESOURCE', 'resource.deleted', 'SUCCESS', `resource:${r.name}`)
  return ok(ctx.res, { deleted: true, id: r.id })
}, 'admin')
on('POST', '/api/v1/pam/admin/resources/:id/credential', (ctx) => {
  if (!String(ctx.body?.secret_plaintext || '').trim())
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { secret_plaintext: 'Enter the secret to store.' })
  return ok(ctx.res, { stored: true, resource_id: ctx.params.id }, 201)
}, 'admin')
on('POST', '/api/v1/pam/admin/resources/:id/rotate', (ctx) => {
  if (!String(ctx.body?.new_credential || '').trim())
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { new_credential: 'Enter the new credential.' })
  return ok(ctx.res, { rotated: true, resource_id: ctx.params.id, rotated_at: new Date().toISOString() })
}, 'admin')

// identity
on('GET', '/api/v1/pam/admin/identity/users', (ctx) => {
  let rows = db.users.filter((u) => u.status !== 'DELETED')
  if (ctx.query.q) {
    const q = ctx.query.q.toLowerCase()
    rows = rows.filter((u) => `${u.username} ${u.email} ${u.full_name}`.toLowerCase().includes(q))
  }
  return ok(ctx.res, { users: rows, count: rows.length })
}, 'admin')
on('GET', '/api/v1/pam/admin/identity/users/:id', (ctx) => {
  const u = db.users.find((x) => x.user_id === ctx.params.id)
  if (!u) return fail(ctx.res, 404, 'NOT_FOUND', 'That account does not exist.')
  return ok(ctx.res, {
    user: u,
    access: {
      roles: u.roles.map((n) => db.roles.find((r) => r.name === n) || { name: n }),
      policies: (db.userPolicies[u.user_id] || []).map((pid) => db.policies.find((p) => p.id === pid)).filter(Boolean),
    },
  })
}, 'admin')
on('POST', '/api/v1/pam/admin/identity/users', (ctx) => {
  const b = ctx.body || {}
  const fields = {}
  if (!String(b.username || '').trim()) fields.username = 'Choose a username.'
  if (!/^\S+@\S+\.\S+$/.test(String(b.email || ''))) fields.email = 'Enter a valid email address.'
  if (String(b.password || '').length < 12) fields.password = 'Use at least 12 characters.'
  if (Object.keys(fields).length) return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', fields)
  if (db.users.some((u) => u.username.toLowerCase() === String(b.username).trim().toLowerCase()))
    return fail(ctx.res, 409, 'ALREADY_EXISTS', `The username "${b.username}" is already taken.`, { username: 'That username is taken.' })
  const u = {
    user_id: uid('u'), org_id: F.ORG, username: String(b.username).trim(), email: b.email,
    full_name: b.full_name || '', status: 'ACTIVE', mfa_enabled: false, is_protected: false,
    roles: b.role && b.role !== 'user' ? ['user', b.role] : ['user'],
    failed_login_attempts: 0, last_login_at: null, last_login_ip: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  db.users.push(u)
  auditRow(ctx.user, 'ADMIN', 'admin.user.created', 'SUCCESS', `user:${u.username}`)
  return ok(ctx.res, { user: u }, 201)
}, 'admin')
on('PATCH', '/api/v1/pam/admin/identity/users/:id', (ctx) => {
  const u = db.users.find((x) => x.user_id === ctx.params.id)
  if (!u) return fail(ctx.res, 404, 'NOT_FOUND', 'That account does not exist.')
  if (ctx.body.email !== undefined) {
    if (!/^\S+@\S+\.\S+$/.test(String(ctx.body.email)))
      return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { email: 'Enter a valid email address.' })
    u.email = ctx.body.email
  }
  if (ctx.body.full_name !== undefined) u.full_name = ctx.body.full_name
  u.updated_at = new Date().toISOString()
  auditRow(ctx.user, 'ADMIN', 'admin.user.updated', 'SUCCESS', `user:${u.username}`)
  return ok(ctx.res, { user: u })
}, 'admin')
on('POST', '/api/v1/pam/admin/identity/users/:id/status', (ctx) => {
  const u = db.users.find((x) => x.user_id === ctx.params.id)
  if (!u) return fail(ctx.res, 404, 'NOT_FOUND', 'That account does not exist.')
  if (u.is_protected)
    return fail(ctx.res, 403, 'PROTECTED_ACCOUNT', 'This account is protected and its status cannot be changed from the console.')
  u.status = ctx.body?.status
  if (u.status === 'ACTIVE') {
    u.failed_login_attempts = 0
    delete u.locked_until
  }
  u.updated_at = new Date().toISOString()
  auditRow(ctx.user, 'ADMIN', 'admin.user.status.changed', 'SUCCESS', `user:${u.username}`, { status: u.status })
  return ok(ctx.res, u)
}, 'admin')
on('DELETE', '/api/v1/pam/admin/identity/users/:id', (ctx) => {
  const u = db.users.find((x) => x.user_id === ctx.params.id)
  if (!u) return fail(ctx.res, 404, 'NOT_FOUND', 'That account does not exist.')
  if (u.is_protected) return fail(ctx.res, 403, 'PROTECTED_ACCOUNT', 'This account is protected and cannot be deleted.')
  u.status = 'DELETED'
  auditRow(ctx.user, 'ADMIN', 'admin.user.deleted', 'SUCCESS', `user:${u.username}`)
  return ok(ctx.res, { deleted: true, id: u.user_id })
}, 'admin')
on('POST', '/api/v1/pam/admin/identity/users/:id/reset-password', (ctx) => {
  if (String(ctx.body?.new_password || '').length < 12)
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { new_password: 'Use at least 12 characters.' })
  auditRow(ctx.user, 'ADMIN', 'admin.user.password.reset', 'SUCCESS')
  return ok(ctx.res, { reset: true })
}, 'admin')
on('POST', '/api/v1/pam/admin/identity/users/:id/reset-mfa', (ctx) => {
  const u = db.users.find((x) => x.user_id === ctx.params.id)
  if (!u) return fail(ctx.res, 404, 'NOT_FOUND', 'That account does not exist.')
  if (String(ctx.body?.reason || '').trim().length < 5)
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { reason: 'Say why the device is being removed.' })
  u.mfa_enabled = false
  auditRow(ctx.user, 'ADMIN', 'admin.user.mfa.reset', 'SUCCESS', `user:${u.username}`)
  return ok(ctx.res, u)
}, 'admin')
on('POST', '/api/v1/pam/admin/identity/users/:id/roles', (ctx) => {
  const u = db.users.find((x) => x.user_id === ctx.params.id)
  if (!u) return fail(ctx.res, 404, 'NOT_FOUND', 'That account does not exist.')
  const role = ctx.body?.role_name
  if (['admin', 'root'].includes(role))
    return fail(ctx.res, 403, 'ROLE_NOT_ASSIGNABLE', 'Administrative access is granted through admin delegation, not by assigning a role.')
  if (!u.roles.includes(role)) u.roles.push(role)
  auditRow(ctx.user, 'ADMIN', 'admin.role.assigned', 'SUCCESS', `user:${u.username}`, { role })
  return ok(ctx.res, u)
}, 'admin')
on('DELETE', '/api/v1/pam/admin/identity/users/:id/roles/:role', (ctx) => {
  const u = db.users.find((x) => x.user_id === ctx.params.id)
  if (!u) return fail(ctx.res, 404, 'NOT_FOUND', 'That account does not exist.')
  u.roles = u.roles.filter((r) => r !== ctx.params.role)
  auditRow(ctx.user, 'ADMIN', 'admin.role.removed', 'SUCCESS', `user:${u.username}`, { role: ctx.params.role })
  return ok(ctx.res, u)
}, 'admin')
on('POST', '/api/v1/pam/admin/identity/users/:id/policies', (ctx) => {
  const list = (db.userPolicies[ctx.params.id] ||= [])
  if (!list.includes(ctx.body?.policy_id)) list.push(ctx.body.policy_id)
  return ok(ctx.res, { attached: true })
}, 'admin')
on('DELETE', '/api/v1/pam/admin/identity/users/:id/policies/:policyId', (ctx) => {
  db.userPolicies[ctx.params.id] = (db.userPolicies[ctx.params.id] || []).filter((p) => p !== ctx.params.policyId)
  return ok(ctx.res, { detached: true })
}, 'admin')
on('GET', '/api/v1/pam/admin/identity/users/:id/delegation', (ctx) => {
  const d = db.delegations[ctx.params.id]
  const u = db.users.find((x) => x.user_id === ctx.params.id)
  if (!d) {
    const inherent = u && u.roles.includes('admin')
    return ok(ctx.res, inherent
      ? { status: 'active', granted_at: F.iso(-262800), expires_at: null, reason: 'Delegated at install time.', granted_by: 'root' }
      : { status: 'none' })
  }
  return ok(ctx.res, d)
}, 'admin')
on('POST', '/api/v1/pam/admin/identity/users/:id/delegate-admin', (ctx) => {
  if (!isRoot(ctx.user))
    return fail(ctx.res, 403, 'ROOT_REQUIRED', 'Only root can grant administrative access.')
  const u = db.users.find((x) => x.user_id === ctx.params.id)
  if (!u) return fail(ctx.res, 404, 'NOT_FOUND', 'That account does not exist.')
  if (u.is_protected) return fail(ctx.res, 403, 'PROTECTED_ACCOUNT', 'This account is protected.')
  if (String(ctx.body?.reason || '').trim().length < 10)
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { reason: 'Give at least 10 characters of justification.' })
  if (!u.roles.includes('admin')) u.roles.push('admin')
  db.delegations[u.user_id] = {
    status: 'active', granted_at: new Date().toISOString(),
    expires_at: ctx.body.expires_at || null, reason: ctx.body.reason, granted_by: ctx.user.username,
  }
  auditRow(ctx.user, 'ADMIN', 'admin.delegation.granted', 'SUCCESS', `user:${u.username}`)
  return ok(ctx.res, db.delegations[u.user_id])
}, 'admin')
on('DELETE', '/api/v1/pam/admin/identity/users/:id/delegate-admin', (ctx) => {
  if (!isRoot(ctx.user)) return fail(ctx.res, 403, 'ROOT_REQUIRED', 'Only root can revoke administrative access.')
  const u = db.users.find((x) => x.user_id === ctx.params.id)
  if (!u) return fail(ctx.res, 404, 'NOT_FOUND', 'That account does not exist.')
  if (String(ctx.body?.reason || '').trim().length < 10)
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { reason: 'Give at least 10 characters of justification.' })
  u.roles = u.roles.filter((r) => r !== 'admin')
  db.delegations[u.user_id] = { status: 'revoked', revoked_at: new Date().toISOString(), reason: ctx.body.reason, revoked_by: ctx.user.username }
  auditRow(ctx.user, 'ADMIN', 'admin.delegation.revoked', 'SUCCESS', `user:${u.username}`)
  return ok(ctx.res, db.delegations[u.user_id])
}, 'admin')

// rbac
on('GET', '/api/v1/pam/admin/rbac/roles', (ctx) =>
  ok(ctx.res, { roles: db.roles.map((r) => ({
    ...r,
    user_count: db.users.filter((u) => u.roles.includes(r.name)).length,
    policy_count: (db.rolePolicies[r.id] || []).length,
  })) }), 'admin')
on('GET', '/api/v1/pam/admin/rbac/roles/:id', (ctx) => {
  const r = db.roles.find((x) => x.id === ctx.params.id)
  if (!r) return fail(ctx.res, 404, 'NOT_FOUND', 'That role does not exist.')
  return ok(ctx.res, { role: r, policies: (db.rolePolicies[r.id] || []).map((p) => db.policies.find((x) => x.id === p)).filter(Boolean) })
}, 'admin')
on('POST', '/api/v1/pam/admin/rbac/roles', (ctx) => {
  const name = String(ctx.body?.name || '').trim()
  if (!name) return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { name: 'Give the role a name.' })
  if (db.roles.some((r) => r.name.toLowerCase() === name.toLowerCase()))
    return fail(ctx.res, 409, 'ALREADY_EXISTS', `A role called "${name}" already exists.`, { name: 'That name is taken.' })
  const r = { id: uid('r'), org_id: F.ORG, name, description: ctx.body.description || '', is_system: false, created_at: new Date().toISOString() }
  db.roles.push(r)
  auditRow(ctx.user, 'ADMIN', 'admin.role.created', 'SUCCESS', `role:${name}`)
  return ok(ctx.res, { role: r }, 201)
}, 'admin')
on('PATCH', '/api/v1/pam/admin/rbac/roles/:id', (ctx) => {
  const r = db.roles.find((x) => x.id === ctx.params.id)
  if (!r) return fail(ctx.res, 404, 'NOT_FOUND', 'That role does not exist.')
  r.description = ctx.body?.description || ''
  return ok(ctx.res, { role: r })
}, 'admin')
on('DELETE', '/api/v1/pam/admin/rbac/roles/:id', (ctx) => {
  const r = db.roles.find((x) => x.id === ctx.params.id)
  if (!r) return fail(ctx.res, 404, 'NOT_FOUND', 'That role does not exist.')
  if (r.is_system) return fail(ctx.res, 403, 'SYSTEM_ROLE', 'Built in roles cannot be deleted.')
  const holders = db.users.filter((u) => u.roles.includes(r.name)).length
  if (holders > 0)
    return fail(ctx.res, 409, 'ROLE_IN_USE', `${holders} ${holders === 1 ? 'account holds' : 'accounts hold'} this role. Remove it from them first.`)
  db.roles = db.roles.filter((x) => x.id !== r.id)
  auditRow(ctx.user, 'ADMIN', 'admin.role.deleted', 'SUCCESS', `role:${r.name}`)
  return ok(ctx.res, { deleted: true, id: r.id })
}, 'admin')
on('POST', '/api/v1/pam/admin/rbac/roles/:id/policies', (ctx) => {
  const list = (db.rolePolicies[ctx.params.id] ||= [])
  if (!list.includes(ctx.body?.policy_id)) list.push(ctx.body.policy_id)
  return ok(ctx.res, { attached: true })
}, 'admin')
on('DELETE', '/api/v1/pam/admin/rbac/roles/:id/policies/:policyId', (ctx) => {
  db.rolePolicies[ctx.params.id] = (db.rolePolicies[ctx.params.id] || []).filter((p) => p !== ctx.params.policyId)
  return ok(ctx.res, { detached: true })
}, 'admin')
on('GET', '/api/v1/pam/admin/rbac/policies', (ctx) =>
  ok(ctx.res, { policies: db.policies.map((p) => ({
    ...p,
    role_count: Object.entries(db.rolePolicies).filter(([, ids]) => ids.includes(p.id)).length,
  })) }), 'admin')
on('GET', '/api/v1/pam/admin/rbac/policies/:id', (ctx) => {
  const p = db.policies.find((x) => x.id === ctx.params.id)
  return p ? ok(ctx.res, { policy: p }) : fail(ctx.res, 404, 'NOT_FOUND', 'That policy does not exist.')
}, 'admin')
on('POST', '/api/v1/pam/admin/rbac/policies', (ctx) => {
  const b = ctx.body || {}
  const fields = {}
  if (!String(b.name || '').trim()) fields.name = 'Give the policy a name.'
  if (!Array.isArray(b.actions) || b.actions.length === 0) fields.actions = 'Add at least one action.'
  if (!Array.isArray(b.resources) || b.resources.length === 0) fields.resources = 'Add at least one resource pattern.'
  if (!['allow', 'deny'].includes(b.effect)) fields.effect = 'Choose allow or deny.'
  if (Object.keys(fields).length) return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', fields)
  if (db.policies.some((p) => p.name.toLowerCase() === String(b.name).trim().toLowerCase()))
    return fail(ctx.res, 409, 'ALREADY_EXISTS', `A policy called "${b.name}" already exists.`, { name: 'That name is taken.' })
  const p = { id: uid('p'), org_id: F.ORG, name: String(b.name).trim(), description: b.description || '', effect: b.effect, actions: b.actions, resources: b.resources, is_system: false, created_at: new Date().toISOString() }
  db.policies.push(p)
  auditRow(ctx.user, 'ADMIN', 'admin.policy.created', 'SUCCESS', `policy:${p.name}`)
  return ok(ctx.res, { policy: p }, 201)
}, 'admin')
on('PATCH', '/api/v1/pam/admin/rbac/policies/:id', (ctx) => {
  const p = db.policies.find((x) => x.id === ctx.params.id)
  if (!p) return fail(ctx.res, 404, 'NOT_FOUND', 'That policy does not exist.')
  Object.assign(p, ctx.body || {})
  return ok(ctx.res, { policy: p })
}, 'admin')
on('DELETE', '/api/v1/pam/admin/rbac/policies/:id', (ctx) => {
  const p = db.policies.find((x) => x.id === ctx.params.id)
  if (!p) return fail(ctx.res, 404, 'NOT_FOUND', 'That policy does not exist.')
  if (p.is_system) return fail(ctx.res, 403, 'SYSTEM_POLICY', 'Built in policies cannot be deleted.')
  db.policies = db.policies.filter((x) => x.id !== p.id)
  return ok(ctx.res, { deleted: true, id: p.id })
}, 'admin')

// mfa policy
on('GET', '/api/v1/pam/admin/mfa-policy', (ctx) =>
  ok(ctx.res, {
    rules: db.mfaRules,
    modes: ['off', 'monitor', 'grace', 'enforce'],
    summary: { roles_covered: db.mfaRules.length, enforcing: db.mfaRules.filter((r) => r.mode === 'enforce').length },
  }), 'admin')
on('GET', '/api/v1/pam/admin/mfa-policy/compliance', (ctx) =>
  ok(ctx.res, {
    accounts: db.users.map((u) => ({
      user_id: u.user_id, username: u.username, email: u.email, roles: u.roles,
      mfa_enabled: u.mfa_enabled, status: u.status,
    })),
    total: db.users.length,
    enrolled: db.users.filter((u) => u.mfa_enabled).length,
  }), 'admin')
on('PUT', '/api/v1/pam/admin/mfa-policy/rules/:role', (ctx) => {
  if (!isRoot(ctx.user)) return fail(ctx.res, 403, 'ROOT_REQUIRED', 'Only root can change MFA enforcement.')
  const mode = ctx.body?.mode
  if (!['off', 'monitor', 'grace', 'enforce'].includes(mode))
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { mode: 'Choose an enforcement mode.' })
  const existing = db.mfaRules.find((r) => r.role_name === ctx.params.role)
  const row = {
    role_name: ctx.params.role, mode, grace_hours: Number(ctx.body.grace_hours || 0),
    reason: ctx.body.reason || '', updated_at: new Date().toISOString(), updated_by: ctx.user.username,
  }
  if (existing) Object.assign(existing, row)
  else db.mfaRules.push(row)
  auditRow(ctx.user, 'ADMIN', 'admin.mfa_policy.updated', 'SUCCESS', `role:${ctx.params.role}`, { mode })
  return ok(ctx.res, row)
}, 'admin')
on('DELETE', '/api/v1/pam/admin/mfa-policy/rules/:role', (ctx) => {
  if (!isRoot(ctx.user)) return fail(ctx.res, 403, 'ROOT_REQUIRED', 'Only root can change MFA enforcement.')
  db.mfaRules = db.mfaRules.filter((r) => r.role_name !== ctx.params.role)
  return ok(ctx.res, { deleted: true, role_name: ctx.params.role })
}, 'admin')

// vault ops
on('POST', '/api/v1/pam/admin/vault/backup', (ctx) =>
  ok(ctx.res, { s3_object_key: `vault-backups/${new Date().toISOString().slice(0, 10)}/${uid('bk')}.enc`, size_bytes: 2_418_331, created_at: new Date().toISOString() }, 201), 'admin')
on('POST', '/api/v1/pam/admin/vault/restore', (ctx) => {
  if (!String(ctx.body?.s3_object_key || '').trim())
    return fail(ctx.res, 422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { s3_object_key: 'Enter the backup object key to restore from.' })
  return ok(ctx.res, { restored: true, s3_object_key: ctx.body.s3_object_key, restored_at: new Date().toISOString() })
}, 'admin')

// ===========================================================================
// dispatch
// ===========================================================================
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,Idempotency-Key',
      })
      return res.end()
    }
    let body = null
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw) { try { body = JSON.parse(raw) } catch { body = null } }
    const query = Object.fromEntries(url.searchParams.entries())

    log({ at: new Date().toISOString(), method: req.method, path: url.pathname, query, body })

    const finish = () => {
      for (const r of routes) {
        if (r.method !== req.method) continue
        const params = match(r.pattern, url.pathname)
        if (!params) continue
        const user = userOf(req)
        if (r.guard !== 'public' && !user)
          return fail(res, 401, 'UNAUTHENTICATED', 'Your session has expired. Sign in again.')
        if (r.guard === 'admin' && !isAdmin(user))
          return fail(res, 403, 'FORBIDDEN', 'This area is limited to administrators.')
        try {
          return r.handler({ req, res, body, query, params, user })
        } catch (e) {
          return fail(res, 500, 'INTERNAL', String(e && e.message))
        }
      }
      return fail(res, 404, 'NOT_FOUND', `No route for ${req.method} ${url.pathname}`)
    }
    if (LATENCY) setTimeout(finish, LATENCY)
    else finish()
  })
})

server.listen(PORT, () => {
  try { fs.writeFileSync(LOG, '') } catch { /* ignore */ }
  const total = routes.length
  console.log(`mock api listening on http://127.0.0.1:${PORT} (${total} routes), log ${LOG}`)
})
