import { randomUUID } from 'node:crypto'
import type { Repo, ProposalRow, ProposalKind, PayoutUpdate } from '../db/repo'
import { Clause, decide, fundableCents, resolveCategory, resolveClient, resolvePayee, type DealContext, type FundingCharge } from '../domain/gate'
import { cartHash, stableHash, type CartFields } from '../domain/hash'
import { lockMessage, type Signer } from '../domain/signing'
import { monthWindow } from '../domain/period'
import type { ProposalCreate, WarrantBody } from '../domain/schemas'
import { WARRANT_ID, WarrantBodySchema } from '../domain/schemas'
import { invoiceNumberFor, type InvoicePort, type LiveInvoice } from '../paypal/invoices'
import { PayPalError, type LivePayout, type PayPalPort } from '../paypal/port'
import { Problem } from '../http/problem'
import { runIdempotent } from './idempotency'

export type HttpResult = { status: number; body: unknown }
export type Role = 'owner' | 'proposer'

const RESUME_PHASES = new Set(['locked', 'order_created', 'invoice_draft', 'invoice_sent', 'payout_sent', 'payout_unclaimed'])
/** Charge phases where a PayPal invoice exists. The client may already have paid it. */
const INVOICE_PHASES = ['invoice_draft', 'invoice_sent']
/** Payout phases where PayPal already holds the batch, so money may already have left. */
const PAYOUT_LIVE_PHASES = ['payout_sent', 'payout_unclaimed']
const INFLIGHT_MS = 30_000

export type ProposalView = {
  id: string
  kind: ProposalKind
  gate: ProposalRow['gate']
  clause: string
  detail: string
  phase: string
  payeeId: string | null
  amountCents: number
  currency: string
  category: string | null
  description: string
  evidenceUrl: string | null
  prompt: string | null
  parentCaptureId: string | null
  jobId: string | null
  fundingCaptureId: string | null
  warrantId: string
  warrantVersion: number
  cartHash: string | null
  orderId: string | null
  captureId: string | null
  refundId: string | null
  approveUrl: string | null
  capturedAmountCents: number | null
  payoutBatchId: string | null
  payoutItemId: string | null
  payoutStatus: string | null
  payoutTransactionId: string | null
  payoutFeeCents: number | null
  dealId: string | null
  milestone: number | null
  lockSignature: string | null
  lockKeyId: string | null
  invoiceId: string | null
  invoiceUrl: string | null
  invoiceStatus: string | null
  createdAt: string
  updatedAt: string
  links: { self: string; packet: string }
}

export function toView(row: ProposalRow): ProposalView {
  return {
    id: row.id,
    kind: row.kind,
    gate: row.gate,
    clause: row.clause,
    detail: row.detail,
    phase: row.phase,
    payeeId: row.payee_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    category: row.category,
    description: row.description,
    evidenceUrl: row.evidence_url,
    prompt: row.prompt,
    parentCaptureId: row.parent_capture_id,
    jobId: row.job_id,
    fundingCaptureId: row.funding_capture_id,
    warrantId: row.warrant_id,
    warrantVersion: row.warrant_version,
    cartHash: row.cart_hash,
    orderId: row.order_id,
    captureId: row.capture_id,
    refundId: row.refund_id,
    approveUrl: row.approve_url,
    capturedAmountCents: row.captured_amount_cents,
    payoutBatchId: row.payout_batch_id,
    payoutItemId: row.payout_item_id,
    payoutStatus: row.payout_status,
    payoutTransactionId: row.payout_txn_id,
    payoutFeeCents: row.payout_fee_cents,
    dealId: row.deal_id,
    milestone: row.milestone,
    lockSignature: row.lock_sig,
    lockKeyId: row.lock_key_id,
    invoiceId: row.invoice_id,
    invoiceUrl: row.invoice_url,
    invoiceStatus: row.invoice_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    links: { self: `/v1/proposals/${row.id}`, packet: `/v1/proposals/${row.id}/packet` },
  }
}

export class MandateService {
  constructor(
    private readonly repo: Repo,
    private readonly paypal: PayPalPort | null,
    private readonly now: () => Date,
    private readonly signer: Signer,
    /** Bill clients with PayPal invoices (the Agent Toolkit). Null means checkout only. */
    private readonly invoices: InvoicePort | null = null,
  ) {}

  /**
   * Boot-time housekeeping. Remembers the public key, and signs locks made before signatures existed, but only
   * when their stored hash still recomputes from their own fields (so a row edited before this point is not blessed).
   */
  prepareSigning(): { signed: number; skipped: number } {
    const now = this.iso()
    for (const key of this.signer.publicKeys()) this.repo.rememberSigningKey(key.keyId, key.publicKeyPem, now)
    for (const stored of this.repo.signingKeys()) this.signer.addPublicKey(stored.publicPem)
    let signed = 0
    let skipped = 0
    for (const row of this.repo.unsignedLocks()) {
      let intact = false
      try {
        intact = cartHash(this.cartFields(row)) === row.cart_hash
      } catch {
        intact = false
      }
      if (!intact) {
        skipped += 1
        continue
      }
      this.repo.signLock(row.id, this.signer.sign(lockMessage(row.id, row.cart_hash!)))
      signed += 1
    }
    return { signed, skipped }
  }

  /** Whether a row's signature verifies for exactly its id and hash. Unsigned rows never verify. */
  lockValid(row: ProposalRow): boolean {
    return Boolean(row.cart_hash) && this.signer.verify(lockMessage(row.id, row.cart_hash!), row.lock_sig, row.lock_key_id)
  }

