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
  invoice_draft: { label: 'Invoice drafted', tone: 'need' },
  invoice_sent: { label: 'Invoice sent · waiting for the client', tone: 'need' },
  invoice_cancelled: { label: 'Invoice cancelled', tone: 'muted' },
  payout_sent: { label: 'Sent · PayPal processing', tone: 'need' },
  payout_unclaimed: { label: 'Sent · unclaimed', tone: 'need' },
  payout_failed: { label: 'Payout failed', tone: 'deny' },
}

/** Money out reads differently from money in: it is sent and paid, not captured. */
const PAYOUT_PHASE: Record<string, { label: string; tone: 'deny' | 'auto' | 'need' | 'ink' | 'muted' }> = {
  locked: { label: 'Approved · ready to send', tone: 'ink' },
  order_created: { label: 'Approved · ready to send', tone: 'ink' },
  capture_inflight: { label: 'Sending', tone: 'ink' },
  captured: { label: 'Paid', tone: 'auto' },
}

export function phaseInfo(phase: string, kind?: Kind): { label: string; tone: 'deny' | 'auto' | 'need' | 'ink' | 'muted' } {
  return (kind === 'payment' ? PAYOUT_PHASE[phase] : undefined) ?? PHASE[phase] ?? { label: phase, tone: 'muted' }
}

/** A contractor payout that is approved, sent, or finished. It is paid through PayPal Payouts, never Orders checkout. */
export function isPayout(proposal: Pick<Proposal, 'kind'>): boolean {
  return proposal.kind === 'payment'
}

/** A payout PayPal already holds, or one the owner can still send. Both show on the Waiting-for-you page. */
export function payoutInProgress(proposal: Pick<Proposal, 'kind' | 'phase'>): boolean {
  return proposal.kind === 'payment' && ['locked', 'order_created', 'capture_inflight', 'payout_sent', 'payout_unclaimed'].includes(proposal.phase)
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
  'invoice.created': 'PayPal invoice drafted',
  'invoice.sent': 'Invoice sent to the client',
  'invoice.status': 'PayPal updated the invoice',
  'invoice.partial': 'Invoice part-paid, not counted as settled',
  'invoice.unavailable': 'Invoicing not permitted, used checkout instead',
  'payout.sent': 'Payout sent to PayPal',
  'payout.status': 'PayPal is processing the payout',
  'payout.completed': 'Paid by PayPal',
  'payout.unclaimed': 'Sent · receiver has no PayPal account yet',
  'payout.failed': 'PayPal failed the payout',
  'delivery.accepted': 'Client’s agent accepted the delivery · signed',
  'standing.waiting': 'Held for now · Mandate will retry',
  'autopilot.payout_asked': 'Autopilot asked to pay the contractor',
  'autopilot.clearing': 'Autopilot is waiting for the client’s money to clear',
  'payout.cancelled': 'Unclaimed payout cancelled · money returned',
  'invoice.reminded': 'Reminder sent to the client',
  'invoice.cancelled': 'Invoice cancelled',
  'dispute.opened': 'Client opened a PayPal dispute',
  'dispute.resolved': 'PayPal dispute resolved',
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
    case 'standing.billing': return `${who}’s milestone is exactly what the signed deal says, and you switched on billing signed deals (after the client accepts, if you asked for that), so the invoice goes out without a tap.`
    case 'standing.matched': return `${who} is covered by a standing rule you signed, so ${amount} goes to PayPal without a tap. Every other rule still had to pass.`
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
    case 'funding.missing': return 'No client payment has money left to fund this payout.'
    case 'funding.job_mismatch': return 'That client payment belongs to a different job.'
    case 'system.paused': return 'Mandate is paused. Nothing automatic runs and no agent is served until the owner resumes it; the owner’s own requests wait for a tap.'
    case 'funding.clearing': return `The client’s payment is still clearing, so no rule pays ${who} from it yet. A client can still take money back for a while. You can approve it yourself now, or let the rule send it when the wait is over.`
    case 'funding.disputed': return 'The client has disputed that payment with PayPal, so it cannot fund a payout until the dispute is resolved.'
    case 'funding.exceeds': return `That client payment cannot fund this much at a ${share} contractor share.`
    case 'deal.required': return 'This job has an agreed deal, so a charge on it must bill one of the deal’s milestones.'
    case 'deal.unknown': return 'The deal this charge names does not exist or was never agreed.'
    case 'deal.milestone_mismatch': return 'A milestone can only be billed for exactly its agreed amount.'
    case 'deal.milestone_billed': return 'That milestone has already been billed.'
    case 'deal.milestone_unknown': return 'The deal has no such milestone.'
    case 'deal.job_mismatch': return 'That deal belongs to a different job.'
    case 'deal.party_mismatch': return 'That deal was made with a different client.'
    case 'lock.signature_invalid': return 'The lock’s signature does not verify, so nothing was sent to PayPal.'
    case 'cart.immutable': return 'The lock holds. A different amount was refused, and PayPal was not asked.'
    case 'shape.invalid': return 'The amount must be a whole number of cents above zero.'
    default: return clause
  }
}

