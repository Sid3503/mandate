import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const shots = '/Users/siddharth.mishra/Desktop/paypal-ai-hack/docs/evidence/q2'

test('demo start, demo banner, role switcher, reset, and live proof page', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))

  // Start from welcome
  await page.goto('/app/welcome')
  const demoDoor = page.getByTestId('door-demo')
  await expect(demoDoor).toBeVisible()
  await demoDoor.click()

  // Lands on Today with demo banner
  await expect(page).toHaveURL(/\/app\/?$/)
  const banner = page.getByTestId('demo-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('Simulated PayPal. No real money.')

  // Role switcher
  const switcher = page.getByTestId('demo-role-switcher')
  await expect(switcher).toBeVisible()

  // Switch to proposer
  const proposerBtn = page.getByTestId('demo-role-proposer')
  await proposerBtn.click()
  await expect(page).toHaveURL(/\/app\/clerk$/)
  await expect(page.getByText('Proposer · can ask, not approve')).toBeVisible()

  // Switch to viewer
  const viewerBtn = page.getByTestId('demo-role-viewer')
  await viewerBtn.click()
  await expect(page).toHaveURL(/\/app\/proof$/)

  // Switch back to owner
  const ownerBtn = page.getByTestId('demo-role-owner')
  await ownerBtn.click()
  await expect(page).toHaveURL(/\/app\/?$/)

  // Navigate to Live proof
  const liveProofLink = page.getByTestId('live-proof-link')
  await expect(liveProofLink).toBeVisible()
  await liveProofLink.click()
  await expect(page).toHaveURL(/\/app\/live-proof$/)
  await expect(page.getByTestId('live-proof-panel')).toBeVisible()
  await expect(page.getByTestId('live-proof-empty')).toContainText('not added yet')

  // Accessibility scan with axe
  await page.waitForTimeout(1600)
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])

  // Capture screenshot of demo banner & live proof
  await page.goto('/app/')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${shots}/demo-banner.png` })
})
