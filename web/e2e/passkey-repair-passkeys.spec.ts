import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const shots = fileURLToPath(new URL('../../docs/evidence/q1', import.meta.url))

const authenticator = {
  protocol: 'ctap2',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
} as const

async function arm(page: Page) {
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable')
  const added = await client.send('WebAuthn.addVirtualAuthenticator', { options: authenticator })
  return { client, authenticatorId: added.authenticatorId }
}

test('adds a second passkey and will not remove the last one', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  const { client, authenticatorId } = await arm(page)
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill('Passkey Studio')
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()
  await page.goto('/app/sessions')
  const rows = page.getByTestId('passkey-row')
  await expect(rows).toHaveCount(1)
  await rows.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByTestId('passkeys')).toContainText('The last passkey stays')
  await expect(rows).toHaveCount(1)
  // A second passkey is a second device. The same authenticator refuses a credential it already holds.
  await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
  await client.send('WebAuthn.addVirtualAuthenticator', { options: authenticator })
  await page.getByRole('button', { name: 'Add a passkey' }).click()
  await expect(rows).toHaveCount(2)
  await rows.first().getByRole('button', { name: 'Remove' }).click()
  await expect(rows).toHaveCount(1)
  await expect(page.getByText('mnd_session')).toHaveCount(0)
  await page.waitForTimeout(1600)
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.page').analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
  await page.locator('.page').screenshot({ path: `${shots}/passkeys.png` })
})
