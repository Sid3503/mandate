import { payableIn } from './money'
import { fundedPhase } from './phases'
import type { RiskSignal } from './risk'
import { isLookalike } from './risk'
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
  refundUnfunds: 'refund.unfunds',
  capMonthly: 'cap.monthly',
  amountAuto: 'amount.auto',
  amountNeedsApproval: 'amount.needs_approval',
  cartImmutable: 'cart.immutable',
  jobMissing: 'job.missing',
  fundingMissing: 'funding.missing',
  fundingJobMismatch: 'funding.job_mismatch',
  fundingExceeds: 'funding.exceeds',
  fundingDisputed: 'funding.disputed',
  fundingClearing: 'funding.clearing',
  standingMatched: 'standing.matched',
  standingBilling: 'standing.billing',
  dealUnknown: 'deal.unknown',
  dealRequired: 'deal.required',
  dealJobMismatch: 'deal.job_mismatch',
  dealPartyMismatch: 'deal.party_mismatch',
  dealMilestoneUnknown: 'deal.milestone_unknown',
  dealMilestoneMismatch: 'deal.milestone_mismatch',
  dealMilestoneBilled: 'deal.milestone_billed',
  duplicateOpen: 'duplicate.open',
  systemPaused: 'system.paused',
  riskVelocity: 'risk.velocity',
  riskNewEvidenceHost: 'risk.new_evidence_host',
  riskPayeeImpersonation: 'risk.payee_impersonation',
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
  /** Contractor cents already locked or paid from this client payment. A refund that drops the share below this cannot go by itself. */
  payoutCommittedCents?: number
  currency: string
  category: string
  evidenceUrl: string | null
  phase: string
}

/** A settled client charge that a contractor payout cites as its source of money. */
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
  /** Cents of this client payment already promised to the payee now being paid. A standing rule with its own share checks this. */
  payeeHeldCents?: number
  /** PayPal has an open dispute on this client payment. Money that may be taken back is not spent. */
  disputed?: boolean
  /** When this client payment settled, from the ledger. Null when it is not known. */
  settledAt?: string | null
}

/** What the gate needs to know about the deal a charge bills, resolved by the service from the database. */
export type DealContext = {
  /** The agreed deal named by the charge, or null when it names none or an unknown one. */
  agreed: { id: string; jobId: string; buyerId: string; milestoneCents: number[] } | null
  /** True when the charge's job already has an agreed deal, so every charge on it must cite that deal. */
  jobHasDeal: boolean
  /** True when the named milestone already has a live charge. */
  milestoneBilled: boolean
  /** True when the client's agent accepted a delivery whose proof is exactly the proof on this charge. */
  accepted?: boolean
}

export type GateSafety = {
  paused: boolean
  reason?: string | null
  since?: string | null
  by?: 'owner' | 'breaker' | null
  epoch?: number
  autopilotPaused?: boolean
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
  /** An open request that already asks for this same money, resolved by the service from the database. */
  openDuplicate?: { id: string } | null
  safety?: GateSafety | null
  actor?: string
  /** The payee exactly as the caller wrote it, before resolution. The lookalike check reads the raw words. */
  rawPayee?: string | null
  /** A risk signal gathered by the service from the ledger. It may only add friction to an automatic decision. */
  risk?: RiskSignal | null
}

/** Cents a settled client charge can still fund for contractors under the share rule. */
export function fundableCents(warrant: WarrantBody, funding: FundingCharge): number {
  const net = Math.max(0, funding.capturedCents - funding.refundHeldCents)
  return Math.max(0, Math.floor((net * warrant.contractorShareBps) / 10_000) - funding.payoutHeldCents)
}

/**
 * A refund of client money that has already funded a contractor. PayPal will not pull a sent payout back, so the
 * studio would be short by the difference. The owner may still refund. A rule, an agent, or the automatic line may not.
 */
export function refundUnfunds(
  warrant: WarrantBody,
  parent: { amountCents: number; heldCents: number; payoutCommittedCents?: number },
  refundCents: number,
): { leftCents: number; shareCents: number; shortCents: number } | null {
  const committed = parent.payoutCommittedCents ?? 0
  if (committed <= 0) return null
  const leftCents = Math.max(0, parent.amountCents - parent.heldCents - refundCents)
  const shareCents = Math.floor((leftCents * warrant.contractorShareBps) / 10_000)
  if (committed <= shareCents) return null
  return { leftCents, shareCents, shortCents: committed - shareCents }
}

/**
 * The arithmetic behind a `funding.exceeds` refusal, in one sentence, so the gate, the page and the receipt all
 * say the numbers the same way. The share is taken of what PayPal reported arrived, not of what was invoiced: a
 * client who paid less can fund less, and a client who paid in full can fund the whole share.
 */
