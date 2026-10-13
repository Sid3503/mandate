import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const shots = '/Users/siddharth.mishra/Desktop/paypal-ai-hack/docs/evidence/q2'

test('role landings for owner, proposer, viewer, client, payee with axe', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))

  // Start from welcome into demo
  await page.goto('/app/welcome')
  const demoDoor = page.getByTestId('door-demo')
  await expect(demoDoor).toBeVisible()
  await demoDoor.click()

  // 1. Owner lands on Today
  await expect(page).toHaveURL(/\/app\/?$/)
  await expect(page.getByRole('heading', { name: /Today/i })).toBeVisible()

  // 2. Switch to proposer -> lands on /clerk
  const proposerBtn = page.getByTestId('demo-role-proposer')
  await proposerBtn.click()
  await expect(page).toHaveURL(/\/app\/clerk$/)
  await expect(page.getByRole('heading', { name: 'Ask Mandate' })).toBeVisible()
  await expect(page.getByText('Proposer · can ask, not approve')).toBeVisible()

  // Navigating to /app/ directly as proposer redirects back to /app/clerk
  await page.goto('/app/')
  await expect(page).toHaveURL(/\/app\/clerk$/)

  // 3. Switch to viewer -> lands on /proof
  const viewerBtn = page.getByTestId('demo-role-viewer')
  await viewerBtn.click()
  await expect(page).toHaveURL(/\/app\/proof$/)
  await expect(page.getByRole('heading', { name: 'Proof' })).toBeVisible()

  // Navigating to /app/ directly as viewer redirects back to /app/proof
  await page.goto('/app/')
  await expect(page).toHaveURL(/\/app\/proof$/)

  // 4. Switch to payee -> lands on /payments
  const payeeBtn = page.getByTestId('demo-role-payee')
  await payeeBtn.click()
  await expect(page).toHaveURL(/\/app\/payments$/)
  await expect(page.getByRole('heading', { name: 'Your payments' })).toBeVisible()
  await expect(page.getByTestId('payee-payments-page')).toBeVisible()

  // Navigating to /app/ directly as payee redirects back to /app/payments
  await page.goto('/app/')
  await expect(page).toHaveURL(/\/app\/payments$/)

  // 5. Client landing on Deals
  await page.goto('/app/deals')
  await expect(page).toHaveURL(/\/app\/deals$/)
  await expect(page.getByRole('heading', { name: 'Deals', exact: true })).toBeVisible()

  // 6. Switch back to owner -> lands on Today
  const ownerBtn = page.getByTestId('demo-role-owner')
  await ownerBtn.click()
  await expect(page).toHaveURL(/\/app\/?$/)
  await expect(page.getByRole('heading', { name: /Today/i })).toBeVisible()

  // 7. Accessibility scan with axe
  await page.waitForTimeout(1600)
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])

  // Capture screenshot of payee landing
  await payeeBtn.click()
  await expect(page).toHaveURL(/\/app\/payments$/)
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${shots}/payee-landing.png` })
})
