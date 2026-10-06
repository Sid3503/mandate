import type { WarrantBody } from './schemas'

export const Clause = {
  shapeInvalid: 'shape.invalid',
  payeeUnknown: 'payee.unknown',
  categoryMissing: 'category.missing',
  currencyMismatch: 'currency.mismatch',
  evidenceMissing: 'evidence.missing',
  amountCeiling: 'amount.ceiling',
  refundUnlinked: 'refund.unlinked',
  refundExceeds: 'refund.exceeds',
  capMonthly: 'cap.monthly',
  amountAuto: 'amount.auto',
  amountNeedsApproval: 'amount.needs_approval',
  cartImmutable: 'cart.immutable',
  jobMissing: 'job.missing',
  fundingMissing: 'funding.missing',
  fundingJobMismatch: 'funding.job_mismatch',
  fundingExceeds: 'funding.exceeds',
  fundingDisputed: 'funding.disputed',
  standingMatched: 'standing.matched',
  dealUnknown: 'deal.unknown',
  dealRequired: 'deal.required',
  dealJobMismatch: 'deal.job_mismatch',
  dealPartyMismatch: 'deal.party_mismatch',
  dealMilestoneUnknown: 'deal.milestone_unknown',
  dealMilestoneMismatch: 'deal.milestone_mismatch',
  dealMilestoneBilled: 'deal.milestone_billed',
} as const

export type GateName = 'DENY' | 'AUTO' | 'NEEDS_APPROVAL'

export type Decision = {
  gate: GateName
  clause: string
  detail: string
}

export type ParentPayment = {
  payeeId: string
  amountCents: number
  heldCents: number
  currency: string
  category: string
  evidenceUrl: string | null
  phase: string
}

/** A captured client charge that a contractor payout cites as its source of money. */
export type FundingCharge = {
  kind: string
  phase: string
  jobId: string | null
  currency: string
  capturedCents: number
  refundHeldCents: number
  payoutHeldCents: number
  /** The client whose payment this is, and the signed deal it belongs to, if any. Standing rules match on these. */
  clientId?: string | null
  dealId?: string | null
  /** PayPal has an open dispute on this client payment. Money that may be taken back is not spent. */
  disputed?: boolean
}

/** What the gate needs to know about the deal a charge bills, resolved by the service from the database. */
export type DealContext = {
  /** The agreed deal named by the charge, or null when it names none or an unknown one. */
  agreed: { id: string; jobId: string; buyerId: string; milestoneCents: number[] } | null
  /** True when the charge's job already has an agreed deal, so every charge on it must cite that deal. */
  jobHasDeal: boolean
  /** True when the named milestone already has a live charge. */
  milestoneBilled: boolean
}

export type GateProposal = {
  kind: 'payment' | 'charge' | 'refund'
  payeeId: string | null
  amountCents: number
  currency: string
  category: string | null
  evidenceUrl: string | null
  parent: ParentPayment | null
  jobId?: string | null
  fundingCaptureId?: string | null
  funding?: FundingCharge | null
  dealId?: string | null
  milestone?: number | null
  deal?: DealContext | null
}

/** Cents a captured client charge can still fund for contractors under the share rule. */
export function fundableCents(warrant: WarrantBody, funding: FundingCharge): number {
  const net = Math.max(0, funding.capturedCents - funding.refundHeldCents)
  return Math.max(0, Math.floor((net * warrant.contractorShareBps) / 10_000) - funding.payoutHeldCents)
}

export type GateContext = {
  reservedCents: number
  priorCaptureIds: string[]
}

function deny(clause: string, detail: string): Decision {
  return { gate: 'DENY', clause, detail }
}

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

