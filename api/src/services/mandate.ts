import { randomUUID } from 'node:crypto'
import { RESERVED_PHASES, type Repo, type ProposalRow, type ProposalKind, type PayoutUpdate } from '../db/repo'
import { Clause, decide, fundableCents, type Decision, resolveCategory, resolveClient, resolvePayee, type DealContext, type FundingCharge } from '../domain/gate'
import { cartHash, stableHash, type CartFields } from '../domain/hash'
import { acceptanceMessage, lockMessage, proofHash, type Signer } from '../domain/signing'
import { monthWindow } from '../domain/period'
import type { ProposalCreate, WarrantBody } from '../domain/schemas'
import { NO_AUTOMATION, ProposalCreateSchema, WARRANT_ID, WarrantBodySchema } from '../domain/schemas'
import { invoiceNumberFor, type InvoicePort, type LiveInvoice } from '../paypal/invoices'
import { PayPalError, type LivePayout, type PayPalPort } from '../paypal/port'
import type { LiveDispute, WatchPort } from '../paypal/watch'
import { assessFeatures } from '../domain/paypalFeatures'
import { reconcile } from '../domain/reconcile'
import { Problem } from '../http/problem'
import { paypalProblem } from './paypalProblem'
import { applyPause, NOT_PAUSED } from '../domain/safety'
import type { SafetyService } from './safety'
import { runIdempotent } from './idempotency'

export type HttpResult = { status: number; body: unknown }
/** Who asked. `autopilot` is the server itself, acting under a rule the owner signed. */
export type Role = 'owner' | 'proposer' | 'autopilot'

const RESUME_PHASES = new Set(['locked', 'order_created', 'invoice_draft', 'invoice_sent', 'payout_sent', 'payout_unclaimed'])
/** Charge phases where a PayPal invoice exists. The client may already have paid it. */
export const FAST_SWEEP_MS = 5_000
export const IDLE_SWEEP_MS = 60_000
const INVOICE_PHASES = ['invoice_draft', 'invoice_sent']
/** Payout phases where PayPal already holds the batch, so money may already have left. */
const PAYOUT_LIVE_PHASES = ['payout_sent', 'payout_unclaimed']
const INFLIGHT_MS = 30_000
/** Reasons a standing-rule payout may wait rather than die: the trouble is outside Mandate and may pass. */
const STANDING_WAITS = new Set(['funding.disputed', 'funding.unverifiable', 'paypal.upstream', 'paypal.unavailable', 'paypal.unconfigured', 'capture.inflight', 'paypal.buyer_pending'])
const STANDING_CLAUSES: string[] = [Clause.standingMatched, Clause.standingBilling]

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

/** PayPal's reporting API wants 2026-10-05T10:00:00+0000, not the usual ISO with milliseconds and Z. */
const payPalTime = (date: Date) => date.toISOString().replace(/\.\d+Z$/, '+0000')

