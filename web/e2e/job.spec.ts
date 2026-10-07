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
  await expect(answer).toContainText('No client payment has money left to fund this payout')
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
  await status.getByRole('button', { name: 'Cancel and return the money' }).click()
  await expect(status.locator('.chip').first()).toHaveText('Payout failed')
  await expect(page.getByText('Unclaimed payout cancelled · money returned')).toBeVisible()
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

test('the PayPal features panel says what is on, what is off, and how to turn it on', async ({ page, request }) => {
  await fake(request, 'scopes-limited')
  await unlock(page, OWNER)
  await page.goto('/app/system')
  const panel = page.locator('[data-tour="system-features"]')
  const invoicing = panel.locator('.features li').filter({ has: page.getByText('Invoicing', { exact: true }) })
  await expect(invoicing.locator('.chip')).toHaveText('Off')
  await expect(panel.locator('.features li').filter({ has: page.getByText('Payouts', { exact: true }) }).locator('.chip')).toHaveText('On')
  await invoicing.getByText('How to turn it on').click()
  await expect(invoicing).toContainText('tick Invoicing')
  await shots(page, '31-paypal-features')
  await fake(request, 'scopes-full')
  await panel.getByRole('button', { name: 'Check again' }).first().click()
  await expect(invoicing.locator('.chip')).toHaveText('On')
  await panel.getByRole('button', { name: 'Check for disputes now' }).click()
  await expect(page.getByText('No open disputes')).toBeVisible()
})

test('PayPal sends the buyer back to the receipt, which settles by itself', async ({ page, request }) => {
  await fake(request, 'buyer-manual')
  const headers = { authorization: `Bearer ${OWNER}` }
  const job = `job_return_${test.info().project.name}`
  const asked = await (await request.post('/v1/proposals', {
    headers: { ...headers, 'idempotency-key': `return-${job}-0001` },
    data: { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: 'Return milestone', evidenceUrl: 'https://www.figma.com/file/northwind-logo', jobId: job },
  })).json()
  await request.post(`/v1/proposals/${asked.id}/approve`, { headers })
  await unlock(page, OWNER)
  await page.goto(`/app/p/${asked.id}`)
  await page.getByRole('button', { name: /Settle \$150\.00/ }).click()
  await expect(page.locator('.buyer')).toContainText('the PayPal buyer approves')
  // The buyer approves on PayPal, and PayPal sends them back here.
  await fake(request, 'buyer-approve')
  await page.goto(`/app/p/${asked.id}?paypal=return`)
  await expect(page.locator('.match-flag')).toHaveText('cents match ✓')
  await expect(page).not.toHaveURL(/paypal=return/)
  await fake(request, 'buyer-auto')
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
  await expect(tour).toContainText('Today')
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
  await expect(page.getByRole('dialog')).toContainText('Today')
  await page.keyboard.press('Escape')
})

/** The signed-in console keeps a live connection open, so the network never goes idle. Settled means loaded and no loading placeholder left. */
async function settled(page: import('@playwright/test').Page) {
  await page.waitForLoadState('load')
  await expect(page.locator('.loading')).toHaveCount(0, { timeout: 15_000 })
}

test('every screen has a guide that walks to its last step', async ({ page }) => {
  await unlock(page, OWNER)
  const screens = ['/app/', '/app/new', '/app/jobs', '/app/deals', '/app/clerk', '/app/ledger', ...(test.info().project.name === 'desktop' ? ['/app/control-room'] : []), '/app/rules', '/app/proof', '/app/system']
  for (const path of screens) {
    await page.goto(path)
    await settled(page)
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

  await card.getByLabel('Link to the delivered work for the next milestone').fill('https://www.figma.com/file/northwind-logo')
  await card.getByRole('button', { name: /Deliver milestone 1/ }).click()
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
  await expect(bubble.locator('.result-card .chip').first()).toHaveText('Refused')
  // The slip shows the work: which tool, what it was given, the rules' one-line answer.
  await expect(bubble.locator('.tooltrail')).toContainText('Filed the request with the rules')
  await expect(bubble.locator('.tooltrail .tt-answer')).toContainText('Refused · payee.unknown')
  await bubble.locator('.tt-raw summary').first().click()
  await expect(bubble.locator('.tt-raw pre').first()).toBeVisible()
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

test('the system page shows the AI layer: which models, which prompt versions, and how they are doing', async ({ page }) => {
  await unlock(page, OWNER)
  await page.goto('/app/system')
  const panel = page.getByRole('region', { name: 'The AI layer' })
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Prompt versions')
  await expect(panel).toContainText('clerk v1')
  await expect(panel).toContainText('reviewer v2')
})

test('a screen that crashes becomes a card with a reference, is reported, and the rest of the console still works', async ({ page, request }) => {
  await unlock(page, OWNER)
  // The server answers with something the screen cannot draw: it must not become a blank page.
  await page.route('**/v1/today', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ unexpected: true }) }))
  await page.goto('/app/')
  const card = page.getByTestId('error-boundary')
  await expect(card).toContainText('Something went wrong here')
  await expect(card).toContainText('Nothing on it sent anything to PayPal')
  await expect(card).toContainText('Reference')
  await shots(page, '41-screen-crashed')
  // The navigation is still there, and another screen works.
  await page.unroute('**/v1/today')
  await page.getByRole('link', { name: 'Jobs' }).first().click()
  await expect(page.getByRole('heading', { name: /Jobs/ }).first()).toBeVisible()
  // The crash was reported, and the owner can see it.
  await expect.poll(async () => JSON.stringify(await (await request.get('/v1/client-errors', { headers: { authorization: `Bearer ${OWNER}` } })).json())).toContain('screen:')
})

