import { payPalToCents } from '../domain/money'
import { arr, obj, str } from './toolkit'
import { payPalCallerOf } from './client'
import type { PayPalPort } from './port'

/**
 * The seller's side of PayPal's Customer Disputes API v1, narrowed to what the dispute desk needs: read a dispute, send
 * a message, provide evidence. It deliberately has no accept-claim, no make-offer and no appeal: those concede or
 * settle money, and a response written here only ever argues the seller's case.
 *
 * HONESTY (read this before trusting the real implementation): the PayPal sandbox cannot create an open dispute for
 * this app (see docs/REFERENCE.md, "A real open dispute could not be created in the sandbox"), so nothing below has
 * been run against a live dispute. It is written to PayPal's published OpenAPI document
 * (https://developer.paypal.com/api/customer-disputes/v1/schema.json, read 2026-11-03) and the tests run it against a
 * fake fetch and the deterministic FakeDisputes. What was and was not confirmed from that document:
 *
 *   confirmed   GET  /v1/customer/disputes/{id}: response fields dispute_id, status, reason, dispute_amount
 *               {currency_code,value}, dispute_life_cycle_stage (INQUIRY|CHARGEBACK|PRE_ARBITRATION|ARBITRATION),
 *               disputed_transactions[].seller_transaction_id, messages[] {posted_by,time_posted,content},
 *               evidences[], seller_response_due_date, buyer_response_due_date, allowed_response_options
 *               {acknowledge_return_item, accept_claim, make_offer}, links[], create_time, update_time.
 *               (The document has no separate `dispute_state` field: `status` carries OPEN, WAITING_FOR_BUYER_RESPONSE,
 *               WAITING_FOR_SELLER_RESPONSE, UNDER_REVIEW, RESOLVED, OTHER.)
 *   confirmed   POST /v1/customer/disputes/{id}/provide-evidence: allowed for status WAITING_FOR_SELLER_RESPONSE; an
 *               evidence is {evidence_type, evidence_info?, documents?, notes (1..2000 chars)}. evidence_info (tracking or
 *               refund ids) is expected only for PROOF_OF_FULFILLMENT, PROOF_OF_REFUND and PROOF_OF_RETURN; "documents
 *               and notes can be given for rest of the evidence types". OTHER is in the evidence_type list.
 *   confirmed   POST /v1/customer/disputes/{id}/send-message: only while dispute_life_cycle_stage is INQUIRY. Both calls
 *               are meant to be made through the `provide-evidence` / `send-message` HATEOAS link of the dispute, and
 *               are not available when that link is absent.
 *   NOT sure    The encoding. The description says to "specify the evidence in the JSON request body", while the
 *               machine-readable request body in the same document lists only multipart/form-data with a file part
 *               (`evidence-file`, `message_document`). This code sends JSON, the documented text; a multipart part for
 *               an attached file is not built (Mandate attaches links, not files). If the live API insists on
 *               multipart, the body would move into an `input` JSON part. UNVERIFIED.
 *   NOT sure    The send-message JSON field name, `message`. The document names no field for it. UNVERIFIED.
 *   NOT sure    Whether these two endpoints honour a PayPal-Request-Id header. The header is sent, as everywhere in this
 *               client, but a repeat being answered with the first answer is not documented for disputes. That is why
 *               the desk also refuses a second send itself (a database rule, not PayPal's).
 */

export type DisputeStage = 'INQUIRY' | 'CHARGEBACK' | 'PRE_ARBITRATION' | 'ARBITRATION' | 'UNKNOWN'

/** What PayPal says about one dispute, in the fields the desk uses. Dates are PayPal's ISO strings, untouched. */
export type DisputeDetail = {
  id: string
  /** OPEN, WAITING_FOR_BUYER_RESPONSE, WAITING_FOR_SELLER_RESPONSE, UNDER_REVIEW, RESOLVED or OTHER. */
  status: string
  stage: DisputeStage
  reason: string | null
  amountCents: number | null
  currency: string | null
  createdAt: string | null
  updatedAt: string | null
  sellerResponseDueDate: string | null
  /** The seller transaction (capture) ids the client disputed. */
  transactionIds: string[]
  messages: Array<{ postedBy: string; at: string | null; content: string }>
  evidences: Array<{ type: string; source: string | null; notes: string | null }>
  /** The response options PayPal offers (accept_claim, make_offer, ...). The desk never uses them. */
  allowedResponseOptions: string[]
  /** The rel names of the HATEOAS links. `provide-evidence` / `send-message` here means PayPal allows that call. */
  linkRels: string[]
}

