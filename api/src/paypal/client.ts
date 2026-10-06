import { centsToPayPal, payPalToCents } from '../domain/money'
import { paypalRequestId } from '../domain/hash'
import { arr, obj, str } from './toolkit'
import { PayPalError, type CapturedPayment, type CreatedOrder, type LiveOrder, type LivePayout, type PayPalPort, type RefundedPayment, type SentPayout } from './port'

type Token = { value: string; expiresAt: number }

export function createPayPalClient(options: {
  clientId: string
  clientSecret: string
  baseUrl: string
  fetch?: typeof fetch
}): PayPalPort {
  const fetchImpl = options.fetch ?? fetch
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  let token: Token | null = null
  let scope: string[] = []

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value
    const response = await fetchImpl(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20_000),
    })
    const json = await readJson(response)
    if (!response.ok || typeof json.access_token !== 'string') {
      throw paypalError(response.status, json)
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 300
    token = { value: json.access_token, expiresAt: Date.now() + expiresIn * 1000 }
    scope = typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : []
    return token.value
  }

  async function call(path: string, init: { method: string; requestId?: string; body?: unknown }): Promise<{ status: number; json: Json }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await accessToken()}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    }
    if (init.requestId) headers['paypal-request-id'] = init.requestId
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    })
    const json = await readJson(response)
    if (!response.ok) throw paypalError(response.status, json)
    return { status: response.status, json }
  }

  async function createOnce(input: {
    proposalId: string
    amountCents: number
    currency: string
    description: string
    payeeEmail: string | null
    returnUrl?: string
    cancelUrl?: string
  }, attachPayee: boolean): Promise<CreatedOrder> {
    const unit: Record<string, unknown> = {
      custom_id: input.proposalId,
      invoice_id: input.proposalId,
      description: input.description.slice(0, 127),
      amount: { currency_code: input.currency, value: centsToPayPal(input.amountCents) },
    }
    if (attachPayee && input.payeeEmail) unit.payee = { email_address: input.payeeEmail }
    const { json } = await call('/v2/checkout/orders', {
      method: 'POST',
      requestId: paypalRequestId(`${input.proposalId}:create`),
      body: {
        intent: 'CAPTURE',
        purchase_units: [unit],
        // With a return URL the buyer lands back on the receipt after approving, instead of being stranded on PayPal.
        ...(input.returnUrl ? { payment_source: { paypal: { experience_context: {
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl ?? input.returnUrl,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          brand_name: 'Mandate',
        } } } } : {}),
      },
    })
    return {
      orderId: stringField(json, 'id'),
      status: stringField(json, 'status'),
      approveUrl: link(json, ['payer-action', 'approve']),
      payeeAttached: attachPayee && Boolean(input.payeeEmail),
    }
  }

  return {
    async createOrder(input) {
      const attach = Boolean(input.payeeEmail)
      try {
        return await createOnce(input, attach)
      } catch (error) {
        if (attach && error instanceof PayPalError && error.httpStatus === 422 && /payee/i.test(error.fields)) {
          return createOnce(input, false)
        }
        throw error
      }
    },
    async getOrder(orderId) {
      const { json } = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: 'GET' })
      const unit = firstUnit(json)
      const amount = unit?.amount
      return {
        orderId: stringField(json, 'id'),
        status: stringField(json, 'status'),
        amountCents: payPalToCents(stringField(asJson(amount), 'value')),
        currency: stringField(asJson(amount), 'currency_code'),
        customId: typeof unit?.custom_id === 'string' ? unit.custom_id : null,
        approveUrl: link(json, ['payer-action', 'approve']),
      }
    },
    async captureOrder(orderId, proposalId) {
      const { json } = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        requestId: paypalRequestId(`${proposalId}:capture`),
        body: {},
      })
      const capture = firstCapture(json)
      const amount = capture?.amount
      return {
        captureId: stringField(capture, 'id'),
        status: stringField(capture, 'status'),
        amountCents: payPalToCents(stringField(asJson(amount), 'value')),
        currency: stringField(asJson(amount), 'currency_code'),
      } satisfies CapturedPayment
    },
    async refundCapture(input) {
      const { json } = await call(`/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`, {
        method: 'POST',
        requestId: paypalRequestId(`${input.proposalId}:refund`),
        body: { amount: { currency_code: input.currency, value: centsToPayPal(input.amountCents) } },
      })
      return { refundId: stringField(json, 'id'), status: stringField(json, 'status') } satisfies RefundedPayment
    },
    async sendPayout(input) {
      const senderBatchId = `mandate_${input.cartHash.slice(0, 48)}`
      const { json } = await call('/v1/payments/payouts', {
        method: 'POST',
        requestId: paypalRequestId(`${input.proposalId}:payout`),
        body: {
          sender_batch_header: {
            sender_batch_id: senderBatchId,
            email_subject: 'You have a payment',
            email_message: 'A payment was sent to you from a client job.',
            recipient_type: 'EMAIL',
          },
          items: [{
            recipient_type: 'EMAIL',
            receiver: input.receiverEmail,
            amount: { currency: input.currency, value: centsToPayPal(input.amountCents) },
            note: input.note.slice(0, 160),
            sender_item_id: input.proposalId,
          }],
        },
      })
      const header = asJson(json.batch_header)
      return { batchId: stringField(header, 'payout_batch_id'), status: stringField(header, 'batch_status') } satisfies SentPayout
    },
    async cancelPayoutItem(itemId) {
      const { json } = await call(`/v1/payments/payouts-item/${encodeURIComponent(itemId)}/cancel`, { method: 'POST' })
      return { status: stringField(json, 'transaction_status') }
    },
    async balance(currency) {
      const { json } = await call(`/v1/reporting/balances?currency_code=${encodeURIComponent(currency)}`, { method: 'GET' })
      const entry = arr(json.balances).find((item) => str(item.currency) === currency) ?? arr(json.balances)[0]
      const cents = (field: string) => {
        const value = obj(entry?.[field]).value
        return typeof value === 'string' ? payPalToCents(value) : 0
      }
      return { availableCents: cents('available_balance'), withheldCents: cents('withheld_balance'), asOf: str(json.as_of_time) }
    },
    async verifyWebhook({ webhookId, headers, event }) {
      const { json } = await call('/v1/notifications/verify-webhook-signature', {
        method: 'POST',
        body: {
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: webhookId,
          webhook_event: event,
        },
      })
      return json.verification_status === 'SUCCESS'
    },
    async scopes(fresh = false) {
      if (fresh) token = null
      await accessToken()
      return scope
    },
    async getPayout(batchId) {
      const { json } = await call(`/v1/payments/payouts/${encodeURIComponent(batchId)}?page_size=1`, { method: 'GET' })
      const header = asJson(json.batch_header)
      const items = Array.isArray(json.items) ? json.items : []
      const first = asJson(items[0])
      let item: LivePayout['item'] = null
      if (first) {
        const inner = asJson(first.payout_item)
        const amount = asJson(inner?.amount)
        const fee = asJson(first.payout_item_fee)
        const errors = asJson(first.errors)
        item = {
          itemId: stringField(first, 'payout_item_id'),
          senderItemId: typeof inner?.sender_item_id === 'string' ? inner.sender_item_id : null,
          status: stringField(first, 'transaction_status'),
          transactionId: typeof first.transaction_id === 'string' ? first.transaction_id : null,
          amountCents: payPalToCents(stringField(amount, 'value')),
          currency: stringField(amount, 'currency'),
          feeCents: fee && typeof fee.value === 'string' ? payPalToCents(fee.value) : null,
          errorName: typeof errors?.name === 'string' ? errors.name : null,
          receiver: typeof inner?.receiver === 'string' ? inner.receiver : null,
        }
      }
      return { batchId: stringField(header, 'payout_batch_id'), batchStatus: stringField(header, 'batch_status'), item } satisfies LivePayout
    },
  }
}

