import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices } from '../src/paypal/fake'
import { parseKeys, verifyReceipt, type Receipt } from '../../web/src/lib/verify'
import { agree, BUYER_KEY, call, closeAll, collect, EVIDENCE, harness, idem, JOB, STUDIO_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]

/** What a person downloads from a receipt, and the keys anyone can fetch. The browser verifier gets nothing else. */
async function receiptAndKeys(app: App, id: string): Promise<{ receipt: Receipt; keys: ReturnType<typeof parseKeys> }> {
  const receipt = (await call(app, 'GET', `/v1/proposals/${id}/packet`)).json as Receipt
  const keys = parseKeys((await call(app, 'GET', '/.well-known/mandate-keys.json')).json)
  return { receipt, keys }
}

describe('the receipt verifier in the browser agrees with the server', () => {
  it('verifies a job receipt, a payout receipt and a plain v1 receipt, whichever cart format they use', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const charge = await collect(h.app, deal.id, 0)
    const payout = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: charge.captureId } })
    await call(h.app, 'POST', `/v1/proposals/${payout.json.id}/approve`)
    await call(h.app, 'POST', `/v1/proposals/${payout.json.id}/capture`)
    // v1: a payment with no job and no funding, under rules that do not demand funding.
    const current = (await call(h.app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    await call(h.app, 'PUT', '/v1/warrant', { body: { ...body, fundingRequired: false } })
    const small = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: { payee: 'Priya', amountCents: 1_500, currency: 'USD', category: 'design', description: 'small', evidenceUrl: EVIDENCE } })
    for (const [name, id, version] of [['charge on a deal (v3)', charge.proposalId, 3], ['payout (v2)', payout.json.id, 2], ['plain payment (v1)', small.json.id, 1]] as const) {
      const { receipt, keys } = await receiptAndKeys(h.app, id)
      const verdict = await verifyReceipt(receipt, keys)
      expect(verdict.ok, name).toBe(true)
      expect(verdict.recomputed, name).toBe(receipt.lock!.hash)
      expect(JSON.parse(JSON.stringify(verdict.checks.map((c) => c.id))), name).toEqual(['hash', 'lock'])
      void version
    }
  })

  it('catches every kind of tampering a person could try with the file they hold', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const charge = await collect(h.app, deal.id, 0)
    const { receipt, keys } = await receiptAndKeys(h.app, charge.proposalId)
    const change = (patch: Record<string, unknown>): Receipt => ({ ...receipt, proposal: { ...receipt.proposal!, ...patch } })
    const failing = async (r: Receipt, k = keys) => (await verifyReceipt(r, k)).checks.filter((c) => !c.ok).map((c) => c.id)

    expect(await failing(change({ amountCents: 90_000 }))).toEqual(['hash'])
    expect(await failing(change({ payeeId: 'payee_mallory' }))).toContain('hash')
    expect(await failing(change({ evidenceUrl: 'https://evil.example/x' }))).toContain('hash')
    expect(await failing(change({ milestone: 1 }))).toContain('hash')
    // Swap in a different hash and recompute nothing: the signature no longer covers it.
    const fake = { ...receipt, lock: { ...receipt.lock!, hash: 'a'.repeat(64) } }
    expect(await failing(fake)).toEqual(expect.arrayContaining(['hash', 'lock']))
    // Signed by nobody we know, and signed with a key that is not the one named.
    expect(await failing(receipt, [])).toEqual(['lock'])
    const flipped = receipt.lock!.signature!.slice(0, -2) + (receipt.lock!.signature!.endsWith('AA') ? 'BB' : 'AA')
    expect(await failing({ ...receipt, lock: { ...receipt.lock!, signature: flipped } })).toEqual(['lock'])
    expect(await failing({ ...receipt, lock: { ...receipt.lock!, signature: null } })).toEqual(['lock'])
  })

  it('verifies the client\'s signed acceptance together with the lock, and catches a swapped proof link', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const deal = await agree(h.app)
    const current = (await call(h.app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    await call(h.app, 'PUT', '/v1/warrant', { body: { ...body, automation: { billSignedDeals: true, requireAcceptance: true, payOnSettle: false, remindUnpaidAfterDays: null, maxReminders: 2 } } })
    await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/deliver`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    const accepted = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/decision`, { key: BUYER_KEY, body: { decision: 'accepted', note: 'ok' } })
    const { receipt, keys } = await receiptAndKeys(h.app, accepted.json.charge.id)
    expect(receipt.acceptance).toMatchObject({ status: 'accepted', proofUrl: EVIDENCE })
    const good = await verifyReceipt(receipt, keys)
    expect(good.ok).toBe(true)
    expect(good.checks.map((c) => c.id)).toEqual(['hash', 'lock', 'acceptance'])
    const swapped = await verifyReceipt({ ...receipt, acceptance: { ...receipt.acceptance!, proofUrl: 'https://evil.example/other' } }, keys)
    expect(swapped.checks.find((c) => c.id === 'acceptance')!.ok).toBe(false)
    const flippedDecision = await verifyReceipt({ ...receipt, acceptance: { ...receipt.acceptance!, status: 'rejected' } }, keys)
    expect(flippedDecision.checks.find((c) => c.id === 'acceptance')!.ok).toBe(false)
  })

  it('says plainly when the file is not a receipt, or was never locked', async () => {
    const h = harness()
    expect((await verifyReceipt({}, [])).ok).toBe(false)
    const denied = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: { payee: 'P. Shah', amountCents: 48_000, currency: 'USD', category: 'design', description: 'x', evidenceUrl: EVIDENCE } })
    const { receipt, keys } = await receiptAndKeys(h.app, denied.json.id)
    const verdict = await verifyReceipt(receipt, keys)
    expect(verdict.ok).toBe(false)
    expect(verdict.checks[0]!.detail).toContain('never locked')
  })
})
