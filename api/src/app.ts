import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { DatabaseSync } from 'node:sqlite'
import { VERSION } from './config'
import { databaseReady } from './db/database'
import { z } from 'zod'
import { BillMilestoneSchema, DealOfferSchema, DecideDeliverySchema } from './domain/deal'
import type { Signer } from './domain/signing'
import { IdempotencyKeySchema, ProposalCreateSchema, CaptureSchema, ListQuerySchema, WarrantBodySchema } from './domain/schemas'
import { onError, Problem, sendProblem, invalidRequest } from './http/problem'
import { WEB_CSP, webAsset } from './http/web'
import { buildOpenApi } from './openapi'
import type { InvoicePort } from './paypal/invoices'
import { PayPalError, type PayPalPort } from './paypal/port'
import { handleMcp } from './mcp/http'
import { AgentService, logReviewFailure } from './agents/service'
import { live } from './services/live'
import type { AgentModel } from './agents/model'
import { buildServices, type Services } from './services/container'
import type { WatchPort } from './paypal/watch'
import { QUICK_IDS, type QuickId } from './services/ask'
import { toolSummary } from './paypal/tiers'
import { decodeCursor, type HttpResult } from './services/mandate'
import { buyerPrincipal, OWNER, STUDIO, type Principal } from './services/principal'

export type AppDeps = {
  db: DatabaseSync
  paypal: PayPalPort | null
  now: () => Date
  /** Signs locks and agreed deals. Tests get a throwaway key. */
  signer?: Signer
  /** Bills clients with PayPal invoices through the Agent Toolkit. Omit for checkout only. */
  invoices?: InvoicePort | null
  /** Read-only view of the PayPal account: disputes and transactions. Omit and those features are off. */
  watch?: WatchPort | null
  /** Pre-built services, for when another entry point (the MCP server, the agents) must share them. */
  services?: Services
  /** The language model behind the clerk and the negotiators. Without it the agents are off and everything else works. */
  model?: AgentModel | null
  /** A separate model for drafting rules. Falls back to `model`. */
  drafterModel?: AgentModel | null
  /** Built by the caller when something outside the app (the timers in main.ts) must share it. */
  agents?: AgentService
  config: {
    apiKey: string
    proposerKey?: string | null
    /** A client's agent. It can make and read offers for that one client and nothing else. */
    buyerAgentKey?: string | null
    buyerAgentParty?: string
    webDist?: string | null
    rateLimitPerMinute: number
    paypalConfigured: boolean
    log: boolean
    publicUrl: string
    /** PayPal's id for the registered webhook. When set, a webhook must carry a signature PayPal confirms. */
    webhookId?: string | null
    /** `auto` lets the hosted stand-in for the client's agent answer a delivery as soon as it arrives. */
    clientAgent?: 'auto' | 'manual'
  }
}

const ClerkMessageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.uuid().optional(),
  /** What screen the person is on, from the app. The server checks it against the ledger. */
  context: z.object({ jobId: z.string().max(80).optional(), proposalId: z.string().max(80).optional() }).strict().optional(),
}).strict()
const AskSchema = z.object({
  message: z.string().trim().max(4000).optional(),
  quick: z.enum(QUICK_IDS).optional(),
  context: z.object({ jobId: z.string().max(80).optional() }).strict().optional(),
}).strict()
const DraftRulesSchema = z.object({ instruction: z.string().trim().min(3).max(1000) }).strict()
const NegotiationSchema = z.object({
  buyer: z.string().trim().max(200).optional(),
  task: z.string().trim().max(300).optional(),
  sellerBrief: z.string().trim().max(600).optional(),
  buyerBrief: z.string().trim().max(600).optional(),
  maxOffers: z.number().int().min(2).max(8).optional(),
}).strict()

const PUBLIC = new Set(['/', '/health', '/ready', '/openapi.json', '/v1/webhooks/paypal', '/.well-known/mandate-keys.json'])

