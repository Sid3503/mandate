import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { drain, fuzz, runAttacks } from '../src/domain/attack'
import { blastRadius, type BlastCharge, type BlastFacts } from '../src/domain/blast'
import { LINE_STUDIO_WARRANT, WarrantBodySchema, type WarrantBody } from '../src/domain/schemas'

const NOW = Date.parse('2026-11-05T10:00:00Z')

const charge = (over: Partial<BlastCharge> = {}): BlastCharge => ({
  kind: 'charge',
  phase: 'captured',
  jobId: 'job_northwind_logo',
  currency: 'USD',
  capturedCents: 15_000,
  refundHeldCents: 0,
  payoutHeldCents: 0,
  clientId: 'client_northwind',
  dealId: 'deal_1',
  payeeHeldCents: 0,
  disputed: false,
  settledAt: '2026-11-01T10:00:00Z',
  captureId: 'CAP1',
  category: 'design',
  duplicate: false,
  ...over,
})

const facts = (over: Partial<BlastFacts> = {}): BlastFacts => ({
  nowMs: NOW,
  reservedCents: 0,
  charges: [charge()],
  autoRefundUsedCents: 0,
  paused: false,
  autopilotPaused: false,
  ...over,
})

const withStanding = (over: Partial<WarrantBody> = {}): WarrantBody => ({
  ...LINE_STUDIO_WARRANT,
  standing: [{ id: 'priya', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true, shareBps: 6000 }],
  automation: { ...LINE_STUDIO_WARRANT.automation, payOnSettle: true },
  ...over,
})

describe('blast radius: the demo studio', () => {
  it('says nothing leaves by itself when no standing rule is signed', () => {
    const radius = blastRadius(LINE_STUDIO_WARRANT, facts())
    expect(radius.alone.totalCents).toBe(0)
    // Under the $20 line, up to the contractor share of the $150, is locked without approval and waits for Send.
    expect(radius.queued.payoutsCents).toBe(9_000)
  })

  it('counts a standing rule at its share of the settled payment, and the real gate agrees to the cent', () => {
    const warrant = withStanding()
    const radius = blastRadius(warrant, facts())
    expect(radius.alone.payoutsCents).toBe(9_000)
    const found = drain(warrant, facts())
    expect(found.alone.payoutsCents).toBe(9_000)
    expect(found.queued.payoutsCents).toBe(9_000)
  })

  it('is stopped by the monthly cap, not only by client money', () => {
    const warrant = withStanding({ monthlyCapCents: 4_000 })
    expect(blastRadius(warrant, facts()).alone.payoutsCents).toBe(4_000)
    expect(drain(warrant, facts()).alone.payoutsCents).toBe(4_000)
    expect(blastRadius(warrant, facts({ reservedCents: 3_500 })).alone.payoutsCents).toBe(500)
  })

  it('counts nothing from money that is disputed, still clearing, or not settled', () => {
    const warrant = withStanding()
    expect(blastRadius(warrant, facts({ charges: [charge({ disputed: true })] })).alone.payoutsCents).toBe(0)
    expect(blastRadius(warrant, facts({ charges: [charge({ phase: 'invoice_sent' })] })).alone.payoutsCents).toBe(0)
    const clearing = withStanding({ clearingDays: 7 })
    expect(blastRadius(clearing, facts({ charges: [charge({ settledAt: '2026-11-04T10:00:00Z' })] })).alone.payoutsCents).toBe(0)
    expect(blastRadius(clearing, facts({ charges: [charge({ settledAt: '2026-10-20T10:00:00Z' })] })).alone.payoutsCents).toBe(9_000)
  })

  it('is zero while paused, and zero for an AI agent once the friction floor holds it', () => {
    expect(blastRadius(withStanding(), facts({ paused: true })).alone.totalCents).toBe(0)
    expect(blastRadius(withStanding(), facts({ autopilotPaused: true })).alone.totalCents).toBe(0)
    const open = blastRadius(withStanding(), facts())
    expect(open.aloneAgent.payoutsCents).toBe(9_000)
    const held = blastRadius(withStanding({ frictionBudget: { modelFloor: 'needs_approval' } }), facts())
    expect(held.aloneAgent.totalCents).toBe(0)
    expect(held.queuedAgent.totalCents).toBe(0)
    expect(held.alone.payoutsCents).toBe(9_000)
    expect(drain(withStanding({ frictionBudget: { modelFloor: 'needs_approval' } }), facts(), 'agent:x').queued.totalCents).toBe(0)
  })

  it('counts an auto-refund policy only for payments the books show were paid twice, inside its monthly limit', () => {
    // The refund path alone: no standing rule and no under-line payouts to spend the same client money first.
    const warrant = withStanding({ standing: [], autoSettleUnderCents: 1, autoRefund: { enabled: true, duplicateOnly: true, skipDisputed: true, maxCents: 5_000, monthlyCapCents: 8_000 } })
    expect(blastRadius(warrant, facts()).alone.refundsCents).toBe(0)
    const twice = facts({ charges: [charge({ duplicate: true })] })
    // The $150 payment has funded nobody yet, so all of it is refundable, but the policy's month stops it at $80.
    expect(blastRadius(warrant, twice).alone.refundsCents).toBe(8_000)
    expect(drain(warrant, twice).alone.refundsCents).toBe(8_000)
    expect(blastRadius(warrant, { ...twice, autoRefundUsedCents: 7_500 }).alone.refundsCents).toBe(500)
  })

  it('keeps a refund from short-changing a contractor who has already been promised their share', () => {
    const warrant = withStanding()
    const paid = facts({ charges: [charge({ payoutHeldCents: 9_000 })] })
    // $90 of the $150 is spoken for at a 60% share, so $150 − $150 can be refunded: all of the client's money funds the share.
    expect(blastRadius(warrant, paid).queued.refundsCents).toBe(0)
    expect(drain(warrant, paid).queued.refundsCents).toBe(0)
  })

  it('offers only levers that really lower the number, and each lever is the real number under that change', () => {
    const warrant = withStanding()
    const radius = blastRadius(warrant, facts())
    expect(radius.levers.length).toBeGreaterThan(0)
    for (const lever of radius.levers) {
      expect(lever.toCents).toBeLessThan(lever.id === 'agents-tap' ? radius.aloneAgent.totalCents : radius.alone.totalCents)
      if (lever.id !== 'agents-tap') expect(blastRadius({ ...warrant, ...lever.patch } as WarrantBody, facts()).alone.totalCents).toBe(lever.toCents)
    }
  })
})

