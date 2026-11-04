import { afterEach, describe, expect, it } from 'vitest'
import { allowRawWrites, agree, BUYER_KEY, call, closeAll, EVIDENCE, harness, STUDIO_KEY } from './support'
import { loadFlags } from '../src/flags'
import { FakeDisputes } from '../src/paypal/fake-disputes'
import { disputeRequestFor, parseDisputeDetail } from '../src/paypal/disputes'
import { FakeInvoices } from '../src/paypal/fake'
import { scriptedModel } from './mockModel'

afterEach(closeAll)

type H = ReturnType<typeof harness>

/** A paid client charge (optionally from a deal milestone the client accepted) with a dispute on its capture. */
async function disputed(options: { accepted?: boolean; unpaid?: boolean; flags?: ReturnType<typeof loadFlags> } = {}) {
  const invoices = new FakeInvoices()
  const h = harness({ flags: options.flags, invoices: options.accepted ? invoices : undefined })
  let captureId: string
  let proposalId: string
  if (options.unpaid) {
    captureId = 'CAP-UNPAID'
    proposalId = ''
  } else if (options.accepted) {
    // The client's own agent accepts the delivery; the billing rule then invoices it; the client pays; the sweep captures.
    const deal = await agree(h.app)
    const current = (await call(h.app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    await call(h.app, 'PUT', '/v1/warrant', { body: { ...body, automation: { billSignedDeals: true, requireAcceptance: true, payOnSettle: false, remindUnpaidAfterDays: null, maxReminders: 2 } } })
    await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/deliver`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    const decided = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/decision`, { key: BUYER_KEY, body: { decision: 'accepted' } })
    expect(decided.json.delivery.status).toBe('accepted')
    proposalId = decided.json.charge.id
    invoices.pay(decided.json.charge.invoiceId)
    await h.services.mandate.sweepPending()
    captureId = (await call(h.app, 'GET', `/v1/proposals/${proposalId}`)).json.captureId
  } else {
    const created = await call(h.app, 'POST', '/v1/proposals', { idem: 'dsp-charge-0001-key', body: { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: 'Northwind logo milestone 1 invoice', evidenceUrl: EVIDENCE, prompt: 'Bill Northwind $150', jobId: 'job_northwind_logo' } })
    proposalId = created.json.id
    await call(h.app, 'POST', `/v1/proposals/${proposalId}/approve`)
    captureId = (await call(h.app, 'POST', `/v1/proposals/${proposalId}/capture`)).json.captureId
  }
  const fake = new FakeDisputes()
  h.services.disputes.port = fake
  fake.add({ id: 'PP-D-1001', transactionIds: [captureId], amountCents: 15000, sellerResponseDueDate: '2026-10-05T06:00:00Z' })
  h.repo.upsertDispute({ disputeId: 'PP-D-1001', transactionId: captureId, status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', amountCents: 15000, currency: 'USD', openedAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z' })
  return { h, fake, captureId, proposalId }
}

const detail = (h: H, id = 'PP-D-1001') => call(h.app, 'GET', `/v1/disputes/${id}`)

describe('PayPal request shapes', () => {
  it('sends a message while the dispute is an inquiry and evidence at every later stage', () => {
    expect(disputeRequestFor('INQUIRY', 'PP-D-1', 'hello', 'rid')).toEqual({ method: 'POST', path: '/v1/customer/disputes/PP-D-1/send-message', body: { message: 'hello' }, requestId: 'rid' })
    expect(disputeRequestFor('CHARGEBACK', 'PP-D-1', 'hello', 'rid')).toEqual({ method: 'POST', path: '/v1/customer/disputes/PP-D-1/provide-evidence', body: { evidences: [{ evidence_type: 'OTHER', notes: 'hello' }] }, requestId: 'rid' })
  })

  it('reads the documented fields of a dispute and invents none', () => {
    const parsed = parseDisputeDetail({ dispute_id: 'PP-D-9', status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'UNAUTHORISED', dispute_life_cycle_stage: 'CHARGEBACK', dispute_amount: { currency_code: 'USD', value: '150.00' }, seller_response_due_date: '2026-10-05T06:00:00Z', disputed_transactions: [{ seller_transaction_id: 'CAP-1' }], links: [{ rel: 'provide-evidence' }], allowed_response_options: { accept_claim: {} } })
    expect(parsed).toMatchObject({ id: 'PP-D-9', stage: 'CHARGEBACK', amountCents: 15000, sellerResponseDueDate: '2026-10-05T06:00:00Z', transactionIds: ['CAP-1'], linkRels: ['provide-evidence'], allowedResponseOptions: ['accept_claim'] })
    expect(parseDisputeDetail({})).toMatchObject({ status: 'OTHER', stage: 'UNKNOWN', amountCents: null, transactionIds: [], sellerResponseDueDate: null })
  })
})

describe('the evidence packet', () => {
  it('holds the signed lock, the approval, the capture, the proof and the books, and lists what is missing', async () => {
    const { h, captureId, proposalId } = await disputed()
    const packet = (await detail(h)).json.packet
    expect(packet.proposalId).toBe(proposalId)
    expect(packet.lock.verdict).toBe('valid')
    expect(packet.approval.method).toBe('owner-key')
    expect(packet.payment).toMatchObject({ captureId, amountCents: 15000, proofUrl: EVIDENCE })
    expect(packet.books.length).toBeGreaterThan(0)
    const ok = Object.fromEntries(packet.checklist.map((item: { id: string; present: boolean }) => [item.id, item.present]))
    expect(ok).toMatchObject({ payment: true, capture: true, lock: true, approval: true, proof: true, books: true, acceptance: false })
    expect(packet.links.verify).toContain(`/app/verify?proposal=${proposalId}`)
  })

  it('carries the client\'s signed acceptance of the delivery when there is one', async () => {
    const { h } = await disputed({ accepted: true })
    const packet = (await detail(h)).json.packet
    expect(packet.acceptance).toMatchObject({ status: 'accepted', signatureValid: true, milestone: 0 })
    expect(packet.checklist.find((item: { id: string }) => item.id === 'acceptance').present).toBe(true)
  })

  it('says plainly when Mandate has no such payment, and refuses to send', async () => {
    const { h } = await disputed()
    h.repo.upsertDispute({ disputeId: 'PP-D-2', transactionId: 'CAP-UNKNOWN', status: 'OPEN', reason: null, amountCents: 100, currency: 'USD', openedAt: null, updatedAt: '2026-10-01T09:00:00Z' })
    ;(h.services.disputes.port as FakeDisputes).add({ id: 'PP-D-2' })
    const packet = (await detail(h, 'PP-D-2')).json.packet
    expect(packet.proposalId).toBeNull()
    expect(packet.checklist).toHaveLength(1)
    const sent = await call(h.app, 'POST', '/v1/disputes/PP-D-2/send', { body: { text: 'hello' } })
    expect(sent.status).toBe(409)
    expect(sent.json.code).toBe('dispute.no_payment')
  })

  it('lists disputes with a response-due countdown, urgent under 48 hours', async () => {
    const { h } = await disputed()
    await detail(h)
    // The clock is 2026-10-03T12:00Z; the due date is 2026-10-05T06:00Z: 42 hours.
    const row = (await call(h.app, 'GET', '/v1/disputes')).json.data[0]
    expect(row).toMatchObject({ id: 'PP-D-1001', respondBy: '2026-10-05T06:00:00Z', urgent: true, response: 'none', inRecords: true })
    expect(row.dueInMs).toBe(42 * 3_600_000)
  })
})

describe('the draft', () => {
  it('is written by the template from facts in the packet, and names what is missing without inventing it', async () => {
    const { h, captureId } = await disputed()
    const draft = (await call(h.app, 'POST', '/v1/disputes/PP-D-1001/draft')).json
    expect(draft.source).toBe('template')
    expect(draft.text).toContain(captureId)
    expect(draft.text).toContain('$150.00')
    expect(draft.text).toContain(EVIDENCE)
    expect(draft.text).toContain('Not available in our records')
    expect(draft.text).toContain('client accepted the delivery')
    // No acceptance in the packet, so the draft never claims one.
    expect(draft.text).not.toMatch(/The client accepted the delivery of milestone/)
    expect(draft.text.length).toBeLessThanOrEqual(2000)
  })

  it('uses a model\'s wording only when it states nothing the packet does not hold', async () => {
    const { h, captureId } = await disputed()
    h.services.disputes.model = scriptedModel(() => ({ tool: 'write_response', input: { text: `The payment ${captureId} for $150.00 was locked with a verified signature and approved by the owner.` } }))
    const good = (await call(h.app, 'POST', '/v1/disputes/PP-D-1001/draft')).json
    expect(good.source).toBe('model')
    expect(good.text).toContain('Not available in our records')

    // Claims a $999.00 refund and a client acceptance that are not in the packet: rejected both times, the template stands.
    h.services.disputes.model = scriptedModel(() => ({ tool: 'write_response', input: { text: 'The client accepted the delivery and paid $999.00, tracking number 1Z999AA10123456784.' } }))
    const bad = (await call(h.app, 'POST', '/v1/disputes/PP-D-1001/draft')).json
    expect(bad.source).toBe('template')
    expect(bad.text).not.toContain('999')
  })

  it('catches an invented claim directly', async () => {
    const { h } = await disputed()
    const packet = h.services.disputes.buildPacket('PP-D-1001')
    const check = (text: string) => h.services.disputes.unsupportedClaim(text, packet)
    expect(check('The client accepted the delivery.')).toMatch(/acceptance/)
    expect(check('Refunded $12.34 already.')).toMatch(/amount/)
    expect(check('See https://evil.example/proof')).toMatch(/link/)
    expect(check('A passkey approved it.')).toMatch(/passkey/)
    expect(check('Capture of $150.00 was locked and signed.')).toBeNull()
    expect(check('The parcel was delivered and signed for.')).toMatch(/arrived/)
  })

  it('keeps every edit as a new row and the history append-only', async () => {
    const { h } = await disputed()
    await call(h.app, 'POST', '/v1/disputes/PP-D-1001/draft')
    expect((await call(h.app, 'PUT', '/v1/disputes/PP-D-1001/draft', { body: { text: 'My own words.' } })).status).toBe(201)
    const view = (await detail(h)).json
    expect(view.draft).toMatchObject({ kind: 'edit', text: 'My own words.', source: 'owner' })
    expect(view.history.map((row: { kind: string }) => row.kind)).toEqual(['draft', 'edit'])
    expect(() => h.db.prepare(`UPDATE dispute_responses SET text = 'x'`).run()).toThrow(/append-only/)
    expect(() => h.db.prepare(`DELETE FROM dispute_responses`).run()).toThrow(/append-only/)
    allowRawWrites(h.db)
    expect(() => h.db.prepare(`DELETE FROM dispute_responses WHERE kind = 'snapshot'`).run()).not.toThrow()
  })
})

describe('sending', () => {
  it('records the approval and the attempt before PayPal is called, sends the exact request, and shows it', async () => {
    const { h, fake, proposalId } = await disputed()
    const text = 'Our signed records follow.'
    // The attempt is already on the books when PayPal is called.
    let seenBefore: string | null = null
    const real = fake.provideEvidence.bind(fake)
    fake.provideEvidence = async (id, evidence, requestId) => {
      seenBefore = (h.db.prepare(`SELECT status FROM paypal_attempts WHERE op = 'dispute_response'`).get() as { status: string } | undefined)?.status ?? null
      return real(id, evidence, requestId)
    }
    const sent = await call(h.app, 'POST', '/v1/disputes/PP-D-1001/send', { body: { text } })
    expect(sent.status).toBe(201)
    expect(seenBefore).toBe('started')
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: '/v1/customer/disputes/PP-D-1001/provide-evidence', body: { evidences: [{ evidence_type: 'OTHER', notes: text }] } })
    expect(sent.json.sent.request).toEqual(fake.requests[0])
    expect(h.repo.attemptsFor(proposalId).find((a) => a.op === 'dispute_response')).toMatchObject({ status: 'succeeded' })
    const kinds = (await detail(h)).json.history.map((row: { kind: string }) => row.kind)
    expect(kinds).toEqual(['approval', 'sent'])
    expect((await call(h.app, 'GET', `/v1/proposals/${proposalId}/packet`)).json.events.map((e: { type: string }) => e.type)).toContain('dispute.responded')
  })

  it('does nothing the second time, and the database refuses a second sent row', async () => {
    const { h, fake } = await disputed()
    const first = await call(h.app, 'POST', '/v1/disputes/PP-D-1001/send', { body: { text: 'Once.' } })
    const second = await call(h.app, 'POST', '/v1/disputes/PP-D-1001/send', { body: { text: 'Once, again, different words.' } })
    expect(second.status).toBe(200)
    expect(second.json.replayed).toBe(true)
    expect(second.json.sent.request).toEqual(first.json.sent.request)
    expect(fake.requests).toHaveLength(1)
    expect(() => h.db.prepare(`INSERT INTO dispute_responses (id, dispute_id, seq, kind, actor, created_at) VALUES ('x', 'PP-D-1001', 99, 'sent', 'owner', 'now')`).run()).toThrow(/UNIQUE/)
    expect((await call(h.app, 'POST', '/v1/disputes/PP-D-1001/draft')).status).toBe(409)
  })

  it('uses a message while the dispute is still an inquiry', async () => {
    const { h, fake } = await disputed()
    fake.add({ id: 'PP-D-1001', stage: 'INQUIRY', transactionIds: [], status: 'WAITING_FOR_SELLER_RESPONSE', linkRels: ['self', 'send-message'], amountCents: 15000 })
    await call(h.app, 'POST', '/v1/disputes/PP-D-1001/send', { body: { text: 'Hello.' } })
    expect(fake.requests[0]).toMatchObject({ path: '/v1/customer/disputes/PP-D-1001/send-message', body: { message: 'Hello.' } })
  })

  it('refuses when PayPal offers no way to respond, and records a refusal from PayPal without a sent row', async () => {
    const { h, fake } = await disputed()
    fake.add({ id: 'PP-D-1001', status: 'RESOLVED', linkRels: ['self'], amountCents: 15000 })
    const closed = await call(h.app, 'POST', '/v1/disputes/PP-D-1001/send', { body: { text: 'Late.' } })
    expect(closed.json.code).toBe('dispute.not_open')
    fake.add({ id: 'PP-D-1001', amountCents: 15000 })
    fake.failStatus = 400
    // The read at send time also fails: nothing is sent and nothing is recorded as sent.
    const refused = await call(h.app, 'POST', '/v1/disputes/PP-D-1001/send', { body: { text: 'Hi.' } })
    expect(refused.status).toBe(502)
    expect(fake.requests).toHaveLength(0)
    expect((await detail(h)).json.sent).toBeNull()
  })

  it('records a definitive PayPal refusal as a failed attempt and may be retried', async () => {
    const { h, fake, proposalId } = await disputed()
    const real = fake.provideEvidence.bind(fake)
    let fail = true
    fake.provideEvidence = async (id, e, r) => {
      if (fail) { fake.failStatus = 422; try { return await real(id, e, r) } finally { fake.failStatus = 0 } }
      return real(id, e, r)
    }
    const refused = await call(h.app, 'POST', '/v1/disputes/PP-D-1001/send', { body: { text: 'Hi.' } })
    expect(refused.json.code).toBe('dispute.send_failed')
    expect(h.repo.attemptsFor(proposalId).find((a) => a.op === 'dispute_response')).toMatchObject({ status: 'failed' })
    fail = false
    expect((await call(h.app, 'POST', '/v1/disputes/PP-D-1001/send', { body: { text: 'Hi.' } })).status).toBe(201)
  })
})

