import { defineConfig, devices } from '@playwright/test'

// E2E_BACKEND=demo (default) runs against the in-browser demo backend.
// E2E_BACKEND=supabase runs against a local Supabase stack (`npx supabase start`)
// with staff accounts from E2E_OWNER_EMAIL / E2E_KITCHEN_EMAIL (+ _PASSWORD).
const backend = process.env.E2E_BACKEND ?? 'demo'
const port = backend === 'demo' ? 4173 : 4174

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 860 } } },
  ],
  webServer: {
    command:
      backend === 'demo'
        ? `npx vite build --mode e2e-demo --outDir dist-e2e-demo && npx vite preview --outDir dist-e2e-demo --port ${port} --strictPort`
        : `npx vite build --mode e2e-supabase --outDir dist-e2e-supabase && npx vite preview --outDir dist-e2e-supabase --port ${port} --strictPort`,
    port,
    reuseExistingServer: false,
    timeout: 120_000,
    env: backend === 'demo' ? { VITE_DEMO_MODE: 'true' } : { VITE_DEMO_MODE: 'false' },
  },
})
