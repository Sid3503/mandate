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

export type PayPalPort = {
  createOrder(input: {
    proposalId: string
    amountCents: number
    currency: string
    description: string
    payeeEmail: string | null
  }): Promise<CreatedOrder>
  getOrder(orderId: string): Promise<LiveOrder>
  captureOrder(orderId: string, proposalId: string): Promise<CapturedPayment>
  refundCapture(input: {
    proposalId: string
    captureId: string
    amountCents: number
    currency: string
  }): Promise<RefundedPayment>
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
