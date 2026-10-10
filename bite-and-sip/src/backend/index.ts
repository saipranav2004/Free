import { createDemoBackend } from './demo'
import { createSupabaseBackend } from './supabase'
import type { Backend } from './types'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined
const forceDemo = import.meta.env.VITE_DEMO_MODE === 'true'

/**
 * Supabase when configured; otherwise the in-browser demo backend, which the
 * UI labels clearly ("Demo mode") so it is never mistaken for a live café.
 */
export const backend: Backend = !forceDemo && url && key ? createSupabaseBackend(url, key) : createDemoBackend()
export const isDemo = backend.mode === 'demo'
export type { Backend } from './types'
