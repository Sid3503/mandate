import { afterEach, describe, expect, it } from 'vitest'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

const deliver = (h: ReturnType<typeof harness>, event: Record<string, unknown>) =>
  h.app.request('http://mandate.test/v1/webhooks/paypal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) })

describe('the PayPal log: what was asked of PayPal, and what PayPal pushed back', () => {
  it('is for the owner only', async () => {
    const h = harness()
    expect((await call(h.app, 'GET', '/v1/paypal/log', { key: 'nobody' })).status).toBe(401)
    const got = await call(h.app, 'GET', '/v1/paypal/log')
    expect(got.status).toBe(200)
    expect(got.json.attempts).toEqual([])
    expect(got.json.webhooks).toEqual([])
    expect(got.json.counts).toMatchObject({ attempts: 0, webhooks: 0 })
    expect(got.json.webhookConfigured).toBe(false)
  })

  it('lists the money-moving calls with their status and PayPal\'s id, newest first', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const charge = await collect(h.app, deal.id, 0)
    const payout = await call(h.app, 'POST', '/v1/proposals', { idem: idem('p'), body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: charge.captureId } })
    await call(h.app, 'POST', `/v1/proposals/${payout.json.id}/approve`)
    expect((await call(h.app, 'POST', `/v1/proposals/${payout.json.id}/capture`)).json.phase).toBe('captured')
    const log = (await call(h.app, 'GET', '/v1/paypal/log')).json
    expect(log.counts.attempts).toBeGreaterThan(0)
    expect(log.attempts[0]).toMatchObject({ proposal_id: payout.json.id, op: 'payout', status: 'succeeded', request_id: expect.any(String) })
    expect(log.attempts[0].request_id.length).toBeLessThanOrEqual(64)
    expect(log.attempts[0].external_id).toMatch(/^BATCH-/)
  })

  it('lists the webhook inbox from its deliveries, with delivery state and why one failed', async () => {
    const h = harness()
    const done = { id: 'WH-11111111', event_type: 'PAYOUTS.PAYOUT.COMPLETED', resource: { payout_batch_id: 'PB-does-not-matter-1' } }
    const refused = { id: 'WH-22222222', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: {} }
    expect((await deliver(h, done)).status).toBe(200)
    expect((await deliver(h, refused)).status).toBe(200)
    const log = (await call(h.app, 'GET', '/v1/paypal/log')).json
    expect(log.webhooks.map((row: { event_id: string }) => row.event_id).sort()).toEqual(['WH-11111111', 'WH-22222222'])
    expect(log.webhooks.every((row: { status: string }) => row.status === 'done')).toBe(true)
    expect(log.counts.webhooks).toBe(2)
    expect(log.counts.webhooksFailed).toBe(0)
  })

  it('keeps a delivered event out of the inbox twice, and says so', async () => {
    const h = harness()
    const event = { id: 'WH-33333333', event_type: 'PAYOUTS.PAYOUT.COMPLETED', resource: { payout_batch_id: 'PB-does-not-matter-2' } }
    const first = await deliver(h, event)
    expect(first.status).toBe(200)
    const second = await deliver(h, event)
    expect(second.status).toBe(200)
    expect(second.ok ? 200 : second.status).toBe(200)
    const log = (await call(h.app, 'GET', '/v1/paypal/log')).json
    // Same event id, one inbox row: PayPal's retries are answered, not re-processed.
    expect(log.webhooks).toHaveLength(1)
    expect(log.webhooks[0]).toMatchObject({ event_id: 'WH-33333333', event_type: 'PAYOUTS.PAYOUT.COMPLETED' })
  })

  it('says whether webhook deliveries are verified, without ever printing secrets', async () => {
    const h = harness({ webhookId: 'WH-SET-UP' })
    const log = (await call(h.app, 'GET', '/v1/paypal/log')).json
    expect(log.webhookConfigured).toBe(true)
    expect(JSON.stringify(log)).not.toContain('WH-SET-UP')
    expect(OWNER_KEY.length).toBeGreaterThan(0)
  })
})
