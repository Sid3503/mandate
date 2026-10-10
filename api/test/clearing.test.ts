import { afterEach, describe, expect, it } from 'vitest'
import { clearingState, decide } from '../src/domain/gate'
import { LINE_STUDIO_WARRANT } from '../src/domain/schemas'
import { FakeInvoices } from '../src/paypal/fake'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, NOW, STUDIO_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]
const DAY = 86_400_000
const RULE = { id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }
const ON = { billSignedDeals: true, payOnSettle: true, remindUnpaidAfterDays: null, maxReminders: 2 }

async function publish(app: App, patch: Record<string, unknown>) {
  const current = (await call(app, 'GET', '/v1/warrant')).json
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  return call(app, 'PUT', '/v1/warrant', { body: { ...body, ...patch } })
}

describe('clearing: money a client can still take back is not paid out on its own', () => {
  it('has not cleared until the window has passed, fails closed with no clock or no settle time, and is off at zero', () => {
    const settledAt = '2026-10-01T00:00:00.000Z'
    const at = Date.parse(settledAt)
    expect(clearingState({ clearingDays: 0 }, { settledAt }, at)).toEqual({ pending: false, clearsAt: null })
    expect(clearingState({ clearingDays: 3 }, { settledAt }, at + 2 * DAY)).toEqual({ pending: true, clearsAt: '2026-10-04T00:00:00.000Z' })
    expect(clearingState({ clearingDays: 3 }, { settledAt }, at + 3 * DAY).pending).toBe(false)
    expect(clearingState({ clearingDays: 3 }, { settledAt: null }, at + 9 * DAY).pending).toBe(true)
    expect(clearingState({ clearingDays: 3 }, { settledAt }, undefined).pending).toBe(true)
  })

  it('turns a would-be automatic payout into a request for the owner, for a standing rule and for a small amount alike', () => {
    const funding = { kind: 'charge', phase: 'captured', jobId: 'job_1', currency: 'USD', capturedCents: 15_000, refundHeldCents: 0, payoutHeldCents: 0, clientId: 'client_northwind', dealId: 'deal_1', settledAt: '2026-10-01T00:00:00.000Z' }
    const request = (amountCents: number) => ({ kind: 'payment' as const, payeeId: 'payee_priya', amountCents, currency: 'USD', category: 'design', evidenceUrl: EVIDENCE, jobId: 'job_1', fundingCaptureId: 'CAP1', parent: null, funding })
    const rules = { ...LINE_STUDIO_WARRANT, standing: [RULE], clearingDays: 3 }
    const early = { reservedCents: 0, priorCaptureIds: [], nowMs: Date.parse('2026-10-02T00:00:00.000Z') }
    const late = { ...early, nowMs: Date.parse('2026-10-04T00:00:00.000Z') }
    expect(decide(rules, request(9_000), early)).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'funding.clearing' })
    expect(decide(rules, request(1_000), early)).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'funding.clearing' })
    expect(decide(rules, request(9_000), late)).toMatchObject({ gate: 'AUTO', clause: 'standing.matched' })
    // With the window off, nothing changes for anyone.
    expect(decide({ ...rules, clearingDays: 0 }, request(9_000), early)).toMatchObject({ gate: 'AUTO', clause: 'standing.matched' })
  })

  async function fundedWithWindow() {
    const h = harness()
    const deal = await agree(h.app)
    const charge = await collect(h.app, deal.id, 0)
    expect((await publish(h.app, { standing: [RULE], clearingDays: 3 })).status).toBe(201)
    const ask = (key: string) => call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: key, body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'Share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: charge.captureId } })
    return { h, ask }
  }

  it('holds a payout for the owner while the client money clears, and lets the owner tap early', async () => {
    const { h, ask } = await fundedWithWindow()
    const held = await ask(idem())
    expect(held.status).toBe(201)
    expect(held.json).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'funding.clearing', phase: 'pending_approval' })
    expect(h.paypal!.payoutCalls).toBe(0)
    expect(JSON.stringify((await call(h.app, 'GET', `/v1/proposals/${held.json.id}/packet`)).json)).toContain('still clearing')
    // The owner may still say yes herself, knowing the risk.
    const early = await call(h.app, 'POST', `/v1/proposals/${held.json.id}/approve`)
    expect(early.status).toBe(200)
    expect(early.json).toMatchObject({ phase: 'locked' })
  })

  it('sends by the owner\'s rule, with no tap, once the window has passed', async () => {
    const { h, ask } = await fundedWithWindow()
    const held = await ask(idem())
    expect(held.json.clause).toBe('funding.clearing')
    expect((await call(h.app, 'POST', `/v1/proposals/${held.json.id}/reject`)).status).toBe(200)
    h.setNow(new Date(NOW.getTime() + 4 * DAY))
    const cleared = await ask(idem())
    expect(cleared.json).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', phase: 'captured', capturedAmountCents: 9_000 })
    expect(h.paypal!.payoutCalls).toBe(1)
  })

  it('makes autopilot wait, say until when, and then pay by itself once the money has cleared', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const deal = await agree(h.app)
    await publish(h.app, { standing: [RULE], automation: ON, clearingDays: 3 })
    const billed = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    invoices.pay(billed.json.invoiceId)
    await h.services.mandate.sweepPending()
    const payouts = async () => (await call(h.app, 'GET', '/v1/proposals')).json.data.filter((row: { kind: string }) => row.kind === 'payment')
    const types = async () => (await call(h.app, 'GET', `/v1/proposals/${billed.json.id}/packet`)).json.events.map((event: { type: string }) => event.type) as string[]

    // The client has paid, but the money has not cleared: nothing is paid out and the ledger says why.
    expect((await call(h.app, 'GET', `/v1/proposals/${billed.json.id}`)).json.phase).toBe('captured')
    expect(await payouts()).toHaveLength(0)
    expect(await types()).toContain('autopilot.clearing')
    expect(await types()).not.toContain('autopilot.payout_asked')
    expect(h.paypal!.payoutCalls).toBe(0)
    // Looking again before then changes nothing, and does not repeat itself in the ledger.
    await h.services.mandate.sweepPending()
    expect((await types()).filter((type) => type === 'autopilot.clearing')).toHaveLength(1)
    // The job says when the money clears.
    const job = (await call(h.app, 'GET', `/v1/jobs/${JOB}`)).json
    expect(job.charges[0].clearing.pending).toBe(true)

    // Days later the server's own look finds it cleared and pays, with no tap, once.
    h.setNow(new Date(NOW.getTime() + 4 * DAY))
    await h.services.mandate.sweepPending()
    const [payout] = await payouts()
    expect(payout).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', phase: 'captured', amountCents: 9_000 })
    expect(h.paypal!.payoutCalls).toBe(1)
    await h.services.mandate.sweepPending()
    expect(await payouts()).toHaveLength(1)
  })
})
