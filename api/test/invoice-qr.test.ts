import { afterEach, describe, expect, it } from 'vitest'
import { TINY_PNG, qrImageFrom } from '../src/paypal/invoices'
import { FakeInvoices } from '../src/paypal/fake'
import { agree, call, closeAll, EVIDENCE, harness, STUDIO_KEY } from './support'

afterEach(closeAll)

describe('reading a QR code out of PayPal\'s answer', () => {
  it('reads a JSON image, a data URL, and the multipart body PayPal also returns', () => {
    expect(qrImageFrom({ image: TINY_PNG })).toBe(TINY_PNG)
    expect(qrImageFrom({ image: `data:image/png;base64,${TINY_PNG}` })).toBe(TINY_PNG)
    const multipart = `--bound\r\nContent-Disposition: form-data; name="image"\r\nContent-Type: text/plain\r\n\r\n${TINY_PNG}\r\n--bound--`
    expect(qrImageFrom(multipart)).toBe(TINY_PNG)
    expect(qrImageFrom({ raw: multipart })).toBe(TINY_PNG)
    expect(qrImageFrom({})).toBeNull()
    expect(qrImageFrom({ image: 'not-an-image' })).toBeNull()
  })
})

describe('the invoice QR code', () => {
  async function invoiced() {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const deal = await agree(h.app)
    const bill = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    const id = bill.json.id as string
    await call(h.app, 'POST', `/v1/proposals/${id}/approve`)
    expect((await call(h.app, 'POST', `/v1/proposals/${id}/capture`)).json.phase).toBe('invoice_sent')
    return { ...h, id, invoices }
  }

  it('returns PayPal\'s PNG for an invoice that has been sent, and writes nothing', async () => {
    const { app, id, invoices } = await invoiced()
    const before = (await call(app, 'GET', `/v1/proposals/${id}/packet`)).json.events.length
    const qr = await call(app, 'GET', `/v1/proposals/${id}/invoice-qr`)
    expect(qr.status).toBe(200)
    expect(qr.json).toEqual({ image: TINY_PNG, contentType: 'image/png' })
    expect(invoices.qrCalls).toEqual([[...invoices.invoices.keys()][0]])
    expect((await call(app, 'GET', `/v1/proposals/${id}/packet`)).json.events).toHaveLength(before)
  })

  it('refuses a proposer, a charge with no invoice, and an invoice PayPal has not sent', async () => {
    const { app, id, invoices } = await invoiced()
    expect((await call(app, 'GET', `/v1/proposals/${id}/invoice-qr`, { key: STUDIO_KEY })).status).toBe(403)
    const plain = harness()
    const deal = await agree(plain.app)
    const waiting = await call(plain.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    expect((await call(plain.app, 'GET', `/v1/proposals/${waiting.json.id}/invoice-qr`)).status).toBe(409)
    invoices.invoices.forEach((invoice) => { invoice.status = 'DRAFT' })
    const refused = await call(app, 'GET', `/v1/proposals/${id}/invoice-qr`)
    expect(refused.status).toBe(502)
    expect(refused.json.code).toBe('paypal.upstream')
    expect(invoices.qrCalls).toEqual([])
  })
})
