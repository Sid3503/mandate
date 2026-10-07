import { afterEach, describe, expect, it } from 'vitest'
import { toLedgerRows } from '../../web/src/control-room/rows'
import { summarise } from '../../web/src/control-room/totals'
import type { Proposal } from '../../web/src/lib/types'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, STUDIO_KEY } from './support'

afterEach(closeAll)

const NOW = new Date('2026-10-09T12:00:00Z')
const base = { id: 'p', kind: 'payment', gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval', detail: '', phase: 'pending_approval', payeeId: 'payee_priya', amountCents: 9000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: null, prompt: null, parentCaptureId: null, jobId: 'job_1', fundingCaptureId: null, capturedAmountCents: null, orderId: null, captureId: null, createdAt: '2026-10-07T12:00:00Z' }
const row = (over: Partial<Proposal>): Proposal => ({ ...base, ...over }) as unknown as Proposal
const names = (id: string | null) => (id === 'payee_priya' ? 'Priya Shah' : id === 'client_northwind' ? 'Northwind' : 'Unknown')

describe('the ledger, as rows for AG Studio', () => {
  it('counts only what PayPal confirmed as money in and out, and keeps the difference', () => {
    const rows = toLedgerRows([
      row({ id: 'in', kind: 'charge', payeeId: 'client_northwind', amountCents: 15000, phase: 'captured', capturedAmountCents: 15000, captureId: 'CAP1' }),
      row({ id: 'out', kind: 'payment', phase: 'captured', capturedAmountCents: 9000, gate: 'AUTO', clause: 'standing.matched' }),
      row({ id: 'asked', kind: 'payment', phase: 'pending_approval', amountCents: 9000 }),
    ], names, NOW)
    const by = Object.fromEntries(rows.map((item) => [item.id, item]))
    expect(by.in).toMatchObject({ direction: 'in', moneyIn: 150, moneyOut: 0, kept: 150, who: 'Northwind', captureId: 'CAP1' })
    expect(by.out).toMatchObject({ direction: 'out', moneyIn: 0, moneyOut: 90, kept: -90, how: 'standing rule', decision: 'AUTO', reason: 'standing.matched' })
    // Asked for and waiting is not money out.
    expect(by.asked).toMatchObject({ moneyOut: 0, amount: 90, how: 'owner tap', status: expect.any(String) })
    expect(summarise(rows).total).toMatchObject({ moneyIn: 150, moneyOut: 90 })
  })

  it('marks a refusal as refused money, and an open invoice as what is still owed, with how long', () => {
    const rows = toLedgerRows([
      row({ id: 'no', gate: 'DENY', clause: 'funding.missing', phase: 'denied', amountCents: 2500 }),
      row({ id: 'inv', kind: 'charge', payeeId: 'client_northwind', amountCents: 15000, phase: 'invoice_sent', createdAt: '2026-10-07T00:00:00Z' }),
      row({ id: 'ref', kind: 'refund', phase: 'refunded', amountCents: 1000, parentCaptureId: 'CAP1' }),
    ], names, NOW)
    const by = Object.fromEntries(rows.map((item) => [item.id, item]))
    expect(by.no).toMatchObject({ decision: 'DENY', refused: 25, status: 'Refused', how: 'refused by a rule', moneyOut: 0 })
    expect(by.inv).toMatchObject({ owed: 150, daysOut: 2, moneyIn: 0 })
    expect(by.ref).toMatchObject({ direction: 'out', moneyOut: 10 })
  })

  it('agrees with the money the ledger itself reports for a real job: $150 in, $90 out, $60 kept', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    const sent = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { kind: 'payment', payee: 'Priya', amountCents: 9000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: paid.captureId } })
    await call(h.app, 'POST', `/v1/proposals/${sent.json.id}/approve`)
    await call(h.app, 'POST', `/v1/proposals/${sent.json.id}/capture`)
    await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { kind: 'payment', payee: 'Priya', amountCents: 1800, currency: 'USD', category: 'lunch', description: 'lunch', evidenceUrl: EVIDENCE, jobId: JOB } })
    const list = (await call(h.app, 'GET', '/v1/proposals?limit=100')).json.data as Proposal[]
    const job = (await call(h.app, 'GET', `/v1/jobs/${JOB}`)).json
    const totals = summarise(toLedgerRows(list, (id) => id ?? 'none', NOW), {})
    expect(totals.total.moneyIn).toBe(job.totals.inCents / 100)
    expect(totals.total.moneyOut).toBe(job.totals.outCents / 100)
    expect(totals.total.moneyIn - totals.total.moneyOut).toBe(job.totals.keptCents / 100)
    expect(summarise(toLedgerRows(list, (id) => id ?? 'none', NOW), { decision: 'DENY', group_by: 'reason' }).groups).toEqual([expect.objectContaining({ group: 'category.missing', requests: 1, refused: 18 })])
  })
})

describe('the totals the dashboard analyst reads', () => {
  const rows = toLedgerRows([
    row({ id: 'a', gate: 'DENY', clause: 'funding.missing', amountCents: 10 }),
    row({ id: 'b', gate: 'DENY', clause: 'funding.missing', amountCents: 20 }),
    row({ id: 'c', gate: 'DENY', clause: 'payee.unknown', amountCents: 48000 }),
    row({ id: 'd', kind: 'charge', payeeId: 'client_northwind', phase: 'captured', capturedAmountCents: 15000, amountCents: 15000 }),
  ], names, NOW)

  it('adds in cents, so 10 cents and 20 cents make 30 cents exactly', () => {
    const refused = summarise(rows, { decision: 'DENY', group_by: 'reason' })
    expect(refused.total).toMatchObject({ requests: 3, refused: 480.3 })
    expect(refused.groups.map((g) => [g.group, g.requests, g.refused])).toEqual([['funding.missing', 2, 0.3], ['payee.unknown', 1, 480]])
  })

  it('filters by direction and leaves everything else alone', () => {
    expect(summarise(rows, { direction: 'in' }).total).toMatchObject({ requests: 1, moneyIn: 150 })
    expect(summarise(rows).groups).toEqual([])
    expect(summarise([], { group_by: 'how' })).toEqual({ total: expect.objectContaining({ requests: 0 }), groups: [] })
  })
})