export class MandateService {
  constructor(
    private readonly repo: Repo,
    private readonly paypal: PayPalPort | null,
    private readonly now: () => Date,
    private readonly signer: Signer,
    /** Bill clients with PayPal invoices (the Agent Toolkit). Null means checkout only. */
    private readonly invoices: InvoicePort | null = null,
    private readonly options: {
      /** Where this server is reached. PayPal sends the buyer back here after they approve a checkout. */
      publicUrl?: string
      /** Read-only view of the PayPal account: disputes and transactions. */
      watch?: WatchPort | null
      /** The emergency stop and the breaker. Absent in tests that do not need it. */
      safety?: SafetyService
    } = {},
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

  /**
   * Publishes the next version of the rules. A caller that says which version it started from (`expectedVersion`) is
   * refused if someone has published since: two people editing never silently overwrite each other.
   */
  publishWarrant(input: unknown, expectedVersion?: number): HttpResult {
    const parsed = WarrantBodySchema.safeParse(input)
    if (!parsed.success) throw parsed.error
    const now = this.iso()
    const saved = this.repo.transaction(() => {
      const current = this.repo.latestWarrant()
      if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) {
        throw new Problem(409, 'rules.stale', 'The rules changed while you were editing', `You started from version ${expectedVersion}, but version ${current?.version ?? 0} is live now. Nothing was published. Start again from the live version so you do not undo someone else's change.`)
      }
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

  /**
   * Ask, and if the owner's standing rule covers it, send. A payout that matches a standing rule is already locked
   * and signed when it is proposed. Nothing in the rule lets it skip a check: the server runs the same settle path
   * the owner's Send button runs, and that path re-checks funding, disputes and the lock. If PayPal cannot be
   * reached, the payout stays locked and the next sweep tries again.
   */
  async proposeAndDispatch(input: ProposalCreate, idempotencyKey: string, actor: Role = 'owner', runId: string | null = null): Promise<HttpResult> {
    // Look for a client dispute first, so a disputed payment is refused at the gate instead of waiting at the door.
    if (input.kind === 'payment' && input.fundingCaptureId) await this.refreshDisputesFor(input.fundingCaptureId).catch(() => undefined)
    const result = this.propose(input, idempotencyKey, actor, runId)
    const body = result.body as { id?: string } | null
    if (!body?.id || (result.status !== 201 && result.status !== 200)) return result
    const sent = await this.dispatchStanding(body.id)
    return sent ? { status: result.status, body: sent } : result
  }

  /** Sends a locked payout, or an invoice, that a standing rule approved. Returns the fresh view, or null if it is not such a request. */
  async dispatchStanding(id: string): Promise<ProposalView | null> {
    const row = this.repo.proposal(id)
    if (!row || !['payment', 'charge'].includes(row.kind) || !STANDING_CLAUSES.includes(row.clause) || !['locked', 'order_created'].includes(row.phase)) return null
    // Paused: a payout the owner's rule already approved waits, locked, and is sent when Mandate is resumed.
    if (this.options.safety?.paused()) {
      const last = [...this.repo.eventsFor(id)].reverse().find((event) => event.type === 'standing.waiting')
      if (!last || (JSON.parse(last.payload_json) as { code?: string }).code !== Clause.systemPaused) {
        this.repo.insertEvent(randomUUID(), id, 'standing.waiting', Clause.standingMatched, { code: Clause.systemPaused, detail: 'Mandate is paused, so this waits locked until the owner resumes it' }, this.iso())
      }
      return toView(this.require(id))
    }
    try {
      await this.capture(id)
    } catch (error) {
      if (!(error instanceof Problem)) throw error
      const now = this.iso()
      if (STANDING_WAITS.has(error.code)) {
        // Something outside Mandate is in the way. Say so once, keep the payout locked, and let the sweep try again.
        const last = [...this.repo.eventsFor(id)].reverse().find((event) => event.type === 'standing.waiting')
        if (!last || (JSON.parse(last.payload_json) as { code?: string }).code !== error.code) {
          this.repo.insertEvent(randomUUID(), id, 'standing.waiting', Clause.standingMatched, { code: error.code, detail: error.detail }, now)
        }
      } else if (this.require(id).phase !== 'capture_refused') {
        // The lock, the funding or the state is wrong. Retrying cannot fix that, and it must not hold the money forever.
        this.repo.transaction(() => {
          this.repo.setPhase(id, 'capture_refused', now)
          this.repo.insertEvent(randomUUID(), id, 'capture.refused', error.code, { detail: error.detail, via: 'standing rule' }, now)
        })
      }
    }
    return toView(this.require(id))
  }

  /** When the server last asked PayPal about money in flight, and how much it looked at. Shown on Today so the automation is visible. */
  private lastLook: { at: string; payouts: number; invoices: number; reminded: number } | null = null

  /** How many invoices and payouts are still waiting on PayPal. While there are any, the server looks often. */
  inFlightCount(): number {
    return this.repo.openPayoutBatches().length + (this.invoices ? this.repo.openInvoices().length : 0)
  }

  /** Quick while money is in flight (so a payment shows within seconds), slow when nothing is. */
  nextSweepMs(): number {
    return this.inFlightCount() > 0 ? FAST_SWEEP_MS : IDLE_SWEEP_MS
  }

  watcher() {
    return { everySeconds: Math.round(this.nextSweepMs() / 1000), lastLook: this.lastLook }
  }

  /**
   * The server's own look at money in flight (every few seconds while something is waiting, once a minute otherwise): payouts PayPal is still processing and invoices still
   * out. It re-reads PayPal (the same read the Check PayPal button does), so a payout or an invoice settles without
   * anyone pressing anything, and without needing a webhook. One failing item never stops the others.
   */
  async sweepPending(): Promise<{ payouts: number; invoices: number; reminded: number }> {
    const payouts = this.repo.openPayoutBatches()
    const invoices = this.invoices ? this.repo.openInvoices() : []
    for (const batch of payouts) await this.refreshPayoutBatch(batch, 'server').catch(() => undefined)
    for (const invoice of invoices) await this.refreshInvoice(invoice, 'server').catch(() => undefined)
    const reminded = await this.remindOverdueInvoices().catch(() => 0)
    this.lastLook = { at: this.iso(), payouts: payouts.length, invoices: invoices.length, reminded }
    return { payouts: payouts.length, invoices: invoices.length, reminded }
  }

  /**
   * The owner's chase schedule. An invoice still unpaid N days after it was sent (or after the last reminder) gets
   * PayPal's own reminder, up to a maximum. It never cancels, never changes the amount, and stops at the maximum.
   */
  private async remindOverdueInvoices(): Promise<number> {
    const automation = this.repo.latestWarrant()?.body.automation
    if (this.options.safety?.paused() || !this.invoices || !automation?.remindUnpaidAfterDays || automation.maxReminders < 1) return 0
    let sent = 0
    for (const row of this.repo.invoicesOut()) {
      const events = this.repo.eventsFor(row.id)
      const reminders = events.filter((event) => event.type === 'invoice.reminded')
      const since = reminders.at(-1)?.created_at ?? events.find((event) => event.type === 'invoice.sent')?.created_at
      if (!since || reminders.length >= automation.maxReminders) continue
      if (this.now().getTime() - Date.parse(since) < automation.remindUnpaidAfterDays * 86_400_000) continue
      await this.remindInvoice(row.id, 'autopilot')
      sent += 1
    }
    return sent
  }

  /** Looks for standing-rule payouts that are approved but not yet sent (PayPal was down, or a dispute held them) and sends them. */
  async sweepStanding(): Promise<number> {
    if (this.options.safety?.paused()) return 0
    const stuck = this.repo.lockedStandingItems()
    for (const row of stuck) await this.dispatchStanding(row.id)
    return stuck.length
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
    const before = this.repo.proposal(id)?.phase
    const result = await this.captureCore(id, claimedAmountCents)
    // A client payment that has just settled may owe a contractor their share. Only a settling counts, not a re-read.
    if (before && before !== 'captured') await this.afterMoney(id).catch(() => undefined)
    return result
  }

  private async captureCore(id: string, claimedAmountCents?: number): Promise<HttpResult> {
    await this.freshenFundingDisputes(id)
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
        throw paypalProblem(error, 'to settle this request', { proposalId: id })
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
        ...(this.options.publicUrl ? {
          returnUrl: `${this.options.publicUrl}/app/p/${current.id}?paypal=return`,
          cancelUrl: `${this.options.publicUrl}/app/p/${current.id}?paypal=cancel`,
        } : {}),
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
  // ---------- what PayPal knows about the account ----------

  /** Which PayPal features this app may use, read from its token scopes. `fresh` asks PayPal for a new token first. */
  async features(fresh = false) {
    if (!this.paypal) return { configured: false, checkedAt: this.iso(), features: assessFeatures([]) }
    const scopes = await this.paypal.scopes(fresh)
    return { configured: true, checkedAt: this.iso(), features: assessFeatures(scopes) }
  }

  /** What PayPal says the account holds. Advice for the owner, never a gate: the report lags by hours, and PayPal fails a payout it cannot fund. */
  async balance() {
    if (!this.paypal) return { available: false as const, reason: 'PayPal is not configured.' }
    try {
      const warrant = this.repo.latestWarrant()
      const found = await this.paypal.balance(warrant?.body.currency ?? 'USD')
      return { available: true as const, ...found, currency: warrant?.body.currency ?? 'USD' }
    } catch (error) {
      if (error instanceof PayPalError && (error.httpStatus === 401 || error.httpStatus === 403)) return { available: false as const, reason: 'The PayPal app has no permission to read the balance (Transaction search).' }
      throw paypalProblem(error, 'to read the balance')
    }
  }

  /** PayPal's own list of what moved in the account, lined up against the ledger. Read-only. */
  async activity(days = 30) {
    const watch = this.options.watch
    if (!watch) return { available: false as const, reason: 'PayPal is not configured.' }
    const end = this.now()
    const start = new Date(end.getTime() - Math.min(Math.max(days, 1), 31) * 86_400_000)
    try {
      const transactions = await watch.listTransactions({ start: payPalTime(start), end: payPalTime(end) })
      return { available: true as const, from: start.toISOString(), to: end.toISOString(), ...reconcile(transactions, this.repo.knownPayPalIds()) }
    } catch (error) {
      if (error instanceof PayPalError && (error.httpStatus === 401 || error.httpStatus === 403)) {
        return { available: false as const, reason: 'The PayPal app has no Transaction Search permission.' }
      }
      throw paypalProblem(error, 'to list transactions')
    }
  }

  /** Reads disputes from PayPal, stores them, and records when one opens or closes. Returns how many are open. */
  async syncDisputes(): Promise<{ checked: boolean; open: number; disputes: ReturnType<Repo['listDisputes']> }> {
    const watch = this.options.watch
    if (!watch) return { checked: false, open: 0, disputes: this.repo.listDisputes(50) }
    for (const live of await watch.listDisputes()) this.recordDispute(live)
    const disputes = this.repo.listDisputes(50)
    return { checked: true, open: disputes.filter((item) => item.status !== 'RESOLVED').length, disputes }
  }

  private recordDispute(live: LiveDispute): void {
    const txn = live.transactionIds[0]
    if (!live.id || !txn) return
    const previous = this.repo.disputeById(live.id)
    const now = this.iso()
    const wasOpen = previous !== null && previous.status !== 'RESOLVED'
    const isOpen = live.status !== 'RESOLVED'
    if (previous && previous.status === live.status) return
    this.repo.transaction(() => {
      this.repo.upsertDispute({ disputeId: live.id, transactionId: txn, status: live.status, reason: live.reason, amountCents: live.cents, currency: live.currency, openedAt: live.openedAt, updatedAt: now })
      const charge = this.repo.paymentByCapture(txn)
      if (!charge) return
      if (isOpen && !wasOpen) {
        this.repo.insertEvent(randomUUID(), charge.id, 'dispute.opened', Clause.fundingDisputed, { disputeId: live.id, reason: live.reason, status: live.status, amountCents: live.cents }, now)
      } else if (!isOpen && wasOpen) {
        this.repo.insertEvent(randomUUID(), charge.id, 'dispute.resolved', Clause.fundingDisputed, { disputeId: live.id, reason: live.reason }, now)
      }
    })
  }

  /**
   * Before a payout leaves, ask PayPal whether the client payment that funds it is disputed. If PayPal says the app may
   * not look (Disputes is off), payouts go on as before. If it may look and cannot answer, the payout waits: an answer
   * nobody could check is not a yes.
   */
  private async refreshDisputesFor(captureId: string): Promise<void> {
    const watch = this.options.watch
    if (!watch) return
    for (const live of await watch.listDisputes({ transactionId: captureId })) this.recordDispute(live)
  }

  private async freshenFundingDisputes(id: string): Promise<void> {
    const watch = this.options.watch
    if (!watch) return
    const row = this.repo.proposal(id)
    if (!row || row.kind !== 'payment' || !row.funding_capture_id || row.payout_batch_id) return
    const funding = this.repo.paymentByCapture(row.funding_capture_id)
    if (!funding?.capture_id) return
    try {
      for (const live of await watch.listDisputes({ transactionId: funding.capture_id })) this.recordDispute(live)
    } catch (error) {
      if (error instanceof PayPalError && (error.httpStatus === 401 || error.httpStatus === 403)) return
      throw new Problem(503, 'funding.unverifiable', 'Could not check for disputes', 'PayPal did not answer whether the client payment is disputed, so the payout is waiting. Nothing was sent. Try again.', { proposalId: id })
    }
  }

  /** An unclaimed payout is held by PayPal because nobody has that account. Cancelling returns the money to the sender. */
  async cancelUnclaimedPayout(id: string): Promise<HttpResult> {
    if (!this.paypal) throw new Problem(503, 'paypal.unconfigured', 'PayPal is not configured', 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first.')
    const row = this.require(id)
    if (row.kind !== 'payment' || row.phase !== 'payout_unclaimed' || !row.payout_item_id || !row.payout_batch_id) {
      throw new Problem(409, 'proposal.state', 'Only an unclaimed payout can be cancelled', `Phase is ${row.phase}. A payout PayPal has already delivered cannot be cancelled.`)
    }
    try {
      await this.paypal.cancelPayoutItem(row.payout_item_id)
    } catch (error) {
      // Found on the real sandbox: PayPal reports the item UNCLAIMED a little before the batch is finished, and will not cancel until it is.
      if (error instanceof PayPalError && error.paypalName === 'BATCH_NOT_COMPLETED') {
        throw new Problem(409, 'payout.batch_processing', 'PayPal is still finishing this payout', 'PayPal only cancels an unclaimed payout once its batch has finished processing. Wait a minute, press Check PayPal, then try again. Nothing was changed.', { proposalId: id })
      }
      if (error instanceof PayPalError) throw paypalProblem(error, 'to cancel the payout', { proposalId: id })
      throw error
    }
    const now = this.iso()
    this.repo.insertEvent(randomUUID(), row.id, 'payout.cancelled', row.clause, { batchId: row.payout_batch_id, itemId: row.payout_item_id, amountCents: row.amount_cents }, now)
    return this.applyLivePayout(this.require(id), await this.paypal.getPayout(row.payout_batch_id))
  }

  /** Nudges the client about an invoice that is out and unpaid. */
  async remindInvoice(id: string, via: 'owner' | 'autopilot' = 'owner'): Promise<HttpResult> {
    const { row, invoices } = this.liveInvoice(id)
    try {
      await invoices.remind(row.invoice_id!, `Reminder: ${row.description}`)
    } catch (error) {
      if (error instanceof PayPalError) throw paypalProblem(error, 'to send the reminder', { proposalId: id })
      throw error
    }
    this.repo.insertEvent(randomUUID(), row.id, 'invoice.reminded', row.clause, { invoiceId: row.invoice_id, via }, this.iso())
    return { status: 200, body: toView(this.require(id)) }
  }

  /** Voids an invoice that is out and unpaid, so a wrong one cannot be paid later. */
  async cancelInvoice(id: string): Promise<HttpResult> {
    const { row, invoices } = this.liveInvoice(id)
    try {
      await invoices.cancel(row.invoice_id!, `Cancelled: ${row.description}`)
    } catch (error) {
      if (error instanceof PayPalError) throw paypalProblem(error, 'to cancel the invoice', { proposalId: id })
      throw error
    }
    const now = this.iso()
    this.repo.transaction(() => {
      this.repo.setInvoiceStatus(row.id, 'CANCELLED', now)
      this.repo.setPhase(row.id, 'invoice_cancelled', now)
      this.repo.insertEvent(randomUUID(), row.id, 'invoice.cancelled', row.clause, { invoiceId: row.invoice_id }, now)
    })
    return { status: 200, body: toView(this.require(id)) }
  }

  private liveInvoice(id: string): { row: ProposalRow; invoices: InvoicePort } {
    const row = this.require(id)
    if (!this.invoices) throw new Problem(503, 'invoice.unavailable', 'Invoicing is not available', 'The PayPal app has no Invoicing permission.')
    if (row.kind !== 'charge' || !row.invoice_id || !INVOICE_PHASES.includes(row.phase)) {
      throw new Problem(409, 'proposal.state', 'No open invoice on this charge', `Phase is ${row.phase}. Only an invoice that is out and unpaid can be reminded or cancelled.`)
    }
    return { row, invoices: this.invoices }
  }

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

  private applyLivePayout(row: ProposalRow, live: LivePayout, by: 'server' | null = null): HttpResult {
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
          ...(by ? { by } : {}),
        }, now)
      }
    })
    return { status: 200, body: toView(this.require(row.id)) }
  }

