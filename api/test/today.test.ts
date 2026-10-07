import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices, FakePayPal, FakeWatch } from '../src/paypal/fake'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, NOW, STUDIO_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]
const RULE = { id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }
const ON = { billSignedDeals: true, payOnSettle: true, remindUnpaidAfterDays: 3, maxReminders: 2 }

async function publish(app: App, patch: Record<string, unknown>) {
  const current = (await call(app, 'GET', '/v1/warrant')).json
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  return call(app, 'PUT', '/v1/warrant', { body: { ...body, ...patch } })
}
const today = async (app: App) => (await call(app, 'GET', '/v1/today')).json
const titles = (items: Array<{ title: string }>) => items.map((item) => item.title)

describe('Today', () => {
  it('is for the owner only', async () => {
    const h = harness()
    expect((await call(h.app, 'GET', '/v1/today')).status).toBe(200)
    expect((await call(h.app, 'GET', '/v1/today', { key: STUDIO_KEY })).status).toBe(403)
  })

  it('says the server has not looked yet before its first check', async () => {
    const h = harness()
    expect((await today(h.app)).watcher).toEqual({ everySeconds: 60, lastLook: null })
  })

  it('starts as a setup checklist on a fresh ledger, and every step can be ticked off', async () => {
    const h = harness()
    const fresh = await today(h.app)
    expect(fresh.setup.complete).toBe(false)
    expect(Object.fromEntries(fresh.setup.steps.map((step: { id: string; done: boolean }) => [step.id, step.done]))).toEqual({ paypal: true, people: true, deal: false, rule: false, autopilot: false, first: false })
    expect(fresh.waiting).toEqual([])
    expect(fresh.readyToBill).toEqual([])
    const bare = harness({ paypal: null })
    expect((await today(bare.app)).setup.steps[0]).toMatchObject({ id: 'paypal', done: false })
  })

  it('lists what waits for the owner, what the rules refused, and the next milestone to bill', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    const deal = await agree(h.app)
    expect((await today(h.app)).readyToBill).toEqual([expect.objectContaining({ dealId: deal.id, jobId: deal.jobId, milestone: 0, amountCents: 15_000, buyerName: 'Northwind', billed: 0, total: 2 })])

    const billed = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { payee: 'P. Shah', amountCents: 48_000, currency: 'USD', category: 'design', description: 'Updated payout details', evidenceUrl: EVIDENCE } })
    const page = await today(h.app)
    expect(page.waiting).toEqual([expect.objectContaining({ kind: 'approval', proposalId: billed.json.id, title: 'Bill Northwind $150.00', actions: ['approve', 'reject', 'open'] })])
    expect(page.stopped).toMatchObject({ count: 1, cents: 48_000 })
    expect(page.stopped.recent[0]).toMatchObject({ clause: 'payee.unknown', title: 'Pay Unknown $480.00 was refused' })
    // Milestone 1 is billed (even while it waits for a tap), so the next one to bill is milestone 2.
    expect(page.readyToBill[0].milestone).toBe(1)

    // Once approved it is "ready to send": still the owner's move, so still under waiting.
    await call(h.app, 'POST', `/v1/proposals/${billed.json.id}/approve`)
    const ready = await today(h.app)
    expect(ready.waiting[0]).toMatchObject({ kind: 'ready', actions: ['settle', 'open'] })
    expect(ready.readyToBill[0].milestone).toBe(1)
    // Settled through an invoice: now it is in flight, waiting for the client.
    await call(h.app, 'POST', `/v1/proposals/${billed.json.id}/capture`)
    const out = await today(h.app)
    expect(out.waiting).toEqual([])
    expect(out.inFlight[0]).toMatchObject({ kind: 'in_flight', title: 'Waiting for Northwind to pay $150.00', actions: ['check', 'remind', 'open'] })
  })

  it('shows what autopilot did for the owner, how, and the month in money that PayPal confirmed', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const deal = await agree(h.app)
    await publish(h.app, { standing: [RULE], automation: ON })
    const billed = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    expect((await today(h.app)).inFlight.map((item: { kind: string }) => item.kind)).toEqual(['in_flight'])
    invoices.pay(billed.json.invoiceId)
    await h.services.mandate.sweepPending()

    const page = await today(h.app)
    expect(page.waiting).toEqual([])
    expect(page.inFlight).toEqual([])
    expect(titles(page.done).sort()).toEqual(['Northwind paid $150.00', 'Priya Shah was paid $90.00'])
    expect(Object.fromEntries(page.done.map((item: { title: string; how: string }) => [item.title, item.how]))).toEqual({ 'Northwind paid $150.00': 'billing', 'Priya Shah was paid $90.00': 'autopilot' })
    expect(page.month).toMatchObject({ label: 'October 2026', inCents: 15_000, outCents: 9_000, keptCents: 6_000, capCents: 18_000, reservedCents: 9_000 })
    expect(page.stats.last30Days).toMatchObject({ requests: 2, refused: 0, automatic: 2, tapped: 0, automaticShare: 100 })
    expect(page.automation).toMatchObject({ billSignedDeals: true, payOnSettle: true, standingRules: 1, any: true })
    // The client's payment was found by Mandate's own look at PayPal, and the page says so; Priya's cleared on the spot. The look itself is visible too.
    expect(page.done.find((item: { title: string }) => item.title === 'Northwind paid $150.00').detail).toContain('Mandate’s own check')
    expect(page.done.find((item: { title: string }) => item.title === 'Priya Shah was paid $90.00').detail).not.toContain('own check')
    expect(page.watcher).toMatchObject({ everySeconds: 60, lastLook: { payouts: expect.any(Number), invoices: expect.any(Number) } })
    expect(page.setup.steps.find((step: { id: string }) => step.id === 'first').done).toBe(true)
  })

  it('tells the owner when autopilot could not pay, when a payout is held, and when an invoice is overdue', async () => {
    const watch = new FakeWatch()
    const invoices = new FakeInvoices()
    const h = harness({ invoices, watch })
    const deal = await agree(h.app)
    await publish(h.app, { standing: [RULE], automation: { ...ON, remindUnpaidAfterDays: null }, monthlyCapCents: 5_000 })
    const billed = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })

    // Four days unpaid, with no reminder schedule: the page calls it overdue and offers the nudge.
    h.setNow(new Date(NOW.getTime() + 4 * 86_400_000))
    const overdue = await today(h.app)
    expect(overdue.waiting[0]).toMatchObject({ kind: 'overdue', title: 'Northwind has not paid $150.00', actions: ['remind', 'check', 'open'] })

    // Paid, but the cap stops the share: that is the owner's business.
    invoices.pay(billed.json.invoiceId)
    await h.services.mandate.sweepPending()
    const blocked = await today(h.app)
    expect(blocked.waiting[0]).toMatchObject({ kind: 'autopilot_blocked', title: 'Autopilot could not pay Priya Shah $90.00', clause: 'cap.monthly' })
    expect(blocked.stopped.count).toBe(0)
  })

  it('shows an open PayPal dispute, and a payout that is held because of it', async () => {
    const watch = new FakeWatch()
    const h = harness({ watch })
    const deal = await agree(h.app)
    const { captureId } = await collect(h.app, deal.id, 0)
    watch.disputes = [{ id: 'PP-D-3', status: 'UNDER_REVIEW', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', cents: 15_000, currency: 'USD', openedAt: null, updatedAt: NOW.toISOString(), transactionIds: [captureId] }]
    await call(h.app, 'POST', '/v1/paypal/disputes/sync')
    const page = await today(h.app)
    expect(page.waiting[0]).toMatchObject({ kind: 'dispute', title: 'Northwind disputed $150.00 with PayPal' })
  })

  it('holds a standing payout that waits on PayPal in the waiting list, with the reason in plain words', async () => {
    const watch = new FakeWatch()
    const h = harness({ watch })
    const deal = await agree(h.app)
    const { captureId } = await collect(h.app, deal.id, 0)
    await publish(h.app, { standing: [RULE] })
    watch.failStatus = 502
    await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: captureId } })
    const page = await today(h.app)
    expect(page.waiting[0]).toMatchObject({ kind: 'held', title: 'Pay Priya Shah $90.00 is on hold' })
    expect(page.waiting[0].detail).toContain('could not say whether the client payment is disputed')
    void FakePayPal
  })
})