describe('attack my rules', () => {
  it('holds every honest-looking trick against the demo rules and shows the many-small-payouts one for what it is', () => {
    const report = runAttacks(withStanding(), facts())
    const by = (id: string) => report.attacks.find((item) => item.id === id)!
    expect(by('stranger')).toMatchObject({ outcome: 'refused', clause: 'payee.unknown' })
    expect(by('lookalike').outcome).toBe('refused')
    expect(by('wrong-work')).toMatchObject({ outcome: 'refused', clause: 'category.missing' })
    expect(by('before-paid')).toMatchObject({ outcome: 'refused', clause: 'funding.missing' })
    // The gate checks the client's money before the ceiling, so on a $150 payment the same ask is refused for funding first.
    expect(by('over-ceiling').outcome).toBe('refused')
    expect(by('over-share')).toMatchObject({ outcome: 'refused', clause: 'funding.exceeds' })
    expect(by('no-proof')).toMatchObject({ outcome: 'refused', clause: 'evidence.missing' })
    expect(by('twice')).toMatchObject({ outcome: 'refused', clause: 'duplicate.open' })
    expect(by('structuring').movedCents).toBe(9_000)
    expect(by('big-standing')).toMatchObject({ outcome: 'alone', clause: 'standing.matched', movedCents: 9_000 })
    expect(report.hypothetical).toBe(false)
    expect(report.verdict).toBe('alone')
  })

  it('finds a fix by running the same attack again, and the fix really stops it', () => {
    const report = runAttacks(withStanding(), facts())
    const big = report.attacks.find((item) => item.id === 'big-standing')!
    expect(big.fix).not.toBeNull()
    const patched = { ...withStanding(), ...big.fix!.patch } as WarrantBody
    expect(runAttacks(patched, facts()).attacks.find((item) => item.id === 'big-standing')!.movedCents).toBe(big.fix!.toCents)
  })

  it('uses an imagined client payment, and says so, when the ledger has none', () => {
    const report = runAttacks(withStanding(), facts({ charges: [] }))
    expect(report.hypothetical).toBe(true)
    expect(report.imagined?.clientName).toBe('Northwind')
    expect(report.attacks.find((item) => item.id === 'over-share')?.hypothetical).toBe(true)
    // With the payment imagined large, it is the monthly cap, not the money, that limits the drain.
    expect(report.radius.alone.payoutsCents).toBe(18_000)
  })

  it('is deterministic for a seed', () => {
    expect(fuzz(withStanding(), facts(), 'proposer', 7)).toEqual(fuzz(withStanding(), facts(), 'proposer', 7))
  })
})

