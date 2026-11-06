export type CreatedOrder = {
  orderId: string
  status: string
  approveUrl: string | null
  payeeAttached: boolean
}

export type CardOnOrder = {
  brand: string | null
  lastDigits: string | null
  authentication: { liabilityShift: string | null; enrollment: string | null; status: string | null } | null
}

export type LiveOrder = {
  orderId: string
  status: string
  amountCents: number
  currency: string
  customId: string | null
  approveUrl: string | null
  /**
   * The capture PayPal already holds on this order, when it has one. An order that reads COMPLETED was captured; this
   * is how a capture whose answer was lost (a timeout, a crash) is recovered without asking PayPal to capture again.
   */
  capture?: CapturedPayment | null
  /** The hold PayPal placed on this order, when it was opened to AUTHORIZE and has been authorized. */
  authorization?: HeldPayment | null
}

export type CapturedPayment = {
  captureId: string
  amountCents: number
  currency: string
  status: string
  /** What PayPal said it took on this capture (`seller_receivable_breakdown.paypal_fee`). Null when it said nothing. */
  feeCents: number | null
  /** What PayPal said reached the seller (`seller_receivable_breakdown.net_amount`). Null when it said nothing. */
  netCents: number | null
  /** Why a capture is PENDING or DECLINED (`status_details.reason`), when PayPal says. */
  statusReason?: string | null
}

export type RefundedPayment = {
  refundId: string
  /** COMPLETED, PENDING, FAILED or CANCELLED. Only COMPLETED means the money went back. */
  status: string
  statusReason?: string | null
}

export type SentPayout = {
  batchId: string
  status: string
}

/** What PayPal says about a payout batch of one item. `item` is null while PayPal has not listed it yet. */
export type LivePayout = {
  batchId: string
  batchStatus: string
  item: {
    itemId: string
    senderItemId: string | null
    status: string
    transactionId: string | null
    amountCents: number
    currency: string
    feeCents: number | null
    errorName: string | null
    receiver: string | null
  } | null
}

/**
 * A hold: PayPal reserved the buyer's money on an order opened with `intent: AUTHORIZE`, and nothing reached the
 * studio yet. It is captured (the money moves) or voided (the buyer was never charged). PayPal honours the funds for
 * three days and keeps the authorization valid for twenty-nine; `honorUntil` and `expiresAt` say when, as PayPal
 * reported them where it did, and as PayPal's documented windows where it did not.
 */
export type HeldPayment = {
  authorizationId: string
  /** CREATED or PENDING are a live hold. CAPTURED, VOIDED, EXPIRED and DENIED are not. */
  status: string
  amountCents: number
  currency: string
  customId: string | null
  /** When PayPal stops honouring the funds (end of the honor period). */
  honorUntil: string | null
  /** When the authorization itself expires and can no longer be captured. */
  expiresAt: string | null
  payerEmail: string | null
}

import type { UpstreamStatus } from './resilience'

export type PayPalPort = {
  /** How PayPal has been answering lately. Absent on a fake. */
  upstream?(): UpstreamStatus
  /**
   * A browser-safe token for the JavaScript SDK, so a card form can be embedded in the console without the browser
   * ever holding the app's client id. Optional: a server without it simply cannot offer the embedded checkout.
   */
  clientToken?(): Promise<string>
  createOrder(input: {
    proposalId: string
    amountCents: number
    currency: string
    description: string
    payeeEmail: string | null
    /**
     * Which instrument the order is opened for. A card order (paid on our own page) and a checkout order (the buyer is
     * sent to PayPal) are different orders on PayPal's side, so the request id is seeded with this too. A wallet order
     * is approved in PayPal's own window (PayPal, Venmo or Pay Later) that the page opens: it carries no payment
     * source and no way back, because the buyer never leaves the page.
     */
    kind?: 'card' | 'checkout' | 'wallet'
    /** Where PayPal sends the buyer after they approve or cancel. */
    returnUrl?: string
    cancelUrl?: string
    /**
     * CAPTURE (the default) takes the money when the order is captured. AUTHORIZE only reserves it: the money is held
     * on the buyer's side until it is captured or voided. A held order is a different order, so the request id says so.
     */
    intent?: 'CAPTURE' | 'AUTHORIZE'
  }): Promise<CreatedOrder>
  /** Places the hold on an approved AUTHORIZE order. Idempotent per request: a repeat returns the same hold. */
  authorizeOrder?(orderId: string, proposalId: string): Promise<HeldPayment>
  /** Re-reads a hold. */
  getAuthorization?(authorizationId: string): Promise<HeldPayment>
  /** Takes the held money. One final capture of exactly the held amount. */
  captureAuthorization?(input: { authorizationId: string; proposalId: string; amountCents: number; currency: string; invoiceId: string }): Promise<CapturedPayment>
  /** Releases the hold back to the buyer. Nothing was ever charged. */
  voidAuthorization?(authorizationId: string): Promise<{ status: string }>
  /** Renews a hold past PayPal's three-day honor period, within its twenty-nine-day life. Returns the new hold. */
  reauthorize?(input: { authorizationId: string; amountCents: number; currency: string; proposalId: string }): Promise<HeldPayment>
  getOrder(orderId: string): Promise<LiveOrder>
  /**
   * The card a buyer paid an order with, and the issuer's 3-D Secure answer, as PayPal reports them on the order's
   * payment source. Null before a card was submitted. Optional: a port without it is treated as "no check was asked".
   */
  cardResult?(orderId: string): Promise<CardOnOrder | null>
  captureOrder(orderId: string, proposalId: string): Promise<CapturedPayment>
  /** Re-reads one capture. Its status is the truth about whether the money arrived, stayed, or was taken back. */
  getCapture(captureId: string): Promise<CapturedPayment>
  /** Re-reads one refund, for a refund PayPal left PENDING. */
  getRefund(refundId: string): Promise<RefundedPayment>
  refundCapture(input: {
    proposalId: string
    captureId: string
    amountCents: number
    currency: string
  }): Promise<RefundedPayment>
  /** Money out to a contractor's PayPal account (Payouts v1). One item per batch. */
  sendPayout(input: {
    proposalId: string
    /** The lock hash. The batch id is derived from it, so a retry can never pay twice. */
    cartHash: string
    receiverEmail: string
    amountCents: number
    currency: string
    note: string
  }): Promise<SentPayout>
  getPayout(batchId: string): Promise<LivePayout>
  /** Cancels a payout item PayPal is holding because the receiver has no account. The money goes back to the sender. */
  cancelPayoutItem(itemId: string): Promise<{ status: string }>
  /** The account's balance. PayPal's report refreshes every few hours, so `asOf` matters: this is advice, never a guarantee. */
  balance(currency: string): Promise<{ availableCents: number; withheldCents: number; asOf: string | null }>
  /** Asks PayPal whether a webhook really came from PayPal. True only when PayPal says SUCCESS. */
  verifyWebhook(input: { webhookId: string; headers: Record<string, string>; event: unknown; rawEvent?: string }): Promise<boolean>
  /** The scopes on the app's access token, which say which PayPal features the app may use. `fresh` forces a new token. */
  scopes(fresh?: boolean): Promise<string[]>
}

export class PayPalError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly paypalName: string,
    readonly debugId: string | null,
    readonly fields: string,
  ) {
    super(paypalName)
    this.name = 'PayPalError'
  }
}
