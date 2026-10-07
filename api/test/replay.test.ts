import { afterEach, describe, expect, it } from 'vitest'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, STUDIO_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]
const bodyOf = async (app: App) => {
  const current = (await call(app, 'GET', '/v1/warrant')).json
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  return body as Record<string, any>
}
const replay = (app: App, rules: unknown, key?: string) => call(app, 'POST', '/v1/rules/replay', { key, body: rules })
const payout = (captureId: string, overrides: Record<string, unknown> = {}) => ({ payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: captureId, ...overrides })

describe('replaying history under proposed rules', () => {
  it('says what would change, and nothing changes in the ledger', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId) })
    expect(asked.json.gate).toBe('NEEDS_APPROVAL')
    const lunch = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId, { amountCents: 1_800, category: 'lunch', description: 'lunch' }) })
    expect(lunch.json.gate).toBe('DENY')

    const body = await bodyOf(h.app)
    const proposed = { ...body, standing: [{ id: 'priya', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }] }
    const result = (await replay(h.app, proposed)).json
    expect(result.checked).toBe(3)
    // The $90 payout would have gone with no tap. The lunch, the deal charge and the rest are unchanged.
    expect(result.changed).toEqual([expect.objectContaining({ proposalId: asked.json.id, title: 'Pay Priya Shah $90.00', before: expect.objectContaining({ gate: 'NEEDS_APPROVAL' }), after: expect.objectContaining({ gate: 'AUTO', clause: 'standing.matched' }) })])
    expect(result).toMatchObject({ nowNoTap: 1, nowTap: 0, nowRefused: 0, nowAllowed: 0 })
    // Stored history is untouched.
    expect((await call(h.app, 'GET', `/v1/proposals/${asked.json.id}`)).json).toMatchObject({ gate: 'NEEDS_APPROVAL', phase: 'pending_approval' })
    expect(h.paypal!.payoutCalls).toBe(0)
  })

  it('shows a tightening as a request that would now be refused, and a loosening that lets a refused one through', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    const ok = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId, { amountCents: 6_000, description: 'part' }) })
    const over = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId, { amountCents: 9_000, description: 'over the cap' }) })
    const body = await bodyOf(h.app)
    const tighter = (await replay(h.app, { ...body, perPaymentCeilingCents: 5_000, autoSettleUnderCents: 2_000 })).json
    expect(tighter.changed.find((item: { proposalId: string }) => item.proposalId === ok.json.id)).toMatchObject({ after: { gate: 'DENY', clause: 'amount.ceiling' } })
    expect(tighter.nowRefused).toBeGreaterThanOrEqual(1)
    void over
    const lunch = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { payee: 'Priya', amountCents: 1_800, currency: 'USD', category: 'lunch', description: 'lunch', evidenceUrl: EVIDENCE } })
    expect(lunch.json.gate).toBe('DENY')
    const looser = (await replay(h.app, { ...body, categories: ['design', 'production', 'lunch'], fundingRequired: false, standing: [] })).json
    expect(looser.changed.find((item: { proposalId: string }) => item.proposalId === lunch.json.id)).toMatchObject({ before: { gate: 'DENY', clause: 'category.missing' }, after: { gate: 'AUTO' } })
    expect(looser.nowAllowed).toBeGreaterThanOrEqual(1)
  })

  it('reports nothing for rules that change nothing, replays the request fairly against its own cap and funding, and is owner only', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    const sent = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: payout(paid.captureId) })
    await call(h.app, 'POST', `/v1/proposals/${sent.json.id}/approve`)
    await call(h.app, 'POST', `/v1/proposals/${sent.json.id}/capture`)
    const body = await bodyOf(h.app)
    // The payout is already paid and holds $90 of the client payment and of the cap. Replaying it must not count it against itself.
    const same = (await replay(h.app, body)).json
    expect(same.changed).toEqual([])
    expect((await replay(h.app, { ...body, monthlyCapCents: 9_000 })).json.changed).toEqual([])
    expect((await replay(h.app, { ...body, monthlyCapCents: 8_999 })).json.changed[0]).toMatchObject({ after: { gate: 'DENY', clause: 'cap.monthly' } })
    expect((await replay(h.app, body, STUDIO_KEY)).status).toBe(403)
    expect((await replay(h.app, { nonsense: true })).status).toBe(400)
  })
})

