import { live, stamp } from '../services/live'
import type { DatabaseSync } from 'node:sqlite'
import type { PartyRules } from '../domain/deal'
import { PartyRulesSchema } from '../domain/deal'
import type { WarrantBody } from '../domain/schemas'
import { WarrantBodySchema } from '../domain/schemas'

export type ProposalKind = 'payment' | 'charge' | 'refund'

export type ProposalRow = {
  id: string
  warrant_id: string
  warrant_version: number
  kind: ProposalKind
  parent_capture_id: string | null
  payee_id: string | null
  amount_cents: number
  currency: string
  category: string | null
  description: string
  evidence_url: string | null
  prompt: string | null
  gate: 'DENY' | 'AUTO' | 'NEEDS_APPROVAL'
  clause: string
  detail: string
  phase: string
  cart_hash: string | null
  order_id: string | null
  capture_id: string | null
  refund_id: string | null
  approve_url: string | null
  captured_amount_cents: number | null
  reserved_at: string | null
  job_id: string | null
  funding_capture_id: string | null
  payout_batch_id: string | null
  payout_item_id: string | null
  payout_status: string | null
  payout_txn_id: string | null
  payout_fee_cents: number | null
  deal_id: string | null
  milestone: number | null
  lock_sig: string | null
  lock_key_id: string | null
  invoice_id: string | null
  invoice_url: string | null
  invoice_status: string | null
  created_at: string
  updated_at: string
}

export type DealRow = {
  id: string
  thread_id: string
  buyer_id: string
  seller_id: string
  offered_by: string
  actor: string
  status: 'agreed' | 'refused'
  job_id: string | null
  terms_json: string
  verdict_json: string
  buyer_rules_version: number
  seller_rules_version: number
  terms_hash: string
  sig: string | null
  key_id: string | null
  run_id: string | null
  prompt: string | null
  created_at: string
}

export type AgentRunRow = {
  id: string
  agent: string
  actor: string
  conversation_id: string | null
  model: string
  status: string
  input: string
  output: string | null
  trace_json: string
  error: string | null
  ms: number | null
  created_at: string
  prompt_version?: string | null
  input_tokens?: number | null
  output_tokens?: number | null
  turns?: number | null
}

export type DisputeRow = { disputeId: string; transactionId: string; status: string; reason: string | null; amountCents: number | null; currency: string | null; openedAt: string | null; updatedAt: string }
type DisputeRecord = { dispute_id: string; transaction_id: string; status: string; reason: string | null; amount_cents: number | null; currency: string | null; opened_at: string | null; updated_at: string }
const disputeRow = (row: DisputeRecord): DisputeRow => ({ disputeId: row.dispute_id, transactionId: row.transaction_id, status: row.status, reason: row.reason, amountCents: row.amount_cents, currency: row.currency, openedAt: row.opened_at, updatedAt: row.updated_at })

export type DeliveryRow = {
  id: string
  deal_id: string
  milestone: number
  proof_url: string
  proof_hash: string
  delivered_by: string
  /** awaiting, accepted, rejected or superseded. The signature covers accepted and rejected. */
  status: 'awaiting' | 'accepted' | 'rejected' | 'superseded'
  note: string | null
  decided_by: string | null
  run_id: string | null
  sig: string | null
  key_id: string | null
  proposal_id: string | null
  created_at: string
  decided_at: string | null
}

export type PartyRulesRecord = { partyId: string; version: number; body: PartyRules; createdAt: string }

/** Phases in which a payout's money is spoken for: locked, sent to PayPal, or paid. */
export const RESERVED_PHASES = ['locked', 'order_created', 'capture_inflight', 'payout_sent', 'payout_unclaimed', 'captured'] as const
/** A billed milestone stays billed unless its charge was refused or thrown away. */
const DEAD_PHASES = ['denied', 'rejected', 'capture_refused', 'invoice_cancelled'] as const
const RESERVED_SQL = RESERVED_PHASES.map((phase) => `'${phase}'`).join(', ')

export type PayoutUpdate = {
  phase: string
  status: string
  itemId: string | null
  transactionId: string | null
  feeCents: number | null
  /** Set only when the payout is settled (PayPal reports SUCCESS). */
  paidCents: number | null
}

export type EventRow = {
  id: string
  proposal_id: string
  type: string
  clause: string | null
  payload_json: string
  created_at: string
}

export type IdempotencyRow = {
  key: string
  request_hash: string
  state: 'pending' | 'done'
  status_code: number | null
  response_json: string | null
  created_at: string
  updated_at: string
}

