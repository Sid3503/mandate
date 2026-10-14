import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const shots = fileURLToPath(new URL('../../docs/evidence/q2', import.meta.url))

test('welcome headline, one line of proof, three doors, and trust strip', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.goto('/app/welcome')

  // Headline
  const h1 = page.getByRole('heading', { level: 1 })
  await expect(h1).toContainText('Agents can ask.')
  await expect(h1).toContainText('Only you can pay.')

  // Three doors container
  const doors = page.getByTestId('three-doors')
  await expect(doors).toBeVisible()

  // Primary door: Try the demo
  const demoDoor = page.getByTestId('door-demo')
  await expect(demoDoor).toBeVisible()
  await expect(demoDoor).toContainText('Try the demo')

  // Second door: Create your studio
  const studioDoor = page.getByTestId('door-studio')
  await expect(studioDoor).toBeVisible()
  await expect(studioDoor).toContainText('Create your studio')
  await expect(studioDoor).toHaveAttribute('href', '/app/studio')

  // Third door: I have a key (small link)
  const keyDoor = page.getByTestId('door-key')
  await expect(keyDoor).toBeVisible()
  await expect(keyDoor).toContainText('I have a key')
  await expect(keyDoor).toHaveAttribute('href', '/app/unlock')

  // Trust strip
  const trustStrip = page.getByTestId('trust-strip')
  await expect(trustStrip).toBeVisible()
  await expect(trustStrip).toContainText('Sandbox only')
  await expect(trustStrip).toContainText('AI cannot move money')
  const verifyLink = trustStrip.getByRole('link', { name: 'Check any receipt yourself' })
  await expect(verifyLink).toBeVisible()
  await expect(verifyLink).toHaveAttribute('href', '/app/verify')

  // Accessibility scan with axe
  await page.waitForTimeout(1600)
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])

  await page.screenshot({ path: `${shots}/doors.png` })
})
