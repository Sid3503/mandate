import type { LiveTransaction } from '../paypal/watch'

export type ActivityRow = LiveTransaction & {
  /** The Mandate request this PayPal transaction belongs to, or null if Mandate has no record of it. */
  proposalId: string | null
  matchedBy: 'id' | 'reference' | 'invoice' | 'custom' | null
}

export type Activity = {
  rows: ActivityRow[]
  matched: number
  unmatched: number
  /** Net cents of the unmatched rows: money PayPal shows that Mandate did not move. */
  unmatchedNetCents: number
}

/**
 * Lines the PayPal account up against the ledger. Money Mandate moved carries an id Mandate stored, or the proposal id
 * as PayPal's custom field or invoice reference. A transaction with none of them did not come from Mandate.
 * `known` maps every PayPal id the ledger holds (and every proposal id) to its proposal.
 */
export function reconcile(transactions: LiveTransaction[], known: Map<string, string>, invoiceProposal: (invoiceRef: string) => string | null = () => null): Activity {
  const rows = transactions.map((txn): ActivityRow => {
    const byId = known.get(txn.id)
    if (byId) return { ...txn, proposalId: byId, matchedBy: 'id' }
    const byRef = txn.referenceId ? known.get(txn.referenceId) : undefined
    if (byRef) return { ...txn, proposalId: byRef, matchedBy: 'reference' }
    const byCustom = txn.customId ? known.get(txn.customId) : undefined
    if (byCustom) return { ...txn, proposalId: byCustom, matchedBy: 'custom' }
    const byInvoice = txn.invoiceId ? known.get(txn.invoiceId) ?? invoiceProposal(txn.invoiceId) : null
    if (byInvoice) return { ...txn, proposalId: byInvoice, matchedBy: 'invoice' }
    return { ...txn, proposalId: null, matchedBy: null }
  })
  const unmatched = rows.filter((row) => row.proposalId === null)
  return {
    rows,
    matched: rows.length - unmatched.length,
    unmatched: unmatched.length,
    unmatchedNetCents: unmatched.reduce((sum, row) => sum + row.cents, 0),
  }
}
