import { afterEach, describe, expect, it } from 'vitest'
import { Clause, decide } from '../src/domain/gate'
import { LINE_STUDIO_WARRANT } from '../src/domain/schemas'
import { assessRisk, hostOf, impersonatesKnownParty, isLookalike, riskEnabled, RiskClause } from '../src/domain/risk'
import { agree, call, closeAll, EVIDENCE, harness, idem } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]

const warrant = LINE_STUDIO_WARRANT
// Under the automatic line (2000 cents), with settled client money behind it: the rules send this with no tap.
const auto = {
  kind: 'payment' as const,
  payeeId: 'payee_priya',
  rawPayee: 'Priya',
  amountCents: 1500,
  currency: 'USD',
  category: 'design',
  evidenceUrl: 'https://www.figma.com/file/northwind-logo',
  parent: null,
  jobId: 'job_northwind_logo',
  fundingCaptureId: 'CAP-NW-1',
  funding: {
    kind: 'charge' as const,
    phase: 'captured' as const,
    jobId: 'job_northwind_logo',
    currency: 'USD',
    capturedCents: 15000,
    refundHeldCents: 0,
    payoutHeldCents: 0,
  },
}
const velocitySignal = { escalate: true as const, code: RiskClause.velocity, detail: 'burst' }

describe('the risk config', () => {
  it('is off by default, so every existing warrant behaves exactly as it did', () => {
    expect(riskEnabled(warrant)).toBe(false)
    expect(riskEnabled(undefined)).toBe(false)
    expect(assessRisk(warrant, { recentProposalCount: 9999, knownEvidenceHosts: [] }, { evidenceUrl: null })).toBeNull()
  })
})

describe('the lookalike check', () => {
  it('fires on shared words that are not an exact match', () => {
    expect(impersonatesKnownParty('P. Shah', warrant.payees)).toBe(true)
    expect(impersonatesKnownParty('PRIYA SHAH', warrant.payees)).toBe(false) // the party themselves, other case
    expect(impersonatesKnownParty('priya', warrant.payees)).toBe(false) // an alias is the party themselves
    expect(impersonatesKnownParty('priya.shah@example.com', warrant.payees)).toBe(false)
    expect(impersonatesKnownParty('priya.shah@examp1e.com', warrant.payees)).toBe(true) // a lookalike address
    expect(impersonatesKnownParty('Zed Quill', warrant.payees)).toBe(false) // a stranger is refused as unknown anyway
    expect(impersonatesKnownParty('', warrant.payees)).toBe(false)
  })

  it('checks clients too, so a lookalike buyer cannot walk in as a seller', () => {
    expect(impersonatesKnownParty('Northwind Labs', warrant.clients)).toBe(true) // shares the whole word, is not the party
    expect(impersonatesKnownParty('Northwind', warrant.clients)).toBe(false)
  })

  it('is a refusal-sharpener, not an escalation: it needs the feature on, and the pattern flag on', () => {
    expect(isLookalike('P. Shah', warrant)).toBe(false) // risk off by default
    expect(isLookalike('P. Shah', { ...warrant, risk: { ...warrant.risk, enabled: true } })).toBe(false) // pattern flag off
    expect(isLookalike('P. Shah', { ...warrant, risk: { ...warrant.risk, enabled: true, patternMatchPayees: true } })).toBe(true)
  })
})