  /** Independent re-check of one lock, for the receipt's Verify button and for auditors. */
  verifyLock(id: string) {
    const row = this.require(id)
    const hashMatches = (() => {
      if (!row.cart_hash) return null
      try {
        return cartHash(this.cartFields(row)) === row.cart_hash
      } catch {
        return false
      }
    })()
    const signatureValid = row.cart_hash ? this.lockValid(row) : null
    return {
      proposalId: row.id,
      locked: Boolean(row.cart_hash),
      cartHash: row.cart_hash,
      hashMatches,
      signature: row.lock_sig,
      keyId: row.lock_key_id,
      algorithm: 'ed25519' as const,
      signatureValid,
      message: row.cart_hash ? lockMessage(row.id, row.cart_hash) : null,
      verdict: !row.cart_hash ? 'not_locked' : hashMatches && signatureValid ? 'valid' : 'invalid',
      publicKeys: this.signer.publicKeys(),
    }
  }

  publicKeys() {
    return { data: this.signer.publicKeys() }
  }

  currentWarrant() {
    const warrant = this.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    return { id: warrant.id, version: warrant.version, createdAt: warrant.createdAt, ...warrant.body }
  }

  warrantVersions() {
    return { data: this.repo.warrantVersions().map((warrant) => ({ id: warrant.id, version: warrant.version, createdAt: warrant.createdAt, ...warrant.body })) }
  }

  publishWarrant(input: unknown): HttpResult {
    const parsed = WarrantBodySchema.safeParse(input)
    if (!parsed.success) throw parsed.error
    const now = this.iso()
    const saved = this.repo.transaction(() => {
      const current = this.repo.latestWarrant()
      const version = current ? current.version + 1 : 1
      const id = current?.id ?? WARRANT_ID
      this.repo.insertWarrant(id, version, parsed.data, now)
      return { id, version, createdAt: now, ...parsed.data }
    })
    return { status: 201, body: saved }
  }

  propose(input: ProposalCreate, idempotencyKey: string, actor: Role = 'owner', runId: string | null = null): HttpResult {
    const hash = stableHash(input)
    const now = this.iso()
    return runIdempotent(this.repo, idempotencyKey, hash, now, () => this.proposeNew(input, now, actor, runId))
  }

  approve(id: string): HttpResult {
    const now = this.iso()
    return this.repo.transaction(() => {
      const row = this.require(id)
      if (['locked', 'order_created', 'captured', 'refunded', ...INVOICE_PHASES, ...PAYOUT_LIVE_PHASES].includes(row.phase)) {
        return { status: 200, body: toView(this.require(id)) }
      }
      if (row.phase !== 'pending_approval' || row.gate === 'DENY') {
        throw new Problem(409, 'proposal.state', 'Proposal cannot be approved', `Phase is ${row.phase}.`)
      }
      const cap = this.capState(row, now)
      if (row.kind === 'payment' && cap.reservedCents + row.amount_cents > cap.warrant.body.monthlyCapCents) {
        const cited = cap.priorCaptureIds.length > 0 ? cap.priorCaptureIds.join(', ') : 'none'
        this.repo.insertEvent(randomUUID(), row.id, 'proposal.approval_blocked', Clause.capMonthly, {
          reservedCents: cap.reservedCents,
          priorCaptureIds: cap.priorCaptureIds,
        }, now)
        return {
          status: 409,
          body: problemValue(Clause.capMonthly, 'Monthly cap blocks approval', `Monthly cap is ${cap.warrant.body.monthlyCapCents} cents; already reserved ${cap.reservedCents} cents; prior captures: ${cited}`, {
            proposalId: row.id,
            priorCaptureIds: cap.priorCaptureIds,
          }),
        }
      }
      const blocked = this.fundingBlock(row, cap.warrant.body)
      if (blocked) {
        this.repo.insertEvent(randomUUID(), row.id, 'proposal.approval_blocked', blocked.clause, {
          fundingCaptureId: row.funding_capture_id,
          detail: blocked.detail,
        }, now)
        return {
          status: 409,
          body: problemValue(blocked.clause, 'Client payment no longer funds this payout', blocked.detail, {
            proposalId: row.id,
            fundingCaptureId: row.funding_capture_id,
          }),
        }
      }
      const fields = this.cartFields(row)
      const hash = cartHash(fields)
      this.repo.lockProposal(row.id, hash, this.signer.sign(lockMessage(row.id, hash)), now)
      this.repo.insertEvent(randomUUID(), row.id, 'proposal.approved', row.clause, { actor: 'owner', cartHash: hash }, now)
      return { status: 200, body: toView(this.require(id)) }
    })
  }

  reject(id: string): HttpResult {
    const now = this.iso()
    return this.repo.transaction(() => {
      const row = this.require(id)
      if (row.phase === 'rejected') return { status: 200, body: toView(row) }
      // A locked payout can be cancelled while nothing has been sent to PayPal. This also voids a
      // checkout an older build opened for it.
      const cancellable = row.kind === 'payment' && !row.payout_batch_id && (row.phase === 'locked' || row.phase === 'order_created')
      if (row.phase !== 'pending_approval' && !cancellable) {
        throw new Problem(409, 'proposal.state', 'Proposal cannot be rejected', `Phase is ${row.phase}.`)
      }
      this.repo.setPhase(row.id, 'rejected', now)
      this.repo.insertEvent(randomUUID(), row.id, 'proposal.rejected', row.clause, { actor: 'owner', wasLocked: cancellable }, now)
      return { status: 200, body: toView(this.require(id)) }
    })
  }

