import { afterEach, describe, expect, it } from 'vitest'
import { Clause, decide } from '../src/domain/gate'
import { ProposalCreateSchema } from '../src/domain/schemas'
import { applyPause, isSuspiciousRefusal, NOT_PAUSED, RefusalCounter, type PauseState } from '../src/domain/safety'
import { FakeInvoices } from '../src/paypal/fake'
import { agree, BUYER_KEY, call, closeAll, EVIDENCE, harness, idem, JOB, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

const PAUSED: PauseState = { paused: true, reason: 'test', since: '2026-10-09T00:00:00Z', by: 'owner', epoch: 0 }
const auto = { gate: 'AUTO', clause: 'amount.auto', detail: 'x' } as const
const tap = { gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval', detail: 'x' } as const
const deny = { gate: 'DENY', clause: 'payee.unknown', detail: 'x' } as const

describe('the pause, as a pure rule', () => {
  it('changes nothing when not paused', () => {
    for (const decision of [auto, tap, deny]) expect(applyPause(decision, NOT_PAUSED, 'proposer')).toBe(decision)
  })

  it('refuses everything an agent, the studio\'s key or the autopilot would have got, and keeps a refusal as it was', () => {
    for (const actor of ['proposer', 'autopilot']) {
      expect(applyPause(auto, PAUSED, actor)).toMatchObject({ gate: 'DENY', clause: Clause.systemPaused })
      expect(applyPause(tap, PAUSED, actor)).toMatchObject({ gate: 'DENY', clause: Clause.systemPaused })
      expect(applyPause(deny, PAUSED, actor)).toBe(deny)
    }
  })

  it('lets the owner ask, but never lets anything go through without their tap', () => {
    expect(applyPause(auto, PAUSED, 'owner')).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: Clause.systemPaused })
    expect(applyPause(tap, PAUSED, 'owner')).toBe(tap)
    expect(applyPause(deny, PAUSED, 'owner')).toBe(deny)
  })
})

describe('the breaker\'s counter', () => {
  it('trips on the third odd refusal inside the window, and forgets old ones', () => {
    const counter = new RefusalCounter(3, 120_000)
    expect(counter.record('proposer', 'payee.unknown', 0)).toBeNull()
    expect(counter.record('proposer', 'cart.immutable', 30_000)).toBeNull()
    expect(counter.record('proposer', 'category.missing', 60_000)).toMatchObject({ count: 3, clauses: ['payee.unknown', 'cart.immutable', 'category.missing'] })
    expect(counter.record('proposer', 'payee.unknown', 61_000)).toBeNull()
    expect(counter.record('proposer', 'payee.unknown', 400_000)).toBeNull()
    expect(counter.record('proposer', 'payee.unknown', 410_000)).toBeNull()
  })

  it('counts each asker on its own, ignores "not yet" and "incomplete", and is off at zero', () => {
    const counter = new RefusalCounter(2, 60_000)
    expect(counter.record('a', 'payee.unknown', 0)).toBeNull()
    expect(counter.record('b', 'payee.unknown', 1)).toBeNull()
    for (const clause of ['funding.missing', 'evidence.missing', 'job.missing', 'system.paused']) {
      expect(isSuspiciousRefusal(clause)).toBe(false)
      expect(counter.record('a', clause, 2)).toBeNull()
    }
    expect(new RefusalCounter(0, 60_000).record('a', 'payee.unknown', 0)).toBeNull()
  })
})

const ask = (app: Parameters<typeof call>[0], overrides: Record<string, unknown> = {}, key = STUDIO_KEY) =>
  call(app, 'POST', '/v1/proposals', { key, idem: idem(), body: { kind: 'payment', payee: 'Priya', amountCents: 1_000, currency: 'USD', category: 'design', description: 'x', evidenceUrl: EVIDENCE, ...overrides } })

const publish = async (app: Parameters<typeof call>[0], patch: Record<string, unknown>) => {
  const current = (await call(app, 'GET', '/v1/warrant')).json
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  return call(app, 'PUT', '/v1/warrant', { body: { ...body, ...patch } })
}

