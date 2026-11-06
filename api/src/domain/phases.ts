/**
 * What a phase means, in one place.
 *
 * A phase records what PayPal has told us happened to the money. `captured` and `settled_short` are the two ways
 * money has arrived: the lock in full, or less than the lock. Every question of the form "has this settled?" or
 * "is this still open?" asks one of the named sets below, so a phase value added once is understood by every reader
 * instead of being a fourth literal in forty hand-written comparisons.
 *
 * One comparison is deliberately left raw and must stay that way: `amounts.match` in `services/audit.ts` asks
 * whether the cents equal the lock. That is true of `captured` and false of `settled_short` by construction, so it
 * is a question about the amount, not about the phase, and it is marked at its own line.
 */

/** The lock was paid in full, to the cent. */
export const FULL_PHASES = ['captured'] as const

/** Money moved for this request: paid in full, paid short, or refunded. */
export const PAID_PHASES = ['captured', 'refunded', 'settled_short'] as const

/** Money arrived and is still with the studio, so a payout may cite it and a refund may reverse it. */
export const FUNDED_PHASES = ['captured', 'settled_short'] as const

/** Less than the lock arrived. What a shortfall's reason was read from is on the row, in `delta_source`. */
export const SHORT_PHASES = ['settled_short'] as const

/**
 * Nothing has finished yet: waiting, locked, sent, out, or unclaimed. `capture_pending` and `refund_pending` are money
 * PayPal accepted but has not finished moving (an eCheck, a risk review). `mismatch_hold` is money PayPal moved that does
 * not match the lock: it needs a person, so it stays open and in everyone's way until one looks.
 */
export const OPEN_PHASES = ['pending_approval', 'locked', 'order_created', 'authorized', 'capture_inflight', 'capture_pending', 'invoice_draft', 'invoice_sent', 'payout_sent', 'payout_unclaimed', 'refund_pending', 'mismatch_hold'] as const

/** A billed milestone stays billed unless the request that billed it was refused, thrown away, or declined by PayPal. */
export const DEAD_PHASES = ['denied', 'rejected', 'capture_refused', 'invoice_cancelled', 'capture_failed', 'refund_failed', 'voided'] as const

/**
 * A payout's money is spoken for: locked, sent to PayPal, or paid. A payout held on a mismatch stays reserved: PayPal
 * may already have paid it, so releasing its headroom would let the same money be promised twice.
 */
export const RESERVED_PHASES = ['locked', 'order_created', 'capture_inflight', 'payout_sent', 'payout_unclaimed', 'captured', 'mismatch_hold'] as const

/** A refund that holds part of its capture: asked for, approved, being sent, waiting at PayPal, or done. */
export const REFUND_HELD_PHASES = ['pending_approval', 'locked', 'order_created', 'capture_inflight', 'refund_pending', 'refunded'] as const

/**
 * Every phase a request can be in, and every move between two of them. This is the state machine. The database holds a
 * copy (refreshed at every boot) and a trigger refuses any write that is not on this list, so a stale read that would
 * move a paid row back to "sent", or a cancelled invoice over a paid one, fails loudly instead of silently rewinding the
 * money. A move to the same phase is always allowed: it is a re-read that learned nothing new.
 */