export type WarrantRecord = {
  id: string
  version: number
  body: WarrantBody
  createdAt: string
}

export type NewProposal = {
  id: string
  warrantId: string
  warrantVersion: number
  kind: ProposalKind
  parentCaptureId: string | null
  jobId: string | null
  fundingCaptureId: string | null
  dealId: string | null
  milestone: number | null
  payeeId: string | null
  amountCents: number
  currency: string
  category: string | null
  description: string
  evidenceUrl: string | null
  prompt: string | null
  gate: ProposalRow['gate']
  clause: string
  detail: string
  phase: string
  cartHash: string | null
  lockSig: string | null
  lockKeyId: string | null
  reservedAt: string | null
  now: string
}

const PROPOSAL_COLUMNS = `id, warrant_id, warrant_version, kind, parent_capture_id, payee_id, amount_cents, currency,
  category, description, evidence_url, prompt, gate, clause, detail, phase, cart_hash, order_id, capture_id,
  refund_id, approve_url, captured_amount_cents, reserved_at, job_id, funding_capture_id, payout_batch_id, payout_item_id,
  payout_status, payout_txn_id, payout_fee_cents, deal_id, milestone, lock_sig, lock_key_id, invoice_id, invoice_url,
  invoice_status, created_at, updated_at`

/** How many transactions are open on each database, however many Repo objects look at it. */
const DEPTH = new WeakMap<DatabaseSync, number>()

