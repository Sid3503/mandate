import { z } from 'zod'

/** The Invoices desk's paths for /openapi.json. Called once from buildOpenApi. */
export function registerInvoicePaths(registry: { registerPath: (path: any) => void }): void {
  const problem = { description: 'Problem details (RFC 9457)', content: { 'application/problem+json': { schema: z.object({ type: z.string(), title: z.string(), status: z.number(), detail: z.string(), code: z.string() }).passthrough() } } }
  const security = [{ bearerAuth: [] }]
  registry.registerPath({
    method: 'get', path: '/v1/invoices', tags: ['invoices'], security,
    summary: 'Owner only. Every client charge read as an invoice, with a derived status (draft, approved, sent, part_paid, paid, overdue, cancelled, declined, reversed), KPIs over all invoices, a projected-cash outlook (PayPal balance, which lags by hours, plus outstanding, minus approved payouts, in due-date buckets; advice, never a guarantee) and the rules that apply to bills in plain English. Filter with ?status=, ?q= and ?jobId=.',
    request: { query: z.object({ status: z.enum(['draft', 'approved', 'sent', 'part_paid', 'paid', 'overdue', 'cancelled', 'declined', 'reversed']).optional(), q: z.string().optional(), jobId: z.string().optional() }) },
    responses: { 200: { description: 'Invoices, counts, KPIs, outlook and guardrails' }, 400: problem, 403: problem },
  })
  registry.registerPath({
    method: 'post', path: '/v1/invoices/draft', tags: ['invoices'], security,
    summary: 'Owner only, rate limited. Turns messy notes into a LOCAL DRAFT of a bill: client, line items, due date, note, what is missing and what the gate would decide. Writes nothing and asks nothing of PayPal. A model may re-read the lines when one is configured and under budget, and every number it returns must be in the notes; otherwise plain rules read them. File the bill with POST /v1/proposals.',
    request: { body: { content: { 'application/json': { schema: z.object({ notes: z.string().min(1).max(4000) }) } } } },
    responses: { 200: { description: 'The draft' }, 400: problem, 403: problem, 404: problem, 429: problem },
  })
}
