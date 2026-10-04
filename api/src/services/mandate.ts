import { randomUUID } from 'node:crypto'
import type { Repo, ProposalRow, ProposalKind } from '../db/repo'
import { Clause, decide, fundableCents, resolveCategory, resolveClient, resolvePayee, type FundingCharge } from '../domain/gate'
import { cartHash, stableHash, type CartFields } from '../domain/hash'
import { monthWindow } from '../domain/period'
import type { ProposalCreate, WarrantBody } from '../domain/schemas'
import { WARRANT_ID, WarrantBodySchema } from '../domain/schemas'
import { PayPalError, type PayPalPort } from '../paypal/port'
import { Problem } from '../http/problem'

export type HttpResult = { status: number; body: unknown }
export type Role = 'owner' | 'proposer'

const RESUME_PHASES = new Set(['locked', 'order_created'])
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
  ) {}

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

  propose(input: ProposalCreate, idempotencyKey: string, actor: Role = 'owner'): HttpResult {
    const hash = stableHash(input)
    const now = this.iso()
    return this.repo.transaction(() => {
      const existing = this.repo.idempotency(idempotencyKey)
      if (existing?.state === 'done') {
        if (existing.request_hash !== hash) {
          throw new Problem(422, 'idempotency.mismatch', 'Idempotency-Key is already used', 'This key was stored for a different request body.')
        }
        return { status: existing.status_code ?? 200, body: JSON.parse(existing.response_json ?? '{}') as unknown }
      }
      if (existing?.state === 'pending') {
        throw new Problem(409, 'idempotency.inflight', 'A request is outstanding for this Idempotency-Key', 'Retry after the original request finishes.')
      }
      this.repo.insertIdempotency(idempotencyKey, hash, now)
      const result = this.proposeNew(input, now, actor)
      this.repo.finishIdempotency(idempotencyKey, result.status, result.body, now)
      return result
    })
  }

  approve(id: string): HttpResult {
    const now = this.iso()
    return this.repo.transaction(() => {
      const row = this.require(id)
      if (row.phase === 'locked' || row.phase === 'order_created' || row.phase === 'captured' || row.phase === 'refunded') {
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
      this.repo.lockProposal(row.id, hash, now)
      this.repo.insertEvent(randomUUID(), row.id, 'proposal.approved', row.clause, { actor: 'owner', cartHash: hash }, now)
      return { status: 200, body: toView(this.require(id)) }
    })
  }

  reject(id: string): HttpResult {
    const now = this.iso()
    return this.repo.transaction(() => {
      const row = this.require(id)
      if (row.phase === 'rejected') return { status: 200, body: toView(row) }
      if (row.phase !== 'pending_approval') {
        throw new Problem(409, 'proposal.state', 'Proposal cannot be rejected', `Phase is ${row.phase}.`)
      }
      this.repo.setPhase(row.id, 'rejected', now)
      this.repo.insertEvent(randomUUID(), row.id, 'proposal.rejected', row.clause, { actor: 'owner' }, now)
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
      amounts: {
        approvedCents: row.cart_hash ? row.amount_cents : null,
        capturedCents: row.captured_amount_cents,
        match: captured ? row.captured_amount_cents === row.amount_cents : null,
      },
      orderId: row.order_id,
      captureId: row.capture_id,
      job: row.job_id,
      funding: row.funding_capture_id ? this.fundingSummary(row.funding_capture_id) : null,
      events,
    }
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

  private proposeNew(input: ProposalCreate, now: string, actor: Role): HttpResult {
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
    } : null
    const phase = decision.gate === 'DENY' ? 'denied' : lockNow ? 'locked' : 'pending_approval'
    this.repo.insertProposal({
      id,
      warrantId: warrant.id,
      warrantVersion: warrant.version,
      kind: input.kind,
      parentCaptureId: input.parentCaptureId ?? null,
      jobId,
      fundingCaptureId,
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
      cartHash: fields ? cartHash(fields) : null,
      reservedAt: lockNow ? now : null,
      now,
    })
    this.repo.insertEvent(randomUUID(), id, 'proposal.created', decision.clause, {
      actor,
      gate: decision.gate,
      prompt: input.prompt ?? null,
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
    if (row.phase === 'captured' || row.phase === 'refunded') {
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
    if (row.kind === 'payment' && row.funding_capture_id) {
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
    // Orders collects a buyer payment for the studio. It is never a contractor payout.
    // This also covers money-out rows with an Orders checkout created by older builds:
    // a buyer approving that checkout must not make it capturable through this route.
    if (row.kind === 'payment') {
      return {
        result: {
          status: 409,
          body: problemValue('payout.unavailable', 'Contractor payout not connected',
            'This payment is approved and reserved, but PayPal Payouts is not connected. Orders checkout pays the studio, not the contractor. No payout was sent.', {
              proposalId: row.id,
              lockedAmountCents: row.amount_cents,
              phase: row.phase,
            }),
        },
        row,
        resume: row.phase,
      }
    }
    const resume = row.phase === 'capture_inflight' ? (row.order_id ? 'order_created' : 'locked') : row.phase
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
    const heldCents = payouts.filter((row) => ['locked', 'order_created', 'capture_inflight'].includes(row.phase)).reduce((sum, row) => sum + row.amount_cents, 0)
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
