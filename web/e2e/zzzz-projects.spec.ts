import { expect, test, type Page } from '@playwright/test'
import { deflateRawSync } from 'node:zlib'

const OWNER = 'owner-e2e-key-0123456789'

/**
 * Projects, paid on approval, in the browser. The client approves the plan on their link, sees the stage sealed with
 * its check, pays into a hold through the console's own card form (PayPal's script is a stand-in with the same shape),
 * and releases it; the files unlock. The server is the test server with the fake PayPal, so every step is the real
 * code path: the hold is placed by authorizing an AUTHORIZE order, and captured only by the client's release.
 */
const SDK_STUB = `
window.paypal = {
  createInstance: async () => ({
    findEligibleMethods: async () => ({ isEligible: () => true, getDetails: () => undefined }),
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

/** A real 1×1 PNG, made here so the test carries no binary file. Each seed gives different bytes. */
function png(seed: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2
  const zlibWrap = (raw: Buffer) => { const deflated = deflateRawSync(raw); let a = 1; let b = 0; for (const byte of raw) { a = (a + byte) % 65521; b = (b + a) % 65521 } const adler = Buffer.alloc(4); adler.writeUInt32BE(((b << 16) | a) >>> 0); return Buffer.concat([Buffer.from([0x78, 0x9c]), deflated, adler]) }
  const pixel = Buffer.from([0, seed % 256, (seed * 7) % 256, (seed * 13) % 256])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlibWrap(pixel)), chunk('IEND', Buffer.alloc(0))])
}

async function stubPayPal(page: Page) {
  await page.route('**/web-sdk/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: SDK_STUB }))
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

test('a client approves the plan, pays a sealed stage into a hold, and releases it; the files unlock', async ({ page, request }) => {
  await stubPayPal(page)
  const headers = { authorization: `Bearer ${OWNER}` }
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

  const made = await request.post('/v1/projects', { headers, data: {
    title: 'Brand identity for Kola Press', summary: 'Two paid stages.', clientName: `Kola Press ${tag}`, clientEmail: `hello+${tag}@kolapress.example`,
    currency: 'USD', category: 'design', reviewDays: 3, reviseDays: 3, brief: 'A logo and a brand kit.', briefSource: null, questions: [],
    stages: [
      { title: 'Logo concepts', description: '', deliverables: ['2 logo concepts'], amountCents: 15_000, dueDate: day(6) },
      { title: 'Brand kit', description: '', deliverables: ['Colours and fonts'], amountCents: 12_000, dueDate: day(14) },
    ],
  } })
  expect(made.status()).toBe(201)
  const project = await made.json()
  const sent = await (await request.post(`/v1/projects/${project.id}/send`, { headers, data: {} })).json()
  const path = new URL(sent.link.url).pathname + new URL(sent.link.url).search

  // The client: no key, no account. They approve the plan before any money moves.
  await page.goto(path)
  await expect(page.getByTestId('plan-review')).toBeVisible()
  await page.getByTestId('approve-plan').click()
  await expect(page.getByTestId('portal-stage')).toHaveCount(2)

  // The studio delivers stage 1, sealed. The bill goes through the gate; the owner taps it.
  const stageId = project.stages[0].id
  for (const [name, seed] of [['concept-1.png', 1], ['concept-2.png', 2]] as const) {
    const up = await request.post(`/v1/projects/${project.id}/stages/${stageId}/files`, { headers, multipart: { file: { name, mimeType: 'image/png', buffer: png(seed) } } })
    expect(up.status()).toBe(201)
  }
  const delivered = await (await request.post(`/v1/projects/${project.id}/stages/${stageId}/send`, { headers, data: {} })).json()
  const charge = delivered.stages[0].charge
  if (charge.phase === 'pending_approval') await request.post(`/v1/proposals/${charge.id}/approve`, { headers, data: { instrument: 'checkout' } })

  // Sealed, with the check, and a button that pays into a hold.
  await page.reload()
  const stage = page.getByTestId('portal-stage').first()
  await expect(stage.getByTestId('client-check')).toBeVisible()
  await expect(stage.locator('.seal-mark')).toHaveCount(2)
  await stage.getByTestId('pay-into-hold').click()
  await expect(page.getByText(/PayPal holds it on your side/)).toBeVisible()
  await page.getByTestId('pay-submit').click()
  await expect(stage.getByTestId('hold-banner')).toBeVisible()
  expect((await (await request.get(`/v1/proposals/${charge.id}`, { headers })).json()).phase).toBe('authorized')

  // The owner's own Settle cannot take held money.
  const grab = await request.post(`/v1/proposals/${charge.id}/capture`, { headers, data: {} })
  expect(grab.status()).toBe(409)

  // The client approves; the hold is captured and the files unlock.
  await stage.getByTestId('approve-release').click()
  await expect(stage).toHaveAttribute('data-status', 'released')
  await expect(stage.getByTestId('download-all')).toBeVisible()
  await stage.getByTestId('receipt').click()
  await expect(page.getByTestId('receipt-modal')).toContainText('You paid')
  expect((await (await request.get(`/v1/proposals/${charge.id}`, { headers })).json()).phase).toBe('captured')
})

test('the studio sees what it is owed, project by project, with its ledger', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
  await page.goto('/app/unlock')
  await page.getByLabel('API key').fill(OWNER)
  await page.getByRole('button', { name: 'Unlock console' }).click()
  await expect(page.getByRole('heading', { name: /Waiting for you/ })).toBeVisible()
  await page.goto('/app/projects')
  await expect(page.getByTestId('owed-headline')).toBeVisible()
  await expect(page.getByTestId('project-row').first()).toBeVisible()
  await expect(page.getByTestId('stage-ledger')).toBeVisible()
})
