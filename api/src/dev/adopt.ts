// Demo only. A payment PayPal already holds is brought back into a fresh ledger, so a later step (a refund) can be filmed
// against it. The demo server keeps its ledger in memory, so a take's own rows are gone once the server stops; PayPal's
// records are not. Everything that is PayPal's (order, capture, fee, net, the payout to the contractor) is read from
// paypal-record.json, which paypal-record.mjs fetched from the sandbox. The rows go in through the same service calls a
// real request takes, so the lock is signed and the gate has said its piece; only PayPal's answers are put in place of
// calls that would have made a second payment.
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Clause } from '../domain/gate'
import type { Services } from '../services/container'

type PayPalRecord = {
  order: { id: string; customId: string; description: string; amountCents: number; currency: string }
  capture: { id: string; amountCents: number; feeCents: number; netCents: number; createdAt: string }
  payout: { transactionId: string; amountCents: number; at: string; feeCents: number | null }
  // A refund PayPal already completed on this capture. Rebuilt here so the desk can show it.
  // Nothing in this block is sent to PayPal.
  refund?: { id: string; amountCents: number; at: string }
}

type Cast = { client: { id: string }; payee: { id: string }; categories: string[]; proof: string }

/**
 * `stage: 'charge'` stops once the client's payment has settled, before the contractor's share is paid: the ledger as it
 * stood the moment the money arrived. It is built from the same PayPal record, and nothing is sent anywhere.
 */
export function adoptPayment(services: Services, recordPath: string, cast: Cast, stage: 'all' | 'charge' = 'all'): { jobId: string; chargeId: string; payoutId: string | null; refundId: string | null } {
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as PayPalRecord
  const { mandate, repo } = services
  const jobId = 'job_coastline-store'
  const key = (what: string) => `adopt-${what}-${record.capture.id}`

  const charge = mandate.propose({
    kind: 'charge', payee: cast.client.id, amountCents: record.order.amountCents, currency: record.order.currency, category: cast.categories[0],
    description: record.order.description, evidenceUrl: cast.proof, jobId,
  }, key('charge'))
  if (charge.status >= 300) throw new Error(`adopt: the charge was refused: ${JSON.stringify(charge.body)}`)
  const chargeId = (charge.body as { id: string }).id
  const approved = mandate.approve(chargeId, null, { method: 'owner-key' }, 'checkout')
  if (approved.status >= 300) throw new Error(`adopt: the charge could not be locked: ${JSON.stringify(approved.body)}`)
  const paidAt = record.capture.createdAt
  repo.transaction(() => {
    repo.saveOrder(chargeId, record.order.id, null, paidAt, 'card')
    repo.markCaptured(chargeId, record.capture.id, record.capture.amountCents, record.capture.amountCents, paidAt, record.capture.feeCents, record.capture.netCents)
    const clause = repo.proposal(chargeId)!.clause
    repo.insertEvent(randomUUID(), chargeId, 'order.created', clause, { orderId: record.order.id }, paidAt)
    repo.insertEvent(randomUUID(), chargeId, 'capture.completed', clause, { orderId: record.order.id, captureId: record.capture.id, amountCents: record.capture.amountCents }, paidAt)
  })

  if (stage === 'charge') return { jobId, chargeId, payoutId: null, refundId: null }

  const payout = mandate.propose({
    kind: 'payment', payee: cast.payee.id, amountCents: record.payout.amountCents, currency: record.order.currency, category: cast.categories[0],
    description: `Share of ${record.order.description}`, evidenceUrl: cast.proof, jobId, fundingCaptureId: record.capture.id,
  }, key('payout'))
  if (payout.status >= 300) throw new Error(`adopt: the payout was refused: ${JSON.stringify(payout.body)}`)
  const payoutId = (payout.body as { id: string }).id
  const locked = mandate.approve(payoutId, null, { method: 'owner-key' })
  if (locked.status >= 300) throw new Error(`adopt: the payout could not be locked: ${JSON.stringify(locked.body)}`)
  // A locked payout is not paid yet. The real path settles from "settling", and the state machine only allows that edge.
  if (!repo.transitionPhase(payoutId, ['locked'], 'capture_inflight', record.payout.at)) {
    throw new Error('adopt: the payout could not move to settling')
  }
  repo.transaction(() => {
    repo.applyPayout(payoutId, { phase: 'captured', status: 'SUCCESS', itemId: null, transactionId: record.payout.transactionId, feeCents: record.payout.feeCents, paidCents: record.payout.amountCents }, record.payout.at)
    repo.insertEvent(randomUUID(), payoutId, 'payout.completed', repo.proposal(payoutId)!.clause, { transactionId: record.payout.transactionId, amountCents: record.payout.amountCents }, record.payout.at)
  })

  const refundId = record.refund ? adoptRefund(services, record, cast, key, jobId) : null
  return { jobId, chargeId, payoutId, refundId }
}

// The capture was already refunded at PayPal. Propose and approve go through the gate (the owner had to tap,
// because the payout had left). The PayPal call itself is not made again: the completed refund id is written
// where a successful call would have written it, and the charge is marked taken back so Money at risk can name the hole.
function adoptRefund(services: Services, record: PayPalRecord, cast: Cast, key: (what: string) => string, jobId: string): string {
  const { mandate, repo } = services
  const refund = record.refund!
  const asked = mandate.propose({
    kind: 'refund', payee: cast.client.id, amountCents: refund.amountCents, currency: record.order.currency, category: cast.categories[0],
    description: `Refund of ${record.order.description}`, evidenceUrl: cast.proof, jobId, parentCaptureId: record.capture.id,
  }, key('refund'))
  const askedBody = asked.body as { id?: string; gate?: string }
  if (asked.status >= 300 || !askedBody.id || askedBody.gate === 'DENY') {
    throw new Error(`adopt: the refund was refused: ${JSON.stringify(asked.body)}`)
  }
  if (askedBody.gate !== 'NEEDS_APPROVAL') {
    throw new Error(`adopt: the refund did not wait for the owner (gate ${askedBody.gate})`)
  }
  const refundId = askedBody.id
  const approved = mandate.approve(refundId, null, { method: 'owner-key' })
  if (approved.status >= 300) throw new Error(`adopt: the refund could not be locked: ${JSON.stringify(approved.body)}`)
  if (!repo.transitionPhase(refundId, ['locked'], 'capture_inflight', refund.at)) {
    throw new Error('adopt: the refund could not move to settling')
  }
  const attemptId = randomUUID()
  repo.transaction(() => {
    repo.markRefunded(refundId, refund.id, refund.amountCents, refund.at)
    repo.insertEvent(randomUUID(), refundId, 'refund.completed', repo.proposal(refundId)!.clause, {
      parentCaptureId: record.capture.id, refundId: refund.id, amountCents: refund.amountCents,
    }, refund.at)
    repo.startAttempt({ id: attemptId, proposalId: refundId, op: 'refund', requestId: `adopt-refund-${refund.id}`, now: refund.at })
    repo.finishAttempt(attemptId, 'succeeded', refund.id, null, refund.at)
  })
  const charge = repo.proposalByCapture(record.capture.id)
  if (!charge || !repo.transitionPhase(charge.id, ['captured'], 'capture_reversed', refund.at)) {
    throw new Error('adopt: the capture could not be marked taken back')
  }
  repo.insertEvent(randomUUID(), charge.id, 'capture.reversed', Clause.fundingExceeds, {
    captureId: record.capture.id, status: 'REFUNDED', refundedHereCents: refund.amountCents,
  }, refund.at)
  return refundId
}