describe('the signals that escalate', () => {
  it('asks for a tap when requests arrive faster than the warrant allows', () => {
    const risk = { ...warrant.risk, enabled: true, velocityMaxPerHour: 2, velocityWindowMinutes: 60 }
    const body = { ...warrant, risk }
    expect(assessRisk(body, { recentProposalCount: 2, knownEvidenceHosts: [] }, { evidenceUrl: null })).toBeNull()
    expect(assessRisk(body, { recentProposalCount: 3, knownEvidenceHosts: [] }, { evidenceUrl: null }))
      .toMatchObject({ escalate: true, code: RiskClause.velocity })
  })

  it('lets 0 turn the velocity check off entirely', () => {
    const risk = { ...warrant.risk, enabled: true, velocityMaxPerHour: 0 }
    expect(assessRisk({ ...warrant, risk }, { recentProposalCount: 10_000, knownEvidenceHosts: [] }, { evidenceUrl: null })).toBeNull()
  })

  it('flags proof hosted where no earlier request pointed, but never a first request', () => {
    const risk = { ...warrant.risk, enabled: true, escalateNewEvidenceHost: true }
    const body = { ...warrant, risk }
    const ledger = { recentProposalCount: 0, knownEvidenceHosts: ['www.figma.com'] }
    expect(assessRisk(body, ledger, { evidenceUrl: 'https://www.dropbox.example/proof' }))
      .toMatchObject({ escalate: true, code: RiskClause.newEvidenceHost })
    expect(assessRisk(body, ledger, { evidenceUrl: 'https://www.figma.com/file/other' })).toBeNull()
    // An empty history means the studio has no hosts yet: the first request is never punished for arriving first.
    expect(assessRisk(body, { recentProposalCount: 0, knownEvidenceHosts: [] }, { evidenceUrl: 'https://www.dropbox.example/proof' })).toBeNull()
    expect(hostOf('not a url')).toBeNull()
  })

  it('ranks the burst over the new host, and answers with at most one signal', () => {
    const risk = { ...warrant.risk, enabled: true, velocityMaxPerHour: 2, escalateNewEvidenceHost: true }
    const verdict = assessRisk(
      { ...warrant, risk },
      { recentProposalCount: 5, knownEvidenceHosts: ['www.figma.com'] },
      { evidenceUrl: 'https://www.dropbox.example/proof' },
    )
    expect(verdict).toMatchObject({ code: RiskClause.velocity })
  })
})

describe('what a signal may do to a decision', () => {
  it('turns an automatic payment into one that waits for a tap', () => {
    const decision = decide(warrant, { ...auto, risk: velocitySignal }, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: Clause.riskVelocity })
    expect(decision.detail).toContain('the rules would have sent this with no tap')
  })

  it('never touches a refusal: the rules said no, and the signal does not relitigate that', () => {
    const refused = { ...auto, category: 'lunch', risk: velocitySignal }
    expect(decide(warrant, refused, { reservedCents: 0, priorCaptureIds: [] }))
      .toMatchObject({ gate: 'DENY', clause: Clause.categoryMissing })
  })

  it('never lowers a tap: a request the owner had to approve still needs the owner', () => {
    const tapped = { ...auto, amountCents: 9000, risk: velocitySignal }
    expect(decide(warrant, tapped, { reservedCents: 0, priorCaptureIds: [] }))
      .toMatchObject({ gate: 'NEEDS_APPROVAL', clause: Clause.amountNeedsApproval })
  })

  it('names a lookalike in the refusal instead of shrugging unknown, and still refuses', () => {
    const risk = { ...warrant.risk, enabled: true, patternMatchPayees: true }
    const body = { ...warrant, risk }
    const lookalike = { ...auto, payeeId: null, rawPayee: 'P. Shah' }
    const decision = decide(body, lookalike, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision).toMatchObject({ gate: 'DENY', clause: Clause.riskPayeeImpersonation })
    expect(decision.detail).toContain('P. Shah')
    // The same ask with the feature off is refused as before.
    expect(decide(warrant, lookalike, { reservedCents: 0, priorCaptureIds: [] }))
      .toMatchObject({ gate: 'DENY', clause: Clause.payeeUnknown })
  })
})