export function fundingArithmetic(warrant: WarrantBody, funding: FundingCharge, captureId: string | null, askedCents: number): string {
  const net = Math.max(0, funding.capturedCents - funding.refundHeldCents)
  const shareOf = Math.max(0, Math.floor((net * warrant.contractorShareBps) / 10_000))
  const left = Math.max(0, shareOf - funding.payoutHeldCents)
  return `client payment ${captureId ?? 'none'} settled ${net} cents; at a ${warrant.contractorShareBps / 100}% contractor share that is ${shareOf} cents, of which ${funding.payoutHeldCents} is already committed, so ${left} more cents is left; ${askedCents} cents was asked`
}

export type GateContext = {
  reservedCents: number
  priorCaptureIds: string[]
  /** The time the request is judged at, in milliseconds. The gate has no clock of its own. */
  nowMs?: number
}

const DAY_MS = 86_400_000

/**
 * Has this client payment cleared? Money a client can still take back (a chargeback, a dispute that has not opened yet)
 * is not paid out by a rule until it has been settled for `clearingDays`. With no clock, or no known settle time, it
 * has not cleared: the gate fails closed.
 */
export function clearingState(warrant: { clearingDays?: number }, funding: { settledAt?: string | null }, nowMs: number | undefined): { pending: boolean; clearsAt: string | null } {
  const days = warrant.clearingDays ?? 0
  if (days <= 0) return { pending: false, clearsAt: null }
  const settled = funding.settledAt ? Date.parse(funding.settledAt) : Number.NaN
  if (!Number.isFinite(settled) || nowMs === undefined) return { pending: true, clearsAt: null }
  const clears = settled + days * DAY_MS
  return { pending: nowMs < clears, clearsAt: new Date(clears).toISOString() }
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

function evaluateProposal(warrant: WarrantBody, proposal: GateProposal, context: GateContext): Decision {
  if (!Number.isInteger(proposal.amountCents) || proposal.amountCents <= 0) {
    return deny(Clause.shapeInvalid, 'amount must be a positive integer number of cents')
  }
  if (!proposal.payeeId) {
    // A name that resolves to nobody is refused either way. With the lookalike check on, the refusal names the
    // attempt instead of shrugging "unknown" - the one place a risk feature sharpens a refusal rather than
    // escalating a decision. The class never changes: refused is refused, PayPal is never called either way.
    if (proposal.rawPayee && isLookalike(proposal.rawPayee, warrant)) {
      return deny(Clause.riskPayeeImpersonation, `the name given ("${proposal.rawPayee.trim()}") is not on the rules, and it shares words with a party who is without matching any of them exactly, which is what a lookalike vendor looks like`)
    }
    return deny(Clause.payeeUnknown, proposal.kind === 'charge' ? 'client is not on the warrant' : 'payee is not on the warrant')
  }
  if (!proposal.category || !warrant.categories.includes(proposal.category)) {
    return deny(Clause.categoryMissing, 'category is not on the warrant')
  }
  if (proposal.currency !== warrant.currency) {
    return deny(Clause.currencyMismatch, `currency must be ${warrant.currency}`)
  }
  if (!payableIn(proposal.amountCents, proposal.currency)) {
    return deny(Clause.currencyMismatch, `${proposal.currency} is paid in whole units only, with no decimals`)
  }
  if (proposal.kind === 'refund') {
    const parent = proposal.parent
    if (!parent || !fundedPhase(parent.phase) || parent.payeeId !== proposal.payeeId || parent.currency !== proposal.currency) {
      return deny(Clause.refundUnlinked, 'refund must cite a client payment that has settled, for the same payee')
    }
    if (parent.category !== proposal.category) {
      return deny(Clause.categoryMissing, 'refund category must match the captured payment')
    }
    const remaining = parent.amountCents - parent.heldCents
    if (proposal.amountCents > remaining) {
      return deny(Clause.refundExceeds, `refund exceeds the ${remaining} cents still available on the capture`)
    }
    const hole = refundUnfunds(warrant, parent, proposal.amountCents)
    if (hole) {
      return {
        gate: 'NEEDS_APPROVAL',
        clause: Clause.refundUnfunds,
        detail: `refunding ${proposal.amountCents} cents would leave ${hole.leftCents} cents settled, which funds ${hole.shareCents} cents at the contractor share, but ${parent.payoutCommittedCents} cents is already committed to a contractor, so the studio would be short ${hole.shortCents} cents. PayPal cannot pull that payout back. A rule cannot send this refund. The owner can.`,
      }
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
  // Deliberately after the validity and identity checks, and before the money rules. An open ask has already
  // reserved its share (`funding.exceeds`) and its month (`cap.monthly`), so checked any later this would
  // surface as an arithmetic refusal instead of "you already asked for this".
  if (proposal.openDuplicate) {
    return deny(Clause.duplicateOpen, `a ${proposal.kind} of ${proposal.amountCents} ${proposal.currency} cents was already asked for by proposal ${proposal.openDuplicate.id}, which is still open`)
  }
  if (proposal.kind === 'payment' && warrant.fundingRequired) {
    const funding = proposal.funding ?? null
    if (!proposal.fundingCaptureId || !funding || funding.kind !== 'charge' || !fundedPhase(funding.phase)) {
      return deny(Clause.fundingMissing, 'a contractor payout must cite a client payment that has settled')
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
      return deny(Clause.fundingExceeds, fundingArithmetic(warrant, funding, proposal.fundingCaptureId ?? null, proposal.amountCents))
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
  const billing = matchBilling(warrant, proposal)
  if (billing) {
    return {
      gate: 'AUTO',
      clause: Clause.standingBilling,
      detail: 'covered by the owner\'s rule to bill signed-deal milestones when proof is attached: the client, the amount and the milestone are exactly what the deal says, and it has not been billed before, so no tap is needed',
    }
  }
  // A payout that would go with no tap waits while the client's money could still be taken back. Only the owner's own tap sends it early.
  const clearing = proposal.kind === 'payment' && proposal.funding ? clearingState(warrant, proposal.funding, context.nowMs) : null
  const holdForClearing = (): Decision => ({
    gate: 'NEEDS_APPROVAL',
    clause: Clause.fundingClearing,
    detail: `the client's payment is still clearing${clearing?.clearsAt ? ` until ${clearing.clearsAt.slice(0, 10)}` : ''} (${warrant.clearingDays} day${warrant.clearingDays === 1 ? '' : 's'} after it settled), so no rule sends this on its own. You can still approve it yourself.`,
  })
  const standing = matchStanding(warrant, proposal)
  if (standing && clearing?.pending) return holdForClearing()
  if (standing) {
    return {
      gate: 'AUTO',
      clause: Clause.standingMatched,
      detail: `covered by the owner's standing rule ${standing.id}: paid from settled ${standing.requireDeal ? 'signed-deal ' : ''}client money, within the contractor share and the monthly cap, so no tap is needed`,
    }
  }
  if (proposal.amountCents < warrant.autoSettleUnderCents && clearing?.pending) return holdForClearing()
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

export function decide(warrant: WarrantBody, proposal: GateProposal, context: GateContext): Decision {
  const judged = evaluateProposal(warrant, proposal, context)
  // The risk engine's one move: a decision the rules were about to make on their own (AUTO) needs a tap after all.
  // It never touches a refusal, never lowers a tap, and applies to every actor, the owner included - a second look
  // is cheap, and "AI may only add friction" has no exception for who asked.
  const result = judged.gate === 'AUTO' && proposal.risk?.escalate
    ? {
        gate: 'NEEDS_APPROVAL' as const,
        clause: proposal.risk.code,
        detail: `the rules would have sent this with no tap, but the risk engine adds friction: ${proposal.risk.detail}`,
      }
    : judged
  if (proposal.safety?.autopilotPaused && (proposal.actor ?? 'proposer') === 'autopilot' && result.gate !== 'DENY') {
    return {
      gate: 'DENY',
      clause: Clause.systemPaused,
      detail: 'Autopilot is paused: automatic billing and payouts are stopped until resumed',
    }
  }
  if (proposal.safety?.paused && result.gate !== 'DENY') {
    const why = proposal.safety.reason ? ` (${proposal.safety.reason})` : ''
    const actor = proposal.actor ?? 'proposer'
    if (actor !== 'owner') {
      return {
        gate: 'DENY',
        clause: Clause.systemPaused,
        detail: `Mandate is paused${why}, so nothing automatic runs and no agent is served until the owner resumes it`,
      }
    }
    if (result.gate === 'AUTO') {
      return {
        gate: 'NEEDS_APPROVAL',
        clause: Clause.systemPaused,
        detail: `Mandate is paused${why}: nothing goes without the owner's tap`,
      }
    }
  }
  return result
}

/** The standing rule that covers this payout, or null. The other checks have already passed by the time this is asked. */
export function matchStanding(warrant: WarrantBody, proposal: GateProposal) {
  if (proposal.kind !== 'payment' || !warrant.fundingRequired || !proposal.payeeId) return null
  const funding = proposal.funding
  if (!funding || !funding.clientId) return null
  return warrant.standing.find((rule) => {
    if (rule.payeeId !== proposal.payeeId || !rule.clientIds.includes(funding.clientId!)) return false
    if (rule.requireDeal && !funding.dealId) return false
    // A rule with its own share covers only that share of the client payment, less what this payee was already promised.
    if (rule.shareBps !== undefined) {
      const net = Math.max(0, funding.capturedCents - funding.refundHeldCents)
      const left = Math.floor((net * rule.shareBps) / 10_000) - (funding.payeeHeldCents ?? 0)
      if (proposal.amountCents > left) return false
    }
    return true
  }) ?? null
}

/**
 * A charge that bills a milestone of a signed deal. By the time this is asked the deal checks have already passed:
 * the deal exists and was agreed, the client is the deal's client, the amount is exactly the milestone's, and the
 * milestone has not been billed. All the owner's switch adds is "no tap".
 */
export function matchBilling(warrant: WarrantBody, proposal: GateProposal): boolean {
  return proposal.kind === 'charge'
    && warrant.automation.billSignedDeals
    && Boolean(proposal.dealId)
    && proposal.milestone !== null && proposal.milestone !== undefined
    && Boolean(proposal.deal?.agreed)
    && (!warrant.automation.requireAcceptance || proposal.deal?.accepted === true)
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