const ids = ['payee_priya', 'payee_sam', 'payee_lee']
const warrants = fc
  .record({
    auto: fc.integer({ min: 1, max: 30_000 }),
    ceilingExtra: fc.integer({ min: 0, max: 100_000 }),
    cap: fc.integer({ min: 1, max: 200_000 }),
    share: fc.integer({ min: 0, max: 10_000 }),
    clearing: fc.constantFrom(0, 0, 7),
    funding: fc.boolean(),
    floor: fc.constantFrom('auto', 'auto', 'needs_approval', 'deny'),
    standing: fc.array(fc.record({ payee: fc.constantFrom(...ids), shareBps: fc.option(fc.integer({ min: 1, max: 5_000 }), { nil: undefined }), requireDeal: fc.boolean() }), { maxLength: 2 }),
    refund: fc.option(fc.record({ max: fc.integer({ min: 1, max: 20_000 }), extra: fc.integer({ min: 0, max: 50_000 }) }), { nil: undefined }),
  })
  .map((r): WarrantBody | null => {
    const body = {
      ...LINE_STUDIO_WARRANT,
      payees: ids.map((id) => ({ id, displayName: id.replace('payee_', '').replace(/^./, (c) => c.toUpperCase()) + ' Shah', email: `${id}@example.com`, aliases: [] })),
      autoSettleUnderCents: r.auto,
      perPaymentCeilingCents: r.auto + r.ceilingExtra,
      monthlyCapCents: r.cap,
      contractorShareBps: Math.max(r.share, 1),
      clearingDays: r.clearing,
      fundingRequired: r.funding,
      frictionBudget: { modelFloor: r.floor },
      standing: r.funding ? r.standing.map((s, i) => ({ id: `rule${i}`, payeeId: s.payee, clientIds: ['client_northwind'], requireDeal: s.requireDeal, ...(s.shareBps ? { shareBps: s.shareBps } : {}) })) : [],
      automation: { ...LINE_STUDIO_WARRANT.automation, payOnSettle: false },
      autoRefund: r.refund ? { enabled: true, duplicateOnly: true, skipDisputed: true, maxCents: r.refund.max, monthlyCapCents: r.refund.max + r.refund.extra } : LINE_STUDIO_WARRANT.autoRefund,
    }
    const parsed = WarrantBodySchema.safeParse(body)
    return parsed.success ? parsed.data : null
  })

const ledger = fc.record({
  reserved: fc.integer({ min: 0, max: 100_000 }),
  paused: fc.boolean(),
  autopilotPaused: fc.boolean(),
  used: fc.integer({ min: 0, max: 30_000 }),
  charges: fc.array(fc.record({
    captured: fc.integer({ min: 1, max: 300_000 }),
    refundHeld: fc.integer({ min: 0, max: 100_000 }),
    payoutHeld: fc.integer({ min: 0, max: 100_000 }),
    disputed: fc.boolean(),
    duplicate: fc.boolean(),
    deal: fc.boolean(),
    settledDaysAgo: fc.integer({ min: 0, max: 20 }),
  }), { maxLength: 3 }),
}).map((r): BlastFacts => ({
  nowMs: NOW,
  reservedCents: r.reserved,
  paused: r.paused && r.reserved % 5 === 0,
  autopilotPaused: r.autopilotPaused && r.reserved % 3 === 0,
  autoRefundUsedCents: r.used,
  charges: r.charges.map((c, i) => charge({
    captureId: `CAP${i}`,
    jobId: `job_${i}`,
    capturedCents: c.captured,
    refundHeldCents: Math.min(c.refundHeld, c.captured),
    payoutHeldCents: c.payoutHeld,
    disputed: c.disputed,
    duplicate: c.duplicate,
    dealId: c.deal ? `deal_${i}` : null,
    settledAt: new Date(NOW - c.settledDaysAgo * 86_400_000).toISOString(),
  })),
}))

const RUNS = Number(process.env.PROPERTY_RUNS ?? 150)

describe('blast radius is an upper bound on what a hostile proposer can move', () => {
  it('holds for a draining proposer, a random one and an AI agent, on random rules and random ledgers', () => {
    fc.assert(
      fc.property(warrants, ledger, fc.integer({ min: 1, max: 1_000_000 }), (warrant, ledgerFacts, seed) => {
        fc.pre(warrant !== null)
        const w = warrant!
        const radius = blastRadius(w, ledgerFacts)
        for (const actor of ['proposer', 'agent:fooled']) {
          const bound = actor === 'proposer' ? radius : { alone: radius.aloneAgent, queued: radius.queuedAgent }
          const found = drain(w, ledgerFacts, actor)
          expect(found.alone.payoutsCents).toBeLessThanOrEqual(bound.alone.payoutsCents)
          expect(found.alone.refundsCents).toBeLessThanOrEqual(bound.alone.refundsCents)
          expect(found.queued.payoutsCents).toBeLessThanOrEqual(bound.queued.payoutsCents)
          expect(found.queued.refundsCents).toBeLessThanOrEqual(bound.queued.refundsCents)
          const random = fuzz(w, ledgerFacts, actor, seed)
          expect(random.alone.payoutsCents).toBeLessThanOrEqual(bound.alone.payoutsCents)
          expect(random.alone.refundsCents).toBeLessThanOrEqual(bound.alone.refundsCents)
          expect(random.queued.payoutsCents).toBeLessThanOrEqual(bound.queued.payoutsCents)
          expect(random.queued.refundsCents).toBeLessThanOrEqual(bound.queued.refundsCents)
        }
        // Whatever it moves, payouts never pass the cap that was left.
        expect(blastRadius(w, ledgerFacts).queued.payoutsCents).toBeLessThanOrEqual(Math.max(0, w.monthlyCapCents - ledgerFacts.reservedCents))
      }),
      { numRuns: RUNS },
    )
  }, Math.max(15_000, RUNS * 10))
})
