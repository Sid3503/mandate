import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const OWNER = 'owner-e2e-key-0123456789'
const PROPOSER = 'proposer-e2e-key-0123456789'
const shots = (page: Page, name: string) => page.screenshot({ path: `e2e/shots/${test.info().project.name}-${name}.png`, fullPage: true, animations: 'disabled' })

async function unlock(page: Page, key: string) {
  await page.goto('/app/unlock')
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

// The welcome tour opens by itself on a first visit and would cover the page, so every test starts as a returning visitor.
// Tests tagged @tour start as a first-time visitor instead.
test.beforeEach(async ({ page }) => {
  if (test.info().title.includes('@tour')) return
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
})

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
  await payout.getByRole('link', { name: 'Send the payout →' }).click()

  // Money out goes through PayPal Payouts, straight to Priya. Nothing here opens an Orders checkout.
  const status = page.locator('.payout-status')
  await expect(status).toContainText('Send exactly $90.00 to Priya Shah')
  await expect(status).toContainText('Ready to send')
  await expect(page.getByRole('link', { name: 'Open PayPal ↗' })).toHaveCount(0)
  await expect(page.locator('.match-flag')).toHaveText('not paid')
  await shots(page, '07-payout-ready')

  // A retry at $250 is refused: the lock is $90.
  await page.getByText('Integrity check · try to change the amount').click()
  await page.getByLabel('Claimed amount').fill('250')
  await page.getByRole('button', { name: 'Send claim' }).click()
  await expect(page.locator('.refused-claim')).toContainText('cart.immutable')
  await expect(page.locator('.refused-claim')).toContainText('$0 moved')
  await shots(page, '08-receipt-refused-claim')

  // Send it. PayPal confirms, and only then does the page say paid.
  await page.getByRole('button', { name: /Send \$90\.00 to Priya Shah/ }).click()
  await expect(status).toContainText('reached Priya Shah’s PayPal account')
  await expect(status.locator('.chip').first()).toHaveText('Paid')
  await expect(page.locator('.match-flag')).toHaveText('cents match ✓')
  await expect(page.getByText('Payout batch')).toBeVisible()
  await expect(page.getByRole('button', { name: /Send \$90|Check PayPal/ })).toHaveCount(0)
  await shots(page, '07b-payout-paid')

  // The job: $150 in, $90 out, $60 kept.
  await page.goto(`/app/jobs/${job}`)
  await expect(page.locator('.total-in')).toContainText('$150.00')
  await expect(page.locator('.total-out')).toContainText('$90.00')
  await expect(page.locator('.total-kept')).toContainText('$60.00')
  await expect(page.locator('.payouts')).toContainText('Paid')
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

/** The frozen job's $180 monthly cap would stop a third $90 payout, so these extra payouts run under a wider cap. */
async function widerCap(request: APIRequestContext) {
  const headers = { authorization: `Bearer ${OWNER}` }
  const current = await (await request.get('/v1/warrant', { headers })).json()
  if (current.monthlyCapCents >= 90_000) return
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  await request.put('/v1/warrant', { headers, data: { ...body, monthlyCapCents: 90_000 } })
}

/** Money in and out through the API, so the payout tests can spend their time on the receipt screen. */
async function fundedPayout(request: APIRequestContext, job: string) {
  await widerCap(request)
  const headers = { authorization: `Bearer ${OWNER}` }
  const post = async (path: string, data?: unknown, key?: string) =>
    (await request.post(path, { headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) }, data })).json()
  const charge = await post('/v1/proposals', { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: `Invoice ${job}`, evidenceUrl: 'https://www.figma.com/file/northwind-logo', jobId: job }, `charge-${job}-0001`)
  await post(`/v1/proposals/${charge.id}/approve`)
  const captured = await post(`/v1/proposals/${charge.id}/capture`)
  const payout = await post('/v1/proposals', { payee: 'Priya', amountCents: 9000, currency: 'USD', category: 'design', description: `Share ${job}`, evidenceUrl: 'https://www.figma.com/file/northwind-logo', prompt: 'Pay Priya her $90 share', jobId: job, fundingCaptureId: captured.captureId }, `payout-${job}-0001`)
  await post(`/v1/proposals/${payout.id}/approve`)
  return payout.id as string
}

