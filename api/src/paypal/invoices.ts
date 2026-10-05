import { centsToPayPal, payPalToCents } from '../domain/money'
import { PayPalError } from './port'
import { createToolkit, type Json } from './toolkit'

export type InvoiceRequest = {
  proposalId: string
  /** Deterministic from the proposal id, so a retry after a crash finds the same draft instead of making another. */
  invoiceNumber: string
  amountCents: number
  currency: string
  title: string
  description: string
  note: string
  recipientEmail: string
  recipientName: string
}

export type LiveInvoice = {
  invoiceId: string
  number: string | null
  /** DRAFT, SENT, PAID, PARTIALLY_PAID, MARKED_AS_PAID, CANCELLED, REFUNDED, ... as PayPal reports it. */
  status: string
  totalCents: number
  currency: string
  /** What PayPal says was actually paid through PayPal. */
  paidCents: number
  /** The PayPal payment id of the (first) payment. This is the capture id that funds contractor payouts and refunds. */
  transactionId: string | null
  reference: string | null
  payerUrl: string | null
}

/** Billing a client with a PayPal invoice. Only ever called by the server, after the owner's tap. */
export type InvoicePort = {
  createDraft(input: InvoiceRequest): Promise<{ invoiceId: string }>
  send(invoiceId: string, note: string): Promise<{ payerUrl: string | null }>
  get(invoiceId: string): Promise<LiveInvoice>
  /** Emails the client a reminder. No money moves. */
  remind(invoiceId: string, note: string): Promise<void>
  /** Cancels a sent invoice, so it can no longer be paid. */
  cancel(invoiceId: string, note: string): Promise<void>
  /** Finds a draft this server made earlier (crash recovery). */
  findByNumber(invoiceNumber: string): Promise<{ invoiceId: string } | null>
}

export const invoiceNumberFor = (proposalId: string) => `MND-${proposalId.replaceAll('-', '').slice(0, 16).toUpperCase()}`

/**
 * PayPal's own Agent Toolkit, run inside our server, for everything about billing a client by invoice.
 * The server calls these tools with values taken from a locked cart. No model ever sees them.
 */
export function createToolkitInvoices(options: { clientId: string; clientSecret: string; sandbox: boolean }): InvoicePort {
  const toolkit = createToolkit({
    ...options,
    actions: { invoices: { create: true, send: true, get: true, list: true, sendReminder: true, cancel: true } },
  })
  const run = toolkit.run

  return {
    async createDraft(input) {
      const [given, ...rest] = input.recipientName.trim().split(/\s+/)
      const result = await run('create_invoice', {
        currency_code: input.currency,
        invoice_number: input.invoiceNumber,
        reference: input.proposalId,
        note: input.note.slice(0, 4000),
        primary_recipients: [{ billing_info: { email_address: input.recipientEmail, name: { given_name: given || 'Client', surname: rest.join(' ') || undefined }, business_name: input.recipientName.slice(0, 300) } }],
        items: [{ name: input.title.slice(0, 200), description: input.description.slice(0, 1000), quantity: '1', unit_amount: { currency_code: input.currency, value: centsToPayPal(input.amountCents) } }],
        allow_partial_payment: false,
      })
      const id = idFrom(result)
      if (!id) throw new PayPalError(502, 'paypal_malformed', null, 'create_invoice returned no id')
      return { invoiceId: id }
    },
    async send(invoiceId, note) {
      const result = await run('send_invoice', { invoice_id: invoiceId, note: note.slice(0, 4000), send_to_recipient: true })
      return { payerUrl: linkFrom(result) }
    },
    async get(invoiceId) {
      return parseInvoice(await run('get_invoice', { invoice_id: invoiceId }), invoiceId)
    },
    async remind(invoiceId, note) {
      await run('send_invoice_reminder', { invoice_id: invoiceId, subject: 'Reminder: your invoice is waiting', note: note.slice(0, 4000) })
    },
    async cancel(invoiceId, note) {
      await run('cancel_sent_invoice', { invoice_id: invoiceId, note: note.slice(0, 4000), send_to_recipient: true })
    },
    async findByNumber(invoiceNumber) {
      try {
        const result = await run('list_invoices', { page: 1, page_size: 100, total_required: false })
        const items = Array.isArray(result.items) ? (result.items as Json[]) : []
        const found = items.find((item) => (item.detail as Json | undefined)?.invoice_number === invoiceNumber)
        const id = found ? idFrom(found) : null
        return id ? { invoiceId: id } : null
      } catch {
        return null
      }
    },
  }
}

function idFrom(value: Json): string | null {
  if (typeof value.id === 'string') return value.id
  const href = typeof value.href === 'string' ? value.href : null
  return href ? href.split('/').filter(Boolean).at(-1) ?? null : null
}

function linkFrom(value: Json): string | null {
  const links = Array.isArray(value.links) ? (value.links as Json[]) : []
  const found = links.find((link) => link.rel === 'payer-view' || link.rel === 'recipient-view') ?? links[0]
  if (found && typeof found.href === 'string') return found.href
  return typeof value.href === 'string' ? value.href : null
}

/** Reads the parts of PayPal's invoice we rely on. Anything missing is treated as "not paid", never as paid. */
export function parseInvoice(invoice: Json, fallbackId: string): LiveInvoice {
  const detail = (invoice.detail ?? {}) as Json
  const amount = (invoice.amount ?? {}) as Json
  const metadata = (detail.metadata ?? {}) as Json
  const transactions = (((invoice.payments ?? {}) as Json).transactions ?? []) as Json[]
  const paidThroughPayPal = transactions.filter((item) => item.method === 'PAYPAL' || item.method === 'CREDIT_DEBIT_CARD' || item.method === undefined)
  const paid = paidThroughPayPal.reduce((sum, item) => sum + paid1(item), 0)
  const first = paidThroughPayPal.find((item) => typeof item.payment_id === 'string')
  const value = (amount.value ?? ((amount.breakdown ?? {}) as Json).value) as string | undefined
  return {
    invoiceId: typeof invoice.id === 'string' ? invoice.id : fallbackId,
    number: typeof detail.invoice_number === 'string' ? detail.invoice_number : null,
    status: typeof invoice.status === 'string' ? invoice.status : 'UNKNOWN',
    totalCents: typeof value === 'string' ? payPalToCents(value) : 0,
    currency: typeof amount.currency_code === 'string' ? amount.currency_code : typeof detail.currency_code === 'string' ? detail.currency_code : '',
    paidCents: paid,
    transactionId: typeof first?.payment_id === 'string' ? first.payment_id : null,
    reference: typeof detail.reference === 'string' ? detail.reference : null,
    payerUrl: typeof metadata.recipient_view_url === 'string' ? metadata.recipient_view_url : null,
  }
}

function paid1(transaction: Json): number {
  const amount = (transaction.amount ?? {}) as Json
  return typeof amount.value === 'string' ? payPalToCents(amount.value) : 0
}