  /** PayPal reports on a payout batch. The body is never trusted: the batch is re-read from PayPal. */
  async refreshPayoutBatch(batchId: string, by: 'server' | null = null): Promise<{ refreshed: boolean }> {
    if (!this.paypal) return { refreshed: false }
    const row = this.repo.proposalByPayoutBatch(batchId)
    if (!row || !['payout_sent', 'payout_unclaimed'].includes(row.phase)) return { refreshed: false }
    const live = await this.paypal.getPayout(batchId)
    this.applyLivePayout(row, live, by)
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

  private applyLiveInvoice(row: ProposalRow, live: LiveInvoice, by: 'server' | null = null): HttpResult {
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
        this.repo.insertEvent(randomUUID(), row.id, 'capture.completed', row.clause, { invoiceId: live.invoiceId, captureId: live.transactionId, amountCents: live.paidCents, via: 'invoice', ...(by ? { by } : {}) }, now)
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
      this.repo.setPhase(row.id, 'invoice_cancelled', now)
      this.repo.insertEvent(randomUUID(), row.id, 'invoice.cancelled', row.clause, { invoiceId: live.invoiceId, reason: 'cancelled at PayPal' }, now)
    } else if (paid) {
      // Paid, but not in full or not through PayPal: the money is not the locked cents, so it is not called settled.
      this.repo.insertEvent(randomUUID(), row.id, 'invoice.partial', row.clause, { invoiceId: live.invoiceId, paidCents: live.paidCents, lockedCents: row.amount_cents }, now)
    }
    return { status: 200, body: toView(this.require(row.id)) }
  }

