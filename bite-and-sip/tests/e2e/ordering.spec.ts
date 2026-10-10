import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { expectNoHorizontalOverflow, KITCHEN, OWNER, showStage, signIn, staffPage, uniquePhone } from './helpers'

test('student orders with UPI, kitchen verifies and hands over, student sees each step live', async ({ page, browser }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/t/T12')
  await expect(page.getByText('Table T12 · Pickup at the counter')).toBeVisible()
  await page.getByRole('button', { name: /College Special Maggi, ₹40/ }).click()
  await page.getByLabel('Extra Cheese').check()
  await page.getByRole('button', { name: /Add to cart · ₹55/ }).click()
  await page.getByRole('button', { name: 'Add Masala Chai' }).click()
  await page.getByRole('button', { name: /View cart/ }).click()

  await page.getByLabel('Name').fill('E2E Student')
  await page.getByLabel('Mobile number').fill(uniquePhone())
  await page.getByText('UPI', { exact: true }).click()
  await page.getByRole('button', { name: /Place order · ₹70/ }).click()

  await expect(page.getByText('Order received')).toBeVisible()
  const code = (await page.getByText(/^BS-\d+$/).first().textContent())!.trim()
  await expect(page.getByRole('img', { name: /UPI QR code to pay ₹70/ })).toBeVisible()
  await page.getByRole('button', { name: 'I’ve paid' }).click()
  await expect(page.getByText(/Waiting for the café to confirm your payment/)).toBeVisible()
  await expect(page.getByText('UPI · check payment')).toBeVisible()

  const staff = await staffPage(browser, page)
  await signIn(staff, KITCHEN)
  const card = staff.getByRole('article', { name: new RegExp(`${code} for E2E Student`) })
  await expect(card).toBeVisible()
  await expect(card.getByText('Note:')).toHaveCount(0)
  await card.getByRole('button', { name: 'Start preparing' }).click()
  await expect(page.getByRole('heading', { name: 'Being prepared' })).toBeVisible({ timeout: 15_000 })

  await showStage(staff, 'Preparing')
  await card.getByRole('button', { name: 'Mark ready' }).click()
  await showStage(staff, 'Ready')
  await expect(card.getByRole('button', { name: 'Hand over' })).toHaveCount(0) // unpaid UPI can't be handed over
  await card.getByRole('button', { name: 'Check UPI payment' }).click()
  await staff.getByLabel(/UPI reference/).fill('UTR 4321')
  await staff.getByRole('button', { name: /Received ₹70/ }).click()
  await expect(page.getByRole('heading', { name: 'Ready for pickup' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/confirmed by the café/)).toBeVisible({ timeout: 15_000 })

  await card.getByRole('button', { name: 'Hand over' }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Collected' })).toBeVisible({ timeout: 15_000 })
  expect(errors).toEqual([])
})

test('cash order: student cancels before preparation; second order is collected with cash at handover', async ({ page, browser }) => {
  const phone = uniquePhone()
  for (const keep of [false, true]) {
    await page.goto('/')
    await page.getByRole('button', { name: 'Add Crispy Samosa' }).click()
    await page.getByRole('button', { name: /View cart/ }).click()
    await page.getByLabel('Name').fill(keep ? 'Cash Keeper' : 'Cash Canceller')
    await page.getByLabel('Mobile number').fill(phone)
    await page.getByLabel(/Cash at the counter/).check()
    await page.getByRole('button', { name: /Place order · ₹15/ }).click()
    await expect(page.getByText('Order received')).toBeVisible()
    if (!keep) {
      await page.getByRole('button', { name: 'Cancel this order' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click()
      await expect(page.getByRole('heading', { name: 'Order cancelled' })).toBeVisible()
    }
  }
  const code = (await page.getByText(/^BS-\d+$/).first().textContent())!.trim()
  const staff = await staffPage(browser, page)
  await signIn(staff, KITCHEN)
  const card = staff.getByRole('article', { name: new RegExp(`${code} for Cash Keeper`) })
  await card.getByRole('button', { name: 'Start preparing' }).click()
  await showStage(staff, 'Preparing')
  await card.getByRole('button', { name: 'Mark ready' }).click()
  await showStage(staff, 'Ready')
  await card.getByRole('button', { name: /Collect ₹15 & hand over/ }).click()
  await staff.getByRole('dialog').getByRole('button', { name: /Collected ₹15/ }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Collected' })).toBeVisible({ timeout: 15_000 })

  await page.goto('/orders')
  await expect(page.getByText('Cancelled').first()).toBeVisible()
  await expect(page.getByText('Collected').first()).toBeVisible()
})

test('owner closes the café, students cannot order, owner reopens', async ({ page, browser }) => {
  const owner = await staffPage(browser, page)
  await signIn(owner, OWNER)
  await owner.goto('/staff/settings')
  const sw = owner.getByRole('switch', { name: 'Taking orders' })
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await sw.click()
  await expect(owner.getByText('Closed — orders paused')).toBeVisible()
  try {
    await page.goto('/')
    await expect(page.getByText('We’re closed right now')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Masala Chai' })).toBeDisabled()
  } finally {
    await sw.click()
    await expect(owner.getByText('Open — taking orders')).toBeVisible()
  }
})

test('owner edits the menu: new item appears for students; kitchen marks it sold out', async ({ page, browser }) => {
  const name = `Test Lassi ${Date.now() % 100000}`
  const owner = await staffPage(browser, page)
  await signIn(owner, OWNER)
  await owner.goto('/staff/menu')
  await owner.getByRole('button', { name: 'Add item' }).click()
  const dlg = owner.getByRole('dialog')
  await dlg.getByLabel('Name', { exact: true }).fill(name)
  await dlg.getByLabel('Category').selectOption({ label: 'Beverages' })
  await dlg.getByLabel('Price (₹)').fill('35')
  await dlg.getByRole('button', { name: 'Add-on' }).click()
  await dlg.getByLabel('Add-on 1 name').fill('Extra Sweet')
  await dlg.getByLabel('Add-on 1 price').fill('5')
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(owner.getByText(`${name} added to the menu`)).toBeVisible()

  await page.goto('/')
  await page.getByRole('button', { name: new RegExp(`${name}, ₹35`) }).click()
  await page.getByLabel(/Extra Sweet/).check()
  await expect(page.getByRole('button', { name: /Add to cart · ₹40/ })).toBeVisible()

  await signIn(owner, KITCHEN)
  await owner.goto('/staff/menu')
  await expect(owner.getByRole('button', { name: 'Add item' })).toHaveCount(0)
  await owner.getByRole('switch', { name: `${name} available` }).click()
  await expect(owner.getByText(`${name} marked sold out`)).toBeVisible()

  await signIn(owner, OWNER)
  await owner.goto('/staff/menu')
  await owner.getByRole('button', { name: `Edit ${name}` }).click()
  await owner.getByRole('button', { name: 'Delete' }).click()
  await owner.getByRole('button', { name: 'Yes, delete' }).click()
  await expect(owner.getByText(`${name} deleted`)).toBeVisible()
})

test('reports reconcile and QR codes generate', async ({ page }) => {
  await signIn(page, OWNER)
  await page.goto('/staff/reports')
  await page.getByRole('button', { name: 'Last 7 days' }).click()
  const money = page.getByRole('region', { name: 'Where the money is' }).or(page.locator('section', { has: page.getByRole('heading', { name: 'Where the money is' }) }))
  const text = await money.first().innerText()
  const values = [...text.matchAll(/₹([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, '')))
  // cash + upi + outstanding cash + outstanding upi = sales
  expect(values[0] + values[1] + values[2] + values[3]).toBe(values[4])

  await page.goto('/staff/print-qr')
  await expect(page.getByRole('img', { name: /QR code for Table T1$/ })).toBeVisible()
  await expect(page.getByRole('img', { name: 'QR code for Order here' })).toBeVisible()
})

test('pages fit the screen and pass automated accessibility checks', async ({ page }) => {
  for (const path of ['/', '/cart', '/orders', '/staff/login']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    await expectNoHorizontalOverflow(page)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(results.violations.map((v) => `${path}: ${v.id} (${v.nodes.length})`)).toEqual([])
  }
  await signIn(page, OWNER)
  for (const path of ['/staff', '/staff/menu', '/staff/reports', '/staff/settings']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    await expectNoHorizontalOverflow(page)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(results.violations.map((v) => `${path}: ${v.id} (${v.nodes.length})`)).toEqual([])
  }
})

test('unknown routes and foreign orders are handled', async ({ page }) => {
  await page.goto('/nope')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await page.goto('/order/00000000-0000-4000-8000-000000000000')
  await expect(page.getByRole('heading', { name: /isn’t on this phone/ })).toBeVisible()
  await page.goto('/staff/settings')
  await expect(page.getByRole('heading', { name: 'Staff sign in' })).toBeVisible()
})
