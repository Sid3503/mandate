import type { Proposal } from '../lib/types'
import { phaseInfo } from '../lib/words'

/**
 * The ledger, as the flat rows AG Studio works with.
 *
 * Studio never talks to Mandate or to PayPal. It is handed an array, and this is where the array comes from: the same
 * requests the Ledger grid already shows, one plain object each. Every amount is in dollars (Studio sums and formats
 * them), and the money columns follow one rule so that no tile can overstate what happened: `moneyIn` and `moneyOut`
 * count only what PayPal confirmed (a settled payment, a paid payout), never what was merely asked for.
 */
export type LedgerRow = {
  id: string
  asked: Date
  day: string
  who: string
  what: string
  kind: 'payment' | 'charge' | 'refund'
  /** `in` is money coming to the studio; `out` is money leaving it (a payout or a refund). */
  direction: 'in' | 'out'
  /** What the rules decided: DENY, AUTO (no tap) or NEEDS_APPROVAL (waits for the owner). */
  decision: 'DENY' | 'AUTO' | 'NEEDS_APPROVAL'
  /** The rule that decided, for example `funding.missing`. */
  reason: string
  /** Where it is now, in words. */
  status: string
  /** How it was approved: the owner's tap, a standing rule, under the line, or refused. */
  how: string
  amount: number
  moneyIn: number
  moneyOut: number
  kept: number
  /** What was asked for and refused. */
  refused: number
  /** What a client still owes on an invoice that is out. */
  owed: number
  daysOut: number | null
  job: string | null
  orderId: string | null
  captureId: string | null
}

const dollars = (cents: number) => Math.round(cents) / 100

function howApproved(row: Proposal): string {
  if (row.gate === 'DENY') return 'refused by a rule'
  if (row.clause.startsWith('standing.')) return 'standing rule'
  if (row.clause === 'amount.auto') return 'under the line'
  return 'owner tap'
}

export function toLedgerRows(proposals: Proposal[], nameOf: (id: string | null) => string, now: Date = new Date()): LedgerRow[] {
  return proposals.map((row) => {
    const settledCents = row.phase === 'captured' ? (row.capturedAmountCents ?? row.amountCents) : row.phase === 'refunded' ? row.amountCents : 0
    const inCents = row.kind === 'charge' ? settledCents : 0
    const outCents = row.kind === 'charge' ? 0 : settledCents
    const asked = new Date(row.createdAt)
    const owed = row.kind === 'charge' && (row.phase === 'invoice_sent' || row.phase === 'invoice_draft') ? row.amountCents : 0
    return {
      id: row.id,
      asked,
      day: row.createdAt.slice(0, 10),
      who: nameOf(row.payeeId),
      what: row.description,
      kind: row.kind,
      direction: row.kind === 'charge' ? 'in' : 'out',
      decision: row.gate,
      reason: row.clause,
      status: row.gate === 'DENY' ? 'Refused' : phaseInfo(row.phase, row.kind).label,
      how: howApproved(row),
      amount: dollars(row.amountCents),
      moneyIn: dollars(inCents),
      moneyOut: dollars(outCents),
      kept: dollars(inCents - outCents),
      refused: row.gate === 'DENY' ? dollars(row.amountCents) : 0,
      owed: dollars(owed),
      daysOut: owed > 0 ? Math.max(0, Math.floor((now.getTime() - asked.getTime()) / 86_400_000)) : null,
      job: row.jobId,
      orderId: row.orderId,
      captureId: row.captureId,
    }
  })
}
