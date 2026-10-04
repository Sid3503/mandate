import type { DatabaseSync } from 'node:sqlite'
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
  created_at: string
  updated_at: string
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
  reservedAt: string | null
  now: string
}

const PROPOSAL_COLUMNS = `id, warrant_id, warrant_version, kind, parent_capture_id, payee_id, amount_cents, currency,
  category, description, evidence_url, prompt, gate, clause, detail, phase, cart_hash, order_id, capture_id,
  refund_id, approve_url, captured_amount_cents, reserved_at, job_id, funding_capture_id, created_at, updated_at`

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
      funding_capture_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.warrantId, input.warrantVersion, input.kind, input.parentCaptureId, input.payeeId,
      input.amountCents, input.currency, input.category, input.description, input.evidenceUrl, input.prompt,
      input.gate, input.clause, input.detail, input.phase, input.cartHash, input.reservedAt, input.jobId,
      input.fundingCaptureId, input.now, input.now,
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
         AND phase IN ('locked', 'order_created', 'capture_inflight', 'captured')`,
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
         AND phase IN ('locked', 'order_created', 'capture_inflight', 'captured')`,
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
      'SELECT id, proposal_id, type, clause, payload_json, created_at FROM events WHERE proposal_id = ? ORDER BY created_at ASC, id ASC',
    ).all(proposalId) as EventRow[]
  }

  lockProposal(id: string, hash: string, now: string): void {
    this.db.prepare(
      `UPDATE proposals SET phase = 'locked', cart_hash = ?, reserved_at = ?, updated_at = ? WHERE id = ?`,
    ).run(hash, now, now, id)
  }

  setPhase(id: string, phase: string, now: string): void {
    this.db.prepare('UPDATE proposals SET phase = ?, updated_at = ? WHERE id = ?').run(phase, now, id)
  }

  saveOrder(id: string, orderId: string, approveUrl: string | null, now: string): void {
    this.db.prepare(
      `UPDATE proposals SET phase = 'order_created', order_id = ?, approve_url = ?, updated_at = ? WHERE id = ?`,
    ).run(orderId, approveUrl, now, id)
  }

  markCaptured(id: string, captureId: string, amountCents: number, now: string): void {
    this.db.prepare(
      `UPDATE proposals SET phase = 'captured', capture_id = ?, captured_amount_cents = ?, updated_at = ? WHERE id = ? AND kind IN ('payment', 'charge')`,
    ).run(captureId, amountCents, now, id)
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