export const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  pending_approval: ['locked', 'rejected', 'denied'],
  locked: ['capture_inflight', 'order_created', 'capture_refused', 'rejected'],
  order_created: ['capture_inflight', 'captured', 'capture_pending', 'capture_failed', 'capture_refused', 'mismatch_hold', 'rejected', 'authorized'],
  // A hold: PayPal reserved the client's money on an AUTHORIZE order, and none of it has reached the studio. It is
  // captured (the client approved the work, or the review window they agreed to ran out), or voided (the client was
  // never charged). A hold is not money: no payout may cite it, because it is not funded until it is captured.
  authorized: ['capture_inflight', 'captured', 'capture_pending', 'capture_failed', 'mismatch_hold', 'voided'],
  capture_inflight: [
    'locked', 'order_created', 'authorized', 'invoice_draft', 'invoice_sent', 'invoice_cancelled', 'payout_sent', 'payout_unclaimed', 'payout_failed',
    'captured', 'settled_short', 'capture_pending', 'capture_failed', 'capture_refused', 'mismatch_hold',
    'refunded', 'refund_pending', 'refund_failed', 'voided',
  ],
  capture_pending: ['captured', 'capture_failed', 'capture_reversed'],
  invoice_draft: ['invoice_sent', 'capture_inflight', 'invoice_cancelled', 'captured', 'settled_short', 'capture_refused'],
  invoice_sent: ['capture_inflight', 'captured', 'settled_short', 'invoice_cancelled', 'capture_refused'],
  settled_short: ['captured', 'capture_refused', 'capture_reversed'],
  payout_sent: ['capture_inflight', 'captured', 'payout_unclaimed', 'payout_failed', 'mismatch_hold'],
  payout_unclaimed: ['capture_inflight', 'captured', 'payout_failed', 'mismatch_hold'],
  // A paid charge can still be taken back (a chargeback, a refund made at PayPal). A paid payout can still come back
  // (RETURNED, REVERSED). Both are recorded; neither is allowed to pretend the money never arrived.
  captured: ['capture_reversed', 'payout_failed'],
  refund_pending: ['refunded', 'refund_failed'],
  // Final. A person decides what happens next, by filing a new request.
  mismatch_hold: [],
  denied: [],
  rejected: [],
  capture_refused: [],
  capture_failed: [],
  capture_reversed: [],
  invoice_cancelled: [],
  // Final. The hold was released back to the client: nothing was charged.
  voided: [],
  payout_failed: [],
  refunded: [],
  refund_failed: [],
}

export const ALL_PHASES: readonly string[] = Object.keys(TRANSITIONS)

/** True when a request may move from one phase to the other. Staying put is always allowed. */
export function canTransition(from: string, to: string): boolean {
  return from === to || (TRANSITIONS[from]?.includes(to) ?? false)
}

/**
 * An invoice the server still re-reads from PayPal. A short payment keeps its invoice watched, so a later payment
 * that completes the lock is still seen, and a reason code added later can still explain a row an earlier code
 * could only call unexplained.
 */
export const INVOICE_WATCH_PHASES = ['invoice_draft', 'invoice_sent', 'settled_short'] as const

const members = (phases: readonly string[]) => new Set<string>(phases)
const full = members(FULL_PHASES)
const paid = members(PAID_PHASES)
const funded = members(FUNDED_PHASES)
const short = members(SHORT_PHASES)
const watched = members(INVOICE_WATCH_PHASES)

/** The lock was paid in full, to the cent. */
export const fullPhase = (phase: string): boolean => full.has(phase)
/** Money moved for this request: paid in full, paid short, or refunded. */
export const paidPhase = (phase: string): boolean => paid.has(phase)
/** Money arrived and is still with the studio, so a payout may cite it and a refund may reverse it. */
export const fundedPhase = (phase: string): boolean => funded.has(phase)
/** Less than the lock arrived. */
export const shortPhase = (phase: string): boolean => short.has(phase)
/** An invoice the server still re-reads from PayPal. */
export const watchedInvoicePhase = (phase: string): boolean => watched.has(phase)

/**
 * Cents PayPal has actually put in for this request. Both settlement paths write `settled_cents`, so it is the one
 * field that answers this. `captured_amount_cents` is the fallback for a payout, which records its paid amount there
 * and never settles through an invoice.
 */
export function arrivedCents(row: { settled_cents: number | null; captured_amount_cents: number | null }): number {
  return row.settled_cents ?? row.captured_amount_cents ?? 0
}

/**
 * The cents this request should show on PayPal's side, signed the way PayPal's own transaction report signs money:
 * a client charge is positive, a payout or a refund is negative. What actually arrived wins over the lock, so a
 * short settlement is compared against the money that really moved rather than against a lock it never met, and a
 * known shortfall is not re-flagged as a disagreement. `amount_cents` is the fallback for money still in flight.
 */
export function expectedSignedCents(row: { kind: string; amount_cents: number; captured_amount_cents: number | null; settled_cents: number | null }): number {
  const cents = row.settled_cents ?? row.captured_amount_cents ?? row.amount_cents
  return row.kind === 'charge' ? cents : -cents
}

/** A phase list as the inside of a SQL `IN (...)`. */
export const sqlList = (phases: readonly string[]): string => phases.map((phase) => `'${phase}'`).join(', ')
