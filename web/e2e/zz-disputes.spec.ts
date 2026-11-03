import { expect, test } from '@playwright/test'

// Runs last (the name sorts after every other spec) because it leaves one captured charge behind.
// Uses the dev server's fake PayPal and fake Disputes API: the sandbox cannot open a real dispute.
const OWNER = 'owner-e2e-key-0123456789'
const auth = { authorization: `Bearer ${OWNER}` }

test('the dispute desk: evidence from the signed records, a person approves, the exact request is shown', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  const job = `job_dispute_${test.info().project.name}`

  // Honest empty state first.
  await page.goto('/app/unlock')
  await page.getByLabel('API key').fill(OWNER)
  await page.getByRole('button', { name: 'Unlock console' }).click()
  await expect(page.getByRole('heading', { name: /Waiting for you/ })).toBeVisible()
  await page.getByRole('link', { name: 'Disputes' }).first().click()
  await expect(page.getByText('No client disputes')).toBeVisible()

  // A paid client charge, then a dispute on it.
  const created = await request.post('/v1/proposals', {
    headers: { ...auth, 'idempotency-key': `dispute-charge-${job}-0001` },
    data: { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: 'Northwind logo milestone 1 invoice', evidenceUrl: 'https://www.figma.com/file/northwind-logo', prompt: 'Bill Northwind $150', jobId: job },
  })
  const id = (await created.json()).id as string
  await request.post(`/v1/proposals/${id}/approve`, { headers: auth })
  const captured = await (await request.post(`/v1/proposals/${id}/capture`, { headers: auth })).json()
  expect(captured.captureId).toBeTruthy()
  const seeded = await (await request.post('/__fake/disputes/seed', { headers: auth })).json()

  await page.goto('/app/disputes')
  const row = page.getByRole('button', { name: `Open dispute ${seeded.id}` })
  await expect(row).toBeVisible()
  await expect(row).toContainText(/response due in 1d (4|5)h/)
  await row.click()

  // The packet is a checklist: what is present and what is missing.
  const checklist = page.getByTestId('evidence-checklist')
  await expect(checklist.locator('li[data-present="yes"]').filter({ hasText: 'Signed lock on the payment' })).toBeVisible()
  await expect(checklist.locator('li[data-present="no"]').filter({ hasText: 'The client accepted the delivery' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Verify the lock yourself' })).toBeVisible()
  await expect(page.getByTestId('approval-banner')).toContainText('A person approves every dispute response. Nothing is sent until you do.')
  await expect(page.getByText('not run on a live dispute').first()).toBeVisible()

  // Draft from the evidence; the draft names what is missing and does not claim an acceptance.
  await page.getByRole('button', { name: 'Draft from the evidence' }).click()
  const box = page.getByLabel('Response text')
  await expect(box).toHaveValue(/Not available in our records/)
  await expect(box).not.toHaveValue(/accepted the delivery of milestone/)
  await box.fill(`${await box.inputValue()}\nPlease review the signed receipt.`)

  // Approve and send; the exact request is then shown, and the editor is gone.
  await page.getByRole('button', { name: 'Approve with passkey and send' }).click()
  const sent = page.getByTestId('sent-request')
  await expect(sent).toContainText(`POST /v1/customer/disputes/${seeded.id}/provide-evidence`)
  await expect(sent).toContainText('"evidence_type": "OTHER"')
  await expect(page.getByLabel('Response text')).toHaveCount(0)

  // A second send over the API does nothing.
  const again = await request.post(`/v1/disputes/${seeded.id}/send`, { headers: auth, data: { text: 'again' } })
  expect((await again.json()).replayed).toBe(true)
})
