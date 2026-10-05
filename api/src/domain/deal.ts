import { z } from 'zod'

/**
 * The deal check: a pure function that answers one question. Do these terms fit inside BOTH owners' rules?
 *
 * Each company writes its own rules once (the buyer's budget, the seller's floor). Agents may say anything to each
 * other, but a deal exists only where the two rule sets overlap. No model is consulted here.
 *
 * Limits are private. An agent is told which rule of its own it broke, with the number. For the other side's rules
 * it is told only that they do not allow the terms, with a direction to move. Negotiators never learn each other's
 * reservation price from a refusal.
 */

export const DealClause = {
  shape: 'deal.shape',
  currency: 'deal.currency',
  categoryBuyer: 'deal.category_buyer',
  categorySeller: 'deal.category_seller',
  overBuyerLimit: 'deal.over_buyer_limit',
  underSellerMinimum: 'deal.under_seller_minimum',
  milestoneTooLarge: 'deal.milestone_too_large',
  milestoneTooSmall: 'deal.milestone_too_small',
  tooManyMilestones: 'deal.too_many_milestones',
  proofRequired: 'deal.proof_required',
  dueDatePast: 'deal.due_date_past',
  threadClosed: 'deal.thread_closed',
  jobTaken: 'deal.job_taken',
} as const

export type Side = 'buyer' | 'seller'

export const MilestoneSchema = z.object({
  title: z.string().trim().min(1).max(120),
  amountCents: z.number().int().positive().max(100_000_000),
}).strict()

export const DealTermsSchema = z.object({
  jobId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  scope: z.string().trim().min(1).max(300),
  category: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  totalCents: z.number().int().positive().max(100_000_000),
  milestones: z.array(MilestoneSchema).min(1).max(12),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  proofRequired: z.boolean().default(true),
}).strict()

export type DealTerms = z.infer<typeof DealTermsSchema>

export const PartyRulesSchema = z.object({
  role: z.enum(['buyer', 'seller']),
  displayName: z.string().trim().min(1).max(120),
  currency: z.string().regex(/^[A-Z]{3}$/),
  categories: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).min(1).max(50),
  maxMilestones: z.number().int().min(1).max(12),
  requireProof: z.boolean(),
  /** Buyer: the most the whole job may cost. */
  maxTotalCents: z.number().int().positive().max(100_000_000).optional(),
  /** Buyer: the most a single milestone may cost. */
  maxMilestoneCents: z.number().int().positive().max(100_000_000).optional(),
  /** Seller: the least the whole job may cost. */
  minTotalCents: z.number().int().positive().max(100_000_000).optional(),
  /** Seller: the least a single milestone may be. */
  minMilestoneCents: z.number().int().positive().max(100_000_000).optional(),
}).strict().superRefine((rules, ctx) => {
  if (rules.role === 'buyer' && rules.maxTotalCents === undefined) {
    ctx.addIssue({ code: 'custom', path: ['maxTotalCents'], message: 'a buyer must set the most a job may cost' })
  }
  if (rules.role === 'seller' && rules.minTotalCents === undefined) {
    ctx.addIssue({ code: 'custom', path: ['minTotalCents'], message: 'a seller must set the least a job may cost' })
  }
})

export type PartyRules = z.infer<typeof PartyRulesSchema>

export type DealViolation = {
  code: string
  /** Whose rule was broken. `terms` means the offer contradicts itself. */
  side: Side | 'terms'
  /** Full detail, including the limit. For the owner. Never sent to the other side's agent. */
  detail: string
  /** Which way to move to fix it, without naming the other side's number. */
  hint: string
}

export type DealVerdict = {
  verdict: 'ACCEPT' | 'REFUSE'
  violations: DealViolation[]
  /** The band both rule sets allow for the total. Owner-only: showing it to an agent would reveal both limits. */
  zone: { minCents: number; maxCents: number } | null
}

