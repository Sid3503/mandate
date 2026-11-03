import { afterEach, describe, expect, it } from 'vitest'
import { withMaintenance } from '../src/db/database'
import { PayPalError } from '../src/paypal/port'
import { createPayPalClient } from '../src/paypal/client'
import { call, closeAll, harness, idem, JOB, EVIDENCE, NOW, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

const charge = {
  kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design',
  description: 'Northwind logo milestone 1 invoice', evidenceUrl: EVIDENCE, prompt: 'Bill Northwind $150', jobId: JOB,
}
const priya = {
  payee: 'Priya', amountCents: 9000, currency: 'USD', category: 'design', description: 'Northwind logo milestone 1',
  evidenceUrl: EVIDENCE, prompt: 'Pay Priya her share', jobId: JOB,
}

type H = ReturnType<typeof harness>

async function approvedCharge(h: H): Promise<string> {
  const created = await call(h.app, 'POST', '/v1/proposals', { idem: idem('c'), body: charge })
  await call(h.app, 'POST', `/v1/proposals/${created.json.id}/approve`)
  return created.json.id as string
}

async function paidCharge(h: H): Promise<{ id: string; captureId: string }> {
  const id = await approvedCharge(h)
  const captured = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
  if (!captured.json.captureId) throw new Error(JSON.stringify(captured.json))
  return { id, captureId: captured.json.captureId }
}

async function lockedPayout(h: H, fundingCaptureId: string): Promise<string> {
  const created = await call(h.app, 'POST', '/v1/proposals', { idem: idem('p'), body: { ...priya, fundingCaptureId } })
  await call(h.app, 'POST', `/v1/proposals/${created.json.id}/approve`)
  return created.json.id as string
}

const phase = (h: H, id: string) => h.repo.proposal(id)!.phase
const balance = (h: H, account: string) => h.repo.ledgerBalances().find((row) => row.account === account)?.cents ?? 0

describe('a capture is only money when PayPal says COMPLETED', () => {
  it('holds a PENDING capture, pays nobody from it, and settles it once PayPal completes it', async () => {
    const h = harness()
    h.paypal!.captureOutcome = 'PENDING'
    const id = await approvedCharge(h)
    const res = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    expect(res.status).toBe(202)
    expect(phase(h, id)).toBe('capture_pending')
    expect(balance(h, 'paypal:balance')).toBe(0)
    // A payout cannot be funded from money that has not arrived.
    const payout = await call(h.app, 'POST', '/v1/proposals', { idem: idem('p'), body: { ...priya, fundingCaptureId: res.json.captureId } })
    expect(payout.json.gate).toBe('DENY')

    h.paypal!.setCaptureStatus(res.json.captureId, 'COMPLETED')
    await h.services.mandate.sweepPending()
    expect(phase(h, id)).toBe('captured')
    expect(balance(h, 'income:client_payments')).toBe(-15000)
  })

  it('records a DECLINED capture as failed, moves no money, and frees the milestone', async () => {
    const h = harness()
    h.paypal!.captureOutcome = 'DECLINED'
    const id = await approvedCharge(h)
    const res = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    expect(res.status).toBe(402)
    expect(res.json.code).toBe('pay.capture_declined')
    expect(phase(h, id)).toBe('capture_failed')
    expect(h.repo.journal()).toHaveLength(0)
  })

  it('recovers a capture whose answer was lost, without capturing twice, even past the request-id window', async () => {
    const h = harness()
    const id = await approvedCharge(h)
    h.paypal!.loseNextCaptureAnswer = true
    const first = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    expect(first.status).toBeGreaterThanOrEqual(500)
    // PayPal may have captured: the row is not marked paid, and the unknown answer is on record.
    expect(['capture_inflight', 'order_created']).toContain(phase(h, id))
    expect(h.repo.attemptsFor(id).map((a) => a.status)).toEqual(['unknown'])

    h.paypal!.requestIdsForgotten = true
    h.setNow(new Date(NOW.getTime() + 10 * 60_000))
    await h.services.mandate.sweepPending()
    expect(phase(h, id)).toBe('captured')
    expect(h.paypal!.captureCalls).toBe(1)
    expect(h.repo.eventsFor(id).filter((e) => e.type === 'capture.completed')).toHaveLength(1)
  })

  it('puts back a request whose settle crashed before PayPal was called', async () => {
    const h = harness()
    const id = await approvedCharge(h)
    h.repo.setPhase(id, 'capture_inflight', NOW.toISOString())
    h.setNow(new Date(NOW.getTime() + 10 * 60_000))
    await h.services.mandate.recoverStalled()
    expect(phase(h, id)).toBe('locked')
    expect(h.repo.eventsFor(id).some((e) => e.type === 'capture.recovered')).toBe(true)
  })
})

describe('payouts are recorded once, however many times PayPal is asked', () => {
  it('two refreshes of the same batch at once count the payout once', async () => {
    const h = harness()
    h.paypal!.payoutOutcome = 'PENDING'
    const { captureId } = await paidCharge(h)
    const id = await lockedPayout(h, captureId)
    const sent = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    expect(phase(h, id)).toBe('payout_sent')
    h.paypal!.settlePayouts('SUCCESS')
    await Promise.all([
      h.services.mandate.refreshPayoutBatch(sent.json.payoutBatchId, 'server'),
      h.services.mandate.refreshPayoutBatch(sent.json.payoutBatchId, 'server'),
    ])
    expect(phase(h, id)).toBe('captured')
    expect(h.repo.eventsFor(id).filter((e) => e.type === 'payout.completed')).toHaveLength(1)
    expect(h.repo.payeeRow('payee_priya')!.total_paid_cents).toBe(9000)
    expect(balance(h, 'expense:payouts:payee_priya')).toBe(9000)
  })

  it('a stale PENDING read cannot move a paid payout back to sent', async () => {
    const h = harness()
    const { captureId } = await paidCharge(h)
    const id = await lockedPayout(h, captureId)
    const sent = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    expect(phase(h, id)).toBe('captured')
    const batch = h.paypal!.payouts.get(sent.json.payoutBatchId)!
    batch.status = 'PENDING'
    await h.services.mandate.refreshPayoutBatch(sent.json.payoutBatchId, 'server')
    expect(phase(h, id)).toBe('captured')
  })

  it('a payout PayPal returns after paying it is reversed in the books by a new entry', async () => {
    const h = harness()
    const { captureId } = await paidCharge(h)
    const id = await lockedPayout(h, captureId)
    const sent = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    expect(balance(h, 'expense:payouts:payee_priya')).toBe(9000)
    h.paypal!.payouts.get(sent.json.payoutBatchId)!.status = 'RETURNED'
    await h.services.mandate.refreshPayoutBatch(sent.json.payoutBatchId, 'server')
    expect(phase(h, id)).toBe('payout_failed')
    expect(balance(h, 'expense:payouts:payee_priya')).toBe(0)
    expect(h.repo.journal().some((entry) => entry.delta_cents < 0)).toBe(true)
  })
})

describe('the double-entry ledger', () => {
  it('books a full flow so that every entry balances and the PayPal balance is what really moved', async () => {
    const h = harness()
    const { captureId } = await paidCharge(h)
    const id = await lockedPayout(h, captureId)
    await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    for (const entry of h.repo.allJournal()) expect(entry.postings.reduce((s, leg) => s + leg.amountCents, 0)).toBe(0)
    const charged = h.repo.proposalByCapture(captureId)!
    const fee = charged.capture_fee_cents ?? 0
    const payoutFee = h.repo.proposal(id)!.payout_fee_cents ?? 0
    expect(balance(h, 'paypal:balance')).toBe(15000 - fee - 9000 - payoutFee)
    const audit = await call(h.app, 'GET', '/v1/audit')
    expect(audit.json.checks.find((c: { id: string }) => c.id === 'ledger.balanced').status).toBe('pass')
  })

  it('refuses to edit or delete a journal entry, and the audit sees a chain broken behind its back', async () => {
    const h = harness()
    await paidCharge(h)
    expect(() => h.db.prepare('UPDATE postings SET amount_cents = 1').run()).toThrow(/append-only/)
    expect(() => h.db.prepare('DELETE FROM journal_entries').run()).toThrow(/append-only/)
    withMaintenance(h.db, () => h.db.prepare(`UPDATE journal_entries SET memo = 'edited'`).run())
    const audit = await call(h.app, 'GET', '/v1/audit')
    expect(audit.json.checks.find((c: { id: string }) => c.id === 'ledger.balanced').status).toBe('fail')
  })

  it('refuses an entry whose legs do not sum to zero', () => {
    const h = harness()
    expect(() => h.repo.transaction(() => {
      h.db.prepare(`INSERT INTO postings (entry_id, account, amount_cents) VALUES ('x', 'a', 5)`).run()
      h.db.prepare(`INSERT INTO postings (entry_id, account, amount_cents) VALUES ('x', 'b', -4)`).run()
      h.db.prepare(`INSERT INTO journal_entries (id, seq, proposal_id, purpose, currency, delta_cents, memo, prev_hash, hash, created_at) VALUES ('x', 999, 'nope', 'p', 'USD', 5, 'm', 'a', 'b', 'now')`).run()
    })).toThrow(/does not balance/)
  })
})

describe('the database enforces the rules even if the code does not', () => {
  it('refuses an impossible request, a rewound phase, a changed lock and an edited history', async () => {
    const h = harness()
    const { id } = await paidCharge(h)
    expect(() => h.db.prepare(`INSERT INTO proposals (id, warrant_id, warrant_version, kind, amount_cents, currency, description, gate, clause, detail, phase, created_at, updated_at)
      VALUES ('neg', 'w', 1, 'payment', -5, 'USD', 'd', 'AUTO', 'c', 'd', 'locked', 'now', 'now')`).run()).toThrow(/positive/)
    expect(() => h.db.prepare(`UPDATE proposals SET phase = 'payout_sent' WHERE id = ?`).run(id)).toThrow(/transition not allowed/)
    expect(() => h.db.prepare('UPDATE proposals SET amount_cents = 1 WHERE id = ?').run(id)).toThrow(/locked cart/)
    expect(() => h.db.prepare(`UPDATE events SET payload_json = '{}'`).run()).toThrow(/append-only/)
    expect(() => h.db.prepare(`UPDATE warrants SET body_json = '{}'`).run()).toThrow(/append-only/)
  })

  it('confirms a payee address change as a new version of the rules, never by editing the old one', async () => {
    const h = harness()
    const before = h.repo.latestWarrant()!
    h.repo.requestPayeeChange('payee_priya', 'priya.new@example.com')
    h.repo.confirmPayeeChange('payee_priya', NOW.toISOString())
    const after = h.repo.latestWarrant()!
    expect(after.version).toBe(before.version + 1)
    expect(after.body.payees.find((p) => p.id === 'payee_priya')!.email).toBe('priya.new@example.com')
    expect(h.repo.warrant(before.id, before.version)!.body.payees.find((p) => p.id === 'payee_priya')!.email).not.toBe('priya.new@example.com')
  })
})

describe('refunds are only done when PayPal says so', () => {
  it('keeps a PENDING refund held against its capture and finishes it later', async () => {
    const h = harness()
    const { captureId } = await paidCharge(h)
    h.paypal!.refundOutcome = 'PENDING'
    const refund = await call(h.app, 'POST', '/v1/proposals', { idem: idem('r'), body: { kind: 'refund', parentCaptureId: captureId, amountCents: 5000, currency: 'USD', description: 'Partial refund', evidenceUrl: EVIDENCE, payee: 'Northwind', category: 'design', jobId: JOB } })
    await call(h.app, 'POST', `/v1/proposals/${refund.json.id}/approve`)
    const sent = await call(h.app, 'POST', `/v1/proposals/${refund.json.id}/capture`)
    expect(sent.status).toBe(202)
    expect(phase(h, refund.json.id)).toBe('refund_pending')
    expect(h.repo.heldRefundCents(captureId)).toBe(5000)
    expect(balance(h, 'income:refunds')).toBe(0)
    h.paypal!.setRefundStatus(h.repo.proposal(refund.json.id)!.refund_id!, 'COMPLETED')
    await h.services.mandate.sweepPending()
    expect(phase(h, refund.json.id)).toBe('refunded')
    expect(balance(h, 'income:refunds')).toBe(5000)
  })
})

describe('webhooks', () => {
  const deliver = (h: H, event: Record<string, unknown>) => h.app.request('http://mandate.test/v1/webhooks/paypal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) })

  it('a chargeback at PayPal reverses the client payment and stops payouts from it', async () => {
    const h = harness()
    const { id, captureId } = await paidCharge(h)
    h.paypal!.setCaptureStatus(captureId, 'REFUNDED')
    const res = await deliver(h, { id: 'WH-REV-1', event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: 'RF-1', links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] } })
    expect((await res.json()).refreshed).toBe(true)
    expect(phase(h, id)).toBe('capture_reversed')
    expect(balance(h, 'income:reversals')).toBe(15000)
    const payout = await call(h.app, 'POST', '/v1/proposals', { idem: idem('p'), body: { ...priya, fundingCaptureId: captureId } })
    expect(payout.json.gate).toBe('DENY')
  })

  it('a delivery whose processing failed is processed again on PayPal\'s retry; a done one is not', async () => {
    const h = harness()
    const { captureId } = await paidCharge(h)
    const original = h.paypal!.getCapture.bind(h.paypal!)
    h.paypal!.getCapture = async () => { throw new PayPalError(503, 'down', null, 'x') }
    const event = { id: 'WH-RETRY-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: captureId } }
    await deliver(h, event)
    expect(h.repo.webhookEvent('WH-RETRY-1')!.status).toBe('failed')
    h.paypal!.getCapture = original
    await deliver(h, event)
    expect(h.repo.webhookEvent('WH-RETRY-1')).toMatchObject({ status: 'done', attempts: 2 })
    const again = await (await deliver(h, event)).json()
    expect(again.duplicate).toBe(true)
  })
})

describe('idempotency keys belong to whoever used them', () => {
  it('the same key from two callers files two requests, and a replay is not billed again', async () => {
    const h = harness()
    const key = 'shared-key-123456'
    const a = await call(h.app, 'POST', '/v1/proposals', { key: OWNER_KEY, idem: key, body: { ...priya } })
    const b = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: key, body: { ...priya } })
    expect(a.json.id).toBeTruthy()
    expect(b.json.id).toBeTruthy()
    expect(a.json.id).not.toBe(b.json.id)
    const replay = await call(h.app, 'POST', '/v1/proposals', { key: OWNER_KEY, idem: key, body: { ...priya } })
    expect(replay.json.id).toBe(a.json.id)
  })
})

describe('the PayPal client', () => {
  it('recovers from an open breaker even when it has no token cached', async () => {
    let clock = 0
    let down = true
    const fetchStub = (async (url: string) => {
      if (down) throw new TypeError('fetch failed')
      if (String(url).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      return new Response(JSON.stringify({ balances: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const client = createPayPalClient({ clientId: 'id', clientSecret: 'secret', baseUrl: 'https://paypal.test', fetch: fetchStub, guard: { attempts: 1, failuresToOpen: 1, cooldownMs: 1000, now: () => clock, sleep: async () => undefined } })
    await expect(client.balance('USD')).rejects.toBeTruthy()
    expect(client.upstream!().circuit).toBe('open')
    down = false
    clock = 5000
    // The half-open probe must reach PayPal, fetching a token on the way, and close the breaker.
    await expect(client.balance('USD')).resolves.toMatchObject({ availableCents: 0 })
    expect(client.upstream!().circuit).toBe('closed')
  })
})
