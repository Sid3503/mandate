import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseSync } from 'node:sqlite'
import { DEAD_PHASES, expectedSignedCents, INVOICE_WATCH_PHASES, OPEN_PHASES, PAID_PHASES, RESERVED_PHASES, sqlList } from '../domain/phases'
import type { LedgerMoney } from '../domain/reconcile'
import type { PartyRules } from '../domain/deal'
import { PartyRulesSchema } from '../domain/deal'
import type { WarrantBody } from '../domain/schemas'
import { WarrantBodySchema } from '../domain/schemas'
import { live, stamp } from '../services/live'

/** Who caused the ledger event on this request. Absent means an older owner-key or system write. */
export type ActorStamp = { memberId: string; displayName: string; role: string; via: string }
export const actorContext = new AsyncLocalStorage<ActorStamp>()

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
  /** How the order was opened: 'card' (paid on our page) or 'checkout' (the buyer is sent to PayPal). */
  order_kind: string | null
  capture_id: string | null
  refund_id: string | null
  approve_url: string | null
  captured_amount_cents: number | null
  /** What PayPal said it took on the capture. Null when PayPal stated no fee, never zero. */
  capture_fee_cents: number | null
  /** What PayPal said reached the seller on the capture. Null when PayPal stated no net, never zero. */
  capture_net_cents: number | null
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
  /** How this charge is to be paid: 'invoice' (PayPal invoices it) or 'checkout' (the client pays on our page). */
  pay_instrument: string | null
  /** What PayPal reported actually arrived. Null until a settlement is seen. */
  settled_cents: number | null
  /** settled_cents minus the locked amount. Negative means the client paid less. */
  delta_cents: number | null
  /** Why the settled amount was not the locked amount. A closed code, never a model's word. */
  delta_reason: string | null
  /** The PayPal field that reason was read from, when it was read from one. */
  delta_source: string | null
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
  /**
   * `open` is a standing offer waiting for the other side; `countered` was answered with a counter-offer; `agreed` was
   * accepted and signed; `refused` broke the offerer's own rules and never stood; `withdrawn` and `expired` were open
   * when the negotiation ended without a deal.
   */
  status: 'agreed' | 'refused' | 'open' | 'countered' | 'withdrawn' | 'expired'
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

export type AgentRow = {
  id: string
  name: string
  scopes_json: string
  limits_json: string
  status: string
  key_hash: string
  key_prefix?: string | null
  created_at: string
  last_seen_at: string | null
  expires_at?: string | null
}

/** One client's own key: bound to one client on the warrant, never to the studio, never to another client. */
export type ClientKeyRow = {
  id: string
  name: string
  party_id: string
  status: string
  key_hash: string
  key_prefix?: string | null
  created_at: string
  last_seen_at: string | null
  expires_at?: string | null
}