/** Routes only the owner key may call. A proposer, such as an agent, can ask but never decide or move money. */
const OWNER_ONLY = [
  { method: 'PUT', pattern: /^\/v1\/warrant$/ },
  { method: 'GET', pattern: /^\/v1\/party-rules$/ },
  { method: 'PUT', pattern: /^\/v1\/party-rules\/[^/]+$/ },
  { method: 'POST', pattern: /^\/v1\/negotiations(\/stream)?$/ },
  { method: 'POST', pattern: /^\/v1\/rules\/(draft|replay)$/ },
  { method: 'POST', pattern: /^\/v1\/ask$/ },
  { method: 'POST', pattern: /^\/v1\/deals\/[^/]+\/milestones\/\d+\/review$/ },
  { method: 'GET', pattern: /^\/v1\/agent-runs(\/[^/]+)?$/ },
  { method: 'POST', pattern: /^\/v1\/proposals\/[^/]+\/(approve|reject|capture|cancel-payout|remind-invoice|cancel-invoice)$/ },
  { method: 'GET', pattern: /^\/v1\/(today|audit)$/ },
  { method: 'GET', pattern: /^\/v1\/paypal\/(features|activity|disputes|tools|balance)$/ },
  { method: 'POST', pattern: /^\/v1\/paypal\/(features\/check|disputes\/sync)$/ },
]

/** A client's agent may do only this. Everything else is the studio's business. */
function buyerMayCall(method: string, path: string): boolean {
  return (method === 'GET' && (path === '/v1/session' || path === '/v1/deals' || path === '/v1/party-rules/mine' || /^\/v1\/deals\/[^/]+$/.test(path)))
    || (method === 'GET' && path === '/v1/deliveries')
    || (method === 'POST' && (path === '/v1/deals/offers' || path === '/mcp' || /^\/v1\/deals\/[^/]+\/milestones\/\d+\/decision$/.test(path)))
}

