import type { Hono } from 'hono'
import { z } from 'zod'
import { draftInvoice } from '../agents/invoiceDraft'
import type { AgentModel } from '../agents/model'
import { ProposalCreateSchema } from '../domain/schemas'
import type { ModelBudget } from '../ops/budget'
import type { Services } from '../services/container'
import { INVOICE_STATUSES } from '../services/invoiceDesk'
import type { Principal } from '../services/principal'
import { invalidRequest, Problem } from './problem'

const FilterSchema = z.object({
  status: z.enum(INVOICE_STATUSES as unknown as [string, ...string[]]).optional(),
  q: z.string().trim().max(200).optional(),
  jobId: z.string().trim().max(80).optional(),
})
const DraftSchema = z.object({ notes: z.string().trim().min(1).max(4000) }).strict()

type Ctx = {
  services: Services
  /** The model that may re-read the notes. The deterministic reader runs without it. */
  model: AgentModel | null
  budget: ModelBudget | null
  now: () => Date
}

/** Notes drafts allowed per minute, for the owner. The model routes of the agents are limited the same way. */
const DRAFTS_PER_MINUTE = 8

/**
 * The Invoices desk's routes. Both are owner-only (app.ts lists them in OWNER_ONLY, and each handler checks the
 * principal again, so a mistake in that list cannot open the door). Neither writes a row or calls PayPal for money:
 * the list reads the books, and a draft is a local preview. Asking for the bill is the normal POST /v1/proposals.
 */
export function mountInvoices(app: Hono<any>, ctx: Ctx): void {
  const desk = ctx.services.invoiceDesk
  const recent: number[] = []
  const owner = (c: { get: (key: 'principal') => Principal }) => {
    if (c.get('principal')?.role !== 'owner') throw new Problem(403, 'auth.forbidden', 'Owner key required', 'Only the owner reads the Invoices desk or drafts a bill from notes. An agent or proposer key cannot.')
  }

  app.get('/v1/invoices', async (c) => {
    owner(c)
    const parsed = FilterSchema.safeParse({ status: c.req.query('status') || undefined, q: c.req.query('q') || undefined, jobId: c.req.query('jobId') || undefined })
    if (!parsed.success) throw invalidRequest(parsed.error)
    const { data, counts, kpis } = desk.list(parsed.data as Parameters<typeof desk.list>[0])
    return c.json({ asOf: ctx.now().toISOString(), data, counts, kpis, outlook: await desk.outlook(), guardrails: desk.guardrails() })
  })

  app.post('/v1/invoices/draft', async (c) => {
    owner(c)
    const parsed = DraftSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw invalidRequest(parsed.error)
    const warrant = ctx.services.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written, so there are no clients to bill yet.')
    const nowMs = ctx.now().getTime()
    while (recent.length > 0 && nowMs - recent[0]! >= 60_000) recent.shift()
    if (recent.length >= DRAFTS_PER_MINUTE) throw new Problem(429, 'rate.limited', 'Too many drafts', 'Drafting from notes is limited to protect the model quota. Try again in a minute.')
    recent.push(nowMs)
    // The model is optional and counted against the daily budget. Over budget or no key: the plain rules read the notes.
    const useModel = ctx.model !== null && ctx.budget?.reserve() == null
    const draft = await draftInvoice({
      notes: parsed.data.notes,
      warrant: warrant.body,
      now: ctx.now(),
      model: useModel ? ctx.model : null,
      // The gate's own pure preview: it writes nothing and never reaches PayPal.
      preview: (request) => {
        const verdict = ctx.services.mandate.tryRequest(ProposalCreateSchema.parse(request)).live
        if (!verdict) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
        return verdict
      },
      onUsage: (usage) => ctx.budget?.correct(usage.inputTokens ?? 0, usage.outputTokens ?? 0),
    })
    return c.json({ ...draft, nothingSent: true })
  })
}
