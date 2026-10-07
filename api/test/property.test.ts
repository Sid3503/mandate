import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices } from '../src/paypal/fake'
import { agree, call, closeAll, EVIDENCE, harness, idem, JOB, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

/**
 * Random months.
 *
 * Each run is a fresh ledger and a few dozen random things happening to it: deals billed, clients paying, requests that
 * are fine and requests that are not, approvals, rejections, refunds, rule changes, the emergency stop pressed and
 * released. After every run the same promises are checked by code that does not share anything with the gate. The runs are
 * seeded, so a failure names the seed and replays exactly. PROPERTY_RUNS raises the number (the default is small enough
 * to run on every change; the guarantees page says how many ran).
 */
export const RUNS = Number(process.env.PROPERTY_RUNS ?? 40)
const STEPS = 36

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Row = Record<string, any>

async function month(seed: number) {
  const random = rng(seed)
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]!
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1))

  const invoices = new FakeInvoices()
  const h = harness({ invoices })
  const app = h.app
  const rows = async () => (await call(app, 'GET', '/v1/proposals?limit=100')).json.data as Row[]
  const captured = async () => (await rows()).filter((row) => row.kind === 'charge' && row.phase === 'captured')
  const deal = await agree(app)
  let billed = 0
  let trail = ''
  const note = (what: string) => { trail += `${what}; ` }

  for (let step = 0; step < STEPS; step += 1) {
    const move = random()
    if (move < 0.16 && billed < 2) {
      note(`bill ${billed}`)
      const made = await call(app, 'POST', `/v1/deals/${deal.id}/milestones/${billed}/bill`, { key: pick([STUDIO_KEY, OWNER_KEY]), body: { evidenceUrl: EVIDENCE } })
      if (made.status === 201 && made.json.gate !== 'DENY') billed += 1
    } else if (move < 0.3) {
      const pending = (await rows()).filter((row) => row.kind === 'charge' && ['pending_approval', 'locked', 'invoice_sent', 'order_created'].includes(row.phase))
      if (pending.length > 0) {
        const row = pick(pending)
        note(`client pays ${row.id.slice(0, 4)}`)
        if (row.phase === 'pending_approval') await call(app, 'POST', `/v1/proposals/${row.id}/approve`)
        if (row.phase === 'invoice_sent') { invoices.pay(row.invoiceId); await h.services.mandate.sweepPending() } else await call(app, 'POST', `/v1/proposals/${row.id}/capture`)
      }
    } else if (move < 0.62) {
      const charges = await captured()
      const funding = charges.length > 0 && random() < 0.8 ? pick(charges) : null
      const body: Record<string, unknown> = {
        kind: 'payment',
        payee: pick(['Priya', 'Priya', 'Priya', 'P. Shah', 'Cafe Lila']),
        amountCents: pick([between(1, 2_500), between(1_000, 9_000), between(9_000, 60_000)]),
        currency: random() < 0.95 ? 'USD' : 'EUR',
        category: pick(['design', 'design', 'production', 'lunch']),
        description: 'random',
        evidenceUrl: random() < 0.9 ? EVIDENCE : undefined,
        jobId: JOB,
        fundingCaptureId: funding ? (random() < 0.9 ? funding.captureId : 'CAP-NOT-REAL') : undefined,
      }
      note(`ask ${body.amountCents} ${body.payee}`)
      await call(app, 'POST', '/v1/proposals', { key: pick([STUDIO_KEY, OWNER_KEY]), idem: random() < 0.15 ? 'same-key-for-replays-0001' : idem(), body })
    } else if (move < 0.78) {
      const waiting = (await rows()).filter((row) => row.phase === 'pending_approval' && row.kind === 'payment')
      if (waiting.length > 0) {
        const row = pick(waiting)
        note(`${random() < 0.8 ? 'approve' : 'reject'} ${row.id.slice(0, 4)}`)
        if (random() < 0.8) {
          await call(app, 'POST', `/v1/proposals/${row.id}/approve`)
          await call(app, 'POST', `/v1/proposals/${row.id}/capture`)
        } else await call(app, 'POST', `/v1/proposals/${row.id}/reject`)
      }
    } else if (move < 0.86) {
      const charges = await captured()
      if (charges.length > 0) {
        const row = pick(charges)
        note('refund')
        await call(app, 'POST', '/v1/proposals', { idem: idem(), body: { kind: 'refund', payee: 'Northwind', amountCents: between(100, row.amountCents), currency: 'USD', category: 'design', description: 'refund', evidenceUrl: EVIDENCE, parentCaptureId: row.captureId } })
      }
    } else if (move < 0.92) {
      note('rules')
      const current = (await call(app, 'GET', '/v1/warrant')).json
      const { id: _id, version: _v, createdAt: _c, ...body } = current
      await call(app, 'PUT', '/v1/warrant', { body: { ...body, monthlyCapCents: pick([6_000, 18_000, 50_000]), autoSettleUnderCents: pick([0, 1_000, 2_000, 5_000]), standing: random() < 0.5 ? [{ id: 'p', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }] : [], automation: { ...body.automation, billSignedDeals: random() < 0.5, payOnSettle: random() < 0.5 } } })
    } else {
      note('pause/resume')
      await call(app, 'POST', random() < 0.5 ? '/v1/safety/pause' : '/v1/safety/resume')
    }
  }
  return { h, trail, rows: await rows(), app }
}

