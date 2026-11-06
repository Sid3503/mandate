import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const OWNER = 'owner-e2e-key-0123456789'
const PROPOSER = 'proposer-e2e-key-0123456789'
const EVIDENCE = 'https://www.figma.com/file/northwind-logo'
const shots = (page: Page, name: string) => page.screenshot({ path: `e2e/shots/${test.info().project.name}-${name}.png`, fullPage: true, animations: 'disabled' })

async function unlock(page: Page, key: string) {
  // The first-visit tour would open over Today and take the click meant for the band (seen on the slower CI runner).
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await page.goto('/app/unlock')
  await page.getByLabel('API key').fill(key)
  await page.getByRole('button', { name: 'Unlock console' }).click()
  await expect(page.getByRole('heading', { name: /Waiting for you/ })).toBeVisible()
}

const post = async (request: APIRequestContext, path: string, data?: unknown, key?: string, as = OWNER) =>
  (await request.post(path, { headers: { authorization: `Bearer ${as}`, ...(key ? { 'idempotency-key': key } : {}) }, data })).json()

/** The studio's rules with one standing rule for Priya, a wide cap, the risk engine off (earlier specs file enough requests to trip its velocity check, which is it working), and a regret window. Published through the API. */
async function sign(request: APIRequestContext, regretSeconds: number) {
  const headers = { authorization: `Bearer ${OWNER}` }
  const { id: _i, version: _v, createdAt: _c, ...body } = await (await request.get('/v1/warrant', { headers })).json()
  const rule = { id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: false }
  const standing = (body.standing ?? []).length > 0 ? body.standing : [rule]
  const put = await request.put('/v1/warrant', { headers, data: { ...body, standing, regretSeconds, monthlyCapCents: Math.max(body.monthlyCapCents, 90_000), automation: { ...body.automation, payOnSettle: false }, risk: { ...body.risk, enabled: false } } })
  expect(put.status()).toBe(201)
}

async function funded(request: APIRequestContext, job: string) {
  const charge = await post(request, '/v1/proposals', { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: `Invoice ${job}`, evidenceUrl: EVIDENCE, jobId: job }, `charge-${job}-0001`)
  await post(request, `/v1/proposals/${charge.id}/approve`)
  const paid = await post(request, `/v1/proposals/${charge.id}/capture`)
  expect(paid.captureId).toBeTruthy()
  return paid.captureId as string
}

const askPriya = (request: APIRequestContext, job: string, captureId: string, key: string, amountCents = 9000) =>
  post(request, '/v1/proposals', { payee: 'Priya', amountCents, currency: 'USD', category: 'design', description: `Share ${job}`, evidenceUrl: EVIDENCE, jobId: job, fundingCaptureId: captureId }, key, PROPOSER)

test.describe.configure({ mode: 'serial' })

// Runs last, after every other spec: it publishes a standing rule and a regret window, which change how every later payout is decided.
test('Today says the most that can leave without you, and the number is what a hostile key can actually move', async ({ page, request }) => {
  await sign(request, 0)
  const job = `job_blast_${test.info().project.name}`
  const captureId = await funded(request, job)
  const before = await (await request.get('/v1/blast-radius', { headers: { authorization: `Bearer ${OWNER}` } })).json()
  expect(before.alone.payoutsCents).toBeGreaterThanOrEqual(9000)

  await unlock(page, OWNER)
  const tile = page.getByTestId('blast')
  await expect(tile).toBeVisible()
  await expect(page.getByTestId('blast-alone')).toContainText('$')
  await tile.locator('summary').click()
  await expect(tile.locator('.blast-lines li').first()).toBeVisible()
  await shots(page, 'blast-today')

  // A hostile proposer asks for far more than its share, over and over. Only the share moves, and the number falls by exactly that.
  const sent = await askPriya(request, job, captureId, `blast-${job}-0001`)
  expect(sent).toMatchObject({ clause: 'standing.matched', phase: 'captured', capturedAmountCents: 9000 })
  for (const [i, cents] of [9000, 1999, 500].entries()) {
    const more = await askPriya(request, job, captureId, `blast-${job}-more-${i}`, cents)
    expect(more.gate).toBe('DENY')
  }
  const after = await (await request.get('/v1/blast-radius', { headers: { authorization: `Bearer ${OWNER}` } })).json()
  expect(after.capLeftCents).toBe(before.capLeftCents - 9000)
})

