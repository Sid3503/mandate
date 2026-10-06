import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices, FakePayPal, FakeWatch } from '../src/paypal/fake'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]

/** Publishes the next rules version with the given standing rules. This one call is the owner's "yes". */
async function publishStanding(app: App, standing: unknown[], extra: Record<string, unknown> = {}) {
  const current = (await call(app, 'GET', '/v1/warrant')).json
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  return call(app, 'PUT', '/v1/warrant', { body: { ...body, standing, ...extra } })
}

const RULE = { id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }
const payout = (fundingCaptureId: string, overrides: Record<string, unknown> = {}) => ({ payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'Milestone 1 share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId, ...overrides })

async function funded(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  const deal = await agree(h.app)
  const charge = await collect(h.app, deal.id, 0)
  return { ...h, deal, ...charge }
}

const dispute = (captureId: string, status = 'UNDER_REVIEW') => ({ id: 'PP-D-9', status, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', cents: 15_000, currency: 'USD', openedAt: null, updatedAt: null, transactionIds: [captureId] })
const eventTypes = async (app: App, id: string) => (await call(app, 'GET', `/v1/proposals/${id}/packet`)).json.events.map((event: { type: string }) => event.type)

describe('a standing rule: say yes to the rule once, not to each payment', () => {
  it('pays Priya her share with no tap, through the same settle path, and signs the lock', async () => {
    const h = await funded()
    expect((await publishStanding(h.app, [RULE])).status).toBe(201)

    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId) })
    expect(asked.status).toBe(201)
    expect(asked.json).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', phase: 'captured', capturedAmountCents: 9_000, warrantVersion: 2 })
    expect(h.paypal!.payoutCalls).toBe(1)
    const packet = (await call(h.app, 'GET', `/v1/proposals/${asked.json.id}/packet`)).json
    expect(packet.lock.signatureValid).toBe(true)
    expect(packet.events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining(['proposal.created', 'payout.sent', 'payout.completed']))
    expect(packet.events.map((event: { type: string }) => event.type)).not.toContain('proposal.approved')
    const job = (await call(h.app, 'GET', `/v1/jobs/${JOB}`)).json
    expect(job.totals).toEqual({ inCents: 15_000, outCents: 9_000, heldCents: 0, keptCents: 6_000 })
  })

  it('does nothing new until the owner publishes the rule: the same ask still needs a tap', async () => {
    const h = await funded()
    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId) })
    expect(asked.json).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval', phase: 'pending_approval' })
    expect(h.paypal!.payoutCalls).toBe(0)
  })

  it('does not cover an agent that asks for more than the share, and the cap and proof still bind', async () => {
    const h = await funded()
    await publishStanding(h.app, [RULE])
    const over = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId, { amountCents: 9_100 }) })
    expect(over.json).toMatchObject({ gate: 'DENY', clause: 'funding.exceeds' })
    const noProof = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId, { evidenceUrl: undefined }) })
    expect(noProof.json).toMatchObject({ gate: 'DENY', clause: 'evidence.missing' })
    const first = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId) })
    expect(first.json.phase).toBe('captured')
    // The client payment is spent. A second $90 from it is refused, not quietly paid.
    const again = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId) })
    expect(again.json).toMatchObject({ gate: 'DENY', clause: 'funding.exceeds' })
    expect(h.paypal!.payoutCalls).toBe(1)
  })

  it('does not cover a payee or a client the rule does not name', async () => {
    const h = await funded()
    const current = (await call(h.app, 'GET', '/v1/warrant')).json
    await publishStanding(h.app, [{ ...RULE, clientIds: ['client_other'] }], {
      clients: [...current.clients, { id: 'client_other', displayName: 'Other Co', email: 'ap@other.example', aliases: [] }],
    })
    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId) })
    expect(asked.json).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval' })
    const stranger = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId, { payee: 'P. Shah' }) })
    expect(stranger.json).toMatchObject({ gate: 'DENY', clause: 'payee.unknown' })
  })

  it('can insist the money came through a signed deal', async () => {
    const h = harness()
    await publishStanding(h.app, [RULE])
    // A charge on a job with no deal: settled, but not through a signed deal.
    const charge = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design', description: 'Ad hoc work', evidenceUrl: EVIDENCE, jobId: 'job_no_deal' } })
    await call(h.app, 'POST', `/v1/proposals/${charge.json.id}/approve`)
    const settled = await call(h.app, 'POST', `/v1/proposals/${charge.json.id}/capture`)
    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(settled.json.captureId, { jobId: 'job_no_deal' }) })
    expect(asked.json).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval' })

    await publishStanding(h.app, [{ ...RULE, requireDeal: false }])
    const covered = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(settled.json.captureId, { jobId: 'job_no_deal', description: 'Share, no deal' }) })
    expect(covered.json).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', phase: 'captured' })
  })

  it('refuses a payout at the gate when the client payment is already disputed', async () => {
    const watch = new FakeWatch()
    const h = await funded({ watch })
    await publishStanding(h.app, [RULE])
    watch.disputes = [dispute(h.captureId)]
    const held = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId) })
    expect(held.json).toMatchObject({ gate: 'DENY', clause: 'funding.disputed' })
    expect(h.paypal!.payoutCalls).toBe(0)
  })

  it('holds a payout the dispute catches after it was approved, and sends it once the dispute is resolved', async () => {
    const watch = new FakeWatch()
    const h = await funded({ watch })
    await publishStanding(h.app, [RULE])
    // The answer about disputes is not available when the payout is asked, so it is approved and locked, then held at the door.
    watch.failStatus = 502
    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId) })
    expect(asked.json.phase).toBe('locked')
    watch.failStatus = 0
    watch.disputes = [dispute(h.captureId)]
    await h.services.mandate.sweepStanding()
    expect((await call(h.app, 'GET', `/v1/proposals/${asked.json.id}`)).json.phase).toBe('locked')
    expect(h.paypal!.payoutCalls).toBe(0)
    watch.disputes = [dispute(h.captureId, 'RESOLVED')]
    await h.services.mandate.sweepStanding()
    expect((await call(h.app, 'GET', `/v1/proposals/${asked.json.id}`)).json.phase).toBe('captured')
    expect(h.paypal!.payoutCalls).toBe(1)
    const events = await eventTypes(h.app, asked.json.id)
    expect(events).toContain('standing.waiting')
    expect(events.filter((type: string) => type === 'standing.waiting')).toHaveLength(2)
  })

  it('leaves an approved payout locked when PayPal cannot be reached, and the sweep sends it later', async () => {
    const watch = new FakeWatch()
    const h = await funded({ watch })
    await publishStanding(h.app, [RULE])
    // The dispute check cannot be answered, so the send waits. Nothing reached PayPal.
    watch.failStatus = 502
    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId) })
    expect(asked.status).toBe(201)
    expect(asked.json).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', phase: 'locked' })
    expect(h.paypal!.payoutCalls).toBe(0)
    expect(await eventTypes(h.app, asked.json.id)).toContain('standing.waiting')

    watch.failStatus = 0
    const swept = await h.services.mandate.sweepStanding()
    expect(swept).toBe(1)
    expect((await call(h.app, 'GET', `/v1/proposals/${asked.json.id}`)).json.phase).toBe('captured')
    expect(h.paypal!.payoutCalls).toBe(1)
  })

  it('is refused at capture if the lock was tampered with, even for a standing-rule payout', async () => {
    const watch = new FakeWatch()
    const h = await funded({ watch })
    await publishStanding(h.app, [RULE])
    watch.failStatus = 502
    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId) })
    expect(asked.json.phase).toBe('locked')
    watch.failStatus = 0
    h.db.prepare('UPDATE proposals SET amount_cents = 90000 WHERE id = ?').run(asked.json.id)
    await h.services.mandate.sweepStanding()
    expect(h.paypal!.payoutCalls).toBe(0)
    // A broken lock is not something waiting can fix, so the payout is refused for good and stops holding the money.
    expect((await call(h.app, 'GET', `/v1/proposals/${asked.json.id}`)).json.phase).toBe('capture_refused')
    expect(await eventTypes(h.app, asked.json.id)).toContain('capture.refused')
    expect(await h.services.mandate.sweepStanding()).toBe(0)
  })
})

