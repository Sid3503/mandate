import { expect, test } from '@playwright/test'

test('the production build ignores ?key= and ?mode= in the URL', async ({ page }) => {
  await page.goto('/app/welcome?key=untrusted_attacker_key&mode=demo')
  const storedKey = await page.evaluate(() => sessionStorage.getItem('mandate.apiKey'))
  expect(storedKey).toBeNull()
  const storedMode = await page.evaluate(() => sessionStorage.getItem('mandate.workspaceMode'))
  expect(storedMode).toBeNull()
})
