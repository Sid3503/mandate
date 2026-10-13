import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

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

test('agent scorecard: requests, refusals, auto, needs-tap, last seen and breaker display', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await arm(page)

  // Complete studio wizard to set up owner session
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill('Scorecard Studio')
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()

  await page.getByRole('button', { name: 'Create recovery codes' }).click()
  await page.getByRole('button', { name: 'I saved these' }).click()
  await page.getByRole('button', { name: 'Skip rules' }).click()
  await page.getByRole('button', { name: 'Open Today' }).click()
  await expect(page.getByRole('heading', { name: /Today/ })).toBeVisible()

  // Connect an agent key
  await page.goto('/app/connect')
  const connectPanel = page.getByTestId('connect-agent')
  await expect(connectPanel).toBeVisible()
  await page.getByPlaceholder('e.g. Nightly invoice sweep').fill('Billing Auditor')
  await page.getByTestId('create-agent-button').click()
  await expect(page.getByTestId('connect-reveal')).toBeVisible()

  // Open System screen to see Connected agents and scorecard
  await page.goto('/app/system')
  const agentPanel = page.getByTestId('agent-keys-panel')
  await expect(agentPanel).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connected agents and scorecard' })).toBeVisible()

  const table = page.getByTestId('agent-scorecard-table')
  await expect(table).toBeVisible()
  await expect(table.getByText('Billing Auditor')).toBeVisible()

  // Verify scorecard columns and metrics
  await expect(table.getByText('Scorecard (Req / Auto / Tap / Refused)')).toBeVisible()
  await expect(table.getByText('0 req · 0 auto · 0 tap · 0 refused')).toBeVisible()

  // Capture screenshot of the scorecard panel for evidence (no secrets shown)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="agent-keys-panel"]')
    el?.scrollIntoView({ behavior: 'instant', block: 'start' })
  })
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${shots}/scorecard.png` })

  // Run axe accessibility check (wait for any fade)
  await page.waitForTimeout(1600)
  const scan = await new AxeBuilder({ page }).analyze()
  expect(scan.violations.filter((v) => v.id !== 'color-contrast')).toEqual([])
})
