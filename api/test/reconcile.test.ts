import { describe, expect, it } from 'vitest'
import { expectedSignedCents } from '../src/domain/phases'
import { reconcile, type LedgerMoney } from '../src/domain/reconcile'
import type { LiveTransaction } from '../src/paypal/watch'

/** One line of PayPal's transaction report. Only the fields a match can read are ever interesting here. */
const txn = (id: string, cents: number, extra: Partial<LiveTransaction> = {}): LiveTransaction => ({
  id,
  date: '2026-10-03T10:00:00+0000',
  cents,
  currency: 'USD',
  status: 'S',
  eventCode: 'T0006',
  subject: null,
  counterparty: null,
  referenceId: null,
  invoiceId: null,
  customId: null,
  ...extra,
})

/** The ledger's view of one request, reachable by its own id and by every PayPal id Mandate stored on it. */
const ledger = (entry: LedgerMoney, ...ids: string[]): Map<string, LedgerMoney> => {
  const map = new Map<string, LedgerMoney>()
  map.set(entry.proposalId, entry)
  for (const id of ids) map.set(id, entry)
  return map
}

describe('what the ledger says a request is worth', () => {
  const row = (kind: string, overrides: Partial<{ amount_cents: number; captured_amount_cents: number | null; settled_cents: number | null }> = {}) => ({
    kind,
    amount_cents: 15_000,
    captured_amount_cents: null,
    settled_cents: null,
    ...overrides,
  })

  it('signs a client charge in and a payout or a refund out', () => {
    expect(expectedSignedCents(row('charge'))).toBe(15_000)
    expect(expectedSignedCents(row('payment'))).toBe(-15_000)
    expect(expectedSignedCents(row('refund'))).toBe(-15_000)
  })

  it('compares a short settlement against what arrived, not against the lock it never met', () => {
    expect(expectedSignedCents(row('charge', { settled_cents: 14_250 }))).toBe(14_250)
  })

  it('falls back to the lock while the money is still in flight', () => {
    expect(expectedSignedCents(row('payment', { captured_amount_cents: null }))).toBe(-15_000)
    expect(expectedSignedCents(row('payment', { captured_amount_cents: 9_000 }))).toBe(-9_000)
  })
})

