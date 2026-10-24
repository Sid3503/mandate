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
  // The screen says which PayPal this studio moves money on, and keeps saying it after a reload. This server has
  // no PayPal, so the studio has none: it never pretends money moved.
  await expect(page.getByTestId('paypal-sim')).toContainText('not connected yet')
  await expect(page.getByRole('button', { name: 'Open Today' })).toHaveCount(0)
  const fingerprint = (await page.getByTestId('passkey-fingerprint').innerText()).trim()
  await page.reload()
  await expect(page.getByTestId('passkey-fingerprint')).toHaveText(fingerprint)
  await expect(page.getByTestId('paypal-sim')).toContainText('not connected yet')
  await expect(page.getByRole('button', { name: 'Add a second passkey' })).toBeVisible()
  await page.getByRole('button', { name: 'Create recovery codes' }).click()
  await expect(page.getByTestId('wizard-codes')).toBeVisible()
  await page.getByRole('button', { name: 'I saved these' }).click()
  await expect(page.getByTestId('wizard-codes')).toHaveCount(0)
  await page.getByRole('button', { name: 'Skip for now' }).click()
  // The words go to the server, so they are still there on the Rules screen.
  await page.getByLabel('Rules in words').fill('Pay a contractor only when the client has paid.')
  await page.getByRole('button', { name: 'Save these words' }).click()
  await expect(page.getByTestId('studio-done')).toContainText('Recovery codes are saved')
  await expect(page.getByTestId('studio-words-kept')).toBeVisible()
  await expect(page.getByTestId('paypal-sim')).toContainText('not connected yet')
  await page.waitForTimeout(1600)
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.unlock').analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
  await page.locator('.unlock').screenshot({ path: `${shots}/wizard.png` })

  // The Rules screen starts from those words, and says the studio has no rules yet.
  await page.getByRole('button', { name: 'Write your rules' }).click()
  await expect(page.getByTestId('rules-first')).toContainText('no rules yet')
  await expect(page.getByTestId('rules-words-kept')).toContainText('Pay a contractor only when the client has paid.')

  // Back to Today: the studio has its own name and its own first step.
  await page.goto('/app/')
  await expect(page.getByRole('heading', { level: 1, name: /today/i })).toBeVisible()
  await expect(page.getByTestId('story-rail')).toContainText('Write the rules your studio runs on')
  await expect(page.locator('.topbar')).toContainText('Wizard Studio')
})
