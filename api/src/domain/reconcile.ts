import type { LiveTransaction } from '../paypal/watch'

/**
 * What the ledger holds for one request, carried beside every id that can match it, so a transaction can never be
 * matched without the amount it should show also being in hand. `cents` is signed the way PayPal's own transaction
 * report signs money: money in is positive, money out is negative.
 */
export type LedgerMoney = {
  proposalId: string
  cents: number
  currency: string
}

export type ActivityRow = LiveTransaction & {
  /** The Mandate request this PayPal transaction belongs to, or null if Mandate has no record of it. */
  proposalId: string | null
  matchedBy: 'id' | 'reference' | 'invoice' | 'custom' | null
  /** Signed cents the ledger holds for the matched request, or null when nothing matched or nothing is recorded. */
  expectedCents: number | null
  /** Currency the ledger holds for the matched request, or null. */
  expectedCurrency: string | null
  /**
   * This row's cents minus `expectedCents`. Null when unmatched, and null when the request is split across several
   * transactions, because one part of a part-paid invoice is not a disagreement with the whole.
   */
  deltaCents: number | null
  /**
   * Whether the matched request's money lines up: its transactions add up to what the ledger holds and the currency
   * agrees. Null when nothing was compared. False is surfaced, never accepted.
   */
  balanced: boolean | null
}

export type Activity = {
  rows: ActivityRow[]
  matched: number
  unmatched: number
  /** Net cents of the unmatched rows: money PayPal shows that Mandate did not move. */
  unmatchedNetCents: number
  /** Matched requests whose PayPal transactions do not add up to what the ledger holds. */
  mismatched: number
  /** Net cents of those differences: what PayPal shows minus what the ledger recorded. */
  mismatchedNetCents: number
}

/**
 * Lines the PayPal account up against the ledger. Money Mandate moved carries an id Mandate stored, or the proposal id
 * as PayPal's custom field or invoice reference. A transaction with none of them did not come from Mandate.
 * `known` maps every PayPal id the ledger holds (and every proposal id) to its proposal and its money.
 *
 * Matching by id is only half the answer: a matched row is then checked against the money the ledger holds for that
 * request. A request can legitimately be paid in several transactions (an invoice paid in parts), so the check sums
 * them before comparing; a row's own delta is only meaningful when it is the only transaction for the request.
 */
export function reconcile(transactions: LiveTransaction[], known: Map<string, LedgerMoney>, invoiceProposal: (invoiceRef: string) => string | null = () => null): Activity {
  const rows = transactions.map((txn): ActivityRow => {
    const none = { expectedCents: null, expectedCurrency: null, deltaCents: null, balanced: null }
    const byId = known.get(txn.id)
    if (byId) return { ...txn, ...none, proposalId: byId.proposalId, matchedBy: 'id' }
    const byRef = txn.referenceId ? known.get(txn.referenceId) : undefined
    if (byRef) return { ...txn, ...none, proposalId: byRef.proposalId, matchedBy: 'reference' }
    const byCustom = txn.customId ? known.get(txn.customId) : undefined
    if (byCustom) return { ...txn, ...none, proposalId: byCustom.proposalId, matchedBy: 'custom' }
    const invoiceRef = txn.invoiceId
    const byInvoice = invoiceRef ? known.get(invoiceRef) ?? known.get(invoiceProposal(invoiceRef) ?? '') : undefined
    if (byInvoice) return { ...txn, ...none, proposalId: byInvoice.proposalId, matchedBy: 'invoice' }
    return { ...txn, ...none, proposalId: null, matchedBy: null }
  })

  const groups = new Map<string, ActivityRow[]>()
  for (const row of rows) {
    if (!row.proposalId) continue
    const group = groups.get(row.proposalId)
    if (group) group.push(row)
    else groups.set(row.proposalId, [row])
  }

  let mismatched = 0
  let mismatchedNetCents = 0
  for (const [proposalId, group] of groups) {
    const money = known.get(proposalId)
    if (!money) continue
    const sum = group.reduce((total, row) => total + row.cents, 0)
    const currencyAgrees = group.every((row) => row.currency === money.currency)
    const balanced = sum === money.cents && currencyAgrees
    if (!balanced) {
      mismatched += 1
      mismatchedNetCents += sum - money.cents
    }
    for (const row of group) {
      row.expectedCents = money.cents
      row.expectedCurrency = money.currency
      row.deltaCents = group.length === 1 ? row.cents - money.cents : null
      row.balanced = balanced
    }
  }

  const unmatched = rows.filter((row) => row.proposalId === null)
  return {
    rows,
    matched: rows.length - unmatched.length,
    unmatched: unmatched.length,
    unmatchedNetCents: unmatched.reduce((sum, row) => sum + row.cents, 0),
    mismatched,
    mismatchedNetCents,
  }
}