describe('pausing and resuming', () => {
  it('is the owner\'s button: anyone can see the state, only the owner can change it, and it is written down once, signed', async () => {
    const h = harness()
    expect((await call(h.app, 'POST', '/v1/safety/pause', { key: STUDIO_KEY })).status).toBe(403)
    expect((await call(h.app, 'GET', '/v1/safety', { key: STUDIO_KEY })).json).toMatchObject({ paused: false })
    const paused = await call(h.app, 'POST', '/v1/safety/pause', { body: { reason: 'Odd requests on Friday' } })
    expect(paused.json).toMatchObject({ paused: true, reason: 'Odd requests on Friday', by: 'owner' })
    await call(h.app, 'POST', '/v1/safety/pause')
    const state = (await call(h.app, 'GET', '/v1/safety')).json
    expect(state.events).toHaveLength(1)
    expect(state.events[0]).toMatchObject({ type: 'paused', by: 'owner', signed: true })
    expect((await call(h.app, 'GET', '/v1/status', { key: STUDIO_KEY })).json.paused).toMatchObject({ reason: 'Odd requests on Friday', by: 'owner' })
    const resumed = await call(h.app, 'POST', '/v1/safety/resume')
    expect(resumed.json).toMatchObject({ paused: false, epoch: 1 })
    expect((await call(h.app, 'GET', '/v1/safety')).json.events.map((event: { type: string }) => event.type)).toEqual(['resumed', 'paused'])
  })

  it('refuses the studio\'s key with the reason written on the receipt, and makes the owner\'s own small payment wait for a tap', async () => {
    const h = harness()
    // With payouts no longer needing client money, a $10 payout to Priya goes through with no tap: the thing a pause must stop.
    await publish(h.app, { fundingRequired: false, standing: [] })
    expect((await ask(h.app)).json).toMatchObject({ gate: 'AUTO' })
    await call(h.app, 'POST', '/v1/safety/pause', { body: { reason: 'Odd requests' } })
    const refused = await ask(h.app)
    expect(refused.json).toMatchObject({ gate: 'DENY', clause: 'system.paused', phase: 'denied' })
    expect(refused.json.detail).toContain('Odd requests')
    // The owner can still ask, but a payment that would have gone with no tap now waits for one.
    expect((await ask(h.app, {}, OWNER_KEY)).json).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'system.paused', phase: 'pending_approval' })
    await call(h.app, 'POST', '/v1/safety/resume')
    expect((await ask(h.app)).json).toMatchObject({ gate: 'AUTO' })
  })

  it('trips by itself on three odd refusals in two minutes, says why, and stays paused until the owner resumes', async () => {
    const h = harness({ breaker: { tripAfter: 3, windowSeconds: 120 } })
    await publish(h.app, { fundingRequired: false, standing: [] })
    await ask(h.app, { payee: 'Mallory' })
    await ask(h.app, { payee: 'Eve' })
    expect((await call(h.app, 'GET', '/v1/safety')).json.paused).toBe(false)
    await ask(h.app, { payee: 'Trent' })
    const state = (await call(h.app, 'GET', '/v1/safety')).json
    expect(state).toMatchObject({ paused: true, by: 'breaker' })
    expect(state.reason).toContain('3 refusals from the studio\'s key in 2 minutes')
    expect(state.events[0]).toMatchObject({ type: 'paused', by: 'breaker', signed: true })
    expect(state.events[0].detail).toContain('payee.unknown')
    expect((await ask(h.app)).json).toMatchObject({ gate: 'DENY', clause: 'system.paused' })
    // The owner's own mistakes never trip it.
    expect((await call(h.app, 'POST', '/v1/safety/resume')).json.paused).toBe(false)
    for (let n = 0; n < 4; n += 1) await ask(h.app, { payee: `Nobody${n}` }, OWNER_KEY)
    expect((await call(h.app, 'GET', '/v1/safety')).json.paused).toBe(false)
  })

  it('does not count a request that is merely early', async () => {
    const h = harness({ breaker: { tripAfter: 3, windowSeconds: 120 } })
    for (let n = 0; n < 6; n += 1) await ask(h.app)
    expect((await call(h.app, 'GET', '/v1/safety')).json.paused).toBe(false)
  })
})

