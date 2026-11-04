import { GENESIS_HASH, journalHash, ledgerTargets, type DisputeRow, type JournalEntryRow, type Posting, type ProposalRow } from '../db/repo'
import type { Activity } from './reconcile'
import { FUNDED_PHASES, REFUND_HELD_PHASES, arrivedCents, fullPhase } from './phases'

/**
 * Breaks: places where Mandate's books and PayPal (or the books and the rows, or the rows and the clock) disagree, and
 * somebody should look. Everything here is a pure function of facts handed in, so each rule can be tested with a
 * handful of rows and a clock, and nothing here can move money or call PayPal. The service stores what these find and
 * decides what a fix may do; the rules only describe the disagreement and what is expected against what was seen.
 *
 * A break has a stable `key` (`rule:proposalId`, or `rule:reference` for something with no request). The same
 * disagreement found on the next scan has the same key, which is how a scan knows it is the same break and not a new one.
 */

export type BreakSeverity = 'critical' | 'warning' | 'info'

export type Break = {
  key: string
  rule: string
  severity: BreakSeverity
  proposalId: string | null
  title: string
  detail: string
  /** What the books say should be true, in words and numbers. */
  expected: string
  /** What was actually found. */
  observed: string
  /** Observed minus expected, in cents, when the disagreement is a sum of money. Null when it is not. */
  deltaCents: number | null
}

/** A request's event, reduced to what the rules read. */
export type BreakEventFact = { type: string; created_at: string }

