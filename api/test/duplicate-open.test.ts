import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices } from '../src/paypal/fake'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB } from './support'

afterEach(closeAll)

/** The frozen job with milestone 0 already collected, so a payout to Priya has client money behind it. */
async function funded() {
  const h = harness()
  const deal = await agree(h.app)
  const { captureId } = await collect(h.app, deal.id, 0)
  const ask = (overrides: Record<string, unknown> = {}) => call(h.app, 'POST', '/v1/proposals', {
    idem: idem('dup'),
    body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: captureId, ...overrides },
  })
  return { ...h, deal, captureId, ask }
}

describe('a second ask for money that is already asked for', () => {
  it('refuses it while the first is open, names both, and calls nobody', async () => {
    const h = await funded()
    const paypal = h.paypal!
    const orders = paypal.orders.size
    const first = await h.ask()
    expect(first.json).toMatchObject({ gate: 'NEEDS_APPROVAL', phase: 'pending_approval' })

    const second = await h.ask()
    expect(second.status).toBe(201)
    expect(second.json).toMatchObject({ gate: 'DENY', clause: 'duplicate.open', phase: 'denied' })
    // The detail has to name both, or the owner cannot tell which ask is the old one.
    expect(second.json.detail).toContain(first.json.id)
    expect(second.json.detail).toContain(second.json.id)
    // Nothing was sent to PayPal, and exactly one of the two was let through.
    expect(paypal.orders.size).toBe(orders)
    expect(paypal.payoutCalls).toBe(0)
    expect([first.json.gate, second.json.gate].filter((gate) => gate !== 'DENY')).toHaveLength(1)
  })

  it('still refuses a repeat whose description was reworded', async () => {
    const h = await funded()
    const first = await h.ask({ description: 'design share' })
    // Locked, so its share is already held and a plain re-check would read as an arithmetic refusal.
    expect((await call(h.app, 'POST', `/v1/proposals/${first.json.id}/approve`)).json.phase).toBe('locked')
    const reworded = await h.ask({ description: 'design share, second attempt' })
    expect(reworded.json).toMatchObject({ gate: 'DENY', clause: 'duplicate.open' })
  })

  it('refuses a repeat of a charge whose invoice is still out', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    // A job with no agreed deal, so the charge is judged on its own. JOB itself has a deal.
    const job = 'job_retainer_2026'
    const body = { kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design', description: 'retainer', evidenceUrl: EVIDENCE, jobId: job }
    const first = await call(h.app, 'POST', '/v1/proposals', { idem: idem('dup'), body })
    expect(first.json).toMatchObject({ gate: 'NEEDS_APPROVAL' })
    await call(h.app, 'POST', `/v1/proposals/${first.json.id}/approve`)
    expect((await call(h.app, 'POST', `/v1/proposals/${first.json.id}/capture`)).json.phase).toBe('invoice_sent')

    const second = await call(h.app, 'POST', '/v1/proposals', { idem: idem('dup'), body })
    expect(second.json).toMatchObject({ gate: 'DENY', clause: 'duplicate.open', phase: 'denied' })
    expect(invoices.createCalls).toBe(1)
  })

  it('does not let a dead ask block a fresh one', async () => {
    const h = await funded()
    // A category the warrant does not carry: refused, so the row is denied and finished with.
    const dead = await h.ask({ category: 'not_a_category' })
    expect(dead.json).toMatchObject({ gate: 'DENY', clause: 'category.missing', phase: 'denied' })

    const fresh = await h.ask()
    expect(fresh.json.clause).not.toBe('duplicate.open')
    expect(fresh.json.gate).toBe('NEEDS_APPROVAL')
  })

  it('does not confuse one milestone of a deal with another', async () => {
    // Both milestones are 15,000 cents to Northwind on the same job. The first is still an open invoice
    // when the second is billed, so a key of job plus payee plus amount would refuse the second bill.
    const h = harness({ invoices: new FakeInvoices() })
    const deal = await agree(h.app)
    const zero = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    await call(h.app, 'POST', `/v1/proposals/${zero.json.id}/approve`)
    expect((await call(h.app, 'POST', `/v1/proposals/${zero.json.id}/capture`)).json.phase).toBe('invoice_sent')

    const one = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/1/bill`, { body: { evidenceUrl: EVIDENCE } })
    expect(one.json.clause).not.toBe('duplicate.open')
    expect(one.json).toMatchObject({ gate: 'NEEDS_APPROVAL', amountCents: 15_000, milestone: 1 })
  })

  it('does not treat a different amount as the same ask', async () => {
    const h = await funded()
    expect((await h.ask({ amountCents: 3_000 })).json.gate).toBe('NEEDS_APPROVAL')
    const other = await h.ask({ amountCents: 5_000 })
    expect(other.json.clause).not.toBe('duplicate.open')
  })

  it('does not treat the same amount from a different client payment as the same ask', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const first = await collect(h.app, deal.id, 0)
    const second = await collect(h.app, deal.id, 1)
    const ask = (captureId: string) => call(h.app, 'POST', '/v1/proposals', {
      idem: idem('dup'),
      body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: captureId },
    })
    expect((await ask(first.captureId)).json.gate).toBe('NEEDS_APPROVAL')
    const other = await ask(second.captureId)
    expect(other.json.clause).not.toBe('duplicate.open')
    expect(other.json.gate).toBe('NEEDS_APPROVAL')
  })
})
