import { afterEach, describe, expect, it } from 'vitest'
import { countTaps, suggestRules, type SuggestInput } from '../src/domain/suggest'
import { LINE_STUDIO_WARRANT, WarrantBodySchema } from '../src/domain/schemas'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB } from './support'

afterEach(closeAll)

const warrant = WarrantBodySchema.parse({ ...LINE_STUDIO_WARRANT })
const NOW = new Date('2026-10-20T12:00:00Z')
const charge = { id: 'c1', kind: 'charge', gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval', phase: 'captured', payeeId: 'client_northwind', amountCents: 15_000, fundingCaptureId: null, captureId: 'CAP1', createdAt: '2026-10-01T00:00:00Z' }
const payout = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'payment', gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval', phase: 'captured', payeeId: 'payee_priya', amountCents: 3_000, fundingCaptureId: 'CAP1', captureId: null, createdAt: '2026-10-05T00:00:00Z', ...over })
const tap = (proposalId: string, at = '2026-10-05T10:00:00Z', actor = 'owner') => ({ proposalId, type: 'approved' as const, actor, at })

const base = (over: Partial<SuggestInput>): SuggestInput => ({ warrant: { ...warrant, standing: [] }, now: NOW, proposals: [charge, payout('a'), payout('b'), payout('c')], decisions: [tap('a'), tap('b'), tap('c')], ...over })

describe('a rule worth offering', () => {
  it('is offered after three taps for the same person from the same client, in words for the drafter', () => {
    const [one] = suggestRules(base({}))
    expect(one).toMatchObject({ payeeName: 'Priya Shah', clientName: 'Northwind', approved: 3, totalCents: 9_000, largestCents: 3_000 })
    expect(one!.draft).toBe("Pay Priya Shah automatically from Northwind's signed-deal payments, with no tap, as soon as Northwind pays.")
  })

  it('is not offered on two taps, on a rejection, on a rule that already covers it, on old taps, or on approvals that were not the owner\'s', () => {
    expect(suggestRules(base({ decisions: [tap('a'), tap('b')] }))).toEqual([])
    expect(suggestRules(base({ decisions: [tap('a'), tap('b'), tap('c'), { proposalId: 'd', type: 'rejected', actor: 'owner', at: '2026-10-06T00:00:00Z' }], proposals: [charge, payout('a'), payout('b'), payout('c'), payout('d', { phase: 'rejected' })] }))).toEqual([])
    expect(suggestRules(base({ warrant: { ...warrant, standing: [{ id: 's', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }] } }))).toEqual([])
    expect(suggestRules(base({ decisions: [tap('a', '2026-07-01T00:00:00Z'), tap('b', '2026-07-02T00:00:00Z'), tap('c', '2026-07-03T00:00:00Z')] }))).toEqual([])
    expect(suggestRules(base({ decisions: [tap('a', undefined, 'autopilot'), tap('b', undefined, 'proposer'), tap('c')] }))).toEqual([])
  })

  it('does not count a payout that went through a rule, or one that was never sent', () => {
    expect(suggestRules(base({ proposals: [charge, payout('a', { clause: 'standing.matched' }), payout('b'), payout('c')] }))).toEqual([])
    expect(suggestRules(base({ proposals: [charge, payout('a', { phase: 'denied' }), payout('b'), payout('c')] }))).toEqual([])
  })
})

describe('how many times the owner had to tap', () => {
  it('counts taps this month and last, and what the owner\'s rules did without one', () => {
    const taps = countTaps({ now: NOW, proposals: [payout('x', { gate: 'AUTO', clause: 'standing.matched', createdAt: '2026-10-04T00:00:00Z' }), payout('y', { gate: 'AUTO', phase: 'denied', createdAt: '2026-10-04T00:00:00Z' })], decisions: [tap('a', '2026-10-05T00:00:00Z'), tap('b', '2026-09-30T00:00:00Z'), tap('c', '2026-09-02T00:00:00Z'), tap('d', '2026-10-06T00:00:00Z', 'proposer')] })
    expect(taps).toEqual({ thisMonth: 1, lastMonth: 2, byRule: 1 })
  })
})

describe('GET /v1/suggestions', () => {
  it('finds the pattern in a real ledger, and is the owner\'s alone', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    for (let n = 0; n < 3; n += 1) {
      const made = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: { kind: 'payment', payee: 'Priya', amountCents: 3_000, currency: 'USD', category: 'design', description: `part ${n}`, evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: paid.captureId } })
      expect(made.json.gate).toBe('NEEDS_APPROVAL')
      await call(h.app, 'POST', `/v1/proposals/${made.json.id}/approve`)
      await call(h.app, 'POST', `/v1/proposals/${made.json.id}/capture`)
    }
    const { json } = await call(h.app, 'GET', '/v1/suggestions')
    expect(json.suggestions).toHaveLength(1)
    expect(json.suggestions[0]).toMatchObject({ payeeName: 'Priya Shah', clientName: 'Northwind', approved: 3, totalCents: 9_000 })
    expect(json.taps.thisMonth).toBe(4)
    expect((await call(h.app, 'GET', '/v1/suggestions', { key: 'test-proposer-key-32chars' })).status).toBe(403)
  })
})