export type BreakFacts = {
  now: Date
  proposals: ProposalRow[]
  /** Events by request id, oldest first. */
  events: Map<string, BreakEventFact[]>
  journal: Array<JournalEntryRow & { postings: Posting[] }>
  disputes: DisputeRow[]
  /** The owner's automation rules (reminder schedule). Null when there are no rules. */
  automation: { remindUnpaidAfterDays?: number | null } | null
  /** PayPal's own transaction list lined up against the books. Present only on "Reconcile now". */
  activity?: Activity | null
  /** How long a worker owns a request it marked settling. Defaults to the server's lease. */
  inflightMs?: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const DUPLICATE_WINDOW_MS = DAY
export const PENDING_STALE_MS = 6 * HOUR
export const UNCLAIMED_AGING_MS = 20 * DAY
/** PayPal returns an unclaimed payout to the sender after this long. */
export const UNCLAIMED_RETURN_DAYS = 30
export const DEFAULT_INVOICE_DAYS = 14
export const STUCK_DRAFT_MS = HOUR
export const SHORT_AGING_MS = 3 * DAY
export const DEFAULT_INFLIGHT_MS = 180_000
/** PayPal does not store a response-due date for us, so a dispute is assumed to be due this long after it opened. */
export const DISPUTE_RESPONSE_DAYS = 10
/** A dispute due within this long (or already overdue) is critical. */
export const DISPUTE_SOON_MS = 3 * DAY
/** A refund filed as a request that has waited this long without the owner's tap needs chasing. */
export const REFUND_OWNER_WAIT_MS = 7 * DAY
/** The missing part of a partly paid invoice that has not arrived this long is unresolved. */
export const PARTIAL_UNRESOLVED_MS = 10 * DAY
/** A capture fee heavier than this share of what arrived (plus a fixed allowance) is an anomaly worth reading. */
export const FEE_ANOMALY_BPS = 400
/** The fixed cents allowance on top of the share, so PayPal's small `3.49% + 49¢`-shaped fees are never called anomalies. */
export const FEE_ANOMALY_FIXED_CENTS = 60
/** Fees on very small payments are dominated by the fixed part and never judged. */
export const FEE_ANOMALY_MIN_CENTS = 1_000

const money = (cents: number, currency: string): string => `${(cents / 100).toFixed(2)} ${currency}`

/** When a request last entered its present phase: the newest event of one of these types, else the row's own stamp. */
function phaseSince(row: ProposalRow, events: BreakEventFact[], types: string[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (types.includes(events[index]!.type)) return events[index]!.created_at
  }
  return row.updated_at
}

function ageOf(now: Date, iso: string): number {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? 0 : now.getTime() - at
}

const hoursWords = (ms: number): string => (ms >= 2 * DAY ? `${Math.floor(ms / DAY)} days` : `${Math.floor(ms / HOUR)} hours`)

/**
 * The moment an invoice is due, and the one place that decides it. A request that carries an explicit `due_date` (a
 * column another part of the product adds) is due then; one that does not is due the reminder schedule's number of days
 * after it was sent. Null when neither is known.
 */
export function invoiceDueAt(row: ProposalRow, sentAt: string | null = null, days: number = DEFAULT_INVOICE_DAYS): string | null {
  const explicit = (row as { due_date?: string | null }).due_date ?? null
  if (explicit) return explicit
  if (!sentAt) return null
  const sent = Date.parse(sentAt)
  return Number.isNaN(sent) ? null : new Date(sent + days * DAY).toISOString()
}

/** Every break the facts show. The order is stable: by rule, then by key. */
export function detectBreaks(facts: BreakFacts): Break[] {
  const out: Break[] = []
  const eventsOf = (row: ProposalRow): BreakEventFact[] => facts.events.get(row.id) ?? []
  const add = (found: Break) => out.push(found)

  duplicateCaptures(facts, add)
  for (const row of facts.proposals) {
    const events = eventsOf(row)
    const amount = money(row.amount_cents, row.currency)

    if (row.phase === 'capture_pending') {
      const since = phaseSince(row, events, ['capture.pending'])
      const age = ageOf(facts.now, since)
      if (age > PENDING_STALE_MS) {
        add({ key: `capture.pending_stale:${row.id}`, rule: 'capture.pending_stale', severity: 'warning', proposalId: row.id, title: `A ${amount} client payment has been pending for ${hoursWords(age)}`, detail: 'PayPal accepted this capture but has not finished it (an eCheck or a risk review). Nobody can be paid from it until it completes.', expected: 'completed within 6 hours', observed: `still pending after ${hoursWords(age)}`, deltaCents: null })
      }
    }

    if (row.phase === 'capture_reversed') {
      const arrived = arrivedCents(row)
      const funded = facts.proposals.filter((other) => other.kind === 'payment' && row.capture_id !== null && other.funding_capture_id === row.capture_id && ['captured', 'payout_sent', 'payout_unclaimed'].includes(other.phase))
      const wentOut = funded.reduce((sum, other) => sum + (other.captured_amount_cents ?? other.amount_cents), 0)
      add({
        key: `capture.reversed:${row.id}`, rule: 'capture.reversed', severity: 'critical', proposalId: row.id,
        title: wentOut > 0 ? `A ${money(arrived, row.currency)} client payment was taken back and ${money(wentOut, row.currency)} had already gone out` : `A ${money(arrived, row.currency)} client payment was taken back at PayPal`,
        detail: wentOut > 0 ? `PayPal reversed the capture (a chargeback or a refund made at PayPal). Payouts funded from it already left, so more went out than came in by ${money(wentOut, row.currency)}.` : 'PayPal reversed the capture (a chargeback or a refund made at PayPal). The books show the reversal; nothing was paid out of it.',
        expected: `${money(arrived, row.currency)} kept`, observed: wentOut > 0 ? `0 kept, ${money(wentOut, row.currency)} paid out of it` : '0 kept, taken back', deltaCents: -arrived,
      })
    }

    if (row.phase === 'mismatch_hold') {
      add({ key: `mismatch.held:${row.id}`, rule: 'mismatch.held', severity: 'critical', proposalId: row.id, title: `PayPal moved money that does not match the lock on a ${amount} request`, detail: 'The request is held. What PayPal reports (the amount or the currency) is not what was locked and approved, so nothing more will happen to it until a person decides.', expected: `${amount} as locked`, observed: row.captured_amount_cents !== null ? `PayPal reports ${money(row.captured_amount_cents, row.currency)}` : 'PayPal reports a different amount or currency', deltaCents: row.captured_amount_cents !== null ? row.captured_amount_cents - row.amount_cents : null })
    }

    if (row.phase === 'refund_pending') {
      const age = ageOf(facts.now, phaseSince(row, events, ['refund.pending']))
      if (age > PENDING_STALE_MS) {
        add({ key: `refund.pending_stale:${row.id}`, rule: 'refund.pending_stale', severity: 'warning', proposalId: row.id, title: `A ${amount} refund has been pending for ${hoursWords(age)}`, detail: 'PayPal accepted the refund but has not finished it. The client has not been paid back yet.', expected: 'completed within 6 hours', observed: `still pending after ${hoursWords(age)}`, deltaCents: null })
      }
    }

    // Rule 17. A refund that was filed and never tapped: the client is still waiting for money the books already set
    // aside for return. PayPal is not involved; the fault is that nobody decided the ask.
    if (row.kind === 'refund' && row.phase === 'pending_approval') {
      const age = ageOf(facts.now, phaseSince(row, events, ['proposal.created']))
      if (age > REFUND_OWNER_WAIT_MS) {
        add({ key: `refund.awaiting_owner:${row.id}`, rule: 'refund.awaiting_owner', severity: 'warning', proposalId: row.id, title: `A ${amount} refund has waited ${hoursWords(age)} without the owner's tap`, detail: 'A refund request was filed and is waiting for the owner\'s approval. The client has not been paid back yet; PayPal has not been asked for anything.', expected: 'decided within 7 days', observed: `undecided for ${hoursWords(age)}`, deltaCents: null })
      }
    }

    if (row.phase === 'payout_unclaimed') {
      const age = ageOf(facts.now, phaseSince(row, events, ['payout.unclaimed']))
      if (age > UNCLAIMED_AGING_MS) {
        add({ key: `payout.unclaimed_aging:${row.id}`, rule: 'payout.unclaimed_aging', severity: 'warning', proposalId: row.id, title: `A ${amount} payout has sat unclaimed for ${hoursWords(age)}`, detail: `Nobody has claimed this payout. PayPal returns unclaimed money to the sender after ${UNCLAIMED_RETURN_DAYS} days; cancelling it now returns the money and frees the reservation.`, expected: `claimed within 20 days (PayPal returns it at ${UNCLAIMED_RETURN_DAYS})`, observed: `unclaimed for ${hoursWords(age)}`, deltaCents: -row.amount_cents })
      }
    }

    if (row.phase === 'payout_failed' && row.payout_batch_id && !paidAgain(row, facts.proposals)) {
      add({ key: `payout.returned:${row.id}`, rule: 'payout.returned', severity: 'warning', proposalId: row.id, title: `A ${amount} payout was returned or failed`, detail: 'PayPal sent the payout and then returned it, or failed it. The money is back with the studio and the contractor has not been paid.', expected: `${amount} paid to the contractor`, observed: `${money(0, row.currency)} paid, money returned`, deltaCents: -row.amount_cents })
    }

    if (row.kind === 'charge' && row.phase === 'invoice_sent') {
      const days = facts.automation?.remindUnpaidAfterDays ?? DEFAULT_INVOICE_DAYS
      const sent = events.find((event) => event.type === 'invoice.sent')?.created_at ?? row.updated_at
      const due = invoiceDueAt(row, sent, days)
      if (due !== null && facts.now.getTime() > Date.parse(due)) {
        const late = facts.now.getTime() - Date.parse(due)
        add({ key: `invoice.overdue:${row.id}`, rule: 'invoice.overdue', severity: 'warning', proposalId: row.id, title: `A ${amount} invoice is ${hoursWords(late)} overdue`, detail: `The invoice was due ${due.slice(0, 10)} and PayPal has not seen a payment.`, expected: `paid by ${due.slice(0, 10)}`, observed: 'unpaid', deltaCents: row.amount_cents })
      }
    }

    if (row.phase === 'invoice_draft') {
      const age = ageOf(facts.now, phaseSince(row, events, ['invoice.created']))
      if (age > STUCK_DRAFT_MS) {
        add({ key: `invoice.stuck_draft:${row.id}`, rule: 'invoice.stuck_draft', severity: 'warning', proposalId: row.id, title: `A ${amount} invoice has been a draft for ${hoursWords(age)}`, detail: 'The invoice was created at PayPal but never sent, so the client cannot pay it.', expected: 'sent within 1 hour', observed: `still a draft after ${hoursWords(age)}`, deltaCents: null })
      }
    }

    if (row.phase === 'settled_short') {
      const age = ageOf(facts.now, phaseSince(row, events, ['invoice.partial', 'invoice.settled']))
      if (age > SHORT_AGING_MS) {
        const short = row.delta_cents !== null ? row.delta_cents : (row.settled_cents ?? 0) - row.amount_cents
        add({ key: `settlement.short_aging:${row.id}`, rule: 'settlement.short_aging', severity: 'warning', proposalId: row.id, title: `The client paid ${money(Math.abs(short), row.currency)} short ${hoursWords(age)} ago`, detail: 'The client paid less than was locked and the rest has not arrived.', expected: money(row.amount_cents, row.currency), observed: money(row.settled_cents ?? 0, row.currency), deltaCents: short })
      }
      // Rule 18. A part payment whose missing part PayPal does not explain, still missing days later. Nothing
      // attributes the gap, so it cannot be closed by itself: someone must chase the remainder, refund the paid
      // part, or write it off, and say which.
      if (row.delta_reason === 'partial') {
        const age = ageOf(facts.now, phaseSince(row, events, ['invoice.partial', 'invoice.settled']))
        if (age > PARTIAL_UNRESOLVED_MS) {
          const missing = row.amount_cents - (row.settled_cents ?? 0)
          add({ key: `invoice.partial_unresolved:${row.id}`, rule: 'invoice.partial_unresolved', severity: 'warning', proposalId: row.id, title: `A part payment of ${money(row.settled_cents ?? 0, row.currency)} on a ${amount} invoice has stayed part paid for ${hoursWords(age)}`, detail: 'The client paid part of the invoice and no PayPal field explains the missing part. It has not arrived either. Chase the remainder with PayPal\'s reminder, refund the paid part, or write it off.', expected: `${money(row.amount_cents, row.currency)} arrived`, observed: `${money(row.settled_cents ?? 0, row.currency)} arrived, ${money(missing, row.currency)} still outstanding`, deltaCents: missing })
        }
      }
    }

    if (row.phase === 'capture_inflight') {
      const lease = facts.inflightMs ?? DEFAULT_INFLIGHT_MS
      const age = ageOf(facts.now, row.updated_at)
      if (age > lease) {
        add({ key: `inflight.stalled:${row.id}`, rule: 'inflight.stalled', severity: 'warning', proposalId: row.id, title: `A ${amount} request has been stuck settling for ${age >= HOUR ? hoursWords(age) : `${Math.round(age / 60_000)} minutes`}`, detail: 'A worker marked this request "settling" and never finished. A crash or a lost answer leaves it here; recovery either puts it back or resumes the same PayPal call.', expected: `settled within ${Math.round(lease / 1000)} seconds`, observed: `settling for ${Math.round(age / 1000)} seconds`, deltaCents: null })
      }
    }
  }

  refundsExceed(facts, add)
  booksDrift(facts, add)
  disputesOpen(facts, add)
  disputesOverdue(facts, add)
  feeAnomalies(facts, add)
  paypalDiffers(facts, add)
  return out.sort((a, b) => a.rule.localeCompare(b.rule) || a.key.localeCompare(b.key))
}

/** A later payout to the same person for the same job and amount that did go through: the failed one was made good. */
function paidAgain(row: ProposalRow, all: ProposalRow[]): boolean {
  return all.some((other) => other.id !== row.id && other.kind === 'payment' && other.payee_id === row.payee_id && other.job_id === row.job_id && other.amount_cents === row.amount_cents && other.currency === row.currency && fullPhase(other.phase) && other.created_at > row.created_at)
}

/** Rule 1. Two paid charges for the same client, amount, currency (and job) within a day: the client may have paid twice. */
function duplicateCaptures(facts: BreakFacts, add: (found: Break) => void): void {
  const paid = facts.proposals.filter((row) => row.kind === 'charge' && FUNDED_PHASES.includes(row.phase as never) && row.capture_id !== null)
  const groups = new Map<string, Array<{ row: ProposalRow; at: number }>>()
  for (const row of paid) {
    const events = facts.events.get(row.id) ?? []
    const at = Date.parse(phaseSince(row, events, ['capture.completed']))
    const key = [row.payee_id ?? '', arrivedCents(row), row.currency, row.job_id ?? ''].join('|')
    const group = groups.get(key)
    if (group) group.push({ row, at })
    else groups.set(key, [{ row, at }])
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.at - b.at || a.row.id.localeCompare(b.row.id))
    group.forEach((entry, index) => {
      const earlier = group.slice(0, index).find((other) => entry.at - other.at <= DUPLICATE_WINDOW_MS && !differentMilestones(other.row, entry.row))
      if (!earlier) return
      // Refunded (or being refunded) in full: the duplicate was dealt with. A refund still waiting for approval has not dealt with it.
      const refunded = facts.proposals.filter((other) => other.kind === 'refund' && other.parent_capture_id === entry.row.capture_id && ['capture_inflight', 'refund_pending', 'refunded'].includes(other.phase)).reduce((sum, other) => sum + other.amount_cents, 0)
      if (refunded >= arrivedCents(entry.row)) return
      const cents = arrivedCents(entry.row)
      add({ key: `capture.duplicate:${entry.row.id}`, rule: 'capture.duplicate', severity: 'critical', proposalId: entry.row.id, title: `${money(cents, entry.row.currency)} may have been paid twice`, detail: `Two charges for the same client, amount and job were paid within 24 hours (this one, and ${earlier.row.id}). If the client meant to pay once, the later one should be refunded.`, expected: 'one payment', observed: 'two payments within 24 hours', deltaCents: cents })
    })
  }
}