function isWeb(path: string): boolean {
  return path === '/app' || path.startsWith('/app/')
}

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: { requestId: string; principal: Principal } }>()
  const services = deps.services ?? buildServices({ ...deps, publicUrl: deps.config.publicUrl })
  const { mandate: service, deals } = services
  const agents = deps.agents ?? new AgentService(services, deps.model ?? null, deps.now, deps.drafterModel ?? null)
  const buckets = new Map<string, { count: number; reset: number }>()
  const openapi = buildOpenApi(deps.config.publicUrl)

  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id')
    const requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID()
    c.set('requestId', requestId)
    c.header('x-request-id', requestId)
    c.header('cache-control', 'no-store')
    c.header('x-content-type-options', 'nosniff')
    c.header('referrer-policy', 'no-referrer')
    c.header('x-frame-options', 'DENY')
    const started = performance.now()
    await next()
    if (deps.config.log) {
      console.log(JSON.stringify({
        level: 'info',
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      }))
    }
  })

  app.use('*', async (c, next) => {
    if (c.req.path === '/health' || c.req.path === '/ready' || isWeb(c.req.path)) return next()
    const limit = deps.config.rateLimitPerMinute
    if (limit <= 0) return next()
    const presented = c.req.header('authorization') ?? 'anonymous'
    const key = createHash('sha256').update(presented).digest('hex')
    const now = Date.now()
    const bucket = buckets.get(key)
    if (!bucket || now >= bucket.reset) buckets.set(key, { count: 1, reset: now + 60_000 })
    else if (bucket.count >= limit) {
      c.header('retry-after', '60')
      throw new Problem(429, 'rate.limited', 'Too many requests', 'The per-minute limit for this credential has been reached.')
    } else bucket.count += 1
    await next()
  })

  app.use('*', async (c, next) => {
    if (PUBLIC.has(c.req.path) || isWeb(c.req.path)) return next()
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const owner = token !== '' && sameSecret(token, deps.config.apiKey)
    const studio = !owner && token !== '' && Boolean(deps.config.proposerKey) && sameSecret(token, deps.config.proposerKey!)
    const buyer = !owner && !studio && token !== '' && Boolean(deps.config.buyerAgentKey) && sameSecret(token, deps.config.buyerAgentKey!)
    if (!owner && !studio && !buyer) {
      throw new Problem(401, 'auth.unauthorized', 'Unauthorized', 'Provide Authorization: Bearer <api key>.')
    }
    const principal: Principal = owner ? OWNER : studio ? STUDIO : buyerPrincipal(deps.config.buyerAgentParty ?? 'client_northwind')
    c.set('principal', principal)
    if (principal.role !== 'owner' && OWNER_ONLY.some((rule) => rule.method === c.req.method && rule.pattern.test(c.req.path))) {
      throw new Problem(403, 'auth.forbidden', 'Owner key required', 'A proposer key can propose and read. Only the owner can approve, reject, capture, or change the warrant.')
    }
    if (principal.side === 'buyer' && !buyerMayCall(c.req.method, c.req.path)) {
      throw new Problem(403, 'auth.forbidden', 'Not available to a client agent', 'A client agent can make and read deal offers for its own client. Nothing else.')
    }
    await next()
  })

  app.get('/app', (c) => c.redirect('/app/', 308))
  app.get('/app/*', (c) => {
    const asset = deps.config.webDist ? webAsset(deps.config.webDist, c.req.path, c.req.header('accept-encoding') ?? '') : null
    if (!asset) return sendProblem(c, new Problem(404, 'route.not_found', 'Not found', 'The owner console is not built. Run npm run build in web/.'))
    const headers: Record<string, string> = {
      'content-type': asset.type,
      'cache-control': asset.cache,
      'content-security-policy': WEB_CSP,
    }
    if (asset.encoding) headers['content-encoding'] = asset.encoding
    headers.vary = 'accept-encoding'
    if (c.req.path.endsWith('/sw.js')) headers['service-worker-allowed'] = '/app/'
    return c.body(asset.body as unknown as ArrayBuffer, 200, headers)
  })

  app.onError(onError)
  app.notFound((c) => sendProblem(c, new Problem(404, 'route.not_found', 'Not found', 'No route matches this path.')))

  // A browser that opens the server's address lands on the product. Everything else gets the JSON index.
  app.get('/', (c) => {
    if ((c.req.header('accept') ?? '').includes('text/html')) return c.redirect('/app/welcome', 302)
    return c.json({
      service: 'mandate-api',
      version: VERSION,
      health: '/health',
      ready: '/ready',
      openapi: '/openapi.json',
      console: '/app/',
    })
  })

  app.get('/health', (c) => health(c, 'pass', {
    'api:alive': [{ status: 'pass', componentType: 'system', time: deps.now().toISOString() }],
  }))

  app.get('/ready', (c) => {
    const dbOk = databaseReady(deps.db)
    const paypalStatus = deps.config.paypalConfigured ? 'pass' : 'warn'
    const status = dbOk ? 'pass' : 'fail'
    return health(c, status, {
      'sqlite:read': [{ status: dbOk ? 'pass' : 'fail', componentType: 'datastore', time: deps.now().toISOString() }],
      'agents:model': [{
        status: agents.enabled ? 'pass' : 'warn',
        componentType: 'vendor',
        observedValue: agents.modelName ?? 'off',
        time: deps.now().toISOString(),
      }],
      'paypal:credentials': [{
        status: paypalStatus,
        componentType: 'vendor',
        observedValue: deps.config.paypalConfigured ? 'configured' : 'missing',
        time: deps.now().toISOString(),
      }],
    }, dbOk ? 200 : 503)
  })

  app.get('/openapi.json', (c) => c.json(openapi))

  app.get('/v1/session', (c) => c.json({ role: c.get('principal').role, side: c.get('principal').side, version: VERSION, paypalConfigured: deps.config.paypalConfigured, agents: { enabled: agents.enabled, model: agents.modelName } }))
  app.get('/.well-known/mandate-keys.json', (c) => c.json(service.publicKeys()))
  app.get('/v1/warrant', (c) => c.json(service.currentWarrant()))
  app.get('/v1/warrant/versions', (c) => c.json(service.warrantVersions()))
  app.put('/v1/warrant', async (c) => {
    assertJson(c)
    const result = service.publishWarrant(await readJson(c))
    return send(c, result)
  })

  app.post('/v1/proposals', async (c) => {
    assertJson(c)
    const key = IdempotencyKeySchema.safeParse(c.req.header('idempotency-key'))
    if (!key.success) throw new Problem(400, 'idempotency.missing', 'Idempotency-Key is missing', 'POST /v1/proposals requires an Idempotency-Key of 8 to 255 token characters.')
    const parsed = ProposalCreateSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    return send(c, await service.proposeAndDispatch(parsed.data, key.data, c.get('principal').role))
  })

  app.get('/v1/proposals', (c) => {
    const query = ListQuerySchema.safeParse({ limit: c.req.query('limit') ?? 50, cursor: c.req.query('cursor') })
    if (!query.success) throw invalidRequest(query.error)
    return c.json(service.listProposals(query.data.limit, query.data.cursor ? decodeCursor(query.data.cursor) : null))
  })

  app.get('/v1/proposals/:id', (c) => c.json(service.packet(c.req.param('id')).proposal))
  app.get('/v1/proposals/:id/packet', (c) => c.json(service.packet(c.req.param('id'))))
  app.get('/v1/proposals/:id/verify', (c) => c.json(service.verifyLock(c.req.param('id'))))

  app.post('/v1/proposals/:id/approve', async (c) => {
    await assertEmpty(c)
    return send(c, service.approve(c.req.param('id')))
  })
  app.post('/v1/proposals/:id/reject', async (c) => {
    await assertEmpty(c)
    return send(c, service.reject(c.req.param('id')))
  })
  app.post('/v1/proposals/:id/cancel-payout', async (c) => {
    await assertEmpty(c)
    return send(c, await service.cancelUnclaimedPayout(c.req.param('id')))
  })
  app.post('/v1/proposals/:id/remind-invoice', async (c) => {
    await assertEmpty(c)
    return send(c, await service.remindInvoice(c.req.param('id')))
  })
  app.post('/v1/proposals/:id/cancel-invoice', async (c) => {
    await assertEmpty(c)
    return send(c, await service.cancelInvoice(c.req.param('id')))
  })
  app.post('/v1/proposals/:id/capture', async (c) => {
    const text = (await c.req.text()).trim()
    let body: unknown = {}
    if (text) {
      try {
        body = JSON.parse(text) as unknown
      } catch {
        throw new Problem(400, 'request.invalid', 'Request is invalid', 'Body is not JSON.')
      }
    }
    const parsed = CaptureSchema.safeParse(body)
    if (!parsed.success) throw invalidRequest(parsed.error)
    return send(c, await service.capture(c.req.param('id'), parsed.data.claimedAmountCents))
  })

  // PayPal tells us a payout changed. The body is never trusted: it only names a batch, and the
  // batch is re-read from PayPal with our own credentials. A forged call can at worst cause a read.
  app.post('/v1/webhooks/paypal', async (c) => {
    const raw = await c.req.text()
    let event: { id?: unknown; event_type?: unknown; resource?: Record<string, unknown> } = {}
    try {
      event = JSON.parse(raw) as typeof event
    } catch {
      return c.json({ received: true, refreshed: false })
    }
    // With a webhook id, PayPal must vouch for the delivery. Without one the body is still never trusted:
    // it only names something to re-read from PayPal.
    if (deps.config.webhookId) {
      const header = (name: string) => c.req.header(name) ?? ''
      let genuine = false
      try {
        genuine = deps.paypal
          ? await deps.paypal.verifyWebhook({
              webhookId: deps.config.webhookId,
              headers: Object.fromEntries(['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'].map((name) => [name, header(name)])),
              event,
            })
          : false
      } catch {
        genuine = false
      }
      if (!genuine) return c.json({ received: false, error: 'webhook.signature_invalid' }, 401)
    }
    const eventId = typeof event.id === 'string' && event.id.length <= 128 ? event.id : null
    const eventType = typeof event.event_type === 'string' ? event.event_type.slice(0, 80) : ''
    // PayPal retries deliveries. A retry of an event already handled does nothing.
    if (eventId && !services.repo.claimWebhookEvent(eventId, eventType, deps.now().toISOString())) {
      return c.json({ received: true, duplicate: true, refreshed: false })
    }
    const resource = event.resource ?? {}
    const header = resource.batch_header as Record<string, unknown> | undefined
    const found = resource.payout_batch_id ?? header?.payout_batch_id
    const batchId = typeof found === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(found) ? found : null
    const invoice = (resource.invoice as Record<string, unknown> | undefined)?.id ?? (typeof resource.id === 'string' && resource.id.startsWith('INV') ? resource.id : undefined)
    const invoiceId = typeof invoice === 'string' && /^INV[A-Za-z0-9-]{3,64}$/.test(invoice) ? invoice : null
    try {
      if (eventType.startsWith('CUSTOMER.DISPUTE.')) return c.json({ received: true, refreshed: (await service.syncDisputes()).checked })
      if (batchId) return c.json({ received: true, ...(await service.refreshPayoutBatch(batchId)) })
      if (invoiceId) return c.json({ received: true, ...(await service.refreshInvoice(invoiceId)) })
    } catch {
      if (eventId) services.repo.releaseWebhookEvent(eventId)
      return c.json({ received: true, refreshed: false })
    }
    return c.json({ received: true, refreshed: false })
  })

  // ---------- what PayPal knows about the account (owner only) ----------
  app.get('/v1/paypal/features', async (c) => c.json(await service.features(false)))
  app.post('/v1/paypal/features/check', async (c) => {
    await assertEmpty(c)
    return c.json(await service.features(true))
  })
  // The console listens here, so a payment, a decision or a settlement shows the moment it is written. Events only
  // say what changed; the console re-reads the real thing through the normal routes. Owner and studio only.
  app.get('/v1/stream', (c) => {
    const principal = c.get('principal')
    if (principal.role !== 'owner' && principal.role !== 'proposer') throw new Problem(403, 'auth.forbidden', 'Not for this key', 'The live stream is for the owner and the studio.')
    return streamSSE(c, async (stream) => {
      const unsubscribe = live.subscribe((event) => { void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => undefined) })
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ type: 'hello', at: deps.now().toISOString() }) })
      const beat = setInterval(() => { void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => undefined) }, 15_000)
      await new Promise<void>((resolve) => stream.onAbort(resolve))
      clearInterval(beat)
      unsubscribe()
    })
  })
  app.get('/v1/today', (c) => c.json({ ...services.today.build(), clientAgent: { mode: deps.config.clientAgent ?? 'manual', ready: agents.enabled } }))
  app.get('/v1/audit', async (c) => c.json(await services.audit.run({ paypal: c.req.query('paypal') === '1' })))
  app.get('/v1/paypal/balance', async (c) => c.json(await service.balance()))
  app.get('/v1/paypal/tools', (c) => c.json(toolSummary()))
  app.get('/v1/paypal/activity', async (c) => c.json(await service.activity(Number(c.req.query('days') ?? 30) || 30)))
  app.get('/v1/paypal/disputes', (c) => c.json({ data: services.repo.listDisputes(50) }))
  app.post('/v1/paypal/disputes/sync', async (c) => {
    await assertEmpty(c)
    try {
      return c.json(await service.syncDisputes())
    } catch (error) {
      if (error instanceof PayPalError && (error.httpStatus === 401 || error.httpStatus === 403)) {
        return c.json({ checked: false, open: 0, disputes: services.repo.listDisputes(50), reason: 'The PayPal app has no Disputes permission.' })
      }
      throw new Problem(502, 'paypal.upstream', 'PayPal could not list disputes', error instanceof PayPalError ? error.paypalName : 'unknown')
    }
  })

  app.get('/v1/jobs/:jobId', (c) => c.json({ ...service.job(c.req.param('jobId')), deal: deals.summaryForJob(c.req.param('jobId')) }))

  // ---------- the agent door ----------
  app.all('/mcp', (c) => handleMcp(c.req.raw, services, c.get('principal')))

  // ---------- the agents: a clerk for staff, and two negotiators ----------
  app.post('/v1/clerk/messages', async (c) => {
    assertJson(c)
    const parsed = ClerkMessageSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    return c.json(await agents.clerk(parsed.data, c.get('principal')))
  })
  // Ask, part one: decide where a sentence goes, without a model. Owner only.
  app.post('/v1/ask', async (c) => {
    assertJson(c)
    const parsed = AskSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    if (parsed.data.quick) return c.json(services.ask.quick(parsed.data.quick as QuickId))
    return c.json(services.ask.route(parsed.data.message ?? '', parsed.data.context))
  })
  // Ask, part two: the clerk, told as it works, so the rules' answer shows before the model's words.
  app.post('/v1/clerk/stream', async (c) => {
    assertJson(c)
    const parsed = ClerkMessageSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    const principal = c.get('principal')
    return streamSSE(c, async (stream) => {
      const send = (event: { type: string }) => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      try {
        const reply = await agents.clerk(parsed.data, principal, {
          onStep: (step) => { void send({ type: 'step', tools: step.toolResults.map((item) => ({ tool: item.tool, ok: item.ok })), outcomes: step.toolResults.filter((item) => item.tool === 'propose' && item.ok).map((item) => item.output) } as { type: string }) },
        })
        await send({ type: 'done', reply } as { type: string })
      } catch (error) {
        const problem = error instanceof Problem ? error : null
        await send({ type: 'error', code: problem?.code ?? 'internal', message: problem?.detail ?? 'The clerk failed. Nothing was sent to PayPal.' } as { type: string })
      }
    })
  })
  app.post('/v1/rules/replay', async (c) => {
    assertJson(c)
    const parsed = WarrantBodySchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    return c.json(service.replay(parsed.data))
  })
  app.post('/v1/rules/draft', async (c) => {
    assertJson(c)
    const parsed = DraftRulesSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    return c.json(await agents.draftRules(parsed.data.instruction, c.get('principal')))
  })
  app.get('/v1/clerk/conversations/:id', (c) => c.json(agents.conversation(c.req.param('id'))))
  app.post('/v1/negotiations', async (c) => {
    assertJson(c)
    const parsed = NegotiationSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    return c.json(await agents.negotiate(parsed.data, c.get('principal')))
  })
  // The same negotiation, told as it happens: who is thinking, each offer, the rules' verdict, the end.
  // Server-sent events over a POST (a browser EventSource cannot carry the key). Owner only.
  app.post('/v1/negotiations/stream', async (c) => {
    assertJson(c)
    const parsed = NegotiationSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    const principal = c.get('principal')
    agents.assertCanNegotiate(principal)
    const abort = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => abort.abort())
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => abort.abort())
      const send = (event: { type: string }) => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      try {
        await agents.negotiate(parsed.data, principal, { onEvent: send, signal: abort.signal })
      } catch (error) {
        const problem = error instanceof Problem ? error : null
        await send({ type: 'error', code: problem?.code ?? 'internal', message: problem?.detail ?? 'The negotiation failed. Nothing was sent to PayPal.' } as { type: string })
      }
    })
  })
  app.get('/v1/agent-runs', (c) => c.json(agents.recentRuns(30)))
  app.get('/v1/agent-runs/:id', (c) => c.json(agents.run(c.req.param('id'))))

  // ---------- deals: two companies' agents agree terms inside both owners' rules ----------
  app.post('/v1/deals/offers', async (c) => {
    assertJson(c)
    const key = IdempotencyKeySchema.safeParse(c.req.header('idempotency-key'))
    if (!key.success) throw new Problem(400, 'idempotency.missing', 'Idempotency-Key is missing', 'POST /v1/deals/offers requires an Idempotency-Key of 8 to 255 token characters.')
    const principal = c.get('principal')
    const parsed = DealOfferSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    if (principal.role === 'proposer' && !parsed.data.as && !principal.side) {
      throw new Problem(400, 'deal.as_required', 'Say which party is offering', 'Set "as" to buyer or seller.')
    }
    return send(c, deals.offer(parsed.data, key.data, principal))
  })
  app.get('/v1/deals', (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50) || 50))
    return c.json(deals.list(limit, c.get('principal')))
  })
  app.get('/v1/deals/:id', (c) => c.json(deals.get(c.req.param('id'), c.get('principal'))))
  app.get('/v1/deliveries', (c) => c.json(deals.deliveries(c.get('principal'))))
  app.post('/v1/deals/:id/milestones/:n/deliver', async (c) => {
    assertJson(c)
    const milestone = Number(c.req.param('n'))
    if (!Number.isInteger(milestone) || milestone < 0 || milestone > 11) throw new Problem(404, 'deal.milestone_unknown', 'No such milestone', 'Milestones are numbered from 0.')
    const parsed = BillMilestoneSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    const made = await deals.deliver(c.req.param('id'), milestone, parsed.data, c.get('principal'))
    // The client's agent is a separate party. When the hosted stand-in is on auto, it answers by itself, as an outside agent polling get_deliveries would.
    if (deps.config.clientAgent === 'auto' && agents.enabled && made.status === 201 && (made.body as { mode?: string }).mode === 'awaiting') {
      void agents.reviewDelivery(c.req.param('id'), milestone, OWNER).catch((error) => logReviewFailure(c.req.param('id'), milestone, error))
    }
    return send(c, made)
  })
  app.post('/v1/deals/:id/milestones/:n/decision', async (c) => {
    assertJson(c)
    const milestone = Number(c.req.param('n'))
    if (!Number.isInteger(milestone) || milestone < 0 || milestone > 11) throw new Problem(404, 'deal.milestone_unknown', 'No such milestone', 'Milestones are numbered from 0.')
    const parsed = DecideDeliverySchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    return send(c, await deals.decide(c.req.param('id'), milestone, parsed.data, c.get('principal')))
  })
  app.post('/v1/deals/:id/milestones/:n/review', async (c) => {
    await assertEmpty(c)
    const milestone = Number(c.req.param('n'))
    if (!Number.isInteger(milestone) || milestone < 0 || milestone > 11) throw new Problem(404, 'deal.milestone_unknown', 'No such milestone', 'Milestones are numbered from 0.')
    return c.json(await agents.reviewDelivery(c.req.param('id'), milestone, c.get('principal')))
  })
  app.get('/v1/deals/:id/verify', (c) => c.json(deals.verify(c.req.param('id'))))
  app.post('/v1/deals/:id/milestones/:n/bill', async (c) => {
    assertJson(c)
    const milestone = Number(c.req.param('n'))
    if (!Number.isInteger(milestone) || milestone < 0 || milestone > 11) throw new Problem(404, 'deal.milestone_unknown', 'No such milestone', 'Milestones are numbered from 0.')
    const parsed = BillMilestoneSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    return send(c, await deals.bill(c.req.param('id'), milestone, parsed.data, c.get('principal')))
  })
  app.get('/v1/party-rules', (c) => c.json(deals.rules()))
  app.get('/v1/party-rules/mine', (c) => c.json(deals.rulesFor(c.get('principal'))))
  app.put('/v1/party-rules/:partyId', async (c) => {
    assertJson(c)
    return send(c, deals.publishRules(c.req.param('partyId'), await readJson(c)))
  })

  app.get('/v1/ledger', (c) => {
    const query = ListQuerySchema.safeParse({ limit: c.req.query('limit') ?? 50, cursor: c.req.query('cursor') })
    if (!query.success) throw invalidRequest(query.error)
    return c.json(service.listLedger(query.data.limit, query.data.cursor ? decodeCursor(query.data.cursor) : null))
  })

  return app
}

