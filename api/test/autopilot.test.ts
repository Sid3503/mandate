import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices, FakePayPal, FakeWatch } from '../src/paypal/fake'
import { agree, call, closeAll, EVIDENCE, harness, idem, JOB, NOW, STUDIO_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]

const RULE = { id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }
const ON = { billSignedDeals: true, payOnSettle: true, remindUnpaidAfterDays: null, maxReminders: 2 }

/** Publishes the next rules version with changes on top of the current one. This is the owner's one yes. */
async function publish(app: App, patch: Record<string, unknown>) {
  const current = (await call(app, 'GET', '/v1/warrant')).json
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  return call(app, 'PUT', '/v1/warrant', { body: { ...body, ...patch } })
}

async function studio(options: Parameters<typeof harness>[0] = {}) {
  const invoices = options.invoices === undefined ? new FakeInvoices() : options.invoices
  const h = harness({ ...options, invoices })
  const deal = await agree(h.app)
  return { ...h, deal, invoices: invoices as FakeInvoices }
}

const bill = (h: { app: App; deal: { id: string } }, milestone = 0, key?: string, evidenceUrl = EVIDENCE) =>
  call(h.app, 'POST', `/v1/deals/${h.deal.id}/milestones/${milestone}/bill`, { key, body: { evidenceUrl } })

const one = async (app: App, id: string) => (await call(app, 'GET', `/v1/proposals/${id}`)).json
const types = async (app: App, id: string) => (await call(app, 'GET', `/v1/proposals/${id}/packet`)).json.events.map((event: { type: string }) => event.type) as string[]
const payouts = async (app: App) => (await call(app, 'GET', '/v1/proposals')).json.data.filter((row: { kind: string }) => row.kind === 'payment') as Array<Record<string, any>>

describe('autopilot: billing a signed deal when the work is delivered', () => {
  it('sends the invoice with no tap, for exactly the agreed milestone, and signs the lock', async () => {
    const h = await studio()
    expect((await publish(h.app, { automation: { ...ON, payOnSettle: false } })).status).toBe(201)
    const billed = await bill(h, 0, STUDIO_KEY)
    expect(billed.status).toBe(201)
    expect(billed.json).toMatchObject({ gate: 'AUTO', clause: 'standing.billing', phase: 'invoice_sent', amountCents: 15_000, invoiceStatus: 'SENT' })
    const made = [...h.invoices.invoices.values()][0]!
    expect(made).toMatchObject({ totalCents: 15_000, email: 'ap@northwind.example', reference: billed.json.id })
    expect(await types(h.app, billed.json.id)).not.toContain('proposal.approved')
    expect((await call(h.app, 'GET', `/v1/proposals/${billed.json.id}/packet`)).json.lock.signatureValid).toBe(true)
    // Asking again is a replay, not a second invoice.
    const again = await bill(h, 0, STUDIO_KEY)
    expect(again.json.id).toBe(billed.json.id)
    expect(h.invoices.createCalls).toBe(1)
  })

  it('still needs a tap until the owner switches it on', async () => {
    const h = await studio()
    const billed = await bill(h, 0, STUDIO_KEY)
    expect(billed.json).toMatchObject({ gate: 'NEEDS_APPROVAL', phase: 'pending_approval' })
    expect(h.invoices.createCalls).toBe(0)
  })

  it('bills a milestone once, and only for the amount the deal says', async () => {
    const h = await studio()
    await publish(h.app, { automation: { ...ON, payOnSettle: false } })
    await bill(h, 0, STUDIO_KEY)
    const twice = await bill(h, 0, STUDIO_KEY, 'https://www.figma.com/file/another-link')
    expect(twice.json).toMatchObject({ gate: 'DENY', clause: 'deal.milestone_billed' })
    const wrong = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 14_000, currency: 'USD', category: 'design', description: 'x', evidenceUrl: EVIDENCE, jobId: h.deal.jobId, dealId: h.deal.id, milestone: 1 } })
    expect(wrong.json).toMatchObject({ gate: 'DENY', clause: 'deal.milestone_mismatch' })
    const noProof = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design', description: 'x', jobId: h.deal.jobId, dealId: h.deal.id, milestone: 1 } })
    expect(noProof.json).toMatchObject({ gate: 'DENY', clause: 'evidence.missing' })
    expect(h.invoices.createCalls).toBe(1)
  })

  it('does not cover a charge that is not a milestone of a signed deal', async () => {
    const h = await studio()
    await publish(h.app, { automation: { ...ON, payOnSettle: false } })
    const adHoc = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design', description: 'Extra work', evidenceUrl: EVIDENCE, jobId: 'job_no_deal' } })
    expect(adHoc.json).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval' })
    expect(h.invoices.createCalls).toBe(0)
  })

  it('waits for the client at checkout when the app cannot invoice, and settles once they approve', async () => {
    const paypal = new FakePayPal()
    paypal.autoApprove = false
    const invoices = new FakeInvoices()
    invoices.unauthorised = true
    const h = await studio({ paypal, invoices })
    await publish(h.app, { automation: { ...ON, payOnSettle: false } })
    const billed = await bill(h, 0, STUDIO_KEY)
    expect(billed.json).toMatchObject({ gate: 'AUTO', clause: 'standing.billing', phase: 'order_created' })
    expect(await types(h.app, billed.json.id)).toContain('standing.waiting')
    await h.services.mandate.sweepStanding()
    expect((await one(h.app, billed.json.id)).phase).toBe('order_created')
    paypal.approveAll()
    await h.services.mandate.sweepStanding()
    expect(await one(h.app, billed.json.id)).toMatchObject({ phase: 'captured', capturedAmountCents: 15_000 })
  })
})

