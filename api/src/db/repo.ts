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
}

export type PartyRulesRecord = { partyId: string; version: number; body: PartyRules; createdAt: string }

/** Phases in which a payout's money is spoken for: locked, sent to PayPal, or paid. */
export const RESERVED_PHASES = ['locked', 'order_created', 'capture_inflight', 'payout_sent', 'payout_unclaimed', 'captured'] as const
/** A billed milestone stays billed unless its charge was refused or thrown away. */
const DEAD_PHASES = ['denied', 'rejected', 'capture_refused'] as const
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

export class Repo {
  constructor(private readonly db: DatabaseSync) {}

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
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

  // ---------- agent runs ----------

  insertAgentRun(row: AgentRunRow): void {
    this.db.prepare(`INSERT INTO agent_runs (id, agent, actor, conversation_id, model, status, input, output, trace_json, error, ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.agent, row.actor, row.conversation_id, row.model, row.status, row.input, row.output, row.trace_json, row.error, row.ms, row.created_at,
    )
  }

  agentRun(id: string): AgentRunRow | null {
    return (this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRunRow | undefined) ?? null
  }

  agentRunsInConversation(conversationId: string, limit: number): AgentRunRow[] {
    return this.db.prepare('SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(conversationId, limit) as AgentRunRow[]
  }

  recentAgentRuns(limit: number): AgentRunRow[] {
    return this.db.prepare('SELECT * FROM agent_runs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as AgentRunRow[]
  }

  setPhase(id: string, phase: string, now: string): void {
    this.db.prepare('UPDATE proposals SET phase = ?, updated_at = ? WHERE id = ?').run(phase, now, id)
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