test('when PayPal is not answering, every screen says so and says what is safe', async ({ page }) => {
  await unlock(page, OWNER)
  await page.route('**/v1/status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ time: new Date().toISOString(), degraded: ['paypal'], paypal: { circuit: 'open', consecutiveFailures: 5, lastError: '503 SERVICE_UNAVAILABLE', lastOkAt: null, openUntil: null }, ai: { enabled: true, primary: 'x', fallback: null, circuit: 'closed' } }) }))
  await page.goto('/app/jobs')
  const banner = page.getByTestId('degraded')
  await expect(banner).toContainText('PayPal is not answering')
  await expect(banner).toContainText('keep their place')
  await page.getByRole('link', { name: 'Ledger' }).first().click()
  await expect(page.getByTestId('degraded')).toBeVisible()
})

test('a server that answers with a page of HTML, or not at all, is described instead of crashing the screen', async ({ page }) => {
  await unlock(page, OWNER)
  await page.route('**/v1/proposals?**', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body><h1>Bad gateway</h1></body></html>' }))
  await page.goto('/app/ledger')
  await expect(page.getByRole('alert').filter({ hasText: 'server.error' }).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('error-boundary')).toHaveCount(0)
})

test('the owner can stop everything with one button; agents are refused with the reason; resuming brings it back', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${OWNER}` }
  await unlock(page, OWNER)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Pause Mandate' })
  await expect(dialog).toContainText('cannot be called back')
  await dialog.getByLabel('Why (optional)').fill('Odd requests on Friday')
  await dialog.getByRole('button', { name: 'Pause everything' }).click()

  const banner = page.getByTestId('paused-banner')
  await expect(banner).toContainText('Mandate is paused')
  await expect(banner).toContainText('Odd requests on Friday')
  await shots(page, '42-paused')
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)

  // While paused the studio's key is refused, whatever it asks, and the reason is on the receipt.
  const refused = await (await request.post('/v1/proposals', {
    headers: { authorization: 'Bearer proposer-e2e-key-0123456789', 'idempotency-key': `paused-${test.info().project.name}-0001-aaaa` },
    data: { kind: 'payment', payee: 'Priya', amountCents: 1000, currency: 'USD', category: 'design', description: 'While paused', evidenceUrl: 'https://www.figma.com/file/x' },
  })).json()
  expect(['system.paused', 'funding.missing']).toContain(refused.clause)

  // The System page shows the history, signed.
  await page.goto('/app/system')
  await expect(page.getByTestId('safety-panel')).toContainText('Paused · Odd requests on Friday')
  await expect(page.getByTestId('safety-panel')).toContainText('signed ✓')

  await page.getByTestId('paused-banner').getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByTestId('paused-banner')).toHaveCount(0)
  await expect(page.locator('.toast', { hasText: 'running again' }).first()).toBeVisible()
  const state = await (await request.get('/v1/safety', { headers })).json()
  expect(state.paused).toBe(false)
  // Proof checks that nothing ran on its own meanwhile.
  await page.goto('/app/proof')
  await expect(page.locator('.check-row', { hasText: 'Nothing ran on its own while Mandate was paused' })).toContainText('Pass')
})

test('the Proof page lists what Mandate promises, with the live check or the tests behind each', async ({ page }) => {
  await unlock(page, OWNER)
  await page.goto('/app/proof')
  const promises = page.getByTestId('promises')
  await expect(promises).toContainText('No payout is ever larger than the contractor', { timeout: 20_000 })
  await expect(promises).toContainText('3,000 months')
  await expect(promises.locator('.chip', { hasText: 'Pass now' }).first()).toBeVisible()
  await expect(promises.locator('.chip', { hasText: 'Random months' }).first()).toBeVisible()
})

test('the owner can try a request and check the rules with cases, under the live rules and under a draft, and nothing is filed', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${OWNER}` }
  await unlock(page, OWNER)
  await page.goto('/app/rules')
  const before = (await (await request.get('/v1/proposals', { headers })).json()).data.length
  await page.getByText('Try a request, or check the rules with cases').click()
  const panel = page.getByTestId('try-rules').first()
  await expect(panel).toContainText('Cases made from the rules')
  await expect(panel.locator('table.try-cases')).toContainText('Someone who is not on the rules', { timeout: 20_000 })
  await expect(panel.locator('table.try-cases')).toContainText('payee.unknown')
  await panel.locator('.try-form select').first().selectOption('A. Stranger')
  await panel.getByRole('button', { name: 'Try it' }).click()
  const result = panel.getByTestId('try-result')
  await expect(result).toContainText('payee.unknown')
  await expect(result).toContainText('Nothing was filed and PayPal was not called')
  await shots(page, '43-try-it')
  expect((await (await request.get('/v1/proposals', { headers })).json()).data.length).toBe(before)

  // With a draft open, the cases show the live rules and the draft side by side.
  await page.getByLabel('Describe the change you want to the rules').fill('Lower the monthly cap to $120.')
  await page.getByRole('button', { name: 'Draft it' }).click()
  await page.getByRole('button', { name: 'Review this draft' }).click()
  await page.getByRole('button', { name: 'Review changes' }).click()
  const draftPanel = page.locator('.editor').getByTestId('try-rules')
  await expect(draftPanel).toContainText('This draft')
  await expect(draftPanel.locator('table.try-cases')).toContainText('Live rules')
})

