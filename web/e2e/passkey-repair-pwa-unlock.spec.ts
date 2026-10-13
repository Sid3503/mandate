import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const shots = '/Users/siddharth.mishra/Desktop/paypal-ai-hack/docs/evidence/q2'

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

test('PWA unlock with Face ID on expired session', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await arm(page)

  // Visit expired session unlock directly
  await page.goto('/app/unlock?reason=expired')
  const expiredBox = page.getByTestId('expired-session-box')
  await expect(expiredBox).toBeVisible()
  const faceIdBtn = page.getByTestId('unlock-faceid-btn')
  await expect(faceIdBtn).toBeVisible()
  await expect(faceIdBtn).toContainText('Unlock with Face ID')

  // Axe scan for expired unlock screen
  await page.waitForTimeout(1600)
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])

  // Capture screenshot of expired unlock screen
  await page.screenshot({ path: `${shots}/unlock-faceid.png` })

  // Register passkey via studio
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill('PWA FaceID Studio')
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()
  const workspace = await page.evaluate(() => sessionStorage.getItem('mandate.workspace'))

  // End session
  const logout = await page.request.post(`/w/${workspace}/auth/logout`, {
    headers: { origin: 'http://localhost:8777', 'x-mandate-client': 'web' },
  })
  expect(logout.status()).toBe(200)
  await page.evaluate(() => sessionStorage.clear())

  // Return to unlock with expired session
  await page.goto('/app/unlock?reason=expired')
  await expect(page.getByTestId('unlock-faceid-btn')).toBeVisible()
  await page.getByTestId('unlock-faceid-btn').click()

  // Successfully lands on Today
  await expect(page).toHaveURL(/\/app\/?$/)
  await expect(page.getByRole('heading', { name: /Today/i })).toBeVisible()
})
