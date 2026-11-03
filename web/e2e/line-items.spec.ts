import { expect, test, type Page } from '@playwright/test'

const OWNER = 'owner-e2e-key-0123456789'

async function unlock(page: Page, key: string) {
  await page.goto('/app/unlock')
  await page.getByLabel('API key').fill(key)
  await page.getByRole('button', { name: 'Unlock console' }).click()
  await expect(page.getByRole('heading', { name: /Waiting for you/ })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
})

test('a bill with two items, a due date and a note is asked for, approved, and shown on its receipt', async ({ page }) => {
  const description = `Line items bill ${test.info().project.name}`
  await unlock(page, OWNER)
  await page.goto('/app/new')
  await page.getByText('Money in').click()

  // Two items, typed in; the subtotal becomes the amount.
  await page.getByRole('button', { name: 'Add a line item' }).click()
  await page.getByLabel('Item 1 description').fill('Logo concepts')
  await page.getByLabel('Item 1 quantity').fill('2')
  await page.getByLabel('Item 1 unit price').fill('50')
  await page.getByRole('button', { name: 'Add a line item' }).click()
  await page.getByLabel('Item 2 description').fill('Final files')
  await page.getByLabel('Item 2 unit price').fill('50')
  await expect(page.getByTestId('line-subtotal')).toContainText('$150.00')
  await expect(page.getByLabel('Amount in USD')).toHaveValue('150.00')
  await expect(page.getByLabel('Amount in USD')).toHaveAttribute('readonly', '')

  // A row can be removed and added back; the total follows.
  await page.getByRole('button', { name: 'Remove item 2' }).click()
  await expect(page.getByTestId('line-subtotal')).toContainText('$100.00')
  await page.getByRole('button', { name: 'Add a line item' }).click()
  await page.getByLabel('Item 2 description').fill('Final files')
  await page.getByLabel('Item 2 unit price').fill('50')
  await expect(page.getByTestId('line-subtotal')).toContainText('$150.00')

  // Net 14 sets the date, and a note goes with it.
  await page.getByRole('button', { name: 'Net 14' }).click()
  const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
  await expect(page.getByLabel(/Due date/)).toHaveValue(due)
  await page.getByLabel(/Note for the client/).fill('Thank you <b>so</b> much.')
  await page.getByLabel('What it is for').fill(description)
  await page.getByLabel('Job').fill(`job_line_items_${test.info().project.name}`)
  await page.getByLabel('Link to the work').fill('https://www.figma.com/file/northwind-logo')
  await page.getByRole('button', { name: 'Ask the rules' }).click()
  const answer = page.locator('.answer')
  await expect(answer.getByText('Needs you')).toBeVisible()

  // The owner approves it on Today.
  await page.goto('/app/')
  const waiting = page.locator('.approval').filter({ hasText: description })
  await expect(waiting).toBeVisible()
  await waiting.getByRole('button', { name: /Approve/ }).click()
  await expect(waiting.getByText('Approved · locked')).toBeVisible()

  // Its receipt shows the items, the due date, the note (angle brackets gone), and a lock that verifies.
  await page.goto('/app/')
  const list = await page.request.get('/v1/proposals?limit=100', { headers: { authorization: `Bearer ${OWNER}` } })
  const made = ((await list.json()).data as Array<{ id: string; description: string }>).find((row) => row.description === description)!
  await page.goto(`/app/p/${made.id}`)
  const terms = page.getByTestId('bill-terms')
  await expect(terms).toBeVisible()
  await expect(terms.getByRole('row', { name: /Logo concepts/ })).toContainText('$50.00')
  await expect(terms.getByRole('row', { name: /Logo concepts/ })).toContainText('$100.00')
  await expect(terms.getByRole('row', { name: /Final files/ })).toContainText('$50.00')
  await expect(terms.getByRole('row', { name: /Total/ })).toContainText('$150.00')
  await expect(terms).toContainText('Due')
  await expect(terms).toContainText('Thank you bso/b much.')
  await expect(terms).not.toContainText('Overdue')
  await expect(page.getByText('items, due date and note')).toBeVisible()
  const verified = await (await page.request.get(`/v1/proposals/${made.id}/verify`, { headers: { authorization: `Bearer ${OWNER}` } })).json()
  expect(verified.verdict).toBe('valid')
})
