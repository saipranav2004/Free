// Renders video overlays (backgrounds, device frames, captions, title cards) as PNGs
// with the app's own font, so the walkthrough matches the site.
//   node scripts/video/overlays.mjs <videoDir>
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIR = process.argv[2] ?? '/tmp/bitesip-video'
const root = fileURLToPath(new URL('../../', import.meta.url))
// Embedded as data URIs: an inline page may not load file:// resources.
const font = `data:font/woff2;base64,${readFileSync(`${root}node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2`).toString('base64')}`
const logo = `data:image/webp;base64,${readFileSync(`${root}public/brand/logo-splash.webp`).toString('base64')}`
const timeline = JSON.parse(readFileSync(`${DIR}/timeline.json`, 'utf8'))

const css = `
@font-face{font-family:Jakarta;src:url(${font}) format('woff2');font-weight:200 800}
*{box-sizing:border-box;margin:0}
body{font-family:Jakarta,sans-serif;color:#fff;background:transparent}
.y{color:#FCC014}`

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
async function render(name, html, transparent = true) {
  await page.setContent(`<style>${css}</style>${html}`)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: `${DIR}/${name}.png`, omitBackground: transparent })
}

// Layout constants shared with compose.py
const PHONE = { x: 110, y: 96, w: 432, h: 934 } // 780x1688 scaled
const KITCHEN = { x: 640, y: 168, w: 1200, h: 750 } // 1920x1200 scaled

await render(
  'bg-a',
  `<div style="position:fixed;inset:0;background:#0a0a0a">
    <div style="position:absolute;left:${KITCHEN.x}px;top:${KITCHEN.y - 300}px;width:1200px;height:900px;background:radial-gradient(closest-side,rgba(252,192,20,.10),transparent)"></div>
    <div style="position:absolute;left:${PHONE.x}px;top:${PHONE.y - 52}px;font-size:22px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.7)">Student <span class="y">·</span> phone</div>
    <div style="position:absolute;left:${KITCHEN.x}px;top:${KITCHEN.y - 52}px;font-size:22px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.7)">Kitchen <span class="y">·</span> counter screen</div>
    <div style="position:absolute;right:80px;top:40px;display:flex;align-items:center;gap:14px">
      <span style="font-size:15px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.55)">Live demo · real backend</span>
      <img src="${logo}" style="width:64px;height:64px;border-radius:50%">
    </div>
  </div>`,
  false,
)

// Device frames: transparent screen hole, rounded corners filled with the background.
const frame = (b, radius, border) => `
  <svg width="1920" height="1080" style="position:fixed;inset:0">
    <defs><mask id="m"><rect width="1920" height="1080" fill="white"/>
      <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${radius}" fill="black"/></mask></defs>
    <rect x="${b.x - 2}" y="${b.y - 2}" width="${b.w + 4}" height="${b.h + 4}" fill="#0a0a0a" mask="url(#m)"/>
    <rect x="${b.x - border / 2}" y="${b.y - border / 2}" width="${b.w + border}" height="${b.h + border}" rx="${radius + border / 2}" fill="none" stroke="#2a2a2a" stroke-width="${border}"/>
  </svg>`
await render('frame-phone', frame(PHONE, 44, 14))
await render('frame-kitchen', frame(KITCHEN, 14, 10))

// Captions
const pill = (text, cx, y) => `
  <div style="position:fixed;left:${cx}px;top:${y}px;transform:translateX(-50%);max-width:1150px;padding:16px 30px;border-radius:999px;
    background:rgba(17,17,17,.92);border:2px solid #FCC014;font-size:30px;font-weight:700;white-space:nowrap;box-shadow:0 18px 40px -12px rgba(0,0,0,.6)">
    <span class="y">●</span>&nbsp; ${text}</div>`
for (const [i, c] of timeline.captions.entries()) {
  const html = c.segment === 'A' ? pill(c.text, KITCHEN.x + KITCHEN.w / 2, 962) : pill(c.text, 960, 978)
  await render(`cap-${i}`, html)
}

// Title / chapter / end cards
const card = (eyebrow, title, sub) => `
  <div style="position:fixed;inset:0;background:#050505;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
    <div style="position:absolute;width:900px;height:900px;border-radius:50%;background:radial-gradient(closest-side,rgba(252,192,20,.16),transparent)"></div>
    <img src="${logo}" style="position:relative;width:300px;height:300px;border-radius:50%;-webkit-mask-image:radial-gradient(circle,#000 66%,transparent 71%)">
    <div style="position:relative;margin-top:34px;font-size:22px;font-weight:700;letter-spacing:.3em;text-transform:uppercase" class="y">${eyebrow}</div>
    <div style="position:relative;margin-top:14px;font-size:64px;font-weight:800;letter-spacing:-.02em">${title}</div>
    <div style="position:relative;margin-top:14px;font-size:26px;color:rgba(255,255,255,.7)">${sub}</div>
  </div>`
await render('card-title', card('Walkthrough', 'Bite <span class="y">&amp;</span> Sip ordering', 'Scan · order · pay · track · collect, with the kitchen and owner views'), false)
await render('card-owner', card('Part 2', 'Owner tools', 'Menu, café settings, table QR codes and reports'), false)
await render('card-end', card('Bite &amp; Sip · College Café', 'Order from your seat.', 'React + Supabase · live updates · recorded on a real backend'), false)

await browser.close()
console.log('overlays rendered')