/** The exact HTTP request the desk makes. It is stored before it is sent and shown to the owner afterwards. */
export type DisputeRequest = {
  method: 'POST'
  path: string
  body: Record<string, unknown>
  requestId: string
}

export type DisputeSendResult = { linkRels: string[] }

export type DisputePort = {
  get(id: string): Promise<DisputeDetail>
  sendMessage(id: string, message: string, requestId: string): Promise<DisputeSendResult>
  provideEvidence(id: string, evidence: { evidenceType: 'OTHER'; notes: string }, requestId: string): Promise<DisputeSendResult>
}

/** PayPal's limit for a message's content and for an evidence's notes. */
export const DISPUTE_TEXT_MAX = 2000

/** The request that carries a written response. One function builds it, so the stored request is the sent request. */
export function disputeRequestFor(stage: DisputeStage, id: string, text: string, requestId: string): DisputeRequest {
  const base = `/v1/customer/disputes/${encodeURIComponent(id)}`
  // PayPal only takes a message while the dispute is an inquiry; every later stage takes evidence.
  if (stage === 'INQUIRY') return { method: 'POST', path: `${base}/send-message`, body: { message: text }, requestId }
  return { method: 'POST', path: `${base}/provide-evidence`, body: { evidences: [{ evidence_type: 'OTHER', notes: text }] }, requestId }
}

const STAGES = new Set(['INQUIRY', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION'])

/** Reads PayPal's dispute JSON into the fields above. Missing fields become null or empty, never guesses. */
export function parseDisputeDetail(json: Record<string, unknown>): DisputeDetail {
  const amount = obj(json.dispute_amount)
  const stage = str(json.dispute_life_cycle_stage)
  return {
    id: str(json.dispute_id) ?? '',
    status: str(json.status) ?? 'OTHER',
    stage: stage && STAGES.has(stage) ? stage as DisputeStage : 'UNKNOWN',
    reason: str(json.reason),
    amountCents: typeof amount.value === 'string' && /^-?\d+(\.\d{1,2})?$/.test(amount.value) ? payPalToCents(amount.value) : null,
    currency: str(amount.currency_code),
    createdAt: str(json.create_time),
    updatedAt: str(json.update_time),
    sellerResponseDueDate: str(json.seller_response_due_date),
    transactionIds: arr(json.disputed_transactions).map((txn) => str(txn.seller_transaction_id)).filter((v): v is string => v !== null),
    messages: arr(json.messages).map((m) => ({ postedBy: str(m.posted_by) ?? 'UNKNOWN', at: str(m.time_posted), content: str(m.content) ?? '' })),
    evidences: arr(json.evidences).map((e) => ({ type: str(e.evidence_type) ?? 'UNKNOWN', source: str(e.source), notes: str(e.notes) })),
    allowedResponseOptions: Object.keys(obj(json.allowed_response_options)),
    linkRels: arr(json.links).map((link) => str(link.rel)).filter((v): v is string => v !== null),
  }
}

/** The real port. It borrows the PayPal client's token and circuit breaker, so a disputes call counts against the same breaker. */
export function createPayPalDisputes(paypal: PayPalPort): DisputePort | null {
  const call = payPalCallerOf(paypal)
  if (!call) return null
  const send = async (request: DisputeRequest): Promise<DisputeSendResult> => {
    const { json } = await call(request.path, { method: request.method, requestId: request.requestId, body: request.body })
    return { linkRels: arr(json.links).map((link) => str(link.rel)).filter((v): v is string => v !== null) }
  }
  return {
    async get(id) {
      const { json } = await call(`/v1/customer/disputes/${encodeURIComponent(id)}`, { method: 'GET' })
      return parseDisputeDetail(json)
    },
    sendMessage: (id, message, requestId) => send(disputeRequestFor('INQUIRY', id, message, requestId)),
    provideEvidence: (id, evidence, requestId) => send(disputeRequestFor('CHARGEBACK', id, evidence.notes, requestId)),
  }
}
