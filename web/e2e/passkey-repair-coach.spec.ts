import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const shots = '/Users/siddharth.mishra/Desktop/paypal-ai-hack/docs/evidence/q2'

test('first-run 3-mark coach tour and screen states with axe', async ({ page }) => {
  mkdirSync(shots, { recursive: true })

  // Clean state: no coach seen flag
  await page.goto('/app/welcome')
  await page.evaluate(() => {
    localStorage.removeItem('mandate.tour.welcome')
    localStorage.removeItem('mandate.coach.seen')
  })
  const demoDoor = page.getByTestId('door-demo')
  await expect(demoDoor).toBeVisible()
  await demoDoor.click()

  // Lands on Today and the coach tour opens (at most 3 marks)
  await expect(page).toHaveURL(/\/app\/?$/)

  const card = page.locator('.tour-card')
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card).toContainText('What needs you')
  await expect(card).toContainText('Step 1 of 3')

  // Capture screenshot of first coach mark
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${shots}/coach-marks.png` })

  // Advance to mark 2
  const nextBtn = card.locator('[data-tour-primary]')
  await nextBtn.click()
  await expect(card).toContainText('Agents can ask')
  await expect(card).toContainText('Step 2 of 3')

  // Advance to mark 3
  await nextBtn.click()
  await expect(card).toContainText('Rules guard every dollar')
  await expect(card).toContainText('Step 3 of 3')

  // Finish tour via Done button
  await nextBtn.click()
  await expect(card).toBeHidden()

  // Verify mandate.coach.seen is set
  const seen = await page.evaluate(() => localStorage.getItem('mandate.coach.seen'))
  expect(seen).toBe('1')

  // Reload page: coach does not show again
  await page.reload()
  await page.waitForTimeout(1000)
  await expect(card).toBeHidden()

  // Test screen states on LiveProof: empty state
  await page.goto('/app/live-proof')
  await expect(page.getByTestId('live-proof-empty')).toBeVisible()
  await expect(page.getByTestId('live-proof-empty')).toContainText('not added yet')

  // Test screen states on PayeePayments: empty state
  await page.goto('/app/payments')
  await expect(page.getByTestId('payee-payments-page')).toBeVisible()
  await expect(page.getByText('No payments yet')).toBeVisible()

  // Axe scan
  await page.waitForTimeout(1600)
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
})
