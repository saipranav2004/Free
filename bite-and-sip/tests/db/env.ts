import { execSync } from 'node:child_process'

export interface LocalEnv {
  url: string
  publishableKey: string
  secretKey: string
}

/** Reads local Supabase credentials from env vars or `supabase status`. */
export function localEnv(): LocalEnv {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_SECRET_KEY) {
    return {
      url: process.env.SUPABASE_URL,
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
      secretKey: process.env.SUPABASE_SECRET_KEY,
    }
  }
  const raw = execSync('npx supabase status -o json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const status = JSON.parse(raw.slice(raw.indexOf('{')))
  return { url: status.API_URL, publishableKey: status.PUBLISHABLE_KEY, secretKey: status.SECRET_KEY }
}