describe('autopilot: paying the contractor when the client pays', () => {
  it('runs the whole job with nobody touching it: deal, proof, invoice, payment, payout', async () => {
    const h = await studio()
    await publish(h.app, { standing: [RULE], automation: ON })
    const billed = await bill(h, 0, STUDIO_KEY)
    expect(billed.json.phase).toBe('invoice_sent')
    // Nothing is paid out before the client pays.
    expect(await payouts(h.app)).toHaveLength(0)

    // The client pays the invoice in PayPal. The server's own look at PayPal finds it.
    h.invoices.pay(billed.json.invoiceId)
    await h.services.mandate.sweepPending()

    expect(await one(h.app, billed.json.id)).toMatchObject({ phase: 'captured', capturedAmountCents: 15_000 })
    const [payout] = (await payouts(h.app)) as [Record<string, any>]
    expect(payout).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', phase: 'captured', amountCents: 9_000, payeeId: 'payee_priya', fundingCaptureId: (await one(h.app, billed.json.id)).captureId })
    const created = (await call(h.app, 'GET', `/v1/proposals/${payout.id}/packet`)).json.events.find((event: { type: string }) => event.type === 'proposal.created')
    expect(created.payload.actor).toBe('autopilot')
    expect(await types(h.app, billed.json.id)).toContain('autopilot.payout_asked')
    expect((await call(h.app, 'GET', `/v1/jobs/${JOB}`)).json.totals).toEqual({ inCents: 15_000, outCents: 9_000, heldCents: 0, keptCents: 6_000 })

    // Looking again changes nothing: one payout, one PayPal call.
    await h.services.mandate.sweepPending()
    await h.services.mandate.sweepStanding()
    expect(await payouts(h.app)).toHaveLength(1)
    expect(h.paypal!.payoutCalls).toBe(1)
  })

  it('does not treat PayPal UNCLAIMED as captured', async () => {
    const paypal = new FakePayPal()
    paypal.unregistered.add('priya.shah@example.com')
    const h = await studio({ paypal })
    await publish(h.app, { standing: [RULE], automation: ON })
    const billed = await bill(h, 0, STUDIO_KEY)
    h.invoices.pay(billed.json.invoiceId)
    await h.services.mandate.sweepPending()
    const [payout] = (await payouts(h.app)) as [Record<string, any>]
    expect(payout.phase).not.toBe('captured')
    expect(payout).toMatchObject({ gate: 'AUTO', phase: 'payout_unclaimed', payoutStatus: 'UNCLAIMED' })
  })

  it('does nothing until the client has paid, and never for a rule the owner did not sign', async () => {
    const h = await studio()
    await publish(h.app, { automation: { ...ON, payOnSettle: false }, standing: [RULE] })
    const billed = await bill(h, 0, STUDIO_KEY)
    h.invoices.pay(billed.json.invoiceId)
    await h.services.mandate.sweepPending()
    expect(await one(h.app, billed.json.id)).toMatchObject({ phase: 'captured' })
    expect(await payouts(h.app)).toHaveLength(0)
    expect(h.paypal!.payoutCalls).toBe(0)
  })

  it('splits a client payment between contractors by the share each rule names', async () => {
    const h = await studio()
    const current = (await call(h.app, 'GET', '/v1/warrant')).json
    await publish(h.app, {
      payees: [...current.payees, { id: 'payee_sam', displayName: 'Sam Rao', email: 'sam@example.com', aliases: ['Sam'] }],
      standing: [{ ...RULE, shareBps: 4_000 }, { id: 'sam_from_northwind', payeeId: 'payee_sam', clientIds: ['client_northwind'], requireDeal: true, shareBps: 2_000 }],
      automation: ON,
    })
    const billed = await bill(h, 0, STUDIO_KEY)
    h.invoices.pay(billed.json.invoiceId)
    await h.services.mandate.sweepPending()
    const paid = Object.fromEntries((await payouts(h.app)).map((row) => [row.payeeId, row.amountCents]))
    expect(paid).toEqual({ payee_priya: 6_000, payee_sam: 3_000 })
    expect((await call(h.app, 'GET', `/v1/jobs/${JOB}`)).json.totals).toEqual({ inCents: 15_000, outCents: 9_000, heldCents: 0, keptCents: 6_000 })
  })

  it('refuses to publish rules that promise contractors more than their share, or pay-on-settle with nobody to pay', async () => {
    const h = await studio()
    const current = (await call(h.app, 'GET', '/v1/warrant')).json
    const over = await publish(h.app, {
      payees: [...current.payees, { id: 'payee_sam', displayName: 'Sam Rao', email: 'sam@example.com', aliases: [] }],
      standing: [{ ...RULE, shareBps: 4_000 }, { id: 'sam', payeeId: 'payee_sam', clientIds: ['client_northwind'], requireDeal: true, shareBps: 3_000 }],
    })
    expect(over.status).toBe(400)
    expect((await publish(h.app, { standing: [RULE, { ...RULE, id: 'again' }] })).status).toBe(400)
    expect((await publish(h.app, { automation: { ...ON } })).status).toBe(400)
    expect((await publish(h.app, { automation: { ...ON, remindUnpaidAfterDays: 0 }, standing: [RULE] })).status).toBe(400)
  })

  it('records a refusal instead of paying when the cap or a dispute stands in the way', async () => {
    const watch = new FakeWatch()
    const h = await studio({ watch })
    await publish(h.app, { standing: [RULE], automation: ON, monthlyCapCents: 5_000 })
    const billed = await bill(h, 0, STUDIO_KEY)
    h.invoices.pay(billed.json.invoiceId)
    await h.services.mandate.sweepPending()
    const [refused] = await payouts(h.app)
    expect(refused).toMatchObject({ gate: 'DENY', clause: 'cap.monthly', phase: 'denied' })
    expect(h.paypal!.payoutCalls).toBe(0)
    expect(await types(h.app, billed.json.id)).toContain('autopilot.payout_asked')

    const second = await studio({ watch })
    await publish(second.app, { standing: [RULE], automation: ON })
    const b2 = await bill(second, 0, STUDIO_KEY)
    second.invoices.pay(b2.json.invoiceId)
    const captureId = `CAP-INV-${b2.json.invoiceId.slice(5, 17)}`
    watch.disputes = [{ id: 'PP-D-7', status: 'UNDER_REVIEW', reason: null, cents: 15_000, currency: 'USD', openedAt: null, updatedAt: null, transactionIds: [captureId] }]
    await second.services.mandate.sweepPending()
    expect((await payouts(second.app))[0]).toMatchObject({ gate: 'DENY', clause: 'funding.disputed' })
    expect(second.paypal!.payoutCalls).toBe(0)
  })

  it('does not pay for a charge that settled before the owner switched it on', async () => {
    const h = await studio()
    const billed = await bill(h, 0)
    await call(h.app, 'POST', `/v1/proposals/${billed.json.id}/approve`)
    await call(h.app, 'POST', `/v1/proposals/${billed.json.id}/capture`)
    h.invoices.pay(billed.json.invoiceId ?? [...h.invoices.invoices.keys()][0]!)
    await call(h.app, 'POST', `/v1/proposals/${billed.json.id}/capture`)
    expect((await one(h.app, billed.json.id)).phase).toBe('captured')
    await publish(h.app, { standing: [RULE], automation: ON })
    await call(h.app, 'POST', `/v1/proposals/${billed.json.id}/capture`)
    await h.services.mandate.sweepPending()
    expect(await payouts(h.app)).toHaveLength(0)
  })
})

