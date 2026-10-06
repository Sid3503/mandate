import type { WarrantBody } from './schemas'

/**
 * The rules in plain words, written once on the server so every surface says the same thing: the console, the
 * agents' tool results, and receipts. The server's own sentence always travels beside it.
 */

const dollars = (cents: number, currency = 'USD') => `${currency === 'USD' ? '$' : `${currency} `}${(cents / 100).toFixed(2)}`

export type ExplainInput = {
  clause: string
  kind?: 'payment' | 'charge' | 'refund'
  amountCents?: number
  category?: string | null
  payeeName?: string | null
  warrant?: Pick<WarrantBody, 'autoSettleUnderCents' | 'monthlyCapCents' | 'contractorShareBps' | 'currency'> | null
}

export function explainClause(input: ExplainInput): string {
  const who = input.payeeName ?? 'That party'
  const amount = input.amountCents !== undefined ? dollars(input.amountCents, input.warrant?.currency) : 'This amount'
  const line = input.warrant ? dollars(input.warrant.autoSettleUnderCents, input.warrant.currency) : 'the automatic line'
  const cap = input.warrant ? dollars(input.warrant.monthlyCapCents, input.warrant.currency) : 'the monthly cap'
  const share = input.warrant ? `${input.warrant.contractorShareBps / 100}%` : 'the contractor share'
  switch (input.clause) {
    case 'amount.needs_approval': return `${who} is on the rules, but ${amount} is at or above ${line}, so the owner has to tap.`
    case 'standing.matched': return `${who} is covered by a standing rule the owner signed, so ${amount} goes to PayPal without a tap. Every other rule still had to pass.`
    case 'amount.auto': return `${who} is on the rules and ${amount} is under ${line}, so it goes through without a tap.`
    case 'payee.unknown': return input.kind === 'charge' ? 'That client is not on the rules. Nobody new can be billed.' : 'That account is not on the rules. Being under the line never adds a new payee.'
    case 'category.missing': return `“${input.category ?? 'That'}” is not an allowed kind of work.`
    case 'currency.mismatch': return `Only ${input.warrant?.currency ?? 'the warrant currency'} can move.`
    case 'evidence.missing': return 'Every request needs an https link to the work.'
    case 'amount.ceiling': return 'Over the per-payment ceiling. That stops typos before anyone taps.'
    case 'cap.monthly': return `Contractor payouts this month would pass ${cap}.`
    case 'refund.unlinked': return 'A refund must point at a payment that was actually settled.'
    case 'refund.exceeds': return 'That is more than is left to refund on the payment.'
    case 'job.missing': return 'Money in has to name the job it pays for.'
    case 'funding.missing': return 'The client has not paid for this yet, so nothing funds the payout.'
    case 'funding.job_mismatch': return 'That client payment belongs to a different job.'
    case 'funding.disputed': return 'The client has disputed that payment with PayPal, so it cannot fund a payout until the dispute is resolved.'
    case 'funding.exceeds': return `That client payment cannot fund this much at a ${share} contractor share.`
    case 'deal.required': return 'This job has an agreed deal, so a charge on it must bill one of the deal’s milestones.'
    case 'deal.unknown': return 'The deal this charge names does not exist or was never agreed.'
    case 'deal.milestone_mismatch': return 'A milestone can only be billed for exactly its agreed amount.'
    case 'deal.milestone_billed': return 'That milestone has already been billed.'
    case 'deal.milestone_unknown': return 'The deal has no such milestone.'
    case 'deal.job_mismatch': return 'That deal belongs to a different job.'
    case 'deal.party_mismatch': return 'That deal was made with a different client.'
    case 'cart.immutable': return 'The lock holds. A different amount was refused, and PayPal was not asked.'
    case 'lock.signature_invalid': return 'The lock’s signature does not verify, so nothing was sent to PayPal.'
    case 'shape.invalid': return 'The amount must be a whole number of cents above zero.'
    case 'deal.over_buyer_limit': return 'The total is over what the client’s rules allow.'
    case 'deal.under_seller_minimum': return 'The total is under the studio’s minimum.'
    case 'deal.shape': return 'The milestones do not add up to the total.'
    case 'deal.category_buyer': return 'The client does not buy that kind of work.'
    case 'deal.category_seller': return 'The studio does not sell that kind of work.'
    case 'deal.proof_required': return 'Each milestone needs a proof link.'
    case 'deal.too_many_milestones': return 'There are more milestones than one side allows.'
    case 'deal.milestone_too_large': return 'A milestone is larger than the client allows.'
    case 'deal.milestone_too_small': return 'A milestone is smaller than the studio allows.'
    case 'deal.due_date_past': return 'The due date has already passed.'
    case 'deal.currency': return 'The currency does not match what both sides work in.'
    case 'deal.thread_closed': return 'This negotiation already ended in a deal.'
    case 'deal.job_taken': return 'That job id is already in use.'
    default: return input.clause
  }
}

/** What happens next, for a proposal in a given state. Agents repeat this instead of guessing. */
export function nextStep(input: { gate: string; phase: string; kind: string; clause?: string }): string {
  const { gate, phase, kind, clause } = input
  const standing = clause === 'standing.matched'
  if (gate === 'DENY' || phase === 'denied') return 'Nothing moved and PayPal was not called. Change the request, or ask the owner to change the rules.'
  switch (phase) {
    case 'pending_approval': return 'Waiting for the owner to tap Approve. Agents cannot approve.'
    case 'rejected': return 'The owner rejected it. Nothing moved.'
    case 'locked':
    case 'order_created': if (standing) return 'The owner\'s standing rule covers it, so Mandate sends it to PayPal itself. If it is still locked, PayPal could not be reached or a dispute is holding it, and Mandate will retry. It is not paid until PayPal says so.'
      return kind === 'payment' ? 'Approved and locked. The owner sends the payout from the receipt.' : 'Approved and locked. The owner settles it, and the client pays through PayPal.'
    case 'invoice_sent': return 'A PayPal invoice was sent to the client. It settles when the client pays it.'
    case 'invoice_cancelled': return 'The invoice was cancelled, so it can no longer be paid. The milestone can be billed again.'
    case 'payout_sent': return 'PayPal has the payout and is processing it. It is not paid until PayPal says so.'
    case 'payout_unclaimed': return 'Sent, but the receiver has no PayPal account yet, so it is not paid.'
    case 'payout_failed': return 'PayPal did not pay it. The reservation was released.'
    case 'captured': return kind === 'payment' ? 'Paid. PayPal confirmed it.' : 'Settled. PayPal confirmed the client payment.'
    case 'refunded': return 'Refunded.'
    case 'capture_refused': return 'Refused at PayPal because the live amount did not match the lock.'
    default: return 'In progress.'
  }
}