export class Repo {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Runs `fn` as one unit: all of it happens or none of it does. It may be called from inside another transaction (a rule
   * that records a pause while a request is being decided): the inner one is then a savepoint that can be undone on its
   * own without undoing the outer one.
   */
  transaction<T>(fn: () => T): T {
    const depth = DEPTH.get(this.db) ?? 0
    const name = `sp_${depth}`
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`)
    DEPTH.set(this.db, depth + 1)
    try {
      const value = fn()
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`)
      return value
    } catch (error) {
      this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`)
      throw error
    } finally {
      DEPTH.set(this.db, depth)
    }
  }

  latestWarrant(): WarrantRecord | null {
    const row = this.db.prepare(
      'SELECT id, version, body_json, created_at FROM warrants ORDER BY version DESC LIMIT 1',
    ).get() as { id: string; version: number; body_json: string; created_at: string } | undefined
    if (!row) return null
    return { id: row.id, version: row.version, body: WarrantBodySchema.parse(JSON.parse(row.body_json)), createdAt: row.created_at }
  }

  warrant(id: string, version: number): WarrantRecord | null {
    const row = this.db.prepare(
      'SELECT id, version, body_json, created_at FROM warrants WHERE id = ? AND version = ?',
    ).get(id, version) as { id: string; version: number; body_json: string; created_at: string } | undefined
    if (!row) return null
    return { id: row.id, version: row.version, body: WarrantBodySchema.parse(JSON.parse(row.body_json)), createdAt: row.created_at }
  }

  warrantVersions(): WarrantRecord[] {
    const rows = this.db.prepare(
      'SELECT id, version, body_json, created_at FROM warrants ORDER BY version DESC',
    ).all() as Array<{ id: string; version: number; body_json: string; created_at: string }>
    return rows.map((row) => ({ id: row.id, version: row.version, body: WarrantBodySchema.parse(JSON.parse(row.body_json)), createdAt: row.created_at }))
  }

  insertWarrant(id: string, version: number, body: WarrantBody, now: string): void {
    this.db.prepare('INSERT INTO warrants (id, version, body_json, created_at) VALUES (?, ?, ?, ?)').run(
      id, version, JSON.stringify(body), now,
    )
    live.publish({ type: 'changed', scope: 'rules', what: 'rules.published', at: stamp() })
  }

  insertProposal(input: NewProposal): void {
    this.db.prepare(`INSERT INTO proposals (
      id, warrant_id, warrant_version, kind, parent_capture_id, payee_id, amount_cents, currency, category,
      description, evidence_url, prompt, gate, clause, detail, phase, cart_hash, reserved_at, job_id,
      funding_capture_id, deal_id, milestone, lock_sig, lock_key_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.warrantId, input.warrantVersion, input.kind, input.parentCaptureId, input.payeeId,
      input.amountCents, input.currency, input.category, input.description, input.evidenceUrl, input.prompt,
      input.gate, input.clause, input.detail, input.phase, input.cartHash, input.reservedAt, input.jobId,
      input.fundingCaptureId, input.dealId, input.milestone, input.lockSig, input.lockKeyId, input.now, input.now,
    )
  }

  proposal(id: string): ProposalRow | null {
    return (this.db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE id = ?`).get(id) as ProposalRow | undefined) ?? null
  }

  /** The payment or client charge that produced this PayPal capture. */
  paymentByCapture(captureId: string): ProposalRow | null {
    return (this.db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE capture_id = ? AND kind IN ('payment', 'charge')`,
    ).get(captureId) as ProposalRow | undefined) ?? null
  }

  /** Contractor payouts that hold money against a client capture: locked or further, net of their refunds. */
  heldPayoutCents(fundingCaptureId: string): number {
    const rows = this.db.prepare(
      `SELECT amount_cents AS amountCents, capture_id AS captureId FROM proposals
       WHERE kind = 'payment' AND funding_capture_id = ?
         AND phase IN (${RESERVED_SQL})`,
    ).all(fundingCaptureId) as Array<{ amountCents: number; captureId: string | null }>
    return rows.reduce((sum, row) => sum + Math.max(0, row.amountCents - (row.captureId ? this.refundedCents(row.captureId) : 0)), 0)
  }

  proposalsForJob(jobId: string): ProposalRow[] {
    return this.db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE job_id = ? ORDER BY created_at ASC, id ASC`,
    ).all(jobId) as ProposalRow[]
  }

  refundsOf(captureId: string): ProposalRow[] {
    return this.db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE kind = 'refund' AND parent_capture_id = ? ORDER BY created_at ASC, id ASC`,
    ).all(captureId) as ProposalRow[]
  }

  listProposals(limit: number, cursor: { createdAt: string; id: string } | null): ProposalRow[] {
    if (!cursor) {
      return this.db.prepare(
        `SELECT ${PROPOSAL_COLUMNS} FROM proposals ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(limit) as ProposalRow[]
    }
    return this.db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals
       WHERE created_at < ? OR (created_at = ? AND id < ?)
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(cursor.createdAt, cursor.createdAt, cursor.id, limit) as ProposalRow[]
  }

  reservations(warrantId: string, start: string, end: string): Array<{ amountCents: number; captureId: string | null }> {
    return this.db.prepare(
      `SELECT amount_cents AS amountCents, capture_id AS captureId FROM proposals
       WHERE warrant_id = ? AND kind = 'payment' AND reserved_at >= ? AND reserved_at < ?
         AND phase IN (${RESERVED_SQL})`,
    ).all(warrantId, start, end) as Array<{ amountCents: number; captureId: string | null }>
  }

  heldRefundCents(captureId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM proposals
       WHERE kind = 'refund' AND parent_capture_id = ?
         AND phase IN ('pending_approval', 'locked', 'order_created', 'capture_inflight', 'refunded')`,
    ).get(captureId) as { cents: number }
    return row.cents
  }

  refundedCents(captureId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM proposals
       WHERE kind = 'refund' AND parent_capture_id = ? AND phase = 'refunded'`,
    ).get(captureId) as { cents: number }
    return row.cents
  }

  insertEvent(id: string, proposalId: string, type: string, clause: string | null, payload: unknown, now: string): void {
    this.db.prepare(
      'INSERT INTO events (id, proposal_id, type, clause, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, proposalId, type, clause, JSON.stringify(payload), now)
    live.publish({ type: 'changed', scope: 'ledger', what: type, id: proposalId, at: stamp() })
  }

  listEvents(limit: number, cursor: { createdAt: string; id: string } | null): EventRow[] {
    if (!cursor) {
      return this.db.prepare(
        'SELECT id, proposal_id, type, clause, payload_json, created_at FROM events ORDER BY created_at DESC, id DESC LIMIT ?',
      ).all(limit) as EventRow[]
    }
    return this.db.prepare(
      `SELECT id, proposal_id, type, clause, payload_json, created_at FROM events
       WHERE created_at < ? OR (created_at = ? AND id < ?)
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(cursor.createdAt, cursor.createdAt, cursor.id, limit) as EventRow[]
  }

  eventsFor(proposalId: string): EventRow[] {
    return this.db.prepare(
      'SELECT id, proposal_id, type, clause, payload_json, created_at FROM events WHERE proposal_id = ? ORDER BY created_at ASC, rowid ASC',
    ).all(proposalId) as EventRow[]
  }

  lockProposal(id: string, hash: string, sig: { signature: string; keyId: string }, now: string): void {
    this.db.prepare(
      `UPDATE proposals SET phase = 'locked', cart_hash = ?, lock_sig = ?, lock_key_id = ?, reserved_at = ?, updated_at = ? WHERE id = ?`,
    ).run(hash, sig.signature, sig.keyId, now, now, id)
  }

  /** Locks made before signing existed. They are signed once at boot, after their hash is re-checked. */
  unsignedLocks(): ProposalRow[] {
    return this.db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE cart_hash IS NOT NULL AND lock_sig IS NULL AND phase NOT IN ('denied', 'rejected', 'pending_approval')`,
    ).all() as ProposalRow[]
  }

  signLock(id: string, sig: { signature: string; keyId: string }): void {
    this.db.prepare('UPDATE proposals SET lock_sig = ?, lock_key_id = ? WHERE id = ? AND lock_sig IS NULL').run(sig.signature, sig.keyId, id)
  }

  /** Public keys the server has signed with, so old receipts stay verifiable after a rotation. */
  rememberSigningKey(keyId: string, publicPem: string, now: string): void {
    this.db.prepare('INSERT OR IGNORE INTO signing_keys (key_id, public_pem, created_at) VALUES (?, ?, ?)').run(keyId, publicPem, now)
  }

  signingKeys(): Array<{ keyId: string; publicPem: string }> {
    return (this.db.prepare('SELECT key_id AS keyId, public_pem AS publicPem FROM signing_keys ORDER BY created_at').all() as Array<{ keyId: string; publicPem: string }>)
  }

  saveInvoiceDraft(id: string, invoiceId: string, now: string): void {
    this.db.prepare(
      `UPDATE proposals SET phase = 'invoice_draft', invoice_id = ?, invoice_status = 'DRAFT', updated_at = ? WHERE id = ?`,
    ).run(invoiceId, now, id)
  }

  saveInvoice(id: string, invoiceId: string, url: string | null, status: string, now: string): void {
    this.db.prepare(
      `UPDATE proposals SET phase = 'invoice_sent', invoice_id = ?, invoice_url = ?, invoice_status = ?, updated_at = ? WHERE id = ?`,
    ).run(invoiceId, url, status, now, id)
  }

  setInvoiceStatus(id: string, status: string, now: string): void {
    this.db.prepare('UPDATE proposals SET invoice_status = ?, updated_at = ? WHERE id = ?').run(status, now, id)
  }

  proposalByInvoice(invoiceId: string): ProposalRow | null {
    return (this.db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE invoice_id = ?`).get(invoiceId) as ProposalRow | undefined) ?? null
  }

  /** The live charge that bills one milestone of a deal, if any. */
  chargeForMilestone(dealId: string, milestone: number): ProposalRow | null {
    const dead = DEAD_PHASES.map((phase) => `'${phase}'`).join(', ')
    return (this.db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE deal_id = ? AND milestone = ? AND kind = 'charge' AND phase NOT IN (${dead}) ORDER BY created_at LIMIT 1`,
    ).get(dealId, milestone) as ProposalRow | undefined) ?? null
  }

  chargesForDeal(dealId: string): ProposalRow[] {
    return this.db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE deal_id = ? AND kind = 'charge' ORDER BY milestone, created_at`,
    ).all(dealId) as ProposalRow[]
  }

  // ---------- deal rules and deals ----------

  partyRules(partyId: string): PartyRulesRecord | null {
    const row = this.db.prepare('SELECT party_id, version, body_json, created_at FROM party_rules WHERE party_id = ? ORDER BY version DESC LIMIT 1')
      .get(partyId) as { party_id: string; version: number; body_json: string; created_at: string } | undefined
    return row ? { partyId: row.party_id, version: row.version, body: PartyRulesSchema.parse(JSON.parse(row.body_json)), createdAt: row.created_at } : null
  }

  partyRulesVersions(partyId: string): PartyRulesRecord[] {
    const rows = this.db.prepare('SELECT party_id, version, body_json, created_at FROM party_rules WHERE party_id = ? ORDER BY version DESC')
      .all(partyId) as Array<{ party_id: string; version: number; body_json: string; created_at: string }>
    return rows.map((row) => ({ partyId: row.party_id, version: row.version, body: PartyRulesSchema.parse(JSON.parse(row.body_json)), createdAt: row.created_at }))
  }

  insertPartyRules(partyId: string, version: number, body: PartyRules, now: string): void {
    this.db.prepare('INSERT INTO party_rules (party_id, version, body_json, created_at) VALUES (?, ?, ?, ?)').run(partyId, version, JSON.stringify(body), now)
  }

  insertDeal(row: DealRow): void {
    this.db.prepare(`INSERT INTO deals (
      id, thread_id, buyer_id, seller_id, offered_by, actor, status, job_id, terms_json, verdict_json,
      buyer_rules_version, seller_rules_version, terms_hash, sig, key_id, run_id, prompt, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.thread_id, row.buyer_id, row.seller_id, row.offered_by, row.actor, row.status, row.job_id, row.terms_json,
      row.verdict_json, row.buyer_rules_version, row.seller_rules_version, row.terms_hash, row.sig, row.key_id, row.run_id,
      row.prompt, row.created_at,
    )
    live.publish({ type: 'changed', scope: 'deal', what: `deal.${row.status}`, dealId: row.id, at: stamp() })
  }

  deal(id: string): DealRow | null {
    return (this.db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as DealRow | undefined) ?? null
  }

  listDeals(limit: number): DealRow[] {
    return this.db.prepare('SELECT * FROM deals ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as DealRow[]
  }

  dealsInThread(threadId: string): DealRow[] {
    return this.db.prepare('SELECT * FROM deals WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC').all(threadId) as DealRow[]
  }

  agreedDealInThread(threadId: string): DealRow | null {
    return (this.db.prepare(`SELECT * FROM deals WHERE thread_id = ? AND status = 'agreed' LIMIT 1`).get(threadId) as DealRow | undefined) ?? null
  }

  agreedDealByJob(jobId: string): DealRow | null {
    return (this.db.prepare(`SELECT * FROM deals WHERE job_id = ? AND status = 'agreed' LIMIT 1`).get(jobId) as DealRow | undefined) ?? null
  }

  /** PayPal batches still processing, and invoices still out. The server asks PayPal about these on a timer, so nobody has to press Check. */
  openPayoutBatches(): string[] {
    return (this.db.prepare(`SELECT payout_batch_id FROM proposals WHERE phase = 'payout_sent' AND payout_batch_id IS NOT NULL ORDER BY updated_at LIMIT 20`).all() as Array<{ payout_batch_id: string }>).map((row) => row.payout_batch_id)
  }

  openInvoices(): string[] {
    return (this.db.prepare(`SELECT invoice_id FROM proposals WHERE phase IN ('invoice_draft', 'invoice_sent') AND invoice_id IS NOT NULL ORDER BY updated_at LIMIT 20`).all() as Array<{ invoice_id: string }>).map((row) => row.invoice_id)
  }

  /** Payouts and bills a standing rule approved that have not reached PayPal yet. */
  lockedStandingItems(): ProposalRow[] {
    return this.db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE clause IN ('standing.matched', 'standing.billing') AND kind IN ('payment', 'charge') AND phase IN ('locked', 'order_created') AND payout_batch_id IS NULL ORDER BY created_at LIMIT 20`).all() as ProposalRow[]
  }

  /** Invoices that are out, with their proposal, for the reminder schedule. */
  invoicesOut(): ProposalRow[] {
    return this.db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE kind = 'charge' AND phase = 'invoice_sent' AND invoice_id IS NOT NULL ORDER BY created_at LIMIT 50`).all() as ProposalRow[]
  }

  /** What one payee has been promised out of one client payment: locked, sent or paid. */
  heldPayoutCentsFor(fundingCaptureId: string, payeeId: string): number {
    const rows = this.db.prepare(
      `SELECT amount_cents AS amountCents, capture_id AS captureId FROM proposals
       WHERE kind = 'payment' AND funding_capture_id = ? AND payee_id = ?
         AND phase IN (${RESERVED_SQL})`,
    ).all(fundingCaptureId, payeeId) as Array<{ amountCents: number; captureId: string | null }>
    return rows.reduce((sum, row) => sum + Math.max(0, row.amountCents - (row.captureId ? this.refundedCents(row.captureId) : 0)), 0)
  }

  /** Requests made since a moment, newest first. */
  proposalsSince(sinceIso: string, limit: number): ProposalRow[] {
    return this.db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(sinceIso, limit) as ProposalRow[]
  }

  /** Everything that is not finished: waiting, locked, sent, out, or unclaimed. */
  openProposals(limit: number): ProposalRow[] {
    return this.db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals
       WHERE phase IN ('pending_approval', 'locked', 'order_created', 'capture_inflight', 'invoice_draft', 'invoice_sent', 'payout_sent', 'payout_unclaimed')
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(limit) as ProposalRow[]
  }

  /** Settled and refunded requests, newest activity first. */
  settledProposals(sinceIso: string, limit: number): ProposalRow[] {
    return this.db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE phase IN ('captured', 'refunded') AND updated_at >= ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(sinceIso, limit) as ProposalRow[]
  }

  /** Every request, oldest first. The audit reads all of them. */
  allProposals(): ProposalRow[] {
    return this.db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals ORDER BY created_at ASC, id ASC`).all() as ProposalRow[]
  }

  allEvents(): EventRow[] {
    return this.db.prepare('SELECT id, proposal_id, type, clause, payload_json, created_at FROM events ORDER BY created_at ASC, rowid ASC').all() as EventRow[]
  }

  /** Events of some types inside a window, for the month's totals. */
  eventsOfTypes(types: string[], start: string, end: string): EventRow[] {
    const marks = types.map(() => '?').join(', ')
    return this.db.prepare(`SELECT id, proposal_id, type, clause, payload_json, created_at FROM events WHERE type IN (${marks}) AND created_at >= ? AND created_at < ? ORDER BY created_at ASC, rowid ASC`).all(...types, start, end) as EventRow[]
  }

  countAgreedDeals(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM deals WHERE status = 'agreed'`).get() as { n: number }).n
  }

  agreedDeals(): DealRow[] {
    return this.db.prepare(`SELECT * FROM deals WHERE status = 'agreed' ORDER BY created_at ASC`).all() as DealRow[]
  }

  // ---------- deliveries and the client's acceptance ----------

  insertDelivery(row: DeliveryRow): void {
    this.db.prepare(`INSERT INTO deliveries (id, deal_id, milestone, proof_url, proof_hash, delivered_by, status, note, decided_by, run_id, sig, key_id, proposal_id, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.deal_id, row.milestone, row.proof_url, row.proof_hash, row.delivered_by, row.status, row.note, row.decided_by, row.run_id, row.sig, row.key_id, row.proposal_id, row.created_at, row.decided_at)
    live.publish({ type: 'changed', scope: 'delivery', what: `delivery.${row.status}`, dealId: row.deal_id, milestone: row.milestone, at: stamp() })
  }

  delivery(id: string): DeliveryRow | null {
    return (this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as DeliveryRow | undefined) ?? null
  }

  /** The newest delivery for a milestone that is still live: awaiting, accepted or rejected. */
  currentDelivery(dealId: string, milestone: number): DeliveryRow | null {
    return (this.db.prepare(`SELECT * FROM deliveries WHERE deal_id = ? AND milestone = ? AND status != 'superseded' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(dealId, milestone) as DeliveryRow | undefined) ?? null
  }

  deliveryByProposal(proposalId: string): DeliveryRow | null {
    return (this.db.prepare('SELECT * FROM deliveries WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1').get(proposalId) as DeliveryRow | undefined) ?? null
  }

  acceptedDelivery(dealId: string, milestone: number): DeliveryRow | null {
    return (this.db.prepare(`SELECT * FROM deliveries WHERE deal_id = ? AND milestone = ? AND status = 'accepted' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(dealId, milestone) as DeliveryRow | undefined) ?? null
  }

  supersedeAwaiting(dealId: string, milestone: number): void {
    this.db.prepare(`UPDATE deliveries SET status = 'superseded' WHERE deal_id = ? AND milestone = ? AND status IN ('awaiting', 'rejected')`).run(dealId, milestone)
  }

  decideDelivery(id: string, status: 'accepted' | 'rejected', note: string | null, decidedBy: string, runId: string | null, sig: string, keyId: string, now: string): void {
    this.db.prepare(`UPDATE deliveries SET status = ?, note = ?, decided_by = ?, run_id = ?, sig = ?, key_id = ?, decided_at = ? WHERE id = ?`).run(status, note, decidedBy, runId, sig, keyId, now, id)
    const delivery = this.delivery(id)
    if (delivery) live.publish({ type: 'changed', scope: 'delivery', what: `delivery.${status}`, dealId: delivery.deal_id, milestone: delivery.milestone, at: stamp() })
  }

  linkDelivery(id: string, proposalId: string): void {
    this.db.prepare('UPDATE deliveries SET proposal_id = ? WHERE id = ?').run(proposalId, id)
  }

  deliveriesFor(buyerId: string | null, limit: number): DeliveryRow[] {
    return (buyerId
      ? this.db.prepare(`SELECT d.* FROM deliveries d JOIN deals e ON e.id = d.deal_id WHERE e.buyer_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`).all(buyerId, limit)
      : this.db.prepare('SELECT * FROM deliveries ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)) as DeliveryRow[]
  }

  allDeliveries(): DeliveryRow[] {
    return this.db.prepare('SELECT * FROM deliveries ORDER BY created_at ASC, rowid ASC').all() as DeliveryRow[]
  }

  // ---------- PayPal disputes and reconciliation ----------

  upsertDispute(row: DisputeRow): void {
    this.db.prepare(`INSERT INTO paypal_disputes (dispute_id, transaction_id, status, reason, amount_cents, currency, opened_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dispute_id) DO UPDATE SET transaction_id = excluded.transaction_id, status = excluded.status, reason = excluded.reason,
        amount_cents = excluded.amount_cents, currency = excluded.currency, updated_at = excluded.updated_at`).run(
      row.disputeId, row.transactionId, row.status, row.reason, row.amountCents, row.currency, row.openedAt, row.updatedAt,
    )
  }

  /** True the first time an event id is seen. PayPal retries deliveries, and a retry must not be processed twice. */
  claimWebhookEvent(eventId: string, eventType: string, now: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, event_type, received_at) VALUES (?, ?, ?)').run(eventId, eventType, now).changes > 0
  }

  releaseWebhookEvent(eventId: string): void {
    this.db.prepare('DELETE FROM webhook_events WHERE event_id = ?').run(eventId)
  }

  disputeById(disputeId: string): DisputeRow | null {
    const row = this.db.prepare('SELECT * FROM paypal_disputes WHERE dispute_id = ?').get(disputeId) as DisputeRecord | undefined
    return row ? disputeRow(row) : null
  }

  openDisputeFor(transactionId: string): DisputeRow | null {
    const row = this.db.prepare(`SELECT * FROM paypal_disputes WHERE transaction_id = ? AND status != 'RESOLVED' ORDER BY updated_at DESC LIMIT 1`).get(transactionId) as DisputeRecord | undefined
    return row ? disputeRow(row) : null
  }

  listDisputes(limit: number): DisputeRow[] {
    return (this.db.prepare('SELECT * FROM paypal_disputes ORDER BY updated_at DESC LIMIT ?').all(limit) as DisputeRecord[]).map(disputeRow)
  }

  /** Every PayPal id this ledger created or was told about. A PayPal transaction with none of these did not come from Mandate. */
  knownPayPalIds(): Map<string, string> {
    const map = new Map<string, string>()
    const rows = this.db.prepare(`SELECT id, order_id, capture_id, refund_id, payout_batch_id, payout_item_id, payout_txn_id, invoice_id FROM proposals`).all() as Array<Record<string, string | null>>
    for (const row of rows) {
      map.set(row.id!, row.id!)
      for (const key of ['order_id', 'capture_id', 'refund_id', 'payout_batch_id', 'payout_item_id', 'payout_txn_id', 'invoice_id']) {
        const value = row[key]
        if (value) map.set(value, row.id!)
      }
    }
    return map
  }

  // ---------- agent runs ----------

  insertAgentRun(row: AgentRunRow): void {
    this.db.prepare(`INSERT INTO agent_runs (id, agent, actor, conversation_id, model, status, input, output, trace_json, error, ms, created_at, prompt_version, input_tokens, output_tokens, turns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.agent, row.actor, row.conversation_id, row.model, row.status, row.input, row.output, row.trace_json, row.error, row.ms, row.created_at,
      row.prompt_version ?? null, row.input_tokens ?? null, row.output_tokens ?? null, row.turns ?? null,
    )
  }

  agentRun(id: string): AgentRunRow | null {
    return (this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRunRow | undefined) ?? null
  }

  agentRunsInConversation(conversationId: string, limit: number): AgentRunRow[] {
    return this.db.prepare('SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(conversationId, limit) as AgentRunRow[]
  }

  safetyState(): { paused: number; reason: string | null; since: string | null; by: string | null; epoch: number } {
    return this.db.prepare('SELECT paused, reason, since, by, epoch FROM safety_state WHERE id = 1').get() as never
  }

  setSafetyState(state: { paused: boolean; reason: string | null; since: string | null; by: string | null; epoch: number }): void {
    this.db.prepare('UPDATE safety_state SET paused = ?, reason = ?, since = ?, by = ?, epoch = ? WHERE id = 1').run(state.paused ? 1 : 0, state.reason, state.since, state.by, state.epoch)
  }

  insertSafetyEvent(row: { id: string; at: string; type: string; by: string; reason: string | null; detail: string | null; sig: string | null; keyId: string | null }): void {
    this.db.prepare('INSERT INTO safety_events (id, at, type, by, reason, detail, sig, key_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.at, row.type, row.by, row.reason, row.detail, row.sig, row.keyId)
  }

  safetyEvents(limit: number): Array<{ id: string; at: string; type: string; by: string; reason: string | null; detail: string | null; sig: string | null; key_id: string | null }> {
    return this.db.prepare('SELECT * FROM safety_events ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as never
  }

  allSafetyEvents(): Array<{ id: string; at: string; type: string; by: string; reason: string | null }> {
    return this.db.prepare('SELECT id, at, type, by, reason FROM safety_events ORDER BY at ASC, rowid ASC').all() as never
  }

  insertClientError(row: { id: string; at: string; role: string; scope: string; message: string; stack: string | null; url: string | null; agent: string | null; releaseId: string | null }): void {
    this.db.prepare('INSERT INTO client_errors (id, at, role, scope, message, stack, url, agent, release_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.at, row.role, row.scope, row.message, row.stack, row.url, row.agent, row.releaseId)
    // Keep the newest 500. This is a diagnostic, not a record.
    this.db.prepare('DELETE FROM client_errors WHERE id IN (SELECT id FROM client_errors ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET 500)').run()
  }

  recentClientErrors(limit: number): Array<{ id: string; at: string; role: string; scope: string; message: string; stack: string | null; url: string | null; agent: string | null; release_id: string | null }> {
    return this.db.prepare('SELECT * FROM client_errors ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as never
  }

  recentAgentRuns(limit: number): AgentRunRow[] {
    return this.db.prepare('SELECT * FROM agent_runs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as AgentRunRow[]
  }

  setPhase(id: string, phase: string, now: string): void {
    this.db.prepare('UPDATE proposals SET phase = ?, updated_at = ? WHERE id = ?').run(phase, now, id)
    live.publish({ type: 'changed', scope: 'ledger', what: `phase.${phase}`, id, at: stamp() })
  }

  saveOrder(id: string, orderId: string, approveUrl: string | null, now: string): void {
    this.db.prepare(
      `UPDATE proposals SET phase = 'order_created', order_id = ?, approve_url = ?, updated_at = ? WHERE id = ?`,
    ).run(orderId, approveUrl, now, id)
  }

  /** A client paid an invoice. Same end state as a captured order, so funding and refunds work unchanged. */
  markCaptured(id: string, captureId: string, amountCents: number, now: string): void {
    this.db.prepare(
      `UPDATE proposals SET phase = 'captured', capture_id = ?, captured_amount_cents = ?, updated_at = ? WHERE id = ? AND kind IN ('payment', 'charge')`,
    ).run(captureId, amountCents, now, id)
  }

  /** The payout batch now exists at PayPal. From here the payout is in flight, not merely locked. */
  savePayoutBatch(id: string, batchId: string, now: string): void {
    this.db.prepare(
      `UPDATE proposals SET phase = 'payout_sent', payout_batch_id = ?, payout_status = 'PENDING', updated_at = ? WHERE id = ?`,
    ).run(batchId, now, id)
  }

  applyPayout(id: string, update: PayoutUpdate, now: string): void {
    this.db.prepare(
      `UPDATE proposals SET phase = ?, payout_status = ?, payout_item_id = COALESCE(?, payout_item_id),
         payout_txn_id = COALESCE(?, payout_txn_id), payout_fee_cents = COALESCE(?, payout_fee_cents),
         captured_amount_cents = COALESCE(?, captured_amount_cents), updated_at = ? WHERE id = ?`,
    ).run(update.phase, update.status, update.itemId, update.transactionId, update.feeCents, update.paidCents, now, id)
  }

  proposalByPayoutBatch(batchId: string): ProposalRow | null {
    return (this.db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE payout_batch_id = ?`).get(batchId) as ProposalRow | undefined) ?? null
  }

  markRefunded(id: string, refundId: string, amountCents: number, now: string): void {
    this.db.prepare(
      `UPDATE proposals SET phase = 'refunded', refund_id = ?, captured_amount_cents = ?, updated_at = ? WHERE id = ?`,
    ).run(refundId, amountCents, now, id)
  }

  refuse(id: string, now: string): void {
    this.db.prepare(`UPDATE proposals SET phase = 'capture_refused', updated_at = ? WHERE id = ?`).run(now, id)
  }

  idempotency(key: string): IdempotencyRow | null {
    return (this.db.prepare(
      'SELECT key, request_hash, state, status_code, response_json, created_at, updated_at FROM idempotency WHERE key = ?',
    ).get(key) as IdempotencyRow | undefined) ?? null
  }

  insertIdempotency(key: string, hash: string, now: string): void {
    this.db.prepare(
      `INSERT INTO idempotency (key, request_hash, state, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)`,
    ).run(key, hash, now, now)
  }

  finishIdempotency(key: string, status: number, body: unknown, now: string): void {
    this.db.prepare(
      `UPDATE idempotency SET state = 'done', status_code = ?, response_json = ?, updated_at = ? WHERE key = ?`,
    ).run(status, JSON.stringify(body), now, key)
  }
}
