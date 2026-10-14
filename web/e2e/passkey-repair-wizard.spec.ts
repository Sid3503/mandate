import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const shots = fileURLToPath(new URL('../../docs/evidence/q1', import.meta.url))

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

test('the studio wizard keeps progress and requires a backup before Today', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await arm(page)
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill('Wizard Studio')
  await page.reload()
  await expect(page.getByLabel('Studio name')).toHaveValue('Wizard Studio')
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()
  await expect(page.getByTestId('paypal-sim')).toContainText('No charge reaches PayPal')
  await expect(page.getByRole('button', { name: 'Open Today' })).toHaveCount(0)
  const fingerprint = (await page.getByTestId('passkey-fingerprint').innerText()).trim()
  await page.reload()
  await expect(page.getByTestId('passkey-fingerprint')).toHaveText(fingerprint)
  await expect(page.getByRole('button', { name: 'Add a second passkey' })).toBeVisible()
  await page.getByRole('button', { name: 'Create recovery codes' }).click()
  await expect(page.getByTestId('wizard-codes')).toBeVisible()
  await page.getByRole('button', { name: 'I saved these' }).click()
  await expect(page.getByTestId('wizard-codes')).toHaveCount(0)
  await page.getByRole('button', { name: 'Skip rules' }).click()
  await expect(page.getByTestId('studio-done')).toContainText('Recovery codes are saved')
  await expect(page.getByTestId('paypal-sim')).toContainText('simulated')
  await page.waitForTimeout(1600)
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.unlock').analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
  await page.locator('.unlock').screenshot({ path: `${shots}/wizard.png` })
  await page.getByRole('button', { name: 'Open Today' }).click()
  await expect(page.getByRole('heading', { name: /Today/ })).toBeVisible()
})