describe('writing a standing rule', () => {
  it('only the owner can publish one', async () => {
    const h = harness()
    const current = (await call(h.app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    const refused = await call(h.app, 'PUT', '/v1/warrant', { key: STUDIO_KEY, body: { ...body, standing: [RULE] } })
    expect(refused.status).toBe(403)
    expect(OWNER_KEY).toBeTruthy()
  })

  it('refuses a rule that names someone who is not on the rules, or that works without funding', async () => {
    const h = harness()
    expect((await publishStanding(h.app, [{ ...RULE, payeeId: 'payee_ghost' }])).status).toBe(400)
    expect((await publishStanding(h.app, [{ ...RULE, clientIds: ['client_ghost'] }])).status).toBe(400)
    expect((await publishStanding(h.app, [RULE], { fundingRequired: false })).status).toBe(400)
    expect((await publishStanding(h.app, [RULE, RULE])).status).toBe(400)
  })
})

describe('finishing without anyone pressing Check', () => {
  it('settles a payout PayPal was still processing, on the server\'s own look', async () => {
    const paypal = new FakePayPal()
    paypal.payoutOutcome = 'PENDING'
    const h = await funded({ paypal })
    await publishStanding(h.app, [RULE])
    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(h.captureId) })
    expect(asked.json).toMatchObject({ clause: 'standing.matched', phase: 'payout_sent', payoutStatus: 'PENDING' })
    // Still processing: the look changes nothing.
    expect(await h.services.mandate.sweepPending()).toMatchObject({ payouts: 1, invoices: 0 })
    expect((await call(h.app, 'GET', `/v1/proposals/${asked.json.id}`)).json.phase).toBe('payout_sent')
    paypal.settlePayouts('SUCCESS')
    await h.services.mandate.sweepPending()
    expect((await call(h.app, 'GET', `/v1/proposals/${asked.json.id}`)).json).toMatchObject({ phase: 'captured', payoutStatus: 'SUCCESS', capturedAmountCents: 9_000 })
    expect(paypal.payoutCalls).toBe(1)
    expect(await h.services.mandate.sweepPending()).toMatchObject({ payouts: 0, invoices: 0 })
  })

  it('settles an invoice the client has paid, and never settles one they have not', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const deal = await agree(h.app)
    const bill = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    await call(h.app, 'POST', `/v1/proposals/${bill.json.id}/approve`)
    expect((await call(h.app, 'POST', `/v1/proposals/${bill.json.id}/capture`)).json.phase).toBe('invoice_sent')
    await h.services.mandate.sweepPending()
    expect((await call(h.app, 'GET', `/v1/proposals/${bill.json.id}`)).json.phase).toBe('invoice_sent')
    invoices.pay([...invoices.invoices.keys()][0]!)
    await h.services.mandate.sweepPending()
    expect((await call(h.app, 'GET', `/v1/proposals/${bill.json.id}`)).json).toMatchObject({ phase: 'captured', capturedAmountCents: 15_000 })
  })
})