async function fake(request: APIRequestContext, outcome: string) {
  await request.post(`/__fake/payouts/${outcome}`, { headers: { authorization: `Bearer ${OWNER}` } })
}

test('a payout PayPal is still processing is not called paid until PayPal says so', async ({ page, request }) => {
  await fake(request, 'PENDING')
  const id = await fundedPayout(request, `job_slow_${test.info().project.name}`)
  await unlock(page, OWNER)
  await page.goto(`/app/p/${id}`)
  await page.getByRole('button', { name: /Send \$90\.00 to Priya Shah/ }).click()
  const status = page.locator('.payout-status')
  await expect(status.locator('.chip').first()).toHaveText('Sent · PayPal processing')
  await expect(status).toContainText('It is not paid until PayPal says so')
  await expect(page.locator('.match-flag')).toHaveText('not paid')
  await expect(status.locator('.still-waiting')).toContainText('PayPal says PENDING')
  await shots(page, '17-payout-processing')
  await page.goto(`/app/jobs/job_slow_${test.info().project.name}`)
  await expect(page.locator('.total-out')).toContainText('$0.00')
  await expect(page.locator('.totals')).toContainText('Approved · not yet paid')

  await fake(request, 'settle')
  await page.goto(`/app/p/${id}`)
  await page.getByRole('button', { name: 'Check PayPal' }).click()
  await expect(status.locator('.chip').first()).toHaveText('Paid')
  await expect(page.locator('.match-flag')).toHaveText('cents match ✓')
  await fake(request, 'SUCCESS')
})

test('a receiver PayPal cannot find is unclaimed, and a failed payout is released', async ({ page, request }) => {
  await fake(request, 'unregistered')
  const unclaimed = await fundedPayout(request, `job_unclaimed_${test.info().project.name}`)
  await unlock(page, OWNER)
  await page.goto(`/app/p/${unclaimed}`)
  await page.getByRole('button', { name: /Send \$90\.00 to Priya Shah/ }).click()
  const status = page.locator('.payout-status')
  await expect(status.locator('.chip').first()).toHaveText('Sent · unclaimed')
  await expect(status).toContainText('Mandate does not count it as paid')
  await shots(page, '18-payout-unclaimed')
  await fake(request, 'registered')

  await fake(request, 'FAILED')
  const failed = await fundedPayout(request, `job_failed_${test.info().project.name}`)
  await page.goto(`/app/p/${failed}`)
  await page.getByRole('button', { name: /Send \$90\.00 to Priya Shah/ }).click()
  await expect(status.locator('.chip').first()).toHaveText('Payout failed')
  await expect(status).toContainText('PayPal did not pay Priya Shah')
  await shots(page, '19-payout-failed')
  await fake(request, 'SUCCESS')
})

test('an owner can cancel a locked payout before it is sent', async ({ page, request }) => {
  const id = await fundedPayout(request, `job_cancel_${test.info().project.name}`)
  await unlock(page, OWNER)
  await page.goto(`/app/p/${id}`)
  await page.getByRole('button', { name: 'Cancel this payout' }).click()
  await expect(page.locator('.page-head .chip').first()).toHaveText('Rejected')
  await expect(page.locator('.payout-status')).toHaveCount(0)
})

