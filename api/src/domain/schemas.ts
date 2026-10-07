import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

export const PayeeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  displayName: z.string().trim().min(1).max(120),
  email: z.email().max(200),
  aliases: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
}).strict()

/**
 * A standing rule: the owner says yes once to a whole kind of payout. A contractor payout that matches it needs no
 * tap. It still has to pass every other rule (funding, share, cap, proof, dispute hold), and the lock is still signed.
 */
export const StandingRuleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  payeeId: z.string().min(1).max(64),
  /** The client payments that may fund it. */
  clientIds: z.array(z.string().min(1).max(64)).min(1).max(20),
  /** Only client money that came through a signed deal. */
  requireDeal: z.boolean().default(true),
  /** This payee's share of a client payment, in basis points. Omitted means the whole contractor share. */
  shareBps: z.number().int().min(1).max(10_000).optional(),
}).strict()

/**
 * What the server may do without being asked, once the owner has signed it. Each switch only removes a tap or a
 * nudge; none of them widens what a payment may be.
 */
export const AutomationSchema = z.object({
  /** A milestone of a signed deal is billed, and its invoice sent, as soon as proof of the work is attached. */
  billSignedDeals: z.boolean().default(false),
  /** Bill only after the client's own agent has accepted the delivery. Without its acceptance a bill still needs the owner's tap. */
  requireAcceptance: z.boolean().default(false),
  /** When a client payment settles, the server asks to pay each contractor whose standing rule covers it. */
  payOnSettle: z.boolean().default(false),
  /** Send PayPal's own reminder for an invoice that is still unpaid after this many days. */
  remindUnpaidAfterDays: z.number().int().min(1).max(60).nullable().default(null),
  /** The most reminders sent for one invoice. */
  maxReminders: z.number().int().min(0).max(5).default(2),
}).strict()

export type Automation = z.infer<typeof AutomationSchema>
export const NO_AUTOMATION: Automation = { billSignedDeals: false, requireAcceptance: false, payOnSettle: false, remindUnpaidAfterDays: null, maxReminders: 2 }

export const WarrantBodySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  autoSettleUnderCents: z.number().int().positive().max(100_000_000),
  monthlyCapCents: z.number().int().positive().max(100_000_000),
  perPaymentCeilingCents: z.number().int().positive().max(100_000_000),
  evidenceRequired: z.boolean(),
  timezone: z.string().trim().min(1).max(64),
  payees: z.array(PayeeSchema).min(1).max(100),
  categories: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).min(1).max(50),
  clients: z.array(PayeeSchema).max(100).default([]),
  fundingRequired: z.boolean().default(false),
  contractorShareBps: z.number().int().min(0).max(10_000).default(10_000),
  standing: z.array(StandingRuleSchema).max(20).default([]),
  automation: AutomationSchema.default(NO_AUTOMATION),
}).strict().superRefine((warrant, ctx) => {
  if (warrant.autoSettleUnderCents > warrant.perPaymentCeilingCents) {
    ctx.addIssue({ code: 'custom', path: ['autoSettleUnderCents'], message: 'auto settle must be at or under the per-payment ceiling' })
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: warrant.timezone })
  } catch {
    ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'unknown IANA timezone' })
  }
  const payeeIds = new Set<string>()
  warrant.payees.forEach((payee, index) => {
    if (payeeIds.has(payee.id)) ctx.addIssue({ code: 'custom', path: ['payees', index, 'id'], message: 'duplicate payee id' })
    payeeIds.add(payee.id)
  })
  warrant.clients.forEach((client, index) => {
    if (payeeIds.has(client.id)) ctx.addIssue({ code: 'custom', path: ['clients', index, 'id'], message: 'duplicate party id' })
    payeeIds.add(client.id)
  })
  const standingIds = new Set<string>()
  warrant.standing.forEach((rule, index) => {
    if (standingIds.has(rule.id)) ctx.addIssue({ code: 'custom', path: ['standing', index, 'id'], message: 'duplicate standing rule id' })
    standingIds.add(rule.id)
    if (!warrant.payees.some((payee) => payee.id === rule.payeeId)) ctx.addIssue({ code: 'custom', path: ['standing', index, 'payeeId'], message: 'a standing rule must name a payee on the rules' })
    rule.clientIds.forEach((clientId, at) => {
      if (!warrant.clients.some((client) => client.id === clientId)) ctx.addIssue({ code: 'custom', path: ['standing', index, 'clientIds', at], message: 'a standing rule must name clients on the rules' })
    })
    if (!warrant.fundingRequired) ctx.addIssue({ code: 'custom', path: ['standing', index], message: 'standing rules need "payouts need client money first" switched on' })
  })
  if (warrant.automation.requireAcceptance && !warrant.automation.billSignedDeals) {
    ctx.addIssue({ code: 'custom', path: ['automation', 'requireAcceptance'], message: 'requiring the client\'s acceptance only means something when billing signed deals is switched on' })
  }
  if (warrant.automation.payOnSettle && warrant.standing.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['automation', 'payOnSettle'], message: 'paying on settle needs at least one standing rule to say whom to pay' })
  }
  // Contractors paid out of one client's money can never be promised more than the contractor share in total.
  for (const client of warrant.clients) {
    const promised = warrant.standing.filter((rule) => rule.clientIds.includes(client.id)).reduce((sum, rule) => sum + (rule.shareBps ?? warrant.contractorShareBps), 0)
    if (promised > warrant.contractorShareBps) {
      ctx.addIssue({ code: 'custom', path: ['standing'], message: `standing rules promise ${promised / 100}% of ${client.displayName}'s payments, but contractors may receive at most ${warrant.contractorShareBps / 100}%. Give each rule its own share.` })
    }
  }
  const categories = new Set<string>()
  warrant.categories.forEach((category, index) => {
    if (categories.has(category)) ctx.addIssue({ code: 'custom', path: ['categories', index], message: 'duplicate category' })
    categories.add(category)
  })
})

