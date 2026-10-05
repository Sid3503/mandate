import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices, FakePayPal } from '../src/paypal/fake'
import { invoiceNumberFor, parseInvoice } from '../src/paypal/invoices'
import { agree, call, closeAll, EVIDENCE, harness, idem, JOB } from './support'

afterEach(closeAll)

async function billed(invoices: FakeInvoices, paypal?: FakePayPal) {
  const h = harness({ invoices, paypal })
  const deal = await agree(h.app)
  const bill = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
  await call(h.app, 'POST', `/v1/proposals/${bill.json.id}/approve`)
  return { ...h, id: bill.json.id as string, deal, invoices }
}

describe('billing a client with a PayPal invoice', () => {
  it('creates and sends an invoice from the lock, then settles only when PayPal says it was paid', async () => {
    const { app, id, invoices, paypal } = await billed(new FakeInvoices())
    const sent = await call(app, 'POST', `/v1/proposals/${id}/capture`)
    expect(sent.status).toBe(200)
    expect(sent.json).toMatchObject({ phase: 'invoice_sent', invoiceStatus: 'SENT', orderId: null, captureId: null, capturedAmountCents: null })
    expect(sent.json.invoiceId).toMatch(/^INV2-/)
    expect(invoices.createCalls).toBe(1)
    expect(invoices.sendCalls).toBe(1)
    const made = [...invoices.invoices.values()][0]!
    expect(made).toMatchObject({ totalCents: 15_000, currency: 'USD', reference: id, number: invoiceNumberFor(id), email: 'ap@northwind.example' })
    expect(paypal!.orders.size).toBe(0)

    // Still unpaid: asking again changes nothing and never calls PayPal to create another invoice.
    const again = await call(app, 'POST', `/v1/proposals/${id}/capture`)
    expect(again.json.phase).toBe('invoice_sent')
    expect(invoices.createCalls).toBe(1)
    expect(invoices.sendCalls).toBe(1)
    expect((await call(app, 'GET', `/v1/jobs/${JOB}`)).json.totals.inCents).toBe(0)

    invoices.pay(sent.json.invoiceId)
    const paid = await call(app, 'POST', `/v1/proposals/${id}/capture`)
    expect(paid.json).toMatchObject({ phase: 'captured', capturedAmountCents: 15_000, invoiceStatus: 'PAID' })
    expect(paid.json.captureId).toMatch(/^CAP-INV-/)
    const packet = (await call(app, 'GET', `/v1/proposals/${id}/packet`)).json
    expect(packet.amounts).toEqual({ approvedCents: 15_000, capturedCents: 15_000, match: true })
    expect(packet.invoice).toMatchObject({ id: sent.json.invoiceId, status: 'PAID' })
    expect(packet.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['invoice.created', 'invoice.sent', 'capture.completed']))
    expect((await call(app, 'GET', `/v1/jobs/${JOB}`)).json.totals).toEqual({ inCents: 15_000, outCents: 0, heldCents: 0, keptCents: 15_000 })
  })

  it('funds a contractor payout from an invoice payment exactly like a checkout payment', async () => {
    const { app, id, invoices } = await billed(new FakeInvoices())
    const sent = (await call(app, 'POST', `/v1/proposals/${id}/capture`)).json
    invoices.pay(sent.invoiceId)
    const paid = (await call(app, 'POST', `/v1/proposals/${id}/capture`)).json
    const payout = await call(app, 'POST', '/v1/proposals', { idem: idem(), body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: paid.captureId } })
    expect(payout.json.gate).toBe('NEEDS_APPROVAL')
    await call(app, 'POST', `/v1/proposals/${payout.json.id}/approve`)
    expect((await call(app, 'POST', `/v1/proposals/${payout.json.id}/capture`)).json.phase).toBe('captured')
    // And the invoice payment can be refunded through the same gate.
    const refund = await call(app, 'POST', '/v1/proposals', { idem: idem(), body: { kind: 'refund', payee: 'Northwind', amountCents: 6_000, currency: 'USD', category: 'design', description: 'partial', evidenceUrl: EVIDENCE, parentCaptureId: paid.captureId } })
    expect(refund.json.clause).not.toBe('refund.unlinked')
  })

  it('does not call an invoice settled when PayPal says it was paid a different amount', async () => {
    const { app, id, invoices } = await billed(new FakeInvoices())
    const sent = (await call(app, 'POST', `/v1/proposals/${id}/capture`)).json
    invoices.pay(sent.invoiceId, 5_000)
    const partial = await call(app, 'POST', `/v1/proposals/${id}/capture`)
    expect(partial.json).toMatchObject({ phase: 'invoice_sent', capturedAmountCents: null })
    const events = (await call(app, 'GET', `/v1/proposals/${id}/packet`)).json.events.map((e: { type: string }) => e.type)
    expect(events).toContain('invoice.partial')
    expect((await call(app, 'GET', `/v1/jobs/${JOB}`)).json.totals.inCents).toBe(0)
  })

  it('refuses an invoice whose total no longer matches the lock', async () => {
    const { app, id, invoices } = await billed(new FakeInvoices())
    const sent = (await call(app, 'POST', `/v1/proposals/${id}/capture`)).json
    invoices.mutateTotal(sent.invoiceId, 25_000)
    invoices.pay(sent.invoiceId)
    const refused = await call(app, 'POST', `/v1/proposals/${id}/capture`)
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ code: 'cart.immutable', lockedAmountCents: 15_000 })
    expect((await call(app, 'GET', `/v1/proposals/${id}`)).json.phase).toBe('capture_refused')
  })

  it('treats a cancelled invoice as refused, never as paid', async () => {
    const { app, id, invoices } = await billed(new FakeInvoices())
    const sent = (await call(app, 'POST', `/v1/proposals/${id}/capture`)).json
    invoices.setStatus(sent.invoiceId, 'CANCELLED')
    const result = await call(app, 'POST', `/v1/proposals/${id}/capture`)
    expect(result.json.phase).toBe('invoice_cancelled')
  })

  it('falls back to checkout when the PayPal app may not send invoices', async () => {
    const invoices = new FakeInvoices()
    invoices.unauthorised = true
    const buyer = new FakePayPal()
    buyer.autoApprove = false
    const { app, id, paypal } = await billed(invoices, buyer)
    const settled = await call(app, 'POST', `/v1/proposals/${id}/capture`)
    expect(settled.status).toBe(409)
    expect(settled.json.code).toBe('paypal.buyer_pending')
    expect(paypal!.orders.size).toBe(1)
    const events = (await call(app, 'GET', `/v1/proposals/${id}/packet`)).json.events.map((e: { type: string }) => e.type)
    expect(events).toContain('invoice.unavailable')
  })

  it('recovers a draft invoice after a crash instead of making a second one', async () => {
    const invoices = new FakeInvoices()
    const { app, id, db } = await billed(invoices)
    // The server made the draft, then died before it could save the invoice id.
    await invoices.createDraft({ proposalId: id, invoiceNumber: invoiceNumberFor(id), amountCents: 15_000, currency: 'USD', title: 't', description: 'd', note: 'n', recipientEmail: 'ap@northwind.example', recipientName: 'Northwind' })
    expect(db.prepare('SELECT invoice_id FROM proposals WHERE id = ?').get(id)).toEqual({ invoice_id: null })
    const sent = await call(app, 'POST', `/v1/proposals/${id}/capture`)
    expect(sent.json.phase).toBe('invoice_sent')
    expect(invoices.invoices.size).toBe(1)
  })

  it('uses PayPal\'s word, not the webhook\'s: an invoice event only triggers a re-read', async () => {
    const { app, id, invoices } = await billed(new FakeInvoices())
    const sent = (await call(app, 'POST', `/v1/proposals/${id}/capture`)).json
    const hook = (invoiceId: string) => app.request('http://mandate.test/v1/webhooks/paypal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: invoiceId, status: 'PAID', amount: { value: '0.01' } } } }),
    })
    const early = await (await hook(sent.invoiceId)).json()
    expect(early.refreshed).toBe(true)
    expect((await call(app, 'GET', `/v1/proposals/${id}`)).json.phase).toBe('invoice_sent')
    invoices.pay(sent.invoiceId)
    await hook(sent.invoiceId)
    expect((await call(app, 'GET', `/v1/proposals/${id}`)).json).toMatchObject({ phase: 'captured', capturedAmountCents: 15_000 })
    expect((await (await hook('INV2-UNKNOWN0000')).json()).refreshed).toBe(false)
  })

  it('parses what PayPal returns, and never reads missing data as paid', () => {
    const live = parseInvoice({
      id: 'INV2-1', status: 'PAID', detail: { invoice_number: 'MND-1', currency_code: 'USD', reference: 'p1', metadata: { recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/#1' } },
      amount: { currency_code: 'USD', value: '150.00' },
      payments: { transactions: [{ payment_id: 'CAP1', method: 'PAYPAL', amount: { currency_code: 'USD', value: '150.00' } }] },
    }, 'x')
    expect(live).toMatchObject({ invoiceId: 'INV2-1', status: 'PAID', totalCents: 15_000, paidCents: 15_000, transactionId: 'CAP1', reference: 'p1', payerUrl: 'https://www.sandbox.paypal.com/invoice/p/#1' })
    expect(parseInvoice({ id: 'INV2-2', status: 'SENT' }, 'x')).toMatchObject({ paidCents: 0, transactionId: null, totalCents: 0 })
    const external = parseInvoice({ id: 'INV2-3', status: 'MARKED_AS_PAID', amount: { value: '150.00', currency_code: 'USD' }, payments: { transactions: [{ payment_id: 'X', method: 'CASH', amount: { value: '150.00' } }] } }, 'x')
    expect(external.paidCents).toBe(0)
  })
})

describe('the invoice wiring is off unless asked for', () => {
  it('bills by checkout when no invoice port is configured', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const bill = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    await call(h.app, 'POST', `/v1/proposals/${bill.json.id}/approve`)
    const r = await call(h.app, 'POST', `/v1/proposals/${bill.json.id}/capture`)
    expect(r.json.phase).toBe('captured')
    expect(r.json.invoiceId).toBeNull()
  })
})
