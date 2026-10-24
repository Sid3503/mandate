// Records the real product loop at 60fps through Chrome's CDP screencast.
//   unlock  ->  try to break it (3 refusals)
//   ->  two agents negotiate a deal (offers outside both companies' rules refused, one signed)
//   ->  bill milestone 1, lock it to be paid on our own card page
//   ->  she asks Mandate (⌘K) for the rule change in her own words; the drafter writes it,
//       code checks it, and she reviews and publishes it
//   ->  the card pays milestone 1 here, and that pays Priya's share with no tap
//   ->  connect an agent, and an outside agent on a live model is fooled by its inbox:
//       three refusals, and the breaker suspends its key  ->  verify a receipt.
// Navigation is done by clicking the real sidebar and links, then smooth-scrolling
// to the target, so the video never hard-cuts to a pre-scrolled card.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

const START_WALL = Date.now()

const BASE = process.env.BASE ?? 'http://127.0.0.1:8799'
const OWNER = process.env.OWNER_KEY ?? 'owner-e2e-key-0123456789'
const OUT = process.env.OUT ?? 'pitch/video/take'
// The receipt file the settle step downloads, used later on the public Verify page.
let RECEIPT_JSON = null

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const log = (m) => console.log(`[demo] ${m}`)
const ts = () => ((Date.now() - START_WALL) / 1000).toFixed(2)

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
})
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
})
const page = await context.newPage()
page.on('response', (res) => {
  if (!/approve|stepup/.test(res.url())) return
  console.log(`[net] ${ts()}s ${res.status()} ${res.request().method()} ${res.url().replace(BASE, '')}`)
})
page.on('requestfailed', (req) => {
  if (!/approve|stepup/.test(req.url())) return
  console.log(`[net] ${ts()}s FAILED ${req.url().replace(BASE, '')} ${req.failure()?.errorText}`)
})

await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))

// The card form is our page. PayPal's script is stood in with the same shape the console
// uses, so this fake PayPal server can show the fields and settle the lock without
// sending the buyer to a sandbox link. The server still makes the order and captures it.
// REAL_PAYPAL=1 records against a server on the real PayPal sandbox: PayPal's own script and card fields.
const REAL_PAYPAL = process.env.REAL_PAYPAL === '1'
if (!REAL_PAYPAL) await page.route('**/web-sdk/**', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: `window.paypal = {
  createInstance: async () => ({
    findEligibleMethods: async () => ({ isEligible: () => true }),
    createCardFieldsOneTimePaymentSession: () => ({
      createCardFieldsComponent: (options) => {
        const field = document.createElement('input')
        field.setAttribute('data-paypal-field', options.type)
        field.setAttribute('placeholder', options.placeholder || options.type)
        return field
      },
      submit: async (orderId) => ({ state: 'succeeded', data: { orderId, liabilityShift: 'POSSIBLE' } }),
    }),
  }),
}`,
}))