test('the ledger can be exported as CSV, and points to the control room', async ({ page }) => {
  await unlock(page, OWNER)
  await page.goto('/app/ledger')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  expect((await download).suggestedFilename()).toBe('mandate-ledger.csv')
  await expect(page.locator('.toast', { hasText: 'Ledger exported' })).toBeVisible()
  if (test.info().project.name === 'desktop') {
    await page.getByRole('link', { name: /Open in the control room/ }).click()
    await expect(page).toHaveURL(/\/app\/control-room/)
  }
})

test('the control room shows the ledger in AG Studio, follows it live, keeps a saved layout, and reaches nothing outside Mandate', async ({ page, request }) => {
  if (test.info().project.name === 'phone') {
    // A dashboard needs room: on a phone the screen says so and points at the Ledger.
    await unlock(page, OWNER)
    await page.goto('/app/control-room')
    await expect(page.getByRole('status').filter({ hasText: 'desktop screen' })).toBeVisible()
    return
  }
  const headers = { authorization: `Bearer ${OWNER}` }
  const tag = test.info().project.name
  const refuse = (n: number, description: string, payee: string) => request.post('/v1/proposals', {
    headers: { ...headers, 'idempotency-key': `cr-${tag}-${n}-aaaaaaaa` },
    data: { kind: 'payment', payee, amountCents: 1800, currency: 'USD', category: 'design', description, evidenceUrl: 'https://www.figma.com/file/x', prompt: 'x' },
  })
  await refuse(1, 'Control room first refusal', 'Nobody Known')
  const outside: string[] = []
  page.on('request', (r) => { const url = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol.startsWith('http')) outside.push(r.url()) })

  await unlock(page, OWNER)
  await page.getByRole('link', { name: 'Control room' }).first().click()
  const room = page.getByTestId('control-room')
  await expect(room).toContainText('MONEY IN · CONFIRMED', { timeout: 30_000 })
  await expect(room).toContainText('WHAT THE RULES REFUSED', { timeout: 30_000 })
  await expect(room).toContainText('Control room first refusal', { timeout: 30_000 })
  // Every widget finishes loading, and none is left on a visible spinner (Studio keeps a hidden status label, so read what is shown).
  await expect.poll(async () => (await room.innerText()).includes('Loading...'), { timeout: 30_000 }).toBe(false)
  await shots(page, '40-control-room')

  // A new refusal appears on the dashboard without a reload.
  await refuse(2, 'Control room live refusal', 'Nobody Known')
  await expect(room).toContainText('Control room live refusal', { timeout: 30_000 })

  // The dashboard agent answers in the chat panel through Mandate's own route.
  const turn = page.waitForResponse((r) => r.url().includes('/v1/studio/turn') && r.status() === 200)
  await page.getByRole('textbox', { name: 'Message input' }).fill('hello')
  await page.getByRole('button', { name: 'Send message' }).click()
  await turn
  await expect(room).toContainText('Tell me what to pay', { timeout: 30_000 })

  // A saved layout survives a reload, and Reset goes back to the demo layout.
  await page.getByRole('button', { name: 'Save layout' }).click()
  await expect(page.locator('.toast', { hasText: 'Layout saved' })).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('control-room')).toContainText('WHAT THE RULES REFUSED', { timeout: 30_000 })
  const reset = page.getByRole('button', { name: 'Reset to demo' })
  await expect(reset).toBeEnabled()
  await reset.click()
  await expect(reset).toBeDisabled()

  // Studio never reached anything but this server: no PayPal, no AG Grid, no font or analytics host.
  expect(outside).toEqual([])
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
  for (const path of ['/app/', '/app/new', '/app/jobs', '/app/deals', '/app/clerk', '/app/ledger', '/app/rules', '/app/proof', '/app/system']) {
    await page.goto(path)
    await settled(page)
    await page.waitForTimeout(1000)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).exclude('.ag-root-wrapper').analyze()
    expect(results.violations.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
  }
})

