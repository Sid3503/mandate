import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
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
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi('Proposal')

const WarrantViewSchema = WarrantBodySchema.extend({
  id: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
}).openapi('Warrant')

const SessionSchema = z.object({
  role: z.enum(['owner', 'proposer']),
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
    summary: 'Owner only. Reject a pending proposal.',
    request: { params: z.object({ id: z.uuid() }) },
    responses: { 200: { description: 'Rejected' }, 401: problem, 403: problem, 409: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/proposals/{id}/capture',
    tags: ['proposals'],
    security: bearer,
    summary: 'Owner only. Server capture. Amount in the body is a claim, never the amount sent to PayPal. A different claim is refused.',
    request: {
      params: z.object({ id: z.uuid() }),
      body: { content: { 'application/json': { schema: CaptureSchema } }, required: false },
    },
    responses: { 200: { description: 'Captured or replayed' }, 401: problem, 403: problem, 409: problem, 502: problem, 503: problem },
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
