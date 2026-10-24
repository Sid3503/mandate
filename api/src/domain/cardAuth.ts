/**
 * Whether a card payment may be captured, from the issuer's 3-D Secure answer. A pure function of what PayPal reports
 * on the order (`payment_source.card.authentication_result`), following PayPal's table of recommended actions:
 * https://developer.paypal.com/docs/checkout/advanced/customize/3d-secure/response-parameters/
 *
 * 3-D Secure is how a card issuer confirms the cardholder (a one-time code, a banking app). Where the law requires it
 * (PSD2 in Europe and the UK, the RBI's additional factor in India, and others), a card payment without it is
 * declined, and where it succeeded the issuer, not the studio, carries the fraud liability. The browser reports a
 * result too, but the browser can lie; the server reads it from PayPal and decides here.
 */

export type CardAuthentication = {
  /** YES, POSSIBLE, NO or UNKNOWN. */
  liabilityShift: string | null
  /** Y (enrolled), N (not enrolled), U (unavailable), B (bypassed). */
  enrollment: string | null
  /** Y, N, R (rejected), A (attempted), U (unable), C (challenge required), I (information only). */
  status: string | null
}

export type CardDecision =
  | { action: 'capture'; liabilityShifted: boolean; why: string }
  | { action: 'retry'; why: string }
  | { action: 'refuse'; why: string }

export function cardAuthDecision(auth: CardAuthentication | null): CardDecision {
  // No authentication was asked for: the card's region does not require it, so PayPal approved the card without it.
  if (!auth || (!auth.liabilityShift && !auth.enrollment && !auth.status)) {
    return { action: 'capture', liabilityShifted: false, why: 'The card was approved without a bank check: none was required for it.' }
  }
  const shift = (auth.liabilityShift ?? '').toUpperCase()
  const enrolled = (auth.enrollment ?? '').toUpperCase()
  const status = (auth.status ?? '').toUpperCase()
  if (shift === 'YES' || shift === 'POSSIBLE') {
    return { action: 'capture', liabilityShifted: true, why: 'The card\'s bank confirmed the cardholder.' }
  }
  if (shift === 'UNKNOWN') return { action: 'retry', why: 'The card\'s bank could not be reached to confirm the cardholder. Try again, or use another card.' }
  if (shift === 'NO') {
    if (enrolled === 'Y') {
      if (status === 'N' || status === 'R') return { action: 'refuse', why: 'The card\'s bank did not confirm the cardholder. Nothing was charged.' }
      return { action: 'retry', why: 'The bank check did not finish. Try again, or use another card. Nothing was charged.' }
    }
    // Not enrolled, unavailable or bypassed: PayPal recommends going ahead, without the issuer taking the liability.
    if (enrolled === 'N' || enrolled === 'U' || enrolled === 'B') return { action: 'capture', liabilityShifted: false, why: 'The card does not take part in the bank check, so it was charged without one.' }
  }
  return { action: 'retry', why: 'The bank check gave an answer we do not recognise. Try again, or use another card. Nothing was charged.' }
}
