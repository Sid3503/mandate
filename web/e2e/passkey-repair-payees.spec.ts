import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { currentWorkspace, attestPayee, writeFirstRules } from './studio'

const shots = fileURLToPath(new URL('../../docs/evidence/q4', import.meta.url))

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

test('payee screen with history, diagnostics card, and account change form', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await arm(page)

  // Set up studio owner
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill('Payee Studio')
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()

  // A new studio starts empty: the owner writes the rules, and the people on them are the studio's payees.
  const workspace = await currentWorkspace(page)
  await writeFirstRules(page, workspace)

  // Navigate to Payees screen
  await page.goto('/app/payees')
  const pageContainer = page.getByTestId('payees-page')
  await expect(pageContainer).toBeVisible()

  // The contractor the owner just wrote into the rules is on the list, and waits first: nobody has paid them before.
  const list = page.getByTestId('payees-list')
  await expect(list).toBeVisible()
  const priyaRow = page.getByTestId('payee-row-payee_priya')
  await expect(priyaRow).toBeVisible()
  await expect(priyaRow).toContainText('Priya Shah')
  await expect(priyaRow).toContainText('Cooling')

  // Verify diagnostic card: "Why can I not pay this account?"
  const diagCard = page.getByTestId('payee-diagnostic-card')
  await expect(diagCard).toBeVisible()
  await expect(diagCard).toContainText('Why can I not pay this account?')
  await expect(diagCard).toContainText('cooling period')
  const diagReason = page.getByTestId('payee-diagnostic-reason')
  await expect(diagReason).toBeVisible()

  // The owner attests it with a passkey, and it becomes payable.
  await attestPayee(page, workspace, 'payee_priya')
  await page.reload()
  await expect(page.getByTestId('payee-row-payee_priya')).toContainText('Active')

  // Verify Payout History section
  const history = page.getByTestId('payee-history')
  await expect(history).toBeVisible()
  await expect(history).toContainText('Payout History')

  // Open "Change payout account" form
  const changeBtn = page.getByTestId('change-account-btn')
  await expect(changeBtn).toBeVisible()
  await changeBtn.click()

  const changeForm = page.getByTestId('change-account-form')
  await expect(changeForm).toBeVisible()
  await expect(page.getByTestId('new-email-input')).toBeVisible()
  await expect(page.getByTestId('submit-change-btn')).toBeVisible()

  // Axe accessibility check
  await page.waitForTimeout(1000)
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .include('.payees-screen')
    .analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])

  // Capture evidence screenshot
  await page.screenshot({ path: `${shots}/payees.png`, fullPage: true })
})
