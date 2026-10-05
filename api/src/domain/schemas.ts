import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

export const PayeeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  displayName: z.string().trim().min(1).max(120),
  email: z.email().max(200),
  aliases: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
}).strict()

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
  fundingRequired: true,
  contractorShareBps: 6000,
}

export const DEMO_JOB_ID = 'job_northwind_logo'

export const WARRANT_ID = 'wnt_line_studio'