// Last on purpose: a published standing rule changes how every later payout is decided.
test('the owner signs a standing rule once, and the payout it covers is sent with no tap', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${OWNER}` }
  await widerCap(request)
  const job = `job_standing_${test.info().project.name}`
  const post = async (path: string, data?: unknown, key?: string, as = OWNER) =>
    (await request.post(path, { headers: { authorization: `Bearer ${as}`, ...(key ? { 'idempotency-key': key } : {}) }, data })).json()
  const charge = await post('/v1/proposals', { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: `Invoice ${job}`, evidenceUrl: 'https://www.figma.com/file/northwind-logo', jobId: job }, `charge-${job}-0001`)
  await post(`/v1/proposals/${charge.id}/approve`)
  const paid = await post(`/v1/proposals/${charge.id}/capture`)

  // Before the rule: the same ask waits for a tap.
  const before = await post('/v1/proposals', { payee: 'Priya', amountCents: 9000, currency: 'USD', category: 'design', description: `Share ${job}`, evidenceUrl: 'https://www.figma.com/file/northwind-logo', jobId: job, fundingCaptureId: paid.captureId }, `before-${job}-0001`, PROPOSER)
  expect(before).toMatchObject({ gate: 'NEEDS_APPROVAL', phase: 'pending_approval' })
  await post(`/v1/proposals/${before.id}/reject`)

  await unlock(page, OWNER)
  await page.goto('/app/rules')
  await page.getByRole('button', { name: /Write version/ }).click()
  const standing = page.locator('fieldset.standing')
  await standing.getByRole('button', { name: '+ Add a standing rule' }).click()
  await standing.getByLabel('Only money that came through a signed deal').uncheck()
  await shots(page, '32-standing-rule-editor')
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.editor').analyze()
  expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
  await page.getByRole('button', { name: 'Review changes' }).click()
  await expect(page.locator('.editor table.diff')).toContainText('Standing rules (no tap)')
  await expect(page.locator('.editor table.diff')).toContainText('Priya Shah from Northwind')
  await page.getByRole('button', { name: /Publish version/ }).click()
  await expect(page.getByText(/Standing rule: Priya Shah is paid, with no tap/)).toBeVisible()

  // After the rule: an agent's ask is sent by the server, and PayPal's answer is on the receipt.
  const after = await post('/v1/proposals', { payee: 'Priya', amountCents: 9000, currency: 'USD', category: 'design', description: `Share ${job} again`, evidenceUrl: 'https://www.figma.com/file/northwind-logo', jobId: job, fundingCaptureId: paid.captureId }, `after-${job}-0001`, PROPOSER)
  expect(after).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', phase: 'captured', capturedAmountCents: 9000 })
  await page.goto(`/app/p/${after.id}`)
  await expect(page.locator('.page-head .chip').first()).toHaveText('Paid')
  await expect(page.locator('.decision-words')).toContainText('standing rule you signed')
  await expect(page.locator('.match-flag')).toHaveText('cents match ✓')
  await shots(page, '33-standing-paid')

  // Put the rules back for anything that runs after.
  const current = await (await request.get('/v1/warrant', { headers })).json()
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  await request.put('/v1/warrant', { headers, data: { ...body, standing: [] } })
})


async function publishRules(request: APIRequestContext, patch: Record<string, unknown>) {
  const headers = { authorization: `Bearer ${OWNER}` }
  const current = await (await request.get('/v1/warrant', { headers })).json()
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  const saved = await request.put('/v1/warrant', { headers, data: { ...body, ...patch } })
  expect(saved.status()).toBe(201)
}

const RULE = { id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }
const OFF = { billSignedDeals: false, payOnSettle: false, remindUnpaidAfterDays: null, maxReminders: 2 }

test('autopilot runs the job: proof in, invoice out, client pays, contractor paid, and nobody taps', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${OWNER}` }
  await fake(request, 'invoices-on')
  await widerCap(request)
  const job = `job_autopilot_${test.info().project.name}`
  const offered = await request.post('/v1/deals/offers', {
    headers: { ...headers, 'idempotency-key': `deal-${job}-0001` },
    data: { buyer: 'Northwind', terms: { scope: 'Autopilot logo', category: 'design', currency: 'USD', totalCents: 30000, milestones: [{ title: 'Concepts', amountCents: 15000 }, { title: 'Final files', amountCents: 15000 }], proofRequired: true, jobId: job } },
  })
  const deal = await offered.json()
  expect(deal.status).toBe('agreed')

  // The owner says yes once, to the rules. This is the only approval in the whole job.
  await publishRules(request, { standing: [RULE], automation: { billSignedDeals: true, payOnSettle: true, remindUnpaidAfterDays: 3, maxReminders: 2 } })
  await unlock(page, OWNER)

  // Today: the next milestone is ready to bill. The work is delivered, so paste the proof.
  const proof = page.locator(`#proof-${deal.id}-0`)
  await expect(proof).toBeVisible()
  await proof.fill('https://www.figma.com/file/autopilot-concepts')
  await proof.locator('xpath=ancestor::li').getByRole('button', { name: 'Delivered · bill it' }).click()
  await expect(page.getByText('Invoice sent to Northwind')).toBeVisible()
  await expect(page.locator('[data-tour="ready"]')).toContainText('Waiting for Northwind to pay $150.00')
  await shots(page, '34-today-in-flight')

  // The client pays the invoice in PayPal. The server's own look at PayPal finds it; nobody presses Check.
  await fake(request, 'invoices-pay')
  await fake(request, 'sweep')
  await page.reload()
  const done = page.locator('[data-tour="today-done"]')
  await expect(done).toContainText('Northwind paid $150.00')
  await expect(done).toContainText('Billing rule · no tap')
  await expect(done).toContainText('Priya Shah was paid $90.00')
  await expect(done).toContainText('Autopilot · no tap')
  await shots(page, '35-today-done-for-you')

  await page.goto(`/app/jobs/${job}`)
  await expect(page.locator('.total-out')).toContainText('$90.00')
  await expect(page.locator('.totals')).toContainText('$60.00')

  // And it is all checkable.
  await page.goto('/app/proof')
  await expect(page.locator('.verdict.ok')).toContainText('Everything checks out')
  await expect(page.locator('.check-row.fail')).toHaveCount(0)
  await expect(page.locator('.check-row', { hasText: 'Every payment had a yes' })).toContainText('Pass')
  await shots(page, '36-proof')

  await publishRules(request, { standing: [], automation: OFF })
  await fake(request, 'invoices-off')
})

