import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const shots = fileURLToPath(new URL('../../docs/evidence/q0', import.meta.url))
const ownerKey = 'passkey-repair-owner-key-32'

test('demo tap, the approval card, the receipt line, and three verify results', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await page.goto('/app/welcome')
  await page.getByRole('button', { name: 'Try the demo' }).click()
  await expect(page.getByRole('heading', { name: /Today/ })).toBeVisible()
  const workspace = await page.evaluate(() => sessionStorage.getItem('mandate.workspace'))
  expect(workspace).toBeTruthy()
  const made = await page.request.post(`/w/${workspace}/v1/proposals`, {
    headers: { origin: 'http://localhost:8777', 'x-mandate-client': 'web', 'idempotency-key': 'q0-demo-tap' },
    data: {
      kind: 'charge',
      payee: 'Northwind',
      amountCents: 15000,
      currency: 'USD',
      category: 'design',
      description: 'Northwind logo',
      evidenceUrl: 'https://www.figma.com/file/northwind-logo',
      jobId: 'job_northwind_logo',
    },
  })
  expect(made.ok()).toBe(true)
  const id = (await made.json()).id as string
  await page.reload()
  const card = page.locator('article.approval')
  await expect(card.getByRole('button', { name: 'Demo tap' })).toBeVisible()
  await expect(card.getByText('amount.needs_approval')).toBeVisible()
  await expect(card.locator('.hash')).not.toHaveText('no lock yet')
  await expect(page.getByText(ownerKey)).toHaveCount(0)
  await card.screenshot({ path: `${shots}/demo-tap.png` })
  await card.screenshot({ path: `${shots}/approval-card.png` })
  await card.getByRole('button', { name: 'Demo tap' }).click()
  await expect(page.getByText('Signed and sent')).toBeVisible()
  await expect(card.getByText('Approved · locked')).toBeVisible()
  await page.goto(`/app/p/${id}`)
  const line = page.getByTestId('proof-line')
  await expect(line).toContainText('demo')
  await expect(line).toHaveClass(/proof-amber/)
  await line.screenshot({ path: `${shots}/receipt-line.png` })
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download receipt' }).click()
  const download = await downloadPromise
  const saved = '/tmp/mandate-q0-receipt.json'
  await download.saveAs(saved)
  const text = readFileSync(saved, 'utf8')
  expect(text).not.toContain(ownerKey)
  expect(text).not.toContain('paypal-canary-token')
  const keys = await page.request.get(`/w/${workspace}/.well-known/mandate-keys.json`)
  expect(keys.ok()).toBe(true)
  await page.goto('/app/verify')
  await page.locator('#keys-json').fill(await keys.text())
  await page.locator('#receipt-json').fill(text)
  await page.getByRole('button', { name: 'Verify this receipt' }).click()
  const verdict = page.getByTestId('verdict')
  await expect(verdict).toContainText('This receipt is genuine.')
  await verdict.screenshot({ path: `${shots}/verify-good.png` })
  const tampered = JSON.parse(text) as { proposal: { amountCents: number } }
  tampered.proposal.amountCents += 1
  await page.locator('#receipt-json').fill(JSON.stringify(tampered))
  await page.getByRole('button', { name: 'Verify this receipt' }).click()
  await expect(verdict).toContainText('Does not verify')
  await verdict.screenshot({ path: `${shots}/verify-tampered.png` })
  const vector = JSON.parse(readFileSync(new URL('../src/lib/passkey-vector.json', import.meta.url), 'utf8')) as { publicKey: { alg: number } }
  vector.publicKey.alg = -8
  await page.locator('#receipt-json').fill(JSON.stringify({ approval: { payload: vector } }))
  await page.getByRole('button', { name: 'Verify this receipt' }).click()
  await expect(verdict).toContainText('cannot verify here')
  await expect(verdict).not.toContainText('valid signature by this key')
  await verdict.screenshot({ path: `${shots}/verify-unsupported.png` })
})
