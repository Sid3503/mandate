// Demo only. A payment PayPal already holds is brought back into a fresh ledger, so a later step (a refund) can be filmed
// against it. The demo server keeps its ledger in memory, so a take's own rows are gone once the server stops; PayPal's
// records are not. Everything that is PayPal's (order, capture, fee, net, the payout to the contractor) is read from
// paypal-record.json, which paypal-record.mjs fetched from the sandbox. The rows go in through the same service calls a
// real request takes, so the lock is signed and the gate has said its piece; only PayPal's answers are put in place of
// calls that would have made a second payment.
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Services } from '../services/container'

type PayPalRecord = {
  order: { id: string; customId: string; description: string; amountCents: number; currency: string }
  capture: { id: string; amountCents: number; feeCents: number; netCents: number; createdAt: string }
  payout: { transactionId: string; amountCents: number; at: string; feeCents: number | null }
}

type Cast = { client: { id: string }; payee: { id: string }; categories: string[]; proof: string }

export function adoptPayment(services: Services, recordPath: string, cast: Cast): { jobId: string; chargeId: string; payoutId: string } {
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

  const payout = mandate.propose({
    kind: 'payment', payee: cast.payee.id, amountCents: record.payout.amountCents, currency: record.order.currency, category: cast.categories[0],
    description: `Share of ${record.order.description}`, evidenceUrl: cast.proof, jobId, fundingCaptureId: record.capture.id,
  }, key('payout'))
  if (payout.status >= 300) throw new Error(`adopt: the payout was refused: ${JSON.stringify(payout.body)}`)
  const payoutId = (payout.body as { id: string }).id
  const locked = mandate.approve(payoutId, null, { method: 'owner-key' })
  if (locked.status >= 300) throw new Error(`adopt: the payout could not be locked: ${JSON.stringify(locked.body)}`)
  repo.transaction(() => {
    repo.applyPayout(payoutId, { phase: 'captured', status: 'SUCCESS', itemId: null, transactionId: record.payout.transactionId, feeCents: record.payout.feeCents, paidCents: record.payout.amountCents }, record.payout.at)
    repo.insertEvent(randomUUID(), payoutId, 'payout.completed', repo.proposal(payoutId)!.clause, { transactionId: record.payout.transactionId, amountCents: record.payout.amountCents }, record.payout.at)
  })
  return { jobId, chargeId, payoutId }
}