  /** A PayPal invoice event names an invoice. Re-read it from PayPal and settle only on what PayPal says. */
  async refreshInvoice(invoiceId: string, by: 'server' | null = null): Promise<{ refreshed: boolean }> {
    if (!this.invoices) return { refreshed: false }
    const row = this.repo.proposalByInvoice(invoiceId)
    if (!row || !INVOICE_PHASES.includes(row.phase)) return { refreshed: false }
    this.applyLiveInvoice(row, await this.invoices.get(invoiceId), by)
    if (this.repo.proposal(row.id)?.phase === 'captured') await this.afterMoney(row.id).catch(() => undefined)
    return { refreshed: true }
  }

  /**
   * What follows a client payment that has just settled. If the owner has switched on "pay when the client pays", the
   * server asks to pay each contractor whose standing rule covers it. It only asks: the gate answers exactly as it would
   * for anyone else, and the same settle path sends it.
   */
  isPaused(): boolean {
    return this.options.safety?.paused() ?? false
  }

  /** After a resume: ask, for every settled client payment, for the payouts the autopilot was told to wait on. Idempotent. */
  async resumeAutopilot(): Promise<number> {
    let asked = 0
    for (const row of this.repo.allProposals()) {
      if (row.kind === 'charge' && row.phase === 'captured') {
        const before = this.repo.eventsFor(row.id).filter((event) => event.type === 'autopilot.payout_asked').length
        await this.afterMoney(row.id).catch(() => undefined)
        asked += this.repo.eventsFor(row.id).filter((event) => event.type === 'autopilot.payout_asked').length - before
      }
    }
    await this.sweepStanding().catch(() => 0)
    return asked
  }

