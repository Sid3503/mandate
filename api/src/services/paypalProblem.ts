import { Problem } from '../http/problem'
import { PayPalError } from '../paypal/port'

/**
 * What a failed PayPal call means to a person. PayPal answering "no" (a bad request, a forbidden account) is
 * `paypal.upstream`: nothing moved, and the debug id is for PayPal's support. PayPal not answering at all (a timeout, a
 * 5xx, our own breaker being open) is `paypal.unavailable`: the call may be repeated safely later, a sweep does so on
 * its own, and the request keeps its place. The two need different words and different buttons.
 */
export function paypalProblem(error: unknown, action: string, extensions: Record<string, unknown> = {}): Problem {
  const paypal = error instanceof PayPalError ? error : null
  const notAnswering = !paypal || paypal.httpStatus === 429 || paypal.httpStatus >= 500
  if (notAnswering) {
    return new Problem(503, 'paypal.unavailable', 'PayPal is not answering', `PayPal did not answer when Mandate tried ${action}. Nothing was lost: the request keeps its place and Mandate tries again by itself.`, { retryable: true, ...extensions })
  }
  return new Problem(502, 'paypal.upstream', `PayPal rejected ${action}`, paypal.paypalName, { ...extensions, debugId: paypal.debugId })
}
