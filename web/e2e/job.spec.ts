import { expect, test, type Page } from '@playwright/test'

const OWNER = 'owner-e2e-key-0123456789'
const PROPOSER = 'proposer-e2e-key-0123456789'
const shots = (page: Page, name: string) => page.screenshot({ path: `e2e/shots/${test.info().project.name}-${name}.png`, fullPage: true, animations: 'disabled' })

async function unlock(page: Page, key: string) {
  await page.goto('/app/')
  await expect(page).toHaveURL(/\/app\/unlock/)
  await page.getByLabel('API key').fill(key)
  await page.getByRole('button', { name: 'Unlock console' }).click()
  await expect(page.getByRole('heading', { name: /Waiting for you/ })).toBeVisible()
}

async function ask(page: Page, fill: () => Promise<void>) {
  await page.goto('/app/new')
  await fill()
  await page.getByRole('button', { name: 'Ask the rules' }).click()
  return page.locator('.answer')
}

async function amount(page: Page, dollars: string) {
  await page.getByLabel('Amount').fill(dollars)
}

test.describe.configure({ mode: 'serial' })

test('the frozen job, end to end, from the owner console', async ({ page }) => {
  const job = `job_northwind_logo_${test.info().project.name}`
  await shots(page, '00-blank').catch(() => undefined)
  await page.goto('/app/unlock')
  await expect(page.getByText('Ledger ready')).toBeVisible()
  await shots(page, '01-unlock')
  await unlock(page, OWNER)
  await shots(page, '02-waiting-empty')

  // An $18 team lunch is refused: lunch is not allowed work, even under the $20 line.
  let answer = await ask(page, async () => {
    await page.getByLabel('Funded by which client payment').selectOption({ label: 'Nothing yet · the client has not paid' })
    await amount(page, '18')
    await page.getByLabel('Kind of work').selectOption({ label: 'Something else…' })
    await page.getByLabel('Other kind of work').fill('lunch')
    await page.getByLabel('What it is for').fill('Team lunch')
    await page.getByLabel('Link to the work').fill('https://example.com/receipt')
  })
  await expect(answer.getByText('Refused')).toBeVisible()
  await expect(answer).toContainText('category.missing')
  await expect(answer).toContainText('$0 moved')

  // Priya before Northwind has paid: nothing funds it.
  answer = await ask(page, async () => {
    await page.getByLabel('Funded by which client payment').selectOption({ label: 'Nothing yet · the client has not paid' })
    await amount(page, '90')
    await page.getByLabel('What it is for').fill('Northwind logo milestone 1')
    await page.getByLabel('Link to the work').fill('https://www.figma.com/file/northwind-logo')
  })
  await expect(answer).toContainText('funding.missing')
  await expect(answer).toContainText('The client has not paid for this yet')
  await shots(page, '03-refused-unfunded')

  // Money in: bill Northwind $150 for milestone 1.
  answer = await ask(page, async () => {
    await page.getByText('Money in').click()
    await amount(page, '150')
    await page.getByLabel('What it is for').fill('Northwind logo milestone 1 invoice')
    await page.getByLabel('Link to the work').fill('https://www.figma.com/file/northwind-logo')
    await page.getByLabel('Job').fill(job)
    await page.getByLabel('How it was asked, in words').fill('Bill Northwind $150 for logo milestone 1')
  })
  await expect(answer.getByText('Needs you')).toBeVisible()

  // Approve the charge and settle it (the fake PayPal buyer approves at once).
  await page.goto('/app/')
  const charge = page.locator('.approval').filter({ hasText: 'Bill Northwind' }).filter({ hasText: job })
  await expect(charge).toBeVisible()
  await shots(page, '04-waiting-charge')
  await charge.getByRole('button', { name: /Approve/ }).click()
  await expect(charge.getByText('Approved · locked')).toBeVisible()
  await charge.getByRole('link', { name: 'Settle →' }).click()
  await page.getByRole('button', { name: /Settle \$150\.00/ }).click()
  await expect(page.locator('.match-flag')).toHaveText('cents match ✓')

  // Money out: Priya's $90, funded by the $150 capture.
  answer = await ask(page, async () => {
    const funding = page.getByLabel('Funded by which client payment')
    await expect(funding.locator('option', { hasText: 'can fund $90.00' })).toHaveCount(1)
    await funding.selectOption({ index: 1 })
    await amount(page, '90')
    await page.getByLabel('What it is for').fill('Northwind logo milestone 1')
    await page.getByLabel('Link to the work').fill('https://www.figma.com/file/northwind-logo')
    await page.getByLabel('How it was asked, in words').fill('Pay Priya her $90 share for Northwind milestone 1')
  })
  await expect(answer.getByText('Needs you')).toBeVisible()
  await expect(answer).toContainText('$90.00 is at or above $20.00')

  // Meera's tap: the hero shot.
  await page.goto('/app/')
  const payout = page.locator('.approval').filter({ hasText: 'Pay Priya Shah' }).filter({ hasText: job })
  await expect(payout).toContainText('Funded by')
  await expect(payout).toContainText('settled ✓')
  await shots(page, '05-waiting-priya')
  await payout.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `e2e/shots/${test.info().project.name}-05b-fold.png`, animations: 'disabled' })
  await payout.getByRole('button', { name: /Approve \$90\.00/ }).click()
  await expect(payout.getByText('Approved · locked')).toBeVisible()
  await expect(payout).toContainText('not yet paid')
  await page.waitForTimeout(600)
  await shots(page, '06-priya-locked')
  await payout.getByRole('link', { name: 'View payout status →' }).click()

  // Money out is reserved, never sent through Orders checkout: say so, and offer no way to send it wrongly.
  const status = page.locator('.payout-status')
  await expect(status).toContainText('approved and reserved for Priya Shah, but it has not been sent')
  await expect(status).toContainText('Reserved · not paid')
  await expect(page.getByRole('button', { name: /Settle|Check PayPal/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open PayPal ↗' })).toHaveCount(0)
  await expect(page.locator('.match-flag')).toHaveText('reserved · not paid')
  await shots(page, '07-payout-status')

  // A retry at $250 is refused: the lock is $90.
  await page.getByText('Integrity check · try to change the amount').click()
  await page.getByLabel('Claimed amount').fill('250')
  await page.getByRole('button', { name: 'Send claim' }).click()
  await expect(page.locator('.refused-claim')).toContainText('cart.immutable')
  await expect(page.locator('.refused-claim')).toContainText('$0 moved')
  await shots(page, '08-receipt-refused-claim')

  // The job: $150 in, $0 out, $90 reserved for Priya, $60 kept.
  await page.goto(`/app/jobs/${job}`)
  await expect(page.locator('.total-in')).toContainText('$150.00')
  await expect(page.locator('.total-out')).toContainText('$0.00')
  await expect(page.locator('.totals')).toContainText('Reserved for payouts')
  await expect(page.locator('.total-kept')).toContainText('$60.00')
  await expect(page.locator('.payouts')).toContainText('Approved · awaiting Payouts')
  await shots(page, '09-job')

  // The ledger grid shows the refusals.
  await page.goto('/app/ledger')
  await page.getByRole('button', { name: 'Refused', exact: true }).click()
  await expect(page.locator('.ag-row.row-refused').first()).toBeVisible()
  await shots(page, '10-ledger-refused')
  await page.getByRole('button', { name: 'Everything' }).click()
  await expect(page.locator('.grid-wrap .ag-row')).toHaveCount(4)
  await page.waitForTimeout(300)
  await shots(page, '11-ledger-all')

  // Rules history and a new version with a reviewed diff.
  await page.goto('/app/rules')
  await expect(page.getByText('version 1 is live', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Write version 2' }).click()
  await page.getByLabel('Automatic under').fill('25')
  await page.getByRole('button', { name: 'Review changes' }).click()
  await expect(page.locator('.editor .diff .now')).toHaveText('$25.00')
  await shots(page, '12-rules-review')
  await page.getByRole('button', { name: 'Publish version 2' }).click()
  await expect(page.getByText('version 2 is live', { exact: false })).toBeVisible()
  await shots(page, '13-rules-v2')

  await page.goto('/app/system')
  await expect(page.getByText('Owner · can approve, settle, change rules')).toBeVisible()
  await shots(page, '14-system')
})

test('a buyer who has not approved gets a clear "still waiting" answer, not a silent retry', async ({ page }) => {
  await unlock(page, OWNER)
  const answer = await ask(page, async () => {
    await page.getByText('Money in').click()
    await amount(page, '150')
    await page.getByLabel('What it is for').fill('Northwind pending buyer')
    await page.getByLabel('Link to the work').fill('https://www.figma.com/file/northwind-logo')
    await page.getByLabel('Job').fill('job_pending_buyer')
  })
  await answer.getByRole('link', { name: 'Open receipt →' }).click()
  await page.goto('/app/')
  const card = page.locator('.approval').filter({ hasText: 'Northwind pending buyer' })
  await card.getByRole('button', { name: /Approve/ }).click()
  await card.getByRole('link', { name: 'Settle →' }).click()
  await page.route('**/v1/proposals/*/capture', (route) => route.fulfill({
    status: 409,
    contentType: 'application/problem+json',
    body: JSON.stringify({ code: 'paypal.buyer_pending', title: 'Buyer has not approved the PayPal order', status: 409, detail: 'Open the approve URL, then capture again.', approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=TEST' }),
  }))
  await page.getByRole('button', { name: /Settle \$150\.00/ }).click()
  await expect(page.locator('.still-waiting')).toContainText('nothing was captured and $0 moved')
  await expect(page.locator('.still-waiting')).toContainText('Checked PayPal at')
  await expect(page.getByRole('button', { name: 'Check PayPal and settle' })).toBeEnabled()
  await expect(page.getByRole('link', { name: 'Open PayPal ↗' })).toBeVisible()
  await shots(page, '16-buyer-pending')
})

test('a proposer key can ask but never approve', async ({ page }) => {
  await unlock(page, PROPOSER)
  await expect(page.getByText('Proposer · can ask, not approve')).toBeVisible()
  const answer = await ask(page, async () => {
    await page.getByText('Money in').click()
    await amount(page, '150')
    await page.getByLabel('What it is for').fill('Agent-drafted invoice')
    await page.getByLabel('Link to the work').fill('https://www.figma.com/file/northwind-logo')
    await page.getByLabel('Job').fill('job_agent_draft')
  })
  await expect(answer.getByText('Needs you')).toBeVisible()
  await page.goto('/app/')
  const card = page.locator('.approval').filter({ hasText: 'Agent-drafted invoice' })
  await expect(card.getByRole('button', { name: /Approve/ })).toBeDisabled()
  await expect(card).toContainText('Only the owner key can approve')
  await shots(page, '15-proposer')
})

test('offline is read-only', async ({ page, context }) => {
  await unlock(page, OWNER)
  await page.goto('/app/new')
  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(page.getByText('Nothing that moves money can be sent')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ask the rules' })).toBeDisabled()
  await context.setOffline(false)
})

test('installs as an app: manifest, icons, and a service worker scoped to /app/', async ({ page, request }) => {
  const manifest = await (await request.get('/app/manifest.webmanifest')).json()
  expect(manifest).toMatchObject({ start_url: '/app/', scope: '/app/', display: 'standalone' })
  for (const icon of manifest.icons as Array<{ src: string }>) {
    expect((await request.get(`/app/${icon.src}`)).status()).toBe(200)
  }
  await page.goto('/app/unlock')
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(scope).toMatch(/\/app\/$/)
  const apiCached = await page.evaluate(async () => {
    const names = await caches.keys()
    for (const name of names) {
      const keys = await (await caches.open(name)).keys()
      if (keys.some((entry) => new URL(entry.url).pathname.startsWith('/v1/'))) return true
    }
    return false
  })
  expect(apiCached).toBe(false)
})

test('every signed-in screen passes axe (WCAG 2.1 AA)', async ({ page }) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  await unlock(page, OWNER)
  for (const path of ['/app/', '/app/new', '/app/jobs', '/app/ledger', '/app/rules', '/app/system']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).exclude('.ag-root-wrapper').analyze()
    expect(results.violations.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
  }
})
