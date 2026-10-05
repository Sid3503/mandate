import { payPalToCents } from '../domain/money'
import { arr, createToolkit, obj, str, type Json } from './toolkit'

export type LiveTransaction = {
  id: string
  date: string
  /** Signed: money in is positive, money out is negative. */
  cents: number
  currency: string
  status: string
  eventCode: string | null
  subject: string | null
  counterparty: string | null
  referenceId: string | null
  invoiceId: string | null
  customId: string | null
}

export type LiveDispute = {
  id: string
  status: string
  reason: string | null
  cents: number | null
  currency: string | null
  openedAt: string | null
  updatedAt: string | null
  /** The PayPal transaction (a capture id) the client disputed. */
  transactionIds: string[]
}

/** Read-only windows onto the PayPal account, through PayPal's Agent Toolkit. Nothing here moves money. */
export type WatchPort = {
  listTransactions(input: { start: string; end: string }): Promise<LiveTransaction[]>
  /** Open and closed disputes, or just the ones on one transaction. */
  listDisputes(input?: { transactionId?: string }): Promise<LiveDispute[]>
}

export function createToolkitWatch(options: { clientId: string; clientSecret: string; sandbox: boolean }): WatchPort {
  const toolkit = createToolkit({ ...options, actions: { transactions: { list: true }, disputes: { list: true, get: true } } })
  return {
    async listTransactions({ start, end }) {
      const result = await toolkit.run('list_transactions', { start_date: start, end_date: end, page_size: 100 })
      return arr(result.transaction_details).map(parseTransaction).filter((item): item is LiveTransaction => item !== null)
    },
    async listDisputes(input) {
      const list = await toolkit.run('list_disputes', { ...(input?.transactionId ? { disputed_transaction_id: input.transactionId } : {}), page_size: 20 })
      const out: LiveDispute[] = []
      for (const item of arr(list.items).slice(0, 20)) {
        const id = str(item.dispute_id)
        if (!id) continue
        let transactionIds: string[] = input?.transactionId ? [input.transactionId] : []
        if (transactionIds.length === 0) {
          // The list does not say which payment was disputed. The detail does.
          const detail = await toolkit.run('get_dispute', { dispute_id: id }).catch(() => ({}) as Json)
          transactionIds = arr(detail.disputed_transactions).map((txn) => str(txn.seller_transaction_id)).filter((v): v is string => v !== null)
        }
        out.push(parseDispute(item, transactionIds))
      }
      return out
    },
  }
}

export function parseTransaction(detail: Json): LiveTransaction | null {
  const info = obj(detail.transaction_info)
  const id = str(info.transaction_id)
  if (!id) return null
  const amount = obj(info.transaction_amount)
  const payer = obj(detail.payer_info)
  const email = str(payer.email_address)
  const name = str(obj(payer.payer_name).alternate_full_name) ?? str(obj(payer.payer_name).given_name)
  return {
    id,
    date: str(info.transaction_initiation_date) ?? '',
    cents: typeof amount.value === 'string' ? payPalToCents(amount.value.replace('-', '')) * (amount.value.startsWith('-') ? -1 : 1) : 0,
    currency: str(amount.currency_code) ?? '',
    status: str(info.transaction_status) ?? 'UNKNOWN',
    eventCode: str(info.transaction_event_code),
    subject: str(info.transaction_subject) ?? str(info.transaction_note),
    counterparty: email ?? name,
    referenceId: str(info.paypal_reference_id),
    invoiceId: str(info.invoice_id),
    customId: str(info.custom_field),
  }
}

export function parseDispute(item: Json, transactionIds: string[]): LiveDispute {
  const amount = obj(item.dispute_amount)
  return {
    id: str(item.dispute_id) ?? '',
    status: str(item.status) ?? 'OTHER',
    reason: str(item.reason),
    cents: typeof amount.value === 'string' ? payPalToCents(amount.value) : null,
    currency: str(amount.currency_code),
    openedAt: str(item.create_time),
    updatedAt: str(item.update_time),
    transactionIds,
  }
}
