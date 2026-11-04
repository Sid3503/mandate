import { describe, expect, it } from 'vitest'
import { detectBreaks, invoiceDueAt, type BreakFacts } from '../src/domain/breaks'
import { ledgerTargets, type ProposalRow } from '../src/db/repo'

const NOW = new Date('2026-10-30T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const H = 3_600_000
const D = 24 * H

let n = 0
function row(over: Partial<ProposalRow>): ProposalRow {
  n += 1
  return {
    id: `p${n}`, warrant_id: 'w', warrant_version: 1, kind: 'charge', parent_capture_id: null, payee_id: 'client_northwind', amount_cents: 10000, currency: 'USD',
    category: 'design', description: 'x', evidence_url: null, prompt: null, gate: 'AUTO', clause: 'ok', detail: '', phase: 'captured', cart_hash: null, order_id: null, order_kind: null,
    capture_id: `cap${n}`, refund_id: null, approve_url: null, captured_amount_cents: 10000, capture_fee_cents: null, capture_net_cents: null, reserved_at: null, job_id: 'job1',
    funding_capture_id: null, payout_batch_id: null, payout_item_id: null, payout_status: null, payout_txn_id: null, payout_fee_cents: null, deal_id: null, milestone: null,
    lock_sig: null, lock_key_id: null, invoice_id: null, invoice_url: null, invoice_status: null, pay_instrument: null, settled_cents: 10000, delta_cents: null, delta_reason: null,
    delta_source: null, created_at: ago(30 * D), updated_at: ago(D), ...over,
  } as ProposalRow
}

/** Facts whose journal agrees with the rows, so only the rule under test fires. */
function facts(proposals: ProposalRow[], over: Partial<BreakFacts> = {}): BreakFacts {
  return { now: NOW, proposals, events: new Map(), journal: [], disputes: [], automation: null, ...over }
}
const rules = (f: BreakFacts) => detectBreaks(f).filter((b) => b.rule !== 'books.drift').map((b) => b.rule)
// A row the books do not know about drifts, so rules are checked with drift filtered out above.

describe('breaks: detection rules', () => {
  it('1 capture.duplicate: two paid charges, same client+amount+job within 24h, flags the later one', () => {
    const a = row({ id: 'a' }), b = row({ id: 'b' })
    const ev = new Map([['a', [{ type: 'capture.completed', created_at: ago(10 * H) }]], ['b', [{ type: 'capture.completed', created_at: ago(2 * H) }]]])
    const found = detectBreaks(facts([a, b], { events: ev })).filter((x) => x.rule === 'capture.duplicate')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ key: 'capture.duplicate:b', severity: 'critical', proposalId: 'b', deltaCents: 10000 })
  })
  it('1 is not raised outside 24h, for different jobs, for different deal milestones, or once refunded', () => {
    const far = new Map([['a', [{ type: 'capture.completed', created_at: ago(60 * H) }]], ['b', [{ type: 'capture.completed', created_at: ago(1 * H) }]]])
    expect(rules(facts([row({ id: 'a' }), row({ id: 'b' })], { events: far }))).not.toContain('capture.duplicate')
    expect(rules(facts([row({ id: 'a' }), row({ id: 'b', job_id: 'job2' })]))).not.toContain('capture.duplicate')
    expect(rules(facts([row({ id: 'a', deal_id: 'd', milestone: 0 }), row({ id: 'b', deal_id: 'd', milestone: 1 })]))).not.toContain('capture.duplicate')
    const b = row({ id: 'b', capture_id: 'capB' })
    const refund = row({ kind: 'refund', parent_capture_id: 'capB', phase: 'refunded', amount_cents: 10000, capture_id: null })
    expect(rules(facts([row({ id: 'a' }), b, refund]))).not.toContain('capture.duplicate')
  })
  it('1 stays open while the refund is only waiting for approval', () => {
    const b = row({ id: 'b', capture_id: 'capB' })
    const refund = row({ kind: 'refund', parent_capture_id: 'capB', phase: 'pending_approval', amount_cents: 10000, capture_id: null })
    expect(rules(facts([row({ id: 'a' }), b, refund]))).toContain('capture.duplicate')
  })
  it('2 capture.pending_stale after 6h only', () => {
    expect(rules(facts([row({ phase: 'capture_pending', updated_at: ago(7 * H), settled_cents: null, captured_amount_cents: null })]))).toContain('capture.pending_stale')
    expect(rules(facts([row({ phase: 'capture_pending', updated_at: ago(5 * H), settled_cents: null, captured_amount_cents: null })]))).not.toContain('capture.pending_stale')
  })
  it('3 capture.reversed is critical and says more went out than came in', () => {
    const c = row({ id: 'c', phase: 'capture_reversed', capture_id: 'capC' })
    const pay = row({ kind: 'payment', funding_capture_id: 'capC', phase: 'captured', amount_cents: 6000, captured_amount_cents: 6000, capture_id: null })
    const found = detectBreaks(facts([c, pay])).find((x) => x.rule === 'capture.reversed')!
    expect(found.severity).toBe('critical')
    expect(found.title).toContain('60.00 USD had already gone out')
    expect(found.deltaCents).toBe(-10000)
  })
  it('4 mismatch.held is critical', () => {
    const found = detectBreaks(facts([row({ phase: 'mismatch_hold', captured_amount_cents: 9000 })])).find((x) => x.rule === 'mismatch.held')!
    expect(found).toMatchObject({ severity: 'critical', deltaCents: -1000 })
  })
  it('5 refund.pending_stale after 6h', () => {
    expect(rules(facts([row({ kind: 'refund', phase: 'refund_pending', updated_at: ago(8 * H) })]))).toContain('refund.pending_stale')
    expect(rules(facts([row({ kind: 'refund', phase: 'refund_pending', updated_at: ago(1 * H) })]))).not.toContain('refund.pending_stale')
  })
  it('6 refund.exceeds when held refunds pass the capture', () => {
    const c = row({ id: 'c', capture_id: 'capC' })
    const r1 = row({ kind: 'refund', parent_capture_id: 'capC', phase: 'refunded', amount_cents: 7000, capture_id: null })
    const r2 = row({ kind: 'refund', parent_capture_id: 'capC', phase: 'refund_pending', amount_cents: 7000, capture_id: null })
    expect(rules(facts([c, r1]))).not.toContain('refund.exceeds')
    const found = detectBreaks(facts([c, r1, r2])).find((x) => x.rule === 'refund.exceeds')!
    expect(found).toMatchObject({ severity: 'critical', proposalId: 'c', deltaCents: 4000 })
  })
  it('7 payout.unclaimed_aging after 20 days', () => {
    expect(rules(facts([row({ kind: 'payment', phase: 'payout_unclaimed', updated_at: ago(21 * D) })]))).toContain('payout.unclaimed_aging')
    expect(rules(facts([row({ kind: 'payment', phase: 'payout_unclaimed', updated_at: ago(19 * D) })]))).not.toContain('payout.unclaimed_aging')
  })
  it('8 payout.returned only when a batch existed, and not once paid again', () => {
    expect(rules(facts([row({ kind: 'payment', phase: 'payout_failed', payout_batch_id: 'b1' })]))).toContain('payout.returned')
    expect(rules(facts([row({ kind: 'payment', phase: 'payout_failed', payout_batch_id: null })]))).not.toContain('payout.returned')
    const failed = row({ kind: 'payment', phase: 'payout_failed', payout_batch_id: 'b1', payee_id: 'priya', created_at: ago(5 * D) })
    const again = row({ kind: 'payment', phase: 'captured', payee_id: 'priya', created_at: ago(1 * D) })
    expect(rules(facts([failed, again]))).not.toContain('payout.returned')
  })
  it('9 invoice.overdue uses remindUnpaidAfterDays, default 14, and invoiceDueAt prefers due_date', () => {
    const r = row({ phase: 'invoice_sent', updated_at: ago(15 * D) })
    const sent = new Map([[r.id, [{ type: 'invoice.sent', created_at: ago(15 * D) }]]])
    expect(rules(facts([r], { events: sent }))).toContain('invoice.overdue')
    expect(rules(facts([r], { events: sent, automation: { remindUnpaidAfterDays: 20 } }))).not.toContain('invoice.overdue')
    expect(rules(facts([r], { events: sent, automation: { remindUnpaidAfterDays: 7 } }))).toContain('invoice.overdue')
    expect(invoiceDueAt({ ...r, due_date: '2026-12-01T00:00:00.000Z' } as ProposalRow, ago(15 * D), 14)).toBe('2026-12-01T00:00:00.000Z')
    expect(rules(facts([{ ...r, due_date: '2026-12-01T00:00:00.000Z' } as ProposalRow], { events: sent }))).not.toContain('invoice.overdue')
    expect(invoiceDueAt(r, null)).toBeNull()
  })
  it('10 invoice.stuck_draft after 1h', () => {
    expect(rules(facts([row({ phase: 'invoice_draft', updated_at: ago(2 * H) })]))).toContain('invoice.stuck_draft')
    expect(rules(facts([row({ phase: 'invoice_draft', updated_at: ago(0.5 * H) })]))).not.toContain('invoice.stuck_draft')
  })
  it('11 settlement.short_aging after 3 days', () => {
    const short = { phase: 'settled_short', settled_cents: 8000, delta_cents: -2000, updated_at: ago(4 * D) }
    expect(detectBreaks(facts([row(short)])).find((x) => x.rule === 'settlement.short_aging')).toMatchObject({ deltaCents: -2000 })
    expect(rules(facts([row({ ...short, updated_at: ago(1 * D) })]))).not.toContain('settlement.short_aging')
  })
  it('12 inflight.stalled past the lease', () => {
    expect(rules(facts([row({ phase: 'capture_inflight', updated_at: ago(10 * 60_000) })]))).toContain('inflight.stalled')
    expect(rules(facts([row({ phase: 'capture_inflight', updated_at: ago(30_000) })]))).not.toContain('inflight.stalled')
    expect(rules(facts([row({ phase: 'capture_inflight', updated_at: ago(60_000) })], { inflightMs: 30_000 }))).toContain('inflight.stalled')
  })
  it('13 books.drift when the journal disagrees with a row, none when it agrees', () => {
    const r = row({ id: 'z' })
    expect(detectBreaks(facts([r])).some((x) => x.rule === 'books.drift' && x.key === 'books.drift:z:receipt')).toBe(true)
    const entries = ledgerTargets(r).filter((t) => t.cents > 0)
    expect(entries.length).toBeGreaterThan(0)
  })
  it('13 books.drift reports a broken chain', () => {
    const journal = [{ id: 'e', seq: 1, proposal_id: 'x', purpose: 'receipt', currency: 'USD', delta_cents: 5, memo: '', prev_hash: 'bad', hash: 'bad', created_at: ago(D), postings: [{ account: 'a', amountCents: 5 }, { account: 'b', amountCents: -5 }] }]
    const found = detectBreaks(facts([], { journal })).find((x) => x.key === 'books.drift:chain')!
    expect(found.severity).toBe('critical')
  })
  it('14 dispute.open when payouts left or are held; critical when due soon; only then', () => {
    const c = row({ id: 'c', capture_id: 'capC' })
    const pay = row({ kind: 'payment', funding_capture_id: 'capC', phase: 'payout_sent', capture_id: null })
    const dispute = (openedAgo: number, status = 'WAITING_FOR_SELLER_RESPONSE') => ({ disputeId: 'D1', transactionId: 'capC', status, reason: 'x', amountCents: 10000, currency: 'USD', openedAt: ago(openedAgo), updatedAt: ago(openedAgo) })
    expect(detectBreaks(facts([c, pay], { disputes: [dispute(1 * D)] })).find((x) => x.rule === 'dispute.open')).toMatchObject({ severity: 'warning', key: 'dispute.open:D1' })
    expect(detectBreaks(facts([c, pay], { disputes: [dispute(8 * D)] })).find((x) => x.rule === 'dispute.open')!.severity).toBe('critical')
    expect(rules(facts([c], { disputes: [dispute(8 * D)] }))).not.toContain('dispute.open')
    expect(rules(facts([c, pay], { disputes: [dispute(8 * D, 'RESOLVED')] }))).not.toContain('dispute.open')
  })
  it('15 paypal.unknown_or_differs from the activity, only when given', () => {
    const txn = { id: 'T1', date: '', cents: 5000, currency: 'USD', status: 'S', eventCode: null, subject: null, counterparty: null, referenceId: null, invoiceId: null, customId: null }
    const activity = { rows: [{ ...txn, proposalId: null, matchedBy: null, expectedCents: null, expectedCurrency: null, deltaCents: null, balanced: null }, { ...txn, id: 'T2', cents: 9000, proposalId: 'q', matchedBy: 'id' as const, expectedCents: 10000, expectedCurrency: 'USD', deltaCents: -1000, balanced: false }], matched: 1, unmatched: 1, unmatchedNetCents: 5000, mismatched: 1, mismatchedNetCents: -1000 }
    expect(rules(facts([]))).not.toContain('paypal.unknown_or_differs')
    const found = detectBreaks(facts([], { activity })).filter((x) => x.rule === 'paypal.unknown_or_differs')
    expect(found.map((x) => x.key).sort()).toEqual(['paypal.unknown_or_differs:T1', 'paypal.unknown_or_differs:q'])
    expect(found.find((x) => x.proposalId === 'q')).toMatchObject({ severity: 'critical', deltaCents: -1000 })
  })
  it('16 dispute.response_overdue past the assumed tenth day, with no payouts needed', () => {
    const dispute = (openedAgo: number, status = 'WAITING_FOR_SELLER_RESPONSE') => ({ disputeId: 'D1', transactionId: 'capC', status, reason: 'x', amountCents: 7500, currency: 'USD', openedAt: ago(openedAgo), updatedAt: ago(openedAgo) })
    expect(rules(facts([row({ id: 'c', capture_id: 'capC' })], { disputes: [dispute(9 * D)] }))).not.toContain('dispute.response_overdue')
    const found = detectBreaks(facts([row({ id: 'c', capture_id: 'capC' })], { disputes: [dispute(12 * D)] })).find((x) => x.rule === 'dispute.response_overdue')!
    expect(found).toMatchObject({ key: 'dispute.response_overdue:D1', severity: 'critical', proposalId: 'c', deltaCents: -7500 })
    expect(found.detail).toContain('dispute desk')
    expect(rules(facts([row({ id: 'c', capture_id: 'capC' })], { disputes: [dispute(12 * D, 'RESOLVED')] }))).not.toContain('dispute.response_overdue')
  })
  it('17 refund.awaiting_owner after a week, only for a refund ask still waiting for the tap', () => {
    expect(rules(facts([row({ kind: 'refund', phase: 'pending_approval', updated_at: ago(6 * D), created_at: ago(8 * D), capture_id: null, settled_cents: null, captured_amount_cents: null })]))).not.toContain('refund.awaiting_owner')
    const found = detectBreaks(facts([row({ kind: 'refund', phase: 'pending_approval', updated_at: ago(9 * D), created_at: ago(9 * D), capture_id: null, settled_cents: null, captured_amount_cents: null })])).find((x) => x.rule === 'refund.awaiting_owner')!
    expect(found).toMatchObject({ key: expect.stringMatching(/^refund\.awaiting_owner:/), severity: 'warning' })
    expect(found.title).toContain('refund')
    expect(rules(facts([row({ kind: 'refund', phase: 'refunded', updated_at: ago(9 * D), capture_id: null, settled_cents: null, captured_amount_cents: null })]))).not.toContain('refund.awaiting_owner')
  })
  it('18 invoice.partial_unresolved after ten days, only for a gap PayPal does not explain', () => {
    const partial = { phase: 'settled_short', settled_cents: 8000, delta_cents: -2000, delta_reason: 'partial' as const }
    expect(rules(facts([row({ ...partial, updated_at: ago(5 * D) })]))).not.toContain('invoice.partial_unresolved')
    const found = detectBreaks(facts([row({ ...partial, updated_at: ago(11 * D) })])).find((x) => x.rule === 'invoice.partial_unresolved')!
    expect(found).toMatchObject({ severity: 'warning', deltaCents: 2000 })
    expect(found.title).toContain('part paid')
    // A shortfall with a reason PayPal stated (a discount, a fee) is attributed, so it is not this one.
    expect(rules(facts([row({ ...partial, delta_reason: 'early_discount' as const, updated_at: ago(11 * D) })]))).not.toContain('invoice.partial_unresolved')
  })
  it('19 fees.anomaly above the plan share plus a fixed allowance, only on big-enough payments', () => {
    const fee = (settled: number, feeCents: number) => ({ captured_amount_cents: settled, settled_cents: settled, capture_fee_cents: feeCents })
    // A plan fee, 2.9% + 30 cents, is never called an anomaly.
    expect(rules(facts([row(fee(15000, 465))]))).not.toContain('fees.anomaly')
    // A small payment where the fixed part dominates is never judged, and fees on too-small payments are never judged at all.
    expect(rules(facts([row(fee(1200, 65))]))).not.toContain('fees.anomaly')
    expect(rules(facts([row(fee(800, 400))]))).not.toContain('fees.anomaly')
    const found = detectBreaks(facts([row(fee(10000, 800))])).find((x) => x.rule === 'fees.anomaly')!
    expect(found).toMatchObject({ severity: 'warning', deltaCents: 340 }) // 800 against a 460 ceiling.
    expect(found.title).toContain('8.00%')
    // At the ceiling exactly: not an anomaly.
    expect(rules(facts([row(fee(10000, 460))]))).not.toContain('fees.anomaly')
  })
  it('20 refund.not_made when a reversed capture has no refund PayPal was asked for', () => {
    const charge = row({ id: 'c', phase: 'capture_reversed', capture_id: 'capC' })
    expect(rules(facts([charge]))).toContain('refund.not_made')
    const waiting = row({ kind: 'refund', parent_capture_id: 'capC', phase: 'pending_approval', amount_cents: 10000, capture_id: null, settled_cents: null, captured_amount_cents: null })
    expect(rules(facts([charge, waiting]))).toContain('refund.not_made')
    const sent = row({ kind: 'refund', parent_capture_id: 'capC', phase: 'refunded', amount_cents: 10000, capture_id: null, settled_cents: null, captured_amount_cents: null })
    expect(rules(facts([charge, sent]))).not.toContain('refund.not_made')
    const partial = row({ kind: 'refund', parent_capture_id: 'capC', phase: 'refunded', amount_cents: 4000, capture_id: null, settled_cents: null, captured_amount_cents: null })
    const found = detectBreaks(facts([charge, partial])).find((item) => item.rule === 'refund.not_made')!
    expect(found).toMatchObject({ severity: 'critical', proposalId: 'c', deltaCents: -6000 })
  })
  it('21 tracking.unproven on an open dispute whose proof is not a carrier link, and not once it is', () => {
    const dispute = { disputeId: 'D1', transactionId: 'capC', status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'x', amountCents: 10000, currency: 'USD', openedAt: ago(D), updatedAt: ago(D) }
    const plain = row({ id: 'c', capture_id: 'capC', evidence_url: 'https://www.figma.com/file/northwind-logo' })
    const found = detectBreaks(facts([plain], { disputes: [dispute] })).find((item) => item.rule === 'tracking.unproven')!
    expect(found).toMatchObject({ key: 'tracking.unproven:D1', severity: 'info', deltaCents: null })
    const tracked = row({ id: 'c', capture_id: 'capC', evidence_url: 'https://www.ups.com/track?tracknum=1Z999AA10123456784' })
    expect(rules(facts([tracked], { disputes: [dispute] }))).not.toContain('tracking.unproven')
    expect(rules(facts([plain], { disputes: [{ ...dispute, status: 'RESOLVED' }] }))).not.toContain('tracking.unproven')
  })
  it('keys are stable between runs', () => {
    const f = facts([row({ id: 'k', phase: 'mismatch_hold' })])
    expect(detectBreaks(f).map((x) => x.key)).toEqual(detectBreaks(f).map((x) => x.key))
  })
})