describe('random months', () => {
  it(`keep every promise, in ${RUNS} runs of ${STEPS} random steps`, async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const { h, trail, rows, app } = await month(seed * 7919)
      const where = `seed ${seed * 7919} (${trail.slice(0, 400)})`
      const versions = (await call(app, 'GET', '/v1/warrant/versions')).json.data as Row[]
      const maxShare = Math.max(...versions.map((v) => v.contractorShareBps))
      const maxCap = Math.max(...versions.map((v) => v.monthlyCapCents))
      const settled = (row: Row) => row.phase === 'captured' && (row.capturedAmountCents ?? 0) > 0
      const payouts = rows.filter((row) => row.kind === 'payment')
      const charges = rows.filter((row) => row.kind === 'charge' && settled(row))

      // 1. A payout never exceeds the contractor's share of the client money it cites.
      for (const charge of charges) {
        const out = payouts.filter((p) => p.fundingCaptureId === charge.captureId && settled(p)).reduce((sum, p) => sum + p.amountCents, 0)
        expect(out, `payouts from ${charge.captureId} exceed the share. ${where}`).toBeLessThanOrEqual(Math.floor((charge.capturedAmountCents * maxShare) / 10_000))
      }
      // 2. Nothing is paid out of money that did not arrive.
      for (const p of payouts.filter(settled)) expect(charges.some((c) => c.captureId === p.fundingCaptureId), `a payout was sent with no settled client payment behind it. ${where}`).toBe(true)
      // 3. In total, contractors are paid less than came in, and never more than the highest cap ever in force.
      const totalIn = charges.reduce((sum, c) => sum + c.capturedAmountCents, 0)
      const totalOut = payouts.filter(settled).reduce((sum, p) => sum + p.capturedAmountCents, 0)
      expect(totalOut, `more went out than came in. ${where}`).toBeLessThanOrEqual(totalIn)
      expect(totalOut, `more went out than any cap allowed. ${where}`).toBeLessThanOrEqual(maxCap)
      // 4. A request nobody could approve never went through: unknown payees and unlisted work are never paid.
      for (const p of payouts) {
        if (['payee_unknown', null].includes(p.payeeId)) expect(settled(p) || p.phase === 'locked', `an unknown payee was approved. ${where}`).toBe(false)
        if (p.category === 'lunch') expect(settled(p), `unlisted work was paid. ${where}`).toBe(false)
      }
      // 5. Nothing the rules refused ever reached PayPal.
      for (const p of rows.filter((row) => row.gate === 'DENY')) expect(p.orderId ?? p.payoutBatchId ?? p.captureId, `a refused request has a PayPal id. ${where}`).toBeFalsy()
      // 6. PayPal was asked to pay exactly the payouts that have a batch: never twice for one request.
      const batches = payouts.filter((p) => p.payoutBatchId).length
      expect(h.paypal!.payoutCalls, `PayPal was asked to pay a different number of times than there are payouts. ${where}`).toBe(batches)
      // 7. The server's own audit, which does not share the gate's code, agrees with all of it.
      const audit = (await call(app, 'GET', '/v1/audit')).json
      const failed = audit.checks.filter((check: Row) => check.status === 'fail').map((check: Row) => `${check.id}: ${JSON.stringify(check.failures).slice(0, 200)}`)
      expect(failed, `the audit failed. ${where}`).toEqual([])
      closeAll()
    }
  }, 600_000)
})
