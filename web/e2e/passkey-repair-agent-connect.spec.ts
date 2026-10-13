import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const shots = '/Users/siddharth.mishra/Desktop/paypal-ai-hack/docs/evidence/q1'

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

test('connect-an-agent template wizard, scopes, can-and-cannot preview, expiry, and key testing', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await arm(page)

  // Set up studio owner
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill('Agent Connect Studio')
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()

  // Navigate to Connect screen
  await page.goto('/app/connect')
  const panel = page.getByTestId('connect-agent')
  await expect(panel).toBeVisible()

  // Check templates exist
  await expect(panel.getByText('Read and ask')).toBeVisible()
  await expect(panel.getByText('Read only')).toBeVisible()
  await expect(panel.getByText('Read, ask and negotiate')).toBeVisible()

  // Check scope checklist and can-and-cannot preview
  const preview = page.getByTestId('can-and-cannot-preview')
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('Can do')
  await expect(preview).toContainText('Cannot do')

  // Name the agent
  await page.getByPlaceholder('e.g. Nightly invoice sweep').fill('Nightly Invoice Agent')

  // Check expiry selection
  const expirySelect = page.getByTestId('connect-expiry')
  await expect(expirySelect).toBeVisible()
  await expirySelect.selectOption('90')

  // Create key
  await page.getByTestId('create-agent-button').click()

  // Verify reveal
  const reveal = page.getByTestId('connect-reveal')
  await expect(reveal).toBeVisible()
  await expect(page.getByTestId('connect-key')).toBeVisible()
  await expect(reveal).toContainText('claude mcp add --transport http mandate')

  // Test the key
  const testBtn = page.getByTestId('test-this-key')
  await expect(testBtn).toBeVisible()
  await testBtn.click()
  await expect(page.getByTestId('connect-check-ok')).toBeVisible()

  await page.waitForTimeout(1600)
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.page').analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
  await page.locator('.page').screenshot({ path: `${shots}/connect-agent.png` })
})