  async capture(id: string, claimedAmountCents?: number): Promise<HttpResult> {
    const started = this.repo.transaction(() => this.beginCapture(id, claimedAmountCents))
    if (started.result) return started.result
    const row = started.row
    const resume = started.resume
    if (!this.paypal) {
      this.repo.setPhase(row.id, resume, this.iso())
      throw new Problem(503, 'paypal.unconfigured', 'PayPal is not configured', 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET before capture.')
    }
    try {
      const current = this.require(id)
      if (current.kind === 'refund') return await this.settleRefund(current)
      if (current.kind === 'payment') return await this.settlePayout(current)
      if (current.kind === 'charge' && this.invoices && !current.order_id) {
        const invoiced = await this.settleInvoice(current)
        if (invoiced) return invoiced
      }
      return await this.settlePayment(current)
    } catch (error) {
      if (this.require(id).phase === 'capture_inflight') this.repo.setPhase(id, resume, this.iso())
      if (error instanceof PayPalError) {
        throw new Problem(502, 'paypal.upstream', 'PayPal rejected the call', error.paypalName, {
          proposalId: id,
          debugId: error.debugId,
        })
      }
      throw error
    }
  }

  private async settlePayment(current: ProposalRow): Promise<HttpResult> {
    if (!this.paypal) throw new Problem(503, 'paypal.unconfigured', 'PayPal is not configured', 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET before capture.')
    if (!current.order_id) {
      const created = await this.paypal.createOrder({
        proposalId: current.id,
        amountCents: current.amount_cents,
        currency: current.currency,
        description: current.description,
        // Contractor identity stays on the warrant. The placeholder email is not a PayPal account.
        payeeEmail: null,
      })
      const now = this.iso()
      this.repo.transaction(() => {
        this.repo.saveOrder(current.id, created.orderId, created.approveUrl, now)
        this.repo.insertEvent(randomUUID(), current.id, 'order.created', current.clause, {
          orderId: created.orderId,
          payeeAttached: created.payeeAttached,
        }, now)
      })
    }
    const saved = this.require(current.id)
    const live = await this.paypal.getOrder(saved.order_id!)
    if (live.amountCents !== saved.amount_cents || live.currency !== saved.currency || live.customId !== saved.id) {
      return this.refuseLive(saved, live.amountCents, live.currency)
    }
    if (live.status !== 'APPROVED' && live.status !== 'COMPLETED') {
      this.repo.setPhase(saved.id, 'order_created', this.iso())
      throw new Problem(409, 'paypal.buyer_pending', 'Buyer has not approved the PayPal order', 'Open the approve URL, then capture again.', {
        proposalId: saved.id,
        orderId: saved.order_id,
        approveUrl: live.approveUrl ?? saved.approve_url,
      })
    }
    const captured = await this.paypal.captureOrder(saved.order_id!, saved.id)
    if (captured.amountCents !== saved.amount_cents || captured.currency !== saved.currency) {
      return this.refuseLive(saved, captured.amountCents, captured.currency)
    }
    const now = this.iso()
    this.repo.transaction(() => {
      this.repo.markCaptured(saved.id, captured.captureId, captured.amountCents, now)
      this.repo.insertEvent(randomUUID(), saved.id, 'capture.completed', saved.clause, {
        orderId: saved.order_id,
        captureId: captured.captureId,
        amountCents: captured.amountCents,
      }, now)
    })
    return { status: 200, body: toView(this.require(saved.id)) }
  }

  /** Money out. Sends one PayPal Payouts item from the lock, then reads it back from PayPal and checks it. */
  private async settlePayout(current: ProposalRow): Promise<HttpResult> {
    if (!this.paypal) throw new Problem(503, 'paypal.unconfigured', 'PayPal is not configured', 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET before capture.')
    let batchId = current.payout_batch_id
    if (!batchId) {
      const warrant = this.repo.warrant(current.warrant_id, current.warrant_version)
      const payee = warrant?.body.payees.find((item) => item.id === current.payee_id)
      if (!payee || !current.cart_hash) {
        throw new Problem(409, Clause.payeeUnknown, 'Payee is not on the rules', 'The contractor for this payout is not on the rules it was approved under. Nothing was sent.')
      }
      const sent = await this.paypal.sendPayout({
        proposalId: current.id,
        cartHash: current.cart_hash,
        receiverEmail: payee.email,
        amountCents: current.amount_cents,
        currency: current.currency,
        note: current.description,
      })
      batchId = sent.batchId
      const now = this.iso()
      this.repo.transaction(() => {
        this.repo.savePayoutBatch(current.id, sent.batchId, now)
        this.repo.insertEvent(randomUUID(), current.id, 'payout.sent', current.clause, {
          batchId: sent.batchId,
          receiver: payee.email,
          amountCents: current.amount_cents,
          currency: current.currency,
        }, now)
      })
    }
    const saved = this.require(current.id)
    const live = await this.paypal.getPayout(batchId)
    return this.applyLivePayout(saved, live)
  }

  private applyLivePayout(row: ProposalRow, live: LivePayout): HttpResult {
    const item = live.item
    if (!item) return { status: 200, body: toView(this.require(row.id)) }
    if (item.amountCents !== row.amount_cents || item.currency !== row.currency || (item.senderItemId !== null && item.senderItemId !== row.id)) {
      const now = this.iso()
      this.repo.transaction(() => {
        this.repo.refuse(row.id, now)
        this.repo.insertEvent(randomUUID(), row.id, 'capture.refused', Clause.cartImmutable, {
          lockedAmountCents: row.amount_cents,
          liveAmountCents: item.amountCents,
          liveCurrency: item.currency,
          batchId: live.batchId,
        }, now)
      })
      return {
        status: 409,
        body: problemValue(Clause.cartImmutable, 'PayPal payout does not match the locked cart', `Locked amount is ${row.amount_cents} ${row.currency} cents. PayPal reports ${item.amountCents} ${item.currency} cents.`, {
          proposalId: row.id,
          batchId: live.batchId,
          lockedAmountCents: row.amount_cents,
          liveAmountCents: item.amountCents,
        }),
      }
    }
    const update = payoutUpdate(item)
    const now = this.iso()
    this.repo.transaction(() => {
      this.repo.applyPayout(row.id, update, now)
      if (row.phase !== update.phase || row.payout_status !== item.status) {
        const type = update.phase === 'captured' ? 'payout.completed'
          : update.phase === 'payout_unclaimed' ? 'payout.unclaimed'
          : update.phase === 'payout_failed' ? 'payout.failed'
          : 'payout.status'
        this.repo.insertEvent(randomUUID(), row.id, type, row.clause, {
          batchId: live.batchId,
          itemId: item.itemId,
          status: item.status,
          transactionId: item.transactionId,
          amountCents: item.amountCents,
          feeCents: item.feeCents,
          error: item.errorName,
        }, now)
      }
    })
    return { status: 200, body: toView(this.require(row.id)) }
  }

  /** PayPal reports on a payout batch. The body is never trusted: the batch is re-read from PayPal. */
  async refreshPayoutBatch(batchId: string): Promise<{ refreshed: boolean }> {
    if (!this.paypal) return { refreshed: false }
    const row = this.repo.proposalByPayoutBatch(batchId)
    if (!row || !['payout_sent', 'payout_unclaimed'].includes(row.phase)) return { refreshed: false }
    const live = await this.paypal.getPayout(batchId)
    this.applyLivePayout(row, live)
    return { refreshed: true }
  }

  /**
   * Money in by PayPal invoice. The invoice is made from the locked cart: the client, the cents, the proof and the
   * proposal id as its reference. It settles only when PayPal says the invoice was paid, for exactly the locked
   * cents, under that reference. Returns null when the app has no permission to invoice, so checkout can take over.
   */
  private async settleInvoice(current: ProposalRow): Promise<HttpResult | null> {
    const invoices = this.invoices!
    let row = current
    if (!row.invoice_id) {
      const warrant = this.repo.warrant(row.warrant_id, row.warrant_version)
      const client = warrant?.body.clients.find((item) => item.id === row.payee_id)
      if (!client) throw new Problem(409, Clause.payeeUnknown, 'Client is not on the rules', 'The client for this charge is not on the rules it was approved under. Nothing was sent.')
      const number = invoiceNumberFor(row.id)
      let invoiceId: string | null = null
      try {
        invoiceId = (await invoices.findByNumber(number))?.invoiceId ?? null
        if (!invoiceId) {
          invoiceId = (await invoices.createDraft({
            proposalId: row.id,
            invoiceNumber: number,
            amountCents: row.amount_cents,
            currency: row.currency,
            title: row.description,
            description: row.evidence_url ? `Proof of work: ${row.evidence_url}` : row.description,
            note: row.prompt ?? row.description,
            recipientEmail: client.email,
            recipientName: client.displayName,
          })).invoiceId
        }
      } catch (error) {
        if (error instanceof PayPalError && (error.httpStatus === 401 || error.httpStatus === 403)) {
          const now = this.iso()
          this.repo.insertEvent(randomUUID(), row.id, 'invoice.unavailable', row.clause, { reason: 'PayPal app has no Invoicing permission', status: error.httpStatus }, now)
          this.repo.setPhase(row.id, row.phase === 'capture_inflight' ? 'locked' : row.phase, now)
          return null
        }
        throw error
      }
      const now = this.iso()
      this.repo.transaction(() => {
        this.repo.saveInvoiceDraft(row.id, invoiceId!, now)
        this.repo.insertEvent(randomUUID(), row.id, 'invoice.created', row.clause, { invoiceId, invoiceNumber: number, amountCents: row.amount_cents }, now)
      })
      row = this.require(row.id)
    }
    // Send once. A drafted invoice is sent; one PayPal already reports as sent, paid or cancelled is only read.
    if (row.invoice_status === 'DRAFT' || row.invoice_status === null) {
      const sent = await invoices.send(row.invoice_id!, row.description)
      const now = this.iso()
      this.repo.transaction(() => {
        this.repo.saveInvoice(row.id, row.invoice_id!, sent.payerUrl, 'SENT', now)
        this.repo.insertEvent(randomUUID(), row.id, 'invoice.sent', row.clause, { invoiceId: row.invoice_id, payerUrl: sent.payerUrl }, now)
      })
      row = this.require(row.id)
    }
    return this.applyLiveInvoice(row, await invoices.get(row.invoice_id!))
  }

  private applyLiveInvoice(row: ProposalRow, live: LiveInvoice): HttpResult {
    const paid = live.status === 'PAID' || live.status === 'PARTIALLY_PAID' || live.paidCents > 0
    const mismatch = live.totalCents !== row.amount_cents || live.currency !== row.currency || (live.reference !== null && live.reference !== row.id)
    if (mismatch) {
      // The invoice is not the one we locked. Whatever it says, we do not call it paid.
      return this.refuseLive(row, live.totalCents, live.currency)
    }
    if (live.status === 'PAID' && live.paidCents === row.amount_cents && live.transactionId) {
      const now = this.iso()
      this.repo.transaction(() => {
        this.repo.markCaptured(row.id, live.transactionId!, live.paidCents, now)
        this.repo.setInvoiceStatus(row.id, live.status, now)
        this.repo.insertEvent(randomUUID(), row.id, 'capture.completed', row.clause, { invoiceId: live.invoiceId, captureId: live.transactionId, amountCents: live.paidCents, via: 'invoice' }, now)
      })
      return { status: 200, body: toView(this.require(row.id)) }
    }
    const now = this.iso()
    // Not settled: the invoice is out with the client. Leave the "settling" marker that capture set.
    if (row.phase === 'capture_inflight') this.repo.setPhase(row.id, 'invoice_sent', now)
    if (live.status !== row.invoice_status) {
      this.repo.transaction(() => {
        this.repo.setInvoiceStatus(row.id, live.status, now)
        this.repo.insertEvent(randomUUID(), row.id, 'invoice.status', row.clause, { invoiceId: live.invoiceId, status: live.status, paidCents: live.paidCents }, now)
      })
    }
    if (live.status === 'CANCELLED') {
      this.repo.setPhase(row.id, 'capture_refused', now)
      this.repo.insertEvent(randomUUID(), row.id, 'capture.refused', row.clause, { invoiceId: live.invoiceId, reason: 'invoice cancelled' }, now)
    } else if (paid) {
      // Paid, but not in full or not through PayPal: the money is not the locked cents, so it is not called settled.
      this.repo.insertEvent(randomUUID(), row.id, 'invoice.partial', row.clause, { invoiceId: live.invoiceId, paidCents: live.paidCents, lockedCents: row.amount_cents }, now)
    }
    return { status: 200, body: toView(this.require(row.id)) }
  }

  /** A PayPal invoice event names an invoice. Re-read it from PayPal and settle only on what PayPal says. */
  async refreshInvoice(invoiceId: string): Promise<{ refreshed: boolean }> {
    if (!this.invoices) return { refreshed: false }
    const row = this.repo.proposalByInvoice(invoiceId)
    if (!row || !INVOICE_PHASES.includes(row.phase)) return { refreshed: false }
    this.applyLiveInvoice(row, await this.invoices.get(invoiceId))
    return { refreshed: true }
  }

  private async settleRefund(current: ProposalRow): Promise<HttpResult> {
    if (!this.paypal) throw new Problem(503, 'paypal.unconfigured', 'PayPal is not configured', 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET before capture.')
    if (!current.parent_capture_id) {
      throw new Problem(409, Clause.refundUnlinked, 'Refund is not linked to a capture', 'The parent capture id is missing.')
    }
    const refunded = await this.paypal.refundCapture({
      proposalId: current.id,
      captureId: current.parent_capture_id,
      amountCents: current.amount_cents,
      currency: current.currency,
    })
    const now = this.iso()
    this.repo.transaction(() => {
      this.repo.markRefunded(current.id, refunded.refundId, current.amount_cents, now)
      this.repo.insertEvent(randomUUID(), current.id, 'refund.completed', current.clause, {
        parentCaptureId: current.parent_capture_id,
        refundId: refunded.refundId,
        amountCents: current.amount_cents,
      }, now)
    })
    return { status: 200, body: toView(this.require(current.id)) }
  }

  listProposals(limit: number, cursor: { createdAt: string; id: string } | null) {
    const rows = this.repo.listProposals(limit + 1, cursor)
    return page(rows.map(toView), limit)
  }

  listLedger(limit: number, cursor: { createdAt: string; id: string } | null) {
    const rows = this.repo.listEvents(limit + 1, cursor)
    const data = rows.slice(0, limit).map((row) => ({
      id: row.id,
      proposalId: row.proposal_id,
      type: row.type,
      clause: row.clause,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }))
    const last = data[data.length - 1]
    return { data, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null }
  }

  packet(id: string) {
    const row = this.require(id)
    const warrant = this.repo.warrant(row.warrant_id, row.warrant_version)
    const payee = warrant && row.payee_id ? warrant.body.payees.find((item) => item.id === row.payee_id) ?? null : null
    const events = this.repo.eventsFor(id).map((event) => ({
      id: event.id,
      type: event.type,
      clause: event.clause,
      payload: JSON.parse(event.payload_json) as unknown,
      createdAt: event.created_at,
    }))
    const approval = events.find((event) => event.type === 'proposal.approved') ?? null
    const captured = row.phase === 'captured' || row.phase === 'refunded'
    return {
      proposal: toView(row),
      payee,
      warrant: warrant ? { id: warrant.id, version: warrant.version, currency: warrant.body.currency, monthlyCapCents: warrant.body.monthlyCapCents, autoSettleUnderCents: warrant.body.autoSettleUnderCents } : null,
      prompt: row.prompt,
      clause: row.clause,
      approval,
      invoice: row.invoice_id ? { id: row.invoice_id, status: row.invoice_status, url: row.invoice_url } : null,
      agentRun: this.agentRunFor(events),
      lock: row.cart_hash ? {
        hash: row.cart_hash,
        signature: row.lock_sig,
        keyId: row.lock_key_id,
        algorithm: 'ed25519' as const,
        signatureValid: this.lockValid(row),
      } : null,
      amounts: {
        approvedCents: row.cart_hash ? row.amount_cents : null,
        capturedCents: row.captured_amount_cents,
        match: captured ? row.captured_amount_cents === row.amount_cents : null,
      },
      orderId: row.order_id,
      captureId: row.capture_id,
      payout: row.payout_batch_id ? {
        batchId: row.payout_batch_id,
        itemId: row.payout_item_id,
        status: row.payout_status,
        transactionId: row.payout_txn_id,
        feeCents: row.payout_fee_cents,
        receiver: payee?.email ?? null,
      } : null,
      job: row.job_id,
      funding: row.funding_capture_id ? this.fundingSummary(row.funding_capture_id) : null,
      events,
    }
  }

  /** The chat behind a request, when an agent asked for it. The receipt can then answer "who said what". */
  private agentRunFor(events: Array<{ type: string; payload: unknown }>) {
    const created = events.find((event) => event.type === 'proposal.created')
    const runId = (created?.payload as { runId?: unknown } | undefined)?.runId
    if (typeof runId !== 'string') return null
    const run = this.repo.agentRun(runId)
    if (!run) return null
    return { id: run.id, agent: run.agent, model: run.model, status: run.status, input: run.input, output: run.output, createdAt: run.created_at }
  }

  private fundingSummary(captureId: string) {
    const charge = this.repo.paymentByCapture(captureId)
    if (!charge) return { captureId, proposalId: null, clientId: null, capturedCents: null, phase: 'missing' }
    return {
      captureId,
      proposalId: charge.id,
      clientId: charge.payee_id,
      jobId: charge.job_id,
      capturedCents: charge.captured_amount_cents,
      orderId: charge.order_id,
      phase: charge.phase,
    }
  }

  private proposeNew(input: ProposalCreate, now: string, actor: Role, runId: string | null = null): HttpResult {
    if (input.proposalId) return this.amend(input, now)
    const warrant = this.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const parent = input.kind === 'refund' && input.parentCaptureId ? this.repo.paymentByCapture(input.parentCaptureId) : null
    const payee = input.kind === 'charge' || parent?.kind === 'charge'
      ? resolveClient(warrant.body, input.payee)
      : resolvePayee(warrant.body, input.payee)
    const fundingRow = input.kind === 'payment' && input.fundingCaptureId ? this.repo.paymentByCapture(input.fundingCaptureId) : null
    const jobId = input.jobId ?? (input.kind === 'refund' ? parent?.job_id : fundingRow?.job_id) ?? null
    const fundingCaptureId = input.kind === 'payment' ? input.fundingCaptureId ?? null : null
    const category = input.kind === 'refund' && !input.category && parent?.category
      ? parent.category
      : resolveCategory(warrant.body, input.category)
    const evidenceUrl = input.evidenceUrl ?? (input.kind === 'refund' ? parent?.evidence_url ?? null : null)
    const cap = this.reservation(warrant.id, warrant.body, now)
    const dealId = input.kind === 'charge' ? input.dealId ?? null : null
    const milestone = dealId ? input.milestone ?? null : null
    const deal = input.kind === 'charge' ? this.dealContext(dealId, milestone, jobId) : null
    const decision = decide(warrant.body, {
      kind: input.kind,
      payeeId: payee?.id ?? null,
      amountCents: input.amountCents,
      currency: input.currency,
      category,
      evidenceUrl,
      parent: parent ? {
        payeeId: parent.payee_id ?? '',
        amountCents: parent.amount_cents,
        heldCents: this.repo.heldRefundCents(parent.capture_id!),
        currency: parent.currency,
        category: parent.category ?? '',
        evidenceUrl: parent.evidence_url,
        phase: parent.phase,
      } : null,
      jobId,
      fundingCaptureId,
      funding: fundingRow ? this.fundingState(fundingRow) : null,
      dealId,
      milestone,
      deal,
    }, cap)
    const id = randomUUID()
    const lockNow = decision.gate === 'AUTO'
    const fields: CartFields | null = lockNow && payee && category && evidenceUrl ? {
      proposalId: id,
      warrantId: warrant.id,
      warrantVersion: warrant.version,
      payeeId: payee.id,
      amountCents: input.amountCents,
      currency: input.currency,
      category,
      evidenceUrl,
      kind: input.kind,
      parentCaptureId: input.parentCaptureId ?? null,
      jobId,
      fundingCaptureId,
      dealId,
      milestone,
    } : null
    const lockHash = fields ? cartHash(fields) : null
    const lockSig = lockHash ? this.signer.sign(lockMessage(id, lockHash)) : null
    const phase = decision.gate === 'DENY' ? 'denied' : lockNow ? 'locked' : 'pending_approval'
    this.repo.insertProposal({
      id,
      warrantId: warrant.id,
      warrantVersion: warrant.version,
      kind: input.kind,
      parentCaptureId: input.parentCaptureId ?? null,
      jobId,
      fundingCaptureId,
      dealId,
      milestone,
      payeeId: payee?.id ?? null,
      amountCents: input.amountCents,
      currency: input.currency,
      category,
      description: input.description,
      evidenceUrl,
      prompt: input.prompt ?? null,
      gate: decision.gate,
      clause: decision.clause,
      detail: decision.detail,
      phase,
      cartHash: lockHash,
      lockSig: lockSig?.signature ?? null,
      lockKeyId: lockSig?.keyId ?? null,
      reservedAt: lockNow ? now : null,
      now,
    })
    this.repo.insertEvent(randomUUID(), id, 'proposal.created', decision.clause, {
      actor,
      gate: decision.gate,
      prompt: input.prompt ?? null,
      runId,
      priorCaptureIds: decision.clause === Clause.capMonthly ? cap.priorCaptureIds : undefined,
    }, now)
    const view = toView(this.require(id))
    return { status: 201, body: view }
  }

  private amend(input: ProposalCreate, now: string): HttpResult {
    const row = this.repo.proposal(input.proposalId!)
    if (!row) throw new Problem(404, 'proposal.missing', 'Proposal not found', 'No proposal matches that id.')
    const warrant = this.repo.warrant(row.warrant_id, row.warrant_version)
    const payee = warrant
      ? (row.kind === 'charge' || (row.kind === 'refund' && this.isClient(warrant.body, row.payee_id)) ? resolveClient : resolvePayee)(warrant.body, input.payee)
      : null
    const category = resolveCategory(warrant?.body ?? emptyWarrant(), input.category)
    const same = row.amount_cents === input.amountCents
      && row.currency === input.currency
      && row.kind === input.kind
      && (row.parent_capture_id ?? null) === (input.parentCaptureId ?? null)
      && row.payee_id === (payee?.id ?? null)
      && (row.category ?? null) === category
      && row.description === input.description
      && (row.evidence_url ?? null) === (input.evidenceUrl ?? null)
      && (row.prompt ?? null) === (input.prompt ?? null)
      && (input.jobId === undefined || row.job_id === input.jobId)
      && (row.funding_capture_id ?? null) === (input.kind === 'payment' ? input.fundingCaptureId ?? null : null)
    if (same) return { status: 200, body: toView(row) }
    this.repo.insertEvent(randomUUID(), row.id, 'cart.mutation_refused', Clause.cartImmutable, {
      claimedAmountCents: input.amountCents,
      lockedAmountCents: row.amount_cents,
    }, now)
    return {
      status: 409,
      body: problemValue(Clause.cartImmutable, 'Locked cart rejected a different proposal', `Proposal ${row.id} stays at ${row.amount_cents} ${row.currency} cents.`, {
        proposalId: row.id,
        lockedAmountCents: row.amount_cents,
        claimedAmountCents: input.amountCents,
        phase: row.phase,
      }),
    }
  }

  private beginCapture(id: string, claimedAmountCents: number | undefined): { result: HttpResult | null; row: ProposalRow; resume: string } {
    const row = this.require(id)
    const now = this.iso()
    if (claimedAmountCents !== undefined && claimedAmountCents !== row.amount_cents) {
      this.repo.insertEvent(randomUUID(), row.id, 'capture.refused', Clause.cartImmutable, {
        claimedAmountCents,
        lockedAmountCents: row.amount_cents,
      }, now)
      return {
        result: {
          status: 409,
          body: problemValue(Clause.cartImmutable, 'Locked cart rejected a different amount', `Locked amount is ${row.amount_cents} cents. Claimed amount is ${claimedAmountCents} cents.`, {
            proposalId: row.id,
            lockedAmountCents: row.amount_cents,
            claimedAmountCents,
            phase: row.phase,
          }),
        },
        row,
        resume: row.phase,
      }
    }
    if (row.phase === 'captured' || row.phase === 'refunded' || row.phase === 'payout_failed') {
      return { result: { status: 200, body: toView(row) }, row, resume: row.phase }
    }
    if (row.phase === 'capture_inflight') {
      const age = Date.now() - Date.parse(row.updated_at)
      if (age >= 0 && age < INFLIGHT_MS) {
        throw new Problem(409, 'capture.inflight', 'Capture is already running', 'Retry shortly. The PayPal call uses a stable idempotency key.')
      }
    } else if (!RESUME_PHASES.has(row.phase) || !row.cart_hash || row.gate === 'DENY') {
      throw new Problem(409, 'proposal.state', 'Proposal cannot be captured', `Phase is ${row.phase}.`)
    }
    const fields = this.cartFields(row)
    if (cartHash(fields) !== row.cart_hash) {
      throw new Problem(409, Clause.cartImmutable, 'Cart hash does not match the row', 'The stored cart does not match its hash.', { proposalId: row.id })
    }
    // A hash can be recomputed by anyone who can write the database. Only the server's key can sign it.
    if (!this.lockValid(row)) {
      this.repo.insertEvent(randomUUID(), row.id, 'capture.refused', 'lock.signature_invalid', { keyId: row.lock_key_id, signed: Boolean(row.lock_sig) }, now)
      throw new Problem(409, 'lock.signature_invalid', 'The lock signature does not verify', 'This lock was not signed by the server, or was changed after it was signed. PayPal was not called.', { proposalId: row.id })
    }
    // Once PayPal holds the batch the money may already have left, so a later refund of the client payment cannot stop it.
    if (row.kind === 'payment' && row.funding_capture_id && !row.payout_batch_id) {
      const funding = this.repo.paymentByCapture(row.funding_capture_id)
      const warrant = this.repo.warrant(row.warrant_id, row.warrant_version)
      const state = funding ? this.fundingState(funding) : null
      // This payout is already counted in payoutHeldCents, so a negative balance means the client money shrank.
      const over = !state || state.phase !== 'captured' || !warrant
        || Math.floor((Math.max(0, state.capturedCents - state.refundHeldCents) * warrant.body.contractorShareBps) / 10_000) < state.payoutHeldCents
      if (over) {
        this.repo.insertEvent(randomUUID(), row.id, 'capture.refused', Clause.fundingExceeds, { fundingCaptureId: row.funding_capture_id }, now)
        throw new Problem(409, Clause.fundingExceeds, 'Client payment no longer funds this payout', `Client capture ${row.funding_capture_id} was refunded or is missing. PayPal was not called.`, {
          proposalId: row.id,
          fundingCaptureId: row.funding_capture_id,
        })
      }
    }
    const resume = row.phase === 'capture_inflight' ? (row.payout_batch_id ? 'payout_sent' : row.invoice_id ? 'invoice_sent' : row.order_id ? 'order_created' : 'locked') : row.phase
    this.repo.setPhase(row.id, 'capture_inflight', now)
    return { result: null, row, resume }
  }

  private refuseLive(row: ProposalRow, amountCents: number | null, currency: string | null): HttpResult {
    const now = this.iso()
    this.repo.transaction(() => {
      this.repo.refuse(row.id, now)
      this.repo.insertEvent(randomUUID(), row.id, 'capture.refused', Clause.cartImmutable, {
        lockedAmountCents: row.amount_cents,
        liveAmountCents: amountCents,
        liveCurrency: currency,
        orderId: row.order_id,
      }, now)
    })
    return {
      status: 409,
      body: problemValue(Clause.cartImmutable, 'PayPal order does not match the locked cart', `Locked amount is ${row.amount_cents} ${row.currency} cents.`, {
        proposalId: row.id,
        orderId: row.order_id,
        lockedAmountCents: row.amount_cents,
        liveAmountCents: amountCents,
      }),
    }
  }

  private capState(row: ProposalRow, now: string) {
    const warrant = this.repo.warrant(row.warrant_id, row.warrant_version)
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'The warrant version for this proposal is gone.')
    return { warrant, ...this.reservation(warrant.id, warrant.body, now) }
  }

  private reservation(warrantId: string, warrant: WarrantBody, now: string) {
    const window = monthWindow(new Date(now), warrant.timezone)
    const rows = this.repo.reservations(warrantId, window.start, window.end)
    let reservedCents = 0
    const priorCaptureIds: string[] = []
    for (const row of rows) {
      const refunded = row.captureId ? this.repo.refundedCents(row.captureId) : 0
      reservedCents += Math.max(0, row.amountCents - refunded)
      if (row.captureId) priorCaptureIds.push(row.captureId)
    }
    return { reservedCents, priorCaptureIds }
  }

  private cartFields(row: ProposalRow): CartFields {
    if (!row.payee_id || !row.category || !row.evidence_url) {
      throw new Problem(409, 'proposal.state', 'Proposal cannot be captured', 'The cart is missing payee, category, or evidence.')
    }
    return {
      proposalId: row.id,
      warrantId: row.warrant_id,
      warrantVersion: row.warrant_version,
      payeeId: row.payee_id,
      amountCents: row.amount_cents,
      currency: row.currency,
      category: row.category,
      evidenceUrl: row.evidence_url,
      kind: row.kind,
      parentCaptureId: row.parent_capture_id,
      jobId: row.job_id,
      fundingCaptureId: row.funding_capture_id,
      dealId: row.deal_id,
      milestone: row.milestone,
    }
  }

  /** The deal facts the gate needs for a charge. Resolved here so the gate itself stays a pure function. */
  private dealContext(dealId: string | null, milestone: number | null, jobId: string | null): DealContext {
    const row = dealId ? this.repo.deal(dealId) : null
    const terms = row && row.status === 'agreed' ? (JSON.parse(row.terms_json) as { milestones: Array<{ amountCents: number }> }) : null
    return {
      agreed: row && terms && row.job_id ? { id: row.id, jobId: row.job_id, buyerId: row.buyer_id, milestoneCents: terms.milestones.map((item) => item.amountCents) } : null,
      jobHasDeal: jobId ? this.repo.agreedDealByJob(jobId) !== null : false,
      milestoneBilled: dealId && milestone !== null ? this.repo.chargeForMilestone(dealId, milestone) !== null : false,
    }
  }

  private fundingState(row: ProposalRow): FundingCharge {
    return {
      kind: row.kind,
      phase: row.phase,
      jobId: row.job_id,
      currency: row.currency,
      capturedCents: row.captured_amount_cents ?? 0,
      refundHeldCents: row.capture_id ? this.repo.heldRefundCents(row.capture_id) : 0,
      payoutHeldCents: row.capture_id ? this.repo.heldPayoutCents(row.capture_id) : 0,
    }
  }

  private fundingBlock(row: ProposalRow, warrant: WarrantBody): { clause: string; detail: string } | null {
    if (row.kind !== 'payment' || !warrant.fundingRequired) return null
    const funding = row.funding_capture_id ? this.repo.paymentByCapture(row.funding_capture_id) : null
    if (!funding || funding.kind !== 'charge' || funding.phase !== 'captured') {
      return { clause: Clause.fundingMissing, detail: 'a contractor payout must cite a captured client payment' }
    }
    const available = fundableCents(warrant, this.fundingState(funding))
    if (row.amount_cents > available) {
      return { clause: Clause.fundingExceeds, detail: `client payment ${row.funding_capture_id} can fund ${available} more cents` }
    }
    return null
  }

  private isClient(warrant: WarrantBody, partyId: string | null): boolean {
    return partyId !== null && warrant.clients.some((client) => client.id === partyId)
  }

  job(jobId: string) {
    const rows = this.repo.proposalsForJob(jobId)
    if (rows.length === 0) throw new Problem(404, 'job.missing', 'Job not found', 'No proposal names this job.')
    const warrant = this.repo.warrant(rows[0]!.warrant_id, rows[0]!.warrant_version)
    const clientId = rows.find((row) => row.kind === 'charge')?.payee_id ?? null
    const client = warrant && clientId ? warrant.body.clients.find((item) => item.id === clientId) ?? null : null
    const charges = rows.filter((row) => row.kind === 'charge')
    const payouts = rows.filter((row) => row.kind === 'payment')
    const refunds = rows.filter((row) => row.kind === 'refund')
    const refundedOf = (row: ProposalRow) => (row.capture_id ? this.repo.refundedCents(row.capture_id) : 0)
    const inCents = charges.filter((row) => row.phase === 'captured').reduce((sum, row) => sum + (row.captured_amount_cents ?? 0) - refundedOf(row), 0)
    const outCents = payouts.filter((row) => row.phase === 'captured').reduce((sum, row) => sum + (row.captured_amount_cents ?? 0) - refundedOf(row), 0)
    const heldCents = payouts.filter((row) => ['locked', 'order_created', 'capture_inflight', ...PAYOUT_LIVE_PHASES].includes(row.phase)).reduce((sum, row) => sum + row.amount_cents, 0)
    return {
      jobId,
      client,
      contractorShareBps: warrant?.body.contractorShareBps ?? null,
      charges: charges.map((row) => ({
        ...toView(row),
        fundableCents: row.phase === 'captured' && warrant ? fundableCents(warrant.body, this.fundingState(row)) : 0,
      })),
      payouts: payouts.map(toView),
      refunds: refunds.map(toView),
      totals: { inCents, outCents, heldCents, keptCents: inCents - outCents - heldCents },
    }
  }

  private require(id: string): ProposalRow {
    const row = this.repo.proposal(id)
    if (!row) throw new Problem(404, 'proposal.missing', 'Proposal not found', 'No proposal matches that id.')
    return row
  }

  private iso(): string {
    return this.now().toISOString()
  }
}

function page<T extends { createdAt: string; id: string }>(rows: T[], limit: number) {
  const data = rows.slice(0, limit)
  const last = data[data.length - 1]
  return { data, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null }
}

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  let raw = ''
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8')
  } catch {
    throw new Problem(400, 'cursor.invalid', 'Cursor is invalid', 'The cursor could not be read.')
  }
  const split = raw.indexOf('\n')
  if (split <= 0) throw new Problem(400, 'cursor.invalid', 'Cursor is invalid', 'The cursor could not be read.')
  const createdAt = raw.slice(0, split)
  const id = raw.slice(split + 1)
  if (!id || Number.isNaN(Date.parse(createdAt))) {
    throw new Problem(400, 'cursor.invalid', 'Cursor is invalid', 'The cursor could not be read.')
  }
  return { createdAt, id }
}

function payoutUpdate(item: NonNullable<LivePayout['item']>): PayoutUpdate {
  const phase = item.status === 'SUCCESS' ? 'captured'
    : item.status === 'UNCLAIMED' ? 'payout_unclaimed'
    : ['FAILED', 'BLOCKED', 'RETURNED', 'DENIED', 'REFUNDED', 'REVERSED'].includes(item.status) ? 'payout_failed'
    : 'payout_sent'
  return {
    phase,
    status: item.status,
    itemId: item.itemId,
    transactionId: item.transactionId,
    feeCents: item.feeCents,
    paidCents: phase === 'captured' ? item.amountCents : null,
  }
}

function problemValue(code: string, title: string, detail: string, extensions: Record<string, unknown>) {
  return {
    type: `urn:mandate:problem:${code}`,
    title,
    status: 409,
    detail,
    code,
    ...extensions,
  }
}

function emptyWarrant(): WarrantBody {
  return {
    currency: 'USD',
    autoSettleUnderCents: 1,
    monthlyCapCents: 1,
    perPaymentCeilingCents: 1,
    evidenceRequired: true,
    timezone: 'UTC',
    payees: [],
    categories: [],
    clients: [],
    fundingRequired: false,
    contractorShareBps: 10_000,
  }
}
