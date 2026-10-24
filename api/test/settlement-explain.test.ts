import { afterEach, describe, expect, it } from 'vitest'
import { explainDelta, explainTotal, type InvoiceMoney } from '../src/domain/settlement'
import { FakeInvoices } from '../src/paypal/fake'
import { agree, call, closeAll, EVIDENCE, harness } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]
type Check = { id: string; status: string; checked: number; failures: Array<{ proposalId: string | null; detail: string }> }
const audit = async (app: App): Promise<{ checks: Check[] }> => (await call(app, 'GET', '/v1/audit')).json
const check = (report: { checks: Check[] }, id: string): Check => report.checks.find((item) => item.id === id)!

/** An invoice that asks for the 15,000 cent milestone and was paid in full. Overrides say what PayPal reported. */
const money = (overrides: Partial<InvoiceMoney> = {}): InvoiceMoney => ({
  totalCents: 15_000,
  paidCents: 15_000,
  discountCents: null,
  earlyDiscountCents: null,
  feeCents: null,
  ...overrides,
})

describe('which PayPal field explains a shortfall', () => {
  it('calls a full payment full, with no gap to attribute', () => {
    expect(explainDelta(15_000, money())).toEqual({ reason: 'full', source: null, settledCents: 15_000 })
  })

  it('calls a payment above the lock full, and keeps the extra cents', () => {
    expect(explainDelta(15_000, money({ paidCents: 15_500 }))).toEqual({ reason: 'full', source: null, settledCents: 15_500 })
  })

  it('attributes a shortfall to nothing when PayPal reported nothing, and says so as partial', () => {
    expect(explainDelta(15_000, money({ paidCents: 14_250 }))).toEqual({ reason: 'partial', source: 'payments.paid_amount', settledCents: 14_250 })
  })

  it('reads the early-payment discount PayPal says it applied', () => {
    expect(explainDelta(15_000, money({ paidCents: 14_250, earlyDiscountCents: 750 }))).toEqual({ reason: 'early_discount', source: 'early_payment_discount', settledCents: 14_250 })
  })

  it('reads an invoice-level discount as a credit on the bill', () => {
    expect(explainDelta(15_000, money({ paidCents: 14_250, discountCents: 750 }))).toEqual({ reason: 'credit_note', source: 'amount.breakdown.discount', settledCents: 14_250 })
  })

  it('reads a fee PayPal reported on the payment', () => {
    expect(explainDelta(15_000, money({ paidCents: 14_250, feeCents: 750 }))).toEqual({ reason: 'paypal_fee', source: 'payments.transactions[].fee', settledCents: 14_250 })
  })

  it('does not let a field claim a gap it does not cover', () => {
    // A 5.00 discount cannot explain a 7.50 shortfall. Saying it did would be this product's own invented number.
    expect(explainDelta(15_000, money({ paidCents: 14_250, discountCents: 500 })).reason).toBe('partial')
  })

  it('ignores an early-payment offer that PayPal says was not applied', () => {
    // The reader only hands over the amount when PayPal reports `is_applied`, so an untaken offer arrives as null.
    expect(explainDelta(15_000, money({ paidCents: 14_250, earlyDiscountCents: null })).reason).toBe('partial')
  })

  it('keeps the more specific field when two of them could explain the same gap', () => {
    expect(explainDelta(15_000, money({ paidCents: 14_250, earlyDiscountCents: 750, discountCents: 750 })).reason).toBe('early_discount')
  })

  it('calls money that never arrived unexplained, and settles nothing on it', () => {
    expect(explainDelta(15_000, money({ paidCents: 0, totalCents: 15_000 }))).toEqual({ reason: 'unexplained', source: null, settledCents: 0 })
  })
})

describe('a total that is not the lock is refused unless a discount explains it', () => {
  it('explains a discounted invoice, and refuses one nothing accounts for', () => {
    expect(explainTotal(15_000, money({ totalCents: 14_250, discountCents: 750 }))).toEqual({ reason: 'credit_note', source: 'amount.breakdown.discount' })
    expect(explainTotal(15_000, money({ totalCents: 14_250 }))).toBeNull()
    expect(explainTotal(15_000, money({ totalCents: 15_001 }))).toBeNull()
    expect(explainTotal(15_000, money())).toBeNull()
  })
})