function health(c: { json: (body: unknown, status?: number, headers?: Record<string, string>) => Response }, status: 'pass' | 'fail', checks: Record<string, unknown[]>, code = 200) {
  return c.json({
    status,
    version: VERSION,
    serviceId: 'mandate-api',
    description: 'Mandate spending-warrant API',
    checks,
  }, code, { 'content-type': 'application/health+json' })
}

function send(c: Parameters<typeof sendProblem>[0], result: HttpResult): Response {
  if (result.status >= 400) {
    const body = result.body !== null && typeof result.body === 'object'
      ? { requestId: c.get('requestId'), ...(result.body as Record<string, unknown>) }
      : result.body
    return c.body(JSON.stringify(body), result.status as 400, { 'content-type': 'application/problem+json' })
  }
  const headers: Record<string, string> = {}
  if (result.status === 201 && result.body && typeof result.body === 'object' && 'id' in result.body) {
    headers.location = `/v1/proposals/${String((result.body as { id: string }).id)}`
  }
  return c.json(result.body, result.status as 200, headers)
}

function assertJson(c: { req: { header: (name: string) => string | undefined } }): void {
  const type = c.req.header('content-type') ?? ''
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new Problem(415, 'request.unsupported_media_type', 'Unsupported media type', 'Use application/json.')
  }
}

async function assertEmpty(c: { req: { text: () => Promise<string> } }): Promise<void> {
  const text = (await c.req.text()).trim()
  if (!text) return
  const parsed = JSON.parse(text) as unknown
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return
  throw new Problem(400, 'request.invalid', 'Request is invalid', 'This action takes no fields. The cart is read from the server.')
}

async function readJson(c: { req: { text: () => Promise<string> } }): Promise<unknown> {
  const text = await c.req.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Problem(400, 'request.invalid', 'Request is invalid', 'Body is not JSON.')
  }
}

function sameSecret(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}
