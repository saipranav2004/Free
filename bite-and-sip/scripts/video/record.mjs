// Records the walkthrough against a running build (real Supabase backend).
// Captures crisp frames with the Chrome DevTools screencast, plus a caption log.
//   node scripts/video/record.mjs <baseUrl> <outDir>
import { chromium } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://localhost:4175'
const OUT = process.argv[3] ?? '/tmp/bitesip-video'
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_PATH
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const captions = []
const caption = (text, segment) => {
  captions.push({ t: Date.now() / 1000, text, segment })
  console.log(`[${segment}] ${text}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Visible cursor + tap ripple, so viewers can follow what is being clicked.
const INDICATOR = `
(() => {
  const install = () => {
    if (document.getElementById('__cursor')) return
    const st = document.createElement('style')
    st.textContent = \`
      #__cursor{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
        background:rgba(252,192,20,.35);border:2px solid #111;pointer-events:none;transition:transform .15s;left:-40px;top:-40px}
      .__tap{position:fixed;z-index:2147483646;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;
        border:3px solid #FCC014;pointer-events:none;animation:__tap .55s ease-out forwards}
      @keyframes __tap{from{transform:scale(.6);opacity:1}to{transform:scale(3.4);opacity:0}}\`
    document.documentElement.appendChild(st)
    const c = document.createElement('div'); c.id='__cursor'; document.documentElement.appendChild(c)
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
    addEventListener('mousedown', e => {
      c.style.transform = 'scale(.7)'; setTimeout(() => (c.style.transform = ''), 160)
      const r = document.createElement('div'); r.className='__tap'; r.style.left=e.clientX+'px'; r.style.top=e.clientY+'px'
      document.documentElement.appendChild(r); setTimeout(() => r.remove(), 600)
    }, true)
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install); else install()
})()`

async function startRecorder(page, name, maxWidth, maxHeight) {
  const dir = `${OUT}/${name}`
  mkdirSync(dir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  const frames = []
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = `${dir}/${String(frames.length).padStart(6, '0')}.jpg`
    writeFileSync(file, Buffer.from(data, 'base64'))
    frames.push({ file, t: metadata.timestamp })
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1, maxWidth, maxHeight })
  return {
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {})
      writeFileSync(`${dir}/frames.json`, JSON.stringify(frames))
      return frames
    },
  }
}

/** Moves the visible cursor smoothly to an element, then clicks it. */
async function click(page, locator, pause = 350) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 })
  await wait(pause)
  await locator.click()
}
async function type(page, locator, text) {
  await click(page, locator, 200)
  await locator.pressSequentially(text, { delay: 70 })
}
async function smoothScroll(page, dy, steps = 18) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy / steps)
    await wait(28)
  }
}

// Headless screencasts ignore deviceScaleFactor unless the scale is forced on the browser.
const browser = await chromium.launch({ executablePath: CHROME, args: ['--force-color-profile=srgb', '--force-device-scale-factor=2'] })

