import { clearingState, fundableCents, type FundingCharge } from './gate'
import { fundedPhase } from './phases'
import type { WarrantBody } from './schemas'

/**
 * Blast radius: the most money that can leave, if every proposer is wrong, fooled or hostile.
 *
 * It is a pure function of the signed rules and a few facts read from the ledger. It reuses the gate's own arithmetic
 * (`fundableCents`, `clearingState`, `refundUnfunds`'s inequality), so it cannot drift from what the gate does, and it is
 * an upper bound by construction: where the gate adds a check the bound ignores (the risk engine, a payee's cooling
 * period, a velocity limit), the bound is merely looser, never tighter. `test/blast.test.ts` plays a hostile proposer
 * against the real gate, with random rules and random ledgers, and fails if it ever moves more than this says.
 *
 * Two tiers, because the product has two:
 *  - `alone`: money that moves with nobody pressing anything. Only a standing rule (a payout) and the auto-refund policy
 *    (a refund of a payment the books prove was paid twice) send by themselves.
 *  - `queued`: everything alone can do, plus what the rules lock without anyone's approval (a request under the no-tap
 *    line) that then waits for the owner's own Send. It moves only if the owner presses Send.
 *
 * Billing a client moves money in, not out, so it is not here.
 */

/** A settled client payment, with what the gate needs to know about it. */
export type BlastCharge = FundingCharge & {
  captureId: string
  category: string | null
  /** The books show this capture was paid twice (an open `capture.duplicate` break). */
  duplicate: boolean
}

export type BlastFacts = {
  nowMs: number
  /** Cents of this month's cap that locked, sent or paid payouts already hold. */
  reservedCents: number
  charges: BlastCharge[]
  /** What the auto-refund policy has spent this month. */
  autoRefundUsedCents: number
  /** Mandate is paused: nothing automatic runs and no proposer is served. */
  paused: boolean
  /** Autopilot is paused: a rule's payout waits locked. */
  autopilotPaused: boolean
}

export type Reach = { payoutsCents: number; refundsCents: number; totalCents: number }

export type BlastLine = { id: string; cents: number; words: string }

export type BlastLever = {
  id: string
  /** A sentence the owner could say to the rules drafter to make this change. */
  sentence: string
  /** What the number would be with only this change. Computed by the same function, not estimated. */
  toCents: number
  patch: Partial<WarrantBody>
}

export type BlastRadius = {
  currency: string
  paused: boolean
  /** Nobody presses anything. Worst case over every kind of proposer. */
  alone: Reach
  /** The same, for an AI agent (the friction floor may take it to zero). */
  aloneAgent: Reach
  /** If the owner also presses Send on everything the rules locked without approval. */
  queued: Reach
  queuedAgent: Reach
  monthCapCents: number
  reservedCents: number
  capLeftCents: number
  lines: BlastLine[]
  levers: BlastLever[]
}

const ZERO: Reach = { payoutsCents: 0, refundsCents: 0, totalCents: 0 }
const reach = (payoutsCents: number, refundsCents: number): Reach => ({ payoutsCents, refundsCents, totalCents: payoutsCents + refundsCents })

