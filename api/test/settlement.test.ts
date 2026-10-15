import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices } from '../src/paypal/fake'
import { agree, call, closeAll, collect, EVIDENCE, harness, JOB } from './support'

afterEach(closeAll)

/** The frozen job's first milestone is a 15,000 cent charge to Northwind, billed as a PayPal invoice. */
async function billed(invoices: FakeInvoices) {
  const h = harness({ invoices })
  const deal = await agree(h.app)
  const bill = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
  await call(h.app, 'POST', `/v1/proposals/${bill.json.id}/approve`)
  const id = bill.json.id as string
  const sent = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
  return { ...h, id, invoices, invoiceId: sent.json.invoiceId as string }
}

describe('the settlement delta: what arrived, and why', () => {
  it('records the amount that arrived and the reason when the client pays less than the lock', async () => {
    const h = await billed(new FakeInvoices())
    h.invoices.pay(h.invoiceId, 5_000)
    const partial = await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
    expect(partial.json).toMatchObject({
      phase: 'settled_short',
      capturedAmountCents: null,
      settledCents: 5_000,
      deltaCents: -10_000,
      deltaReason: 'partial',
    })
    // The money is really in, so the job totals count what arrived, and the contractor's share is fundable from it.
    const job = (await call(h.app, 'GET', `/v1/jobs/${JOB}`)).json
    expect(job.totals.inCents).toBe(5_000)
    expect(job.charges[0].fundableCents).toBe(3_000)
  })

  it('records a full settlement as full, with no delta', async () => {
    const h = await billed(new FakeInvoices())
    h.invoices.pay(h.invoiceId)
    const paid = await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
    expect(paid.json).toMatchObject({
      phase: 'captured',
      capturedAmountCents: 15_000,
      settledCents: 15_000,
      deltaCents: 0,
      deltaReason: 'full',
    })
  })

  it('moves a short settlement to full when the rest arrives', async () => {
    const h = await billed(new FakeInvoices())
    h.invoices.pay(h.invoiceId, 5_000)
    await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
    h.invoices.pay(h.invoiceId)
    const paid = await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
    expect(paid.json).toMatchObject({ phase: 'captured', settledCents: 15_000, deltaCents: 0, deltaReason: 'full' })
  })

  it('refuses to call it settled when PayPal says paid and no money arrived', async () => {
    const h = await billed(new FakeInvoices())
    // Paid status, nothing paid: PayPal's own words do not match its own numbers.
    h.invoices.setStatus(h.invoiceId, 'PARTIALLY_PAID')
    const result = await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
    expect(result.json).toMatchObject({
      phase: 'invoice_sent',
      capturedAmountCents: null,
      settledCents: 0,
      deltaCents: -15_000,
      deltaReason: 'unexplained',
    })
  })

  it('records a checkout capture as a full settlement too, off the second call site', async () => {
    // No invoice port, so the charge settles through Orders and markCaptured's other caller runs.
    const h = harness()
    const deal = await agree(h.app)
    const { proposalId } = await collect(h.app, deal.id, 0)
    const row = (await call(h.app, 'GET', `/v1/proposals/${proposalId}`)).json
    expect(row).toMatchObject({
      phase: 'captured',
      capturedAmountCents: 15_000,
      settledCents: 15_000,
      deltaCents: 0,
      deltaReason: 'full',
    })
  })

  it('does not rewrite the row when a sweep learns nothing new', async () => {
    const h = await billed(new FakeInvoices())
    h.invoices.pay(h.invoiceId, 5_000)
    await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
    // The guard is what keeps a stuck invoice from rotating to the back of openInvoices, which orders by
    // updated_at. Called at the row level, so the check is about the guard and not the phase the settlement
    // path writes alongside it.
    const bare = h.repo.proposal(h.id)!
    expect(bare).toMatchObject({ phase: 'settled_short', settled_cents: 5_000, delta_cents: -10_000, delta_reason: 'partial' })
    // The short path writes through settleShort. Same guard, and the same flag is what stops a part-paid
    // invoice from appending an invoice.partial event on every sweep.
    expect(h.repo.settleShort(h.id, 'CAP-INV-1', 5_000, 'partial', 'payments.paid_amount', '2026-10-15T01:00:00.000Z')).toBe(false)
    const same = h.repo.proposal(h.id)!
    expect(same.updated_at).toBe(bare.updated_at)
    // A real change does write, so the guard is not a no-op.
    expect(h.repo.settleShort(h.id, 'CAP-INV-1', 9_000, 'partial', 'payments.paid_amount', '2026-10-15T02:00:00.000Z')).toBe(true)
    const changed = h.repo.proposal(h.id)!
    expect(changed).toMatchObject({ phase: 'settled_short', settled_cents: 9_000, delta_cents: -6_000, delta_reason: 'partial' })
    expect(changed.updated_at).toBe('2026-10-15T02:00:00.000Z')
    // The reason alone is news too. S3 makes that reachable without the cents moving, and the event
    // that stops a part-paid invoice appending on every sweep is this same flag.
    expect(h.repo.recordSettlement(h.id, 9_000, 'unexplained', null, '2026-10-15T03:00:00.000Z')).toBe(true)
    expect(h.repo.proposal(h.id)!.delta_reason).toBe('unexplained')
  })
})
