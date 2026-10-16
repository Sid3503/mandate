import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const shots = fileURLToPath(new URL('../../docs/evidence/q1', import.meta.url))

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

test('an invite names the inviter and the role, and a revoke blocks it', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await arm(page)
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill('Invite Studio')
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()
  const workspace = await page.evaluate(() => sessionStorage.getItem('mandate.workspace'))
  await page.goto('/app/sessions')
  await page.getByRole('button', { name: 'Invite a proposer' }).click()
  await expect(page.getByTestId('invites')).toContainText('Invite ready for a proposer.')
  await page.getByRole('button', { name: 'Revoke this invite' }).click()
  await expect(page.getByTestId('invites')).toContainText('No invite is waiting.')
  const pending = page.waitForResponse((res) => res.url().includes('/v1/invites') && res.request().method() === 'POST' && !res.url().includes('revoke'))
  await page.getByRole('button', { name: 'Invite a proposer' }).click()
  const made = await pending
  expect(made.ok()).toBeTruthy()
  const token = (await made.json() as { token: string }).token
  expect(token.length).toBeGreaterThan(20)
  await page.goto(`/app/join#t=${encodeURIComponent(token)}`)
  await page.getByRole('button', { name: 'Show this invite' }).click()
  await expect(page.getByTestId('invite-who')).toContainText('Invited by Owner')
  await expect(page.getByTestId('invite-role')).toContainText('Staff can ask')
  await expect(page.getByText(token)).toHaveCount(0)
  await page.waitForTimeout(1600)
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.unlock').analyze()
  expect(scan.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
  await page.locator('.unlock').screenshot({ path: `${shots}/invite.png` })
  const revoked = await page.request.post(`/w/${workspace}/v1/invites/revoke`, {
    data: { token },
    headers: { origin: 'http://localhost:8777', 'x-mandate-client': 'web' },
  })
  expect(revoked.ok()).toBeTruthy()
  await page.reload()
  await page.getByRole('button', { name: 'Show this invite' }).click()
  await expect(page.getByText('Invite is not valid')).toBeVisible()
})
