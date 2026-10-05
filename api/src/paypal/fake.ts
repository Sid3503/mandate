import type { InvoicePort, InvoiceRequest, LiveInvoice } from './invoices'
import { PayPalError, type LivePayout, type PayPalPort } from './port'

type StoredOrder = {
  amountCents: number
  currency: string
  customId: string
  status: string
  captureId?: string
}

type StoredPayout = {
  batchId: string
  itemId: string
  proposalId: string
  receiver: string
  amountCents: number
  currency: string
  status: string
}

export class FakePayPal implements PayPalPort {
  readonly payouts = new Map<string, StoredPayout>()
  /** Receivers that have no PayPal account. PayPal holds those payouts as UNCLAIMED. */
  readonly unregistered = new Set<string>()
  /** The status a new payout settles to. Tests set 'PENDING' to simulate a slow batch. */
  payoutOutcome: 'SUCCESS' | 'PENDING' | 'FAILED' = 'SUCCESS'
  payoutCalls = 0

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

  async sendPayout(input: { proposalId: string; cartHash: string; receiverEmail: string; amountCents: number; currency: string }) {
    const batchId = `BATCH-${input.cartHash.slice(0, 12)}`
    if (!this.payouts.has(batchId)) {
      this.payoutCalls += 1
      this.payouts.set(batchId, {
        batchId,
        itemId: `ITEM-${input.proposalId.replaceAll('-', '').slice(0, 12)}`,
        proposalId: input.proposalId,
        receiver: input.receiverEmail,
        amountCents: input.amountCents,
        currency: input.currency,
        status: this.unregistered.has(input.receiverEmail) ? 'UNCLAIMED' : this.payoutOutcome,
      })
    }
    return { batchId, status: 'PENDING' }
  }

  async getPayout(batchId: string): Promise<LivePayout> {
    const payout = this.payouts.get(batchId)
    if (!payout) throw new PayPalError(404, 'RESOURCE_NOT_FOUND', 'debug', 'batch')
    return {
      batchId,
      batchStatus: payout.status === 'PENDING' ? 'PENDING' : 'SUCCESS',
      item: {
        itemId: payout.itemId,
        senderItemId: payout.proposalId,
        status: payout.status,
        transactionId: payout.status === 'SUCCESS' || payout.status === 'UNCLAIMED' ? `TXN-${payout.itemId.slice(5)}` : null,
        amountCents: payout.amountCents,
        currency: payout.currency,
        feeCents: 25,
        errorName: payout.status === 'UNCLAIMED' ? 'RECEIVER_UNREGISTERED' : payout.status === 'FAILED' ? 'INSUFFICIENT_FUNDS' : null,
        receiver: payout.receiver,
      },
    }
  }

  /** Simulates PayPal finishing a slow batch. */
  settlePayouts(status: 'SUCCESS' | 'FAILED' = 'SUCCESS'): void {
    for (const payout of this.payouts.values()) if (payout.status === 'PENDING') payout.status = status
  }

  /** Simulates PayPal reporting a different amount than the one sent. */
  mutatePayout(batchId: string, amountCents: number): void {
    const payout = this.payouts.get(batchId)
    if (!payout) throw new Error(`missing ${batchId}`)
    payout.amountCents = amountCents
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

export class FakeInvoices implements InvoicePort {
  readonly invoices = new Map<string, { number: string; proposalId: string; totalCents: number; currency: string; status: string; reference: string; transactionId: string | null; paidCents: number; email: string }>()
  createCalls = 0
  sendCalls = 0
  /** When set, creating fails the way an app without Invoicing permission does. */
  unauthorised = false
  /** Pay as soon as the invoice is sent, like a client who pays at once. */
  autoPay = false

  async createDraft(input: InvoiceRequest) {
    if (this.unauthorised) throw new PayPalError(403, 'PAYPAL_API_HTTP_ERROR', null, 'Authorization failed due to insufficient permissions.')
    this.createCalls += 1
    const existing = [...this.invoices.entries()].find(([, item]) => item.number === input.invoiceNumber)
    if (existing) throw new PayPalError(422, 'DUPLICATE_INVOICE_NUMBER', null, 'invoice number')
    const invoiceId = `INV2-${input.proposalId.replaceAll('-', '').slice(0, 12).toUpperCase()}`
    this.invoices.set(invoiceId, { number: input.invoiceNumber, proposalId: input.proposalId, totalCents: input.amountCents, currency: input.currency, status: 'DRAFT', reference: input.proposalId, transactionId: null, paidCents: 0, email: input.recipientEmail })
    return { invoiceId }
  }

  async send(invoiceId: string) {
    const invoice = this.invoices.get(invoiceId)
    if (!invoice) throw new PayPalError(404, 'RESOURCE_NOT_FOUND', null, invoiceId)
    this.sendCalls += 1
    invoice.status = 'SENT'
    if (this.autoPay) this.pay(invoiceId)
    return { payerUrl: `https://www.sandbox.paypal.com/invoice/p/#${invoiceId}` }
  }

  async get(invoiceId: string): Promise<LiveInvoice> {
    const invoice = this.invoices.get(invoiceId)
    if (!invoice) throw new PayPalError(404, 'RESOURCE_NOT_FOUND', null, invoiceId)
    return {
      invoiceId,
      number: invoice.number,
      status: invoice.status,
      totalCents: invoice.totalCents,
      currency: invoice.currency,
      paidCents: invoice.paidCents,
      transactionId: invoice.transactionId,
      reference: invoice.reference,
      payerUrl: `https://www.sandbox.paypal.com/invoice/p/#${invoiceId}`,
    }
  }

  async findByNumber(number: string) {
    const found = [...this.invoices.entries()].find(([, item]) => item.number === number)
    return found ? { invoiceId: found[0] } : null
  }

  /** The client pays the invoice in PayPal. */
  pay(invoiceId: string, cents?: number) {
    const invoice = this.invoices.get(invoiceId)
    if (!invoice) throw new Error(`missing ${invoiceId}`)
    invoice.status = 'PAID'
    invoice.paidCents = cents ?? invoice.totalCents
    invoice.transactionId = `CAP-INV-${invoiceId.slice(5, 17)}`
  }

  setStatus(invoiceId: string, status: string) {
    this.invoices.get(invoiceId)!.status = status
  }

  /** Simulates PayPal reporting a different total than the one we asked for. */
  mutateTotal(invoiceId: string, cents: number) {
    this.invoices.get(invoiceId)!.totalCents = cents
  }
}
