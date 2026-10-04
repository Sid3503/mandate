import { dollars } from './money'
import type { Gate, Kind, Party, Proposal, Warrant } from './types'

export const KIND: Record<Kind, { label: string; short: string; arrow: string }> = {
  charge: { label: 'Money in', short: 'In', arrow: '↘' },
  payment: { label: 'Money out', short: 'Out', arrow: '↗' },
  refund: { label: 'Refund', short: 'Refund', arrow: '↩' },
}

export const GATE: Record<Gate, { label: string; tone: 'deny' | 'auto' | 'need' }> = {
  DENY: { label: 'Refused', tone: 'deny' },
  AUTO: { label: 'Automatic', tone: 'auto' },
  NEEDS_APPROVAL: { label: 'Needs you', tone: 'need' },
}

export const PHASE: Record<string, { label: string; tone: 'deny' | 'auto' | 'need' | 'ink' | 'muted' }> = {
  denied: { label: 'Refused', tone: 'deny' },
  pending_approval: { label: 'Waiting for you', tone: 'need' },
  rejected: { label: 'Rejected', tone: 'muted' },
  locked: { label: 'Locked · ready to settle', tone: 'ink' },
  order_created: { label: 'Waiting on PayPal buyer', tone: 'need' },
  capture_inflight: { label: 'Settling', tone: 'ink' },
  captured: { label: 'Settled', tone: 'auto' },
  refunded: { label: 'Refunded', tone: 'auto' },
  capture_refused: { label: 'Refused at PayPal', tone: 'deny' },
}

/** A contractor payout cannot use Orders checkout; its approved lock stays reserved until Payouts is connected. */
export function awaitingPayoutRail(proposal: Pick<Proposal, 'kind' | 'phase'>): boolean {
  return proposal.kind === 'payment' && (proposal.phase === 'locked' || proposal.phase === 'order_created' || proposal.phase === 'capture_inflight')
}

export const EVENT: Record<string, string> = {
  'proposal.created': 'Asked',
  'proposal.approved': 'Approved · lock signed',
  'proposal.rejected': 'Rejected',
  'proposal.approval_blocked': 'Approval blocked',
  'cart.mutation_refused': 'Changed request refused',
  'capture.refused': 'Settlement refused',
  'order.created': 'PayPal order created',
  'capture.completed': 'Settled with PayPal',
  'refund.completed': 'Refunded with PayPal',
}

export type Names = (id: string | null | undefined) => string

/** Builds a name lookup across every warrant version so old proposals keep their people. */
export function namer(versions: Warrant[] | undefined): Names {
  const map = new Map<string, string>()
  for (const warrant of [...(versions ?? [])].reverse()) {
    for (const party of [...warrant.payees, ...(warrant.clients ?? [])]) map.set(party.id, party.displayName)
  }
  return (id) => (id ? map.get(id) ?? id : 'Unknown')
}

export function parties(warrant: Warrant | undefined): { payees: Party[]; clients: Party[] } {
  return { payees: warrant?.payees ?? [], clients: warrant?.clients ?? [] }
}

