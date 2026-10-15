import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices } from '../src/paypal/fake'
import { agree, call, closeAll, EVIDENCE, harness, idem, JOB } from './support'

afterEach(closeAll)

/** The frozen job's first milestone is a 15,000 cent charge to Northwind, billed as a PayPal invoice. */
async function billed(invoices: FakeInvoices) {
  const h = harness({ invoices })
  const deal = await agree(h.app)
  const bill = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
  await call(h.app, 'POST', `/v1/proposals/${bill.json.id}/approve`)
  const id = bill.json.id as string
  const sent = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
  return { ...h, id, invoices, invoiceId: sent.json.invoiceId as string }
}

/** The same charge, settled for 5,000 of its 15,000. Returns the PayPal payment id that came with the money. */
async function shortSettled() {
  const h = await billed(new FakeInvoices())
  h.invoices.pay(h.invoiceId, 5_000)
  const settled = await call(h.app, 'POST', `/v1/proposals/${h.id}/capture`)
  return { ...h, captureId: settled.json.captureId as string }
}

describe('a short settlement is a settlement', () => {
  it('moves the row to settled_short, keeps the payment id, and counts what arrived', async () => {
    const h = await shortSettled()
    const row = (await call(h.app, 'GET', `/v1/proposals/${h.id}`)).json
    expect(row).toMatchObject({ phase: 'settled_short', settledCents: 5_000, deltaCents: -10_000, deltaReason: 'partial' })
    expect(h.captureId).toMatch(/^CAP-INV-/)
    const job = (await call(h.app, 'GET', `/v1/jobs/${JOB}`)).json
    expect(job.charges[0]).toMatchObject({ phase: 'settled_short', fundableCents: 3_000 })
    expect(job.totals.inCents).toBe(5_000)
  })

  it('does not claim the cents matched, even though the row is settled', async () => {
    const h = await shortSettled()
    const packet = (await call(h.app, 'GET', `/v1/proposals/${h.id}/packet`)).json
    expect(packet.amounts).toEqual({ approvedCents: 15_000, capturedCents: null, match: false })
    // The gap is on the record, with the reason that names it.
    expect(packet.proposal).toMatchObject({ settledCents: 5_000, deltaCents: -10_000, deltaReason: 'partial' })
  })

  it('funds a payout up to the share of what arrived, and no further', async () => {
    const h = await shortSettled()
    const body = (amountCents: number) => ({ payee: 'Priya', amountCents, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: h.captureId })
    const ok = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: body(3_000) })
    expect(ok.json.gate).toBe('NEEDS_APPROVAL')
    expect(ok.json.clause).not.toBe('funding.missing')
    // 60% of the 5,000 that arrived is 3,000, not 60% of the 15,000 that was locked.
    const tooMuch = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: body(3_001) })
    expect(tooMuch.json).toMatchObject({ gate: 'DENY', clause: 'funding.exceeds' })
  })

  it('refunds a short settlement, capped by what arrived', async () => {
    const h = await shortSettled()
    const body = (amountCents: number) => ({ kind: 'refund', payee: 'Northwind', amountCents, currency: 'USD', category: 'design', description: 'give it back', evidenceUrl: EVIDENCE, parentCaptureId: h.captureId })
    const ok = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: body(5_000) })
    expect(ok.json.clause).not.toBe('refund.unlinked')
    const tooMuch = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: body(5_001) })
    expect(tooMuch.json).toMatchObject({ gate: 'DENY', clause: 'refund.exceeds' })
  })

  it('leaves the audit green: the payout is funded, and the job totals count the money that arrived', async () => {
    const h = await shortSettled()
    await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: { payee: 'Priya', amountCents: 3_000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: h.captureId } })
    const report = await h.services.audit.run()
    const checks = new Map(report.checks.map((check) => [check.id, check]))
    expect(checks.get('payouts.funded')!.status).toBe('pass')
    expect(checks.get('jobs.in_covers_out')!.status).toBe('pass')
    expect(checks.get('history.complete')!.status).toBe('pass')
    // The cents-equal-the-lock guarantee is untouched: a settled_short row is not counted as matching.
    expect(checks.get('amounts.match')!.status).toBe('pass')
  })
})

describe('the phase vocabulary is shared, not hand-written', () => {
  it('has no raw "captured" comparison outside domain/phases.ts', () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url))
    const phases = fileURLToPath(new URL('../src/domain/phases.ts', import.meta.url))
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          walk(path)
          continue
        }
        if (!name.endsWith('.ts') || path === phases) continue
        const lines = readFileSync(path, 'utf8').split('\n')
        lines.forEach((line, index) => {
          if (!/[!=]==\s*'captured'/.test(line)) return
          const near = lines.slice(Math.max(0, index - 3), index + 1).join('\n')
          if (!near.includes('phase-compare-ok')) offenders.push(`${path.slice(root.length)}:${index + 1}: ${line.trim()}`)
        })
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