export type WarrantBody = z.infer<typeof WarrantBodySchema>
export type Payee = z.infer<typeof PayeeSchema>

export const ProposalCreateSchema = z.object({
  kind: z.enum(['payment', 'charge', 'refund']).default('payment'),
  payee: z.string().trim().min(1).max(200),
  amountCents: z.number().int().positive().max(100_000_000),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).refine((value) => /^[A-Z]{3}$/.test(value)),
  category: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().min(1).max(500),
  evidenceUrl: z.string().trim().max(2000).optional(),
  prompt: z.string().trim().max(4000).optional(),
  parentCaptureId: z.string().trim().min(1).max(64).optional(),
  jobId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  fundingCaptureId: z.string().trim().min(1).max(64).optional(),
  /** Bill one milestone of an agreed deal. The amount must equal the milestone. */
  dealId: z.uuid().optional(),
  milestone: z.number().int().min(0).max(11).optional(),
  proposalId: z.uuid().optional(),
}).strict().refine((value) => (value.dealId === undefined) === (value.milestone === undefined), {
  message: 'dealId and milestone go together',
  path: ['milestone'],
})

export type ProposalCreate = z.infer<typeof ProposalCreateSchema>

export const CaptureSchema = z.object({
  claimedAmountCents: z.number().int().positive().max(100_000_000).optional(),
}).strict()

export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
})

export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._~:-]{8,255}$/)

export const LINE_STUDIO_WARRANT: WarrantBody = {
  currency: 'USD',
  autoSettleUnderCents: 2000,
  monthlyCapCents: 18000,
  perPaymentCeilingCents: 50000,
  evidenceRequired: true,
  timezone: 'Asia/Kolkata',
  payees: [{
    id: 'payee_priya',
    displayName: 'Priya Shah',
    email: 'priya.shah@example.com',
    aliases: ['Priya', 'priya'],
  }],
  categories: ['design', 'production'],
  clients: [{
    id: 'client_northwind',
    displayName: 'Northwind',
    email: 'ap@northwind.example',
    aliases: ['Northwind', 'northwind'],
  }],
  standing: [],
  automation: NO_AUTOMATION,
  fundingRequired: true,
  contractorShareBps: 6000,
}

export const DEMO_JOB_ID = 'job_northwind_logo'

export const WARRANT_ID = 'wnt_line_studio'
