import { PayPalError, type PayPalPort } from './port'

type StoredOrder = {
  amountCents: number
  currency: string
  customId: string
  status: string
  captureId?: string
}

export class FakePayPal implements PayPalPort {
  readonly orders = new Map<string, StoredOrder>()
  autoApprove = true
  captureCalls = 0
  refundCalls = 0

  async createOrder(input: {
    proposalId: string
    amountCents: number
    currency: string
    description: string
    payeeEmail: string | null
  }) {
    const orderId = `ORDER-${input.proposalId.replaceAll('-', '').slice(0, 12)}`
    const existing = this.orders.get(orderId)
    if (!existing) {
      this.orders.set(orderId, {
        amountCents: input.amountCents,
        currency: input.currency,
        customId: input.proposalId,
        status: this.autoApprove ? 'APPROVED' : 'CREATED',
      })
    }
    const order = this.orders.get(orderId)!
    return {
      orderId,
      status: order.status,
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
      payeeAttached: Boolean(input.payeeEmail),
    }
  }

  async getOrder(orderId: string) {
    const order = this.orders.get(orderId)
    if (!order) throw new PayPalError(404, 'RESOURCE_NOT_FOUND', 'debug', 'order')
    return {
      orderId,
      status: order.status,
      amountCents: order.amountCents,
      currency: order.currency,
      customId: order.customId,
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
    }
  }

  async captureOrder(orderId: string) {
    this.captureCalls += 1
    const order = this.orders.get(orderId)
    if (!order) throw new PayPalError(404, 'RESOURCE_NOT_FOUND', 'debug', 'order')
    if (order.status !== 'APPROVED' && order.status !== 'COMPLETED') {
      throw new PayPalError(422, 'ORDER_NOT_APPROVED', 'debug', 'status')
    }
    order.status = 'COMPLETED'
    order.captureId ??= `CAP-${orderId.slice(6, 18)}`
    return { captureId: order.captureId, amountCents: order.amountCents, currency: order.currency, status: 'COMPLETED' }
  }

  async refundCapture(input: { proposalId: string; captureId: string; amountCents: number; currency: string }) {
    this.refundCalls += 1
    return { refundId: `REFUND-${input.proposalId.replaceAll('-', '').slice(0, 12)}`, status: 'COMPLETED' }
  }

  approve(orderId: string): void {
    const order = this.orders.get(orderId)
    if (!order) throw new Error(`missing ${orderId}`)
    order.status = 'APPROVED'
  }

  mutateAmount(orderId: string, amountCents: number): void {
    const order = this.orders.get(orderId)
    if (!order) throw new Error(`missing ${orderId}`)
    order.amountCents = amountCents
  }
}
