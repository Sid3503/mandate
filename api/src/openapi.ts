import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { BillMilestoneSchema, DealOfferSchema, PartyRulesSchema } from './domain/deal'
import { CaptureSchema, ListQuerySchema, ProposalCreateSchema, WarrantBodySchema } from './domain/schemas'

const HealthSchema = z.object({
  status: z.enum(['pass', 'fail', 'warn']),
  version: z.string(),
  serviceId: z.string(),
  description: z.string(),
  checks: z.record(z.string(), z.array(z.object({
    status: z.enum(['pass', 'fail', 'warn']),
    componentType: z.string(),
    time: z.string(),
    observedValue: z.string().optional(),
  }))),
}).openapi('Health')

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string().optional(),
  code: z.string(),
  requestId: z.string().optional(),
}).passthrough().openapi('Problem')

const ProposalSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['payment', 'charge', 'refund']),
  gate: z.enum(['DENY', 'AUTO', 'NEEDS_APPROVAL']),
  clause: z.string(),
  detail: z.string(),
  phase: z.string(),
  payeeId: z.string().nullable(),
  amountCents: z.number().int(),
  currency: z.string(),
  category: z.string().nullable(),
  description: z.string(),
  evidenceUrl: z.string().nullable(),
  prompt: z.string().nullable(),
  parentCaptureId: z.string().nullable(),
  jobId: z.string().nullable(),
  fundingCaptureId: z.string().nullable(),
  warrantId: z.string(),
  warrantVersion: z.number().int(),
  cartHash: z.string().nullable(),
  orderId: z.string().nullable(),
  captureId: z.string().nullable(),
  refundId: z.string().nullable(),
  approveUrl: z.string().nullable(),
  capturedAmountCents: z.number().int().nullable(),
  payoutBatchId: z.string().nullable(),
  payoutItemId: z.string().nullable(),
  payoutStatus: z.string().nullable(),
  payoutTransactionId: z.string().nullable(),
  payoutFeeCents: z.number().int().nullable(),
  dealId: z.string().nullable(),
  milestone: z.number().int().nullable(),
  lockSignature: z.string().nullable(),
  lockKeyId: z.string().nullable(),
  invoiceId: z.string().nullable(),
  invoiceUrl: z.string().nullable(),
  invoiceStatus: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi('Proposal')

const WarrantViewSchema = WarrantBodySchema.extend({
  id: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
}).openapi('Warrant')

const DealSchema = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  buyerId: z.string(),
  buyerName: z.string(),
  sellerId: z.string(),
  offeredBy: z.string(),
  status: z.enum(['agreed', 'refused']),
  jobId: z.string().nullable(),
  terms: z.object({
    scope: z.string(),
    category: z.string(),
    currency: z.string(),
    totalCents: z.number().int(),
    milestones: z.array(z.object({ title: z.string(), amountCents: z.number().int() })),
    dueDate: z.string().optional(),
    proofRequired: z.boolean(),
  }),
  termsHash: z.string(),
  rulesVersions: z.object({ buyer: z.number().int(), seller: z.number().int() }),
  signature: z.string().nullable(),
  keyId: z.string().nullable(),
  prompt: z.string().nullable(),
  runId: z.string().nullable(),
  createdAt: z.string(),
  verdict: z.object({
    verdict: z.enum(['ACCEPT', 'REFUSE']),
    violations: z.array(z.object({ code: z.string(), side: z.string(), detail: z.string(), hint: z.string() })),
    zone: z.object({ minCents: z.number().int(), maxCents: z.number().int() }).nullable().optional(),
  }),
  billing: z.object({
    dealId: z.string(),
    totalCents: z.number().int(),
    scope: z.string(),
    signatureValid: z.boolean(),
    milestones: z.array(z.object({ index: z.number().int(), title: z.string(), amountCents: z.number().int(), chargeId: z.string().nullable(), phase: z.string().nullable(), attempts: z.number().int() })),
  }).nullable(),
}).openapi('Deal')

const SessionSchema = z.object({
  role: z.enum(['owner', 'proposer']),
  side: z.enum(['buyer', 'seller']).nullable(),
  agents: z.object({ enabled: z.boolean(), model: z.string().nullable() }),
  version: z.string(),
  paypalConfigured: z.boolean(),
}).openapi('Session')

const problem = {
  description: 'Problem details (RFC 9457)',
  content: { 'application/problem+json': { schema: ProblemSchema } },
}

const bearer = [{ bearerAuth: [] }]

