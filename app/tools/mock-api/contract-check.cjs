// ---------------------------------------------------------------------------
// Contract conformance check
// ---------------------------------------------------------------------------
// Reads every api/*.js module in the console, works out which wrapper key each
// call unwraps (`return data.data.users` means the response must carry a
// `users` key), then calls the local contract server and asserts the key is
// actually there. This is what stops the mock drifting from the shape the real
// client expects, which would make an interaction test pass against a server
// that agrees with nobody.
const fs = require('fs')
const path = require('path')
const http = require('http')

const API_DIR = path.join(__dirname, '..', '..', 'src', 'api')
const BASE = 'http://127.0.0.1:' + (process.env.MOCK_PORT || 8787)

function request(method, urlPath, token, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null
    const req = http.request(
      BASE + urlPath,
      {
        method,
        headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = JSON.parse(text) } catch { /* binary or plain text body */ }
          resolve({ status: res.statusCode, json, text, headers: res.headers })
        })
      }
    )
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    if (payload) req.write(payload)
    req.end()
  })
}

// Parse `http.<verb>('<path>'` plus the `return data.data<.key>` that follows.
function parseModule(file) {
  const src = fs.readFileSync(path.join(API_DIR, file), 'utf8')
  // Some modules build their paths from a module level const, e.g.
  // `const BASE = '/api/v1/pam/admin/mfa-policy'` then http.get(`${BASE}/compliance`).
  const consts = {}
  const constRe = /^const (\w+) = '([^']+)'/gm
  let cm
  while ((cm = constRe.exec(src))) consts[cm[1]] = cm[2]
  const out = []
  const fnRe = /export async function (\w+)\(([^)]*)\)\s*\{([\s\S]*?)\n\}/g
  let m
  while ((m = fnRe.exec(src))) {
    const [, name, , bodySrc] = m
    const call = /http\.(get|post|put|patch|delete)\(\s*(`[^`]*`|'[^']*')/.exec(bodySrc)
    if (!call) continue
    const ret = /return data\.data(?:\.(\w+))?/.exec(bodySrc)
    out.push({
      module: file,
      name,
      method: call[1].toUpperCase(),
      template: call[2].slice(1, -1),
      key: ret ? ret[1] || null : null,
      unwraps: !!ret,
      consts,
    })
  }
  return out
}

const SUBS = {
  id: 'res-01', safeId: 'safe-01', credentialId: 'cred-01', userId: 'u-user-0004',
  roleId: 'r-4', policyId: 'p-2', resourceId: 'res-01', deviceId: 'dev-01',
  requestId: 'req-000001', roleName: 'data-platform-oncall', grantId: 'gr-02',
  mfaDeviceId: 'mfa-1', resourcePath: 'postgres-payments-prod-01',
}
// `${id}` means different things on different paths, so the id is chosen from
// the collection the path is addressing rather than from the parameter name.
const BY_PATH = [
  [/jit-requests\//, 'jit-02'],
  [/jit\/requests\//, 'jit-01'],
  [/identity\/users\//, 'u-user-0004'],
  [/rbac\/roles\//, 'r-4'],
  [/rbac\/policies\//, 'p-2'],
  [/\/safes\//, 'safe-01'],
  [/\/credentials\//, 'cred-01'],
  [/\/grants\//, 'gr-02'],
  [/breakglass\//, 'gr-02'],
  [/\/sessions\//, 'sess-01'],
  [/recordings\//, 'rec-03'],
  [/agent\/devices\//, 'dev-01'],
  [/audit\/request\//, 'req-000001'],
  [/audit\/user\//, 'u-user-0004'],
  [/audit\/resource\//, 'postgres-payments-prod-01'],
  [/mfa-policy\/rules\//, 'data-platform-oncall'],
  // connect-info on a JIT gated resource is a legitimate 403, so the shape
  // check addresses the one resource that is open to everyone.
  [/connect-info/, 'res-03'],
]
function concrete(template, consts = {}) {
  return template.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const key = expr.replace(/encodeURIComponent\(|\)/g, '').trim()
    if (key in consts) return consts[key]
    const hit = BY_PATH.find(([re]) => re.test(template))
    return (hit && hit[1]) || SUBS[key] || 'res-01'
  })
}

// GET only: a conformance run must not mutate the fixture set.
;(async () => {
  const login = await request('POST', '/api/v1/auth/login', null, { identifier: 'root', password: 'password' })
  const challenge = login.json.data.challenge_token
  const verified = await request('POST', '/api/v1/auth/mfa/verify', null, { challenge_token: challenge, code: '123456' })
  const token = verified.json.data.access_token

  const rows = fs.readdirSync(API_DIR).filter((f) => f.endsWith('.js')).flatMap(parseModule)
  const gets = rows.filter((r) => r.method === 'GET')
  const problems = []
  for (const r of gets) {
    const urlPath = concrete(r.template, r.consts)
    const res = await request('GET', urlPath, token)
    if (res.status !== 200) {
      problems.push(`${r.module} ${r.name}: GET ${urlPath} -> ${res.status} ${res.json ? res.json.error?.code : res.error || ''}`)
      continue
    }
    if (!res.json) continue // binary body, e.g. a recording cast
    if (!('data' in res.json)) {
      problems.push(`${r.module} ${r.name}: response has no "data" envelope`)
      continue
    }
    if (r.key && !(res.json.data && typeof res.json.data === 'object' && r.key in res.json.data)) {
      problems.push(`${r.module} ${r.name}: unwraps data.data.${r.key}, server sent ${JSON.stringify(Object.keys(res.json.data || {}))}`)
    }
    if (r.unwraps && !r.key && res.json.data === undefined) {
      problems.push(`${r.module} ${r.name}: unwraps data.data, server sent undefined`)
    }
  }
  console.log(`checked ${gets.length} GET endpoints against ${API_DIR}`)
  if (problems.length === 0) console.log('all shapes agree with the client')
  else { problems.forEach((p) => console.log('  MISMATCH ' + p)); process.exitCode = 1 }
})()

