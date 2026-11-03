import type { Hono } from 'hono'
import { z } from 'zod'
import type { Services } from '../services/container'
import { invalidRequest, Problem } from './problem'

const DismissSchema = z.object({ note: z.string().trim().min(1).max(500) }).strict()
const FilterSchema = z.object({
  state: z.enum(['open', 'resolved', 'dismissed']).optional(),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
})

/** Accepts an empty body or `{}`. A scan and a fix take no fields: what to do is read from the server. */
async function emptyBody(c: { req: { text: () => Promise<string> } }): Promise<void> {
  const text = (await c.req.text()).trim()
  if (!text) return
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Problem(400, 'request.invalid', 'Request is invalid', 'Body is not JSON.')
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return
  throw new Problem(400, 'request.invalid', 'Request is invalid', 'This action takes no fields.')
}

/**
 * The Breaks desk's routes. All are owner-only (the app's owner gate lists them beside /v1/audit): a break shows where
 * the books and PayPal disagree, and a fix asks the gate or re-reads PayPal. None of them can capture, approve or send.
 */
export function mountBreaks(app: Hono<any>, services: Services): void {
  app.get('/v1/breaks', (c) => {
    const parsed = FilterSchema.safeParse({ state: c.req.query('state') || undefined, severity: c.req.query('severity') || undefined })
    if (!parsed.success) throw invalidRequest(parsed.error)
    return c.json(services.breaks.list(parsed.data))
  })
  // The scan is also what "Reconcile now" runs: it adds PayPal's own transaction list, which lags by hours and is rate limited.
  app.post('/v1/breaks/scan', async (c) => {
    await emptyBody(c)
    return c.json(await services.breaks.scan(undefined, { withPayPal: true }))
  })
  app.get('/v1/breaks/:key', (c) => c.json(services.breaks.get(decodeURIComponent(c.req.param('key')))))
  app.post('/v1/breaks/:key/fix', async (c) => {
    await emptyBody(c)
    return c.json(await services.breaks.fix(decodeURIComponent(c.req.param('key')), 'owner'))
  })
  app.post('/v1/breaks/:key/dismiss', async (c) => {
    const text = (await c.req.text()).trim()
    let body: unknown = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      throw new Problem(400, 'request.invalid', 'Request is invalid', 'Body is not JSON.')
    }
    const parsed = DismissSchema.safeParse(body)
    if (!parsed.success) throw invalidRequest(parsed.error)
    return c.json(services.breaks.dismiss(decodeURIComponent(c.req.param('key')), 'owner', parsed.data.note))
  })
  // Every call to PayPal that can move money for this request, as it was recorded before the call was made.
  app.get('/v1/proposals/:id/attempts', (c) => {
    const id = c.req.param('id')
    if (!services.repo.proposal(id)) throw new Problem(404, 'proposal.missing', 'Proposal not found', 'No proposal matches that id.')
    return c.json({
      data: services.repo.attemptsFor(id).map((attempt) => ({
        id: attempt.id,
        op: attempt.op,
        // Enough of PayPal's request id to find it, never all of it.
        requestIdPrefix: attempt.request_id.slice(0, 8),
        status: attempt.status,
        externalId: attempt.external_id,
        startedAt: attempt.started_at,
        finishedAt: attempt.finished_at,
      })),
    })
  })
}
