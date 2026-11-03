import { afterEach, describe, expect, it } from 'vitest'
import { GENESIS_HASH } from '../src/db/repo'
import { allowRawWrites, BUYER_KEY, call, closeAll, harness, idem, JOB, EVIDENCE, STUDIO_KEY } from './support'

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

/** A client charge paid through the fake PayPal, then Priya paid out of it. The books then hold four entries. */
async function fullFlow(h: H): Promise<{ chargeId: string; payoutId: string }> {
  const created = await call(h.app, 'POST', '/v1/proposals', { idem: idem('c'), body: charge })
  await call(h.app, 'POST', `/v1/proposals/${created.json.id}/approve`)
  const captured = await call(h.app, 'POST', `/v1/proposals/${created.json.id}/capture`)
  const payout = await call(h.app, 'POST', '/v1/proposals', { idem: idem('p'), body: { ...priya, fundingCaptureId: captured.json.captureId } })
  await call(h.app, 'POST', `/v1/proposals/${payout.json.id}/approve`)
  await call(h.app, 'POST', `/v1/proposals/${payout.json.id}/capture`)
  return { chargeId: created.json.id, payoutId: payout.json.id }
}

describe('GET /v1/books', () => {
  it('starts empty, with the chain at genesis and verified', async () => {
    const h = harness()
    const res = await call(h.app, 'GET', '/v1/books')
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ balances: [], totals: [], chain: { entries: 0, head: GENESIS_HASH, verified: true, brokenAt: null } })
  })

  it('sums a full flow into totals that agree with what PayPal moved', async () => {
    const h = harness()
    const { chargeId, payoutId } = await fullFlow(h)
    const captureFee = h.repo.proposal(chargeId)!.capture_fee_cents ?? 0
    const payoutFee = h.repo.proposal(payoutId)!.payout_fee_cents ?? 0
    const res = await call(h.app, 'GET', '/v1/books')
    expect(res.status).toBe(200)
    expect(res.json.totals).toEqual([{ currency: 'USD', cashCents: 15000 - captureFee - 9000 - payoutFee, inCents: 15000, outCents: 9000, feesCents: captureFee + payoutFee, refundsCents: 0, reversalsCents: 0 }])
    // Every balance together is zero: the books balance.
    expect(res.json.balances.reduce((sum: number, row: { cents: number }) => sum + row.cents, 0)).toBe(0)
    expect(res.json.balances).toContainEqual({ account: 'expense:payouts:payee_priya', currency: 'USD', cents: 9000 })
    const journal = h.repo.allJournal()
    expect(res.json.chain).toEqual({ entries: journal.length, head: journal[journal.length - 1]!.hash, verified: true, brokenAt: null })
  })

  it('names the entry where someone with the file in hand changed the books', async () => {
    const h = harness()
    await fullFlow(h)
    allowRawWrites(h.db)
    h.db.prepare(`UPDATE journal_entries SET memo = 'nothing to see' WHERE seq = 2`).run()
    const res = await call(h.app, 'GET', '/v1/books')
    expect(res.json.chain.verified).toBe(false)
    expect(res.json.chain.brokenAt).toBe(2)
  })

  it('is owner only: the owner key reads it, a proposer and a client agent do not', async () => {
    const h = harness()
    expect((await call(h.app, 'GET', '/v1/books')).status).toBe(200)
    expect((await call(h.app, 'GET', '/v1/books', { key: STUDIO_KEY })).status).toBe(403)
    expect((await call(h.app, 'GET', '/v1/books', { key: BUYER_KEY })).status).toBe(403)
    expect((await call(h.app, 'GET', '/v1/books', { key: 'not-a-key-at-all-000000' })).status).toBe(401)
  })
})

describe('GET /v1/books/journal', () => {
  it('pages newest first by seq, with postings that balance', async () => {
    const h = harness()
    await fullFlow(h)
    const total = h.repo.allJournal().length
    expect(total).toBeGreaterThanOrEqual(3)
    const first = await call(h.app, 'GET', '/v1/books/journal?limit=2')
    expect(first.status).toBe(200)
    expect(first.json.data.map((entry: { seq: number }) => entry.seq)).toEqual([total, total - 1])
    expect(first.json.nextCursor).toBe(String(total - 1))
    for (const entry of first.json.data) expect(entry.postings.reduce((sum: number, leg: { amountCents: number }) => sum + leg.amountCents, 0)).toBe(0)
    const seen: number[] = first.json.data.map((entry: { seq: number }) => entry.seq)
    let cursor = first.json.nextCursor as string | null
    while (cursor) {
      const page = await call(h.app, 'GET', `/v1/books/journal?limit=2&cursor=${cursor}`)
      seen.push(...page.json.data.map((entry: { seq: number }) => entry.seq))
      cursor = page.json.nextCursor
    }
    expect(seen).toEqual(Array.from({ length: total }, (_, index) => total - index))
  })

  it('returns one request\'s entries, oldest first, with what the request was', async () => {
    const h = harness()
    const { chargeId, payoutId } = await fullFlow(h)
    const res = await call(h.app, 'GET', `/v1/books/journal?proposalId=${payoutId}`)
    expect(res.status).toBe(200)
    expect(res.json.nextCursor).toBeNull()
    expect(res.json.data.length).toBeGreaterThan(0)
    expect(res.json.data.every((entry: { proposalId: string }) => entry.proposalId === payoutId)).toBe(true)
    expect(res.json.data[0]).toMatchObject({ purpose: 'payout', kind: 'payment', payeeId: 'payee_priya', deltaCents: 9000 })
    const seqs = res.json.data.map((entry: { seq: number }) => entry.seq)
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => a - b))
    const chargeEntries = await call(h.app, 'GET', `/v1/books/journal?proposalId=${chargeId}`)
    expect(chargeEntries.json.data.map((entry: { purpose: string }) => entry.purpose)).toContain('receipt')
  })

  it('refuses a cursor that is not a journal position', async () => {
    const h = harness()
    const res = await call(h.app, 'GET', '/v1/books/journal?cursor=abc')
    expect(res.status).toBe(400)
    expect(res.json.code).toBe('books.cursor')
  })

  it('is in the OpenAPI document', async () => {
    const h = harness()
    const spec = await (await h.app.request('http://mandate.test/openapi.json')).json()
    expect(spec.paths['/v1/books']).toBeTruthy()
    expect(spec.paths['/v1/books/journal']).toBeTruthy()
  })
})
