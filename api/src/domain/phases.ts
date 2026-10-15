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

/** Nothing has finished yet: waiting, locked, sent, out, or unclaimed. */
export const OPEN_PHASES = ['pending_approval', 'locked', 'order_created', 'capture_inflight', 'invoice_draft', 'invoice_sent', 'payout_sent', 'payout_unclaimed'] as const

/** A billed milestone stays billed unless the request that billed it was refused or thrown away. */
export const DEAD_PHASES = ['denied', 'rejected', 'capture_refused', 'invoice_cancelled'] as const

/** A payout's money is spoken for: locked, sent to PayPal, or paid. */
export const RESERVED_PHASES = ['locked', 'order_created', 'capture_inflight', 'payout_sent', 'payout_unclaimed', 'captured'] as const

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

/** A phase list as the inside of a SQL `IN (...)`. */
export const sqlList = (phases: readonly string[]): string => phases.map((phase) => `'${phase}'`).join(', ')
