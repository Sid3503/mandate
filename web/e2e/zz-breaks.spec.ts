import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const OWNER = 'owner-e2e-key-0123456789'
const headers = { authorization: `Bearer ${OWNER}` }

async function unlock(page: Page) {
  await page.goto('/app/unlock')
  await page.getByLabel('API key').fill(OWNER)
  await page.getByRole('button', { name: 'Unlock console' }).click()
  await expect(page.getByRole('heading', { name: /Waiting for you/ })).toBeVisible()
}

/** One client charge, approved and paid through the fake PayPal. Returns the request id and its PayPal capture id. */
async function paidCharge(request: APIRequestContext, job: string, n: number) {
  const created = await (await request.post('/v1/proposals', {
    headers: { ...headers, 'idempotency-key': `breaks-${job}-${n}-0001` },
    data: { kind: 'charge', payee: 'Northwind', amountCents: 7700, currency: 'USD', category: 'design', description: `Invoice ${job} ${n}`, evidenceUrl: 'https://www.figma.com/file/northwind-logo', jobId: job },
  })).json()
  expect((await request.post(`/v1/proposals/${created.id}/approve`, { headers })).status()).toBe(200)
  const captured = await (await request.post(`/v1/proposals/${created.id}/capture`, { headers })).json()
  expect(captured.captureId).toBeTruthy()
  return { id: created.id as string, captureId: captured.captureId as string }
}

test('the Breaks desk finds a double payment, files the refund through the gate, and keeps the PayPal calls', async ({ page, request }) => {
  const job = `breaks-${Date.now()}`
  await paidCharge(request, job, 1)
  const second = await paidCharge(request, job, 2)
  await unlock(page)

  await page.goto('/app/breaks')
  await expect(page.getByRole('heading', { name: 'Breaks' })).toBeVisible()
  await page.getByRole('button', { name: 'Reconcile now' }).click()
  await expect(page.getByTestId('scan-status')).toContainText('Reconciled')
  await expect(page.getByTestId('synced')).toContainText('Synced')
  await expect(page.getByTestId('breaks-kpis')).toContainText('Open breaks')
  await expect(page.getByTestId('breaks-kpis')).toContainText('Money at stake')

  // Either of the two payments may be "the later one" when both land in the same moment: open the break for this job.
  const opener = page.getByRole('button', { name: /Open break: .*may have been paid twice/ })
  await expect(opener.first()).toBeVisible()
  await opener.first().click()
  const detail = page.getByTestId('break-detail')
  await expect(detail).toContainText('PayPal capture')
  await expect(detail).toContainText('Your rules decide')

  await page.getByTestId('break-fix').click()
  await expect(page.getByTestId('break-said')).toContainText('Nothing was refunded by this button')

  // Dismiss needs a note.
  await expect(page.getByTestId('break-dismiss')).toBeDisabled()
  await detail.getByLabel('Dismiss with a note').fill('Checked with the client: both were wanted.')
  await page.getByTestId('break-dismiss').click()
  await expect(page.getByTestId('break-said')).toContainText('Dismissed')
  await page.getByRole('button', { name: 'Dismissed', exact: true }).click()
  await expect(page.getByRole('button', { name: /Open break: .*may have been paid twice/ }).first()).toBeVisible()

  // The receipt shows every PayPal call, recorded before it was made.
  await page.goto(`/app/p/${second.id}`)
  const calls = page.getByTestId('paypal-calls')
  await expect(calls).toBeVisible()
  await expect(calls).toContainText('PayPal-Request-Id')
  await expect(calls).toContainText('succeeded')
})
