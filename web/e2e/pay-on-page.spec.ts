import { expect, test, type Page } from '@playwright/test'

const OWNER = 'owner-e2e-key-0123456789'
// Its own job: a charge on the shared job would fund another spec's payout by mistake.
const JOB = 'job_embedded_pay'
const EVIDENCE = 'https://www.figma.com/file/northwind-logo'

/**
 * Paying a bill on our own page.
 *
 * PayPal's script is replaced with a stand-in that has the same shape the console uses, so the test drives the real
 * console code: the server makes the order from the lock, the browser holds only an order id and a browser-safe
 * token, and the server does the capture after re-reading the order and checking it against the lock.
 */
const SDK_STUB = `
window.paypal = {
  createInstance: async () => ({
    findEligibleMethods: async () => ({ isEligible: () => true }),
    createCardFieldsOneTimePaymentSession: () => ({
      createCardFieldsComponent: (options) => {
        const field = document.createElement('input')
        field.setAttribute('data-paypal-field', options.type)
        field.setAttribute('placeholder', options.placeholder || options.type)
        return field
      },
      submit: async (orderId) => ({ state: 'succeeded', data: { orderId, liabilityShift: 'POSSIBLE' } }),
    }),
  }),
}
`

async function stubPayPal(page: Page) {
  await page.route('**/web-sdk/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: SDK_STUB }))
}

async function unlock(page: Page, key: string) {
  await page.goto('/app/unlock')
  await page.getByLabel('API key').fill(key)
  await page.getByRole('button', { name: 'Unlock console' }).click()
  await expect(page.getByRole('heading', { name: /Waiting for you/ })).toBeVisible()
}

test('a client pays a locked bill on the page, without leaving it', async ({ page, request }) => {
  await stubPayPal(page)
  const headers = { authorization: `Bearer ${OWNER}` }

  // A bill the owner approved to be paid on our own page.
  const asked = await (await request.post('/v1/proposals', {
    headers: { ...headers, 'idempotency-key': 'embedded-pay-0001' },
    data: { kind: 'charge', payee: 'Northwind', amountCents: 25_000, currency: 'USD', category: 'design', description: 'Northwind logo milestone 1', evidenceUrl: EVIDENCE, jobId: JOB },
  })).json()
  const approved = await (await request.post(`/v1/proposals/${asked.id}/approve`, { headers, data: { instrument: 'checkout' } })).json()
  expect(approved.payInstrument).toBe('checkout')
  expect(approved.phase).toBe('locked')

  // A link the client may pay with.
  const share = await (await request.post(`/v1/jobs/${JOB}/shares`, { headers, data: { partyId: 'client_northwind', canPay: true, ttlDays: 30 } })).json()
  expect(share.token).toBeTruthy()

  // The client opens their page. No key, no sign-in.
  await page.goto(`/app/s/${share.token}`)
  await expect(page.getByRole('heading', { name: /Your invoices on this job/ })).toBeVisible()
  await expect(page.getByText('You can pay what is due here, without leaving this page.')).toBeVisible()

  // They press Pay here, and the card form appears in our page.
  await page.getByRole('button', { name: 'Pay here' }).click()
  await expect(page.getByTestId('pay-panel')).toBeVisible()
  await expect(page.getByTestId('pay-field-number')).toBeVisible()
  await expect(page.getByText('This amount is locked. It will not change while you pay.')).toBeVisible()

  // They pay.
  await page.getByTestId('pay-submit').click()
  await expect(page.getByTestId('pay-done')).toBeVisible()
  await expect(page.getByTestId('pay-done')).toContainText('Paid')

  // The server settled it, and the cents match the lock.
  const settled = await (await request.get(`/v1/proposals/${asked.id}`, { headers })).json()
  expect(settled.phase).toBe('captured')
  expect(settled.capturedAmountCents).toBe(25_000)
})

test('a link that may only look cannot pay', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${OWNER}` }
  const asked = await (await request.post('/v1/proposals', {
    headers: { ...headers, 'idempotency-key': 'embedded-pay-0002' },
    data: { kind: 'charge', payee: 'Northwind', amountCents: 27_000, currency: 'USD', category: 'design', description: 'Read only bill', evidenceUrl: EVIDENCE, jobId: JOB },
  })).json()
  await (await request.post(`/v1/proposals/${asked.id}/approve`, { headers, data: { instrument: 'checkout' } })).json()
  const share = await (await request.post(`/v1/jobs/${JOB}/shares`, { headers, data: { partyId: 'client_northwind', canPay: false, ttlDays: 30 } })).json()

  await page.goto(`/app/s/${share.token}`)
  await expect(page.getByText('You can only look; nothing here can move money.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pay here' })).toHaveCount(0)
})

test('the owner can pay a bill themselves on the receipt', async ({ page, request }) => {
  await stubPayPal(page)
  const headers = { authorization: `Bearer ${OWNER}` }
  const asked = await (await request.post('/v1/proposals', {
    headers: { ...headers, 'idempotency-key': 'embedded-pay-0003' },
    data: { kind: 'charge', payee: 'Northwind', amountCents: 29_000, currency: 'USD', category: 'design', description: 'Owner pays this one', evidenceUrl: EVIDENCE, jobId: JOB },
  })).json()
  await (await request.post(`/v1/proposals/${asked.id}/approve`, { headers, data: { instrument: 'checkout' } })).json()

  await unlock(page, OWNER)
  await page.goto(`/app/p/${asked.id}`)
  await page.getByTestId('pay-here-owner-button').click()
  await expect(page.getByTestId('pay-panel')).toBeVisible()
  await page.getByTestId('pay-submit').click()

  // The receipt settles, so the panel gives way to the settled receipt.
  await expect(page.getByTestId('pay-here-owner')).toHaveCount(0, { timeout: 20_000 })
  const settled = await (await request.get(`/v1/proposals/${asked.id}`, { headers })).json()
  expect(settled.phase).toBe('captured')
  expect(settled.capturedAmountCents).toBe(29_000)
})

/**
 * PayPal's own card form refuses to send a card it can tell is wrong (a mistyped number), and it says so by throwing.
 * The buyer is told which field, in their words, and what they typed survives the page refreshing itself: opening the
 * form opens an order, which moves the bill, and that must not remount the form.
 */
const SDK_REFUSES_ONCE = `
let tries = 0
window.paypal = {
  createInstance: async () => ({
    findEligibleMethods: async () => ({ isEligible: () => true }),
    createCardFieldsOneTimePaymentSession: () => ({
      createCardFieldsComponent: (options) => {
        const field = document.createElement('input')
        field.setAttribute('data-paypal-field', options.type)
        field.setAttribute('placeholder', options.placeholder || options.type)
        return field
      },
      submit: async (orderId) => {
        tries += 1
        if (tries === 1) {
          const error = new Error('CardFields form submit failed: "Invalid card data: card number field is empty or invalid"')
          error.name = 'SdkInitError'
          error.code = 'ERR_INIT_CARD_FIELDS_SUBMIT_EVENT'
          throw error
        }
        return { state: 'succeeded', data: { orderId } }
      },
    }),
  }),
}
`

test('a mistyped card is named, and what was typed survives the page refreshing', async ({ page, request }) => {
  await page.route('**/web-sdk/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: SDK_REFUSES_ONCE }))
  const headers = { authorization: `Bearer ${OWNER}` }
  const asked = await (await request.post('/v1/proposals', {
    headers: { ...headers, 'idempotency-key': 'embedded-pay-0004' },
    data: { kind: 'charge', payee: 'Northwind', amountCents: 31_000, currency: 'USD', category: 'design', description: 'Mistyped card bill', evidenceUrl: EVIDENCE, jobId: JOB },
  })).json()
  await (await request.post(`/v1/proposals/${asked.id}/approve`, { headers, data: { instrument: 'checkout' } })).json()
  const share = await (await request.post(`/v1/jobs/${JOB}/shares`, { headers, data: { partyId: 'client_northwind', canPay: true, ttlDays: 30 } })).json()

  await page.goto(`/app/s/${share.token}`)
  const bill = page.locator('li', { hasText: 'Mistyped card bill' })
  await bill.getByRole('button', { name: 'Pay here' }).click()
  const number = page.locator('[data-paypal-field="number"]')
  await number.fill('4032 0393 1798 4309')

  await page.getByTestId('pay-submit').click()
  await expect(page.getByRole('alert')).toHaveText('The card number is missing or not valid. Check it and try again. Nothing was charged.')

  // The page refreshes itself. The order the form opened moved the bill, and the form must stay as the buyer left it.
  await page.waitForResponse((response) => response.url().includes(`/v1/share/${share.token}`) && response.request().method() === 'GET', { timeout: 20_000 })
  await expect(number).toHaveValue('4032 0393 1798 4309')
  await expect(page.getByRole('alert')).toBeVisible()

  // Nothing was charged by the refusal.
  const before = await (await request.get(`/v1/proposals/${asked.id}`, { headers })).json()
  expect(before.phase).not.toBe('captured')

  // They fix it and pay.
  await number.fill('4111 1111 1111 1111')
  await page.getByTestId('pay-submit').click()
  await expect(page.getByTestId('pay-done')).toBeVisible()
  const settled = await (await request.get(`/v1/proposals/${asked.id}`, { headers })).json()
  expect(settled.phase).toBe('captured')
  expect(settled.capturedAmountCents).toBe(31_000)
})