/** A read-only link to one job's status for one person. Only a hash of the secret is stored. */
export type ShareRow = {
  id: string
  job_id: string
  party_id: string
  role: string
  label: string
  secret_hash: string
  created_at: string
  expires_at: string
  revoked_at: string | null
  last_seen_at: string | null
  views: number
  /** True when this link may also pay what is due, not only look at it. */
  can_pay: number
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

export type PartyRulesRecord = { partyId: string; version: number; body: PartyRules; createdAt: string; origin: 'seed' | 'written'; writtenBy: 'owner' | 'party' | null }

export type NegotiationRow = {
  id: string
  buyer_id: string
  seller_id: string
  status: 'open' | 'agreed' | 'walked_away' | 'expired' | 'stalled'
  scope: string
  category: string
  currency: string
  milestones_json: string
  offers_per_side: number
  started_by: string
  ended_reason: string | null
  ended_by: string | null
  agreed_deal_id: string | null
  debrief_json: string | null
  created_at: string
  updated_at: string
  expires_at: string
  ended_at: string | null
}

export type MoveRow = {
  id: string
  negotiation_id: string
  seq: number
  side: 'seller' | 'buyer'
  action: 'offer' | 'accept' | 'walk_away'
  deal_id: string | null
  total_cents: number | null
  final: number
  message: string | null
  assessment: string | null
  actor: string
  /** `agent` (a hosted negotiator), `strategy` (the code's planned move, when the model's was unusable), `person`, or `outside` (the company's own agent). */
  by: string
  run_id: string | null
  created_at: string
}

// The phase lists live in domain/phases.ts, with the predicates that read them. Re-exported here because the repo
// is where the SQL that uses them lives.
export { OPEN_PHASES, RESERVED_PHASES }
const RESERVED_SQL = sqlList(RESERVED_PHASES)
const OPEN_SQL = sqlList(OPEN_PHASES)
const PAID_SQL = sqlList(PAID_PHASES)
const INVOICE_WATCH_SQL = sqlList(INVOICE_WATCH_PHASES)

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
  signatureJson: string | null
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

/** The fields that decide what money a request asks for, and where it comes from. Two asks that agree on all of them are the same ask. */
export type DuplicateKey = {
  kind: string
  payeeId: string | null
  amountCents: number
  currency: string
  jobId: string | null
  fundingCaptureId: string | null
  dealId: string | null
  milestone: number | null
  parentCaptureId: string | null
}

const PROPOSAL_COLUMNS = `id, warrant_id, warrant_version, kind, parent_capture_id, payee_id, amount_cents, currency,
  category, description, evidence_url, prompt, gate, clause, detail, phase, cart_hash, order_id, order_kind, capture_id,
  refund_id, approve_url, captured_amount_cents, capture_fee_cents, capture_net_cents, reserved_at, job_id, funding_capture_id, payout_batch_id, payout_item_id,
  payout_status, payout_txn_id, payout_fee_cents, deal_id, milestone, lock_sig, lock_key_id, invoice_id, invoice_url,
  invoice_status, pay_instrument, settled_cents, delta_cents, delta_reason, delta_source, created_at, updated_at`

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
      'SELECT id, version, body_json, created_at, signature_json FROM warrants ORDER BY version DESC LIMIT 1',
    ).get() as { id: string; version: number; body_json: string; created_at: string; signature_json: string | null } | undefined
    if (!row) return null
    return { id: row.id, version: row.version, body: WarrantBodySchema.parse(JSON.parse(row.body_json)), createdAt: row.created_at, signatureJson: row.signature_json }
  }

  /**
   * The rules in the owner's own words, as they last wrote them. Null when they have not written any, or when they have
   * already become rules: the words are a draft, and a draft that has been published is done.
   */
  ruleWords(): { body: string; at: string } | null {
    const row = this.db.prepare('SELECT body, created_at FROM rule_words ORDER BY created_at DESC LIMIT 1').get() as { body: string; created_at: string } | undefined
    if (!row) return null
    return { body: row.body, at: row.created_at }
  }

  saveRuleWords(body: string, now: string): void {
    this.db.prepare('DELETE FROM rule_words').run()
    this.db.prepare('INSERT INTO rule_words (id, body, created_at) VALUES (?, ?, ?)').run('words', body, now)
  }

  clearRuleWords(): void {
    this.db.prepare('DELETE FROM rule_words').run()
  }

  warrant(id: string, version: number): WarrantRecord | null {
    const row = this.db.prepare(
      'SELECT id, version, body_json, created_at, signature_json FROM warrants WHERE id = ? AND version = ?',
    ).get(id, version) as { id: string; version: number; body_json: string; created_at: string; signature_json: string | null } | undefined
    if (!row) return null
    return { id: row.id, version: row.version, body: WarrantBodySchema.parse(JSON.parse(row.body_json)), createdAt: row.created_at, signatureJson: row.signature_json }
  }

  rawWarrants(): Array<{ id: string; version: number; body_json: string; created_at: string; signature_json: string | null }> {
    return this.db.prepare(
      'SELECT id, version, body_json, created_at, signature_json FROM warrants ORDER BY version DESC',
    ).all() as Array<{ id: string; version: number; body_json: string; created_at: string; signature_json: string | null }>
  }

  warrantVersions(): WarrantRecord[] {
    const rows = this.rawWarrants()
    return rows.map((row) => ({ id: row.id, version: row.version, body: WarrantBodySchema.parse(JSON.parse(row.body_json)), createdAt: row.created_at, signatureJson: row.signature_json }))
  }

  insertWarrant(id: string, version: number, body: WarrantBody, now: string, signatureJson: string | null = null): void {
    this.db.prepare('INSERT INTO warrants (id, version, body_json, created_at, signature_json) VALUES (?, ?, ?, ?, ?)').run(
      id, version, JSON.stringify(body), now, signatureJson,
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

  /**
   * Facts about the moment that every event should carry, set by the container. Today it says "Mandate was paused when this
   * happened", so the audit can check what ran during a pause without comparing clocks (two things in the same millisecond
   * have no order by timestamp, but each knows the state it saw).
   */
  stampEvents: (() => Record<string, unknown>) | null = null

  payeeRow(id: string): { id: string; email: string; status: string; change_pending: number; change_email: string | null; first_seen: string; verified_method: string; total_paid_cents: number } | null {
    return this.db.prepare('SELECT id, email, status, change_pending, change_email, first_seen, verified_method, total_paid_cents FROM payees WHERE id = ?').get(id) as { id: string; email: string; status: string; change_pending: number; change_email: string | null; first_seen: string; verified_method: string; total_paid_cents: number } | undefined ?? null
  }

  /** The payout book. Reading it does not change a payment. */
  listPayees(): Array<{ id: string; email: string; status: string; verified_method: string; first_seen: string; total_paid_cents: number; change_pending: number; change_email: string | null }> {
    return this.db.prepare('SELECT id, email, status, verified_method, first_seen, total_paid_cents, change_pending, change_email FROM payees ORDER BY email').all() as Array<{ id: string; email: string; status: string; verified_method: string; first_seen: string; total_paid_cents: number; change_pending: number; change_email: string | null }>
  }

  insertPayee(payee: { id: string; email: string; status?: string; verified_method?: string; first_seen?: string }): void {
    const status = payee.status ?? 'active'
    const verified = payee.verified_method ?? 'unverified'
    const seen = payee.first_seen ?? new Date().toISOString()
    this.db.prepare(
      'INSERT OR IGNORE INTO payees (id, email, status, verified_method, first_seen, total_paid_cents, change_pending) VALUES (?, ?, ?, ?, ?, 0, 0)',
    ).run(payee.id, payee.email, status, verified, seen)
  }

  updatePayeePaidCents(id: string, amountCents: number): void {
    this.db.prepare('UPDATE payees SET total_paid_cents = total_paid_cents + ? WHERE id = ?').run(amountCents, id)
  }

  requestPayeeChange(id: string, newEmail: string): void {
    this.db.prepare('UPDATE payees SET change_email = ?, change_pending = 1 WHERE id = ?').run(newEmail, id)
    live.publish({ type: 'changed', scope: 'rules', what: 'payee.change_requested', at: stamp() })
  }

  confirmPayeeChange(id: string): void {
    const row = this.payeeRow(id)
    if (!row || !row.change_email) return
    const newEmail = row.change_email
    this.db.prepare('UPDATE payees SET email = change_email, change_email = NULL, change_pending = 0 WHERE id = ?').run(id)
    const warrant = this.latestWarrant()
    if (warrant) {
      const target = warrant.body.payees.find((p) => p.id === id)
      if (target && target.email !== newEmail) {
        const updatedPayees = warrant.body.payees.map((p) => p.id === id ? { ...p, email: newEmail } : p)
        const updatedBody = { ...warrant.body, payees: updatedPayees }
        this.db.prepare('UPDATE warrants SET body_json = ? WHERE id = ? AND version = ?').run(
          JSON.stringify(updatedBody), warrant.id, warrant.version,
        )
      }
    }
    live.publish({ type: 'changed', scope: 'rules', what: 'payee.change_confirmed', at: stamp() })
  }

  cancelPayeeChange(id: string): void {
    this.db.prepare('UPDATE payees SET change_email = NULL, change_pending = 0 WHERE id = ?').run(id)
    live.publish({ type: 'changed', scope: 'rules', what: 'payee.change_cancelled', at: stamp() })
  }

  attestPayee(id: string): void {
    this.db.prepare("UPDATE payees SET verified_method = 'owner_attested', status = 'active' WHERE id = ?").run(id)
    live.publish({ type: 'changed', scope: 'rules', what: 'payee.attested', at: stamp() })
  }

  payeeHistory(id: string, limit = 20): Array<{ id: string; kind: string; amountCents: number; currency: string; phase: string; clause: string | null; description: string; createdAt: string }> {
    const rows = this.db.prepare(
      'SELECT id, kind, amount_cents, currency, phase, clause, description, created_at FROM proposals WHERE payee_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(id, limit) as Array<{ id: string; kind: string; amount_cents: number; currency: string; phase: string; clause: string | null; description: string; created_at: string }>
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amountCents: r.amount_cents,
      currency: r.currency,
      phase: r.phase,
      clause: r.clause,
      description: r.description,
      createdAt: r.created_at,
    }))
  }

  insertEvent(id: string, proposalId: string, type: string, clause: string | null, payload: unknown, now: string): void {
    const extra = this.stampEvents?.()
    if (extra && Object.keys(extra).length > 0 && payload && typeof payload === 'object' && !Array.isArray(payload)) payload = { ...(payload as object), ...extra }
    const actor = actorContext.getStore() ?? null
    this.db.prepare(
      'INSERT INTO events (id, proposal_id, type, clause, payload_json, created_at, actor_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, proposalId, type, clause, JSON.stringify(payload), now, actor ? JSON.stringify(actor) : null)
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
    const row = this.db.prepare('SELECT party_id, version, body_json, created_at, origin, written_by FROM party_rules WHERE party_id = ? ORDER BY version DESC LIMIT 1')
      .get(partyId) as PartyRulesDbRow | undefined
    return row ? toPartyRules(row) : null
  }

  partyRulesVersions(partyId: string): PartyRulesRecord[] {
    const rows = this.db.prepare('SELECT party_id, version, body_json, created_at, origin, written_by FROM party_rules WHERE party_id = ? ORDER BY version DESC')
      .all(partyId) as PartyRulesDbRow[]
    return rows.map(toPartyRules)
  }

  insertPartyRules(partyId: string, version: number, body: PartyRules, now: string, origin: 'seed' | 'written', writtenBy: 'owner' | 'party' | null = null): void {
    this.db.prepare('INSERT INTO party_rules (party_id, version, body_json, created_at, origin, written_by) VALUES (?, ?, ?, ?, ?, ?)').run(partyId, version, JSON.stringify(body), now, origin, writtenBy)
  }

  /** A company has claimed its seat once it wrote its own numbers with its own key. */
  sheetClaimed(partyId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM party_rules WHERE party_id = ? AND written_by = 'party' LIMIT 1`).get(partyId))
  }

  // ---------- negotiations ----------

  insertNegotiation(row: NegotiationRow): void {
    this.db.prepare(`INSERT INTO negotiations (id, buyer_id, seller_id, status, scope, category, currency, milestones_json, offers_per_side, started_by,
      ended_reason, ended_by, agreed_deal_id, debrief_json, created_at, updated_at, expires_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.buyer_id, row.seller_id, row.status, row.scope, row.category, row.currency, row.milestones_json, row.offers_per_side, row.started_by,
      row.ended_reason, row.ended_by, row.agreed_deal_id, row.debrief_json, row.created_at, row.updated_at, row.expires_at, row.ended_at,
    )
    live.publish({ type: 'changed', scope: 'deal', what: 'negotiation.opened', at: stamp() })
  }

  negotiation(id: string): NegotiationRow | null {
    return (this.db.prepare('SELECT * FROM negotiations WHERE id = ?').get(id) as NegotiationRow | undefined) ?? null
  }

  listNegotiations(limit: number, buyerId: string | null = null): NegotiationRow[] {
    return (buyerId
      ? this.db.prepare('SELECT * FROM negotiations WHERE buyer_id = ? ORDER BY created_at DESC LIMIT ?').all(buyerId, limit)
      : this.db.prepare('SELECT * FROM negotiations ORDER BY created_at DESC LIMIT ?').all(limit)) as NegotiationRow[]
  }

  endNegotiation(id: string, status: NegotiationRow['status'], reason: string, by: string | null, agreedDealId: string | null, now: string): void {
    this.db.prepare(`UPDATE negotiations SET status = ?, ended_reason = ?, ended_by = ?, agreed_deal_id = ?, ended_at = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
      .run(status, reason, by, agreedDealId, now, now, id)
    // Whatever offer was still standing when it ended without a deal is no longer open.
    if (status !== 'agreed') this.db.prepare(`UPDATE deals SET status = ? WHERE thread_id = ? AND status = 'open'`).run(status === 'walked_away' ? 'withdrawn' : 'expired', id)
    live.publish({ type: 'changed', scope: 'deal', what: `negotiation.${status}`, at: stamp() })
  }

  /** Keeps one side's debrief. Each side writes its own key of the JSON object, so neither overwrites the other. */
  saveDebrief(id: string, side: 'seller' | 'buyer', debrief: unknown): void {
    const row = this.negotiation(id)
    if (!row) return
    const current = row.debrief_json ? JSON.parse(row.debrief_json) as Record<string, unknown> : {}
    this.db.prepare('UPDATE negotiations SET debrief_json = ? WHERE id = ?').run(JSON.stringify({ ...current, [side]: debrief }), id)
    live.publish({ type: 'changed', scope: 'deal', what: 'negotiation.debrief', at: stamp() })
  }

  touchNegotiation(id: string, now: string): void {
    this.db.prepare('UPDATE negotiations SET updated_at = ? WHERE id = ?').run(now, id)
  }

  insertMove(row: MoveRow): void {
    this.db.prepare(`INSERT INTO negotiation_moves (id, negotiation_id, seq, side, action, deal_id, total_cents, final, message, assessment, actor, by, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.negotiation_id, row.seq, row.side, row.action, row.deal_id, row.total_cents, row.final, row.message, row.assessment, row.actor, row.by, row.run_id, row.created_at,
    )
    live.publish({ type: 'changed', scope: 'deal', what: `negotiation.${row.action}`, dealId: row.deal_id ?? undefined, at: stamp() })
  }

  moves(negotiationId: string): MoveRow[] {
    return this.db.prepare('SELECT * FROM negotiation_moves WHERE negotiation_id = ? ORDER BY seq ASC').all(negotiationId) as MoveRow[]
  }

  setDealStatus(id: string, status: DealRow['status']): void {
    this.db.prepare('UPDATE deals SET status = ? WHERE id = ?').run(status, id)
  }

  /** An accepted offer becomes the signed deal: the terms it was offered with, judged and signed at the moment of acceptance. */
  agreeDeal(id: string, input: { jobId: string; termsJson: string; verdictJson: string; buyerRulesVersion: number; sellerRulesVersion: number; termsHash: string; sig: string; keyId: string }): void {
    this.db.prepare(`UPDATE deals SET status = 'agreed', job_id = ?, terms_json = ?, verdict_json = ?, buyer_rules_version = ?, seller_rules_version = ?, terms_hash = ?, sig = ?, key_id = ? WHERE id = ? AND status = 'open'`)
      .run(input.jobId, input.termsJson, input.verdictJson, input.buyerRulesVersion, input.sellerRulesVersion, input.termsHash, input.sig, input.keyId, id)
    live.publish({ type: 'changed', scope: 'deal', what: 'deal.agreed', dealId: id, at: stamp() })
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

  /** Invoices the server still re-reads from PayPal, including one that is part paid. */
  openInvoices(): string[] {
    return (this.db.prepare(`SELECT invoice_id FROM proposals WHERE phase IN (${INVOICE_WATCH_SQL}) AND invoice_id IS NOT NULL ORDER BY updated_at LIMIT 20`).all() as Array<{ invoice_id: string }>).map((row) => row.invoice_id)
  }

  /** Checkout orders the server opened and the buyer has not finished with. A buyer who approved one and closed the
   *  browser must still leave the request settled, so the server re-reads these. */
  openOrders(): string[] {
    return (this.db.prepare(`SELECT order_id FROM proposals WHERE phase = 'order_created' AND order_id IS NOT NULL ORDER BY updated_at LIMIT 20`).all() as Array<{ order_id: string }>).map((row) => row.order_id)
  }

  /** The request an open order belongs to. */
  proposalByOrder(orderId: string): ProposalRow | null {
    return (this.db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE order_id = ?`).get(orderId) as ProposalRow | undefined) ?? null
  }

  /** How a charge is to be paid: an invoice the client gets, or a card form on our own page. */
  setPayInstrument(id: string, instrument: 'invoice' | 'checkout', now: string): void {
    this.db.prepare('UPDATE proposals SET pay_instrument = ?, updated_at = ? WHERE id = ?').run(instrument, now, id)
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
       WHERE phase IN (${OPEN_SQL})
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(limit) as ProposalRow[]
  }

  /**
   * An open request that asks for exactly the same money, on the same job, in the same currency, from the same
   * source. Used to refuse a second ask while the first is still live. Every field is part of "the same ask",
   * and every one is null safe, so two asks with no deal, or no funding, still match each other. The description
   * is deliberately not part of it: rewording the note does not make it a different ask.
   */
  openDuplicate(key: DuplicateKey): ProposalRow | null {
    const found = this.db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals
       WHERE phase IN (${OPEN_SQL})
         AND kind = ? AND amount_cents = ? AND currency = ?
         AND payee_id IS ? AND job_id IS ? AND funding_capture_id IS ?
         AND deal_id IS ? AND milestone IS ? AND parent_capture_id IS ?
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).get(key.kind, key.amountCents, key.currency, key.payeeId, key.jobId, key.fundingCaptureId, key.dealId, key.milestone, key.parentCaptureId)
    return (found as ProposalRow | undefined) ?? null
  }

  /** Settled and refunded requests, newest activity first. */
  settledProposals(sinceIso: string, limit: number): ProposalRow[] {
    return this.db.prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE phase IN (${PAID_SQL}) AND updated_at >= ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
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

  /**
   * Every PayPal id this ledger created or was told about, and every proposal id, with the money the ledger says that
   * request is. A PayPal transaction with none of these did not come from Mandate. One lookup answers both "whose is
   * this?" and "what should it be?", so a matched transaction can never be accepted without its amount also being in
   * hand. `cents` is signed the way PayPal's transaction report signs money.
   */
  knownPayPalIds(): Map<string, LedgerMoney> {
    const map = new Map<string, LedgerMoney>()
    const rows = this.db.prepare(`SELECT id, kind, amount_cents, captured_amount_cents, settled_cents, currency, order_id, capture_id, refund_id, payout_batch_id, payout_item_id, payout_txn_id, invoice_id FROM proposals`).all() as Array<{ id: string; kind: string; amount_cents: number; captured_amount_cents: number | null; settled_cents: number | null; currency: string; [key: string]: string | number | null }>
    for (const row of rows) {
      const money: LedgerMoney = { proposalId: row.id, cents: expectedSignedCents(row), currency: row.currency }
      map.set(money.proposalId, money)
      for (const key of ['order_id', 'capture_id', 'refund_id', 'payout_batch_id', 'payout_item_id', 'payout_txn_id', 'invoice_id']) {
        const value = row[key]
        if (value) map.set(value as string, money)
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

  safetyState(): { paused: number; reason: string | null; since: string | null; by: string | null; epoch: number; autopilot_paused?: number; config_json?: string | null } {
    return this.db.prepare('SELECT paused, reason, since, by, epoch, autopilot_paused, config_json FROM safety_state WHERE id = 1').get() as never
  }

  setSafetyState(state: { paused: boolean; reason: string | null; since: string | null; by: string | null; epoch: number; autopilotPaused?: boolean }): void {
    this.db.prepare('UPDATE safety_state SET paused = ?, reason = ?, since = ?, by = ?, epoch = ?, autopilot_paused = ? WHERE id = 1').run(
      state.paused ? 1 : 0,
      state.reason,
      state.since,
      state.by,
      state.epoch,
      state.autopilotPaused ? 1 : 0,
    )
  }

  safetyConfig<T = unknown>(): T | null {
    const row = this.db.prepare('SELECT config_json FROM safety_state WHERE id = 1').get() as { config_json?: string | null } | undefined
    if (row?.config_json) {
      try {
        return JSON.parse(row.config_json) as T
      } catch {}
    }
    return null
  }

  setSafetyConfig(config: unknown): void {
    this.db.prepare('UPDATE safety_state SET config_json = ? WHERE id = 1').run(JSON.stringify(config))
  }

  insertSafetyEvent(row: { id: string; at: string; type: string; by: string; reason: string | null; detail: string | null; sig: string | null; keyId: string | null }): void {
    this.db.prepare('INSERT INTO safety_events (id, at, type, by, reason, detail, sig, key_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.at, row.type, row.by, row.reason, row.detail, row.sig, row.keyId)
  }

  safetyEvents(limit: number): Array<{ id: string; at: string; type: string; by: string; reason: string | null; detail: string | null; sig: string | null; key_id: string | null }> {
    return this.db.prepare('SELECT * FROM safety_events ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as never
  }

  allSafetyEvents(): Array<{ id: string; at: string; type: string; by: string; reason: string | null; detail: string | null; sig: string | null; key_id: string | null }> {
    return this.db.prepare('SELECT id, at, type, by, reason, detail, sig, key_id FROM safety_events ORDER BY at ASC, rowid ASC').all() as never
  }

  insertClientError(row: { id: string; at: string; role: string; scope: string; message: string; stack: string | null; url: string | null; agent: string | null; releaseId: string | null }): void {
    this.db.prepare('INSERT INTO client_errors (id, at, role, scope, message, stack, url, agent, release_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.at, row.role, row.scope, row.message, row.stack, row.url, row.agent, row.releaseId)
    // Keep the newest 500. This is a diagnostic, not a record.
    this.db.prepare('DELETE FROM client_errors WHERE id IN (SELECT id FROM client_errors ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET 500)').run()
  }

  recentClientErrors(limit: number): Array<{ id: string; at: string; role: string; scope: string; message: string; stack: string | null; url: string | null; agent: string | null; release_id: string | null }> {
    return this.db.prepare('SELECT * FROM client_errors ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as never
  }

  trimClientErrors(olderThanIso: string): number {
    const result = this.db.prepare('DELETE FROM client_errors WHERE at < ?').run(olderThanIso)
    return Number(result.changes)
  }

  createAgent(row: AgentRow): void {
    this.db.prepare(`INSERT INTO agents (id, name, scopes_json, limits_json, status, key_hash, key_prefix, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.name, row.scopes_json, row.limits_json, row.status, row.key_hash, row.key_prefix ?? null, row.created_at, row.last_seen_at, row.expires_at ?? null)
  }

  listAgents(): AgentRow[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY created_at ASC, rowid ASC').all() as AgentRow[]
  }

  getAgent(id: string): AgentRow | null {
    return (this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined) ?? null
  }

  getAgentByKeyHash(keyHash: string): AgentRow | null {
    return (this.db.prepare('SELECT * FROM agents WHERE key_hash = ?').get(keyHash) as AgentRow | undefined) ?? null
  }

  setAgentStatus(id: string, status: string, at: string): void {
    this.db.prepare('UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?').run(status, at, id)
  }

  setAgentSeen(id: string, at: string): void {
    this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(at, id)
  }

  setAgentKeyHash(id: string, keyHash: string, keyPrefix?: string | null): void {
    if (keyPrefix !== undefined) {
      this.db.prepare('UPDATE agents SET key_hash = ?, key_prefix = ? WHERE id = ?').run(keyHash, keyPrefix, id)
    } else {
      this.db.prepare('UPDATE agents SET key_hash = ? WHERE id = ?').run(keyHash, id)
    }
  }

  agentProposalStats(agentId: string): { total: number; auto: number; needsTap: number; refusals: number } {
    const actor = `agent:${agentId}`
    const rows = this.db.prepare(
      `SELECT payload_json FROM events WHERE type = 'proposal.created'`
    ).all() as Array<{ payload_json: string }>
    let total = 0
    let auto = 0
    let needsTap = 0
    let refusals = 0
    for (const r of rows) {
      try {
        const payload = JSON.parse(r.payload_json) as { actor?: string; gate?: string }
        if (payload.actor === actor) {
          total += 1
          if (payload.gate === 'AUTO') auto += 1
          else if (payload.gate === 'DENY') refusals += 1
          else if (payload.gate === 'NEEDS_APPROVAL' || payload.gate === 'TAP') needsTap += 1
        }
      } catch {}
    }
    return { total, auto, needsTap, refusals }
  }

  createShare(row: ShareRow): void {
    this.db.prepare(`INSERT INTO share_links (id, job_id, party_id, role, label, secret_hash, created_at, expires_at, revoked_at, last_seen_at, views, can_pay)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.job_id, row.party_id, row.role, row.label, row.secret_hash, row.created_at, row.expires_at, row.revoked_at, row.last_seen_at, row.views, row.can_pay)
  }

  sharesForJob(jobId: string): ShareRow[] {
    return this.db.prepare('SELECT * FROM share_links WHERE job_id = ? ORDER BY created_at ASC, rowid ASC').all(jobId) as ShareRow[]
  }

  getShare(id: string): ShareRow | null {
    return (this.db.prepare('SELECT * FROM share_links WHERE id = ?').get(id) as ShareRow | undefined) ?? null
  }

  revokeShare(id: string, at: string): void {
    this.db.prepare('UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id)
  }

  noteShareSeen(id: string, at: string): void {
    this.db.prepare('UPDATE share_links SET last_seen_at = ?, views = views + 1 WHERE id = ?').run(at, id)
  }

  createClientKey(row: ClientKeyRow): void {
    this.db.prepare(`INSERT INTO client_keys (id, name, party_id, status, key_hash, key_prefix, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.name, row.party_id, row.status, row.key_hash, row.key_prefix ?? null, row.created_at, row.last_seen_at, row.expires_at ?? null)
  }

  listClientKeys(): ClientKeyRow[] {
    return this.db.prepare('SELECT * FROM client_keys ORDER BY created_at ASC, rowid ASC').all() as ClientKeyRow[]
  }

  getClientKey(id: string): ClientKeyRow | null {
    return (this.db.prepare('SELECT * FROM client_keys WHERE id = ?').get(id) as ClientKeyRow | undefined) ?? null
  }

  getClientKeyByKeyHash(keyHash: string): ClientKeyRow | null {
    return (this.db.prepare('SELECT * FROM client_keys WHERE key_hash = ?').get(keyHash) as ClientKeyRow | undefined) ?? null
  }

  setClientKeyStatus(id: string, status: string, at: string): void {
    this.db.prepare('UPDATE client_keys SET status = ?, last_seen_at = ? WHERE id = ?').run(status, at, id)
  }

  setClientKeyHash(id: string, keyHash: string, keyPrefix?: string | null): void {
    if (keyPrefix !== undefined) {
      this.db.prepare('UPDATE client_keys SET key_hash = ?, key_prefix = ? WHERE id = ?').run(keyHash, keyPrefix, id)
    } else {
      this.db.prepare('UPDATE client_keys SET key_hash = ? WHERE id = ?').run(keyHash, id)
    }
  }

  setClientKeySeen(id: string, at: string): void {
    this.db.prepare('UPDATE client_keys SET last_seen_at = ? WHERE id = ?').run(at, id)
  }

  recentAgentRuns(limit: number): AgentRunRow[] {
    return this.db.prepare('SELECT * FROM agent_runs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as AgentRunRow[]
  }

  setPhase(id: string, phase: string, now: string): void {
    this.db.prepare('UPDATE proposals SET phase = ?, updated_at = ? WHERE id = ?').run(phase, now, id)
    live.publish({ type: 'changed', scope: 'ledger', what: `phase.${phase}`, id, at: stamp() })
  }

  /** Opens the order on the row, and records how it was opened: a card order takes a card, a checkout sends the buyer away. */
  saveOrder(id: string, orderId: string, approveUrl: string | null, now: string, kind: 'card' | 'checkout' = 'checkout'): void {
    this.db.prepare(
      `UPDATE proposals SET phase = 'order_created', order_id = ?, approve_url = ?, order_kind = ?, updated_at = ? WHERE id = ?`,
    ).run(orderId, approveUrl, kind, now, id)
  }

  /**
   * A client paid in full, whether through a captured order or a paid invoice; both end in the same state, so funding
   * and refunds work unchanged. `capturedCents` is the lock, which is what the guarantee and the contractor share are
   * measured against; `settledCents` is what PayPal reported arrived, which can be more than the lock when the payer
   * adds a tip. Keeping the two apart is what lets `amounts.match` stay exact without hiding the money. `feeCents`
   * and `netCents` are what PayPal stated it took and paid out on a capture, null when it stated neither.
   */
  markCaptured(id: string, captureId: string, capturedCents: number, settledCents: number, now: string, feeCents: number | null = null, netCents: number | null = null): void {
    // COALESCE, like applyPayout: a re-read that does not repeat a fee PayPal already stated cannot erase it.
    this.db.prepare(
      `UPDATE proposals SET phase = 'captured', capture_id = ?, captured_amount_cents = ?, settled_cents = ?,
         capture_fee_cents = COALESCE(?, capture_fee_cents), capture_net_cents = COALESCE(?, capture_net_cents),
         delta_cents = ? - amount_cents, delta_reason = 'full', delta_source = NULL, updated_at = ?
       WHERE id = ? AND kind IN ('payment', 'charge')`,
    ).run(captureId, capturedCents, settledCents, feeCents, netCents, settledCents, now, id)
  }

  /**
   * PayPal reports a payment that is not the locked amount. Store what really arrived and the code for why.
   * Re-derived on every sweep, so a later full payment overwrites this, and a reason code added later can
   * explain a row an earlier code could only call unexplained. Writes only on change, because openInvoices
   * orders by updated_at: bumping a stuck invoice every sweep would rotate it to the back of that queue.
   * Returns true when this was news, which is what stops a part-paid invoice appending an event a minute.
   */
  recordSettlement(id: string, settledCents: number, reason: string, source: string | null, now: string): boolean {
    const written = this.db.prepare(
      `UPDATE proposals SET settled_cents = ?, delta_cents = ? - amount_cents, delta_reason = ?, delta_source = ?, updated_at = ?
       WHERE id = ? AND (settled_cents IS NOT ? OR delta_reason IS NOT ?)`,
    ).run(settledCents, settledCents, reason, source, now, id, settledCents, reason)
    return Number(written.changes) > 0
  }

  /**
   * PayPal put some, but not all, of the locked amount in. Store what arrived, why it fell short, and move the row
   * to `settled_short`, so no reader has to infer "some money came" from a settled amount sitting on a row whose
   * phase still says the invoice is out.
   *
   * The capture id is the PayPal payment id, the same kind of id a full capture stores, so a refund can cite this
   * row and a payout can be funded from it. It may be absent if PayPal reported a payment without an id: the row
   * still settles short, it just cannot be the parent of a refund.
   *
   * Re-derived on every sweep, exactly like `recordSettlement`: a later payment that completes the lock overwrites
   * this through `markCaptured`, and a reason code added later can explain a row an earlier code could only call
   * unexplained. Writes only on change, because `openInvoices` orders by updated_at. Returns true when the
   * settlement was news.
   */
  settleShort(id: string, captureId: string | null, settledCents: number, reason: string, source: string | null, now: string): boolean {
    const written = this.db.prepare(
      `UPDATE proposals SET phase = 'settled_short', capture_id = COALESCE(capture_id, ?), settled_cents = ?,
         delta_cents = ? - amount_cents, delta_reason = ?, delta_source = ?, updated_at = ?
       WHERE id = ? AND kind = 'charge'
         AND (phase IS NOT 'settled_short' OR settled_cents IS NOT ? OR delta_reason IS NOT ?)`,
    ).run(captureId, settledCents, settledCents, reason, source, now, id, settledCents, reason)
    return Number(written.changes) > 0
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

type PartyRulesDbRow = { party_id: string; version: number; body_json: string; created_at: string; origin: string; written_by: string | null }

function toPartyRules(row: PartyRulesDbRow): PartyRulesRecord {
  return {
    partyId: row.party_id,
    version: row.version,
    body: PartyRulesSchema.parse(JSON.parse(row.body_json)),
    createdAt: row.created_at,
    origin: row.origin === 'seed' ? 'seed' : 'written',
    writtenBy: row.written_by === 'party' ? 'party' : row.written_by === 'owner' ? 'owner' : null,
  }
}
