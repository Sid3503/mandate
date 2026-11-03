import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const OWNER = 'owner-e2e-key-0123456789'
const headers = { authorization: `Bearer ${OWNER}` }
const PROOF = 'https://www.figma.com/file/northwind-logo'

async function unlock(page: Page) {
  await page.goto('/app/unlock')
  await page.getByLabel('API key').fill(OWNER)
  await page.getByRole('button', { name: 'Unlock console' }).click()
  await expect(page.getByRole('heading', { name: /Waiting for you/ })).toBeVisible()
}

/** One client charge, asked for through the API. `how` says how far it goes: asked, approved, or paid through the fake PayPal. */
async function bill(request: APIRequestContext, job: string, cents: number, how: 'asked' | 'approved' | 'paid') {
  const created = await (await request.post('/v1/proposals', {
    headers: { ...headers, 'idempotency-key': `inv-${job}-${cents}-0001` },
    data: { kind: 'charge', payee: 'Northwind', amountCents: cents, currency: 'USD', category: 'design', description: `Invoice desk ${job} ${cents}`, evidenceUrl: PROOF, jobId: job },
  })).json()
  if (how !== 'asked') expect((await request.post(`/v1/proposals/${created.id}/approve`, { headers })).status()).toBe(200)
  if (how === 'paid') expect((await request.post(`/v1/proposals/${created.id}/capture`, { headers })).status()).toBe(200)
  return created.id as string
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
})

test('the Invoices desk: KPIs, status filters, search, notes to invoice, ask for the bill, see it on the receipt', async ({ page, request }) => {
  const job = `inv-${test.info().project.name}-${Date.now()}`
  await bill(request, job, 15_137, 'asked')
  await bill(request, job, 17_543, 'approved')
  await bill(request, job, 9_077, 'paid')
  await unlock(page)

  // Reached from the Activity views, on a phone as well as a desktop.
  await page.goto('/app/ledger')
  await page.getByRole('navigation', { name: 'Activity views' }).getByRole('link', { name: /Invoices/ }).click()
  await expect(page.getByRole('heading', { name: 'Invoices' })).toBeVisible()
  await expect(page.getByTestId('invoice-kpis')).toContainText('Invoiced')
  await expect(page.getByTestId('invoice-kpis')).toContainText('Outstanding')
  await expect(page.getByTestId('invoice-kpis')).toContainText('Average days to pay')

  // The cash outlook says it is advice, and the guardrails come from the rules.
  await expect(page.getByTestId('cash-outlook')).toContainText('Projected cash')
  await expect(page.getByTestId('outlook-disclaimer')).toContainText('not a guarantee')
  await expect(page.getByTestId('guardrails')).toContainText('USD only')

  // Filter by status: counts on the chips, rows that match.
  const rows = page.getByTestId('invoice-table').or(page.getByTestId('invoice-list'))
  await expect(rows).toContainText('Northwind')
  await page.getByTestId('filter-draft').click()
  await expect(page.getByTestId('filter-draft')).toHaveAttribute('aria-pressed', 'true')
  await expect(rows).toContainText('$151.37')
  await expect(rows).not.toContainText('$175.43')
  await page.getByTestId('filter-paid').click()
  await expect(rows).toContainText('$90.77')
  await expect(rows).not.toContainText('$151.37')
  await page.getByTestId('filter-all').click()
  await page.getByTestId('invoice-search').fill(job)
  await expect(rows).toContainText('$175.43')
  await page.getByTestId('invoice-search').fill('no-such-client-zzz')
  await expect(page.getByTestId('invoices-empty')).toBeVisible()
  await page.getByTestId('invoice-search').fill('')

  // Notes to invoice: a local draft, with the gaps highlighted and the rules' verdict.
  await page.getByTestId('notes-input').fill('Bill Northwind $120 for logo tweaks, net 14, send to accounts@northwind.example')
  await page.getByTestId('draft-it').click()
  const card = page.getByTestId('draft-card')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('nothing-asked')).toHaveText('Nothing is asked of PayPal until you approve it.')
  await expect(card.getByLabel('Item 1 description')).toHaveValue('logo tweaks')
  await expect(page.getByTestId('draft-total')).toContainText('$120.00')
  await expect(card.getByLabel('Due date')).not.toHaveValue('')
  // Not in the notes, so asked for and never invented.
  await expect(card).toContainText('Every bill names the job it pays for')
  await expect(card).toContainText('https link to the work')
  await expect(page.getByTestId('ask-bill')).toBeDisabled()
  await card.getByLabel('Job').fill(job)
  await card.getByLabel('Kind of work').selectOption('design')
  await card.getByLabel('Link to the work').fill(PROOF)
  await expect(page.getByTestId('draft-verdict')).toContainText('Needs your tap')
  await expect(page.getByTestId('draft-verdict')).toContainText('$120.00')
  await page.getByTestId('ask-bill').click()
  await expect(page.getByTestId('draft-done')).toContainText('Open the receipt to approve it')
  await page.getByTestId('draft-receipt-link').click()
  await expect(page).toHaveURL(/\/app\/p\//)
  await expect(page.getByText('$120.00').first()).toBeVisible()
  await expect(page.getByText('logo tweaks').first()).toBeVisible()

  // And it is on the desk, as a draft waiting for the tap.
  await page.goto('/app/invoices')
  await page.getByTestId('filter-draft').click()
  await expect(page.getByTestId('invoice-table').or(page.getByTestId('invoice-list'))).toContainText('$120.00')
})

test('Ask answers the money questions from the books, with the honesty line on the forecast', async ({ page }) => {
  await unlock(page)
  await page.goto('/app/clerk')
  await page.getByRole('button', { name: 'Cash forecast' }).click()
  await expect(page.getByText(/not a promise/).first()).toBeVisible()
  // The chips show on an empty conversation, so start a fresh one.
  await page.goto('/app/clerk')
  await page.getByRole('button', { name: 'Which invoices are overdue?' }).click()
  await expect(page.getByText(/invoice is overdue|No invoice is overdue|invoices are overdue/).first()).toBeVisible()
})

test("the Invoices desk, with a draft open, passes axe (WCAG 2.1 AA)", async ({ page }) => {
  const { default: AxeBuilder } = await import("@axe-core/playwright")
  await unlock(page)
  await page.goto("/app/invoices")
  await page.getByTestId("notes-input").fill("Bill Northwind $120 for logo tweaks, net 14")
  await page.getByTestId("draft-it").click()
  await expect(page.getByTestId("draft-card")).toBeVisible()
  await page.waitForTimeout(1000)
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([])
})