test('Ask Mandate opens from any screen, answers from the ledger with no model, prepares a button, and gets out of the way', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${OWNER}` }
  await unlock(page, OWNER)
  await page.goto('/app/jobs')
  await page.keyboard.press('Control+k')
  const ask = page.getByRole('dialog', { name: 'Ask Mandate' })
  await expect(ask).toBeVisible()
  // A question about the money is answered from the ledger: no model, no wait.
  await ask.getByRole('button', { name: 'What is waiting for me?' }).click()
  await expect(ask.locator('.answer-card')).toContainText('From the ledger · no model')
  await shots(page, '37-ask-mandate')
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.ask').analyze()
  expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])

  // "The work is delivered" becomes a card with a button. Nothing is sent until the owner presses it.
  const job = `job_ask_${test.info().project.name}`
  const deal = await (await request.post('/v1/deals/offers', {
    headers: { ...headers, 'idempotency-key': `deal-${job}-0001` },
    data: { buyer: 'Northwind', terms: { scope: 'Ask logo', category: 'design', currency: 'USD', totalCents: 30000, milestones: [{ title: 'Concepts', amountCents: 15000 }, { title: 'Final files', amountCents: 15000 }], proofRequired: true, jobId: job } },
  })).json()
  await ask.getByLabel('Message to the clerk').fill('the Ask logo concepts for Northwind are delivered https://www.figma.com/file/ask-concepts')
  await ask.getByRole('button', { name: 'Send' }).click()
  const card = ask.getByTestId('action-card')
  await expect(card).toContainText('Prepared for you · nothing has been sent')
  await expect(card).toContainText('Northwind · Concepts')
  const before = await (await request.get('/v1/proposals', { headers })).json()
  expect(before.data.filter((item: { jobId: string }) => item.jobId === job)).toHaveLength(0)
  await card.getByRole('button', { name: 'Deliver' }).click()
  await expect(card).toContainText(/Sent to the client to accept|Billed|Invoice sent/)
  void deal

  // Typing finds pages and receipts without a model.
  await ask.getByLabel('Message to the clerk').fill('proof')
  await expect(ask.getByRole('option', { name: /Go to Proof/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Ask Mandate' })).toHaveCount(0)
  await page.getByRole('button', { name: /^Ask/ }).first().click()
  await expect(page.getByRole('dialog', { name: 'Ask Mandate' })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('a refusal in Ask says what would pass, tested against the rules, and the receipt says it too', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${OWNER}` }
  await widerCap(request)
  const job = `job_pass_${test.info().project.name}`
  const post = async (path: string, data?: unknown, key?: string) => (await request.post(path, { headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) }, data })).json()
  const charge = await post('/v1/proposals', { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: `Invoice ${job}`, evidenceUrl: 'https://www.figma.com/file/northwind-logo', jobId: job }, `charge-${job}-0001`)
  await post(`/v1/proposals/${charge.id}/approve`)
  const paid = await post(`/v1/proposals/${charge.id}/capture`)
  const over = await post('/v1/proposals', { payee: 'Priya', amountCents: 9100, currency: 'USD', category: 'design', description: `Too much ${job}`, evidenceUrl: 'https://www.figma.com/file/northwind-logo', jobId: job, fundingCaptureId: paid.captureId }, `over-${job}-0001`, PROPOSER)
  expect(over).toMatchObject({ gate: 'DENY', clause: 'funding.exceeds' })
  await unlock(page, OWNER)
  await page.goto(`/app/p/${over.id}`)
  await expect(page.getByTestId('would-pass')).toContainText('$90.00 would pass')
  await shots(page, '42-what-would-pass')
})