export function decide(warrant: WarrantBody, proposal: GateProposal, context: GateContext): Decision {
  if (!Number.isInteger(proposal.amountCents) || proposal.amountCents <= 0) {
    return deny(Clause.shapeInvalid, 'amount must be a positive integer number of cents')
  }
  if (!proposal.payeeId) {
    return deny(Clause.payeeUnknown, proposal.kind === 'charge' ? 'client is not on the warrant' : 'payee is not on the warrant')
  }
  if (!proposal.category || !warrant.categories.includes(proposal.category)) {
    return deny(Clause.categoryMissing, 'category is not on the warrant')
  }
  if (proposal.currency !== warrant.currency) {
    return deny(Clause.currencyMismatch, `currency must be ${warrant.currency}`)
  }
  if (proposal.kind === 'refund') {
    const parent = proposal.parent
    if (!parent || parent.phase !== 'captured' || parent.payeeId !== proposal.payeeId || parent.currency !== proposal.currency) {
      return deny(Clause.refundUnlinked, 'refund must cite a captured payment for the same payee')
    }
    if (parent.category !== proposal.category) {
      return deny(Clause.categoryMissing, 'refund category must match the captured payment')
    }
    const remaining = parent.amountCents - parent.heldCents
    if (proposal.amountCents > remaining) {
      return deny(Clause.refundExceeds, `refund exceeds the ${remaining} cents still available on the capture`)
    }
  }
  if (proposal.kind === 'charge' && !proposal.jobId) {
    return deny(Clause.jobMissing, 'a client charge must name the job it pays for')
  }
  if (proposal.kind === 'charge') {
    const context = proposal.deal
    if (proposal.dealId) {
      const agreed = context?.agreed ?? null
      if (!agreed) return deny(Clause.dealUnknown, 'the deal named by this charge does not exist or was never agreed')
      if (agreed.jobId !== proposal.jobId) return deny(Clause.dealJobMismatch, `the deal belongs to job ${agreed.jobId}`)
      if (agreed.buyerId !== proposal.payeeId) return deny(Clause.dealPartyMismatch, 'the deal was made with a different client')
      const expected = proposal.milestone === null || proposal.milestone === undefined ? undefined : agreed.milestoneCents[proposal.milestone]
      if (expected === undefined) return deny(Clause.dealMilestoneUnknown, 'the deal has no such milestone')
      if (expected !== proposal.amountCents) return deny(Clause.dealMilestoneMismatch, `the deal says this milestone is ${expected} cents`)
      if (context?.milestoneBilled) return deny(Clause.dealMilestoneBilled, 'this milestone has already been billed')
    } else if (context?.jobHasDeal) {
      return deny(Clause.dealRequired, 'this job has an agreed deal, so charges on it must bill one of its milestones')
    }
  }
  if (proposal.kind === 'payment' && warrant.fundingRequired) {
    const funding = proposal.funding ?? null
    if (!proposal.fundingCaptureId || !funding || funding.kind !== 'charge' || funding.phase !== 'captured') {
      return deny(Clause.fundingMissing, 'a contractor payout must cite a captured client payment')
    }
    if (!proposal.jobId || funding.jobId !== proposal.jobId) {
      return deny(Clause.fundingJobMismatch, `the cited client payment belongs to job ${funding.jobId ?? 'none'}`)
    }
    if (funding.currency !== proposal.currency) {
      return deny(Clause.currencyMismatch, 'payout currency must match the client payment')
    }
    if (funding.disputed) {
      return deny(Clause.fundingDisputed, `the client has an open PayPal dispute on payment ${proposal.fundingCaptureId}, so it cannot fund a payout until the dispute is resolved`)
    }
    const available = fundableCents(warrant, funding)
    if (proposal.amountCents > available) {
      return deny(
        Clause.fundingExceeds,
        `client payment ${proposal.fundingCaptureId} can fund ${available} more cents at a ${warrant.contractorShareBps / 100}% contractor share`,
      )
    }
  }
  if (warrant.evidenceRequired && (!proposal.evidenceUrl || !httpsUrl(proposal.evidenceUrl))) {
    return deny(Clause.evidenceMissing, 'an https link to the work is required')
  }
  if (proposal.amountCents > warrant.perPaymentCeilingCents) {
    return deny(Clause.amountCeiling, `amount exceeds the per-payment ceiling of ${warrant.perPaymentCeilingCents} cents`)
  }
  if (proposal.kind === 'payment' && context.reservedCents + proposal.amountCents > warrant.monthlyCapCents) {
    const cited = context.priorCaptureIds.length > 0 ? context.priorCaptureIds.join(', ') : 'none'
    return deny(
      Clause.capMonthly,
      `monthly cap is ${warrant.monthlyCapCents} cents; already reserved ${context.reservedCents} cents; prior captures: ${cited}`,
    )
  }
  const standing = matchStanding(warrant, proposal)
  if (standing) {
    return {
      gate: 'AUTO',
      clause: Clause.standingMatched,
      detail: `covered by the owner's standing rule ${standing.id}: paid from settled ${standing.requireDeal ? 'signed-deal ' : ''}client money, within the contractor share and the monthly cap, so no tap is needed`,
    }
  }
  if (proposal.amountCents < warrant.autoSettleUnderCents) {
    return {
      gate: 'AUTO',
      clause: Clause.amountAuto,
      detail: `under ${warrant.autoSettleUnderCents} cents, so the warrant settles without another tap`,
    }
  }
  return {
    gate: 'NEEDS_APPROVAL',
    clause: Clause.amountNeedsApproval,
    detail: `at or above ${warrant.autoSettleUnderCents} cents, so the owner has to tap`,
  }
}

/** The standing rule that covers this payout, or null. The other checks have already passed by the time this is asked. */
export function matchStanding(warrant: WarrantBody, proposal: GateProposal) {
  if (proposal.kind !== 'payment' || !warrant.fundingRequired || !proposal.payeeId) return null
  const funding = proposal.funding
  if (!funding || !funding.clientId) return null
  return warrant.standing.find((rule) =>
    rule.payeeId === proposal.payeeId
    && rule.clientIds.includes(funding.clientId!)
    && (!rule.requireDeal || Boolean(funding.dealId)),
  ) ?? null
}

export function resolvePayee(warrant: WarrantBody, raw: string) {
  return resolveParty(warrant.payees, raw)
}

export function resolveClient(warrant: WarrantBody, raw: string) {
  return resolveParty(warrant.clients, raw)
}

function resolveParty(parties: WarrantBody['payees'], raw: string) {
  const query = raw.trim().toLowerCase()
  return parties.find((payee) =>
    payee.id.toLowerCase() === query
    || payee.email.toLowerCase() === query
    || payee.displayName.toLowerCase() === query
    || payee.aliases.some((alias) => alias.toLowerCase() === query),
  ) ?? null
}

export function resolveCategory(warrant: WarrantBody, raw: string | undefined): string | null {
  if (!raw) return null
  const query = raw.trim().toLowerCase()
  return warrant.categories.find((category) => category === query) ?? query
}
