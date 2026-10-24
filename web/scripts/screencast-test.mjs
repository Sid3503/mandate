// Measures the real frame rate of Chrome's CDP screencast at 1080p.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8799'
const OWNER = process.env.OWNER_KEY ?? 'owner-e2e-key-0123456789'
const DIR = 'pitch/video/screencast-test'

mkdirSync(DIR, { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--disable-frame-rate-limit', '--disable-gpu-vsync'],
})
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
})
const page = await context.newPage()
await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))

await page.goto(`${BASE}/app/unlock`)
await page.getByLabel('API key').fill(OWNER)
await page.getByRole('button', { name: 'Unlock console' }).click()
await page.getByRole('heading', { name: /Waiting for you/ }).waitFor()
await page.waitForTimeout(800)

const client = await context.newCDPSession(page)
let n = 0
let first = 0
let last = 0
const times = []

client.on('Page.screencastFrame', async (f) => {
  n += 1
  first ||= f.metadata.timestamp
  last = f.metadata.timestamp
  times.push(f.metadata.timestamp)
  writeFileSync(`${DIR}/f${String(n).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64'))
  await client.send('Page.screencastFrameAck', { sessionId: f.sessionId })
})

await client.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 85,
  maxWidth: 1920,
  maxHeight: 1080,
  everyNthFrame: 1,
})

// 3s of continuous motion: a zoom in, hold, zoom out.
await page.evaluate(() => {
  document.body.style.overflow = 'hidden'
  document.body.style.transition = 'transform 700ms cubic-bezier(.22,.61,.36,1)'
  document.body.style.transformOrigin = '60% 38%'
  document.body.style.transform = 'scale(1.7)'
})
await page.waitForTimeout(2200)
await page.evaluate(() => {
  document.body.style.transform = 'scale(1)'
})
await page.waitForTimeout(1600)

writeFileSync(`${DIR}/times.json`, JSON.stringify(times))

await client.send('Page.stopScreencast')
await page.waitForTimeout(300)
await browser.close()

const span = last - first
console.log(JSON.stringify({ frames: n, seconds: Number(span.toFixed(3)), fps: Number((n / span).toFixed(2)) }))
console.log(times.slice(0, 8).map((t) => t.toFixed(3)).join(' '))