describe('autopilot across a pause', () => {
  const RULE = { id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }
  const ON = { billSignedDeals: true, requireAcceptance: false, payOnSettle: true, remindUnpaidAfterDays: null, maxReminders: 2 }
  it('waits to pay the contractor while paused, pays on resume, and the audit says nothing ran on its own meanwhile', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const deal = await agree(h.app)
    await publish(h.app, { standing: [RULE], automation: ON })
    const billed = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    expect(billed.json.phase).toBe('invoice_sent')

    await call(h.app, 'POST', '/v1/safety/pause', { body: { reason: 'Friday check' } })
    invoices.pay(billed.json.invoiceId)
    await h.services.mandate.sweepPending()
    // The client's money arrived (that is PayPal's fact), but the autopilot asked for nothing and sent nothing.
    expect((await call(h.app, 'GET', `/v1/proposals/${billed.json.id}`)).json).toMatchObject({ phase: 'captured' })
    const none = (await call(h.app, 'GET', '/v1/proposals')).json.data.filter((row: { kind: string }) => row.kind === 'payment')
    expect(none).toHaveLength(0)
    expect(h.paypal!.payoutCalls).toBe(0)

    await call(h.app, 'POST', '/v1/safety/resume')
    const paid = (await call(h.app, 'GET', '/v1/proposals')).json.data.filter((row: { kind: string }) => row.kind === 'payment')
    expect(paid).toHaveLength(1)
    expect(paid[0]).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', amountCents: 9_000, phase: 'captured' })
    expect(h.paypal!.payoutCalls).toBe(1)
    // A second resume or sweep changes nothing.
    await h.services.mandate.resumeAutopilot()
    expect(h.paypal!.payoutCalls).toBe(1)

    const audit = (await call(h.app, 'GET', '/v1/audit')).json
    expect(audit.checks.find((check: { id: string }) => check.id === 'safety.respected')).toMatchObject({ status: 'pass', note: '1 pause on record.' })
    expect(audit.ok).toBe(true)
  })

  it('holds a payout the rules had already approved, locked, until Mandate is resumed', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const deal = await agree(h.app)
    await publish(h.app, { standing: [RULE], automation: { ...ON, payOnSettle: false } })
    const billed = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    invoices.pay(billed.json.invoiceId)
    await h.services.mandate.sweepPending()
    const captured = (await call(h.app, 'GET', `/v1/proposals/${billed.json.id}`)).json
    // Locked by the owner's standing rule but not yet sent (PayPal was busy, say): the state a pause must hold still.
    const locked = h.services.mandate.propose(ProposalCreateSchema.parse({ kind: 'payment', payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: captured.captureId }), idem(), 'proposer')
    const asked = { json: locked.body as { id: string; gate: string; clause: string; phase: string } }
    expect(asked.json).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', phase: 'locked' })
    await call(h.app, 'POST', '/v1/safety/pause')
    await h.services.mandate.sweepStanding()
    expect((await call(h.app, 'GET', `/v1/proposals/${asked.json.id}`)).json.phase).toBe('locked')
    expect(h.paypal!.payoutCalls).toBe(0)
    await call(h.app, 'POST', '/v1/safety/resume')
    expect((await call(h.app, 'GET', `/v1/proposals/${asked.json.id}`)).json.phase).toBe('captured')
    expect(h.paypal!.payoutCalls).toBe(1)
  })

  it('keeps a delivery the client accepted while paused, and bills it on resume', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const deal = await agree(h.app)
    await publish(h.app, { automation: { billSignedDeals: true, requireAcceptance: true, payOnSettle: false, remindUnpaidAfterDays: null, maxReminders: 2 } })
    await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/deliver`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    await call(h.app, 'POST', '/v1/safety/pause')
    const decided = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/decision`, { key: BUYER_KEY, body: { decision: 'accepted' } })
    expect(decided.json.delivery.status).toBe('accepted')
    expect(decided.json.charge).toBeNull()
    expect(invoices.createCalls).toBe(0)
    await call(h.app, 'POST', '/v1/safety/resume')
    expect(invoices.createCalls).toBe(1)
    const charges = (await call(h.app, 'GET', '/v1/proposals')).json.data.filter((row: { kind: string }) => row.kind === 'charge')
    expect(charges[0]).toMatchObject({ phase: 'invoice_sent', clause: 'standing.billing' })
  })

  it('P7.T1: gate gets a plain safety input, matching request returns DENY system.paused, and reads still work', async () => {
    const h = harness()
    const warrant = (await call(h.app, 'GET', '/v1/warrant')).json
    const body = { ...(warrant.body ?? warrant), fundingRequired: false, standing: [] }

    // 1. Direct decide evaluation with plain safety input
    const baseProposal = {
      kind: 'payment' as const,
      payeeId: 'payee_priya',
      amountCents: 1000,
      currency: 'USD',
      category: 'design',
      evidenceUrl: EVIDENCE,
      parent: null,
    }

    // When paused, proposer gets DENY system.paused
    const pausedProposer = decide(body, {
      ...baseProposal,
      safety: { paused: true, reason: 'Maintenance window' },
      actor: 'proposer',
    }, { reservedCents: 0, priorCaptureIds: [] })
    expect(pausedProposer).toMatchObject({
      gate: 'DENY',
      clause: Clause.systemPaused,
    })
    expect(pausedProposer.detail).toContain('Maintenance window')

    // When paused, owner gets NEEDS_APPROVAL system.paused
    const pausedOwner = decide(body, {
      ...baseProposal,
      safety: { paused: true, reason: 'Maintenance window' },
      actor: 'owner',
    }, { reservedCents: 0, priorCaptureIds: [] })
    expect(pausedOwner).toMatchObject({
      gate: 'NEEDS_APPROVAL',
      clause: Clause.systemPaused,
    })

    // If already invalid (e.g. payee unknown), keeps original refusal
    const pausedUnknown = decide(body, {
      ...baseProposal,
      payeeId: null,
      safety: { paused: true, reason: 'Maintenance window' },
      actor: 'proposer',
    }, { reservedCents: 0, priorCaptureIds: [] })
    expect(pausedUnknown).toMatchObject({
      gate: 'DENY',
      clause: Clause.payeeUnknown,
    })

    // 2. Integration: Pause and verify reads still work completely
    await publish(h.app, { fundingRequired: false, standing: [] })
    await call(h.app, 'POST', '/v1/safety/pause', { body: { reason: 'P7.T1 check' } })
    const denied = await ask(h.app)
    expect(denied.json).toMatchObject({
      gate: 'DENY',
      clause: 'system.paused',
    })

    // Reads still work while paused
    const propRes = await call(h.app, 'GET', '/v1/proposals', { key: STUDIO_KEY })
    expect(propRes.status).toBe(200)
    expect(propRes.json.data).toBeDefined()

    const warrantRes = await call(h.app, 'GET', '/v1/warrant', { key: STUDIO_KEY })
    expect(warrantRes.status).toBe(200)

    const todayRes = await call(h.app, 'GET', '/v1/today', { key: OWNER_KEY })
    expect(todayRes.status).toBe(200)

    const statusRes = await call(h.app, 'GET', '/v1/status', { key: STUDIO_KEY })
    expect(statusRes.status).toBe(200)
    expect(statusRes.json.paused).toMatchObject({ reason: 'P7.T1 check' })

    // Resume
    await call(h.app, 'POST', '/v1/safety/resume')
  })
})