/** The frozen job's first milestone is a 15,000 cent charge to Northwind, billed as a PayPal invoice. */
async function billed(invoices: FakeInvoices, options: { rules?: Record<string, unknown>; deal?: Record<string, unknown> } = {}) {
  const h = harness({ invoices })
  if (options.rules) {
    const current = (await call(h.app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    const published = await call(h.app, 'PUT', '/v1/warrant', { body: { ...body, ...options.rules } })
    if (published.status >= 400) throw new Error(`rules not published: ${JSON.stringify(published.json)}`)
  }
  const deal = await agree(h.app, options.deal)
  const bill = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
  await call(h.app, 'POST', `/v1/proposals/${bill.json.id}/approve`)
  const id = bill.json.id as string
  const sent = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
  return { ...h, id, invoices, invoiceId: sent.json.invoiceId as string }
}

describe('the reason a short settlement carries is read from PayPal, end to end', () => {
  const cases = [
    { name: 'an early-payment discount PayPal applied', adjustments: { earlyDiscountCents: 750 }, reason: 'early_discount', source: 'early_payment_discount' },
    { name: 'a discount on the invoice itself', adjustments: { discountCents: 750 }, reason: 'credit_note', source: 'amount.breakdown.discount' },
    { name: 'a fee PayPal reported on the payment', adjustments: { feeCents: 750 }, reason: 'paypal_fee', source: 'payments.transactions[].fee' },
    { name: 'nothing at all', adjustments: {}, reason: 'partial', source: 'payments.paid_amount' },
  ] as const

  for (const item of cases) {
    it(`records ${item.reason} for ${item.name}`, async () => {
      const h = await billed(new FakeInvoices())
      h.invoices.payPartial(h.invoiceId, 14_250, { ...item.adjustments })
      const short = await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
      expect(short.json).toMatchObject({
        phase: 'settled_short',
        settledCents: 14_250,
        deltaCents: -750,
        deltaReason: item.reason,
        deltaSource: item.source,
      })
      // The number a person reads is attributed, and the field it came from is on the record beside it.
      const packet = (await call(h.app, 'GET', `/v1/proposals/${h.id}/packet`)).json
      expect(packet.proposal).toMatchObject({ deltaReason: item.reason, deltaSource: item.source })
      // amounts.match still refuses to call it a match, and the new check says the shortfall was attributed.
      expect(packet.amounts.match).toBe(false)
      const report = await audit(h.app)
      expect(check(report, 'amounts.match').status).toBe('pass')
      expect(check(report, 'amounts.explained')).toMatchObject({ status: 'pass', checked: 1 })
    })
  }

  it('does not read a reason out of a field that only partly covers the gap', async () => {
    const h = await billed(new FakeInvoices())
    h.invoices.payPartial(h.invoiceId, 14_250, { discountCents: 500 })
    const short = await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
    expect(short.json).toMatchObject({ deltaReason: 'partial', deltaSource: 'payments.paid_amount' })
  })

  it('leaves the row on the invoice when PayPal has not called it paid, even with the whole lock in', async () => {
    const h = await billed(new FakeInvoices())
    // The money is in and it is the whole lock, but PayPal has not marked the invoice PAID. Nothing settles on a
    // state PayPal has not confirmed: the delta is recorded and the row keeps waiting, so a short phase never
    // carries a reason no field stands behind and `amounts.explained` has nothing to catch.
    h.invoices.pay(h.invoiceId, 15_000)
    h.invoices.setStatus(h.invoiceId, 'PARTIALLY_PAID')
    const waiting = await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
    expect(waiting.json).toMatchObject({ phase: 'invoice_sent', settledCents: 15_000, deltaCents: 0, deltaReason: 'full' })
    expect(check(await audit(h.app), 'amounts.explained').checked).toBe(0)
    // When PayPal does say PAID, the same row settles in full, with the lock as what was captured.
    h.invoices.setStatus(h.invoiceId, 'PAID')
    const settled = await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
    expect(settled.json).toMatchObject({ phase: 'captured', capturedAmountCents: 15_000, settledCents: 15_000, deltaReason: 'full' })
  })

  it('refuses only the invoices a discount cannot account for', async () => {
    // The studio edited the invoice at PayPal to carry a credit, so the total is lower than the lock and the
    // client paid the whole of it. That is a settlement, not tampering.
    const discounted = await billed(new FakeInvoices())
    discounted.invoices.mutateTotal(discounted.invoiceId, 14_250)
    discounted.invoices.payPartial(discounted.invoiceId, 14_250, { discountCents: 750 })
    const settled = await call(discounted.app, 'POST', `/v1/proposals/${discounted.id}/capture`)
    expect(settled.status).toBe(200)
    expect(settled.json).toMatchObject({ phase: 'settled_short', settledCents: 14_250, deltaReason: 'credit_note' })

    // A total that moved with nothing behind it is still refused, exactly as before.
    const bare = await billed(new FakeInvoices())
    bare.invoices.mutateTotal(bare.invoiceId, 14_250)
    bare.invoices.payPartial(bare.invoiceId, 14_250)
    const refused = await call(bare.app, 'POST', `/v1/proposals/${bare.id}/capture`)
    expect(refused.json).toMatchObject({ code: 'cart.immutable', lockedAmountCents: 15_000 })

    // So is a total that asks for more than the lock.
    const higher = await billed(new FakeInvoices())
    higher.invoices.mutateTotal(higher.invoiceId, 15_500)
    higher.invoices.pay(higher.invoiceId, 15_500)
    expect((await call(higher.app, 'POST', `/v1/proposals/${higher.id}/capture`)).json.code).toBe('cart.immutable')
  })

  it('settles the lock in full when the payer added a tip, and puts the extra on the record', async () => {
    const h = await billed(new FakeInvoices())
    h.invoices.pay(h.invoiceId, 15_500)
    const paid = await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
    expect(paid.json).toMatchObject({
      phase: 'captured',
      capturedAmountCents: 15_000,
      settledCents: 15_500,
      deltaCents: 500,
      deltaReason: 'full',
    })
    // The guarantee is untouched: what was captured is the lock to the cent, and the tip sits beside it.
    const report = await audit(h.app)
    expect(check(report, 'amounts.match')).toMatchObject({ status: 'pass', checked: 1 })
    expect(check(report, 'amounts.explained').checked).toBe(0)
  })
})

describe('what the server sends PayPal is set by the rules and the deal', () => {
  it('asks for part payment only when the rules do, and sends the deal discount when the deal carries one', async () => {
    const h = await billed(new FakeInvoices(), { rules: { allowPartialPayment: true }, deal: { earlyPaymentDiscount: { percentBps: 200, days: 15 } } })
    // 200 basis points is 2%, and the due date is 15 days after the server's clock, not PayPal's.
    expect(h.invoices.lastCreate).toMatchObject({
      allowPartialPayment: true,
      earlyPaymentDiscount: { percentBps: 200, dueDate: '2026-10-18' },
    })
  })

  it('sends no part payment and no discount when neither the rules nor the deal ask for one', async () => {
    const h = await billed(new FakeInvoices())
    expect(h.invoices.lastCreate).toMatchObject({ allowPartialPayment: false, earlyPaymentDiscount: null })
  })
})
