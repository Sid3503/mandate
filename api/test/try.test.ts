import { afterEach, describe, expect, it } from 'vitest'
import { agree, call, closeAll, collect, EVIDENCE, harness, JOB, STUDIO_KEY } from './support'

afterEach(closeAll)

const request = (over: Record<string, unknown> = {}) => ({ kind: 'payment', payee: 'Priya', amountCents: 1_000, currency: 'USD', category: 'design', description: 'Try', evidenceUrl: EVIDENCE, jobId: JOB, ...over })
const body = async (app: Parameters<typeof call>[0], patch: Record<string, unknown> = {}) => {
  const { id: _i, version: _v, createdAt: _c, ...rest } = (await call(app, 'GET', '/v1/warrant')).json
  return { ...rest, ...patch }
}

describe('trying a request without filing it', () => {
  it('gives the gate\'s own answer, under the live rules and under a draft, and files nothing', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    const before = (await call(h.app, 'GET', '/v1/proposals')).json.data.length
    const asked = request({ amountCents: 9_000, fundingCaptureId: paid.captureId })
    const live = await call(h.app, 'POST', '/v1/rules/try', { body: { request: asked } })
    expect(live.json.live).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval' })
    expect(live.json.draft).toBeNull()
    expect(live.json.funding).toMatchObject({ captureId: paid.captureId, canStillFundCents: 9_000 })
    // Under a draft that raises the no-tap line, the same request would go with no tap.
    const draft = await call(h.app, 'POST', '/v1/rules/try', { body: { request: asked, rules: await body(h.app, { autoSettleUnderCents: 20_000 }) } })
    expect(draft.json.live.gate).toBe('NEEDS_APPROVAL')
    expect(draft.json.draft).toMatchObject({ gate: 'AUTO', clause: 'amount.auto' })
    // Nothing was filed, and PayPal was not touched.
    expect((await call(h.app, 'GET', '/v1/proposals')).json.data).toHaveLength(before)
    expect(h.paypal!.payoutCalls).toBe(0)
  })

  it('is the owner\'s, validates what it is given, and cannot be used to smuggle in rules that are not rules', async () => {
    const h = harness()
    expect((await call(h.app, 'POST', '/v1/rules/try', { key: STUDIO_KEY, body: { request: request() } })).status).toBe(403)
    expect((await call(h.app, 'POST', '/v1/rules/try', { body: { request: request({ amountCents: -5 }) } })).status).toBe(400)
    expect((await call(h.app, 'POST', '/v1/rules/try', { body: { request: request(), rules: { monthlyCapCents: 'lots' } } })).status).toBe(400)
  })
})

describe('cases made from the rules', () => {
  it('sit on the boundaries of the rules and say what each would do, with no client payment to cite', async () => {
    const h = harness()
    const { json } = await call(h.app, 'POST', '/v1/rules/cases', { body: {} })
    expect(json.funding).toBeNull()
    const by = Object.fromEntries(json.cases.map((item: { id: string; live: { gate: string; clause: string } }) => [item.id, item.live]))
    expect(by['stranger']).toMatchObject({ gate: 'DENY', clause: 'payee.unknown' })
    expect(by['not-allowed']).toMatchObject({ gate: 'DENY', clause: 'category.missing' })
    // The rules ask for client money first, so cases about a small or unproven payout wait for a real payment to cite.
    expect(by['under-line']).toBeUndefined()
    expect(by['over-ceiling']).toBeUndefined()
    expect(by['no-proof']).toBeUndefined()
  })

  it('cite a real client payment when there is one, and show the draft beside the live rules', async () => {
    const h = harness()
    const deal = await agree(h.app)
    await collect(h.app, deal.id, 0)
    const { json } = await call(h.app, 'POST', '/v1/rules/cases', { body: { rules: await body(h.app, { autoSettleUnderCents: 500 }) } })
    expect(json.funding).not.toBeNull()
    const line = json.cases.find((item: { id: string }) => item.id === 'under-line')
    // The live line is $20 and the draft's is $5: a payment of a cent under the draft line is the boundary of the DRAFT.
    expect(line.request.amountCents).toBe(499)
    expect(line.live).toMatchObject({ gate: 'AUTO' })
    expect(line.draft).toMatchObject({ gate: 'AUTO' })
    expect(json.cases.find((item: { id: string }) => item.id === 'over-ceiling').live.gate).toBe('DENY')
    const onLine = json.cases.find((item: { id: string }) => item.id === 'on-line')
    expect(onLine.live).toMatchObject({ gate: 'AUTO' })
    expect(onLine.draft).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval' })
  })
})