/** Server problems that are not rule decisions, in plain words. */
export function problemWords(code: string): string {
  switch (code) {
    case 'paypal.buyer_pending': return 'The buyer has not approved the PayPal order. No capture has happened yet.'
    case 'paypal.unconfigured': return 'This server has no PayPal sandbox credentials, so it cannot settle.'
    case 'payee.unknown': return 'The contractor is not on the rules this payout was approved under. Nothing was sent.'
    case 'paypal.upstream': return 'PayPal rejected the call. Nothing moved. Use the debug id in the PayPal dashboard.'
    case 'auth.forbidden': return 'This key can ask and read. Only the owner key can approve, settle, or change the rules.'
    case 'auth.unauthorized': return 'That key was not accepted.'
    case 'capture.inflight': return 'A settlement is already running. Try again in a moment.'
    case 'proposal.state': return 'That action does not fit where this request is now.'
    case 'idempotency.mismatch': return 'This form was already sent with different details. Start a new request.'
    case 'idempotency.inflight': return 'The first send is still running.'
    case 'network.offline': return 'No connection. Nothing was sent.'
    case 'network.timeout': return 'The server did not answer in time. Look at Today before pressing a money button again: the request may have gone through.'
    case 'paypal.unavailable': return 'PayPal is not answering. Nothing was lost: the request keeps its place and Mandate tries again by itself.'
    case 'server.error':
    case 'internal': return 'Something went wrong on the server. Reload the page; if it keeps happening, quote the reference below.'
    case 'response.unreadable': return 'The server\'s answer could not be read. Reload and try again.'
    case 'rules.stale': return 'The rules changed while you were editing. Nothing was published. Start again from the live rules.'
    case 'agents.unconfigured': return 'No language model is configured. The rules and the console work without one.'
    case 'agent.unavailable': return 'The language model failed several times in a row, so it is paused for a moment. Try again shortly.'
    case 'agent.model_error': return 'The language model failed. Nothing was sent to PayPal. Try again.'
    case 'agent.rate_limited': return 'The language model is busy. Try again in a moment.'
    case 'agent.timeout': return 'The language model took too long. Nothing was sent to PayPal.'
    case 'agent.no_tool_call': return 'The model answered in words instead of acting. Nothing was sent.'
    case 'request.too_large': return 'That was too large to send.'
    case 'system.paused': return 'Mandate is paused. Nothing automatic runs and agents are refused until the owner resumes it.'
    case 'rate.limited': return 'Too many requests. Wait a minute.'
    case 'request.invalid': return 'Some fields did not pass validation.'
    case 'deal.rules_invalid': return 'That price sheet is missing something the rules need. Nothing was saved.'
    default: return ''
  }
}

