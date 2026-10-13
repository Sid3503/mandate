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

test('signs in again with the same passkey after the session ends', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await arm(page)
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill('Login Studio')
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()
  const workspace = await page.evaluate(() => sessionStorage.getItem('mandate.workspace'))
  const logout = await page.request.post(`/w/${workspace}/auth/logout`, {
    headers: { origin: 'http://localhost:8777', 'x-mandate-client': 'web' },
  })
  expect(logout.status()).toBe(200)
  await page.evaluate(() => sessionStorage.clear())
  await page.goto('/app/unlock')
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(page.getByRole('heading', { name: /Today/ })).toBeVisible()
  await page.goto('/app/sessions')
  await expect(page.getByText('This session')).toBeVisible()
  await expect(page.getByText('ended')).toBeVisible()
  await expect(page.getByText('mnd_session')).toHaveCount(0)
  await page.waitForTimeout(1600)
  await page.locator('.page').screenshot({ path: `${shots}/passkey-login.png` })
})
