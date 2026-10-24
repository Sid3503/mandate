import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { currentWorkspace, writeFirstRules } from './studio'

async function arm(page: Page) {
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable')
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

test('sign in, approve, verify the receipt, then see a tampered one fail', async ({ page }) => {
  // The approval card now shows the hash and the clause, so Approve sits under the welcome tour.
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await arm(page)
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill('Verify Studio')
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByText('Save this')).toBeVisible()
  const fingerprint = (await page.getByTestId('passkey-fingerprint').innerText()).trim()
  expect(fingerprint.length).toBe(16)
  await page.getByRole('button', { name: 'Create recovery codes' }).click()
  await page.getByRole('button', { name: 'I saved these' }).click()
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await page.getByRole('button', { name: 'Skip rules' }).click()
  await page.getByRole('button', { name: 'Open Today' }).click()
  const workspace = await currentWorkspace(page)
  // A new studio has no rules until the owner writes them, so this one writes them first.
  await writeFirstRules(page, workspace)
  const made = await page.request.post(`/w/${workspace}/v1/proposals`, {
    headers: { origin: 'http://localhost:8777', 'x-mandate-client': 'web', 'idempotency-key': 'passkey-receipt-1' },
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
  await page.getByRole('button', { name: /Approve/ }).click()
  await expect(page.getByText('Approved · locked')).toBeVisible()
  await page.goto(`/app/p/${id}`)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download receipt' }).click()
  const download = await downloadPromise
  const saved = '/tmp/mandate-passkey-receipt.json'
  await download.saveAs(saved)
  const text = readFileSync(saved, 'utf8')
  const receipt = JSON.parse(text) as { approval?: { payload?: { assertion?: { response?: { signature?: string } } } } }
  if (process.env.CAPTURE_PASSKEY_VECTOR === '1') writeFileSync('/tmp/passkey-vector.json', JSON.stringify(receipt.approval?.payload, null, 2))
  await page.goto('/app/verify')
  await page.locator('#receipt-json').fill(text)
  await page.getByRole('button', { name: 'Verify this receipt' }).click()
  await expect(page.getByTestId('verdict')).toContainText('valid signature by this key')
  await expect(page.getByTestId('verdict')).toContainText('RP ID')
  await expect(page.getByTestId('verdict')).toContainText('Origin')
  await page.getByTestId('typed-fingerprint').fill(fingerprint)
  await page.getByRole('button', { name: 'Verify this receipt' }).click()
  await expect(page.getByTestId('verdict')).toContainText('matches the fingerprint you typed')
  await expect(page.getByTestId('verdict')).not.toContainText('Meera')
  const signature = receipt.approval?.payload?.assertion?.response?.signature ?? ''
  expect(signature.length).toBeGreaterThan(8)
  const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
  const tampered = JSON.parse(text) as { approval: { payload: { assertion: { response: { signature: string } } } } }
  tampered.approval.payload.assertion.response.signature = flipped
  await page.locator('#receipt-json').fill(JSON.stringify(tampered))
  await page.getByRole('button', { name: 'Verify this receipt' }).click()
  await expect(page.getByTestId('verdict')).toContainText('Does not verify')
  await expect(page.getByTestId('verdict')).not.toContainText('valid signature by this key')
})
