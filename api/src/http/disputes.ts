import type { Hono } from 'hono'
import { z } from 'zod'
import type { AgentModel } from '../agents/model'
import { stepBinding } from '../auth/passkeys'
import type { ModelBudget } from '../ops/budget'
import { disputeSendPayload } from '../services/disputes'
import type { Services } from '../services/container'
import type { Principal } from '../services/principal'
import { Problem } from './problem'

const TextSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict()

type Ctx = {
  services: Services
  /** The model that may phrase a draft. The template writes it when absent. */
  model: AgentModel | null
  budget: ModelBudget | null
  /** The app's passkey step-up check (a grant bound to this kind and binding, spent once). */
  requireStep: (c: { req: { header: (name: string) => string | undefined }; get: (key: 'memberId') => string | undefined }, kind: string, binding: string) => void
}

/**
 * The dispute desk's routes. All of them are owner-only (app.ts lists them in OWNER_ONLY, and each handler checks the
 * principal again, so a mistake in that list cannot open the door). Sending needs a passkey grant bound to the dispute
 * and the exact text. An agent or MCP key never reaches any of it.
 */
export function mountDisputes(app: Hono<any>, ctx: Ctx): void {
  const desk = ctx.services.disputes
  desk.model = ctx.model
  desk.budget = ctx.budget
  const owner = (c: { get: (key: 'principal') => Principal }) => {
    if (c.get('principal')?.role !== 'owner') throw new Problem(403, 'auth.forbidden', 'Owner key required', 'Only the owner answers a dispute. An agent or proposer key cannot draft, approve or send.')
  }
  const who = (c: { get: (key: 'memberId') => string | undefined }) => c.get('memberId') ?? 'owner'

  app.get('/v1/disputes', async (c) => {
    owner(c)
    return c.json({ data: await desk.list() })
  })
  app.get('/v1/disputes/:id', async (c) => {
    owner(c)
    return c.json(await desk.detail(c.req.param('id')))
  })
  app.post('/v1/disputes/:id/draft', async (c) => {
    owner(c)
    return c.json(await desk.draft(c.req.param('id'), who(c)), 201)
  })
  app.put('/v1/disputes/:id/draft', async (c) => {
    owner(c)
    const parsed = TextSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Send {"text": "..."} of 1 to 2000 characters.')
    return c.json(desk.edit(c.req.param('id'), parsed.data.text, who(c)), 201)
  })
  app.post('/v1/disputes/:id/send', async (c) => {
    owner(c)
    const id = c.req.param('id')
    const parsed = TextSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Send {"text": "..."}: the exact text you approve.')
    // A sent dispute stays sent: a repeat answers with what went, and asks for no second signature.
    if (!desk.alreadySent(id)) ctx.requireStep(c, 'dispute.send', stepBinding('dispute.send', disputeSendPayload(id, parsed.data.text)))
    const grant = c.req.header('x-mandate-stepup')
    const via = grant ? 'passkey' : c.req.header('x-mandate-demo-tap') === '1' ? 'demo' : 'owner-key'
    const result = await desk.send(id, parsed.data.text, { actor: who(c), via })
    return c.json(result, result.replayed ? 200 : 201)
  })
}
