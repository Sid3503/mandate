/**
 * Why the money that arrived is not the money that was locked, answered only from PayPal's own fields.
 *
 * The product's promise is that no number on a receipt is unattributed. A settlement delta is the number that
 * needs an attribution most: it is the gap between what the owner authorised and what a client actually paid.
 * So the reason is read from the PayPal object we received, by name, and a code may only be earned when the
 * field behind it is present. A percentage is not a number of cents, so a percentage alone can never explain a
 * cents gap: only an amount PayPal itself states can. An absent field means unknown, never zero.
 *
 * Two questions live here, and they are different questions:
 * `explainTotal` asks whether an invoice whose total is not the locked amount is still ours, which decides
 * whether to refuse. `explainDelta` asks why what arrived fell short, which decides what to record.
 */

/** The closed set of reasons a settlement can carry. A code with no field behind it is never written. */
export type DeltaReason = 'full' | 'early_discount' | 'credit_note' | 'paypal_fee' | 'partial' | 'unexplained'

/** The PayPal field a reason was read from. Null when PayPal reported nothing that could explain a gap. */
export type DeltaSource =
  | 'early_payment_discount'
  | 'amount.breakdown.discount'
  | 'payments.transactions[].fee'
  | 'payments.paid_amount'
  | null

/** What PayPal reported about one invoice. Null means PayPal did not report that field, which is not the same as zero. */
export type InvoiceMoney = {
  /** `amount.value`: what the invoice asks for. */
  totalCents: number
  /** `payments.paid_amount`: what PayPal says the payer has paid. */
  paidCents: number
  /** `amount.breakdown.discount`: an invoice-level discount, when PayPal states it as an amount. */
  discountCents: number | null
  /** `early_payment_discount`: present only when PayPal says the rule was applied (`is_applied`). */
  earlyDiscountCents: number | null
  /** A fee PayPal reported on the payment. PayPal does not always report it, so absent is unknown. */
  feeCents: number | null
}

export type Settlement = {
  reason: DeltaReason
  source: DeltaSource
  /** Cents PayPal reported arrived. Zero when nothing did. */
  settledCents: number
}

/**
 * The reasons a PayPal field stands behind, so `amounts.explained` can check a stored reason without re-reading
 * PayPal. `unexplained` is deliberately not one: nothing arrived, so nothing can be attributed, and a row is
 * never moved to a settled phase on it.
 */
export const ATTRIBUTED_REASONS: readonly DeltaReason[] = ['early_discount', 'credit_note', 'paypal_fee', 'partial']

/** The one field each reason is read from, so a stored reason and a stored source can be checked against each other. */
export const SOURCE_OF: Record<DeltaReason, DeltaSource> = {
  full: null,
  early_discount: 'early_payment_discount',
  credit_note: 'amount.breakdown.discount',
  paypal_fee: 'payments.transactions[].fee',
  partial: 'payments.paid_amount',
  unexplained: null,
}

/**
 * The adjustment fields, in the order that decides which name wins when two of them could account for the same
 * gap. The conditional early-payment rule comes first because it is the more specific claim: it says PayPal
 * applied a named rule, where an invoice-level discount says only that the bill itself was reduced.
 */
const ADJUSTMENTS: ReadonlyArray<{ reason: DeltaReason; source: DeltaSource; cents: (money: InvoiceMoney) => number | null }> = [
  { reason: 'early_discount', source: 'early_payment_discount', cents: (money) => money.earlyDiscountCents },
  { reason: 'credit_note', source: 'amount.breakdown.discount', cents: (money) => money.discountCents },
  { reason: 'paypal_fee', source: 'payments.transactions[].fee', cents: (money) => money.feeCents },
]

/**
 * The adjustment that accounts for exactly this many cents, or null. A field that only partly explains a gap
 * does not explain it: claiming a discount for a difference it does not cover would be the product's own
 * unattributed number.
 */
function adjustmentFor(gapCents: number, money: InvoiceMoney) {
  if (gapCents <= 0) return null
  for (const candidate of ADJUSTMENTS) {
    if (candidate.cents(money) === gapCents) return candidate
  }
  return null
}

/** Why what arrived is not what was locked. */
export function explainDelta(lockedCents: number, money: InvoiceMoney): Settlement {
  if (money.paidCents >= lockedCents) return { reason: 'full', source: null, settledCents: money.paidCents }
  if (money.paidCents <= 0) return { reason: 'unexplained', source: null, settledCents: 0 }
  const adjustment = adjustmentFor(lockedCents - money.paidCents, money)
  if (adjustment) return { reason: adjustment.reason, source: adjustment.source, settledCents: money.paidCents }
  // Money really arrived and no PayPal field says why it fell short. That is a closed fact, not a guess:
  // PayPal's own partly-paid amount is the field behind it.
  return { reason: 'partial', source: SOURCE_OF.partial, settledCents: money.paidCents }
}

/**
 * Whether an invoice whose total is not the locked amount is still ours. A discount PayPal carries accounts for
 * the difference, and the invoice settles. Anything else, including a total above the lock, is a different bill
 * and is refused. Returns null when no field accounts for the difference.
 */
export function explainTotal(lockedCents: number, money: InvoiceMoney): { reason: DeltaReason; source: DeltaSource } | null {
  const adjustment = adjustmentFor(lockedCents - money.totalCents, money)
  return adjustment ? { reason: adjustment.reason, source: adjustment.source } : null
}