test('the owner says a change in words, sees what the code found in it, reads it back, and publishes it themselves', async ({ page, request }) => {
  await unlock(page, OWNER)
  await page.goto('/app/rules')
  const box = page.locator('[data-tour="rules-draft"]')
  await box.getByLabel('Describe the change you want to the rules').fill('Pay Priya 60% of what Northwind pays, never more than $180 a month, and only after I have seen the work.')
  await box.getByRole('button', { name: 'Draft it' }).click()
  // Amber: a wish the rules cannot keep. Found by code, not by the model.
  const ignored = box.locator('.draft-ignored')
  await expect(ignored).toContainText('only after I have seen the work')
  await expect(ignored).toContainText('without asking you')
  await expect(box.locator('.draft-loosens')).toContainText('A standing rule would let Priya Shah from Northwind be paid with no tap')
  await expect(box.locator('.draft-readback')).toContainText('Priya Shah gets $90 (60%) with no tap from you')
  await expect(box.getByTestId('replay')).toContainText('Replay on your history')
  await expect(box).toContainText('nothing is published')
  await shots(page, '38-draft-rules')
  // A draft is not a decision: the live rules have not moved.
  const before = await (await request.get('/v1/warrant', { headers: { authorization: `Bearer ${OWNER}` } })).json()
  expect(before.standing).toEqual([])

  await box.getByRole('button', { name: 'Review this draft' }).click()
  const editor = page.locator('.editor')
  await expect(editor).toContainText('Drafted by')
  await editor.getByRole('button', { name: 'Review changes' }).click()
  await expect(editor.locator('table.diff')).toContainText('Standing rules (no tap)')
  await expect(editor.getByTestId('replay')).toBeVisible()
  await editor.getByRole('button', { name: /Publish version/ }).click()
  await expect(page.getByText(/Standing rule: Priya Shah is paid, with no tap/)).toBeVisible()
  await publishRules(request, { standing: [], automation: OFF, monthlyCapCents: 18_000 })
})