test('a first-time visitor is walked through the console, and it stays out of the way afterwards @tour', async ({ page }) => {
  await page.goto('/app/')
  await expect(page).toHaveURL(/\/app\/welcome/)
  await page.getByRole('link', { name: 'Unlock' }).first().click()
  await page.getByLabel('API key').fill(OWNER)
  await page.getByRole('button', { name: 'Unlock console' }).click()
  const tour = page.getByRole('dialog')
  await expect(tour).toContainText('Welcome to Mandate')
  await expect(tour).toContainText(/Step 1 of \d+/)
  await shots(page, '20-tour-welcome')

  await page.keyboard.press('ArrowRight')
  await expect(tour).toContainText('How one payment moves')
  await page.keyboard.press('ArrowRight')
  await expect(tour).toContainText('Waiting for you')
  await expect(page.locator('.tour-spot')).toBeVisible()
  await shots(page, '21-tour-spotlight')

  await page.keyboard.press('ArrowLeft')
  await expect(tour).toContainText('How one payment moves')
  await page.keyboard.press('Escape')
  await expect(tour).toHaveCount(0)

  // Leaving once is remembered: a reload does not bring it back.
  await page.reload()
  await expect(page.getByRole('heading', { name: /Waiting for you/ })).toBeVisible()
  await page.waitForTimeout(1200)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // It can always be reopened, from the Guide button or the full tour.
  await page.getByRole('button', { name: /Guide/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Waiting for you')
  await page.keyboard.press('Escape')
})

test('every screen has a guide that walks to its last step', async ({ page }) => {
  await unlock(page, OWNER)
  const screens = ['/app/', '/app/new', '/app/jobs', '/app/deals', '/app/clerk', '/app/ledger', '/app/rules', '/app/system']
  for (const path of screens) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: /Guide/ }).click()
    const tour = page.getByRole('dialog')
    await expect(tour).toBeVisible()
    const total = Number(/of (\d+)/i.exec((await tour.locator('.tour-count').textContent()) ?? '')?.[1])
    expect(total).toBeGreaterThan(1)
    for (let step = 1; step < total; step++) {
      await tour.getByRole('button', { name: 'Next' }).click()
      await expect(tour.locator('.tour-count')).toHaveText(`Step ${step + 1} of ${total}`)
      // A step that points at something must have found it: no card stranded in the middle of the page.
      const title = await tour.locator('.tour-title').innerText()
      if (!/payment moves|Welcome/i.test(title)) {
        await expect(page.locator('.tour-spot'), `${path}: ${title}`).toBeVisible()
        await expect(page.locator('.tour-spot'), `${path}: ${title} is faded out`).toHaveCSS('opacity', '1')
      }
    }
    if (path === '/app/new') await shots(page, '22-tour-new-request')
    if (path === '/app/') await shots(page, '23-tour-inbox')
    await tour.getByRole('button', { name: 'Done' }).click()
    await expect(tour).toHaveCount(0)
  }
})

test('a receipt has a guide, and the open tour passes axe', async ({ page, request }) => {
  const asked = await (await request.post('/v1/proposals', {
    headers: { authorization: `Bearer ${OWNER}`, 'idempotency-key': `tour-receipt-${test.info().project.name}-0001` },
    data: { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: 'Tour receipt', evidenceUrl: 'https://www.figma.com/file/northwind-logo', jobId: 'job_tour_receipt' },
  })).json()
  await unlock(page, OWNER)
  await page.goto(`/app/p/${asked.id}`)
  await page.getByRole('button', { name: /Guide/ }).click()
  const tour = page.getByRole('dialog')
  await expect(tour).toContainText('The decision')
  await shots(page, '24-tour-receipt')
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
})