describe('lining PayPal up against the ledger', () => {
  it('matches a charge by id and says the money agrees', () => {
    const result = reconcile([txn('CAP-1', 15_000)], ledger({ proposalId: 'p1', cents: 15_000, currency: 'USD' }, 'CAP-1'))
    expect(result).toMatchObject({ matched: 1, unmatched: 0, mismatched: 0, mismatchedNetCents: 0 })
    expect(result.rows[0]).toMatchObject({ proposalId: 'p1', matchedBy: 'id', expectedCents: 15_000, expectedCurrency: 'USD', deltaCents: 0, balanced: true })
  })

  it('surfaces a matched row whose cents do not agree, with the difference', () => {
    const result = reconcile([txn('CAP-1', 14_500)], ledger({ proposalId: 'p1', cents: 15_000, currency: 'USD' }, 'CAP-1'))
    expect(result).toMatchObject({ matched: 1, mismatched: 1, mismatchedNetCents: -500 })
    expect(result.rows[0]).toMatchObject({ deltaCents: -500, balanced: false })
  })

  it('surfaces a currency disagreement even when the cents are equal', () => {
    const result = reconcile([txn('CAP-1', 15_000, { currency: 'EUR' })], ledger({ proposalId: 'p1', cents: 15_000, currency: 'USD' }, 'CAP-1'))
    // The cents are the same, so the net figure is zero; the request is still counted as wrong.
    expect(result).toMatchObject({ matched: 1, mismatched: 1, mismatchedNetCents: 0 })
    expect(result.rows[0]).toMatchObject({ expectedCurrency: 'USD', deltaCents: 0, balanced: false })
  })

  it('checks a payout, which is money out', () => {
    const agrees = reconcile([txn('PAY-1', -9_000)], ledger({ proposalId: 'p1', cents: -9_000, currency: 'USD' }, 'PAY-1'))
    expect(agrees.rows[0]).toMatchObject({ deltaCents: 0, balanced: true })
    const wrong = reconcile([txn('PAY-1', -8_500)], ledger({ proposalId: 'p1', cents: -9_000, currency: 'USD' }, 'PAY-1'))
    expect(wrong.rows[0]).toMatchObject({ deltaCents: 500, balanced: false })
    expect(wrong.mismatchedNetCents).toBe(500)
  })

  it('matches by reference, by custom field and by invoice', () => {
    const money = { proposalId: 'p1', cents: 15_000, currency: 'USD' }
    const byRef = reconcile([txn('X-1', 15_000, { referenceId: 'p1' })], ledger(money, 'CAP-1'))
    expect(byRef.rows[0]).toMatchObject({ proposalId: 'p1', matchedBy: 'reference', balanced: true })
    const byCustom = reconcile([txn('X-2', 15_000, { customId: 'p1' })], ledger(money, 'CAP-1'))
    expect(byCustom.rows[0]).toMatchObject({ proposalId: 'p1', matchedBy: 'custom', balanced: true })
    const byInvoice = reconcile([txn('X-3', 15_000, { invoiceId: 'INV-1' })], ledger(money, 'INV-1'))
    expect(byInvoice.rows[0]).toMatchObject({ proposalId: 'p1', matchedBy: 'invoice', balanced: true })
  })

  it('falls back to the invoice resolver, and still checks the money', () => {
    const result = reconcile([txn('X-3', 14_000, { invoiceId: 'INV-9' })], ledger({ proposalId: 'p1', cents: 15_000, currency: 'USD' }, 'INV-1'), (ref) => (ref === 'INV-9' ? 'p1' : null))
    expect(result.rows[0]).toMatchObject({ proposalId: 'p1', matchedBy: 'invoice', deltaCents: -1_000, balanced: false })
    expect(result.mismatched).toBe(1)
  })

  it('compares an invoice paid in parts as a total, and flags neither part', () => {
    const result = reconcile(
      [txn('T-1', 7_500, { invoiceId: 'INV-1' }), txn('T-2', 7_500, { invoiceId: 'INV-1' })],
      ledger({ proposalId: 'p1', cents: 15_000, currency: 'USD' }, 'INV-1'),
    )
    expect(result).toMatchObject({ matched: 2, mismatched: 0, mismatchedNetCents: 0 })
    // A part is not a disagreement with the whole, so neither row claims a delta of its own.
    expect(result.rows.map((row) => row.deltaCents)).toEqual([null, null])
    expect(result.rows.every((row) => row.balanced === true && row.expectedCents === 15_000)).toBe(true)
  })

  it('flags a part-paid invoice whose parts still do not add up', () => {
    const result = reconcile(
      [txn('T-1', 7_500, { invoiceId: 'INV-1' }), txn('T-2', 7_000, { invoiceId: 'INV-1' })],
      ledger({ proposalId: 'p1', cents: 15_000, currency: 'USD' }, 'INV-1'),
    )
    expect(result).toMatchObject({ matched: 2, mismatched: 1, mismatchedNetCents: -500 })
    expect(result.rows.every((row) => row.balanced === false && row.deltaCents === null)).toBe(true)
  })

  it('flags a split request whose currencies disagree with the ledger', () => {
    const result = reconcile(
      [txn('T-1', 7_500, { invoiceId: 'INV-1' }), txn('T-2', 7_500, { invoiceId: 'INV-1', currency: 'EUR' })],
      ledger({ proposalId: 'p1', cents: 15_000, currency: 'USD' }, 'INV-1'),
    )
    expect(result).toMatchObject({ matched: 2, mismatched: 1, mismatchedNetCents: 0 })
  })

  it('leaves a row that matches nothing with no expected money and no verdict', () => {
    const result = reconcile([txn('EXTERNAL-1', -4_800, { subject: 'Font licence' })], new Map())
    expect(result).toMatchObject({ matched: 0, unmatched: 1, unmatchedNetCents: -4_800, mismatched: 0 })
    expect(result.rows[0]).toMatchObject({ proposalId: null, matchedBy: null, expectedCents: null, expectedCurrency: null, deltaCents: null, balanced: null })
  })

  it('does not count an unmatched row as a money disagreement', () => {
    const result = reconcile([txn('EXTERNAL-1', -4_800)], ledger({ proposalId: 'p1', cents: 15_000, currency: 'USD' }, 'CAP-1'))
    expect(result).toMatchObject({ matched: 0, unmatched: 1, mismatched: 0, mismatchedNetCents: 0 })
  })

  it('compares nothing when the ledger holds no money for the matched id', () => {
    // Only reachable if an id is known without its proposal's own key, which knownPayPalIds never does; pinned so
    // the row says "not compared" rather than inventing a verdict.
    const orphan = new Map<string, LedgerMoney>([['CAP-1', { proposalId: 'p1', cents: 15_000, currency: 'USD' }]])
    const result = reconcile([txn('CAP-1', 15_000)], orphan)
    expect(result).toMatchObject({ matched: 1, mismatched: 0 })
    expect(result.rows[0]).toMatchObject({ proposalId: 'p1', expectedCents: null, deltaCents: null, balanced: null })
  })

  it('keeps the two kinds of gap apart: unmatched money is not a mismatch', () => {
    const result = reconcile(
      [txn('CAP-1', 14_500), txn('EXTERNAL-1', -4_800)],
      ledger({ proposalId: 'p1', cents: 15_000, currency: 'USD' }, 'CAP-1'),
    )
    expect(result).toMatchObject({ matched: 1, unmatched: 1, unmatchedNetCents: -4_800, mismatched: 1, mismatchedNetCents: -500 })
  })
})
