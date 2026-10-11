// DEV / DEMO ONLY: inserts ~7 days of completed sample orders into a LOCAL database
// so the Reports screen has realistic data. Never run against production.
//
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node scripts/seed-sample-history.mjs
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
if (!/127\.0\.0\.1|localhost/.test(url)) {
  console.error('Refusing to seed sample history into a non-local database.')
  process.exit(1)
}
const catalog = JSON.parse(readFileSync(new URL('../src/data/catalog.json', import.meta.url), 'utf8'))
const items = catalog.items.filter((i) => i.is_available)
const names = ['Nikitha', 'Arjun', 'Priya', 'Rahul', 'Sneha', 'Karthik', 'Divya', 'Vikram', 'Ananya', 'Rohan', 'Meera', 'Aditya']

let seed = 42
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
const pick = (a) => a[Math.floor(rand() * a.length)]

const client = new pg.Client({ connectionString: url })
await client.connect()
await client.query('begin')
let count = 0
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
for (let d = 7; d >= 1; d--) {
  const n = 22 + Math.floor(rand() * 16)
  for (let k = 0; k < n; k++) {
    const minutes = 8 * 60 + Math.floor(rand() * 600)
    const created = new Date(new Date(`${today}T00:00:00+05:30`).getTime() - d * 86400000 + minutes * 60000)
    const lines = []
    const used = new Set()
    for (let l = 0; l < 1 + Math.floor(rand() * 3); l++) {
      const it = pick(items)
      if (used.has(it.id)) continue
      used.add(it.id)
      const addons = it.addons.length && rand() < 0.35 ? [it.addons[0]] : []
      const unit = it.price + addons.reduce((s, a) => s + a.price, 0)
      const qty = 1 + Math.floor(rand() * 2)
      lines.push({ it, addons, unit, qty })
    }
    const total = lines.reduce((s, l) => s + l.unit * l.qty, 0)
    const units = lines.reduce((s, l) => s + l.qty, 0)
    const cancelled = rand() < 0.04
    const method = rand() < 0.55 ? 'upi' : 'cash'
    const at = (m) => new Date(created.getTime() + m * 60000).toISOString()
    const { rows } = await client.query(
      `insert into public.orders (access_hash, track_key, client_request_id, customer_name, customer_phone, table_label,
         status, payment_method, payment_status, total, item_count, created_at, updated_at, preparing_at, ready_at,
         completed_at, cancelled_at, cancelled_by, cancel_reason, paid_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15,$16,$17,$18,$19) returning id`,
      [
        createHash('sha256').update(randomBytes(32).toString('hex')).digest(),
        randomBytes(16).toString('hex'), randomUUID(), pick(names), `9${String(100000000 + Math.floor(rand() * 899999999))}`,
        rand() < 0.75 ? `T${1 + Math.floor(rand() * 12)}` : null,
        cancelled ? 'cancelled' : 'completed', method, cancelled ? 'unpaid' : 'paid', total, units, created.toISOString(),
        cancelled ? null : at(2), cancelled ? null : at(9), cancelled ? null : at(14), cancelled ? at(3) : null,
        cancelled ? 'staff' : null, cancelled ? 'Item ran out' : null, cancelled ? null : at(14),
      ],
    )
    for (const l of lines) {
      await client.query(
        `insert into public.order_items (order_id, menu_item_id, name, base_price, addons, unit_price, quantity, line_total)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [rows[0].id, l.it.id, l.it.name, l.it.price, JSON.stringify(l.addons.map((a) => ({ id: a.id, name: a.name, price: a.price }))), l.unit, l.qty, l.unit * l.qty],
      )
    }
    count++
  }
}
await client.query('commit')
await client.end()
console.log(`Inserted ${count} sample orders over the last 7 days.`)