  private async afterMoney(id: string): Promise<void> {
    const charge = this.repo.proposal(id)
    if (!charge || charge.kind !== 'charge' || charge.phase !== 'captured' || !charge.capture_id) return
    // Paused: do not ask. Resuming goes back over every settled client payment and asks for what was missed.
    if (this.options.safety?.paused()) return
    const warrant = this.repo.latestWarrant()
    if (!warrant?.body.automation.payOnSettle) return
    const body = warrant.body
    const already = this.repo.eventsFor(charge.id).filter((event) => event.type === 'autopilot.payout_asked').map((event) => (JSON.parse(event.payload_json) as { ruleId?: string }).ruleId)
    for (const rule of body.standing) {
      if (already.includes(rule.id)) continue
      if (!rule.clientIds.includes(charge.payee_id ?? '') || (rule.requireDeal && !charge.deal_id)) continue
      const net = Math.max(0, (charge.captured_amount_cents ?? 0) - this.repo.heldRefundCents(charge.capture_id))
      const owed = Math.floor((net * (rule.shareBps ?? body.contractorShareBps)) / 10_000) - this.repo.heldPayoutCentsFor(charge.capture_id, rule.payeeId)
      if (owed <= 0 || !charge.category || !charge.evidence_url) continue
      const payee = body.payees.find((item) => item.id === rule.payeeId)
      const input = ProposalCreateSchema.parse({
        kind: 'payment',
        payee: rule.payeeId,
        amountCents: owed,
        currency: charge.currency,
        category: charge.category,
        description: `Share of ${charge.description}`.slice(0, 500),
        evidenceUrl: charge.evidence_url,
        prompt: `Autopilot: ${payee?.displayName ?? rule.payeeId} is owed their share now that the client has paid (standing rule ${rule.id})`,
        jobId: charge.job_id ?? undefined,
        fundingCaptureId: charge.capture_id,
      })
      const sent = await this.proposeAndDispatch(input, `autopay-${charge.id}-${rule.id}`, 'autopilot')
      const view = sent.body as { id?: string; gate?: string; clause?: string }
      this.repo.insertEvent(randomUUID(), charge.id, 'autopilot.payout_asked', view.clause ?? Clause.standingMatched, { ruleId: rule.id, payoutId: view.id ?? null, gate: view.gate ?? null, amountCents: owed }, this.iso())
    }
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
      whatWouldPass: row.gate === 'DENY' ? this.whatWouldPass(row.id) : [],
      acceptance: (() => {
        const d = this.repo.deliveryByProposal(row.id)
        return d ? { id: d.id, dealId: d.deal_id, milestone: d.milestone, proofUrl: d.proof_url, status: d.status, note: d.note, decidedBy: d.decided_by, decidedAt: d.decided_at, signature: d.sig, keyId: d.key_id, signatureValid: d.sig ? this.signer.verify(acceptanceMessage(d), d.sig, d.key_id) : null } : null
      })(),
      dispute: this.disputeOn(row.kind === 'payment' ? row.funding_capture_id : row.capture_id),
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

  private disputeOn(captureId: string | null) {
    const open = captureId ? this.repo.openDisputeFor(captureId) : null
    return open ? { id: open.disputeId, status: open.status, reason: open.reason, amountCents: open.amountCents } : null
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

  /**
   * The gate's answer to a request under a set of rules, against the ledger as it is now. Nothing is stored. It is the one
   * place a request is read into the gate's terms, used both to file a request and to try one without filing it.
   */
  private judge(input: ProposalCreate, warrant: { id: string; version: number; body: WarrantBody }, now: string, actor: string) {
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
    const deal = input.kind === 'charge' ? this.dealContext(dealId, milestone, jobId, evidenceUrl) : null
    const decision = applyPause(decide(warrant.body, {
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
      funding: fundingRow ? this.fundingState(fundingRow, payee?.id ?? null) : null,
      dealId,
      milestone,
      deal,
    }, cap), this.options.safety?.state() ?? NOT_PAUSED, actor)
    return { decision, payee, category, evidenceUrl, jobId, fundingCaptureId, dealId, milestone, cap }
  }

  /** A settled client payment with money left to fund a payout, for the try-it cases to cite. Null when there is none yet. */
  tryFunding(): { captureId: string; jobId: string | null; canStillFundCents: number } | null {
    const warrant = this.repo.latestWarrant()
    if (!warrant) return null
    let best: { captureId: string; jobId: string | null; canStillFundCents: number } | null = null
    for (const row of this.repo.allProposals()) {
      if (row.kind !== 'charge' || row.phase !== 'captured' || !row.capture_id) continue
      const left = fundableCents(warrant.body, this.fundingState(row))
      if (left > 0 && (!best || left > best.canStillFundCents)) best = { captureId: row.capture_id, jobId: row.job_id, canStillFundCents: left }
    }
    return best
  }

  /**
   * "What would happen if..."  The same decision the gate would give, for a request the owner types in, under the live rules
   * or under a draft of new ones. It files nothing, locks nothing and never touches PayPal.
   */
  tryRequest(input: ProposalCreate, rules?: WarrantBody) {
    const live = this.repo.latestWarrant()
    if (!live) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const now = this.iso()
    const under = (body: WarrantBody) => {
      const made = this.judge(input, { id: live.id, version: live.version, body }, now, 'owner')
      return { gate: made.decision.gate, clause: made.decision.clause, detail: made.decision.detail }
    }
    return { live: under(live.body), draft: rules ? under(rules) : null }
  }

  private proposeNew(input: ProposalCreate, now: string, actor: Role, runId: string | null = null): HttpResult {
    if (input.proposalId) return this.amend(input, now)
    const warrant = this.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const { decision, payee, category, evidenceUrl, jobId, fundingCaptureId, dealId, milestone, cap } = this.judge(input, warrant, now, actor)
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
    // Anyone but the owner who keeps asking for things the rules never allow trips the breaker.
    if (decision.gate === 'DENY' && actor !== 'owner') this.options.safety?.noteRefusal(String(actor), decision.clause)
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
      if (state?.disputed) {
        this.repo.insertEvent(randomUUID(), row.id, 'capture.refused', Clause.fundingDisputed, { fundingCaptureId: row.funding_capture_id }, now)
        throw new Problem(409, Clause.fundingDisputed, 'Client payment is under dispute', `The client disputed capture ${row.funding_capture_id} with PayPal. The payout waits until the dispute is resolved. PayPal was not called.`, {
          proposalId: row.id,
          fundingCaptureId: row.funding_capture_id,
        })
      }
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
  private dealContext(dealId: string | null, milestone: number | null, jobId: string | null, evidenceUrl: string | null = null): DealContext {
    const row = dealId ? this.repo.deal(dealId) : null
    const terms = row && row.status === 'agreed' ? (JSON.parse(row.terms_json) as { milestones: Array<{ amountCents: number }> }) : null
    return {
      agreed: row && terms && row.job_id ? { id: row.id, jobId: row.job_id, buyerId: row.buyer_id, milestoneCents: terms.milestones.map((item) => item.amountCents) } : null,
      jobHasDeal: jobId ? this.repo.agreedDealByJob(jobId) !== null : false,
      milestoneBilled: dealId && milestone !== null ? this.repo.chargeForMilestone(dealId, milestone) !== null : false,
      accepted: dealId && milestone !== null && evidenceUrl ? this.acceptedDelivery(dealId, milestone, evidenceUrl) : false,
    }
  }

  /** An accepted delivery for exactly this proof, whose signature still verifies. A row edited after signing does not count. */
  private acceptedDelivery(dealId: string, milestone: number, evidenceUrl: string): boolean {
    const row = this.repo.acceptedDelivery(dealId, milestone)
    return Boolean(row && row.proof_hash === proofHash(evidenceUrl) && this.signer.verify(acceptanceMessage(row), row.sig, row.key_id))
  }

  private fundingState(row: ProposalRow, payeeId: string | null = null): FundingCharge {
    return {
      kind: row.kind,
      phase: row.phase,
      jobId: row.job_id,
      currency: row.currency,
      capturedCents: row.captured_amount_cents ?? 0,
      refundHeldCents: row.capture_id ? this.repo.heldRefundCents(row.capture_id) : 0,
      payoutHeldCents: row.capture_id ? this.repo.heldPayoutCents(row.capture_id) : 0,
      clientId: row.payee_id,
      dealId: row.deal_id,
      payeeHeldCents: row.capture_id && payeeId ? this.repo.heldPayoutCentsFor(row.capture_id, payeeId) : 0,
      disputed: row.capture_id ? this.repo.openDisputeFor(row.capture_id) !== null : false,
    }
  }

  private fundingBlock(row: ProposalRow, warrant: WarrantBody): { clause: string; detail: string } | null {
    if (row.kind !== 'payment' || !warrant.fundingRequired) return null
    const funding = row.funding_capture_id ? this.repo.paymentByCapture(row.funding_capture_id) : null
    if (!funding || funding.kind !== 'charge' || funding.phase !== 'captured') {
      return { clause: Clause.fundingMissing, detail: 'a contractor payout must cite a captured client payment' }
    }
    const state = this.fundingState(funding)
    if (state.disputed) return { clause: Clause.fundingDisputed, detail: `the client has an open PayPal dispute on ${row.funding_capture_id}` }
    const available = fundableCents(warrant, state)
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

  // ---------- replay: what the rules would have said ----------

  /**
   * What the gate says about a request that was already made, under the given rules. The context is rebuilt from the
   * ledger with the request itself taken out of the sums (it must not count against its own cap or its own funding).
   * Asked twice, under two sets of rules, every difference in the answer is the rules' doing: the context is identical.
   */
  private replayDecision(row: ProposalRow, body: WarrantBody, over: { amountCents?: number; evidenceUrl?: string | null; category?: string | null } = {}): Decision {
    const own = (RESERVED_PHASES as readonly string[]).includes(row.phase)
    const partiesFor = row.kind === 'charge' || (row.kind === 'refund' && this.isClient(body, row.payee_id)) ? body.clients : body.payees
    const payeeId = row.payee_id && partiesFor.some((party) => party.id === row.payee_id) ? row.payee_id : null
    const parent = row.kind === 'refund' && row.parent_capture_id ? this.repo.paymentByCapture(row.parent_capture_id) : null
    const fundingRow = row.kind === 'payment' && row.funding_capture_id ? this.repo.paymentByCapture(row.funding_capture_id) : null
    let funding = fundingRow ? this.fundingState(fundingRow, payeeId) : null
    if (funding && own) funding = { ...funding, payoutHeldCents: Math.max(0, funding.payoutHeldCents - row.amount_cents), payeeHeldCents: Math.max(0, (funding.payeeHeldCents ?? 0) - row.amount_cents) }
    const cap = this.reservation(row.warrant_id, body, row.created_at)
    const window = monthWindow(new Date(row.created_at), body.timezone)
    const ownInMonth = own && row.kind === 'payment' && row.reserved_at !== null && row.reserved_at >= window.start && row.reserved_at < window.end
    const evidenceUrl = over.evidenceUrl !== undefined ? over.evidenceUrl : row.evidence_url
    const amountCents = over.amountCents ?? row.amount_cents
    let deal: DealContext | null = null
    if (row.kind === 'charge') {
      deal = this.dealContext(row.deal_id, row.milestone, row.job_id, evidenceUrl)
      const live = row.deal_id && row.milestone !== null ? this.repo.chargeForMilestone(row.deal_id, row.milestone) : null
      if (live && live.id === row.id) deal = { ...deal, milestoneBilled: false }
    }
    return decide(body, {
      kind: row.kind,
      payeeId,
      amountCents,
      currency: row.currency,
      category: over.category !== undefined ? over.category : row.category,
      evidenceUrl,
      parent: parent ? { payeeId: parent.payee_id ?? '', amountCents: parent.amount_cents, heldCents: this.repo.heldRefundCents(parent.capture_id!), currency: parent.currency, category: parent.category ?? '', evidenceUrl: parent.evidence_url, phase: parent.phase } : null,
      jobId: row.job_id,
      fundingCaptureId: row.funding_capture_id,
      funding,
      dealId: row.deal_id,
      milestone: row.milestone,
      deal,
    }, { reservedCents: Math.max(0, cap.reservedCents - (ownInMonth ? row.amount_cents : 0)), priorCaptureIds: cap.priorCaptureIds })
  }

  /**
   * Runs the last requests again under proposed rules and reports the ones whose answer would change. The same request,
   * the same ledger, two sets of rules: whatever differs is what the new rules do. Nothing is stored or sent.
   */
  replay(proposed: WarrantBody, limit = 40) {
    const live = this.repo.latestWarrant()
    if (!live) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const names = (id: string | null) => [...live.body.payees, ...live.body.clients, ...proposed.payees, ...proposed.clients].find((party) => party.id === id)?.displayName ?? 'Unknown'
    const rows = this.repo.listProposals(limit, null)
    const label = (d: Decision) => (d.gate === 'DENY' ? `refused (${d.clause})` : d.gate === 'AUTO' ? 'goes with no tap' : 'waits for the owner’s tap')
    const changed: Array<{ proposalId: string; title: string; amountCents: number; before: { gate: string; clause: string; words: string }; after: { gate: string; clause: string; words: string } }> = []
    for (const row of rows) {
      const before = this.replayDecision(row, live.body)
      const after = this.replayDecision(row, proposed)
      if (before.gate === after.gate && before.clause === after.clause) continue
      const verb = row.kind === 'charge' ? 'Bill' : row.kind === 'refund' ? 'Refund' : 'Pay'
      changed.push({ proposalId: row.id, title: `${verb} ${names(row.payee_id)} $${(row.amount_cents / 100).toFixed(2)}`, amountCents: row.amount_cents, before: { gate: before.gate, clause: before.clause, words: label(before) }, after: { gate: after.gate, clause: after.clause, words: label(after) } })
    }
    return {
      checked: rows.length,
      changed,
      nowNoTap: changed.filter((item) => item.after.gate === 'AUTO' && item.before.gate !== 'AUTO').length,
      nowTap: changed.filter((item) => item.after.gate === 'NEEDS_APPROVAL' && item.before.gate !== 'NEEDS_APPROVAL').length,
      nowRefused: changed.filter((item) => item.after.gate === 'DENY' && item.before.gate !== 'DENY').length,
      nowAllowed: changed.filter((item) => item.before.gate === 'DENY' && item.after.gate !== 'DENY').length,
    }
  }

  /**
   * After a refusal: what WOULD pass. Each suggestion is a variant of the same request that was put back through the
   * gate and came out allowed, so none of it is the model's guess.
   */
  whatWouldPass(id: string): Array<{ text: string; tested: boolean }> {
    const row = this.repo.proposal(id)
    const live = this.repo.latestWarrant()
    if (!row || !live || row.gate !== 'DENY') return []
    const body = live.body
    const ok = (over: Parameters<MandateService['replayDecision']>[2]) => this.replayDecision(row, body, over).gate !== 'DENY'
    const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`
    const out: Array<{ text: string; tested: boolean }> = []
    const fundingRow = row.kind === 'payment' && row.funding_capture_id ? this.repo.paymentByCapture(row.funding_capture_id) : null
    switch (row.clause) {
      case Clause.fundingExceeds: {
        const available = fundingRow ? fundableCents(body, this.fundingState(fundingRow, row.payee_id)) : 0
        if (available > 0 && ok({ amountCents: available })) out.push({ text: `${dollars(available)} would pass: that is what the client payment can still fund.`, tested: true })
        else out.push({ text: 'Nothing more can be paid out of that client payment. Another client payment, or a refund being undone, would be needed.', tested: false })
        break
      }
      case Clause.capMonthly: {
        const room = body.monthlyCapCents - this.reservation(row.warrant_id, body, this.now().toISOString()).reservedCents
        if (room > 0 && ok({ amountCents: Math.min(room, row.amount_cents) })) out.push({ text: `${dollars(Math.min(room, row.amount_cents))} would pass: that is what is left of this month’s cap.`, tested: true })
        const next = new Date(monthWindow(this.now(), body.timezone).end)
        out.push({ text: `The full ${dollars(row.amount_cents)} is possible from ${next.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: body.timezone })}, when the month rolls over, or if the owner raises the cap.`, tested: false })
        break
      }
      case Clause.amountCeiling:
        if (ok({ amountCents: body.perPaymentCeilingCents })) out.push({ text: `${dollars(body.perPaymentCeilingCents)} would pass: that is the most one payment may be.`, tested: true })
        break
      case Clause.evidenceMissing:
        if (ok({ evidenceUrl: 'https://example.com/proof' })) out.push({ text: 'Add an https link to the work and it would pass.', tested: true })
        break
      case Clause.categoryMissing: {
        const fits = body.categories.filter((category) => ok({ category }))
        if (fits.length > 0) out.push({ text: `It would pass as ${fits.join(' or ')} work. Those are the kinds of work the rules allow.`, tested: true })
        break
      }
      case Clause.fundingMissing: {
        // Two different situations hide behind this one code: the client has not paid, or the client has paid and every cent
        // the contractor may take from it is already paid out. Say which, from the ledger.
        const paid = row.job_id ? this.repo.proposalsForJob(row.job_id).filter((item) => item.kind === 'charge' && item.phase === 'captured') : []
        const left = paid.reduce((sum, item) => sum + fundableCents(body, this.fundingState(item, row.payee_id)), 0)
        if (paid.length === 0) out.push({ text: 'The client has to pay first. Bill the next milestone, and once the client has paid, this payout can be asked for.', tested: false })
        else if (left <= 0) out.push({ text: `The client has paid ${dollars(paid.reduce((sum, item) => sum + (item.captured_amount_cents ?? 0), 0))} on this job, and the contractor's whole share of it has already been paid out. Nothing is left to fund another payout until the client pays again, for example the next milestone.`, tested: false })
        else out.push({ text: `A client payment on this job can still fund ${dollars(left)}. Ask for that payout and cite that payment.`, tested: false })
        break
      }
      case Clause.systemPaused:
        out.push({ text: 'The owner resumes Mandate from the System page or the banner at the top. Until then nothing automatic runs and agents are refused.', tested: false })
        break
      case Clause.fundingDisputed:
        out.push({ text: 'It would pass once PayPal resolves the client’s dispute on that payment.', tested: false })
        break
      case Clause.payeeUnknown:
        out.push({ text: 'Only the owner can add someone to the rules. Nothing a request says can add a payee.', tested: false })
        break
      case Clause.dealMilestoneMismatch:
        out.push({ text: 'A milestone can only be billed for exactly the amount in the signed deal.', tested: false })
        break
      case Clause.dealMilestoneBilled:
        out.push({ text: 'That milestone was already billed. Cancel its unpaid invoice first if it was wrong.', tested: false })
        break
      default:
        break
    }
    return out
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
    standing: [],
    automation: NO_AUTOMATION,
    fundingRequired: false,
    contractorShareBps: 10_000,
  }
}
