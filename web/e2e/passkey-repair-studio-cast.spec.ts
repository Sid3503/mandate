import { expect, test, type Browser, type Page } from '@playwright/test'

/**
 * Two owners, two clients, two contractors. Each studio must keep its own cast after the rules are published.
 * The demo's Northwind job must not appear in either.
 */
const STUDIOS = [
  {
    studio: 'Harbor Studio',
    client: 'Harbor Foods',
    clientEmail: 'accounts@harborfoods.test',
    payee: 'Ava Chen',
    payeeEmail: 'ava@harbor.test',
    work: 'Logo and brand design',
    rule: 'Pay Ava 60% of what Harbor Foods pays, and only after the logo is delivered.',
    share: '60',
  },
  {
    studio: 'Northline Build',
    client: 'Kepler Hotels',
    clientEmail: 'pay@keplerhotels.test',
    payee: 'Luis Ortega',
    payeeEmail: 'luis@northline.test',
    work: 'Hotel photography',
    rule: 'Pay Luis half of what Kepler Hotels pays, and only after the photos are delivered.',
    share: '50',
  },
] as const

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

async function setup(browser: Browser, studio: (typeof STUDIOS)[number]) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await arm(page)
  await page.goto('/app/studio')
  await page.getByLabel('Studio name').fill(studio.studio)
  await page.getByRole('button', { name: 'Create and save a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Studio ready' })).toBeVisible()
  await page.getByRole('button', { name: 'Create recovery codes' }).click()
  await expect(page.getByTestId('wizard-codes')).toBeVisible()
  await page.getByRole('button', { name: 'I saved these' }).click()
  await expect(page.getByTestId('studio-people')).toBeVisible()
  await page.getByLabel('Client you bill').fill(studio.client)
  await page.getByLabel('Client email').fill(studio.clientEmail)
  await page.getByLabel('Contractor you pay').fill(studio.payee)
  await page.getByLabel('Contractor email').fill(studio.payeeEmail)
  await page.getByLabel('What you do').fill(studio.work)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByLabel('Rules in words')).toBeVisible()
  await page.getByLabel('Rules in words').fill(studio.rule)
  await page.getByRole('button', { name: 'Save these words' }).click()
  await expect(page.getByTestId('studio-cast')).toContainText(studio.client)
  await expect(page.getByTestId('studio-cast')).toContainText(studio.payee)
  await expect(page.getByTestId('studio-cast')).toContainText(studio.work)
  await page.getByRole('button', { name: 'Write your rules' }).click()
  await expect(page.getByTestId('rules-people').getByLabel('Client name')).toHaveValue(studio.client)
  await expect(page.getByTestId('rules-people').getByLabel('Client email')).toHaveValue(studio.clientEmail)
  await expect(page.getByTestId('rules-people').getByLabel('Contractor name')).toHaveValue(studio.payee)
  await expect(page.getByTestId('rules-people').getByLabel('Contractor email')).toHaveValue(studio.payeeEmail)
  await expect(page.getByTestId('rules-words-kept')).toContainText(studio.rule)
  await expect(page.getByTestId('rules-words-kept')).toContainText(studio.clientEmail)
  await expect(page.getByTestId('rules-words-kept')).toContainText(studio.payeeEmail)
  await page.getByRole('button', { name: 'Write them myself' }).click()
  // The first version starts with no amounts: the owner chooses them. The kind of work comes from their own words.
  await expect(page.getByLabel('Automatic under')).toHaveValue('')
  await expect(page.getByLabel('Allowed work, comma separated')).toHaveValue(studio.work.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
  await page.getByLabel('Automatic under').fill('25')
  await page.getByLabel('Monthly contractor cap').fill('2000')
  await page.getByLabel('Per-payment ceiling').fill('1500')
  await page.getByLabel('Contractor share of client money').fill(studio.share)
  await page.getByRole('button', { name: 'Review changes' }).click()
  await page.getByRole('button', { name: 'Publish version 1' }).click()
  await expect(page.getByTestId('rules-glance')).toBeVisible()
  await expect(page.getByText(`${studio.client} (client_`)).toBeVisible()
  await expect(page.getByText(`${studio.payee} (payee_`)).toBeVisible()
  await expect(page.getByText(`${studio.share}%`).first()).toBeVisible()
  await page.goto('/app/')
  await expect(page.getByTestId('you-are')).toContainText(studio.studio)
  await expect(page.getByTestId('today-next')).toContainText('Set the least')
  await expect(page.getByTestId('today-next')).not.toContainText('Northwind')
  await expect(page.getByTestId('today-next')).not.toContainText('Priya')
  await expect(page.getByTestId('today-next')).not.toContainText('$300')
  const body = await page.locator('body').innerText()
  expect(body).not.toContain('Priya')
  expect(body).not.toContain('Northwind')
  return { context, page }
}

test('two studios each keep their own client and contractor', async ({ browser }) => {
  test.setTimeout(180_000)
  const first = await setup(browser, STUDIOS[0])
  const second = await setup(browser, STUDIOS[1])
  await first.page.goto('/app/rules')
  await expect(first.page.getByText('Harbor Foods (client_')).toBeVisible()
  await expect(first.page.getByText('Kepler Hotels')).toHaveCount(0)
  await expect(first.page.getByText('Luis Ortega')).toHaveCount(0)
  await second.page.goto('/app/rules')
  await expect(second.page.getByText('Kepler Hotels (client_')).toBeVisible()
  await expect(second.page.getByText('Harbor Foods')).toHaveCount(0)
  await expect(second.page.getByText('Ava Chen')).toHaveCount(0)
  await first.context.close()
  await second.context.close()
})