/** Two milestones of one deal are different charges that happen to cost the same: not a duplicate. */
function differentMilestones(a: ProposalRow, b: ProposalRow): boolean {
  return a.deal_id !== null && b.deal_id !== null && (a.deal_id !== b.deal_id || a.milestone !== b.milestone)
}

/** Rule 6. Refunds held against one capture add up to more than it captured, cross-checked with what the books booked. */
function refundsExceed(facts: BreakFacts, add: (found: Break) => void): void {
  const bookedRefunds = new Map<string, number>()
  const bookedReceipt = new Map<string, number>()
  for (const entry of facts.journal) {
    if (entry.purpose === 'refund') bookedRefunds.set(entry.proposal_id, (bookedRefunds.get(entry.proposal_id) ?? 0) + entry.delta_cents)
    if (entry.purpose === 'receipt') bookedReceipt.set(entry.proposal_id, (bookedReceipt.get(entry.proposal_id) ?? 0) + entry.delta_cents)
  }
  for (const charge of facts.proposals) {
    if (charge.kind !== 'charge' || !charge.capture_id) continue
    const refunds = facts.proposals.filter((row) => row.kind === 'refund' && row.parent_capture_id === charge.capture_id && REFUND_HELD_PHASES.includes(row.phase as never))
    const held = refunds.reduce((sum, row) => sum + row.amount_cents, 0)
    const captured = arrivedCents(charge)
    const booked = refunds.reduce((sum, row) => sum + (bookedRefunds.get(row.id) ?? 0), 0)
    const receipt = bookedReceipt.get(charge.id) ?? 0
    if (held > captured || (booked > 0 && booked > receipt)) {
      const over = Math.max(held - captured, booked - receipt)
      add({ key: `refund.exceeds:${charge.id}`, rule: 'refund.exceeds', severity: 'critical', proposalId: charge.id, title: `Refunds against one ${money(captured, charge.currency)} payment add up to ${money(held, charge.currency)}`, detail: `More is held for refund than the capture brought in. The books booked ${money(booked, charge.currency)} of refunds against ${money(receipt, charge.currency)} received.`, expected: `at most ${money(captured, charge.currency)} refunded`, observed: `${money(held, charge.currency)} held for refund`, deltaCents: over })
    }
  }
}