test('Attack my rules plays a hostile proposer on a copy of the ledger and shows what held and what got through', async ({ page, request }) => {
  await sign(request, 0)
  const calls = async () => (await (await request.get('/v1/proposals?limit=100', { headers: { authorization: `Bearer ${OWNER}` } })).json()).data.length
  const rowsBefore = await calls()
  await unlock(page, OWNER)
  await page.getByTestId('blast-attack').click()
  const result = page.getByTestId('attack-result')
  await expect(result).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('attack-stranger')).toContainText('Refused')
  await expect(page.getByTestId('attack-stranger')).toContainText('payee.unknown')
  await expect(page.getByTestId('attack-fuzz')).toContainText('random requests')
  await shots(page, 'attack-result')
  // It filed nothing.
  expect(await calls()).toBe(rowsBefore)
  // A fix, previewed, opens the editor on the rules with that one change made.
  const fix = page.locator('.attack-fix').first()
  if (await fix.count() > 0) {
    await fix.getByRole('link', { name: 'Preview in Rules' }).click()
    await expect(page.locator('.editor')).toBeVisible()
    await expect(page.getByTestId('blast-delta')).toBeVisible({ timeout: 10_000 })
    await shots(page, 'attack-fix-preview')
  }
})

test('the editor shows the Blast Radius moving as an amount is typed, before anything is signed', async ({ page, request }) => {
  await sign(request, 0)
  await unlock(page, OWNER)
  await page.goto('/app/rules')
  await page.getByRole('button', { name: /Write version/ }).click()
  await page.getByLabel('Seconds to hold a request a rule sends by itself').fill('30')
  await expect(page.getByTestId('blast-delta')).toBeVisible({ timeout: 10_000 })
  await shots(page, 'blast-editor')
  await page.getByRole('button', { name: 'Review changes' }).click()
  await expect(page.locator('.editor table.diff').first()).toContainText('Hold before a rule sends')
  await expect(page.locator('.editor table.diff').first()).toContainText('30 seconds, with Undo')
  await expect(page.getByTestId('attack')).toBeVisible()
})

test('a payout a rule sends by itself waits out the regret window with a countdown, and Undo takes it back before PayPal is called', async ({ page, request }) => {
  await sign(request, 20)
  const job = `job_regret_${test.info().project.name}`
  const captureId = await funded(request, job)
  await unlock(page, OWNER)

  const asked = await askPriya(request, job, captureId, `regret-${job}-0001`)
  expect(asked).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', phase: 'locked' })
  const band = page.getByTestId('regret-band')
  await expect(band).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('regret-clock')).toContainText('Sends in')
  await shots(page, 'regret-band')
  await page.getByTestId('regret-undo').click()
  await expect(band).toBeHidden({ timeout: 10_000 })
  const row = await (await request.get(`/v1/proposals/${asked.id}`, { headers: { authorization: `Bearer ${OWNER}` } })).json()
  expect(row.phase).toBe('rejected')
  // Taken back means the share is free again: the same ask is allowed, and this time nobody touches it.
  const again = await askPriya(request, job, captureId, `regret-${job}-0002`)
  expect(again).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', phase: 'locked' })
  // The real server sweeps every few seconds by itself; this test server only does when told. A sweep inside the window changes nothing.
  const sweep = () => request.post('/__fake/payouts/sweep', { headers: { authorization: `Bearer ${OWNER}` } })
  await sweep()
  expect((await (await request.get(`/v1/proposals/${again.id}`, { headers: { authorization: `Bearer ${OWNER}` } })).json()).phase).toBe('locked')
  // When the clock runs out the row leaves the band and Today says it is being paid.
  await expect(page.getByTestId('regret-band')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('regret-band')).toBeHidden({ timeout: 40_000 })
  await expect(page.getByText(/Mandate is paying Priya Shah/)).toBeVisible({ timeout: 10_000 })
  await expect.poll(async () => { await sweep(); return (await (await request.get(`/v1/proposals/${again.id}`, { headers: { authorization: `Bearer ${OWNER}` } })).json()).phase }, { timeout: 30_000, intervals: [1000] }).toMatch(/captured|payout_sent/)
  // A late Undo is refused, with the reason.
  const late = await request.post(`/v1/proposals/${again.id}/undo`, { headers: { authorization: `Bearer ${OWNER}` } })
  expect(late.status()).toBe(409)
  await sign(request, 0)
})