test('a sentence that sounds like a rule is handed from Ask to the drafter', async ({ page, request }) => {
  await unlock(page, OWNER)
  await page.goto('/app/jobs')
  await page.keyboard.press('Control+k')
  const ask = page.getByRole('dialog', { name: 'Ask Mandate' })
  await ask.getByLabel('Message to the clerk').fill('let Priya be paid automatically from Northwind')
  await ask.getByRole('button', { name: 'Send' }).click()
  await expect(page).toHaveURL(/\/app\/rules/)
  await expect(page.locator('[data-tour="rules-draft"] .draft-loosens')).toContainText('A standing rule would let Priya Shah from Northwind', { timeout: 30_000 })
  void request
})

test('a change you were writing is still there after you leave the screen or reload, and a blocked save says why and fixes it', async ({ page, request }) => {
  await unlock(page, OWNER)
  await page.goto('/app/rules')
  const box = page.locator('[data-tour="rules-draft"]')
  const words = 'Pay Priya 60% of what Northwind pays, never more than $180 a month, and only after I have seen the work.'
  await box.getByLabel('Describe the change you want to the rules').fill(words)
  await box.getByRole('button', { name: 'Draft it' }).click()
  await expect(box.locator('.draft-readback')).toContainText('Priya Shah gets $90 (60%) with no tap from you')

  // Reload: the words and the drafted result are still there, and still unpublished.
  await page.reload()
  await expect(page.locator('[data-tour="rules-draft"]').getByLabel('Describe the change you want to the rules')).toHaveValue(words)
  await expect(page.locator('[data-tour="rules-draft"] .draft-readback')).toContainText('Priya Shah gets $90 (60%) with no tap from you')

  // Open it in the editor, leave the screen, come back: the editor's work is offered back, not lost.
  await page.locator('[data-tour="rules-draft"]').getByRole('button', { name: 'Review this draft' }).click()
  await expect(page.locator('.editor')).toContainText('Drafted by')
  await page.goto('/app/jobs')
  await page.goto('/app/rules')
  const banner = page.getByTestId('wip-banner')
  await expect(banner).toContainText('You have unpublished changes to the rules')
  await banner.getByRole('button', { name: 'Continue editing' }).click()
  const editor = page.locator('.editor')
  await expect(editor.getByText('Standing rule', { exact: false }).first()).toBeVisible()

  // The exact trap: "pay when the client pays" with no standing rule cannot be reviewed. It says why, and offers the fix.
  await editor.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('wip-banner')).toHaveCount(0)
  await page.getByRole('button', { name: /Write version/ }).click()
  const fresh = page.locator('.editor')
  await fresh.getByLabel(/When a client payment settles, pay each contractor/).check()
  await expect(fresh.getByRole('alert')).toContainText('needs at least one standing rule')
  await expect(fresh.getByRole('button', { name: 'Review changes' })).toBeDisabled()
  await fresh.getByRole('button', { name: 'Add the standing rule it needs' }).click()
  await expect(fresh.getByRole('alert')).toHaveCount(0)
  await expect(fresh.getByRole('button', { name: 'Review changes' })).toBeEnabled()
  await fresh.getByRole('button', { name: 'Cancel' }).click()

  // Publishing from a version that is no longer live is refused, so nobody undoes a newer change by accident.
  const headers = { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' }
  const live = await (await request.get('/v1/warrant', { headers })).json()
  const { id: _id, version, createdAt: _createdAt, ...rest } = live
  const stale = await request.put('/v1/warrant', { headers: { ...headers, 'x-expected-version': String(version - 1) }, data: rest })
  expect(stale.status()).toBe(409)
  expect((await stale.json()).code).toBe('rules.stale')
})

