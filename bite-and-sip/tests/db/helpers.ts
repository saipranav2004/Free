import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomBytes, randomUUID } from 'node:crypto'
import catalog from '../../src/data/catalog.json'
import { localEnv } from './env'

export const env = localEnv()
const opts = { auth: { persistSession: false, autoRefreshToken: false } }

export const admin = createClient(env.url, env.secretKey, opts)
export const anonClient = () => createClient(env.url, env.publishableKey, opts)

export const ITEM = Object.fromEntries(catalog.items.map((i) => [i.name, i])) as Record<string, (typeof catalog.items)[number]>
export const MAGGI = ITEM['College Special Maggi']
export const CHAI = ITEM['Masala Chai']
export const PANEER_WRAP = ITEM['Paneer Wrap'] // seeded as unavailable
export const addon = (item: (typeof catalog.items)[number], name: string) => item.addons.find((a) => a.name === name)!.id

export async function staffClient(role: 'owner' | 'kitchen' | null, tag: string): Promise<SupabaseClient> {
  const email = `${tag}-${randomUUID().slice(0, 8)}@test.bitesip`
  const password = randomBytes(12).toString('hex')
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  if (role) {
    const { error: e2 } = await admin.from('staff').insert({ user_id: data.user.id, display_name: tag, role })
    if (e2) throw e2
  }
  const client = createClient(env.url, env.publishableKey, opts)
  const { error: e3 } = await client.auth.signInWithPassword({ email, password })
  if (e3) throw e3
  return client
}

let phoneCounter = 0
export function uniquePhone() {
  phoneCounter += 1
  return `9${String(Date.now() % 1e6).padStart(6, '0')}${String(phoneCounter % 1000).padStart(3, '0')}`
}

export function newToken() {
  return randomBytes(32).toString('hex')
}

export interface PlaceArgs {
  p_client_request_id?: string
  p_access_token?: string
  p_customer_name?: string
  p_customer_phone?: string
  p_payment_method?: 'cash' | 'upi'
  p_table_label?: string | null
  p_items?: unknown
}

export async function placeOrder(client: SupabaseClient, args: PlaceArgs = {}) {
  const token = args.p_access_token ?? newToken()
  const res = await client.rpc('place_order', {
    p_client_request_id: args.p_client_request_id ?? randomUUID(),
    p_access_token: token,
    p_customer_name: args.p_customer_name ?? 'Test Student',
    p_customer_phone: args.p_customer_phone ?? uniquePhone(),
    p_payment_method: args.p_payment_method ?? 'cash',
    p_table_label: args.p_table_label === undefined ? 'T12' : args.p_table_label,
    p_items: args.p_items ?? [{ menu_item_id: CHAI.id, quantity: 1 }],
  })
  return { ...res, token }
}

export async function setSettings(values: Record<string, unknown>) {
  const { error } = await admin.from('cafe_settings').update(values).eq('id', true)
  if (error) throw error
}
