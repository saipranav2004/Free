import { expect, type Browser, type Page } from '@playwright/test'

export const BACKEND = process.env.E2E_BACKEND ?? 'demo'
export const OWNER = {
  email: process.env.E2E_OWNER_EMAIL ?? 'owner@demo.bitesip',
  password: process.env.E2E_OWNER_PASSWORD ?? 'demo-owner',
}
export const KITCHEN = {
  email: process.env.E2E_KITCHEN_EMAIL ?? 'kitchen@demo.bitesip',
  password: process.env.E2E_KITCHEN_PASSWORD ?? 'demo-kitchen',
}

export async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/staff/login')
  const signOut = page.getByRole('button', { name: 'Sign out' })
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click()
    await page.goto('/staff/login')
  }
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible()
}

/** The demo backend shares state between tabs of one browser context; Supabase works across contexts. */
export async function staffPage(browser: Browser, studentPage: Page) {
  if (BACKEND === 'demo') return studentPage.context().newPage()
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } })
  return ctx.newPage()
}

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page should not scroll sideways').toBeLessThanOrEqual(0)
}

export function uniquePhone() {
  return `9${String(Date.now()).slice(-9)}`
}

/** On phones the board shows one stage at a time; switch to it if the tabs are visible. */
export async function showStage(page: Page, stage: 'New' | 'Preparing' | 'Ready') {
  const tab = page.getByRole('tab', { name: new RegExp(`^${stage}`) })
  if (await tab.isVisible().catch(() => false)) await tab.click()
}