test('two agents negotiate a deal, it is signed, and billing a milestone follows it', async ({ page }) => {
  await unlock(page, OWNER)
  await page.goto('/app/deals')
  await expect(page.getByText('Where a deal can exist')).toBeVisible()
  await page.getByRole('button', { name: 'Let the agents negotiate' }).click()
  const story = page.locator('.stage')
  // The screen comes alive at once: a running state, the studio's agent thinking, a Stop button.
  await expect(story).toContainText('Live negotiation')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(story.locator('.seat-seller')).toContainText('Thinking')
  await expect(story.locator('.turn.is-thinking')).toBeVisible()
  await shots(page, '25a-negotiation-thinking')
  // Then offers arrive one at a time, and pins land on the price line.
  await expect(story.locator('.turn.is-in')).toHaveCount(1, { timeout: 30_000 })
  await expect(story.locator('.seat-buyer')).toContainText('Thinking', { timeout: 1500 })
  await shots(page, '25b-negotiation-midway')
  await expect(story).toContainText('The negotiation, turn by turn', { timeout: 30_000 })
  const turns = story.locator('.turn.is-in')
  await expect(turns).toHaveCount(3)
  await expect(story.locator('.pin')).toHaveCount(3)
  await expect(turns.nth(0)).toContainText('$450.00')
  await expect(turns.nth(0)).toContainText('deal.over_buyer_limit')
  await expect(turns.nth(1)).toContainText('$200.00')
  await expect(turns.nth(1)).toContainText('deal.under_seller_minimum')
  await expect(turns.nth(2)).toContainText('$300.00')
  await expect(turns.nth(2)).toContainText('Agreed')
  await expect(story).toContainText('Agreed in 3 offers')
  // The client agent never saw the studio's floor, so nothing it said can contain it.
  await expect(story.locator('.turn-buyer')).not.toContainText('$250')
  await shots(page, '25-deal-negotiated')

  const card = page.locator('.deal-card.is-agreed')
  await expect(card).toContainText('Spring launch logo')
  await card.getByRole('button', { name: 'Verify' }).click()
  await expect(card.locator('.sig-result')).toContainText('Valid')

  await card.getByLabel('Link to the work for the next milestone').fill('https://www.figma.com/file/northwind-logo')
  await card.getByRole('button', { name: /Bill milestone 1/ }).click()
  await expect(page).toHaveURL(/\/app\/p\//)
  await expect(page.locator('.page-head')).toContainText('$150.00')
  // Until the owner taps there is no lock, so there is nothing to sign.
  await expect(page.locator('.panel-ink')).toContainText('no lock yet')
  await page.goto('/app/')
  const approval = page.locator('.approval').filter({ hasText: 'Bill Northwind' }).first()
  await approval.getByRole('button', { name: /Approve \$150\.00/ }).click()
  await approval.getByRole('link', { name: 'Settle →' }).click()
  await expect(page.locator('.panel-ink')).toContainText('Server signature')
  await page.locator('.panel-ink').getByRole('button', { name: 'Verify' }).click()
  await expect(page.locator('.panel-ink .sig-result')).toContainText('Valid')
  await shots(page, '26-lock-verified')

  // Billing it twice, or billing anything else on this job, is refused by the gate.
  await page.goto('/app/deals')
  await expect(page.locator('.milestones').first()).toContainText('not billed')
})

test('pressing Stop ends a running negotiation and keeps what was offered', async ({ page }) => {
  await unlock(page, OWNER)
  await page.goto('/app/deals')
  await page.getByRole('button', { name: 'Let the agents negotiate' }).click()
  await expect(page.locator('.stage .turn.is-in')).toHaveCount(1, { timeout: 30_000 })
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.stage')).toContainText('Stopped')
  await expect(page.getByRole('button', { name: 'Let the agents negotiate' })).toBeEnabled()
  await shots(page, '25c-negotiation-stopped')
})

test('the clerk asks the rules; a fooled clerk changes nothing', async ({ page, request }) => {
  await unlock(page, OWNER)
  await page.goto('/app/clerk')
  await page.getByRole('button', { name: /FW: urgent, updated payout details/ }).click()
  const bubble = page.locator('.bubble.clerk').last()
  await expect(bubble).toContainText('not on the rules', { timeout: 30_000 })
  await expect(bubble).toContainText('payee.unknown')
  await expect(bubble).toContainText('$0 moved')
  await expect(bubble.locator('.chip').first()).toHaveText('Refused')
  await shots(page, '27-clerk-refused')
  await bubble.getByRole('link', { name: 'Open receipt →' }).click()
  await expect(page.locator('.agent-trace')).toContainText('Studio clerk')
  await page.getByRole('button', { name: 'Show every step the agent took' }).click()
  await expect(page.locator('.trace')).toContainText('propose')
  await shots(page, '28-agent-trace')
  const ledger = await (await request.get('/v1/proposals', { headers: { authorization: `Bearer ${OWNER}` } })).json()
  expect(ledger.data.some((row: { payeeId: string | null; phase: string }) => row.payeeId === null && row.phase === 'denied')).toBe(true)
})

test('a client charge can be billed as a PayPal invoice and settles only when PayPal says it was paid', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${OWNER}` }
  await request.post('/__fake/payouts/invoices-on', { headers })
  const job = `job_invoice_${test.info().project.name}`
  const asked = await (await request.post('/v1/proposals', {
    headers: { ...headers, 'idempotency-key': `invoice-${job}-0001` },
    data: { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: 'Invoice milestone', evidenceUrl: 'https://www.figma.com/file/northwind-logo', jobId: job },
  })).json()
  await request.post(`/v1/proposals/${asked.id}/approve`, { headers })
  await unlock(page, OWNER)
  await page.goto(`/app/p/${asked.id}`)
  await page.getByRole('button', { name: /Settle \$150\.00/ }).click()
  const panel = page.locator('[data-tour="receipt-action"]')
  await expect(panel).toContainText('PayPal sent Northwind an invoice for $150.00')
  await expect(page.locator('.page-head .chip').first()).toHaveText('Invoice sent · waiting for the client')
  await shots(page, '29-invoice-sent')
  await panel.getByRole('button', { name: 'Check PayPal' }).click()
  await expect(panel.locator('.still-waiting')).toContainText('$0 moved')
  await request.post('/__fake/payouts/invoices-pay', { headers })
  await panel.getByRole('button', { name: 'Check PayPal' }).click()
  await expect(page.locator('.match-flag')).toHaveText('cents match ✓')
  await expect(page.getByText('Invoice is')).toBeVisible()
  await request.post('/__fake/payouts/invoices-off', { headers })
})

test('a visitor with no key sees what Mandate is first, and can reach the unlock', async ({ page }) => {
  await page.goto('/app/')
  await expect(page).toHaveURL(/\/app\/welcome/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Agents can ask.')
  await expect(page.getByRole('heading', { level: 2, name: /Ask\. Check\. Tap\. Pay\. Prove\./ })).toBeVisible()
  await expect(page.locator('.land-table tbody tr')).toHaveCount(6)
  await expect(page.locator('.land-tools li')).toHaveCount(7)
  await shots(page, '30-landing')
  // Deep links to the console still ask for a key rather than showing the landing page.
  await page.goto('/app/jobs')
  await expect(page).toHaveURL(/\/app\/unlock/)
  await expect(page.getByRole('link', { name: /What is Mandate/ })).toBeVisible()
  await page.getByRole('link', { name: /What is Mandate/ }).click()
  await expect(page).toHaveURL(/\/app\/welcome/)
  await page.getByRole('link', { name: 'Open the console' }).first().click()
  await expect(page).toHaveURL(/\/app\/unlock/)
  // Once unlocked, the same button goes straight into the console.
  await page.getByLabel('API key').fill(OWNER)
  await page.getByRole('button', { name: 'Unlock console' }).click()
  await expect(page.getByRole('heading', { name: /Waiting for you/ })).toBeVisible()
  await page.goto('/app/welcome')
  await page.getByRole('link', { name: 'Open the console' }).first().click()
  await expect(page).toHaveURL(/\/app\/?$/)
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
  await page.goto('/app/welcome')
  await page.waitForLoadState('networkidle')
  await page.locator('.land').evaluate((el) => el.scrollIntoView())
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)) } window.scrollTo(0, 0) })
  await page.waitForTimeout(1600) // let every entrance finish: axe measures what is on screen right now
  const landing = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(landing.violations.map((v) => `/app/welcome ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
  await unlock(page, OWNER)
  for (const path of ['/app/', '/app/new', '/app/jobs', '/app/deals', '/app/clerk', '/app/ledger', '/app/rules', '/app/system']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).exclude('.ag-root-wrapper').analyze()
    expect(results.violations.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
  }
})