type Json = Record<string, unknown>

async function readJson(response: Response): Promise<Json> {
  const text = await response.text()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : {}
  } catch {
    return {}
  }
}

function paypalError(status: number, json: Json): PayPalError {
  const name = typeof json.name === 'string' ? json.name : 'paypal_error'
  const message = typeof json.message === 'string' ? json.message : ''
  const debugId = typeof json.debug_id === 'string' ? json.debug_id : null
  const details = Array.isArray(json.details) ? json.details : []
  const fields = details.map((detail) => {
    if (!detail || typeof detail !== 'object') return ''
    const record = detail as Json
    return `${String(record.field ?? '')} ${String(record.issue ?? '')} ${String(record.description ?? '')}`
  }).join(' ')
  return new PayPalError(status, name, debugId, `${name} ${message} ${fields}`.slice(0, 500))
}

function asJson(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}

function stringField(value: Json | null | undefined, key: string): string {
  const found = value?.[key]
  if (typeof found !== 'string' || found.length === 0) throw new PayPalError(502, 'paypal_malformed', null, key)
  return found
}

function link(json: Json, rels: string[]): string | null {
  const links = Array.isArray(json.links) ? json.links : []
  for (const entry of links) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Json
    if (typeof record.rel === 'string' && rels.includes(record.rel) && typeof record.href === 'string') return record.href
  }
  return null
}

function firstUnit(json: Json): Json | null {
  const units = json.purchase_units
  if (!Array.isArray(units) || !units[0] || typeof units[0] !== 'object') return null
  return units[0] as Json
}

function firstCapture(json: Json): Json | null {
  const unit = firstUnit(json)
  const payments = unit?.payments
  if (!payments || typeof payments !== 'object') return null
  const captures = (payments as Json).captures
  if (!Array.isArray(captures) || !captures[0] || typeof captures[0] !== 'object') return null
  return captures[0] as Json
}
