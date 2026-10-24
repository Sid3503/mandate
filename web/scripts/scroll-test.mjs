import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8799'
const OWNER = process.env.OWNER_KEY ?? 'owner-e2e-key-0123456789'
const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
const page = await context.newPage()
await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
await page.goto(`${BASE}/app/unlock`)
await page.getByLabel('API key').fill(OWNER)
await page.getByRole('button', { name: 'Unlock console' }).click()
await page.getByRole('heading', { name: /Waiting for you/ }).waitFor()
await page.waitForTimeout(800)

const info = await page.evaluate(() => {
  const els = [
    document.scrollingElement,
    document.documentElement,
    document.body,
    document.querySelector('#root'),
    document.querySelector('.shell'),
    document.querySelector('.main-col'),
    document.querySelector('.main'),
  ]
  return els.map((el, i) => ({
    i,
    tag: el?.tagName,
    cls: el?.className ?? '',
    overflowY: el ? getComputedStyle(el).overflowY : null,
    height: el ? getComputedStyle(el).height : null,
    scrollHeight: el?.scrollHeight,
    clientHeight: el?.clientHeight,
  }))
})
console.log(JSON.stringify(info, null, 2))

for (let i = 0; i < info.length; i += 1) {
  const res = await page.evaluate((index) => {
    const els = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      document.querySelector('#root'),
      document.querySelector('.shell'),
      document.querySelector('.main-col'),
      document.querySelector('.main'),
    ]
    document.documentElement.style.scrollBehavior = 'auto'
    for (const el of els) if (el) el.scrollTop = 0
    const el = els[index]
    if (!el) return null
    el.scrollTop = 600
    return { scrollTop: el.scrollTop, winY: window.scrollY }
  }, i)
  console.log(i, info[i].tag, info[i].cls, JSON.stringify(res))
}

await browser.close()