export function standingSentences(warrant: Warrant): string[] {
  const name = (id: string) => [...warrant.payees, ...(warrant.clients ?? [])].find((party) => party.id === id)?.displayName ?? id
  return (warrant.standing ?? []).map((rule) => `Standing rule: ${name(rule.payeeId)} is paid, with no tap, from settled ${rule.clientIds.map(name).join(' or ')} payments${rule.requireDeal ? ' on a signed deal' : ''}, ${rule.shareBps ? `${rule.shareBps / 100}% of each` : 'up to the contractor share'} and inside the monthly cap.`)
}

/** The rules as sentences, for the Rules screen. */
export function automationSentences(warrant: Warrant): string[] {
  const a = warrant.automation
  if (!a) return []
  return [
    a.billSignedDeals ? (a.requireAcceptance ? 'Autopilot bills a milestone of a signed deal, and sends the invoice, once the client’s own agent has accepted the delivery. Until then a bill waits for your tap.' : 'Autopilot bills a milestone of a signed deal, and sends the invoice, as soon as proof of the work is attached.') : null,
    a.payOnSettle ? 'Autopilot asks to pay each contractor with a standing rule the moment a client payment settles.' : null,
    a.remindUnpaidAfterDays ? `Autopilot reminds a client about an invoice that is still unpaid after ${a.remindUnpaidAfterDays} days, at most ${a.maxReminders} times.` : null,
  ].filter((line): line is string => line !== null)
}

export function ruleSentences(warrant: Warrant): string[] {
  const payees = warrant.payees.map((party) => party.displayName).join(', ')
  const clients = (warrant.clients ?? []).map((party) => party.displayName).join(', ')
  const lines = [
    `Only ${payees || 'nobody'} can be paid. Anyone else is refused, whatever the amount.`,
    clients ? `Only ${clients} can be billed.` : 'No clients can be billed yet.',
    `Allowed work: ${warrant.categories.join(', ')}. Anything else is refused.`,
    ...standingSentences(warrant),
    ...automationSentences(warrant),
    `Under ${dollars(warrant.autoSettleUnderCents)} settles automatically. ${dollars(warrant.autoSettleUnderCents)} and above waits for the owner, unless a standing rule covers it.`,
    `Contractor payouts stop at ${dollars(warrant.monthlyCapCents)} a month (${warrant.timezone}).`,
    `No single payment above ${dollars(warrant.perPaymentCeilingCents)}.`,
    warrant.evidenceRequired ? 'Every request needs an https link to the work.' : 'Evidence links are optional.',
    warrant.fundingRequired
      ? `A contractor is only paid from a client payment already settled on the same job, up to ${warrant.contractorShareBps / 100}% of it.`
      : 'Contractor payouts do not need a client payment behind them.',
    warrant.fundingRequired && warrant.clearingDays > 0 ? `A rule or autopilot waits ${warrant.clearingDays} day${warrant.clearingDays === 1 ? '' : 's'} after a client pays before it sends a payout from that money. You can still tap to pay earlier.` : '',
    `Everything moves in ${warrant.currency}, counted in whole cents.`,
  ]
  return lines.filter((line) => line !== '')
}

/** The deal check's rule codes, in words for a person who is not a lawyer. */
export const DEAL_RULE: Record<string, string> = {
  'deal.over_buyer_limit': 'Over what the client’s rules allow',
  'deal.under_seller_minimum': 'Under the studio’s minimum',
  'deal.shape': 'Milestones do not add up to the total',
  'deal.currency': 'Wrong currency',
  'deal.category_buyer': 'The client does not buy this kind of work',
  'deal.category_seller': 'The studio does not sell this kind of work',
  'deal.milestone_too_large': 'A milestone is larger than the client allows',
  'deal.milestone_too_small': 'A milestone is smaller than the studio allows',
  'deal.too_many_milestones': 'More milestones than one side allows',
  'deal.proof_required': 'Each milestone needs a proof link',
  'deal.due_date_past': 'The due date has passed',
  'deal.job_taken': 'That job id is already in use',
  'deal.thread_closed': 'This negotiation already has a deal',
}

export const AGENT_LABEL: Record<string, string> = {
  clerk: 'Studio clerk',
  'negotiator:seller': 'Studio’s negotiator',
  'negotiator:buyer': 'Client’s negotiator',
}