/** Rule 13. For every request the books say what its row says moved, and the journal chain is whole. */
function booksDrift(facts: BreakFacts, add: (found: Break) => void): void {
  const posted = new Map<string, number>()
  let prev = GENESIS_HASH
  let chain: string | null = null
  facts.journal.forEach((entry, index) => {
    const sum = entry.postings.reduce((total, leg) => total + leg.amountCents, 0)
    if (chain === null) {
      if (sum !== 0 || entry.postings.length < 2) chain = `journal entry ${entry.seq} does not balance (${sum} cents)`
      else if (entry.seq !== index + 1) chain = `journal entry ${entry.seq} is out of sequence: an entry before it is missing`
      else if (entry.prev_hash !== prev || entry.hash !== journalHash(prev, { id: entry.id, seq: entry.seq, proposalId: entry.proposal_id, purpose: entry.purpose, currency: entry.currency, deltaCents: entry.delta_cents, memo: entry.memo, createdAt: entry.created_at }, entry.postings)) chain = `journal entry ${entry.seq} breaks the hash chain: it or an entry before it was changed`
    }
    prev = entry.hash
    const key = `${entry.proposal_id}|${entry.purpose}`
    posted.set(key, (posted.get(key) ?? 0) + entry.delta_cents)
  })
  if (chain !== null) {
    add({ key: 'books.drift:chain', rule: 'books.drift', severity: 'critical', proposalId: null, title: 'The books no longer form an unbroken chain', detail: chain, expected: 'every entry balanced, in sequence and hash-chained', observed: chain, deltaCents: null })
  }
  for (const row of facts.proposals) {
    for (const target of ledgerTargets(row)) {
      const booked = posted.get(`${row.id}|${target.purpose}`) ?? 0
      if (booked !== target.cents) {
        add({ key: `books.drift:${row.id}:${target.purpose}`, rule: 'books.drift', severity: 'critical', proposalId: row.id, title: `The books disagree with a request on ${target.purpose.replace('_', ' ')}`, detail: `The request says ${money(target.cents, row.currency)} for ${target.purpose}, the journal booked ${money(booked, row.currency)}.`, expected: money(target.cents, row.currency), observed: money(booked, row.currency), deltaCents: booked - target.cents })
      }
    }
  }
}

