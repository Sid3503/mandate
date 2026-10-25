import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const OUT_DIR = resolve('/Users/siddharth.mishra/Desktop/mandate-devpost-gallery')
if (!existsSync(OUT_DIR)) {
  mkdirSync(OUT_DIR, { recursive: true })
}

const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'owner-e2e-key-0123456789'

console.log('[capture] Starting e2e server on port', PORT)
const server = spawn('node', ['api/node_modules/tsx/dist/cli.mjs', 'api/src/dev/e2e-server.ts'], {
  env: { ...process.env, PORT: String(PORT), E2E_SCENARIO: 'ironbark' },
  stdio: ['ignore', 'pipe', 'pipe']
})

server.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`))

// Wait for server to be up
let up = false
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`${BASE}/__fake/session`)
    if (res.status === 200) {
      up = true
      break
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 250))
}
if (!up) {
  console.error('[capture] Server failed to start')
  server.kill()
  process.exit(1)
}
console.log('[capture] Server is ready at', BASE)

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox']
})

const context = await browser.newContext({
  viewport: { width: 1440, height: 960 }, // Perfect 3:2 ratio for Devpost
  deviceScaleFactor: 2,
})

await context.addCookies([
  { name: 'mandate_session', value: OWNER, domain: '127.0.0.1', path: '/' },
  { name: 'mandate_session', value: OWNER, domain: 'localhost', path: '/' },
])

const page = await context.newPage()
await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))

async function shoot(name, desc) {
  try {
    const path = `${OUT_DIR}/${name}.png`
    await page.screenshot({ path, fullPage: false })
    console.log(`[captured] ${name}.png — ${desc}`)
  } catch (err) {
    console.error(`[err shooting ${name}]`, err.message)
  }
}

try {
  // 1. Landing Hero
  console.log('[capture] 1. Landing Hero')
  await page.goto(`${BASE}/app/welcome`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(600)
  await shoot('01-landing-hero', 'Landing Page Hero & Product Introduction')

  // 2. Unlock Screen
  console.log('[capture] 2. Unlock Screen')
  await page.goto(`${BASE}/app/unlock`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(500)
  await shoot('02-unlock-screen', 'Cryptographic Biometric & Key Unlock')

  // 3. Today Cockpit
  console.log('[capture] 3. Today Cockpit')
  await page.goto(`${BASE}/app/today`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(800)
  await shoot('03-today-cockpit', 'Owner Today Cockpit & Action Queue')

  // 4. Try to break it (Refusals)
  console.log('[capture] 4. Try to break it')
  try {
    const breakBtn = page.getByRole('button', { name: /Try to break it/i })
    if (await breakBtn.isVisible({ timeout: 2000 })) {
      await breakBtn.click()
      await page.waitForTimeout(1000)
      await shoot('04-attacks-refused', 'Deterministic Rule Engine Blocking Exploits (payee.unknown)')
    }
  } catch (e) {
    console.log('Skipping break click:', e.message)
  }

  // 5. Ask Mandate (⌘K)
  console.log('[capture] 5. Ask Mandate')
  try {
    await page.keyboard.press('Meta+k')
    await page.waitForTimeout(600)
    await shoot('05-ask-mandate-cmd-k', 'Natural Language ⌘K Query Palette')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  } catch (e) {
    console.log('Skipping ⌘K:', e.message)
  }

  // 6. Bilateral AI Deals / Price Sheets
  console.log('[capture] 6. Bilateral AI Deals')
  await page.goto(`${BASE}/app/deals`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(600)
  try {
    const keepBtn = page.getByRole('button', { name: 'Keep these numbers' })
    if (await keepBtn.isVisible({ timeout: 1500 })) {
      await keepBtn.click()
      await page.waitForTimeout(400)
    }
  } catch {}
  await shoot('06-deals-bilateral-limits', 'Bilateral Private Reservation Prices')

  // Start negotiation
  try {
    const negBtn = page.getByRole('button', { name: /negotiate/i })
    if (await negBtn.isVisible({ timeout: 1500 })) {
      await negBtn.click()
      await page.waitForTimeout(2000)
      await shoot('07-deal-negotiation-graph', 'Bilateral Multi-Round Negotiation Trajectory')
    }
  } catch {}

  // 7. Deliver & Approve Milestone
  console.log('[capture] 7. Deliver Milestone')
  try {
    const deliverBtn = page.getByRole('button', { name: /Deliver milestone/i })
    if (await deliverBtn.isVisible({ timeout: 1500 })) {
      await deliverBtn.click()
      await page.waitForTimeout(500)
    }
  } catch {}

  await page.goto(`${BASE}/app/today`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(800)
  await shoot('08-milestone-locked', 'Milestone 1 Locked & Signed with Ed25519')

  // 8. On-page Pay with Card (PayPal Card Fields)
  console.log('[capture] 8. Pay with Card')
  try {
    const payCardBtn = page.getByRole('button', { name: /Pay with a card here|On our page|Settle/i }).first()
    if (await payCardBtn.isVisible({ timeout: 2000 })) {
      await payCardBtn.click()
      await page.waitForTimeout(1000)
      await shoot('09-paypal-card-pay-on-page', 'Native PayPal Card Fields Embedded On-Page')

      const paySubmit = page.getByRole('button', { name: /Pay \$|Pay with a card/i }).first()
      if (await paySubmit.isVisible({ timeout: 1500 })) {
        await paySubmit.click()
        await page.waitForTimeout(1500)
      }
    }
  } catch (e) {
    console.log('Skipping card form:', e.message)
  }

  // 9. Jobs Overview
  console.log('[capture] 9. Jobs Overview')
  await page.goto(`${BASE}/app/jobs`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(600)
  await shoot('10-job-pipeline-totals', 'Milestone Pipeline ($1,200 in, $600 out, $600 kept)')

  // 10. Rules Editor / Drafter
  console.log('[capture] 10. Rules Editor')
  await page.goto(`${BASE}/app/rules`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(600)
  await shoot('11-rules-engine', 'Spend Authority Policy & Standing Rules')

  // 11. AG Grid Ledger (All & Refused)
  console.log('[capture] 11. AG Grid Ledger')
  await page.goto(`${BASE}/app/ledger`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
  await shoot('12-ag-grid-ledger-all', 'AG Grid Real-Time Append-Only Transaction Ledger')

  try {
    const refusedTab = page.getByRole('button', { name: 'Refused' })
    if (await refusedTab.isVisible({ timeout: 1500 })) {
      await refusedTab.click()
      await page.waitForTimeout(600)
      await shoot('13-ag-grid-ledger-refused', 'AG Grid Filtering Blocked Security Exploits')
    }
  } catch {}

  // 12. AG Studio Control Room
  console.log('[capture] 12. AG Studio Control Room')
  await page.goto(`${BASE}/app/control-room`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
  await shoot('14-ag-studio-control-room', 'AG Studio Dynamic Dashboard with AI Analyst')

  // 13. Cryptographic Proof Page
  console.log('[capture] 13. Cryptographic Proof')
  await page.goto(`${BASE}/app/proof`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(600)
  await shoot('15-cryptographic-proof', 'Cryptographic Proof & Invariant Verification')

  // 14. Agent Connect (MCP)
  console.log('[capture] 14. Agent Connect')
  await page.goto(`${BASE}/app/connect`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(600)
  await shoot('16-mcp-agent-connect', 'Model Context Protocol (MCP) Door & Scoped Keys')

  // 15. Offline Receipt Verifier
  console.log('[capture] 15. Offline Receipt Verifier')
  await page.goto(`${BASE}/app/verify`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(600)
  await shoot('17-receipt-verifier-offline', 'Zero-Trust Standalone Offline Receipt Verifier')

} catch (err) {
  console.error('[capture] Error during capture:', err)
} finally {
  await browser.close()
  server.kill()
  console.log('[capture] All done! Images saved to:', OUT_DIR)
}
