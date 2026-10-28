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
  captureFeeCents: z.number().int().nullable().describe('What PayPal said it took on the capture. Null when PayPal stated no fee, never zero.'),
  captureNetCents: z.number().int().nullable().describe('What PayPal said reached the seller on the capture. Null when PayPal stated no net, never zero.'),
  settledCents: z.number().int().nullable().describe('What PayPal reported actually arrived. Null until a settlement is seen.'),
  deltaCents: z.number().int().nullable().describe('settledCents minus the locked amount. Negative means the client paid less.'),
  deltaReason: z.string().nullable().describe('Why the settled amount was not the locked amount: full, early_discount, credit_note, paypal_fee, partial or unexplained. Closed list, and a code is only used when the PayPal field behind it was present.'),
  deltaSource: z.string().nullable().describe('The PayPal field deltaReason was read from, for example early_payment_discount. Null when PayPal reported nothing that could explain the gap.'),
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
  payInstrument: z.enum(['invoice', 'checkout']).nullable().describe('How this charge is to be paid: a PayPal invoice the client gets, or a card form on our own page.'),
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
  /** open: a standing offer awaiting the other side. countered: answered with a counter-offer. agreed: accepted and signed. refused: broke the offerer's own rules and never stood. withdrawn, expired: open when the negotiation ended with no deal. */
  status: z.enum(['open', 'countered', 'agreed', 'refused', 'withdrawn', 'expired']),
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
  agents: z.object({
    enabled: z.boolean(),
    model: z.string().nullable(),
    /** Why the agents are off, when they are: no key at all, or the day's token budget is used up. */
    reason: z.enum(['no_key', 'daily_budget']).nullable(),
    /** What the day's model budget looks like, so the console can say how much is left. */
    budget: z.object({ tokensIn: z.number(), tokensOut: z.number(), cap: z.number(), percent: z.number() }).nullable(),
  }),
  version: z.string(),
  paypalConfigured: z.boolean(),
  /** The PayPal this studio really moves money on: a stand-in, a real sandbox account, or none at all. */
  paypalMode: z.enum(['none', 'fake', 'sandbox', 'live']),
  /** The name the owner gave this studio. Null for the default studio. */
  studioName: z.string().nullable(),
  /** Which studio the caller's session belongs to. A browser in a new tab finds its studio here. */
  workspaceId: z.string(),
  /** What kind of workspace this is: the owner's own, a studio they opened, or the hosted demo. */
  workspaceMode: z.enum(['default', 'demo', 'studio', 'live']),
  demoReset: z.boolean(),
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
    method: 'post',
    path: '/v1/invites',
    tags: ['auth'],
    summary: 'Owner creates an invite. A passkey grant is required when the studio rule is on.',
    responses: { 200: { description: 'Invite token, shown once' }, 401: problem, 403: problem, 404: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/invites/revoke',
    tags: ['auth'],
    summary: 'Owner revokes an unused invite. Another member is forbidden. An unknown token is not found.',
    responses: { 200: { description: 'Revoked' }, 403: problem, 404: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/join/preview',
    tags: ['auth'],
    summary: 'Shows the studio, the role, and who invited. The token is not stored in the page query.',
    responses: { 200: { description: 'Invite preview' }, 400: problem, 404: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/members',
    tags: ['auth'],
    summary: 'Owner lists members. Names and roles only.',
    responses: { 200: { description: 'Members' }, 401: problem, 403: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/members/{id}/role',
    tags: ['auth'],
    summary: 'Owner changes a role. The last owner stays. Sessions for that member end. A passkey grant is required when the studio rule is on.',
    request: { params: z.object({ id: z.uuid() }) },
    responses: { 200: { description: 'Role changed' }, 400: problem, 401: problem, 403: problem, 404: problem, 409: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/members/{id}/revoke',
    tags: ['auth'],
    summary: 'Owner revokes a member. Sessions and passkeys end. The body lists proposals still waiting on a person. The last owner stays.',
    request: { params: z.object({ id: z.uuid() }) },
    responses: { 200: { description: 'Revoked, with open request ids' }, 401: problem, 403: problem, 404: problem, 409: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/auth/credentials',
    tags: ['auth'],
    summary: 'This member\'s passkeys. The public key is not returned.',
    responses: { 200: { description: 'Passkeys' }, 401: problem, 404: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/auth/credentials/revoke',
    tags: ['auth'],
    summary: 'Remove one passkey. The last passkey stays. Another member\'s id is not found.',
    responses: { 200: { description: 'Removed' }, 401: problem, 403: problem, 404: problem, 409: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/auth/sessions',
    tags: ['auth'],
    summary: 'This member\'s sessions. The token hash is not returned.',
    responses: { 200: { description: 'Sessions' }, 401: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/auth/sessions/revoke',
    tags: ['auth'],
    summary: 'End one of this member\'s sessions. Another member\'s id is not found.',
    responses: { 200: { description: 'Ended' }, 401: problem, 403: problem, 404: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/auth/sessions/revoke-others',
    tags: ['auth'],
    summary: 'End every session except the one making this call.',
    responses: { 200: { description: 'Count ended' }, 401: problem, 403: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/auth/recovery/issue',
    tags: ['auth'],
    summary: 'Issue eight recovery codes. They are shown once. The database stores only hashes.',
    responses: { 200: { description: 'Codes' }, 401: problem, 403: problem, 404: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/auth/recovery/ack',
    tags: ['auth'],
    summary: 'The person confirms with the words I saved these. The codes are not returned again.',
    responses: { 200: { description: 'Saved' }, 400: problem, 401: problem, 403: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/auth/recovery/regenerate',
    tags: ['auth'],
    summary: 'Replace recovery codes. Needs a fresh passkey step-up. A recovery session cannot do this.',
    responses: { 200: { description: 'New codes' }, 401: problem, 403: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/auth/events',
    tags: ['auth'],
    summary: 'Owner only. Sign-in history for this studio.',
    responses: { 200: { description: 'Events' }, 401: problem, 403: problem },
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
    summary: 'Owner only. Write the next warrant version. In-flight proposals keep the version they were decided against. Send X-Expected-Version (the version you started from) to be refused with 409 rules.stale if someone has published since.',
    request: { headers: z.object({ 'X-Expected-Version': z.string().regex(/^\d{1,6}$/).optional() }), body: { content: { 'application/json': { schema: WarrantBodySchema } } } },
    responses: { 201: { description: 'Stored', content: { 'application/json': { schema: WarrantViewSchema } } }, 400: problem, 401: problem, 409: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/proposals',
    tags: ['proposals'],
    security: bearer,
    summary: 'Propose a client charge (money in), a contractor payment (money out), or a refund. A payment must cite a settled client charge on the same job. The gate decides. This never captures.',
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
  const ownerRoute = (method: 'get' | 'post', path: string, summary: string, withId = false) => registry.registerPath({
    method,
    path,
    tags: ['paypal'],
    security: bearer,
    summary: `Owner only. ${summary}`,
    ...(withId ? { request: { params: z.object({ id: z.uuid() }) } } : {}),
    responses: { 200: { description: 'OK' }, 401: problem, 403: problem, 409: problem, 502: problem, 503: problem },
  })
  ownerRoute('post', '/v1/proposals/{id}/cancel-payout', 'Cancel a payout PayPal is holding as UNCLAIMED. PayPal returns the money and the reservation is released.', true)
  ownerRoute('post', '/v1/proposals/{id}/remind-invoice', 'Send the client a PayPal reminder for an invoice that is out and unpaid.', true)
  ownerRoute('post', '/v1/proposals/{id}/cancel-invoice', 'Cancel an invoice that is out and unpaid. The milestone can be billed again.', true)
  ownerRoute('post', '/v1/studio/turn', 'One turn of the dashboard agent in AG Studio: streams the model\'s words and tool calls as AG-UI events. The browser runs the dashboard\'s own tools; this route runs none and holds no ledger, service or PayPal client.')
  ownerRoute('get', '/v1/agents', 'List the issued agent keys (names, scopes, hourly limits, status, last seen). Key material is never returned.')
  ownerRoute('post', '/v1/agents', 'Issue an agent key with scopes, hourly limits, and optional expiry. Returns the full API key exactly once; only its hash is stored afterwards.')
  ownerRoute('post', '/v1/agents/{id}/revoke', 'Permanently revoke an agent key.', true)
  ownerRoute('post', '/v1/agents/{id}/upgrade', 'Replace an agent secret. The old mnd_ag_ key stops working. The same agent, scopes, and limits stay. The new key is shown once.', true)
  ownerRoute('post', '/v1/agents/{id}/resume', 'Re-activate an agent the breaker had suspended. Revoked keys stay revoked; create a new one.', true)
  ownerRoute('get', '/v1/agents/{id}/scorecard', 'Get the scorecard for an agent: total requests, refusals, auto approvals, needs-tap count, last seen, and breaker status.')
  ownerRoute('get', '/v1/client-keys', 'List the issued client keys (name, client, status, last seen). Key material is never returned.')
  ownerRoute('post', '/v1/client-keys', 'Issue a client its own key, bound to that client on the warrant. Returns the full API key exactly once; only its hash is stored afterwards.')
  ownerRoute('post', '/v1/client-keys/{id}/revoke', 'Permanently revoke a client key.', true)
  ownerRoute('post', '/v1/client-keys/{id}/rotate', 'Revoke a client key and issue its replacement in one step. Returns the new key exactly once.', true)
  ownerRoute('post', '/v1/client-keys/{id}/upgrade', 'Replace a client secret. The old mnd_cl_ key stops working. The same client binding stays. The new key is shown once.', true)
  ownerRoute('get', '/v1/jobs/{jobId}/shares', 'List the read-only status links issued for a job (who, expiry, views). The secret is never returned.')
  ownerRoute('post', '/v1/jobs/{jobId}/shares', 'Issue a read-only status link for one person on a job: a contractor sees their own payouts, a client sees their own invoices. Returns the link exactly once; only a hash is stored.')
  ownerRoute('post', '/v1/shares/{id}/revoke', 'Withdraw a status link.', true)
  ownerRoute('post', '/v1/demo/reset', 'Wipe the ledger back to a fresh Line Studio. Only exists when the server was started with DEMO_RESET=on against the PayPal sandbox; otherwise 404. The body must be {"confirm":"reset the demo"}. Signing, agent and client keys are kept.')
  ownerRoute('get', '/v1/notify', 'Whether the owner\'s notification webhook is set, when it last sent, and the last error. The address itself is never returned.')
  ownerRoute('post', '/v1/notify/test', 'Send one test message to the owner\'s webhook, so the setup can be checked.')
  ownerRoute('get', '/v1/agents/health', 'How each language model is doing (calls, failures, latency, circuit state, tokens) and which prompt versions are in force.')
  ownerRoute('get', '/v1/paypal/features', 'Which PayPal features this app may use, from its token scopes, with the dashboard steps for any that are off.')
  ownerRoute('post', '/v1/paypal/features/check', 'Same, after asking PayPal for a fresh token.')
  ownerRoute('get', '/v1/today', 'One page of what matters now: what waits for the owner, what is in flight, what was done for them and how, what the rules stopped, the month in money, the next milestones ready to bill, and setup progress. Built from the ledger alone.')
  ownerRoute('get', '/v1/flags', 'The planned switches and their defaults. Off means that feature is not active. Reading them changes nothing.')
  ownerRoute('post', '/v1/rules/simulate', 'Run the same pure check as Try. Writes nothing. The response says wrote: false.')
  ownerRoute('get', '/v1/payees', 'The payout book when FLAG_PAYEE_BOOK is on. Otherwise 404. Reading it does not pay anyone.')
  ownerRoute('post', '/v1/rules/policy', 'Paste a written spending policy (up to 20,000 characters). Returns every sentence with a status found by code (covered, partly, not_covered, unenforceable, context, untrusted, skipped), the pieces of the rules that carry each one out, and a draft for the sentences that could be rules. Quoted or forwarded text and instructions aimed at the system are set aside and never reach the model. Nothing is published.')
  ownerRoute('post', '/v1/rules/draft', 'Describe a change to the rules in plain words and get a DRAFT back: the new rules, a one-line summary, and which changes loosen or tighten what can happen without you. The model drafts; it never publishes. Publishing is PUT /v1/warrant with the owner key, after reading the diff.')
  ownerRoute('post', '/v1/rules/replay', 'Run the last requests again under proposed rules (the body is the full rules) and list the ones whose answer would change: no tap, tap, refused. Nothing is stored or sent.')
  ownerRoute('post', '/v1/replay', 'Replay ledger history against current or proposed rules as a Proof control to verify consistency without writing rows or calling PayPal.')
  ownerRoute('post', '/v1/ask', 'Decide where a sentence typed into Ask should go, with no model: a direct answer from the ledger (waiting, refused, month, in flight, ready, done, autopilot), a prepared delivery card for the owner to press, a hand-off to the rules drafter, or the clerk.')
  ownerRoute('get', '/v1/audit', 'Re-verify the whole ledger: every lock, that every payment had a yes, that amounts match to the cent, that contractors were paid from money that arrived, that the cap held, that no job paid out more than came in, and that signed deals were followed. Add ?paypal=1 to compare with PayPal\'s own history.')
  ownerRoute('get', '/v1/paypal/balance', 'What PayPal says the account holds, with the time of its last report. Advice only: PayPal\'s report lags by hours.')
  ownerRoute('get', '/v1/paypal/tools', 'Every PayPal Agent Toolkit tool, its tier (read, propose, out of scope) and whether the server itself uses it. Agents can call none of them directly.')
  ownerRoute('get', '/v1/paypal/activity', 'The last 30 days of PayPal activity (Transaction search) matched against the ledger. Read-only.')
  ownerRoute('get', '/v1/paypal/disputes', 'Stored PayPal disputes.')
  ownerRoute('post', '/v1/paypal/disputes/sync', 'Read disputes from PayPal now. A disputed client payment cannot fund a payout (funding.disputed).')
  registry.registerPath({
    method: 'post',
    path: '/v1/webhooks/paypal',
    tags: ['proposals'],
    summary: 'PayPal webhook (payout, invoice, dispute events). No credential. The body only names something to re-read from PayPal, so a forged call cannot change a status. With PAYPAL_WEBHOOK_ID set the delivery must also carry a signature PayPal confirms (401 otherwise); repeated event ids are ignored.',
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
    path: '/v1/proposals/{id}/mandate',
    tags: ['proposals'],
    security: bearer,
    summary: 'The closed mandate of one locked payment: a signed verifiable credential (compact JWS over EdDSA, vct mandate.payment.closed.1) whose sub is the cart hash. 409 mandate.not_locked when the payment was never locked: a mandate exists only for something the rules authorized.',
    request: { params: idParam },
    responses: { 200: { description: 'The mandate token and how to verify it' }, 401: problem, 404: problem, 409: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/standing/{ruleId}/mandate',
    tags: ['proposals'],
    security: bearer,
    summary: 'The open mandate of one standing rule: payee, funding clients, share and monthly cap, signed once (vct mandate.payment.open.1).',
    request: { params: z.object({ ruleId: z.string().min(1).max(64) }) },
    responses: { 200: { description: 'The mandate token and how to verify it' }, 401: problem, 404: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/mandates/verify',
    tags: ['proposals'],
    security: bearer,
    summary: 'Check a mandate token against the server\'s keyring. Pure checking: no state, no PayPal, no decision. Answers whether the signature verifies and what the mandate authorizes.',
    request: { body: { content: { 'application/json': { schema: z.object({ mandate: z.string().min(20).max(20_000) }) } } } },
    responses: { 200: { description: 'ok true with the payload, or ok false with a reason' }, 400: problem, 401: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/refusals/export',
    tags: ['proposals'],
    security: bearer,
    summary: 'Every refusal in the ledger with the rule that said it and the server\'s own sentence, as one signed artifact (mandate.refusals.v1). The signature is over the canonical bundle; anyone with the public keys can check it.',
    responses: { 200: { description: 'The signed refusal corpus' }, 401: problem },
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
    summary: 'Write the next version of one company\'s price limits (its walk-away, and optionally its target, negotiating style, standing brief and whether Mandate\'s negotiator may speak for it). `mine` is your own party: the owner may write the studio\'s sheet and a client\'s until that client writes its own (then it is sealed from the owner), a client key its own ceiling, the studio key its own floor, an agent none. Another company\'s sheet is refused. Send only what changes: the rest is kept from the current sheet, or taken from the warrant for a company that never had one. The price itself is never defaulted. Sheets that came with the sample studio count only once a key keeps them: until then offers and negotiations are refused with 409.',
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
    summary: 'Owner only. Mandate\'s hosted negotiators play the table move by move (alternating offers: offer, accept the standing offer, or walk away) until one side accepts, a side walks away, the deadline passes, the sides stall, or a client that speaks for itself must answer. Each move is the model\'s decision; the server holds the walk-away, the turn order and the deadline. Each side\'s negotiator then writes its own company a debrief.',
    request: { body: { content: { 'application/json': { schema: z.object({ buyer: z.string().optional(), task: z.string().optional(), milestones: z.array(z.string()).optional(), category: z.string().optional(), sellerBrief: z.string().optional(), buyerBrief: z.string().optional(), offersPerSide: z.number().int().min(2).max(8).optional(), threadId: z.uuid().optional() }) } } } },
    responses: { 200: { description: 'How it ended, every move, and the negotiation as the caller may see it' }, 401: problem, 403: problem, 409: problem, 503: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/negotiations',
    tags: ['deals'],
    security: bearer,
    summary: 'The latest negotiations the caller is a party to. Moves are public to both sides; each side\'s private numbers, reasoning, outcome and debrief appear only for that side.',
    responses: { 200: { description: 'Negotiations' }, 401: problem, 403: problem },
  })
  registry.registerPath({
    method: 'get',
    path: '/v1/negotiations/{id}',
    tags: ['deals'],
    security: bearer,
    summary: 'One negotiation: every move, whose turn it is, the standing offer, the deadline, how it ended, and the caller\'s own seat (its walk-away, target, a reference next move, its outcome and its negotiator\'s debrief).',
    request: { params: idParam },
    responses: { 200: { description: 'Negotiation' }, 401: problem, 403: problem, 404: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/deals/{id}/accept',
    tags: ['deals'],
    security: bearer,
    summary: 'Accept the other side\'s standing offer, exactly as it stands. The only way a deal is made: both companies\' current rules are checked, and the deal is signed and given its job. Repeating it returns the same deal.',
    request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ message: z.string().max(1000).optional(), assessment: z.string().max(1000).optional() }) } } } },
    responses: { 200: { description: 'The agreed, signed deal', content: { 'application/json': { schema: DealSchema } } }, 401: problem, 403: problem, 404: problem, 409: problem, 422: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/negotiations/{id}/walk-away',
    tags: ['deals'],
    security: bearer,
    summary: 'End a negotiation with no deal. Either side may, at any time.',
    request: { params: idParam, body: { content: { 'application/json': { schema: z.object({ reason: z.string().max(500).optional(), assessment: z.string().max(1000).optional() }) } } } },
    responses: { 200: { description: 'The ended negotiation' }, 401: problem, 403: problem, 404: problem, 409: problem },
  })
  registry.registerPath({
    method: 'post',
    path: '/v1/negotiations/{id}/agent-move',
    tags: ['agents'],
    security: bearer,
    summary: 'One move by Mandate\'s hosted negotiator for the seat whose turn it is, if the caller may let it speak for that seat (the studio always; a client only if it delegated).',
    request: { params: idParam },
    responses: { 200: { description: 'The negotiation after the move' }, 401: problem, 403: problem, 409: problem, 422: problem, 503: problem },
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
    summary: 'Model Context Protocol server (Streamable HTTP, stateless). A studio key gets get_rules, get_jobs, propose, list_ledger, explain and the negotiation tools (offer_deal, accept_offer, walk_away, get_negotiation); a client agent key gets get_rules, explain, get_deliveries, decide_delivery and the negotiation tools. No tool can approve, capture, send or change rules.',
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
