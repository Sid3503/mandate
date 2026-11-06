import { afterEach, describe, expect, it } from 'vitest'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, NOW, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]
const RULE = { id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }

async function publish(app: App, patch: Record<string, unknown>) {
  const { id: _id, version: _v, createdAt: _c, ...body } = (await call(app, 'GET', '/v1/warrant')).json
  return call(app, 'PUT', '/v1/warrant', { body: { ...body, ...patch } })
}

async function funded(regretSeconds: number) {
  const h = harness()
  const deal = await agree(h.app)
  const charge = await collect(h.app, deal.id, 0)
  expect((await publish(h.app, { standing: [RULE], regretSeconds })).status).toBe(201)
  const ask = (amountCents = 9_000) => call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { payee: 'Priya', amountCents, currency: 'USD', category: 'design', description: 'Share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: charge.captureId } })
  const events = async (id: string) => (await call(h.app, 'GET', `/v1/proposals/${id}/packet`)).json.events.map((e: { type: string }) => e.type) as string[]
  return { h, ask, events, charge }
}

describe('the regret window: a rule\'s payout waits, and can be taken back', () => {
  it('sends at once when the window is 0, as before', async () => {
    const { h, ask } = await funded(0)
    const asked = await ask()
    expect(asked.json).toMatchObject({ clause: 'standing.matched', phase: 'captured' })
    expect(h.paypal!.payoutCalls).toBe(1)
  })

  it('holds the payout locked for the window, shows a countdown on Today, then sends it', async () => {
    const { h, ask, events } = await funded(60)
    const asked = await ask()
    expect(asked.json).toMatchObject({ gate: 'AUTO', clause: 'standing.matched', phase: 'locked' })
    expect(h.paypal!.payoutCalls).toBe(0)
    expect(await events(asked.json.id)).toContain('regret.started')

    const today = (await call(h.app, 'GET', '/v1/today')).json
    const item = [...today.waiting, ...today.inFlight].find((entry: { kind: string }) => entry.kind === 'regret')
    expect(item).toMatchObject({ proposalId: asked.json.id, actions: ['undo', 'open'] })
    expect(Date.parse(item.until) - NOW.getTime()).toBe(60_000)

    // A sweep inside the window changes nothing, and does not restart the clock.
    h.setNow(new Date(NOW.getTime() + 30_000))
    await h.services.mandate.sweepStanding()
    expect(h.paypal!.payoutCalls).toBe(0)
    expect((await events(asked.json.id)).filter((type) => type === 'regret.started')).toHaveLength(1)

    h.setNow(new Date(NOW.getTime() + 61_000))
    await h.services.mandate.sweepStanding()
    expect(h.paypal!.payoutCalls).toBe(1)
    expect((await call(h.app, 'GET', `/v1/proposals/${asked.json.id}`)).json.phase).toMatch(/payout_sent|captured/)
  })

  it('can be undone inside the window: nothing goes to PayPal, the cap is freed, and the sweep never sends it', async () => {
    const { h, ask, events } = await funded(60)
    const asked = await ask()
    const capBefore = (await call(h.app, 'GET', '/v1/blast-radius')).json.capLeftCents
    h.setNow(new Date(NOW.getTime() + 10_000))
    const undone = await call(h.app, 'POST', `/v1/proposals/${asked.json.id}/undo`)
    expect(undone.status).toBe(200)
    expect(undone.json.phase).toBe('rejected')
    expect(await events(asked.json.id)).toContain('proposal.undone')
    // The 90 dollars it held are free again, and a second press says the same thing, not an error.
    expect((await call(h.app, 'GET', '/v1/blast-radius')).json.capLeftCents).toBe(capBefore + 9_000)
    expect((await call(h.app, 'POST', `/v1/proposals/${asked.json.id}/undo`)).status).toBe(200)
    h.setNow(new Date(NOW.getTime() + 120_000))
    await h.services.mandate.sweepStanding()
    expect(h.paypal!.payoutCalls).toBe(0)
  })

  it('is too late once the window closes, and is the owner\'s (or an approver\'s) to press, never a proposer\'s', async () => {
    const { h, ask } = await funded(30)
    const asked = await ask()
    expect((await call(h.app, 'POST', `/v1/proposals/${asked.json.id}/undo`, { key: STUDIO_KEY })).status).toBe(403)
    h.setNow(new Date(NOW.getTime() + 31_000))
    const late = await call(h.app, 'POST', `/v1/proposals/${asked.json.id}/undo`, { key: OWNER_KEY })
    expect(late.status).toBe(409)
    expect(late.json.code ?? late.json.type).toMatch(/too_late/)
  })

  it('does not wait for a request the owner approved by tapping, and has nothing to undo on one', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const charge = await collect(h.app, deal.id, 0)
    await publish(h.app, { regretSeconds: 60 })
    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'Share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: charge.captureId } })
    expect(asked.json.phase).toBe('pending_approval')
    await call(h.app, 'POST', `/v1/proposals/${asked.json.id}/approve`)
    await call(h.app, 'POST', `/v1/proposals/${asked.json.id}/capture`)
    expect(h.paypal!.payoutCalls).toBe(1)
    expect((await call(h.app, 'POST', `/v1/proposals/${asked.json.id}/undo`)).status).toBe(409)
  })

  it('never makes the rules wider: the window changes when, not whether', async () => {
    const { h, ask } = await funded(60)
    expect((await ask(9_000)).json.phase).toBe('locked')
    // A second ask for the same share is still refused on the arithmetic, window or no window.
    expect((await ask(9_000)).json).toMatchObject({ gate: 'DENY' })
    expect((await call(h.app, 'GET', '/v1/blast-radius')).json.alone.payoutsCents).toBe(0)
  })
})
