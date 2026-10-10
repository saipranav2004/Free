// Provisions (or updates) a staff account. Runs on a trusted machine only.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=<secret> \
//   node scripts/create-staff.mjs --email owner@example.com --name "Asha" --role owner [--password '...']
//
// The secret key bypasses Row Level Security. Never put it in a VITE_ variable,
// in the browser, or in source control.
import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', default: 'kitchen' },
    password: { type: 'string' },
  },
})

const url = process.env.SUPABASE_URL
const secret = process.env.SUPABASE_SECRET_KEY
if (!url || !secret) {
  console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in the environment.')
  process.exit(1)
}
if (!values.email || !values.name || !['owner', 'kitchen'].includes(values.role)) {
  console.error('Usage: --email <email> --name <display name> --role owner|kitchen [--password <min 8 chars>]')
  process.exit(1)
}
const password = values.password ?? randomBytes(9).toString('base64url')
if (password.length < 8) {
  console.error('Password must be at least 8 characters.')
  process.exit(1)
}

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })

async function findUserByEmail(email) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    if (hit) return hit
    if (data.users.length < 200) return null
  }
  return null
}

let user = await findUserByEmail(values.email)
let created = false
if (!user) {
  const { data, error } = await admin.auth.admin.createUser({ email: values.email, password, email_confirm: true })
  if (error) throw error
  user = data.user
  created = true
} else if (values.password) {
  const { error } = await admin.auth.admin.updateUserById(user.id, { password })
  if (error) throw error
}

const { error } = await admin
  .from('staff')
  .upsert({ user_id: user.id, display_name: values.name, role: values.role, is_active: true }, { onConflict: 'user_id' })
if (error) throw error

console.log(`${created ? 'Created' : 'Updated'} ${values.role} account for ${values.email}.`)
if (created || values.password) console.log(`Password: ${password}  (share it privately; ask them to keep it safe)`)
