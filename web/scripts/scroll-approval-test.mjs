import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8799'
const OWNER = process.env.OWNER_KEY ?? 'owner-e2e-key-0123456789'
const JOB = 'job_demo_northwind'

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
const page = await context.newPage()
await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
const pause = (ms) => page.waitForTimeout(ms)

await page.goto(`${BASE}/app/unlock`)
await page.getByLabel('API key').fill(OWNER)
await page.getByRole('button', { name: 'Unlock console' }).click()
await page.getByRole('heading', { name: /Waiting for you/ }).waitFor()
await pause(800)

await page.getByRole('link', { name: 'Request form' }).first().click()
await page.getByRole('heading', { name: /Ask to move money/ }).waitFor()
await pause(500)
await page.getByText('Money in').click()
await page.getByLabel('Amount').fill('150')
await page.getByLabel('What it is for').fill('Northwind logo milestone 1 invoice')
await page.getByLabel('Link to the work').fill('https://www.figma.com/file/northwind-logo')
await page.getByLabel('Job').fill(JOB)
await page.getByLabel('How it was asked, in words').fill('Bill Northwind $150 for logo milestone 1')
await page.getByRole('button', { name: 'Ask the rules' }).click()
await page.locator('.answer').getByText(/needs you/i).first().waitFor()
await pause(800)

await page.getByRole('link', { name: 'Today' }).first().click()
await page.getByRole('heading', { name: /Waiting for you/ }).waitFor()
await pause(1000)
const card = page.locator('.approval').filter({ hasText: 'Bill Northwind' }).filter({ hasText: JOB })
await card.waitFor()
await pause(500)

const snap = async (label) => {
  const s = await page.evaluate(() => ({ y: window.scrollY, max: document.scrollingElement.scrollHeight - innerHeight }))
  const b = await card.boundingBox()
  console.log(label, JSON.stringify({ y: s.y, max: s.max, top: b && Math.round(b.y), h: b && Math.round(b.height) }))
}
await snap('before')

// Method A: custom rAF on window.scrollTo with scroll-behavior forced to auto.
await card.evaluate(
  (el, args) =>
    new Promise((resolve) => {
      const r = el.getBoundingClientRect()
      const target = Math.max(0, r.top + window.scrollY - args.margin)
      const start = window.scrollY
      const root = document.documentElement
      const prev = root.style.scrollBehavior
      root.style.scrollBehavior = 'auto'
      const t0 = performance.now()
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
      const step = (now) => {
        const p = Math.min(1, (now - t0) / args.ms)
        window.scrollTo(0, start + (target - start) * ease(p))
        if (p < 1) requestAnimationFrame(step)
        else {
          root.style.scrollBehavior = prev
          resolve()
        }
      }
      requestAnimationFrame(step)
    }),
  { ms: 1250, margin: 110 },
)
await pause(200)
await snap('after-custom-0.2s')
for (let i = 0; i < 6; i += 1) {
  await pause(500)
  await snap(`after-custom-${(i + 1) * 0.5}s`)
}

// Method B: native smooth scrollIntoView, centered.
await page.evaluate(() => window.scrollTo(0, 0))
await pause(500)
await snap('reset')
await card.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }))
for (let i = 0; i < 4; i += 1) {
  await pause(500)
  await snap(`after-native-${(i + 1) * 0.5}s`)
}

await browser.close()