describe('who may send', () => {
  it('refuses a send with no passkey grant when the studio requires one, and sends nothing', async () => {
    const { h, fake } = await disputed({ unpaid: true, flags: loadFlags({ REQUIRE_PASSKEY_FOR_MONEY: '1' }) })
    const refused = await call(h.app, 'POST', '/v1/disputes/PP-D-1001/send', { body: { text: 'No grant.' } })
    expect(refused.status).toBe(401)
    expect(refused.json.code).toBe('auth/stepup-required')
    const forged = await call(h.app, 'POST', '/v1/disputes/PP-D-1001/send', { body: { text: 'Fake grant.' } })
    expect(forged.status).toBe(401)
    expect(fake.requests).toHaveLength(0)
  })

  it('never lets a proposer, a client key or an agent key draft, approve or send', async () => {
    const { h, fake } = await disputed()
    const agent = (await call(h.app, 'POST', '/v1/agents', { body: { name: 'CI', scopes: ['read', 'propose', 'mcp'] } })).json.apiKey as string
    for (const key of [STUDIO_KEY, BUYER_KEY, agent]) {
      for (const [method, path, body] of [['GET', '/v1/disputes', undefined], ['GET', '/v1/disputes/PP-D-1001', undefined], ['POST', '/v1/disputes/PP-D-1001/draft', undefined], ['PUT', '/v1/disputes/PP-D-1001/draft', { text: 'x' }], ['POST', '/v1/disputes/PP-D-1001/send', { text: 'x' }]] as const) {
        const result = await call(h.app, method, path, { key, body })
        expect(result.status, `${method} ${path}`).toBe(403)
      }
    }
    expect(fake.requests).toHaveLength(0)
  })
})