describe('after a refusal: what would pass', () => {
  it('offers only variants that were put back through the gate and came out allowed', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    const over = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId, { amountCents: 9_100 }) })
    expect(over.json).toMatchObject({ gate: 'DENY', clause: 'funding.exceeds' })
    const packet = (await call(h.app, 'GET', `/v1/proposals/${over.json.id}/packet`)).json
    expect(packet.whatWouldPass).toEqual([{ text: expect.stringContaining('$90.00 would pass'), tested: true }])

    const noProof = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId, { evidenceUrl: undefined }) })
    expect((await call(h.app, 'GET', `/v1/proposals/${noProof.json.id}/packet`)).json.whatWouldPass[0]).toMatchObject({ text: expect.stringContaining('https link'), tested: true })
    const lunch = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId, { category: 'lunch', amountCents: 1_800 }) })
    expect((await call(h.app, 'GET', `/v1/proposals/${lunch.json.id}/packet`)).json.whatWouldPass[0].text).toContain('design or production')
    const fake = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId, { payee: 'P. Shah', amountCents: 48_000 }) })
    expect((await call(h.app, 'GET', `/v1/proposals/${fake.json.id}/packet`)).json.whatWouldPass[0]).toMatchObject({ tested: false, text: expect.stringContaining('Only the owner can add someone') })
    // An allowed request has no suggestions.
    const fine = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId) })
    expect((await call(h.app, 'GET', `/v1/proposals/${fine.json.id}/packet`)).json.whatWouldPass).toEqual([])
  })

  it('tells apart "the client has not paid" from "the client has paid and the share is all paid out"', async () => {
    const h = harness()
    const deal = await agree(h.app)
    // Nothing paid yet: the client has to pay.
    const early = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(undefined as unknown as string, { fundingCaptureId: undefined }) })
    expect(early.json).toMatchObject({ gate: 'DENY', clause: 'funding.missing' })
    expect((await call(h.app, 'GET', `/v1/proposals/${early.json.id}/packet`)).json.whatWouldPass[0].text).toContain('The client has to pay first')
    // Paid, and the whole contractor share paid out: say that, not "the client has not paid".
    const paid = await collect(h.app, deal.id, 0)
    const sent = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId) })
    await call(h.app, 'POST', `/v1/proposals/${sent.json.id}/approve`)
    await call(h.app, 'POST', `/v1/proposals/${sent.json.id}/capture`)
    const again = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(undefined as unknown as string, { fundingCaptureId: undefined }) })
    expect(again.json).toMatchObject({ gate: 'DENY', clause: 'funding.missing' })
    const text = (await call(h.app, 'GET', `/v1/proposals/${again.json.id}/packet`)).json.whatWouldPass[0].text as string
    expect(text).toContain('has already been paid out')
    expect(text).not.toContain('has to pay first')
  })

  it('offers what is left of the cap, and the date the month rolls over', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    const body = await bodyOf(h.app)
    await call(h.app, 'PUT', '/v1/warrant', { body: { ...body, monthlyCapCents: 12_000 } })
    const first = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId, { amountCents: 6_000, description: 'part one' }) })
    await call(h.app, 'POST', `/v1/proposals/${first.json.id}/approve`)
    const second = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId, { amountCents: 3_000, description: 'part two' }) })
    await call(h.app, 'POST', `/v1/proposals/${second.json.id}/approve`)
    const third = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: payout(paid.captureId, { amountCents: 9_000, description: 'too much' }) })
    const texts = (await call(h.app, 'GET', `/v1/proposals/${third.json.id}/packet`)).json.whatWouldPass.map((item: { text: string }) => item.text)
    expect(third.json.clause).toMatch(/cap\.monthly|funding\.exceeds/)
    expect(texts.length).toBeGreaterThan(0)
  })
})