/** One sentence a person would say for each rule the server can name. The server's own words stay beside it. */
export function explain(clause: string, proposal: Partial<Proposal> | null, warrant: Warrant | undefined, names: Names): string {
  const who = proposal?.payeeId ? names(proposal.payeeId) : 'That party'
  const amount = proposal?.amountCents !== undefined ? dollars(proposal.amountCents) : 'This amount'
  const line = warrant ? dollars(warrant.autoSettleUnderCents) : 'the automatic line'
  const cap = warrant ? dollars(warrant.monthlyCapCents) : 'the monthly cap'
  const share = warrant?.contractorShareBps !== undefined ? `${warrant.contractorShareBps / 100}%` : 'the contractor share'
  switch (clause) {
    case 'amount.needs_approval': return `${who} is on the rules, but ${amount} is at or above ${line}, so the owner has to tap.`
    case 'amount.auto': return `${who} is on the rules and ${amount} is under ${line}, so it settles without a tap.`
    case 'payee.unknown': return proposal?.kind === 'charge' ? 'That client is not on the rules. Nobody new can be billed.' : 'That account is not on the rules. Being under the line never adds a new payee.'
    case 'category.missing': return `“${proposal?.category ?? 'That'}” is not an allowed kind of work.`
    case 'currency.mismatch': return `Only ${warrant?.currency ?? 'the warrant currency'} can move.`
    case 'evidence.missing': return 'Every request needs an https link to the work.'
    case 'amount.ceiling': return 'Over the per-payment ceiling. That stops typos before anyone taps.'
    case 'cap.monthly': return `Contractor payouts this month would pass ${cap}. The earlier payouts are cited.`
    case 'refund.unlinked': return 'A refund must point at a payment that was actually settled.'
    case 'refund.exceeds': return 'That is more than is left to refund on the payment.'
    case 'job.missing': return 'Money in has to name the job it pays for.'
    case 'funding.missing': return 'The client has not paid for this yet, so nothing funds the payout.'
    case 'funding.job_mismatch': return 'That client payment belongs to a different job.'
    case 'funding.exceeds': return `That client payment cannot fund this much at a ${share} contractor share.`
    case 'cart.immutable': return 'The lock holds. A different amount was refused, and PayPal was not asked.'
    case 'shape.invalid': return 'The amount must be a whole number of cents above zero.'
    default: return clause
  }
}

/** Server problems that are not rule decisions, in plain words. */
export function problemWords(code: string): string {
  switch (code) {
    case 'paypal.buyer_pending': return 'The buyer has not approved the PayPal order. No capture has happened yet.'
    case 'payout.unavailable': return 'Approved and reserved for the contractor, but not paid. Contractor Payouts is not connected; Orders checkout would pay the studio.'
    case 'paypal.unconfigured': return 'This server has no PayPal sandbox credentials, so it cannot settle.'
    case 'paypal.upstream': return 'PayPal rejected the call. Nothing moved. Use the debug id in the PayPal dashboard.'
    case 'auth.forbidden': return 'This key can ask and read. Only the owner key can approve, settle, or change the rules.'
    case 'auth.unauthorized': return 'That key was not accepted.'
    case 'capture.inflight': return 'A settlement is already running. Try again in a moment.'
    case 'proposal.state': return 'That action does not fit where this request is now.'
    case 'idempotency.mismatch': return 'This form was already sent with different details. Start a new request.'
    case 'idempotency.inflight': return 'The first send is still running.'
    case 'network.offline': return 'No connection. Nothing was sent.'
    case 'rate.limited': return 'Too many requests. Wait a minute.'
    case 'request.invalid': return 'Some fields did not pass validation.'
    default: return ''
  }
}

/** The rules as sentences, for the Rules screen. */
export function ruleSentences(warrant: Warrant): string[] {
  const payees = warrant.payees.map((party) => party.displayName).join(', ')
  const clients = (warrant.clients ?? []).map((party) => party.displayName).join(', ')
  const lines = [
    `Only ${payees || 'nobody'} can be paid. Anyone else is refused, whatever the amount.`,
    clients ? `Only ${clients} can be billed.` : 'No clients can be billed yet.',
    `Allowed work: ${warrant.categories.join(', ')}. Anything else is refused.`,
    `Under ${dollars(warrant.autoSettleUnderCents)} settles automatically. ${dollars(warrant.autoSettleUnderCents)} and above waits for the owner.`,
    `Contractor payouts stop at ${dollars(warrant.monthlyCapCents)} a month (${warrant.timezone}).`,
    `No single payment above ${dollars(warrant.perPaymentCeilingCents)}.`,
    warrant.evidenceRequired ? 'Every request needs an https link to the work.' : 'Evidence links are optional.',
    warrant.fundingRequired
      ? `A contractor is only paid from a client payment already settled on the same job, up to ${warrant.contractorShareBps / 100}% of it.`
      : 'Contractor payouts do not need a client payment behind them.',
    `Everything moves in ${warrant.currency}, counted in whole cents.`,
  ]
  return lines
}
