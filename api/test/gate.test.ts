import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Clause, decide } from '../src/domain/gate'
import { canonicalCart, cartHash } from '../src/domain/hash'
import { centsToPayPal, payPalToCents } from '../src/domain/money'
import { monthWindow } from '../src/domain/period'
import { LINE_STUDIO_WARRANT } from '../src/domain/schemas'
import { loadConfig } from '../src/config'

const warrant = LINE_STUDIO_WARRANT
const base = {
  kind: 'payment' as const,
  payeeId: 'payee_priya',
  amountCents: 9000,
  currency: 'USD',
  category: 'design',
  evidenceUrl: 'https://www.figma.com/file/northwind-logo',
  parent: null,
  jobId: 'job_northwind_logo',
  fundingCaptureId: 'CAP-NW-1',
  funding: {
    kind: 'charge',
    phase: 'captured',
    jobId: 'job_northwind_logo',
    currency: 'USD',
    capturedCents: 15000,
    refundHeldCents: 0,
    payoutHeldCents: 0,
  },
}

const charge = {
  kind: 'charge' as const,
  payeeId: 'client_northwind',
  amountCents: 15000,
  currency: 'USD',
  category: 'design',
  evidenceUrl: 'https://www.figma.com/file/northwind-logo',
  parent: null,
  jobId: 'job_northwind_logo',
}

describe('gate', () => {
  it('denies lunch because the category is not on the warrant', () => {
    const decision = decide(warrant, { ...base, category: 'lunch' }, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision).toMatchObject({ gate: 'DENY', clause: Clause.categoryMissing })
  })

  it('asks Meera to tap for Priya at $90', () => {
    const decision = decide(warrant, base, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: Clause.amountNeedsApproval })
  })

  it('denies an unknown payee before the auto rule', () => {
    const decision = decide(warrant, { ...base, payeeId: null, amountCents: 1800 }, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision).toMatchObject({ gate: 'DENY', clause: Clause.payeeUnknown })
  })

  it('auto-settles a known payee under $20', () => {
    const decision = decide(warrant, { ...base, amountCents: 1800 }, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision).toMatchObject({ gate: 'AUTO', clause: Clause.amountAuto })
  })

  it('denies a third $90 payout over the $180 monthly cap and cites captures', () => {
    const decision = decide(warrant, base, { reservedCents: 18000, priorCaptureIds: ['CAP-A', 'CAP-B'] })
    expect(decision.gate).toBe('DENY')
    expect(decision.clause).toBe(Clause.capMonthly)
    expect(decision.detail).toContain('CAP-A')
    expect(decision.detail).toContain('18000')
  })

  it('refuses a payout that cites no client payment', () => {
    const decision = decide(warrant, { ...base, fundingCaptureId: null, funding: null }, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision).toMatchObject({ gate: 'DENY', clause: Clause.fundingMissing })
  })

  it('refuses a payout funded by a client payment that is not captured yet', () => {
    const decision = decide(warrant, { ...base, funding: { ...base.funding, phase: 'pending_approval' } }, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision).toMatchObject({ gate: 'DENY', clause: Clause.fundingMissing })
  })

  it('refuses a payout funded by another job', () => {
    const decision = decide(warrant, { ...base, funding: { ...base.funding, jobId: 'job_other' } }, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision).toMatchObject({ gate: 'DENY', clause: Clause.fundingJobMismatch })
  })

  it('caps Priya at a 60% share of the $150 client payment', () => {
    const over = decide(warrant, { ...base, amountCents: 9001 }, { reservedCents: 0, priorCaptureIds: [] })
    expect(over).toMatchObject({ gate: 'DENY', clause: Clause.fundingExceeds })
    const spent = decide(warrant, { ...base, funding: { ...base.funding, payoutHeldCents: 9000 } }, { reservedCents: 0, priorCaptureIds: [] })
    expect(spent).toMatchObject({ gate: 'DENY', clause: Clause.fundingExceeds })
  })

  it('asks Meera to tap a $150 client charge and refuses one with no job', () => {
    expect(decide(warrant, charge, { reservedCents: 0, priorCaptureIds: [] })).toMatchObject({ gate: 'NEEDS_APPROVAL' })
    expect(decide(warrant, { ...charge, jobId: null }, { reservedCents: 0, priorCaptureIds: [] })).toMatchObject({ gate: 'DENY', clause: Clause.jobMissing })
    expect(decide(warrant, { ...charge, payeeId: null }, { reservedCents: 0, priorCaptureIds: [] })).toMatchObject({ gate: 'DENY', clause: Clause.payeeUnknown })
  })

  it('does not count client charges against the contractor monthly cap', () => {
    const decision = decide(warrant, charge, { reservedCents: 18000, priorCaptureIds: [] })
    expect(decision.gate).toBe('NEEDS_APPROVAL')
  })

  it('denies a refund that is not tied to a capture', () => {
    const decision = decide(warrant, { ...base, kind: 'refund', amountCents: 9000 }, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision.clause).toBe(Clause.refundUnlinked)
  })

  it('pins the cart hash to a canonical document', () => {
    const fields = {
      proposalId: '11111111-1111-4111-8111-111111111111',
      warrantId: 'wnt_line_studio',
      warrantVersion: 1,
      payeeId: 'payee_priya',
      amountCents: 9000,
      currency: 'USD',
      category: 'design',
      evidenceUrl: 'https://www.figma.com/file/northwind-logo',
      kind: 'payment' as const,
      parentCaptureId: null,
    }
    const canonical = canonicalCart(fields)
    expect(canonical).toBe('{"v":1,"proposalId":"11111111-1111-4111-8111-111111111111","warrantId":"wnt_line_studio","warrantVersion":1,"payeeId":"payee_priya","amountCents":9000,"currency":"USD","category":"design","evidenceUrl":"https://www.figma.com/file/northwind-logo","kind":"payment","parentCaptureId":null}')
    expect(cartHash(fields)).toBe(createHash('sha256').update(canonical).digest('hex'))
  })

  it('locks the job and the funding capture into a v2 cart', () => {
    const fields = {
      proposalId: '11111111-1111-4111-8111-111111111111',
      warrantId: 'wnt_line_studio',
      warrantVersion: 1,
      payeeId: 'payee_priya',
      amountCents: 9000,
      currency: 'USD',
      category: 'design',
      evidenceUrl: 'https://www.figma.com/file/northwind-logo',
      kind: 'payment' as const,
      parentCaptureId: null,
      jobId: 'job_northwind_logo',
      fundingCaptureId: 'CAP-NW-1',
    }
    const parsed = JSON.parse(canonicalCart(fields))
    expect(parsed).toMatchObject({ v: 2, jobId: 'job_northwind_logo', fundingCaptureId: 'CAP-NW-1' })
    expect(cartHash(fields)).not.toBe(cartHash({ ...fields, fundingCaptureId: 'CAP-OTHER' }))
  })
})

describe('money and calendar', () => {
  it('converts integer cents without float math', () => {
    expect(centsToPayPal(9000)).toBe('90.00')
    expect(payPalToCents('90.00')).toBe(9000)
    expect(payPalToCents('10.5')).toBe(1050)
  })

  it('uses the studio month in Asia/Kolkata', () => {
    const window = monthWindow(new Date('2026-10-03T12:00:00.000Z'), 'Asia/Kolkata')
    expect(window.start).toBe('2026-09-30T18:30:00.000Z')
    expect(window.end).toBe('2026-10-31T18:30:00.000Z')
  })
})

describe('config', () => {
  it('refuses to boot production without a real API key', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/API_KEY/)
  })
})