const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`

function payable(warrant: WarrantBody, facts: BlastFacts, charge: BlastCharge): boolean {
  return charge.kind === 'charge'
    && fundedPhase(charge.phase)
    && charge.currency === warrant.currency
    && !charge.disputed
    && !clearingState(warrant, charge, facts.nowMs).pending
}

/** The most a standing rule can send from this client payment, or 0. */
function standingReach(warrant: WarrantBody, charge: BlastCharge): number {
  if (!warrant.fundingRequired || !charge.clientId) return 0
  const rules = warrant.standing.filter((rule) => rule.clientIds.includes(charge.clientId!) && (!rule.requireDeal || Boolean(charge.dealId)))
  if (rules.length === 0) return 0
  const fundable = fundableCents(warrant, charge)
  if (rules.some((rule) => rule.shareBps === undefined)) return fundable
  const net = Math.max(0, charge.capturedCents - charge.refundHeldCents)
  return Math.min(fundable, rules.reduce((sum, rule) => sum + Math.floor((net * rule.shareBps!) / 10_000), 0))
}

/** Cents of a settled payment that may still be refunded without leaving a contractor short (the gate's own `refundUnfunds` inequality, solved for the refund). */
function refundable(warrant: WarrantBody, charge: BlastCharge): number {
  if (charge.kind !== 'charge' || !fundedPhase(charge.phase) || charge.currency !== warrant.currency) return 0
  if (!charge.clientId || !warrant.clients.some((client) => client.id === charge.clientId)) return 0
  if (!charge.category || !warrant.categories.includes(charge.category)) return 0
  const remaining = Math.max(0, charge.capturedCents - charge.refundHeldCents)
  const committed = charge.payoutHeldCents
  if (committed <= 0) return remaining
  if (warrant.contractorShareBps <= 0) return 0
  const mustStay = Math.ceil((committed * 10_000) / warrant.contractorShareBps)
  return Math.max(0, remaining - mustStay)
}

function reachFor(warrant: WarrantBody, facts: BlastFacts, agent: boolean): { alone: Reach; queued: Reach } {
  if (facts.paused) return { alone: ZERO, queued: ZERO }
  if (agent && warrant.frictionBudget.modelFloor !== 'auto') return { alone: ZERO, queued: ZERO }
  const capLeft = Math.max(0, warrant.monthlyCapCents - facts.reservedCents)
  const underLine = warrant.autoSettleUnderCents >= 2
  const anyone = warrant.payees.length > 0 && warrant.categories.length > 0

  let alonePayouts = 0
  let queuedPayouts = 0
  if (anyone) {
    if (warrant.fundingRequired) {
      let standing = 0
      let either = 0
      for (const charge of facts.charges) {
        if (!payable(warrant, facts, charge)) continue
        const viaRule = standingReach(warrant, charge)
        standing += viaRule
        either += underLine ? fundableCents(warrant, charge) : viaRule
      }
      alonePayouts = Math.min(capLeft, standing)
      queuedPayouts = Math.min(capLeft, either)
    } else {
      queuedPayouts = underLine ? capLeft : 0
    }
  }

  let aloneRefunds = 0
  let queuedRefunds = 0
  if (warrant.clients.length > 0) {
    const policy = warrant.autoRefund
    if (policy.enabled) {
      const duplicates = facts.charges
        .filter((charge) => charge.duplicate && !(charge.disputed && policy.skipDisputed))
        .reduce((sum, charge) => sum + refundable(warrant, charge), 0)
      aloneRefunds = Math.min(Math.max(0, policy.monthlyCapCents - facts.autoRefundUsedCents), duplicates)
    }
    const all = facts.charges.reduce((sum, charge) => sum + refundable(warrant, charge), 0)
    queuedRefunds = underLine ? all : aloneRefunds
  }
  // A paused autopilot does not cancel a rule's payout, it makes it wait locked until someone resumes: the rule's money
  // moves from "alone" to "waits for a person", and the total that could move is unchanged.
  const queued = reach(Math.max(queuedPayouts, alonePayouts), Math.max(queuedRefunds, aloneRefunds))
  const alone = facts.autopilotPaused ? ZERO : reach(alonePayouts, aloneRefunds)
  return { alone, queued }
}

/** The number alone, for the what-if levers. */
const aloneTotal = (warrant: WarrantBody, facts: BlastFacts): number => Math.max(reachFor(warrant, facts, false).alone.totalCents, 0)

export function blastRadius(warrant: WarrantBody, facts: BlastFacts): BlastRadius {
  const staff = reachFor(warrant, facts, false)
  const agent = reachFor(warrant, facts, true)
  const currency = warrant.currency
  const capLeft = Math.max(0, warrant.monthlyCapCents - facts.reservedCents)
  const standingNow = facts.charges.filter((charge) => payable(warrant, facts, charge) && standingReach(warrant, charge) > 0).length

  const lines: BlastLine[] = []
  if (facts.paused) {
    lines.push({ id: 'paused', cents: 0, words: 'Mandate is paused, so nothing runs on its own and nobody who asks is served.' })
  } else {
    lines.push(warrant.standing.length === 0
      ? { id: 'standing', cents: 0, words: 'No standing rule is signed, so no payout goes by itself.' }
      : { id: 'standing', cents: staff.alone.payoutsCents, words: standingNow === 0
          ? 'Standing rules are signed, but no settled client payment can fund one right now.'
          : `Standing rules can send up to ${money(staff.alone.payoutsCents, currency)} from ${standingNow} settled client payment${standingNow === 1 ? '' : 's'}, inside the share and the monthly cap.` })
    lines.push(warrant.autoRefund.enabled
      ? { id: 'autoRefund', cents: staff.alone.refundsCents, words: `The auto-refund policy can send up to ${money(staff.alone.refundsCents, currency)} back, only for payments the books show were paid twice (${money(Math.max(0, warrant.autoRefund.monthlyCapCents - facts.autoRefundUsedCents), currency)} left of its monthly limit).` }
      : { id: 'autoRefund', cents: 0, words: 'The auto-refund policy is off, so no refund goes by itself.' })
    const extra = staff.queued.totalCents - staff.alone.totalCents
    lines.push(warrant.autoSettleUnderCents >= 2
      ? { id: 'queued', cents: extra, words: `Anything under ${money(warrant.autoSettleUnderCents, currency)} is locked without your approval and waits for your Send: up to ${money(extra, currency)} more. It moves only if you press Send.` }
      : { id: 'queued', cents: 0, words: 'No request is locked without your approval.' })
    lines.push({ id: 'cap', cents: capLeft, words: `Payouts of any kind stop at the monthly cap: ${money(warrant.monthlyCapCents, currency)}, of which ${money(facts.reservedCents, currency)} is already spoken for and ${money(capLeft, currency)} is left.` })
    if (warrant.frictionBudget.modelFloor !== 'auto') {
      lines.push({ id: 'agents', cents: 0, words: 'An AI agent can never send anything on its own: the friction floor makes every one of its requests wait for you.' })
    } else if (agent.alone.totalCents > 0) {
      lines.push({ id: 'agents', cents: agent.alone.totalCents, words: 'An AI agent that asks gets the same reach as anyone else, because the friction floor is off.' })
    }
  }

  const levers: BlastLever[] = []
  const now = aloneTotal(warrant, facts)
  const pushLever = (id: string, sentence: string, patch: Partial<WarrantBody>, toCents: number, from = now) => {
    if (toCents < from) levers.push({ id, sentence, patch, toCents })
  }
  if (warrant.frictionBudget.modelFloor === 'auto' && agent.alone.totalCents > 0) {
    pushLever('agents-tap', 'An AI agent must always wait for my tap.', { frictionBudget: { modelFloor: 'needs_approval' } }, 0, agent.alone.totalCents)
  }
  if (warrant.clearingDays < 7) {
    const patch = { clearingDays: 7 }
    pushLever('clearing-7', 'Wait 7 days after a client pays before any rule sends from that money.', patch, aloneTotal({ ...warrant, ...patch }, facts))
  }
  if (warrant.monthlyCapCents >= 2 && capLeft > 0) {
    const half = Math.max(1, Math.floor(warrant.monthlyCapCents / 2))
    const patch = { monthlyCapCents: half }
    pushLever('cap-half', `Cap payouts at ${money(half, currency)} a month.`, patch, aloneTotal({ ...warrant, ...patch }, facts))
  }
  if (warrant.autoRefund.enabled && staff.alone.refundsCents > 0) {
    const patch = { autoRefund: { ...warrant.autoRefund, enabled: false, maxCents: 0, monthlyCapCents: 0 } }
    pushLever('refund-off', 'Turn the auto-refund policy off.', patch, aloneTotal({ ...warrant, ...patch }, facts))
  }

  return {
    currency,
    paused: facts.paused,
    alone: staff.alone,
    aloneAgent: agent.alone,
    queued: staff.queued,
    queuedAgent: agent.queued,
    monthCapCents: warrant.monthlyCapCents,
    reservedCents: facts.reservedCents,
    capLeftCents: capLeft,
    lines,
    levers,
  }
}