// A visible cursor + click ripple, moved by requestAnimationFrame at display rate.
await page.addInitScript(() => {
  const boot = () => {
    if (document.getElementById('demo-cursor')) return
    const style = document.createElement('style')
    style.textContent = `
      #demo-cursor{position:fixed;left:960px;top:540px;width:22px;height:22px;margin-left:-11px;margin-top:-11px;border:3px solid #b6ff3b;border-radius:999px;background:rgba(182,255,59,.28);pointer-events:none;z-index:2147483647;transition:width .08s,height .08s,margin .08s;box-shadow:0 0 14px rgba(0,0,0,.4)}
      #demo-cursor.down{width:14px;height:14px;margin-left:-7px;margin-top:-7px}
      .demo-ripple{position:fixed;width:22px;height:22px;border:3px solid #b6ff3b;border-radius:999px;transform:translate(-50%,-50%) scale(1);animation:demo-ripple .55s ease-out forwards;pointer-events:none;z-index:2147483646}
      @keyframes demo-ripple{to{transform:translate(-50%,-50%) scale(3.6);opacity:0}}
      #demo-note{position:fixed;inset:0;pointer-events:none;z-index:2147483645}
      .demo-wire{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
      .demo-wire-path{fill:none;stroke:#1c1914;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round;transition:stroke-dashoffset .4s cubic-bezier(.22,.61,.36,1)}
      .demo-wire-dot{fill:#b6ff3b;stroke:#1c1914;stroke-width:2}
      .demo-frame{position:absolute;border:3px solid #b6ff3b;border-radius:14px;box-shadow:0 0 0 6px rgba(182,255,59,.22);animation:demo-frame .24s ease-out}
      @keyframes demo-frame{from{opacity:0}to{opacity:1}}
      .demo-card{position:absolute;width:280px;background:#1c1914;color:#f6f3ea;border-radius:14px;padding:12px 14px 13px;box-shadow:7px 7px 0 #b6ff3b;animation:demo-card .24s ease-out}
      .demo-card .demo-kicker{display:block;font:700 11px/1.2 ui-monospace,ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:#b6ff3b;margin-bottom:4px}
      .demo-card strong{display:block;font:700 16px/1.25 ui-sans-serif,system-ui,sans-serif}
      .demo-card p{margin:6px 0 0;font:400 13px/1.35 ui-sans-serif,system-ui,sans-serif;color:#e4dece}
      @keyframes demo-card{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
      #demo-chapter{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#1c1914;color:#f6f3ea;border-radius:999px;padding:8px 14px;font:600 14px/1 ui-sans-serif,system-ui,sans-serif;box-shadow:4px 4px 0 #b6ff3b;white-space:nowrap}
      #demo-intro{position:fixed;inset:0;z-index:2147483646;background:#070705;color:#f6f3ea;display:flex;flex-direction:column;justify-content:center;padding:0 148px;font-family:ui-sans-serif,system-ui,sans-serif}
      #demo-intro .mark{font:700 14px/1 ui-monospace,ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;color:#b6ff3b}
      #demo-intro h1{margin:16px 0 0;font:700 96px/0.92 ui-sans-serif,system-ui,sans-serif;letter-spacing:-.035em}
      #demo-intro .line{margin:22px 0 0;font:600 36px/1.25 ui-sans-serif,system-ui,sans-serif;max-width:1080px}
      #demo-intro ul{margin:40px 0 0;padding:0;list-style:none;display:grid;gap:16px;max-width:920px}
      #demo-intro li{font:500 22px/1.35 ui-sans-serif,system-ui,sans-serif;color:#e4dece;padding-left:16px;border-left:3px solid #b6ff3b}
      #demo-intro .who{margin:42px 0 0;display:grid;gap:22px;max-width:1040px}
      #demo-intro .who div{display:grid;grid-template-columns:240px 1fr;gap:22px;align-items:baseline}
      #demo-intro .who strong{font:700 32px/1.1 ui-sans-serif,system-ui,sans-serif}
      #demo-intro .who span{font:500 22px/1.35 ui-sans-serif,system-ui,sans-serif;color:#e4dece}
      .connect-reveal .snippet pre,.connect-sample .snippet pre{filter:blur(8px)}
      #demo-term{position:fixed;right:28px;top:28px;width:660px;z-index:2147483646;pointer-events:none;background:#1c1914;color:#e4dece;border-radius:16px;box-shadow:8px 8px 0 #b6ff3b,0 18px 40px rgba(0,0,0,.35);font:500 15px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;animation:demo-card .24s ease-out}
      #demo-term .head{padding:12px 16px;background:#2a2620;color:#b6ff3b;font:700 13px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.04em;text-transform:uppercase;display:flex;gap:10px;align-items:center}
      #demo-term .head i{width:9px;height:9px;border-radius:9px;background:#ff5d4d;box-shadow:0 0 10px #ff5d4d;animation:demo-blink 1s steps(2) infinite}
      @keyframes demo-blink{50%{opacity:.25}}
      #demo-term .body{padding:12px 16px 14px;display:grid;gap:5px}
      #demo-term .l{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:demo-card .18s ease-out}
      #demo-term .model,#demo-term .tools,#demo-term .answer,#demo-term .done{color:#9d968a}
      #demo-term .inbox{color:#f6f3ea}
      #demo-term .call{color:#b6ff3b}
      #demo-term .refused{color:#ff8a7a}
      #demo-term .suspended{color:#1c1914;background:#ff5d4d;border-radius:6px;padding:2px 8px;font-weight:700}
      #demo-term .thinks{color:#c9c2b4;font-style:italic;white-space:normal}
      #demo-keys{position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;display:flex;gap:12px;animation:demo-keys .22s cubic-bezier(.2,.9,.3,1.3)}
      #demo-keys kbd{min-width:76px;height:76px;padding:0 18px;display:grid;place-items:center;background:#1c1914;color:#f6f3ea;border:3px solid #b6ff3b;border-radius:16px;box-shadow:0 6px 0 #b6ff3b,0 14px 30px rgba(0,0,0,.35);font:700 38px/1 ui-sans-serif,system-ui,sans-serif}
      #demo-keys kbd.down{transform:translateY(5px);box-shadow:0 1px 0 #b6ff3b,0 8px 20px rgba(0,0,0,.35)}
      @keyframes demo-keys{from{opacity:0;transform:translateX(-50%) translateY(14px) scale(.9)}to{opacity:1;transform:translateX(-50%)}}
    `
    document.head.appendChild(style)
    const c = document.createElement('div')
    c.id = 'demo-cursor'
    c.dataset.x = '960'
    c.dataset.y = '540'
    document.body.appendChild(c)
    addEventListener('mousedown', (e) => {
      c.classList.add('down')
      const r = document.createElement('div')
      r.className = 'demo-ripple'
      r.style.left = `${e.clientX}px`
      r.style.top = `${e.clientY}px`
      document.body.appendChild(r)
      setTimeout(() => r.remove(), 600)
    })
    addEventListener('mouseup', () => c.classList.remove('down'))
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})

const pause = (ms) => page.waitForTimeout(ms)
// Milestone 1 and Priya's share, in cents, read from the deal the agents signed.
let M1 = 0
let SHARE = 0
const usd = (cents, digits = 2) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 && digits === 0 ? 2 : digits, maximumFractionDigits: 2 })}`

async function moveToPoint(x, y, ms = 620) {
  const t0 = Date.now()
  // A throttled rAF must never stall the whole take: cap the visual move, then go on.
  await Promise.race([
    page.evaluate(
      ({ x, y, ms }) =>
        new Promise((resolve) => {
          const c = document.getElementById('demo-cursor')
          if (!c) return resolve()
          const sx = Number(c.dataset.x)
          const sy = Number(c.dataset.y)
          const t0 = performance.now()
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
            if (p < 1) requestAnimationFrame(step)
            else resolve()
          }
          requestAnimationFrame(step)
        }),
      { x, y, ms },
    ),
    new Promise((resolve) => setTimeout(resolve, ms + 600)),
  ])
  console.log(`[move] ${Date.now() - t0}ms -> ${x.toFixed(0)},${y.toFixed(0)}`)
}

async function moveTo(locator, ms = 620) {
  const box = await locator.boundingBox()
  if (!box) {
    console.log('[move] no box')
    return
  }
  const x = box.x + Math.max(14, box.width - 18)
  const y = box.y + Math.min(box.height - 6, Math.max(16, box.height * 0.72))
  await moveToPoint(x, y, ms)
}

const isVisible = (locator) =>
  locator
    .evaluate((el) => {
      const r = el.getBoundingClientRect()
      return r.top >= 70 && r.bottom <= window.innerHeight - 30
    })
    .catch(() => false)

async function smoothScrollTo(locator, { ms = 900, align = 'center', margin = 120 } = {}) {
  const target = await locator.evaluate(
    (el, { align, margin }) => {
      const r = el.getBoundingClientRect()
      const top = r.top + window.scrollY
      if (align === 'top') return Math.max(0, top - margin)
      const vh = window.innerHeight
      return Math.max(0, top - (vh - Math.min(r.height, vh - margin)) / 2)
    },
    { align, margin },
  )
  const start = await page.evaluate(() => window.scrollY)
  if (Math.abs(target - start) < 2) return
  await Promise.race([
    page.evaluate(
      ({ start, target, ms }) =>
        new Promise((resolve) => {
          const root = document.documentElement
          const prev = root.style.scrollBehavior
          // The app sets scroll-behavior: smooth, which turns every call into a new
          // animation and cancels the previous one. Drive it frame by frame instead.
          root.style.scrollBehavior = 'auto'
          const t0 = performance.now()
          const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
          const step = (now) => {
            const p = Math.min(1, (now - t0) / ms)
            window.scrollTo(0, start + (target - start) * ease(p))
            if (p < 1) requestAnimationFrame(step)
            else {
              root.style.scrollBehavior = prev
              resolve()
            }
          }
          requestAnimationFrame(step)
        }),
      { start, target, ms },
    ),
    new Promise((resolve) => setTimeout(resolve, ms + 800)),
  ])
  await pause(60)
}

const toTop = () =>
  page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto'
    window.scrollTo(0, 0)
  })

// Today renders the card before the rest of the page settles. Wait, scroll, then
// re-measure once so a late layout shift cannot leave the card half off screen.
async function settleOn(locator, { margin = 110, ms = 1250 } = {}) {
  const t0 = Date.now()
  await pause(900)
  await smoothScrollTo(locator, { ms, align: 'top', margin })
  await pause(450)
  const box = await locator.boundingBox()
  if (box && Math.abs(box.y - margin) > 60) {
    await smoothScrollTo(locator, { ms: 420, align: 'top', margin })
  }
  console.log(`[settleOn] ${Date.now() - t0}ms`)
}

// Move the cursor to the action button while the page is scrolling the card in.
// A move made after a long static hold loses its intermediate frames on a long
// take, so the cursor appears to teleport; riding the scroll keeps it visible.
// Late AI answers and receipt panels reflow the page after the card first
// appears. Scrolling while that happens looks like a bounce, so wait until the
// card has held the same viewport position for half a second.
async function waitForStable(locator, { need = 5, step = 120, timeout = 6000 } = {}) {
  const start = Date.now()
  let prev = null
  let quiet = 0
  while (Date.now() - start < timeout) {
    const box = await locator.boundingBox().catch(() => null)
    if (box && prev && Math.abs(box.y - prev.y) < 1 && Math.abs(box.height - prev.height) < 1) quiet += 1
    else quiet = 0
    if (quiet >= need) return true
    prev = box
    await pause(step)
  }
  return false
}

async function settleOnWithCursor(card, button, { margin = 110, ms = 1250 } = {}) {
  const t0 = Date.now()
  await pause(600)
  await waitForStable(card)
  const cardBox = await card.boundingBox()
  const btnBox = await button.boundingBox()
  if (!cardBox || !btnBox) {
    await settleOn(card, { margin, ms })
    return
  }
  const scrollY = await page.evaluate(() => window.scrollY)
  const target = Math.max(0, cardBox.y + scrollY - margin)
  const x = btnBox.x + Math.max(14, btnBox.width - 18)
  const y = btnBox.y + scrollY - target + Math.min(btnBox.height - 6, Math.max(16, btnBox.height * 0.72))
  const trace = page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const out = []
        const t0 = performance.now()
        const timer = setInterval(() => {
          out.push([Math.round(performance.now() - t0), Math.round(window.scrollY)])
          if (performance.now() - t0 >= ms) {
            clearInterval(timer)
            resolve(out)
          }
        }, 50)
      }),
    ms + 600,
  )
  await Promise.all([
    smoothScrollTo(card, { ms, align: 'top', margin }),
    (async () => {
      await pause(180)
      await moveToPoint(x, y, ms - 120)
    })(),
  ])
  const samples = await trace
  let reversals = 0
  let prevDir = 0
  for (let i = 1; i < samples.length; i += 1) {
    const dir = Math.sign(samples[i][1] - samples[i - 1][1])
    if (dir && prevDir && dir !== prevDir) reversals += 1
    if (dir) prevDir = dir
  }
  await pause(90)
  const box = await card.boundingBox()
  const drift = box ? box.y - margin : 0
  // The card is already under the cursor. A second eased scroll here reads as a
  // bounce, so only correct a real miss, and do it without animation.
  if (box && Math.abs(drift) > 90) {
    await page.evaluate((dy) => window.scrollBy(0, dy), drift)
    await pause(200)
  }
  console.log(`[settleOn+] ${Date.now() - t0}ms cursor=${x.toFixed(0)},${y.toFixed(0)} drift=${drift.toFixed(0)} stable=${Math.abs(drift) <= 90}`)
  console.log(`[scroll] reversals=${reversals} from=${samples[0]?.[1]} to=${samples[samples.length - 1]?.[1]}`)
}

async function click(locator, settle = 520) {
  const label = await locator
    .evaluate((el) => (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40))
    .catch(() => '?')
  const t0 = Date.now()
  if (!(await isVisible(locator))) await smoothScrollTo(locator, { ms: 700, align: 'center' })
  const t1 = Date.now()
  await moveTo(locator, 620)
  const t2 = Date.now()
  await pause(140)
  await locator.click()
  const t3 = Date.now()
  await pause(settle)
  console.log(`[click] "${label}" vis=${t1 - t0} move=${t2 - t1} click=${t3 - t2}`)
}

async function clickOnly(locator, settle = 520) {
  const label = await locator
    .evaluate((el) => (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40))
    .catch(() => '?')
  const t0 = Date.now()
  if (!(await isVisible(locator))) await smoothScrollTo(locator, { ms: 700, align: 'center' })
  await locator.click()
  const t1 = Date.now()
  await pause(settle)
  console.log(`[click] "${label}" click=${t1 - t0} (no move)`)
}

async function navTo(name) {
  mark(`nav:${name}`)
  await click(page.getByRole('link', { name }).first(), 900)
  await toTop()
  await pause(650)
}

// Let the Today fetches and the late AI answers finish before measuring anything.
// A card that reflows under the cursor is what reads as jitter.
async function quiet(timeout = 6000) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {})
  await pause(350)
}

// Scale #root only. Callouts, the chapter, and the cursor stay on the document
// element, so a zoom cannot trap them or freeze cursor-only frames.
async function zoomOn(locator, scale = 1.32, ms = 680) {
  if (!(await isVisible(locator))) await smoothScrollTo(locator, { ms: 750, align: 'center' })
  const box = await locator.boundingBox()
  if (!box) return
  await page.evaluate(
    ({ scale, ms, cx, cy }) => {
      const root = document.getElementById('root')
      if (!root) return
      const rect = root.getBoundingClientRect()
      const ox = cx - rect.left
      const oy = cy - rect.top
      document.documentElement.style.overflow = 'hidden'
      root.style.willChange = 'transform'
      root.style.transition = `transform ${ms}ms cubic-bezier(.22,.61,.36,1)`
      root.style.transformOrigin = `${ox}px ${oy}px`
      root.style.transform = `scale(${scale})`
    },
    { scale, ms, cx: box.x + box.width / 2, cy: box.y + box.height / 2 },
  )
  await pause(ms + 160)
}

const marks = []
let lastFrameTs = null
function mark(id) {
  marks.push({ id, ts: lastFrameTs })
  log(`mark ${id}`)
}

async function chapter(text) {
  await page.evaluate((text) => {
    let el = document.getElementById('demo-chapter')
    if (!el) {
      el = document.createElement('div')
      el.id = 'demo-chapter'
      document.body.appendChild(el)
    }
    el.textContent = text
    document.documentElement.appendChild(el)
  }, text)
}

// Big keycaps on screen, pressed, then the real keystroke, so a shortcut is seen as well as used.
async function keys(caps, press, { hold = 650 } = {}) {
  await page.evaluate((caps) => {
    document.getElementById('demo-keys')?.remove()
    const row = document.createElement('div')
    row.id = 'demo-keys'
    for (const cap of caps) {
      const k = document.createElement('kbd')
      k.textContent = cap
      row.append(k)
    }
    document.documentElement.appendChild(row)
  }, caps)
  await pause(hold)
  await page.evaluate(() => document.querySelectorAll('#demo-keys kbd').forEach((k) => k.classList.add('down')))
  await page.keyboard.press(press)
  await pause(260)
  await page.evaluate(() => document.querySelectorAll('#demo-keys kbd').forEach((k) => k.classList.remove('down')))
  await pause(420)
  await page.evaluate(() => {
    const row = document.getElementById('demo-keys')
    if (!row) return
    row.style.transition = 'opacity 240ms ease'
    row.style.opacity = '0'
    setTimeout(() => row.remove(), 260)
  })
}

// A terminal on screen for a program that is not the browser: each line is what it printed, when it printed it.
async function termOpen(title) {
  await page.evaluate((title) => {
    document.getElementById('demo-term')?.remove()
    const box = document.createElement('div')
    box.id = 'demo-term'
    const head = document.createElement('div')
    head.className = 'head'
    head.append(document.createElement('i'), document.createTextNode(title))
    const body = document.createElement('div')
    body.className = 'body'
    box.append(head, body)
    document.documentElement.appendChild(box)
  }, title)
}
async function termLine(kind, text) {
  await page.evaluate(({ kind, text }) => {
    const body = document.querySelector('#demo-term .body')
    if (!body) return
    const line = document.createElement('div')
    line.className = `l ${kind}`
    const mark = { call: '→ ', refused: '✕ ', suspended: '■ ', inbox: '✉ ', thinks: '“', tools: 'tools: ', model: '' }[kind] ?? ''
    line.textContent = `${mark}${text}${kind === 'thinks' ? '”' : ''}`
    body.append(line)
    while (body.children.length > 11) body.firstElementChild?.remove()
  }, { kind, text })
}
async function termClose() {
  await page.evaluate(() => {
    const box = document.getElementById('demo-term')
    if (!box) return
    box.style.transition = 'opacity 260ms ease'
    box.style.opacity = '0'
    setTimeout(() => box.remove(), 280)
  })
  await pause(300)
}

async function clearNote() {
  await page.evaluate(() => document.getElementById('demo-note')?.remove())
}

// A lime box on the element, a dark card, and an elbow wire between them.
// The card sits in the first side that fits, and stays clear of the chapter chip.
async function note(locator, { kicker, title, body, hold = 2200 }) {
  if (!(await isVisible(locator))) await smoothScrollTo(locator, { ms: 700, align: 'center' })
  const box = await locator.boundingBox()
  if (!box) {
    console.log('[note] no box')
    return
  }
  await page.evaluate(({ box, kicker, title, body }) => {
    document.getElementById('demo-note')?.remove()
    const pad = 8
    const x = Math.max(8, box.x - pad)
    const y = Math.max(8, box.y - pad)
    const w = box.width + pad * 2
    const h = box.height + pad * 2
    const root = document.createElement('div')
    root.id = 'demo-note'
    const frame = document.createElement('div')
    frame.className = 'demo-frame'
    frame.style.left = `${x}px`
    frame.style.top = `${y}px`
    frame.style.width = `${w}px`
    frame.style.height = `${h}px`
    const card = document.createElement('div')
    card.className = 'demo-card'
    const kickerEl = document.createElement('span')
    kickerEl.className = 'demo-kicker'
    kickerEl.textContent = kicker
    const titleEl = document.createElement('strong')
    titleEl.textContent = title
    const bodyEl = document.createElement('p')
    bodyEl.textContent = body
    card.append(kickerEl, titleEl, bodyEl)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'demo-wire')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('class', 'demo-wire-path')
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    dot.setAttribute('r', '5')
    dot.setAttribute('class', 'demo-wire-dot')
    svg.append(path, dot)
    root.append(svg, frame, card)
    document.body.appendChild(root)
    card.style.left = '0px'
    card.style.top = '0px'
    const cw = card.offsetWidth
    const ch = card.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const gap = 26
    const spots = [
      { x: x + w + gap, y: Math.max(16, Math.min(vh - ch - 88, y + h / 2 - ch / 2)), side: 'right' },
      { x: x - cw - gap, y: Math.max(16, Math.min(vh - ch - 88, y + h / 2 - ch / 2)), side: 'left' },
      { x: Math.max(16, Math.min(vw - cw - 16, x + w - cw)), y: y - ch - gap, side: 'above' },
      { x: Math.max(16, Math.min(vw - cw - 16, x + w - cw)), y: y + h + gap, side: 'below' },
      { x: vw - cw - 20, y: 18, side: 'right' },
      { x: 20, y: 18, side: 'left' },
    ]
    const hitsFrame = (s) => !(s.x + cw < x - 8 || s.x > x + w + 8 || s.y + ch < y - 8 || s.y > y + h + 8)
    const hitsChapter = (s) => s.y + ch > vh - 62 && s.x < vw / 2 + 160 && s.x + cw > vw / 2 - 160
    const fits = (s) => s.x >= 16 && s.y >= 16 && s.x + cw <= vw - 16 && s.y + ch <= vh - 72 && !hitsFrame(s) && !hitsChapter(s)
    const spot = spots.find(fits) ?? spots.find((s) => s.x >= 16 && s.y >= 16 && s.x + cw <= vw - 16 && s.y + ch <= vh - 16) ?? { x: 20, y: 18, side: 'left' }
    card.style.left = `${spot.x}px`
    card.style.top = `${spot.y}px`
    const targetX = spot.side === 'left' ? x : spot.side === 'right' ? x + w : x + w / 2
    const targetY = spot.side === 'above' ? y : spot.side === 'below' ? y + h : y + Math.min(h / 2, 48)
    const fromX = spot.side === 'left' ? spot.x + cw : spot.side === 'right' ? spot.x : spot.x + cw / 2
    const fromY = spot.side === 'above' ? spot.y + ch : spot.side === 'below' ? spot.y : spot.y + ch / 2
    const d = spot.side === 'left' || spot.side === 'right'
      ? `M ${fromX} ${fromY} H ${(fromX + targetX) / 2} V ${targetY} H ${targetX}`
      : `M ${fromX} ${fromY} V ${(fromY + targetY) / 2} H ${targetX} V ${targetY}`
    path.setAttribute('d', d)
    const len = path.getTotalLength()
    path.style.strokeDasharray = String(len)
    path.style.strokeDashoffset = String(len)
    requestAnimationFrame(() => { path.style.strokeDashoffset = '0' })
    dot.setAttribute('cx', String(targetX))
    dot.setAttribute('cy', String(targetY))
  }, { box, kicker, title, body })
  await pause(hold)
}

async function zoomOut(ms = 520) {
  await page.evaluate((ms) => {
    const root = document.getElementById('root')
    if (!root || !root.style.transform) return
    root.style.transition = `transform ${ms}ms cubic-bezier(.22,.61,.36,1)`
    root.style.transform = 'scale(1)'
  }, ms)
  await pause(ms + 90)
  await page.evaluate(() => {
    const root = document.getElementById('root')
    if (!root) return
    root.style.transition = ''
    root.style.transform = ''
    root.style.transformOrigin = ''
    root.style.willChange = ''
    document.documentElement.style.overflow = ''
  })
}

// Zoom onto the proof, hold the wired card long enough for the line about it,
// then zoom back out before the next click.
// Leave a lane for the 280px card. The zoom grows around the card's center,
// so the free side is whichever edge starts farther from the viewport edge.
async function fitScale(locator, want) {
  const box = await locator.boundingBox()
  if (!box || box.width < 8 || box.height < 8) return want
  const card = 330
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const side = Math.max((1920 - card - cx) / (box.width / 2), (cx - card) / (box.width / 2))
  const vert = Math.min((cy - 36) / (box.height / 2), (1080 - 120 - cy) / (box.height / 2))
  const capped = Math.min(want, Number.isFinite(side) ? side : want, Number.isFinite(vert) ? vert : want)
  return Math.max(1.1, Math.min(want, capped))
}

async function show(locator, noteOpts, { scale = 1.32, markId } = {}) {
  await clearNote()
  if (!(await isVisible(locator))) await smoothScrollTo(locator, { ms: 750, align: 'center' })
  const fitted = await fitScale(locator, scale)
  await zoomOn(locator, fitted, 680)
  if (markId) mark(markId)
  await note(locator, noteOpts)
  await clearNote()
  await zoomOut(520)
}

// A card that replaces another fades in on top of it, and the old one goes only once it is
// covered. Fading the old one out first let the app show through between the two cards.
async function paintIntro(kind) {
  await page.evaluate((kind) => {
    const cursor = document.getElementById('demo-cursor')
    if (cursor) cursor.style.opacity = '0'
    const old = document.getElementById('demo-intro')
    // the old card keeps its id (and so its styles) until it is removed
    if (old) setTimeout(() => old.remove(), 520)
    const el = document.createElement('div')
    el.id = 'demo-intro'
    document.documentElement.appendChild(el)
    const kicker = document.createElement('div')
    kicker.className = 'mark'
    const h1 = document.createElement('h1')
    if (kind === 'people') {
      kicker.textContent = 'Before the demo'
      h1.textContent = 'Three people.'
      const list = document.createElement('div')
      list.className = 'who'
      for (const [name, role] of [
        ['Meera', 'Owns Line Studio. She is the only one who taps and pays.'],
        ['Northwind', 'The client. They pay for the logo.'],
        ['Priya', 'The designer. She keeps 60% of what Northwind pays.'],
      ]) {
        const row = document.createElement('div')
        const strong = document.createElement('strong')
        strong.textContent = name
        const span = document.createElement('span')
        span.textContent = role
        row.append(strong, span)
        list.append(row)
      }
      el.append(kicker, h1, list)
    } else {
      kicker.textContent = 'Mandate'
      h1.textContent = 'Agents can ask.'
      const line = document.createElement('div')
      line.className = 'line'
      line.textContent = 'Only you can pay.'
      const list = document.createElement('ul')
      for (const text of [
        'Rules refuse in code. The model never decides.',
        'PayPal moves only the cents you lock.',
        'A contractor is paid from money the client already settled.',
      ]) {
        const li = document.createElement('li')
        li.textContent = text
        list.append(li)
      }
      el.append(kicker, h1, line, list)
    }
    el.style.opacity = '0'
    requestAnimationFrame(() => {
      el.style.transition = 'opacity 420ms ease'
      el.style.opacity = '1'
    })
  }, kind)
}

async function hideIntro() {
  await page.evaluate(() => {
    const el = document.getElementById('demo-intro')
    if (!el) return
    el.style.transition = 'opacity 480ms ease'
    el.style.opacity = '0'
  })
  await pause(520)
  await page.evaluate(() => {
    document.getElementById('demo-intro')?.remove()
    const cursor = document.getElementById('demo-cursor')
    if (cursor) cursor.style.opacity = '1'
  })
}

const answer = () => page.locator('.answer')
const lockCard = () => page.locator('.panel[data-tour="receipt-lock"]')

// ---------------------------------------------------------------- capture
await page.goto(`${BASE}/app/unlock`)
await page.getByText('Ledger ready').waitFor()
await pause(700)

const client = await context.newCDPSession(page)
const frames = []
// Keep frames in memory while recording. Any disk I/O here can stall the event
// loop for seconds on this machine, which starves the screencast ack and makes
// Chrome drop every motion frame until the next click.
const blobs = []
client.on('Page.screencastFrame', (f) => {
  lastFrameTs = f.metadata.timestamp
  frames.push(f.metadata.timestamp)
  blobs.push(Buffer.from(f.data, 'base64'))
  client.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
})
async function flushFrames() {
  for (let i = 0; i < blobs.length; i += 32) {
    await Promise.all(
      blobs
        .slice(i, i + 32)
        .map((buf, j) => writeFile(`${OUT}/f${String(i + j + 1).padStart(5, '0')}.jpg`, buf)),
    )
  }
  blobs.length = 0
}
const SCREENCAST = {
  format: 'jpeg',
  quality: 82,
  maxWidth: 1920,
  maxHeight: 1080,
  everyNthFrame: 1,
}
await paintIntro('principle')
await client.send('Page.startScreencast', SCREENCAST)
await pause(450)
mark('intro')
await pause(8200)
await paintIntro('people')
await pause(420)
mark('cast')
await pause(15600)
await hideIntro()

// ---------------------------------------------------------------- unlock
log('unlock')
mark('unlock')
await click(page.getByLabel('API key'), 360)
await page.getByLabel('API key').fill(OWNER)
await pause(520)
await click(page.getByRole('button', { name: 'Unlock console' }), 1100)
await page.getByRole('heading', { name: /Waiting for you/ }).waitFor()
await chapter('Meera’s Today')
mark('hook')
await pause(11900)

// ---------------------------------------------------------------- try to break it
log('try to break it')
const breakIt = page.getByTestId('break-it')
await breakIt.waitFor()
await chapter('The rules, not the model')
mark('to-break')
await smoothScrollTo(breakIt, { ms: 1050, align: 'center' })
await pause(300)
const breakNotes = {
  'A fake vendor email': ['break', 1.42, 'payee.unknown', 'Not on the list', 'A made-up vendor is refused in code. PayPal is never called.', 10400],
  'An $18 team lunch': ['break-lunch', 1.42, 'category.missing', 'Lunch is not allowed', 'Under the automatic line, and still refused. The amount does not skip the category.', 11900],
  'Pay before the client has paid': ['break-funding', 1.42, 'funding.missing', 'No client money yet', 'Priya is paid only from a client payment that has already settled.', 11300],
}
for (const title of Object.keys(breakNotes)) {
  mark(`try:${title}`)
  await click(breakIt.getByRole('button', { name: title }), 500)
  await breakIt.locator('.break-result').waitFor()
  const [markId, scale, kicker, head, body, hold] = breakNotes[title]
  await show(breakIt.locator('.break-result'), { kicker, title: head, body, hold }, { scale, markId })
}

// ---------------------------------------------------------------- agents negotiate
log('deals: let the agents negotiate')
await navTo('Deals')
await page.getByRole('heading', { name: 'Deals', exact: true }).waitFor()
await pause(500)
await click(page.getByRole('button', { name: 'Keep these numbers' }), 800)
await page.getByRole('button', { name: 'Let the negotiators negotiate' }).waitFor()
const band = page.locator('[data-tour="deal-band"]')
await band.waitFor()
await chapter('Both companies’ rules')
await show(band, {
  kicker: 'Where a deal can exist',
  title: 'A floor and a ceiling',
  body: 'Line Studio will not take a job under $250. Northwind will not pay over $400. Each keeps its number private; a deal can only be accepted inside the overlap.',
  hold: 6200,
}, { scale: 1.16, markId: 'deals-band' })
mark('negotiate-start')
const negotiate = page.locator('[data-tour="deal-negotiate"]')
await negotiate.getByLabel('The job').fill('Spring launch logo')
await negotiate.getByLabel('Paid in milestones').fill('Concepts, Final files')
await click(page.getByRole('button', { name: 'Let the negotiators negotiate' }), 600)
const stage = page.locator('[data-tour="deal-story"]')
await stage.waitFor()
await stage.getByTestId('negotiation-end').waitFor({ timeout: 300000 })
// The negotiators pick every number, so every amount from here on is read from what the server recorded and signed.
const negotiation = (await (await page.request.get(`${BASE}/v1/negotiations`, { headers: { authorization: `Bearer ${OWNER}` } })).json()).data[0]
if (!negotiation || negotiation.status !== 'agreed') throw new Error(`the negotiation ended with no deal: ${negotiation?.ending ?? 'nothing came back'}`)
const agreed = (await (await page.request.get(`${BASE}/v1/deals/${negotiation.agreedDealId}`, { headers: { authorization: `Bearer ${OWNER}` } })).json())
const total = (deal) => deal.terms.milestones.reduce((sum, m) => sum + m.amountCents, 0)
const offers = negotiation.moves.filter((move) => move.action === 'offer').map((move) => move.totalCents)
M1 = agreed.terms.milestones[0].amountCents
SHARE = Math.round(M1 * 0.6)
log(`deal: agreed ${usd(total(agreed))} after ${offers.map((c) => usd(c)).join(', ')}; milestone 1 ${usd(M1)}, Priya ${usd(SHARE)}`)
writeFileSync(`${OUT}/deal.json`, JSON.stringify({ agreedCents: total(agreed), milestoneCents: M1, shareCents: SHARE, offerCents: offers, ending: negotiation.ending }))
await chapter('The negotiators negotiate')
await show(stage, {
  kicker: `${offers.length} offers, then a yes`,
  title: `${offers.map((c) => usd(c, 0)).join(' → ')} · ${usd(total(agreed), 0)} accepted`,
  body: 'Each negotiator decides its own moves inside its own company’s private limits. A deal exists only when one side accepts the other’s exact offer: then both companies’ rules are checked and the server signs it.',
  hold: 11000,
}, { scale: 1.08, markId: 'negotiate' })
mark('deliver')
await click(stage.getByRole('button', { name: /Go to the signed deal/ }), 800)
const proof = page.getByLabel('Link to the delivered work for the next milestone')
await proof.waitFor()
await proof.fill('https://www.figma.com/file/northwind-logo')
await pause(400)
await click(page.getByRole('button', { name: /Deliver milestone 1/ }), 1000)
await page.waitForURL(/\/p\//)
await pause(600)

// Arrive at Today at the top, then roll down to the card.
log('approve the milestone, paid on our page')
await navTo('Today')
await page.getByRole('heading', { name: /Waiting for you/ }).waitFor()
await quiet()
await pause(700)
const charge = page.locator('.approval').filter({ hasText: 'Bill Northwind' }).filter({ hasText: usd(M1) })
await charge.waitFor()
await click(charge.getByText('On our page'), 450)
await chapter('Pay on our page')
await show(charge.locator('[data-testid="instrument"]'), {
  kicker: 'How Northwind pays',
  title: 'A card form here',
  body: 'Not a PayPal invoice, and not a redirect to the sandbox. The card stays on this page. The amount is still the lock.',
  hold: 6200,
}, { scale: 1.28, markId: 'instrument' })
const approveCharge = charge.getByRole('button', { name: /Approve/ })
await settleOnWithCursor(charge, approveCharge)
mark('approve')
await clickOnly(approveCharge, 900)
await charge.getByText('Approved · locked').waitFor()
await chapter('Locked to the cent')
await show(charge, { kicker: 'Signed lock', title: 'The cents are frozen', body: 'A later retry with a different amount is refused. PayPal only sees this lock.', hold: 7800 }, { scale: 1.22, markId: 'lock' })

// The standing rule has to be live before the $150 settles. Publishing does not
// go back and pay a charge that already settled.
// She says the change in a sentence. Ask Mandate (⌘K) sees a rule, not a payment, and
// hands the words to the rules drafter; a model drafts, code checks it against her words,
// and she reviews and publishes. No form filling.
log('rules: asked for in words, through Ask Mandate')
mark('ask-intro')
await chapter('Ask Mandate · ⌘K')
await pause(2600)
await keys(['⌘', 'K'], 'Meta+K')
const askDialog = page.getByRole('dialog', { name: 'Ask Mandate' })
await askDialog.waitFor()
mark('ask-open')
const askBox = askDialog.locator('textarea')
await moveTo(askBox, 520)
await pause(500)
// The last clause asks for something the rules cannot do, so the check has something to catch.
await askBox.pressSequentially('Pay Priya 60% of what Northwind pays, automatically, and email me when it happens', { delay: 58 })
mark('ask-typed')
await pause(1100)
await keys(['↵'], 'Enter', { hold: 380 })
await page.waitForURL(/\/rules/)
const draftBox = page.locator('[data-tour="rules-draft"]')
await draftBox.waitFor()
await chapter('Say it in your own words')
await smoothScrollTo(draftBox, { ms: 850, align: 'top', margin: 90 })
mark('rules-drafting')
// A live model drafts it; the steps stay on screen as the server takes them.
const draftResult = draftBox.locator('.draft-result')
await draftResult.waitFor({ timeout: 90000 })
await pause(1800)
const ignoredNote = draftResult.locator('.draft-ignored')
if (await ignoredNote.count()) {
  await show(ignoredNote, {
    kicker: 'Caught by code',
    title: 'Said, but not in the rule',
    body: 'Mandate sends no email. Code finds the words nothing carries out and says so, instead of a draft that pretends.',
    hold: 7600,
  }, { scale: 1.2, markId: 'rules-flag' })
}
await show(draftResult.locator('.draft-loosens'), {
  kicker: 'Checked by code',
  title: 'What it lets happen without her',
  body: 'Priya from Northwind with no tap, paid the moment the client pays. Nothing is live yet.',
  hold: 7200,
}, { scale: 1.2, markId: 'rules-draft' })

await click(draftBox.getByRole('button', { name: /Review this draft/ }), 900)
mark('rules-editor')
await chapter('Before it is live')
await click(page.getByRole('button', { name: 'Review changes' }), 800)
const diff = page.locator('.editor table.diff').first()
await diff.waitFor()
await show(diff, {
  kicker: 'Before it is live',
  title: 'Two changes',
  body: 'Priya from Northwind, with no tap. And pay contractors when the client pays. She still has to publish.',
  hold: 5600,
}, { scale: 1.2, markId: 'rules-review' })
mark('rules-publish')
await click(page.getByRole('button', { name: 'Publish version 2' }), 1000)
await page.getByText('Standing rule: Priya Shah is paid, with no tap').waitFor()
await page.getByTestId('rules-glance').waitFor()
await chapter('Version 2 is live')
await show(page.getByTestId('rules-glance'), {
  kicker: 'Signed',
  title: 'The standing rule is in force',
  body: `Under $20, no tap. And now whatever this rule covers, no tap either. The ${usd(M1, 0)} bill still needs hers.`,
  hold: 5800,
}, { scale: 1.12, markId: 'rules-live' })

log(`settle ${usd(M1)} — Priya is paid by the rule`)
await navTo('Today')
await page.getByRole('heading', { name: /Waiting for you/ }).waitFor()
await quiet()
const ready = page.locator('.item-ready').filter({ hasText: 'Northwind' })
await ready.waitFor()
await smoothScrollTo(ready, { ms: 800, align: 'center' })
await pause(400)
mark('settle-open')
await click(ready.getByRole('link', { name: new RegExp(`Settle ${usd(M1).replace(/[$.]/g, '\\$&')}`) }), 900)
await page.getByTestId('pay-here-owner-button').waitFor()
await click(page.getByTestId('pay-here-owner-button'), 700)
const card = page.getByTestId('pay-panel')
await card.waitFor()
if (REAL_PAYPAL) {
  // PayPal's fields are iframes inside our form. A sandbox test Visa, typed as a person would.
  const field = (kind) => page.frameLocator(`[data-testid="pay-field-${kind}"] iframe`).first().locator('input').first()
  await field('number').waitFor({ timeout: 30000 })
  for (const [kind, value] of [['number', '4111111111111111'], ['expiry', '1228'], ['cvv', '123']]) {
    await moveTo(page.getByTestId(`pay-field-${kind}`), 420)
    await field(kind).click()
    await field(kind).pressSequentially(value, { delay: 55 })
    await pause(260)
  }
} else {
  await page.locator('[data-paypal-field="number"]').fill('4032 0393 1798 4309')
  await pause(320)
  await page.locator('[data-paypal-field="expiry"]').fill('12 / 28')
  await pause(280)
  await page.locator('[data-paypal-field="cvv"]').fill('123')
}
await pause(400)
await chapter('Card details')
await show(card, {
  kicker: 'On our page',
  title: 'No sandbox redirect',
  body: `Number, expiry, and the code. The ${usd(M1, 0)} is the lock. Paying stays on this page.`,
  hold: 6400,
}, { scale: 1.24, markId: 'card' })
mark('pay')
await click(page.getByTestId('pay-submit'), 1200)
await lockCard().waitFor({ timeout: REAL_PAYPAL ? 90000 : 20000 })
await chapter('Northwind paid')
await show(lockCard(), { kicker: 'Settled', title: 'PayPal confirmed the lock', body: 'What arrived matches what was signed. That payment is what releases Priya’s share.', hold: 6400 }, { scale: 1.16, markId: 'settled' })
await page.evaluate(() => {
  window.__receiptBlobs = []
  const orig = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (blob) => {
    blob.text().then((text) => window.__receiptBlobs.push(text)).catch(() => {})
    return orig(blob)
  }
})
mark('download')
await click(page.getByRole('button', { name: 'Download receipt' }), 700)
RECEIPT_JSON = await page.evaluate(() => window.__receiptBlobs[window.__receiptBlobs.length - 1] ?? null)
if (!RECEIPT_JSON) throw new Error('receipt download did not produce a file')

await navTo('Today')
await page.getByRole('heading', { name: /Waiting for you/ }).waitFor()
await quiet()
const done = page.locator('[data-tour="today-done"]')
const priya = done.locator('.item').filter({ hasText: `Priya Shah was paid ${usd(SHARE)}` })
// A real payout settles on PayPal's side a little later; the server looks every few seconds.
await priya.waitFor({ timeout: REAL_PAYPAL ? 180000 : 15000 })
await smoothScrollTo(priya, { ms: 800, align: 'center' })
await chapter('Priya is paid')
await show(priya, {
  kicker: 'No tap',
  title: 'The rule paid her',
  body: `Northwind’s ${usd(M1, 0)} settled, so autopilot sent Priya ${usd(SHARE, 0)}. Meera did not approve this one.`,
  hold: 7800,
}, { scale: 1.28, markId: 'payout-auto' })
mark('open-priya')
await click(priya.getByRole('link', { name: `Priya Shah was paid ${usd(SHARE)}` }), 900)
await page.locator('.payout-status').getByText(/reached Priya Shah/).waitFor({ timeout: REAL_PAYPAL ? 120000 : 30000 })
await show(page.locator('.payout-status'), {
  kicker: 'Autopilot',
  title: `${usd(SHARE, 0)} reached Priya`,
  body: 'Asked because the client paid. Locked under the standing rule, no tap. PayPal says the cents match.',
  hold: 8600,
}, { scale: 1.18, markId: 'payout-sent' })

// ---------------------------------------------------------------- the job
log('job totals')
mark('open-job')
await click(page.getByRole('link', { name: 'See the job' }).first(), 1000)
await toTop()
await pause(700)
await page.locator('section.totals').waitFor()
await chapter('Where the job is')
const track = page.locator('ol.track')
if (await track.count()) {
  await show(track, { kicker: 'One stage', title: 'Billed, paid, paid out', body: 'The job shows where it is. You do not have to read the ledger to see it.', hold: 8200 }, { scale: 1.28, markId: 'job' })
}
await show(page.locator('section.totals'), { kicker: 'The job', title: `${usd(M1, 0)} in, ${usd(SHARE, 0)} out, ${usd(M1 - SHARE, 0)} kept`, body: 'Every cent on this page is a number the server already stored.', hold: 10800 }, { scale: 1.16, markId: 'job-totals' })

// ---------------------------------------------------------------- any agent
log('connect an agent')
await navTo('Connect an agent')
await page.getByTestId('connect-agent').waitFor()
await pause(600)
await page.getByPlaceholder('e.g. Nightly invoice sweep').fill('Northwind billing clerk')
await pause(600)
await smoothScrollTo(page.getByTestId('can-and-cannot-preview'), { ms: 900, align: 'center' })
await chapter('Any agent, same door')
await show(page.getByTestId('can-and-cannot-preview'), { kicker: 'Six tools', title: 'It can ask. It cannot pay.', body: 'Read, explain, propose. Approve and pay stay on Meera’s key.', hold: 12800 }, { scale: 1.18, markId: 'agent' })
// The key she makes goes to an outside agent: a separate program, on a live model, that reaches Mandate only
// through the MCP door. Its inbox has been poisoned. It asks; the rules refuse; three refusals and its key is
// suspended. The scorecard below follows along as it happens.
const created = page.waitForResponse((res) => /\/v1\/agents$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST')
mark('create-key')
await click(page.getByTestId('create-agent-button'), 900)
const AGENT_KEY = (await (await created).json()).apiKey
if (!AGENT_KEY) throw new Error('no agent key came back')
await page.getByTestId('connect-reveal').waitFor()
await pause(900)
const scorecard = page.getByTestId('agent-scorecard-table')
await smoothScrollTo(scorecard, { ms: 1100, align: 'top', margin: 600 })
await pause(400)
await chapter('An outside agent, fooled')
await termOpen('Outside agent · live model · MCP door, its own key')
mark('attack')
const API_DIR = new URL('../../api/', import.meta.url).pathname
const agentRun = spawn(process.execPath, ['./node_modules/tsx/dist/cli.mjs', 'scripts/outside-agent.ts', `${BASE}/mcp`], {
  cwd: API_DIR,
  env: { ...process.env, MANDATE_AGENT_KEY: AGENT_KEY },
  stdio: ['ignore', 'pipe', 'pipe'],
})
agentRun.stderr.on('data', (chunk) => process.stderr.write(`[agent] ${chunk}`))
let refusals = 0
for await (const raw of createInterface({ input: agentRun.stdout })) {
  let line
  try { line = JSON.parse(raw) } catch { continue }
  console.log(`[agent] ${ts()}s ${line.kind} ${line.text}`)
  await termLine(line.kind, line.text)
  if (line.kind === 'refused') mark(`attack-refused-${++refusals}`)
  if (line.kind === 'suspended') mark('attack-suspended')
}
const row = scorecard.locator('tr', { hasText: 'Northwind billing clerk' })
await row.getByText('suspended', { exact: false }).first().waitFor({ timeout: 15000 })
await pause(1600)
await termClose()
await chapter('Only that key is stopped')
await show(row, {
  kicker: 'Breaker',
  title: 'Suspended, on its own',
  body: 'Three refusals in two minutes, so this key is stopped. Mandate carries on, and Meera decides whether it comes back.',
  hold: 7400,
}, { scale: 1.2, markId: 'suspended' })

// ---------------------------------------------------------------- proof
log('verify a receipt')
mark('verify')
await page.goto(`${BASE}/app/verify`)
await page.locator('#receipt-json').waitFor()
await pause(600)
await page.locator('#receipt-json').fill(RECEIPT_JSON)
await pause(400)
await click(page.getByRole('button', { name: 'Verify this receipt' }), 900)
await page.getByTestId('verdict').waitFor()
await page.getByText('This receipt is genuine.').waitFor()
await chapter('Proof you can check')
await show(page.getByTestId('verdict'), { kicker: 'Genuine', title: 'Checked in the browser', body: 'The receipt is verified against the public key. No server call decides this.', hold: 9400 }, { scale: 1.3, markId: 'proof' })
const original = JSON.parse(RECEIPT_JSON)
const tampered = { ...original, proposal: { ...original.proposal, amountCents: original.proposal.amountCents + 5000 } }
mark('tamper-edit')
await page.locator('#receipt-json').fill(JSON.stringify(tampered, null, 2))
await pause(300)
await click(page.getByRole('button', { name: 'Verify this receipt' }), 700)
await page.getByText('Do not rely on this receipt.').waitFor()
await show(page.getByTestId('verdict'), { kicker: 'Tampered', title: 'One number changed', body: 'The signature no longer matches. Agents can ask. Only you can pay.', hold: 7500 }, { scale: 1.3, markId: 'tamper' })
await pause(900)

// ---------------------------------------------------------------- stop
await client.send('Page.stopScreencast')
await pause(600)
await flushFrames()
writeFileSync(`${OUT}/frames.json`, JSON.stringify(frames))
writeFileSync(`${OUT}/marks.json`, JSON.stringify({ t0: frames[0] ?? null, marks }))
log(`frames ${frames.length}, span ${(frames[frames.length - 1] - frames[0]).toFixed(2)}s`)
await context.close()
await browser.close()