describe('adaptive friction end to end', () => {
  const publish = async (app: App, patch: Record<string, unknown>) => {
    const current = (await call(app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    return call(app, 'PUT', '/v1/warrant', { body: { ...body, ...patch } })
  }
  /** Bills milestone 0 of the deal, approves it, and settles it, leaving a capture the payouts can cite. */
  const collectMilestone = async (app: App, dealId: string) => {
    const billed = await call(app, 'POST', `/v1/deals/${dealId}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    const id = billed.json.id as string
    await call(app, 'POST', `/v1/proposals/${id}/approve`)
    const captured = await call(app, 'POST', `/v1/proposals/${id}/capture`)
    if (!captured.json.captureId) throw new Error(`charge did not capture: ${JSON.stringify(captured.json)}`)
    return captured.json.captureId as string
  }
  /** A payout the rules send with no tap: under the automatic line, funded by the settled client payment. */
  const payout = (app: App, captureId: string, cents: number, overrides: Record<string, unknown> = {}) => call(app, 'POST', '/v1/proposals', {
    idem: idem('risk'),
    body: { kind: 'payment', payee: 'Priya', amountCents: cents, currency: 'USD', category: 'design', description: `northwind work ${cents}`, evidenceUrl: EVIDENCE, jobId: 'job_northwind_logo', fundingCaptureId: captureId, ...overrides },
  })

  it('refuses a lookalike payee by naming the attempt, and the same ask is plain unknown with the feature off', async () => {
    const h = harness()
    await publish(h.app, { risk: { enabled: true, patternMatchPayees: true, velocityMaxPerHour: 0, escalateNewEvidenceHost: false } })
    const refused = await call(h.app, 'POST', '/v1/proposals', {
      idem: idem('look'),
      body: { kind: 'payment', payee: 'P. Shah', amountCents: 1500, currency: 'USD', category: 'design', description: 'logo work', evidenceUrl: EVIDENCE, jobId: 'job_northwind_logo', fundingCaptureId: 'CAP-1' },
    })
    expect(refused.status).toBe(201)
    expect(refused.json).toMatchObject({ gate: 'DENY', clause: 'risk.payee_impersonation' })
    expect(refused.json.detail).toContain('lookalike')
    await publish(h.app, { risk: { enabled: false, patternMatchPayees: false, velocityMaxPerHour: 0, escalateNewEvidenceHost: false } })
    const plain = await call(h.app, 'POST', '/v1/proposals', {
      idem: idem('look2'),
      body: { kind: 'payment', payee: 'P. Shah', amountCents: 1500, currency: 'USD', category: 'design', description: 'logo work', evidenceUrl: EVIDENCE, jobId: 'job_northwind_logo', fundingCaptureId: 'CAP-1' },
    })
    expect(plain.json).toMatchObject({ gate: 'DENY', clause: 'payee.unknown' })
  })

  it('escalates a burst on cue: the ask that tips the count waits for a tap', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const captureId = await collectMilestone(h.app, deal.id)
    await publish(h.app, { risk: { enabled: true, velocityMaxPerHour: 2, velocityWindowMinutes: 60, patternMatchPayees: false, escalateNewEvidenceHost: false } })
    // The billing charge is request one; the first two payouts stay under a limit of two.
    expect((await payout(h.app, captureId, 1500)).json).toMatchObject({ gate: 'AUTO' })
    expect((await payout(h.app, captureId, 1501)).json).toMatchObject({ gate: 'AUTO' })
    const third = await payout(h.app, captureId, 1502)
    expect(third.json).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'risk.velocity' })
    expect(String(third.json.detail)).toContain('requests were filed')
  })

  it('flags proof on a host the studio has never paid against, once there is history', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const captureId = await collectMilestone(h.app, deal.id)
    await publish(h.app, { risk: { enabled: true, escalateNewEvidenceHost: true, velocityMaxPerHour: 0, patternMatchPayees: false } })
    // figma.com is where the client payment's own proof lives, so it is a known host by now.
    expect((await payout(h.app, captureId, 1500)).json).toMatchObject({ gate: 'AUTO' })
    const fresh = await payout(h.app, captureId, 1501, { evidenceUrl: 'https://www.dropbox.example/proof-final.pdf' })
    expect(fresh.json).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'risk.new_evidence_host' })
  })
})
