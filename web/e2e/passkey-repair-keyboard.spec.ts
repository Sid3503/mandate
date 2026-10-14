import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const shots = fileURLToPath(new URL('../../docs/evidence/q8', import.meta.url))

const authenticator = {
  protocol: 'ctap2',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
} as const

async function arm(page: Page) {
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable')
  const added = await client.send('WebAuthn.addVirtualAuthenticator', { options: authenticator })
  return { client, authenticatorId: added.authenticatorId }
}

test('passkey keyboard walk: studio creation, unlock sign-in, and passkey management using keyboard only', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  const { client, authenticatorId } = await arm(page)

  // 1. Studio registration via keyboard navigation only
  await page.goto('/app/studio')
  await page.waitForLoadState('networkidle')

  // Tab into the form input
  let focusedInput = false
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press('Tab')
    const tag = await page.evaluate(() => document.activeElement?.tagName)
    const label = await page.evaluate(() => (document.activeElement as HTMLInputElement)?.name || (document.activeElement as HTMLInputElement)?.id)
    if (tag === 'INPUT') {
      focusedInput = true
      break
    }
  }
  expect(focusedInput).toBe(true)
  await page.keyboard.type('Keyboard Studio')

  // Tab to the submit button
  let focusedSubmit = false
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Tab')
    const text = await page.evaluate(() => document.activeElement?.textContent ?? '')
    if (text.includes('Create and save a passkey')) {
      focusedSubmit = true
      break
    }
  }
  expect(focusedSubmit).toBe(true)

  // Activate submit with Enter
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()

  // 2. Sign out and sign in with passkey via keyboard only
  const workspace = await page.evaluate(() => sessionStorage.getItem('mandate.workspace'))
  const logout = await page.request.post(`/w/${workspace}/auth/logout`, {
    headers: { origin: 'http://localhost:8777', 'x-mandate-client': 'web' },
  })
  expect(logout.status()).toBe(200)
  await page.evaluate(() => sessionStorage.clear())

  await page.goto('/app/unlock')
  await page.waitForLoadState('networkidle')

  // Tab until "Sign in with a passkey" button is focused
  let focusedPasskeyBtn = false
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press('Tab')
    const text = await page.evaluate(() => document.activeElement?.textContent ?? '')
    if (text.includes('Sign in with a passkey') || text.includes('Unlock with Face ID')) {
      focusedPasskeyBtn = true
      break
    }
  }
  expect(focusedPasskeyBtn).toBe(true)

  // Activate with Enter key
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: /Today/ })).toBeVisible()

  // 3. Navigate to sessions and manage passkeys via keyboard only
  await page.goto('/app/sessions')
  await page.waitForLoadState('networkidle')

  const rows = page.getByTestId('passkey-row')
  await expect(rows).toHaveCount(1)

  // Swap virtual authenticator so a second credential can be stored
  await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
  await client.send('WebAuthn.addVirtualAuthenticator', { options: authenticator })

  // Tab until "Add a passkey" button is focused
  let focusedAddPasskey = false
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press('Tab')
    const text = await page.evaluate(() => document.activeElement?.textContent ?? '')
    if (text.includes('Add a passkey')) {
      focusedAddPasskey = true
      break
    }
  }
  expect(focusedAddPasskey).toBe(true)

  // Activate with Enter key
  await page.keyboard.press('Enter')
  await expect(rows).toHaveCount(2)

  // Shift+Tab back to the Remove button on a passkey row
  let focusedRemove = false
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press('Shift+Tab')
    const text = await page.evaluate(() => document.activeElement?.textContent ?? '')
    if (text.trim() === 'Remove') {
      focusedRemove = true
      break
    }
  }
  expect(focusedRemove).toBe(true)

  // Activate Remove with Enter key
  await page.keyboard.press('Enter')
  await expect(rows).toHaveCount(1)

  // Run axe accessibility scan on keyboard-navigated passkey screen
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.page').analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])

  await page.locator('.page').screenshot({ path: `${shots}/passkey-keyboard.png` })
})
