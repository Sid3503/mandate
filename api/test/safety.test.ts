import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { stepBinding } from '../src/auth/passkeys'
import { ControlStore } from '../src/control/store'
import { Clause, decide } from '../src/domain/gate'
import { ProposalCreateSchema } from '../src/domain/schemas'
import { applyPause, isSuspiciousRefusal, NOT_PAUSED, RefusalCounter, type PauseState } from '../src/domain/safety'
import { loadFlags } from '../src/flags'
import { FakeInvoices } from '../src/paypal/fake'
import { agree, BUYER_KEY, call, closeAll, EVIDENCE, harness, idem, JOB, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

const WEB = { origin: 'http://127.0.0.1:8787', 'x-mandate-client': 'web' }
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
    const h = harness({ breaker: { tripAfter: 3, windowSeconds: 120, unknownPayeeTripAfter: 0 } })
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

  it('P7.T2: pause controls: pause all, pause autopilot, pause one agent key with approver/owner permissions and step-up resume', async () => {
    const controlDb = new DatabaseSync(':memory:')
    const control = new ControlStore(controlDb, 'pepper-p7')
    const now = '2026-10-12T12:00:00Z'
    control.insertWorkspace({ id: 'ws_default', slug: 'default', name: 'Default', mode: 'default', paypal_mode: 'fake', db_path: ':memory:', status: 'active', created_at: now, expires_at: null, last_active_at: now, signing_key_sealed: 'sealed' })
    const ownerId = 'mem_owner'
    const approverId = 'mem_approver'
    const proposerId = 'mem_proposer'
    control.addMember({ id: ownerId, workspaceId: 'ws_default', name: 'Owner', role: 'owner', now })
    control.addMember({ id: approverId, workspaceId: 'ws_default', name: 'Approver', role: 'approver', now, limit: 1000 })
    control.addMember({ id: proposerId, workspaceId: 'ws_default', name: 'Proposer', role: 'proposer', now })
    const ownerToken = 'owner-session-token-32chars-test'
    const approverToken = 'approver-session-token-32ch-test'
    const proposerToken = 'proposer-session-token-32ch-test'
    for (const [token, memberId] of [[ownerToken, ownerId], [approverToken, approverId], [proposerToken, proposerId]] as const) {
      control.putSession({ token, memberId, workspaceId: 'ws_default', method: 'passkey', now, idleHours: 12, absoluteDays: 7 })
    }

    const h = harness({ control, flags: loadFlags({ FLAG_PASSKEYS: '1' }) })
    const ownerHeaders = { ...WEB, cookie: `mnd_session=${ownerToken}` }
    const approverHeaders = { ...WEB, cookie: `mnd_session=${approverToken}` }
    const proposerHeaders = { ...WEB, cookie: `mnd_session=${proposerToken}` }

    // 1. Proposer cannot pause or resume
    const proposerPause = await h.app.request('http://mandate.test/v1/safety/pause', { method: 'POST', headers: proposerHeaders })
    expect(proposerPause.status).toBe(403)
    const proposerResume = await h.app.request('http://mandate.test/v1/safety/resume', { method: 'POST', headers: proposerHeaders })
    expect(proposerResume.status).toBe(403)

    // 2. Approver can pause all with NO step-up
    const approverPause = await h.app.request('http://mandate.test/v1/safety/pause', {
      method: 'POST',
      headers: { ...approverHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Approver stop' }),
    })
    expect(approverPause.status).toBe(200)
    expect(((await approverPause.json()) as { paused: boolean }).paused).toBe(true)

    // Approver CANNOT resume
    const approverResume = await h.app.request('http://mandate.test/v1/safety/resume', { method: 'POST', headers: approverHeaders })
    expect(approverResume.status).toBe(403)

    // Turn on workspace passkey-for-money rule
    controlDb.prepare("UPDATE workspaces SET passkey_for_money = 1 WHERE id = 'ws_default'").run()
    const ownerResumeNoStepup = await h.app.request('http://mandate.test/v1/safety/resume', { method: 'POST', headers: ownerHeaders })
    expect(ownerResumeNoStepup.status).toBe(401)

    // With stepup grant, owner resumes successfully
    const grant = 'grant-resume-token'
    control.putGrant({ id: grant, memberId: ownerId, workspaceId: 'ws_default', kind: 'resume', binding: stepBinding('resume', 'safety.resume'), now })
    const ownerResumeWithGrant = await h.app.request('http://mandate.test/v1/safety/resume', {
      method: 'POST',
      headers: { ...ownerHeaders, 'x-mandate-stepup': grant },
    })
    expect(ownerResumeWithGrant.status).toBe(200)
    expect(((await ownerResumeWithGrant.json()) as { paused: boolean }).paused).toBe(false)

    // 3. Pause autopilot
    const pauseAutopilot = await h.app.request('http://mandate.test/v1/safety/pause/autopilot', {
      method: 'POST',
      headers: { ...approverHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Pause autopilot check' }),
    })
    expect(pauseAutopilot.status).toBe(200)
    const stateWithAutopilotPaused = (await (await h.app.request('http://mandate.test/v1/safety', { headers: ownerHeaders })).json()) as { autopilotPaused: boolean }
    expect(stateWithAutopilotPaused.autopilotPaused).toBe(true)

    // Autopilot resume with step-up grant
    const apGrant = 'grant-resume-autopilot-token'
    control.putGrant({ id: apGrant, memberId: ownerId, workspaceId: 'ws_default', kind: 'resume', binding: stepBinding('resume', 'safety.resume'), now })
    const resumeAutopilot = await h.app.request('http://mandate.test/v1/safety/resume/autopilot', {
      method: 'POST',
      headers: { ...ownerHeaders, 'x-mandate-stepup': apGrant },
    })
    expect(resumeAutopilot.status).toBe(200)
    expect(((await resumeAutopilot.json()) as { autopilotPaused: boolean }).autopilotPaused).toBe(false)

    // 4. Pause one agent key
    const createdAgent = h.services.agents.create({ name: 'Bot', scopes: ['propose', 'read'] })
    // Approver can pause agent key with NO step-up
    const pauseAgent = await h.app.request(`http://mandate.test/v1/agents/${createdAgent.agent.id}/pause`, {
      method: 'POST',
      headers: approverHeaders,
    })
    expect(pauseAgent.status).toBe(200)
    expect(((await pauseAgent.json()) as { status: string }).status).toBe('suspended')

    // Calling with suspended agent key is 403
    const agentCall = await call(h.app, 'POST', '/v1/proposals', { key: createdAgent.apiKey, idem: idem(), body: { kind: 'payment', payee: 'Priya', amountCents: 100, currency: 'USD', category: 'design', description: 'x' } })
    expect(agentCall.status).toBe(403)
    expect(agentCall.json.code).toBe('agent.suspended')

    // Owner resumes agent key
    const resumeAgent = await h.app.request(`http://mandate.test/v1/agents/${createdAgent.agent.id}/resume`, {
      method: 'POST',
      headers: ownerHeaders,
    })
    expect(resumeAgent.status).toBe(200)
    expect(((await resumeAgent.json()) as { status: string }).status).toBe('active')

    controlDb.close()
  })

  it('P7.T3 (Case 30): auto-trip breakers (unknown payees, agent spam, autopilot failures) and owner edits settings with step-up', async () => {
    const controlDb = new DatabaseSync(':memory:')
    const control = new ControlStore(controlDb, 'pepper-p7-t3')
    const now = '2026-10-12T12:00:00.000Z'
    control.insertWorkspace({ id: 'ws_default', slug: 'default', name: 'Default', mode: 'default', paypal_mode: 'fake', db_path: ':memory:', status: 'active', created_at: now, expires_at: null, last_active_at: now, signing_key_sealed: 'sealed' })
    const ownerId = 'usr_owner_p7_t3'
    const approverId = 'usr_approver_p7_t3'
    const proposerId = 'usr_proposer_p7_t3'

    control.addMember({ id: ownerId, workspaceId: 'ws_default', name: 'Owner', role: 'owner', now })
    control.addMember({ id: approverId, workspaceId: 'ws_default', name: 'Approver', role: 'approver', now })
    control.addMember({ id: proposerId, workspaceId: 'ws_default', name: 'Proposer', role: 'proposer', now })
    const ownerToken = 'owner-session-token-32chars-t3'
    const approverToken = 'approver-session-token-32ch-t3'
    const proposerToken = 'proposer-session-token-32ch-t3'
    for (const [token, memberId] of [[ownerToken, ownerId], [approverToken, approverId], [proposerToken, proposerId]] as const) {
      control.putSession({ token, memberId, workspaceId: 'ws_default', method: 'passkey', now, idleHours: 12, absoluteDays: 7 })
    }

    const h = harness({
      control,
      flags: loadFlags({ FLAG_PASSKEYS: '1' }),
      breaker: { tripAfter: 3, windowSeconds: 120, unknownPayeeTripAfter: 2, unknownPayeeWindowSeconds: 600, agentRateLimitPerMinute: 20, autopilotFailureTripAfter: 3 },
    })
    const ownerHeaders = { ...WEB, cookie: `mnd_session=${ownerToken}` }
    const approverHeaders = { ...WEB, cookie: `mnd_session=${approverToken}` }
    const proposerHeaders = { ...WEB, cookie: `mnd_session=${proposerToken}` }

    // --- 1. Unknown payee breaker (2 attempts in 10m pauses Mandate) ---
    expect(h.services.safety.paused()).toBe(false)
    const badPayee1 = await call(h.app, 'POST', '/v1/proposals', {
      key: STUDIO_KEY,
      idem: idem(),
      body: { kind: 'payment', payee: 'Unknown Hacker 1', amountCents: 500, currency: 'USD', category: 'design', description: 'test 1' },
    })
    expect(badPayee1.status).toBe(201)
    expect(badPayee1.json.gate).toBe('DENY')
    expect(badPayee1.json.clause).toBe('payee.unknown')
    expect(h.services.safety.paused()).toBe(false)

    const badPayee2 = await call(h.app, 'POST', '/v1/proposals', {
      key: STUDIO_KEY,
      idem: idem(),
      body: { kind: 'payment', payee: 'Unknown Hacker 2', amountCents: 500, currency: 'USD', category: 'design', description: 'test 2' },
    })
    expect(badPayee2.status).toBe(201)
    expect(badPayee2.json.gate).toBe('DENY')
    expect(badPayee2.json.clause).toBe('payee.unknown')
    // Tripped!
    expect(h.services.safety.paused()).toBe(true)
    expect(h.services.safety.state().reason).toContain('unknown payee')

    // Resume for next checks
    await h.services.safety.resume('owner')
    expect(h.services.safety.paused()).toBe(false)

    // --- 2. Agent spam trip (20 req/m from one agent key suspends that key) ---
    const spamAgent = h.services.agents.create({ name: 'FastBot', scopes: ['read'] })
    for (let i = 0; i < 20; i += 1) {
      const res = await call(h.app, 'GET', '/v1/warrant', { key: spamAgent.apiKey })
      expect(res.status).toBe(200)
    }
    // 21st request trips the breaker: 429 agent.rate_limit and agent suspended
    const res21 = await call(h.app, 'GET', '/v1/warrant', { key: spamAgent.apiKey })
    expect(res21.status).toBe(429)
    expect(res21.json.code).toBe('agent.rate_limit')

    // Subsequent request is 403 agent.suspended
    const res22 = await call(h.app, 'GET', '/v1/warrant', { key: spamAgent.apiKey })
    expect(res22.status).toBe(403)
    expect(res22.json.code).toBe('agent.suspended')

    // System-wide Mandate was NOT paused by one agent's spam
    expect(h.services.safety.paused()).toBe(false)

    // --- 3. Autopilot failures in a row (3 in a row pauses autopilot) ---
    expect(h.services.safety.isAutopilotPaused()).toBe(false)
    h.services.safety.noteAutopilotFailure('Simulated failure 1')
    expect(h.services.safety.isAutopilotPaused()).toBe(false)
    h.services.safety.noteAutopilotFailure('Simulated failure 2')
    expect(h.services.safety.isAutopilotPaused()).toBe(false)
    h.services.safety.noteAutopilotFailure('Simulated failure 3')
    expect(h.services.safety.isAutopilotPaused()).toBe(true)
    expect(h.services.safety.state().autopilotPaused).toBe(true)

    // Resume autopilot
    await h.services.safety.resumeAutopilot('owner')
    expect(h.services.safety.isAutopilotPaused()).toBe(false)

    // --- 4. Settings editing with passkey step-up ---
    const newSettings = { tripAfter: 5, windowSeconds: 180, unknownPayeeTripAfter: 4 }

    // Proposer cannot edit settings
    const proposerEdit = await h.app.request('http://mandate.test/v1/safety/config', {
      method: 'PUT',
      headers: { ...proposerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(newSettings),
    })
    expect(proposerEdit.status).toBe(403)

    // Approver cannot edit settings
    const approverEdit = await h.app.request('http://mandate.test/v1/safety/config', {
      method: 'PUT',
      headers: { ...approverHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(newSettings),
    })
    expect(approverEdit.status).toBe(403)

    // Turn on workspace passkey_for_money
    controlDb.prepare("UPDATE workspaces SET passkey_for_money = 1 WHERE id = 'ws_default'").run()

    // Owner without step-up grant gets 401
    const ownerEditNoStepup = await h.app.request('http://mandate.test/v1/safety/config', {
      method: 'PUT',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(newSettings),
    })
    expect(ownerEditNoStepup.status).toBe(401)

    // Owner with step-up grant succeeds
    const grant = 'grant-safety-config-token'
    control.putGrant({
      id: grant,
      memberId: ownerId,
      workspaceId: 'ws_default',
      kind: 'safety.config',
      binding: stepBinding('safety.config', JSON.stringify(newSettings)),
      now,
    })

    const ownerEditWithGrant = await h.app.request('http://mandate.test/v1/safety/config', {
      method: 'PUT',
      headers: { ...ownerHeaders, 'content-type': 'application/json', 'x-mandate-stepup': grant },
      body: JSON.stringify(newSettings),
    })
    expect(ownerEditWithGrant.status).toBe(200)
    const updated = (await ownerEditWithGrant.json()) as { ok: boolean; config: { tripAfter: number; windowSeconds: number; unknownPayeeTripAfter: number } }
    expect(updated.config.tripAfter).toBe(5)
    expect(updated.config.windowSeconds).toBe(180)
    expect(updated.config.unknownPayeeTripAfter).toBe(4)

    // GET /v1/safety returns the updated breaker config
    const safetyGet = await h.app.request('http://mandate.test/v1/safety', { headers: ownerHeaders })
    expect(safetyGet.status).toBe(200)
    const safetyData = (await safetyGet.json()) as { breaker: { tripAfter: number } }
    expect(safetyData.breaker.tripAfter).toBe(5)

    controlDb.close()
  })
})