/** Rule 14. A client dispute on a payment whose payouts already left, or are held waiting on it. */
function disputesOpen(facts: BreakFacts, add: (found: Break) => void): void {
  for (const dispute of facts.disputes) {
    if (dispute.status === 'RESOLVED') continue
    const charge = facts.proposals.find((row) => row.kind === 'charge' && row.capture_id === dispute.transactionId)
    if (!charge) continue
    const payouts = facts.proposals.filter((row) => row.kind === 'payment' && row.funding_capture_id === charge.capture_id && ['payout_sent', 'payout_unclaimed', 'captured', 'locked', 'order_created', 'capture_inflight', 'pending_approval'].includes(row.phase))
    if (payouts.length === 0) continue
    const left = payouts.filter((row) => ['payout_sent', 'payout_unclaimed', 'captured'].includes(row.phase)).reduce((sum, row) => sum + row.amount_cents, 0)
    const held = payouts.length
    // PayPal's due date is not stored with the dispute, so it is assumed to be ten days after it opened.
    const opened = dispute.openedAt ?? dispute.updatedAt
    const due = Date.parse(opened) + DISPUTE_RESPONSE_DAYS * DAY
    const soon = !Number.isNaN(due) && due - facts.now.getTime() <= DISPUTE_SOON_MS
    const cents = dispute.amountCents ?? arrivedCents(charge)
    add({ key: `dispute.open:${dispute.disputeId}`, rule: 'dispute.open', severity: soon ? 'critical' : 'warning', proposalId: charge.id, title: `A ${money(cents, charge.currency)} client dispute is open and ${left > 0 ? `${money(left, charge.currency)} already went out` : `${held} payout${held === 1 ? ' is' : 's are'} held`}`, detail: `Dispute ${dispute.disputeId}${dispute.reason ? ` (${dispute.reason})` : ''} is ${dispute.status}. Response assumed due ${Number.isNaN(due) ? 'unknown' : new Date(due).toISOString().slice(0, 10)} (ten days after it opened: PayPal's own due date is not stored here).`, expected: 'no open dispute on money already paid out', observed: `${dispute.status}, ${left > 0 ? `${money(left, charge.currency)} paid out` : `${held} held`}`, deltaCents: left > 0 ? -left : null })
  }
}

