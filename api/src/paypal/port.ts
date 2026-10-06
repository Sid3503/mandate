export type CreatedOrder = {
  orderId: string
  status: string
  approveUrl: string | null
  payeeAttached: boolean
}

export type LiveOrder = {
  orderId: string
  status: string
  amountCents: number
  currency: string
  customId: string | null
  approveUrl: string | null
}

export type CapturedPayment = {
  captureId: string
  amountCents: number
  currency: string
  status: string
}

export type RefundedPayment = {
  refundId: string
  status: string
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

export type PayPalPort = {
  createOrder(input: {
    proposalId: string
    amountCents: number
    currency: string
    description: string
    payeeEmail: string | null
    /** Where PayPal sends the buyer after they approve or cancel. */
    returnUrl?: string
    cancelUrl?: string
  }): Promise<CreatedOrder>
  getOrder(orderId: string): Promise<LiveOrder>
  captureOrder(orderId: string, proposalId: string): Promise<CapturedPayment>
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
  verifyWebhook(input: { webhookId: string; headers: Record<string, string>; event: unknown }): Promise<boolean>
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
