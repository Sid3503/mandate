import { chromium } from 'playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:8799'
const OWNER = 'owner-e2e-key-0123456789'
const JOB = 'job_demo_northwind'
const OUT = 'pitch/video/card-cursor-test'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
})
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 })
const page = await context.newPage()
await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
await page.addInitScript(() => {
  const boot = () => {
    if (document.getElementById('demo-cursor')) return
    const style = document.createElement('style')
    style.textContent = `
      #demo-cursor{position:fixed;left:960px;top:540px;width:22px;height:22px;margin-left:-11px;margin-top:-11px;border:3px solid #b6ff3b;border-radius:999px;background:rgba(182,255,59,.28);pointer-events:none;z-index:2147483647;box-shadow:0 0 14px rgba(0,0,0,.4)}
    `
    document.head.appendChild(style)
    const c = document.createElement('div')
    c.id = 'demo-cursor'
    c.dataset.x = '960'
    c.dataset.y = '540'
    document.body.appendChild(c)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})

await page.goto(`${BASE}/app/unlock`)
await page.getByText('Ledger ready').waitFor()
await page.getByLabel('API key').fill(OWNER)
await page.getByRole('button', { name: 'Unlock console' }).click()
await page.getByRole('heading', { name: /Waiting for you/ }).waitFor()
await page.waitForTimeout(1200)

const charge = page.locator('.approval').filter({ hasText: 'Bill Northwind' }).filter({ hasText: JOB })
await charge.waitFor()
const card = await charge.boundingBox()
console.log('card', card)

// scroll to the card the same way the take does
await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, card.y + (await page.evaluate(() => window.scrollY)) - 110))
await page.waitForTimeout(1200)

const client = await context.newCDPSession(page)
let frames = []
client.on('Page.screencastFrame', (f) => {
  const i = frames.length + 1
  frames.push(f.metadata.timestamp)
  client.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  writeFileSync(`${OUT}/f${String(i).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64'))
})

const setCursor = async (x, y) => {
  await page.evaluate(
    ({ x, y }) => {
      const c = document.getElementById('demo-cursor')
      c.style.left = `${x}px`
      c.style.top = `${y}px`
      c.dataset.x = String(x)
      c.dataset.y = String(y)
    },
    { x, y },
  )
}

const move = (x, y, ms, mode) =>
  page.evaluate(
    ({ x, y, ms, mode }) =>
      new Promise((resolve) => {
        const c = document.getElementById('demo-cursor')
        const sx = Number(c.dataset.x)
        const sy = Number(c.dataset.y)
        const t0 = performance.now()
        const base = window.scrollY
        const root = document.documentElement
        const prev = root.style.scrollBehavior
        root.style.scrollBehavior = 'auto'
        const card = document.querySelector('.approval')
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ms)
          const e = ease(p)
          const nx = sx + (x - sx) * e
          const ny = sy + (y - sy) * e
          c.style.left = `${nx}px`
          c.style.top = `${ny}px`
          c.dataset.x = String(nx)
          c.dataset.y = String(ny)
          if (mode === 'scroll') {
            window.scrollTo(0, base + (Math.floor((now - t0) / 16) % 2 ? 1 : 0))
          } else if (mode === 'shadow' && card) {
            card.style.boxShadow = Math.floor((now - t0) / 16) % 2 ? '4px 4.02px 0 #111' : '4px 4px 0 #111'
          }
          if (p < 1) requestAnimationFrame(step)
          else {
            window.scrollTo(0, base)
            root.style.scrollBehavior = prev
            if (card) card.style.boxShadow = ''
            resolve()
          }
        }
        requestAnimationFrame(step)
      }),
    { x, y, ms, mode },
  )

async function run(label, mode) {
  // reset cursor to the sidebar Today link
  const today = await page.getByRole('link', { name: 'Today' }).first().boundingBox()
  await setCursor(today.x + today.width / 2, today.y + today.height / 2)
  frames = []
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
  await page.waitForTimeout(600)
  await page.waitForTimeout(1100)
  const btn = await charge.getByRole('button', { name: /Approve/ }).boundingBox()
  const t0 = Date.now()
  await move(btn.x + btn.width / 2, btn.y + btn.height / 2, 620, mode === 'click' ? 'none' : mode)
  const moved = Date.now() - t0
  if (mode === 'click') {
    await charge.getByRole('button', { name: /Approve/ }).click()
    await page.waitForTimeout(1800)
  }
  await page.waitForTimeout(700)
  await client.send('Page.stopScreencast')
  const t = frames.map((x) => +((x - frames[0]) * 1000).toFixed(0))
  const gaps = []
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > 33) gaps.push(`${t[i - 1]}->${t[i]} (${t[i] - t[i - 1]}ms)`)
  console.log(label, 'moved', moved, 'frames', frames.length, 'span', t[t.length - 1], 'gaps', gaps.join(', ') || 'none')
  await page.waitForTimeout(400)
}

await run('plain', 'none')
await run('scroll', 'scroll')
await run('shadow', 'shadow')
await run('click', 'click')

await browser.close()