/** Rule 16. An open dispute whose answer is already late. `dispute.open` needs payouts to matter; this one does not,
 * because while a dispute waits for an answer the money it names is held in this PayPal account either way. PayPal
 * does not store a due date here, so the response is assumed to have been due ten days after it opened. */
function disputesOverdue(facts: BreakFacts, add: (found: Break) => void): void {
  for (const dispute of facts.disputes) {
    if (dispute.status === 'RESOLVED') continue
    const charge = facts.proposals.find((row) => row.kind === 'charge' && row.capture_id === dispute.transactionId)
    if (!charge) continue
    const opened = dispute.openedAt ?? dispute.updatedAt
    const due = Date.parse(opened) + DISPUTE_RESPONSE_DAYS * DAY
    if (Number.isNaN(due) || due > facts.now.getTime()) continue
    const late = facts.now.getTime() - due
    const cents = dispute.amountCents ?? arrivedCents(charge)
    add({ key: `dispute.response_overdue:${dispute.disputeId}`, rule: 'dispute.response_overdue', severity: 'critical', proposalId: charge.id, title: `A ${money(cents, charge.currency)} dispute has gone ${hoursWords(late)} past the day a response was due`, detail: `Dispute ${dispute.disputeId} opened ${Number.isNaN(Date.parse(opened)) ? 'at an unknown time' : opened.slice(0, 10)} and PayPal does not store its due date here, so it was assumed due ${new Date(due).toISOString().slice(0, 10)} (ten days later). Past that day PayPal may decide by default, and its default favours the client. Answer it in the dispute desk.`, expected: `a response by ${new Date(due).toISOString().slice(0, 10)}`, observed: 'no response sent', deltaCents: -cents })
  }
}