export function buildOpenApi(publicUrl: string) {
  const registry = new OpenAPIRegistry()
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Studio API key',
  })

  registry.registerPath({
    method: 'get',
    path: '/health',
    tags: ['ops'],
    summary: 'Liveness. Does not check dependencies.',
    responses: { 200: { description: 'Process is up', content: { 'application/health+json': { schema: HealthSchema } } } },
  })
  registry.registerPath({
    method: 'get',
    path: '/ready',
    tags: ['ops'],
    summary: 'Readiness. Fails when SQLite cannot be read.',
    responses: {
      200: { description: 'Ready, PayPal credentials may still be a warn check', content: { 'application/health+json': { schema: HealthSchema } } },
      503: { description: 'Not ready', content: { 'application/health+json': { schema: HealthSchema } } },
    },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/warrant',
    tags: ['warrant'],
    security: bearer,
    summary: 'Current spending warrant',
    responses: { 200: { description: 'Warrant', content: { 'application/json': { schema: WarrantViewSchema } } }, 401: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/session',
    tags: ['ops'],
    security: bearer,
    summary: 'Which key is this: owner or proposer.',
    responses: { 200: { description: 'Session', content: { 'application/json': { schema: SessionSchema } } }, 401: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/warrant/versions',
    tags: ['warrant'],
    security: bearer,
    summary: 'Every warrant version, newest first.',
    responses: { 200: { description: 'Versions', content: { 'application/json': { schema: z.object({ data: z.array(WarrantViewSchema) }) } } }, 401: problem },
  })
  registry.registerPath({
    method: 'put',
    path: '/v1/warrant',
    tags: ['warrant'],
    security: bearer,
    summary: 'Owner only. Write the next warrant version. In-flight proposals keep the version they were decided against.',
    request: { body: { content: { 'application/json': { schema: WarrantBodySchema } } } },
    responses: { 201: { description: 'Stored', content: { 'application/json': { schema: WarrantViewSchema } } }, 400: problem, 401: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/proposals',
    tags: ['proposals'],
    security: bearer,
    summary: 'Propose a client charge (money in), a contractor payment (money out), or a refund. A payment must cite a captured client charge on the same job. The gate decides. This never captures.',
    request: {
      headers: z.object({ 'Idempotency-Key': z.string().min(8) }),
      body: { content: { 'application/json': { schema: ProposalCreateSchema } } },
    },
    responses: {
      201: { description: 'Proposal recorded. gate DENY is still 201 and has no order id.', content: { 'application/json': { schema: ProposalSchema } } },
      400: problem,
      401: problem,
      409: problem,
      422: problem,
    },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/proposals',
    tags: ['proposals'],
    security: bearer,
    request: { query: ListQuerySchema },
    responses: { 200: { description: 'Page' }, 401: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/proposals/{id}',
    tags: ['proposals'],
    security: bearer,
    request: { params: z.object({ id: z.uuid() }) },
    responses: { 200: { description: 'Proposal', content: { 'application/json': { schema: ProposalSchema } } }, 401: problem, 404: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/proposals/{id}/packet',
    tags: ['ledger'],
    security: bearer,
    summary: 'Dispute packet: prompt, clause, approval, hash, order id, capture id.',
    request: { params: z.object({ id: z.uuid() }) },
    responses: { 200: { description: 'Packet' }, 401: problem, 404: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/proposals/{id}/approve',
    tags: ['proposals'],
    security: bearer,
    summary: 'Owner only. Owner tap. Locks payee, amount, currency, category, and evidence. Body must be empty.',
    request: { params: z.object({ id: z.uuid() }) },
    responses: { 200: { description: 'Locked', content: { 'application/json': { schema: ProposalSchema } } }, 401: problem, 403: problem, 409: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/proposals/{id}/reject',
    tags: ['proposals'],
    security: bearer,
    summary: 'Owner only. Reject a pending proposal, or cancel a locked payout before anything has been sent to PayPal.',
    request: { params: z.object({ id: z.uuid() }) },
    responses: { 200: { description: 'Rejected' }, 401: problem, 403: problem, 409: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/proposals/{id}/capture',
    tags: ['proposals'],
    security: bearer,
    summary: 'Owner only. Settle from the lock: an Orders capture for a client charge, a Payouts item for a contractor payout, a refund for a refund. Calling it again on a payout still at PayPal re-reads its status. Amount in the body is a claim, never the amount sent to PayPal. A different claim is refused.',
    request: {
      params: z.object({ id: z.uuid() }),
      body: { content: { 'application/json': { schema: CaptureSchema } }, required: false },
    },
    responses: { 200: { description: 'Captured or replayed' }, 401: problem, 403: problem, 409: problem, 502: problem, 503: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/webhooks/paypal',
    tags: ['proposals'],
    summary: 'PayPal payout webhook. No credential. The body only names a payout batch; the batch is re-read from PayPal, so a forged call cannot change a status.',
    responses: { 200: { description: 'Received. refreshed says whether a payout was re-read.' } },
  })
  const idParam = z.object({ id: z.uuid() })
  registry.registerPath({
    method: 'get',
    path: '/v1/proposals/{id}/verify',
    tags: ['proposals'],
    security: bearer,
    summary: 'Re-check a lock: the stored hash still recomputes from the row, and the Ed25519 signature verifies for exactly this id and hash.',
    request: { params: idParam },
    responses: { 200: { description: 'Verification' }, 401: problem, 404: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/.well-known/mandate-keys.json',
    tags: ['ops'],
    summary: 'Public keys the server signs locks and deals with, including retired ones, so old receipts stay verifiable. No credential.',
    responses: { 200: { description: 'Keys' } },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/deals/offers',
    tags: ['deals'],
    security: bearer,
    summary: 'Offer deal terms. Agreed only if the terms fit BOTH companies\' rules. Each side sees its own violations in full and the other side\'s only as a direction. Needs an Idempotency-Key.',
    request: { body: { content: { 'application/json': { schema: DealOfferSchema } }, required: true } },
    responses: { 201: { description: 'The offer and the verdict', content: { 'application/json': { schema: DealSchema } } }, 400: problem, 401: problem, 403: problem, 409: problem, 422: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/deals',
    tags: ['deals'],
    security: bearer,
    summary: 'Recent offers and deals, newest first. A client agent sees only its own.',
    responses: { 200: { description: 'Deals', content: { 'application/json': { schema: z.object({ data: z.array(DealSchema) }) } } }, 401: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/deals/{id}',
    tags: ['deals'],
    security: bearer,
    request: { params: idParam },
    responses: { 200: { description: 'Deal', content: { 'application/json': { schema: DealSchema } } }, 401: problem, 404: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/deals/{id}/verify',
    tags: ['deals'],
    security: bearer,
    summary: 'Re-check an agreed deal\'s signature against its stored terms.',
    request: { params: idParam },
    responses: { 200: { description: 'Verification' }, 401: problem, 404: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/deals/{id}/milestones/{n}/bill',
    tags: ['deals'],
    security: bearer,
    summary: 'Propose a client charge for one milestone of an agreed deal, for exactly its agreed amount. The gate still decides.',
    request: { params: z.object({ id: z.uuid(), n: z.string() }), body: { content: { 'application/json': { schema: BillMilestoneSchema } }, required: true } },
    responses: { 201: { description: 'The charge proposal', content: { 'application/json': { schema: ProposalSchema } } }, 401: problem, 403: problem, 404: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/party-rules',
    tags: ['deals'],
    security: bearer,
    summary: 'Owner only. Both companies\' deal rules. These are private to each company.',
    responses: { 200: { description: 'Rules' }, 401: problem, 403: problem },
  })
  registry.registerPath({
    method: 'put',
    path: '/v1/party-rules/{partyId}',
    tags: ['deals'],
    security: bearer,
    summary: 'Owner only. Write the next version of one company\'s deal rules.',
    request: { params: z.object({ partyId: z.string() }), body: { content: { 'application/json': { schema: PartyRulesSchema } }, required: true } },
    responses: { 201: { description: 'New version' }, 401: problem, 403: problem, 404: problem, 422: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/clerk/messages',
    tags: ['agents'],
    security: bearer,
    summary: 'Talk to the studio clerk. It turns the message into requests to the rules and reports their answer. It can only ask: it cannot approve or pay.',
    request: { body: { content: { 'application/json': { schema: z.object({ message: z.string().max(4000), conversationId: z.uuid().optional() }) } }, required: true } },
    responses: { 200: { description: 'The reply, the rules\' outcomes, and the tools used' }, 401: problem, 403: problem, 429: problem, 502: problem, 503: problem, 504: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/negotiations',
    tags: ['agents'],
    security: bearer,
    summary: 'Owner only. Two agents, one per company, trade offers until the terms fit both companies\' rules or they run out of turns.',
    responses: { 200: { description: 'The turns, each with the deal check\'s verdict' }, 401: problem, 403: problem, 503: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/agent-runs/{id}',
    tags: ['agents'],
    security: bearer,
    summary: 'Owner only. The full trace of one agent run: every model turn, tool call and tool result.',
    request: { params: idParam },
    responses: { 200: { description: 'Run' }, 401: problem, 403: problem, 404: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/mcp',
    tags: ['agents'],
    security: bearer,
    summary: 'Model Context Protocol server (Streamable HTTP, stateless). A studio key gets get_rules, get_jobs, propose, list_ledger, offer_deal and explain; a client agent key gets get_rules, offer_deal and explain. No tool can approve, capture, send or change rules.',
    responses: { 200: { description: 'JSON-RPC response' }, 401: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/jobs/{jobId}',
    tags: ['ledger'],
    security: bearer,
    summary: 'Job receipt: client charges in, contractor payouts out, what each capture can still fund.',
    request: { params: z.object({ jobId: z.string() }) },
    responses: { 200: { description: 'Job' }, 401: problem, 404: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/ledger',
    tags: ['ledger'],
    security: bearer,
    request: { query: ListQuerySchema },
    responses: { 200: { description: 'Append-only events' }, 401: problem },
  })

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Mandate API',
      version: '1.0.0',
      description: 'Spending warrant for a studio agent. The model may propose. Only a locked cart can be captured.',
    },
    servers: [{ url: publicUrl }],
  })
}
