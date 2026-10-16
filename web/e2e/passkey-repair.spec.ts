import { expect, test, type Page } from '@playwright/test'

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

async function createStudio(page: Page, name: string) {
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill(name)
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()
  const workspace = await page.evaluate(() => sessionStorage.getItem('mandate.workspace'))
  expect(workspace).toBeTruthy()
  return workspace as string
}

test('a cookie from a finished session fails after logout', async ({ page, playwright }) => {
  await arm(page)
  const workspace = await createStudio(page, 'Repair Studio')
  const before = (await page.context().cookies()).find((cookie) => cookie.name === 'mnd_session')
  expect(before?.value).toBeTruthy()
  const live = await page.request.get(`/w/${workspace}/auth/me`)
  expect(live.status()).toBe(200)
  const logout = await page.request.post(`/w/${workspace}/auth/logout`, {
    headers: { origin: 'http://localhost:8777', 'x-mandate-client': 'web' },
  })
  expect(logout.status()).toBe(200)
  const api = await playwright.request.newContext()
  const again = await api.get(`http://localhost:8777/w/${workspace}/auth/me`, {
    headers: { cookie: `mnd_session=${before?.value}` },
  })
  expect(again.status()).toBe(401)
  await api.dispose()
})

test('a cookie planted before login is not the session after login', async ({ page, playwright }) => {
  const planted = 'planted-session-cookie-value-32'
  await page.context().addCookies([{ name: 'mnd_session', value: planted, url: 'http://localhost:8777' }])
  await arm(page)
  const workspace = await createStudio(page, 'Second Studio')
  const api = await playwright.request.newContext()
  const old = await api.get(`http://localhost:8777/w/${workspace}/auth/me`, {
    headers: { cookie: `mnd_session=${planted}` },
  })
  expect([401, 404]).toContain(old.status())
  const real = await page.request.get(`/w/${workspace}/auth/me`)
  expect(real.status()).toBe(200)
  await api.dispose()
})
