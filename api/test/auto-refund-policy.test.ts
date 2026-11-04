import { afterEach, describe, expect, it } from 'vitest'
import { FakeWatch } from '../src/paypal/fake'
import { call, closeAll, EVIDENCE, harness, idem, JOB, NOW } from './support'

afterEach(closeAll)

const charge = { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: 'Northwind logo milestone', evidenceUrl: EVIDENCE, prompt: 'Bill Northwind', jobId: JOB }
const dispute = (captureId: string, status = 'UNDER_REVIEW') => ({ id: 'PP-D-1', status, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', cents: 15000, currency: 'USD', openedAt: null, updatedAt: null, transactionIds: [captureId] })
type H = ReturnType<typeof harness>

/** Publish the given auto-refund policy as the next version of the rules, and answer with what the books now say. */
async function putPolicy(h: H, policy: unknown) {
  const current = (await call(h.app, 'GET', '/v1/warrant')).json
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  const put = await call(h.app, 'PUT', '/v1/warrant', { body: { ...body, autoRefund: policy } })
  return { put, body: (await call(h.app, 'GET', '/v1/warrant')).json }
}

/** Bill the sample milestone and settle it. */
async function paid(h: H): Promise<{ id: string; captureId: string }> {
  const created = await call(h.app, 'POST', '/v1/proposals', { idem: idem('c'), body: charge })
  await call(h.app, 'POST', `/v1/proposals/${created.json.id}/approve`)
  const captured = await call(h.app, 'POST', `/v1/proposals/${created.json.id}/capture`)
  if (!captured.json.captureId) throw new Error(JSON.stringify(captured.json))
  return { id: created.json.id, captureId: captured.json.captureId }
}

/** The sample scenario: Northwind paid twice, an hour apart, and the books know. */
async function duplicated(h: H) {
  await paid(h)
  h.setNow(new Date(NOW.getTime() + 3_600_000))
  const second = await paid(h)
  const scan = await call(h.app, 'POST', '/v1/breaks/scan')
  expect(scan.json.opened).toEqual([`capture.duplicate:${second.id}`])
  return second
}

/** The way the Breaks desk's file_refund fix now asks: the refund goes through proposeAndDispatch as the autopilot. */
async function askPolicyRefund(h: H, second: Awaited<ReturnType<typeof duplicated>>, amountCents = 15000, idemKey = 'policy-refund') {
  return h.services.mandate.proposeAndDispatch({
    kind: 'refund', payee: 'Northwind', amountCents, currency: 'USD', category: 'design',
    description: 'Refund a duplicated payment', evidenceUrl: EVIDENCE, parentCaptureId: second.captureId, jobId: JOB,
  }, idem(idemKey), 'autopilot')
}

describe('the auto-refund policy, as a signed rule', () => {
  it('publishes only with real limits, so “automatic” cannot quietly mean “any amount”', async () => {
    const h = harness()
    expect((await putPolicy(h, { enabled: true, duplicateOnly: true, skipDisputed: true, maxCents: 0, monthlyCapCents: 0 })).put.status).toBe(400)
    expect((await putPolicy(h, { enabled: true, duplicateOnly: true, skipDisputed: true, maxCents: 20000, monthlyCapCents: 5000 })).put.status).toBe(400)
    expect((await putPolicy(h, { enabled: true, duplicateOnly: false, skipDisputed: true, maxCents: 20000, monthlyCapCents: 20000 })).put.status).toBe(400)
    // Limits mean nothing while the policy is off; the books should not carry a half-signed rule.
    expect((await putPolicy(h, { enabled: false, duplicateOnly: true, skipDisputed: true, maxCents: 2000, monthlyCapCents: 2000 })).put.status).toBe(400)
    const good = await putPolicy(h, { enabled: true, duplicateOnly: true, skipDisputed: true, maxCents: 20000, monthlyCapCents: 20000 })
    expect(good.put.status).toBe(201)
    expect(good.body.autoRefund).toMatchObject({ enabled: true, maxCents: 20000, monthlyCapCents: 20000 })
  })

  it('sends the refund of a duplicated payment on its own, through the same settle path', async () => {
    const h = harness()
    await putPolicy(h, { enabled: true, duplicateOnly: true, skipDisputed: true, maxCents: 20000, monthlyCapCents: 20000 })
    const second = await duplicated(h)
    const sent = await askPolicyRefund(h, second)
    expect(sent.status).toBe(201)
    const body = sent.body as { id: string; gate: string; clause: string; phase: string; detail: string }
    expect(body).toMatchObject({ gate: 'AUTO', clause: 'refund.auto_policy' })
    expect(body.detail).toContain('auto-refund policy')
    expect(h.paypal!.refundCalls).toBe(1)
    expect(h.paypal!.refunds.size).toBe(1)
    expect(h.repo.proposal(body.id)!.phase).toBe('refunded')
    // The books are back in order: the same settle path resolved the break too.
    const scan = await call(h.app, 'POST', '/v1/breaks/scan')
    expect(scan.json.resolved).toEqual([`capture.duplicate:${second.id}`])
  })

  it('leaves the same refund waiting for the owner while the policy is off', async () => {
    const h = harness()
    const second = await duplicated(h)
    const sent = await askPolicyRefund(h, second)
    expect(sent.body).toMatchObject({ gate: 'NEEDS_APPROVAL', phase: 'pending_approval' })
    expect(h.paypal!.refunds.size).toBe(0)
    // The owner may still tap it, and the settle path is the ordinary one.
    await call(h.app, 'POST', `/v1/proposals/${(sent.body as { id: string }).id}/approve`)
    const captured = await call(h.app, 'POST', `/v1/proposals/${(sent.body as { id: string }).id}/capture`)
    expect([captured.status, (captured.json as { phase?: string }).phase]).toEqual([200, 'refunded'])
  })

  it('never covers a payment the books do not prove was paid twice', async () => {
    const h = harness()
    await putPolicy(h, { enabled: true, duplicateOnly: true, skipDisputed: true, maxCents: 20000, monthlyCapCents: 20000 })
    const settle = await paid(h)
    const sent = await askPolicyRefund(h, settle, 15000, 'single-refund')
    expect(sent.body).toMatchObject({ gate: 'NEEDS_APPROVAL' })
    expect((sent.body as { clause?: string }).clause).not.toBe('refund.auto_policy')
    expect(h.paypal!.refunds.size).toBe(0)
  })

  it('waits for the owner above the per-refund maximum, and says where the line is', async () => {
    const h = harness()
    await putPolicy(h, { enabled: true, duplicateOnly: true, skipDisputed: true, maxCents: 5000, monthlyCapCents: 20000 })
    const second = await duplicated(h)
    const sent = await askPolicyRefund(h, second)
    expect(sent.body).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'refund.policy_cap' })
    expect((sent.body as { detail: string }).detail).toContain('50.00')
    expect((sent.body as { detail: string }).detail).toContain('150.00')
    expect(h.paypal!.refunds.size).toBe(0)
  })

  it('stops at the monthly cap once the month has spent it', async () => {
    const h = harness()
    await putPolicy(h, { enabled: true, duplicateOnly: true, skipDisputed: true, maxCents: 5000, monthlyCapCents: 5000 })
    const second = await duplicated(h)
    const first = await askPolicyRefund(h, second, 5000, 'policy-one')
    expect(first.body).toMatchObject({ gate: 'AUTO', clause: 'refund.auto_policy' })
    // 50.00 has gone this month; a further 40.00 would pass the 50.00 cap, so it waits.
    const again = await askPolicyRefund(h, second, 4000, 'policy-two')
    expect(again.body).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'refund.policy_cap' })
    expect((again.body as { detail: string }).detail).toContain('50.00')
    expect(h.paypal!.refunds.size).toBe(1)
  })

  it('sends no refund of its own while the client payment is under an open dispute', async () => {
    const watch = new FakeWatch()
    const h = harness({ watch })
    await putPolicy(h, { enabled: true, duplicateOnly: true, skipDisputed: true, maxCents: 20000, monthlyCapCents: 20000 })
    const second = await duplicated(h)
    watch.disputes = [dispute(second.captureId)]
    expect((await call(h.app, 'POST', '/v1/paypal/disputes/sync')).json.open).toBe(1)
    const sent = await askPolicyRefund(h, second, 5000, 'policy-disputed')
    expect(sent.body).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'refund.policy_disputed' })
    expect(h.paypal!.refunds.size).toBe(0)
  })

  it('finishes a policy refund through the sweep when PayPal answers PENDING first', async () => {
    const h = harness()
    h.paypal!.refundOutcome = 'PENDING'
    await putPolicy(h, { enabled: true, duplicateOnly: true, skipDisputed: true, maxCents: 20000, monthlyCapCents: 20000 })
    const second = await duplicated(h)
    const sent = await askPolicyRefund(h, second)
    expect(sent.body).toMatchObject({ gate: 'AUTO' })
    const refund = h.repo.proposal((sent.body as { id: string }).id)!
    expect(refund.phase).toBe('refund_pending')
    h.paypal!.setRefundStatus(refund.refund_id!, 'COMPLETED')
    await h.services.mandate.sweepPending()
    expect(h.repo.proposal(refund.id)!.phase).toBe('refunded')
  })
})