test('billing waits for the client: delivered, accepted by the client\'s agent, and only then invoiced', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${OWNER}` }
  await fake(request, 'invoices-on')
  const job = `job_accept_${test.info().project.name}`
  const deal = await (await request.post('/v1/deals/offers', {
    headers: { ...headers, 'idempotency-key': `deal-${job}-0001` },
    data: { buyer: 'Northwind', terms: { scope: 'Accepted logo', category: 'design', currency: 'USD', totalCents: 30000, milestones: [{ title: 'Concepts', amountCents: 15000 }, { title: 'Final files', amountCents: 15000 }], proofRequired: true, jobId: job } },
  })).json()
  expect(deal.status).toBe('agreed')
  await publishRules(request, { automation: { billSignedDeals: true, requireAcceptance: true, payOnSettle: false, remindUnpaidAfterDays: null, maxReminders: 2 } })
  await unlock(page, OWNER)

  const proof = page.locator(`#proof-${deal.id}-0`)
  await proof.fill('https://www.figma.com/file/accepted-concepts')
  const row = page.locator('li.bill', { hasText: 'Northwind · Concepts' })
  await row.getByRole('button', { name: 'Delivered · send for acceptance' }).click()
  await expect(row).toContainText('Waiting for Northwind to accept')
  await shots(page, '39-waiting-for-acceptance')
  // Nothing has been billed: the client has not spoken.
  const unbilled = await (await request.get('/v1/proposals', { headers })).json()
  expect(unbilled.data.filter((item: { jobId: string }) => item.jobId === job)).toHaveLength(0)

  await row.getByRole('button', { name: /Ask Northwind.s agent to review/ }).click()
  await expect(page.getByText('The client’s agent accepted the delivery')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-tour="ready"]')).toContainText('Waiting for Northwind to pay $150.00')
  // The console is listening: a payment PayPal reports shows up on this page with no reload and no click.
  await expect(page.getByText('Live', { exact: true })).toBeVisible()
  const inFlight = page.locator('[data-tour="ready"] li.item')
  const before = await inFlight.count()
  await fake(request, 'invoices-pay')
  await fake(request, 'sweep')
  await expect(page.locator('.toast', { hasText: 'PayPal confirmed the payment' })).toBeVisible({ timeout: 10_000 })
  await expect(inFlight).toHaveCount(before - 1, { timeout: 10_000 })
  const after = await (await request.get('/v1/proposals', { headers })).json()
  const charge = after.data.find((item: { jobId: string }) => item.jobId === job)
  expect(charge).toMatchObject({ clause: 'standing.billing', phase: 'captured' })

  await page.goto('/app/proof')
  await expect(page.locator('.check-row', { hasText: 'Billing waited for the client' })).toContainText('Pass')
  await expect(page.locator('.verdict.ok')).toBeVisible()
  await publishRules(request, { automation: OFF })
  await fake(request, 'invoices-off')
})


test('a receipt can be checked in the browser without a key, and a tampered one is caught', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${OWNER}` }
  const job = `job_verify_${test.info().project.name}`
  const asked = await (await request.post('/v1/proposals', {
    headers: { ...headers, 'idempotency-key': `verify-${job}-0001` },
    data: { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: 'Verify me', evidenceUrl: 'https://www.figma.com/file/northwind-logo', jobId: job },
  })).json()
  await request.post(`/v1/proposals/${asked.id}/approve`, { headers })
  const packet = await (await request.get(`/v1/proposals/${asked.id}/packet`, { headers })).json()

  // No key, no login: this page is for whoever was sent the receipt.
  await page.goto('/app/verify')
  await expect(page.getByText(/public keys? loaded from this server/)).toBeVisible()
  await page.getByLabel('Receipt JSON').fill(JSON.stringify(packet))
  await page.getByRole('button', { name: 'Verify this receipt' }).click()
  const verdict = page.getByTestId('verdict')
  await expect(verdict).toContainText('This receipt is genuine.')
  await expect(verdict).toContainText('The lock was signed by the server')
  await shots(page, '40-verify-receipt')
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])

  // The same receipt with the amount edited to $1,500: the lock no longer recomputes.
  packet.proposal.amountCents = 150000
  await page.getByLabel('Receipt JSON').fill(JSON.stringify(packet))
  await page.getByRole('button', { name: 'Verify this receipt' }).click()
  await expect(verdict).toContainText('Do not rely on this receipt.')
  await expect(verdict).toContainText('was changed after it was locked')
  await shots(page, '41-verify-tampered')

  // And from the receipt itself, one click carries it over.
  await unlock(page, OWNER)
  await page.goto(`/app/p/${asked.id}`)
  await page.getByRole('link', { name: /Check it in your browser instead/ }).click()
  await expect(page.getByTestId('verdict')).toContainText('This receipt is genuine.')
})
