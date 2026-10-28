import { describe, it, expect } from 'vitest'
import { decide, Clause } from '../src/domain/gate'
import { LINE_STUDIO_WARRANT } from '../src/domain/schemas'

const validBase = {
  kind: 'payment' as const,
  payeeId: 'payee_priya',
  currency: 'USD',
  category: 'design',
  evidenceUrl: 'https://example.com/logo.svg',
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

describe('Deal Constitution & DUAL_TAP Conflict Protocol', () => {
  it('triggers DUAL_TAP when owner and counterparty sheets disagree on gate', () => {
    const ownerWarrant = {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
      autoSettleUnderCents: 5000,
      frictionBudget: { modelFloor: 'auto' as const },
    }
    const counterpartyWarrant = {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
      autoSettleUnderCents: 1000, // Counterparty requires approval for anything >= 1000
      frictionBudget: { modelFloor: 'auto' as const },
    }

    const proposal: any = {
      ...validBase,
      amountCents: 2500, // Owner says AUTO (< 5000), Counterparty says NEEDS_APPROVAL (>= 1000)
      actor: 'owner',
    }

    const decision = decide(ownerWarrant, proposal, {
      reservedCents: 0,
      priorCaptureIds: [],
      counterpartyWarrant,
    })

    expect(decision.gate).toBe('DUAL_TAP')
    expect(decision.clause).toBe(Clause.constitutionConflict)
    expect(decision.detail).toContain('both must agree')
  })

  it('resolves to AUTO when both sheets agree on AUTO', () => {
    const ownerWarrant = {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
      autoSettleUnderCents: 5000,
      frictionBudget: { modelFloor: 'auto' as const },
    }
    const counterpartyWarrant = {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
      autoSettleUnderCents: 5000,
      frictionBudget: { modelFloor: 'auto' as const },
    }

    const proposal: any = {
      ...validBase,
      amountCents: 2000,
      actor: 'owner',
    }

    const decision = decide(ownerWarrant, proposal, {
      reservedCents: 0,
      priorCaptureIds: [],
      counterpartyWarrant,
    })

    expect(decision.gate).toBe('AUTO')
    expect(decision.clause).toBe(Clause.amountAuto)
  })

  it('resolves to DENY when owner denies, regardless of counterparty', () => {
    const ownerWarrant = {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
      perPaymentCeilingCents: 1000, // Ceiling exceeded
    }
    const counterpartyWarrant = {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
      perPaymentCeilingCents: 100_000,
    }

    const proposal: any = {
      ...validBase,
      amountCents: 5000,
      actor: 'owner',
    }

    const decision = decide(ownerWarrant, proposal, {
      reservedCents: 0,
      priorCaptureIds: [],
      counterpartyWarrant,
    })

    expect(decision.gate).toBe('DENY')
    expect(decision.clause).toBe(Clause.amountCeiling)
  })
})