const usd = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`

export function checkDeal(terms: DealTerms, buyer: PartyRules, seller: PartyRules, today: string): DealVerdict {
  const violations: DealViolation[] = []
  const add = (code: string, side: DealViolation['side'], detail: string, hint: string) => violations.push({ code, side, detail, hint })

  const sum = terms.milestones.reduce((total, milestone) => total + milestone.amountCents, 0)
  if (sum !== terms.totalCents) {
    add(DealClause.shape, 'terms', `milestones add up to ${usd(sum, terms.currency)} but the total is ${usd(terms.totalCents, terms.currency)}`, 'Make the milestones add up to the total.')
  }
  if (terms.currency !== buyer.currency || terms.currency !== seller.currency) {
    add(DealClause.currency, 'terms', `terms are in ${terms.currency}; the buyer works in ${buyer.currency} and the seller in ${seller.currency}`, `Use ${seller.currency}.`)
  }
  if (!buyer.categories.includes(terms.category)) {
    add(DealClause.categoryBuyer, 'buyer', `the buyer does not buy “${terms.category}” (allowed: ${buyer.categories.join(', ')})`, 'Change the kind of work.')
  }
  if (!seller.categories.includes(terms.category)) {
    add(DealClause.categorySeller, 'seller', `the seller does not sell “${terms.category}” (allowed: ${seller.categories.join(', ')})`, 'Change the kind of work.')
  }
  if (buyer.maxTotalCents !== undefined && terms.totalCents > buyer.maxTotalCents) {
    add(DealClause.overBuyerLimit, 'buyer', `total ${usd(terms.totalCents, terms.currency)} is over the buyer's limit of ${usd(buyer.maxTotalCents, terms.currency)}`, 'Lower the total.')
  }
  if (seller.minTotalCents !== undefined && terms.totalCents < seller.minTotalCents) {
    add(DealClause.underSellerMinimum, 'seller', `total ${usd(terms.totalCents, terms.currency)} is under the seller's minimum of ${usd(seller.minTotalCents, terms.currency)}`, 'Raise the total.')
  }
  const largest = Math.max(...terms.milestones.map((milestone) => milestone.amountCents))
  const smallest = Math.min(...terms.milestones.map((milestone) => milestone.amountCents))
  if (buyer.maxMilestoneCents !== undefined && largest > buyer.maxMilestoneCents) {
    add(DealClause.milestoneTooLarge, 'buyer', `a milestone of ${usd(largest, terms.currency)} is over the buyer's per-milestone limit of ${usd(buyer.maxMilestoneCents, terms.currency)}`, 'Split the work into smaller milestones.')
  }
  if (seller.minMilestoneCents !== undefined && smallest < seller.minMilestoneCents) {
    add(DealClause.milestoneTooSmall, 'seller', `a milestone of ${usd(smallest, terms.currency)} is under the seller's per-milestone minimum of ${usd(seller.minMilestoneCents, terms.currency)}`, 'Use fewer, larger milestones.')
  }
  if (terms.milestones.length > buyer.maxMilestones) {
    add(DealClause.tooManyMilestones, 'buyer', `${terms.milestones.length} milestones is more than the buyer allows (${buyer.maxMilestones})`, 'Use fewer milestones.')
  }
  if (terms.milestones.length > seller.maxMilestones) {
    add(DealClause.tooManyMilestones, 'seller', `${terms.milestones.length} milestones is more than the seller offers (${seller.maxMilestones})`, 'Use fewer milestones.')
  }
  if (!terms.proofRequired && (buyer.requireProof || seller.requireProof)) {
    const side: Side = buyer.requireProof ? 'buyer' : 'seller'
    add(DealClause.proofRequired, side, `the ${side} requires proof of delivery at each milestone`, 'Require a proof link at each milestone.')
  }
  if (terms.dueDate && terms.dueDate < today) {
    add(DealClause.dueDatePast, 'terms', `the due date ${terms.dueDate} has already passed`, 'Choose a date in the future.')
  }

  const minCents = seller.minTotalCents ?? 1
  const maxCents = buyer.maxTotalCents ?? Number.MAX_SAFE_INTEGER
  return {
    verdict: violations.length === 0 ? 'ACCEPT' : 'REFUSE',
    violations,
    zone: minCents <= maxCents ? { minCents, maxCents } : null,
  }
}

export type AgentVerdict = {
  verdict: 'ACCEPT' | 'REFUSE'
  violations: Array<{ code: string; side: Side | 'terms'; detail: string; hint: string }>
}

/** What a negotiating agent may see. Its own rules in full; the other side's only as "not allowed, move this way". */
export function verdictFor(verdict: DealVerdict, as: Side | null): AgentVerdict {
  return {
    verdict: verdict.verdict,
    violations: verdict.violations.map((violation) => {
      if (violation.side === as || violation.side === 'terms') return { code: violation.code, side: violation.side, detail: violation.detail, hint: violation.hint }
      return {
        code: violation.code,
        side: violation.side,
        detail: `The ${violation.side}'s rules do not allow these terms. Their limits are private.`,
        hint: violation.hint,
      }
    }),
  }
}

export const DealOfferSchema = z.object({
  buyer: z.string().trim().min(1).max(200),
  terms: DealTermsSchema,
  /** Which party is making the offer. An agent must say; the owner may leave it out. */
  as: z.enum(['buyer', 'seller']).optional(),
  threadId: z.uuid().optional(),
  prompt: z.string().trim().max(4000).optional(),
}).strict()

export type DealOffer = z.infer<typeof DealOfferSchema>

export const BillMilestoneSchema = z.object({
  evidenceUrl: z.string().trim().max(2000),
  prompt: z.string().trim().max(4000).optional(),
}).strict()

export const DEMO_BUYER_RULES: PartyRules = {
  role: 'buyer',
  displayName: 'Northwind',
  currency: 'USD',
  categories: ['design'],
  maxMilestones: 4,
  requireProof: true,
  maxTotalCents: 40_000,
}

export const DEMO_SELLER_RULES: PartyRules = {
  role: 'seller',
  displayName: 'Line Studio',
  currency: 'USD',
  categories: ['design', 'production'],
  maxMilestones: 4,
  requireProof: true,
  minTotalCents: 25_000,
}

/** Every number in a company's rules that the other side must never learn, in cents. */
export function secretsOf(rules: PartyRules): number[] {
  return [rules.maxTotalCents, rules.maxMilestoneCents, rules.minTotalCents, rules.minMilestoneCents].filter((value): value is number => value !== undefined)
}

/** Removes a company's private numbers from a sentence it is about to say to the other side. */
export function scrubNote(note: string, secretCents: number[]): string {
  let out = note
  for (const cents of secretCents) {
    const dollars = cents / 100
    const forms = new Set([
      String(cents),
      dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      Number.isInteger(dollars) ? dollars.toLocaleString('en-US') : '',
      String(dollars),
    ])
    for (const form of forms) {
      if (!form) continue
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out = out.replace(new RegExp(`(?<![\\d,.])\\$?${escaped}(?!\\d|,\\d|\\.\\d)`, 'g'), '[a number I keep private]')
    }
  }
  return out
}
