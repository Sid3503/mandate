import { afterEach, describe, expect, it } from 'vitest'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, STUDIO_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]

async function publish(app: App, patch: Record<string, unknown>) {
  const { id: _id, version: _v, createdAt: _c, ...body } = (await call(app, 'GET', '/v1/warrant')).json
  return call(app, 'PUT', '/v1/warrant', { body: { ...body, ...patch } })
}

const RULE = { id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }
const ask = (fundingCaptureId: string, amountCents: number) => ({ payee: 'Priya', amountCents, currency: 'USD', category: 'design', description: 'Share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId })

describe('blast radius, on the real server', () => {
  it('is zero before any client has paid, and is the owner\'s to read', async () => {
    const h = harness()
    const radius = (await call(h.app, 'GET', '/v1/blast-radius')).json
    expect(radius.alone.totalCents).toBe(0)
    expect(radius.queued.totalCents).toBe(0)
    expect(radius.currency).toBe('USD')
    expect((await call(h.app, 'GET', '/v1/blast-radius', { key: STUDIO_KEY })).status).toBe(403)
    expect((await call(h.app, 'POST', '/v1/rules/attack', { key: STUDIO_KEY, body: {} })).status).toBe(403)
  })

  it('is exactly what a hostile studio key can get out with no tap: the number is the ceiling, and it is reached, not passed', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    expect((await publish(h.app, { standing: [RULE] })).status).toBe(201)

    const before = (await call(h.app, 'GET', '/v1/blast-radius')).json
    expect(before.alone.payoutsCents).toBe(9_000)
    expect(before.queued.payoutsCents).toBe(9_000)

    // A hostile key asks for far more than the number, one cheap ask after another. Only what the rules allow moves.
    let sent = 0
    for (const cents of [9_000, 9_000, 1_999, 500, 9_000]) {
      const got = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: ask(paid.captureId, cents) })
      if (got.json.phase === 'captured' || got.json.phase === 'payout_sent') sent += got.json.amountCents
    }
    expect(sent).toBe(before.alone.payoutsCents)
    expect(h.paypal!.payoutCalls).toBe(1)

    const after = (await call(h.app, 'GET', '/v1/blast-radius')).json
    expect(after.alone.totalCents).toBe(0)
    expect(after.capLeftCents).toBe(before.capLeftCents - 9_000)
  })

  it('shows a draft beside the live rules, so a change is seen before it is published', async () => {
    const h = harness()
    const deal = await agree(h.app)
    await collect(h.app, deal.id, 0)
    const { id: _i, version: _v, createdAt: _c, ...rules } = (await call(h.app, 'GET', '/v1/warrant')).json
    const draft = (await call(h.app, 'POST', '/v1/rules/blast', { body: { rules: { ...rules, standing: [RULE] } } })).json
    expect(draft.live.alone.totalCents).toBe(0)
    expect(draft.draft.alone.payoutsCents).toBe(9_000)
    expect((await call(h.app, 'POST', '/v1/rules/blast', { body: { rules: { monthlyCapCents: 'lots' } } })).status).toBe(400)
  })

  it('attacks the live rules without filing a thing or calling PayPal, and finds a fix that works', async () => {
    const h = harness()
    const deal = await agree(h.app)
    await collect(h.app, deal.id, 0)
    await publish(h.app, { standing: [RULE] })
    const rows = (await call(h.app, 'GET', '/v1/proposals')).json.data.length
    const calls = h.paypal!.payoutCalls
    const report = (await call(h.app, 'POST', '/v1/rules/attack', { body: {} })).json
    expect((await call(h.app, 'GET', '/v1/proposals')).json.data).toHaveLength(rows)
    expect(h.paypal!.payoutCalls).toBe(calls)
    expect(report.of).toBe('live')
    expect(report.hypothetical).toBe(false)
    expect(report.attacks.find((a: { id: string }) => a.id === 'stranger')).toMatchObject({ outcome: 'refused', clause: 'payee.unknown' })
    const big = report.attacks.find((a: { id: string }) => a.id === 'big-standing')
    expect(big).toMatchObject({ outcome: 'alone', movedCents: 9_000 })
    expect(big.fix.sentence).toBeTruthy()
    // The fix, applied to a draft, really stops that attack.
    const { id: _i, version: _v, createdAt: _c, ...rules } = (await call(h.app, 'GET', '/v1/warrant')).json
    const fixed = (await call(h.app, 'POST', '/v1/rules/attack', { body: { rules: { ...rules, ...big.fix.patch } } })).json
    expect(fixed.of).toBe('draft')
    expect(fixed.attacks.find((a: { id: string }) => a.id === 'big-standing').movedCents).toBe(big.fix.toCents)
  })
})