describe('autopilot: chasing an unpaid invoice', () => {
  const day = 86_400_000

  it('sends PayPal\'s reminder on the owner\'s schedule, no more than the maximum, and stops once it is paid', async () => {
    const h = await studio()
    await publish(h.app, { automation: { ...ON, payOnSettle: false, remindUnpaidAfterDays: 3, maxReminders: 2 } })
    const billed = await bill(h, 0, STUDIO_KEY)
    const sweep = async (days: number) => { h.setNow(new Date(NOW.getTime() + days * day)); return h.services.mandate.sweepPending() }

    expect((await sweep(2)).reminded).toBe(0)
    expect((await sweep(3)).reminded).toBe(1)
    expect((await sweep(4)).reminded).toBe(0)
    expect((await sweep(6)).reminded).toBe(1)
    expect((await sweep(9)).reminded).toBe(0)
    expect(h.invoices.remindCalls).toHaveLength(2)
    const reminded = (await call(h.app, 'GET', `/v1/proposals/${billed.json.id}/packet`)).json.events.filter((event: { type: string }) => event.type === 'invoice.reminded')
    expect(reminded.map((event: { payload: { via: string } }) => event.payload.via)).toEqual(['autopilot', 'autopilot'])
    // The invoice itself is untouched by chasing.
    expect([...h.invoices.invoices.values()][0]).toMatchObject({ status: 'SENT', totalCents: 15_000 })
  })

  it('never chases without the owner\'s schedule, and never chases a paid invoice', async () => {
    const h = await studio()
    await publish(h.app, { automation: { ...ON, payOnSettle: false, remindUnpaidAfterDays: null } })
    const billed = await bill(h, 0, STUDIO_KEY)
    h.setNow(new Date(NOW.getTime() + 30 * day))
    expect((await h.services.mandate.sweepPending()).reminded).toBe(0)
    await publish(h.app, { automation: { ...ON, payOnSettle: false, remindUnpaidAfterDays: 1, maxReminders: 3 } })
    h.invoices.pay(billed.json.invoiceId)
    expect((await h.services.mandate.sweepPending()).reminded).toBe(0)
    expect(h.invoices.remindCalls).toHaveLength(0)
  })
})
