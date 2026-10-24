import { expect, test, type Page } from '@playwright/test'

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

test('recovery codes are shown once, confirmed, and replaced with a passkey', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await arm(page)
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill('Recovery Studio')
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()
  await page.goto('/app/sessions')
  await page.getByRole('button', { name: 'Create recovery codes' }).click()
  const list = page.getByTestId('recovery-codes').locator('ol li')
  await expect(list).toHaveCount(8)
  const first = await list.first().innerText()
  await page.getByRole('button', { name: 'I saved these' }).click()
  await expect(page.getByTestId('recovery-codes')).toContainText('Saved.')
  await expect(page.getByText(first)).toHaveCount(0)
  await page.getByRole('button', { name: 'Replace recovery codes' }).click()
  await expect(list).toHaveCount(8)
  await expect(page.getByText(first)).toHaveCount(0)
})