// ---------------------------------------------------------------- Segment A
const studentCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: false })
const kitchenCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
await studentCtx.addInitScript(INDICATOR)
await kitchenCtx.addInitScript(INDICATOR)
const student = await studentCtx.newPage()
const kitchen = await kitchenCtx.newPage()
const errors = []
for (const [n, p] of [['student', student], ['kitchen', kitchen]]) {
  p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`))
  p.on('console', (m) => m.type() === 'error' && errors.push(`${n} console: ${m.text()}`))
}
await student.goto('about:blank')
await kitchen.goto('about:blank')
const recS = await startRecorder(student, 'student', 780, 1688)
const recK = await startRecorder(kitchen, 'kitchen', 1920, 1200)
const segA = Date.now() / 1000

caption('A student scans the QR code on table T12', 'A')
await Promise.all([student.goto(`${BASE}/t/T12`), kitchen.goto(`${BASE}/staff/login`)])
await type(kitchen, kitchen.getByLabel('Email'), 'kitchen@bitesip.test')
await type(kitchen, kitchen.getByLabel('Password'), 'kitchen-pass-123')
await click(kitchen, kitchen.getByRole('button', { name: 'Sign in' }))
await student.getByTestId('intro').waitFor({ state: 'detached', timeout: 10000 })
caption('The menu opens with the table already filled in', 'A')
await wait(1200)
await smoothScroll(student, 650)
await wait(900)
await smoothScroll(student, -650)
await wait(500)

caption('Search, then customise an item with add-ons', 'A')
await type(student, student.getByRole('searchbox', { name: 'Search the menu' }), 'maggi')
await wait(700)
await click(student, student.getByRole('button', { name: /College Special Maggi, ₹40/ }))
await wait(900)
await click(student, student.getByLabel(/Extra Cheese/))
await wait(400)
await click(student, student.getByRole('button', { name: 'Increase College Special Maggi' }))
await wait(600)
await click(student, student.getByRole('button', { name: /Add to cart · ₹110/ }))
await wait(1200)
await click(student, student.getByRole('button', { name: 'Clear search' }))
await wait(600)
await click(student, student.getByRole('button', { name: 'Add Masala Chai' }))
await wait(1400)

caption('Checkout needs only a name and phone number. No sign-up', 'A')
await click(student, student.getByRole('button', { name: /View cart/ }))
await wait(900)
await type(student, student.getByLabel('Name'), 'Nikitha')
await type(student, student.getByLabel('Mobile number'), '98765 43210')
await click(student, student.getByText('UPI', { exact: true }))
await wait(500)
await click(student, student.getByRole('button', { name: /Place order · ₹125/ }))
await student.getByText('Order number').waitFor()
const code = (await student.getByText(/^BS-\d+$/).first().textContent()).trim()
const card = kitchen.getByRole('article', { name: new RegExp(`${code} for Nikitha`) })
caption('Order placed. It appears on the kitchen board instantly', 'A')
await card.waitFor({ timeout: 20000 })
await wait(3000)

caption('Pay by UPI: scan the QR or tap to open a UPI app', 'A')
await student.getByRole('heading', { name: 'Payment' }).scrollIntoViewIfNeeded()
await smoothScroll(student, 380)
await wait(1800)
await click(student, student.getByRole('button', { name: 'I’ve paid' }))
await wait(1600)
caption('The kitchen starts preparing. The student’s screen updates live', 'A')
await smoothScroll(student, -900)
await click(kitchen, card.getByRole('button', { name: 'Start preparing' }))
await student.getByRole('heading', { name: 'Being prepared' }).waitFor()
await wait(2200)
await click(kitchen, card.getByRole('button', { name: 'Mark ready' }))
await wait(1200)

caption('Staff confirm the UPI payment in the café’s own account', 'A')
await click(kitchen, card.getByRole('button', { name: 'Check UPI payment' }))
await wait(1400)
await type(kitchen, kitchen.getByLabel(/UPI reference/), '4821')
await click(kitchen, kitchen.getByRole('button', { name: /Received ₹125/ }))
caption('Ready! The student collects the order at the counter', 'A')
await student.getByText(/confirmed by the café/).waitFor()
await wait(3400)
await click(kitchen, card.getByRole('button', { name: 'Hand over' }))
await student.getByRole('heading', { name: 'Collected' }).waitFor()
await wait(2000)
caption('“My orders” keeps this phone’s order history', 'A')
await click(student, student.getByRole('link', { name: 'My orders' }))
await wait(2600)
const segAEnd = Date.now() / 1000
await recS.stop()
await recK.stop()
await studentCtx.close()
await kitchenCtx.close()
await browser.close()
const browserB = await chromium.launch({ executablePath: CHROME, args: ['--force-color-profile=srgb', '--force-device-scale-factor=1.2'] })

// ---------------------------------------------------------------- Segment B
const ownerCtx = await browserB.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 })
await ownerCtx.addInitScript(INDICATOR)
const owner = await ownerCtx.newPage()
owner.on('pageerror', (e) => errors.push(`owner: ${e.message}`))
await owner.goto('about:blank')
const recO = await startRecorder(owner, 'owner', 1920, 1080)
const segB = Date.now() / 1000
caption('The owner signs in to the same app', 'B')
await owner.goto(`${BASE}/staff/login`)
await type(owner, owner.getByLabel('Email'), 'owner@bitesip.test')
await type(owner, owner.getByLabel('Password'), 'owner-pass-123')
await click(owner, owner.getByRole('button', { name: 'Sign in' }))
await wait(1500)

caption('Menu: mark items in stock or sold out, edit prices, photos and add-ons', 'B')
await click(owner, owner.getByRole('link', { name: 'Menu' }))
await wait(1200)
await click(owner, owner.getByRole('switch', { name: 'Paneer Wrap available' }))
await wait(1500)
await click(owner, owner.getByRole('button', { name: 'Edit Filter Coffee' }))
await wait(1000)
const dlg = owner.getByRole('dialog')
await click(owner, dlg.getByRole('button', { name: 'Add-on' }))
await type(owner, dlg.getByLabel('Add-on 1 name'), 'Extra strong')
await dlg.getByLabel('Add-on 1 price').fill('')
await type(owner, dlg.getByLabel('Add-on 1 price'), '5')
await click(owner, dlg.getByRole('button', { name: 'Save' }))
await wait(1800)

caption('Settings: open or close the café, set the UPI ID, print table QR codes', 'B')
await click(owner, owner.getByRole('link', { name: 'Settings' }))
await wait(1200)
await click(owner, owner.getByRole('switch', { name: 'Taking orders' }))
await wait(1500)
await click(owner, owner.getByRole('switch', { name: 'Taking orders' }))
await wait(1200)
await click(owner, owner.getByRole('button', { name: /Test with ₹1/ }))
await wait(2200)
await owner.keyboard.press('Escape')
await wait(500)
await smoothScroll(owner, 520)
await wait(800)
await click(owner, owner.getByRole('link', { name: /Print table QR codes/ }))
await wait(2200)
await smoothScroll(owner, 600)
await wait(900)

caption('Reports: sales reconcile with cash, confirmed UPI and unpaid amounts', 'B')
await owner.goto(`${BASE}/staff/reports`)
await wait(1600)
await click(owner, owner.getByRole('button', { name: 'Last 7 days' }))
await wait(1400)
const bars = owner.locator('figure button')
const n = await bars.count()
for (let i = 0; i < n; i += 2) {
  const b = await bars.nth(i).boundingBox()
  if (b) await owner.mouse.move(b.x + b.width / 2, b.y + b.height - 10, { steps: 6 })
  await wait(160)
}
await wait(600)
await smoothScroll(owner, 700)
await wait(1500)
const segBEnd = Date.now() / 1000
await recO.stop()
await browserB.close()

writeFileSync(`${OUT}/timeline.json`, JSON.stringify({ captions, segA, segAEnd, segB, segBEnd, errors }, null, 1))
console.log('errors:', errors)