/** Rule 19. PayPal's own fee on a capture is heavier than the plan's share of what arrived (plus a small fixed
 * allowance), and the payment is big enough for the fixed part of the plan never to explain it. A fee a wrong
 * charge plan, a currency conversion or a promo swallowed is money a receipt cannot attribute. */
function feeAnomalies(facts: BreakFacts, add: (found: Break) => void): void {
  for (const row of facts.proposals) {
    if (row.kind !== 'charge' || row.capture_id === null || row.capture_fee_cents === null || row.capture_fee_cents <= 0) continue
    const arrived = arrivedCents(row)
    if (arrived < FEE_ANOMALY_MIN_CENTS) continue
    const ceiling = Math.round((FEE_ANOMALY_BPS * arrived) / 10_000) + FEE_ANOMALY_FIXED_CENTS
    if (row.capture_fee_cents <= ceiling) continue
    const share = (row.capture_fee_cents / arrived) * 10_000
    add({ key: `fees.anomaly:${row.id}`, rule: 'fees.anomaly', severity: 'warning', proposalId: row.id, title: `PayPal's fee on a ${money(arrived, row.currency)} payment is ${(share / 100).toFixed(2)}%, heavier than the ${(FEE_ANOMALY_BPS / 100).toFixed(1)}% a plan would take`, detail: `PayPal charged ${money(row.capture_fee_cents, row.currency)} on ${money(arrived, row.currency)} that arrived. A fee this heavy next to the plan's share can mean a wrong charge plan, a currency conversion or something else PayPal has not said; it is money the receipt cannot attribute. Read the fee on PayPal's side, or answer why.`, expected: `at most ${money(ceiling, row.currency)} (${(FEE_ANOMALY_BPS / 100).toFixed(1)}% plus a fixed allowance)`, observed: `${money(row.capture_fee_cents, row.currency)}`, deltaCents: row.capture_fee_cents - ceiling })
  }
}

/** Rule 15. From PayPal's own transaction list: money Mandate did not move, and requests whose PayPal money does not add up. */
function paypalDiffers(facts: BreakFacts, add: (found: Break) => void): void {
  const activity = facts.activity
  if (!activity) return
  const byRequest = new Map<string, typeof activity.rows>()
  for (const txn of activity.rows) {
    if (txn.proposalId === null) {
      add({ key: `paypal.unknown_or_differs:${txn.id}`, rule: 'paypal.unknown_or_differs', severity: 'warning', proposalId: null, title: `PayPal shows ${money(txn.cents, txn.currency)} that Mandate did not move`, detail: `PayPal transaction ${txn.id} (${txn.eventCode ?? 'no event code'}${txn.subject ? `, "${txn.subject}"` : ''}) matches no request. It may be money moved outside Mandate. PayPal's report lags by hours, so a very recent one of ours can show here for a short while.`, expected: 'every PayPal transaction belongs to a request', observed: `unmatched ${money(txn.cents, txn.currency)}`, deltaCents: txn.cents })
      continue
    }
    const group = byRequest.get(txn.proposalId)
    if (group) group.push(txn)
    else byRequest.set(txn.proposalId, [txn])
  }
  for (const [proposalId, rows] of byRequest) {
    const first = rows[0]!
    if (first.balanced !== false || first.expectedCents === null) continue
    const seen = rows.reduce((sum, row) => sum + row.cents, 0)
    const currency = first.expectedCurrency ?? first.currency
    add({ key: `paypal.unknown_or_differs:${proposalId}`, rule: 'paypal.unknown_or_differs', severity: 'critical', proposalId, title: `PayPal and the books disagree by ${money(Math.abs(seen - first.expectedCents), currency)}`, detail: `PayPal's transactions for this request add up to ${money(seen, first.currency)} and the books hold ${money(first.expectedCents, currency)}${first.expectedCurrency && first.expectedCurrency !== first.currency ? ` (currencies differ: ${first.currency} against ${first.expectedCurrency})` : ''}.`, expected: money(first.expectedCents, currency), observed: money(seen, first.currency), deltaCents: seen - first.expectedCents })
  }
}
