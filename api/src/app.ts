import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { cookieWriteAllowed, readSessionCookie } from './auth/cookies'
import { es256PublicJwk, passkeyRuleBinding, stepBinding } from './auth/passkeys'
import type { ControlStore } from './control/store'
import { mountExtra, type ProductCtx } from './http/extra'
import { clientIp } from './ops/client-ip'
import { API_CSP, securityHeaders } from './ops/headers'
import { Metrics } from './ops/metrics'
import type { ModelBudget } from './ops/budget'
import { MAX_RATE_BUCKETS, RateLimiter, pruneBuckets, rateClass } from './ops/ratelimit'
import { redactText } from './ops/redact'
import type { TenantRegistry } from './tenancy/registry'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { DatabaseSync } from 'node:sqlite'
import { VERSION } from './config'
import { defaultFlags, type ServerFlags } from './flags'
import { databaseReady, resetDemo } from './db/database'
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
import { acceptLegacyMachineKey } from './services/machine-key'
import type { Notifier } from './services/notify'
import { StudioTurnSchema } from './agents/studio'
import { DEEP_RUN, EVERY_CHANGE_RUN, GUARANTEES } from './domain/guarantees'
import { generateCases } from './domain/cases'
import { countTaps, suggestRules } from './domain/suggest'
import { POLICY_MAX_CHARS, POLICY_MIN_CHARS } from './agents/policy'
import { paypalProblem } from './services/paypalProblem'
import type { AgentModel } from './agents/model'
import { buildServices, type Services } from './services/container'
import type { WatchPort } from './paypal/watch'
import { QUICK_IDS, type QuickId } from './services/ask'
import { toolSummary } from './paypal/tiers'
import { decodeCursor, type HttpResult } from './services/mandate'
import { actorLabel, buyerPrincipal, OWNER, STUDIO, type AgentLimits, type AgentScope, type Principal } from './services/principal'

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
  /** True while the process is shutting down: /ready then says so and the load balancer stops sending traffic. */
  draining?: () => boolean
  /** Built by the caller when something outside the app (the timers in main.ts) must share it. */
  agents?: AgentService
  /** Tells the owner's own channel when something needs them. Absent in tests that do not need it. */
  notifier?: Notifier
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
    /** The commit this server was built from. Shown on /ready as releaseId so a deploy can be verified. */
    commit?: string | null
    /** PayPal's id for the registered webhook. When set, a webhook must carry a signature PayPal confirms. */
    webhookId?: string | null
    /** `auto` lets the hosted stand-in for the client's agent answer a delivery as soon as it arrives. */
    clientAgent?: 'auto' | 'manual'
    /** Lets the owner wipe the ledger back to a fresh Line Studio. Sandbox demos only. */
    demoReset?: boolean
    /** Planned switches. Missing means the defaults: new features off. */
    flags?: ServerFlags
    adminKey?: string | null
    cookieSecure?: boolean
    trustProxy?: boolean
    /** How many proxies sit in front of this process. Counted from the right of X-Forwarded-For. */
    trustedProxyHops?: number
    redact?: string[]
    webauthn?: { rpID: string; rpName: string; origins: string[] } | null
    classedRates?: boolean
    idleHours?: number
    absoluteDays?: number
  }
  control?: ControlStore | null
  registry?: TenantRegistry | null
  workspace?: { id: string; mode: 'default' | 'demo' | 'studio' | 'live' }
  nested?: boolean
  budget?: ModelBudget | null
  metrics?: Metrics
  masterKey?: string | null
  demo?: { root: string; template: string } | null
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
const PolicySchema = z.object({ text: z.string().trim().min(POLICY_MIN_CHARS).max(POLICY_MAX_CHARS) }).strict()
const NegotiationSchema = z.object({
  buyer: z.string().trim().max(200).optional(),
  task: z.string().trim().max(300).optional(),
  sellerBrief: z.string().trim().max(600).optional(),
  buyerBrief: z.string().trim().max(600).optional(),
  maxOffers: z.number().int().min(2).max(8).optional(),
}).strict()

const PUBLIC = new Set(['/', '/health', '/ready', '/healthz', '/readyz', '/openapi.json', '/v1/webhooks/paypal', '/.well-known/mandate-keys.json', '/demo/start', '/workspaces', '/join', '/join/preview', '/ops/metrics', '/ops/model/kill', '/ops/model/resume'])

/** Routes only the owner key may call. A proposer, such as an agent, can ask but never decide or move money. */
const OWNER_ONLY = [
  { method: 'PUT', pattern: /^\/v1\/warrant$/ },
  { method: 'GET', pattern: /^\/v1\/party-rules$/ },
  // A PUT to /v1/party-rules/:partyId is not owner-only: each company may write its own sheet. The route decides
  // whose sheet that is; the other side's sheet stays out of reach, so both limits stay private.
  { method: 'POST', pattern: /^\/v1\/negotiations(\/stream)?$/ },
  { method: 'POST', pattern: /^\/v1\/rules\/(draft|draft\/stream|replay|try|cases|simulate|policy|policy\/stream)$/ },
  { method: 'GET', pattern: /^\/v1\/payees$/ },
  { method: 'POST', pattern: /^\/v1\/ask$/ },
  { method: 'POST', pattern: /^\/v1\/deals\/[^/]+\/milestones\/\d+\/review$/ },
  { method: 'GET', pattern: /^\/v1\/agent-runs(\/[^/]+)?$/ },
  { method: 'GET', pattern: /^\/v1\/agents\/health$/ },
  { method: 'GET', pattern: /^\/v1\/agents(\/[^/]+\/scorecard)?$/ },
  { method: 'POST', pattern: /^\/v1\/agents$/ },
  { method: 'POST', pattern: /^\/v1\/agents\/[^/]+\/(revoke|resume|upgrade)$/ },
  { method: 'GET', pattern: /^\/v1\/client-keys$/ },
  { method: 'POST', pattern: /^\/v1\/client-keys$/ },
  { method: 'POST', pattern: /^\/v1\/client-keys\/[^/]+\/(revoke|rotate|upgrade)$/ },
  { method: 'GET', pattern: /^\/v1\/jobs\/[^/]+\/shares$/ },
  { method: 'POST', pattern: /^\/v1\/jobs\/[^/]+\/shares$/ },
  { method: 'POST', pattern: /^\/v1\/shares\/[^/]+\/revoke$/ },
  { method: 'GET', pattern: /^\/v1\/client-errors$/ },
  { method: 'GET', pattern: /^\/v1\/suggestions$/ },
  { method: 'POST', pattern: /^\/v1\/safety\/(pause|resume)$/ },
  { method: 'POST', pattern: /^\/v1\/demo\/reset$/ },
  { method: 'GET', pattern: /^\/v1\/notify$/ },
  { method: 'POST', pattern: /^\/v1\/notify\/test$/ },
  { method: 'POST', pattern: /^\/v1\/studio\/turn$/ },
  { method: 'POST', pattern: /^\/v1\/proposals\/[^/]+\/(approve|reject|capture|cancel-payout|remind-invoice|cancel-invoice)$/ },
  { method: 'POST', pattern: /^\/v1\/workspace\/passkey-rule$/ },
  { method: 'POST', pattern: /^\/v1\/members\/[^/]+\/(role|revoke)$/ },
  { method: 'GET', pattern: /^\/v1\/(today|audit|flags)$/ },
  { method: 'GET', pattern: /^\/v1\/paypal\/(features|activity|disputes|tools|balance)$/ },
  { method: 'POST', pattern: /^\/v1\/paypal\/(features\/check|disputes\/sync)$/ },
]

/** The scope an agent key needs for this route; null if it has no path to it. */
function requiredAgentScope(method: string, path: string): AgentScope | null {
  if (path === '/mcp' || path.startsWith('/mcp/')) return 'mcp'
  if (method === 'GET' && path === '/v1/stream') return 'stream'
  if (path.startsWith('/v1/deals') || path.startsWith('/v1/deliveries') || path.startsWith('/v1/party-rules')) return 'deals'
  if (method === 'GET') return 'read'
  if (method === 'POST' && path === '/v1/proposals') return 'propose'
  return null
}

/** A client's agent may do only this. Everything else is the studio's business. */
function buyerMayCall(method: string, path: string): boolean {
  return (method === 'GET' && (path === '/v1/session' || path === '/v1/deals' || path === '/v1/party-rules/mine' || /^\/v1\/deals\/[^/]+$/.test(path)))
    || (method === 'GET' && path === '/v1/deliveries')
    // The client writes its own ceiling through `mine`: the route resolves it to its own party and refuses any other.
    || (method === 'PUT' && path === '/v1/party-rules/mine')
    || (method === 'POST' && (path === '/v1/deals/offers' || path === '/mcp' || /^\/v1\/deals\/[^/]+\/milestones\/\d+\/decision$/.test(path)))
}

/** A status link carries its own proof in the path, so it needs no key. It can only read one person's view of one job. */
function isShareRead(method: string, path: string): boolean {
  return method === 'GET' && /^\/v1\/share\/[^/]+$/.test(path)
}

function isWeb(path: string): boolean {
  return path === '/app' || path.startsWith('/app/')
}

function isAnonymous(path: string): boolean {
  return PUBLIC.has(path) || path.startsWith('/auth/')
}

const AgentCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(['read', 'propose', 'stream', 'mcp', 'deals'])).min(1),
  limits: z.object({ proposalsPerHour: z.number().int().min(1).max(10_000).optional(), centsPerHour: z.number().int().min(1).optional() }).strict().optional(),
  expiryDays: z.number().int().min(1).max(365).optional().nullable(),
}).strict()

const ClientKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  partyId: z.string().trim().min(1).max(120),
}).strict()

const ShareCreateSchema = z.object({
  partyId: z.string().trim().min(1).max(120),
  ttlDays: z.number().int().min(1).max(90).optional(),
  label: z.string().trim().max(120).optional(),
}).strict()

const TrySchema = z.object({ request: ProposalCreateSchema, rules: WarrantBodySchema.optional() }).strict()
const CasesSchema = z.object({ rules: WarrantBodySchema.optional() }).strict()

const ClientErrorSchema = z.object({
  scope: z.string().regex(/^[a-z0-9:_-]{1,40}$/),
  message: z.string().min(1).max(500),
  stack: z.string().max(4_000).optional(),
  url: z.string().max(300).optional(),
  release: z.string().max(40).optional(),
})

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: { requestId: string; principal: Principal; viaCookie?: boolean; memberRole?: string; memberId?: string; approvalLimit?: number | null } }>()
  const services = deps.services ?? buildServices({
    ...deps,
    publicUrl: deps.config.publicUrl,
    onExternalRef: (kind, externalId) => deps.control?.rememberRef(kind, externalId, deps.workspace?.id ?? 'ws_default'),
  })
  if (deps.control && !services.mandate.hasExternalRef) {
    services.mandate.setOnExternalRef((kind, externalId) => deps.control?.rememberRef(kind, externalId, deps.workspace?.id ?? 'ws_default'))
  }
  const { mandate: service, deals } = services
  const agents = deps.agents ?? new AgentService(services, deps.model ?? null, deps.now, deps.drafterModel ?? null, null, deps.budget ?? null)
  const buckets = new Map<string, { count: number; reset: number }>()
  const classes = new RateLimiter(() => deps.now().getTime())
  const metrics = deps.metrics ?? new Metrics()
  const clientErrorWindow = new Map<string, number[]>()
  const openapi = buildOpenApi(deps.config.publicUrl)

  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id')
    const requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID()
    c.set('requestId', requestId)
    c.header('x-request-id', requestId)
    c.header('cache-control', 'no-store')
    for (const [key, value] of Object.entries(securityHeaders(deps.config.cookieSecure === true))) c.header(key, value)
    if (!isWeb(c.req.path)) c.header('content-security-policy', API_CSP)
    const started = performance.now()
    await next()
    metrics.record(c.res.status)
    if (deps.config.log) {
      console.log(redactText(JSON.stringify({
        level: 'info',
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      }), deps.config.redact ?? []))
    }
  })

  const visitorIp = (c: { req: { header: (name: string) => string | undefined } }) => clientIp(
    { get: (name) => c.req.header(name) },
    deps.config.trustProxy === true,
    deps.config.trustedProxyHops ?? 1,
  )

  // A known key keeps its own bucket. Guesses share one bucket per client IP, so a new wrong key does not reset the count.
  const requestBucket = (c: { req: { header: (name: string) => string | undefined } }): string => {
    const ip = visitorIp(c)
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (token === '') return `anon:${ip}`
    acceptLegacyMachineKey(services.repo, token)
    const digest = createHash('sha256').update(token).digest('hex')
    const known = sameSecret(token, deps.config.apiKey)
      || (deps.config.proposerKey ? sameSecret(token, deps.config.proposerKey) : false)
      || (deps.config.buyerAgentKey ? sameSecret(token, deps.config.buyerAgentKey) : false)
      || services.repo.getAgentByKeyHash(digest) !== null
      || services.repo.getClientKeyByKeyHash(digest) !== null
    return known ? `key:${digest}` : `fail:${ip}`
  }

  app.use('*', async (c, next) => {
    if (c.req.path === '/health' || c.req.path === '/ready' || c.req.path === '/healthz' || c.req.path === '/readyz' || isWeb(c.req.path)) return next()
    const limit = deps.config.rateLimitPerMinute
    if (limit <= 0) return next()
    const presented = requestBucket(c)
    const key = createHash('sha256').update(presented).digest('hex')
    const now = Date.now()
    pruneBuckets(buckets, now, MAX_RATE_BUCKETS)
    const bucket = buckets.get(key)
    if (!bucket || now >= bucket.reset) buckets.set(key, { count: 1, reset: now + 60_000 })
    else if (bucket.count >= limit) {
      c.header('retry-after', '60')
      throw new Problem(429, 'rate.limited', 'Too many requests', 'The per-minute limit for this credential has been reached.')
    } else bucket.count += 1
    pruneBuckets(buckets, now, MAX_RATE_BUCKETS)
    if (deps.config.classedRates) {
      const decision = classes.take({
        className: rateClass(c.req.method, c.req.path),
        ip: visitorIp(c),
        principal: presented,
      })
      if (!decision.ok) {
        c.header('retry-after', String(decision.retryAfter))
        throw new Problem(429, 'rate/limited', 'Too many requests', 'This action is limited. Try again after the stated wait.')
      }
    }
    await next()
  })

  app.use('*', async (c, next) => {
    if (isAnonymous(c.req.path) || isWeb(c.req.path) || isShareRead(c.req.method, c.req.path)) return next()
    if (!deps.nested && c.req.path.startsWith('/w/')) return next()
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const flags = deps.config.flags ?? defaultFlags()
    const legacyOwner = flags.legacyOwnerKeyEnabled && (deps.workspace?.mode ?? 'default') === 'default'
    const owner = legacyOwner && token !== '' && sameSecret(token, deps.config.apiKey)
    const studio = !owner && token !== '' && Boolean(deps.config.proposerKey) && sameSecret(token, deps.config.proposerKey!)
    const buyer = !owner && !studio && token !== '' && Boolean(deps.config.buyerAgentKey) && sameSecret(token, deps.config.buyerAgentKey!)
    let principal: Principal
    if (owner) principal = OWNER
    else if (studio) principal = STUDIO
    else if (buyer) principal = buyerPrincipal(deps.config.buyerAgentParty ?? 'client_northwind')
    else if (!token && deps.control) {
      const raw = readSessionCookie(c.req.header('cookie'), deps.config.cookieSecure === true)
      const session = raw ? deps.control.session(raw, deps.now().toISOString()) : null
      const member = session ? deps.control.member(session.member_id) : null
      const here = deps.workspace?.id ?? 'ws_default'
      if (!session || !member || member.status !== 'active' || member.workspace_id !== here) {
        throw new Problem(404, 'tenant/not-found', 'Not found', 'No workspace has that session.')
      }
      c.set('viaCookie', true)
      c.set('memberRole', member.role)
      c.set('memberId', member.id)
      c.set('approvalLimit', member.approval_limit_cents)
      if (member.role === 'viewer' || member.role === 'payee') {
        const isDemoAction = deps.workspace?.mode === 'demo' && (c.req.path === '/v1/demo/switch' || c.req.path === '/v1/demo/reset')
        if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !isDemoAction) {
          throw new Problem(403, 'auth/forbidden', 'Read only', 'This role can look, not change.')
        }
        principal = STUDIO
      } else if (member.role === 'proposer') principal = STUDIO
      else principal = OWNER
      if (session.method === 'recovery' && c.req.method !== 'GET' && !c.req.path.startsWith('/auth/')) {
        throw new Problem(403, 'auth/forbidden', 'Recovery cannot approve', 'A recovery session can only add a passkey.')
      }
    } else {
      // A client's own key, issued from the System page and bound to one client on the warrant. It is the same
      // kind of caller as the environment's buyer key, except the owner can issue one per client and revoke it.
      acceptLegacyMachineKey(services.repo, token)
      const keyHash = createHash('sha256').update(token).digest('hex')
      const clientKey = services.repo.getClientKeyByKeyHash(keyHash)
      if (clientKey) {
        if (clientKey.status === 'revoked') throw new Problem(403, 'client-key.revoked', 'This client key is revoked', 'Ask the studio for a new key.')
        services.repo.setClientKeySeen(clientKey.id, new Date().toISOString())
        principal = buyerPrincipal(clientKey.party_id)
      } else {
        // Agents have their own keys: look them up by hash, enforce status, and carry their scopes and limits.
        const agent = services.repo.getAgentByKeyHash(keyHash)
        if (!agent) throw new Problem(401, 'auth.unauthorized', 'Unauthorized', 'Provide a valid owner key or agent key.')
        if (agent.status === 'revoked') throw new Problem(403, 'agent.revoked', 'This agent key is revoked', 'Ask the owner for a new agent key.')
        if (agent.status === 'suspended') throw new Problem(403, 'agent.suspended', 'This agent is suspended', 'The agent tripped the breaker. The owner can resume it from the System page.')
        if (agent.expires_at && agent.expires_at <= deps.now().toISOString()) {
          throw new Problem(403, 'agent.expired', 'This agent key has expired', 'Ask the owner to issue a new agent key or upgrade it.')
        }
        services.repo.setAgentSeen(agent.id, deps.now().toISOString())
        principal = { role: 'agent', side: null, buyerId: null, agentId: agent.id, name: agent.name, scopes: JSON.parse(agent.scopes_json) as AgentScope[], limits: JSON.parse(agent.limits_json) as AgentLimits }
      }
    }
    c.set('principal', principal)
    if (principal.role === 'agent') {
      const scope = requiredAgentScope(c.req.method, c.req.path)
      if (scope === null || !principal.scopes.includes(scope)) {
        throw new Problem(403, 'agent.scope', 'This agent key lacks the scope for this route', `Granted scopes: ${principal.scopes.join(', ') || 'none'}. The owner can issue a new key with it.`)
      }
    }
    const isDemoReset = deps.workspace?.mode === 'demo' && c.req.method === 'POST' && c.req.path === '/v1/demo/reset'
    if (principal.role !== 'owner' && !isDemoReset && OWNER_ONLY.some((rule) => rule.method === c.req.method && rule.pattern.test(c.req.path))) {
      throw new Problem(403, 'auth.forbidden', 'Owner key required', 'A proposer key can propose and read. Only the owner can approve, reject, capture, or change the warrant.')
    }
    if (c.get('memberRole') === 'approver' && !isDemoReset && OWNER_ONLY.some((rule) => rule.method === c.req.method && rule.pattern.test(c.req.path))) {
      const pause = c.req.method === 'POST' && c.req.path === '/v1/safety/pause'
      const approve = c.req.method === 'POST' && /^\/v1\/proposals\/[^/]+\/approve$/.test(c.req.path)
      if (!pause && !approve) throw new Problem(403, 'auth/forbidden', 'Outside this role', 'An approver can approve up to their limit, and pause. They cannot publish rules.')
    }
    if (c.get('viaCookie') && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = deps.config.webauthn?.origins ?? [new URL(deps.config.publicUrl).origin]
      if (!cookieWriteAllowed({ get: (name) => c.req.header(name) }, origin)) {
        throw new Problem(403, 'auth/csrf', 'Blocked', 'This browser was not the one that signed in.')
      }
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
  }, 200, deps.config.commit ?? null))

  const readyHandler = (c: Context) => {
    if (deps.draining?.()) return health(c, 'fail', { 'process:draining': [{ status: 'fail', componentType: 'system', observedValue: 'shutting down', time: deps.now().toISOString() }] }, 503, deps.config.commit ?? null)
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
    }, dbOk ? 200 : 503, deps.config.commit ?? null)
  }
  app.get('/ready', readyHandler)
  app.get('/readyz', readyHandler)

  app.get('/openapi.json', (c) => c.json(openapi))

  // What is degraded right now, for the banner at the top of every screen. Read-only and cheap: it never calls PayPal.
  app.get('/v1/status', (c) => {
    const upstream = deps.paypal?.upstream?.() ?? null
    const ai = agents.healthReport()
    const primary = ai.models.find((model) => model.name === ai.primary)
    const degraded: string[] = []
    if (upstream && upstream.circuit !== 'closed') degraded.push('paypal')
    if (ai.enabled && primary && primary.circuit !== 'closed' && !ai.fallback) degraded.push('ai')
    const pause = services.safety.state()
    return c.json({ time: deps.now().toISOString(), degraded, paused: pause.paused ? { reason: pause.reason, since: pause.since, by: pause.by } : null, paypal: upstream, ai: { enabled: ai.enabled, primary: ai.primary, fallback: ai.fallback, circuit: primary?.circuit ?? 'closed' } })
  })
  // Errors the console hit on a person's screen, so an operator can see them. Rate limited, size capped, never trusted.
  app.post('/v1/client-errors', async (c) => {
    assertJson(c)
    const raw = await c.req.text()
    if (raw.length > 12_000) throw new Problem(413, 'request.too_large', 'Report is too large', 'Send less.')
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new Problem(400, 'request.invalid', 'Request is invalid', 'Body is not JSON.')
    }
    const parsed = ClientErrorSchema.safeParse(body)
    if (!parsed.success) throw invalidRequest(parsed.error)
    const principal = c.get('principal')
    const key = `client-errors:${principal.role}:${principal.side ?? ''}`
    const now = deps.now().getTime()
    const recent = (clientErrorWindow.get(key) ?? []).filter((at) => now - at < 60_000)
    if (recent.length >= 20) return c.json({ stored: false, reason: 'rate_limited' }, 202)
    clientErrorWindow.set(key, [...recent, now])
    const clip = (value: string | undefined, max: number) => (value ? value.slice(0, max) : null)
    services.repo.insertClientError({ id: randomUUID(), at: deps.now().toISOString(), role: principal.role, scope: parsed.data.scope, message: parsed.data.message, stack: clip(parsed.data.stack, 4_000), url: clip(parsed.data.url, 300), agent: clip(c.req.header('user-agent'), 200), releaseId: clip(parsed.data.release, 40) })
    return c.json({ stored: true }, 201)
  })
  app.get('/v1/client-errors', (c) => c.json({ data: services.repo.recentClientErrors(50).map((row) => ({ id: row.id, at: row.at, role: row.role, scope: row.scope, message: row.message, stack: row.stack, url: row.url, agent: row.agent, release: row.release_id })) }))
  // "You keep saying yes": standing rules worth offering, from what the owner actually did. Words for the drafter, never a rule.
  app.get('/v1/suggestions', (c) => {
    const warrant = services.repo.latestWarrant()
    if (!warrant) return c.json({ suggestions: [], taps: { thisMonth: 0, lastMonth: 0, byRule: 0 } })
    const proposals = services.repo.allProposals().map((row) => ({ id: row.id, kind: row.kind, gate: row.gate, clause: row.clause, phase: row.phase, payeeId: row.payee_id, amountCents: row.amount_cents, fundingCaptureId: row.funding_capture_id, captureId: row.capture_id, createdAt: row.created_at }))
    const decisions = services.repo.allEvents().filter((event) => event.type === 'proposal.approved' || event.type === 'proposal.rejected').map((event) => ({ proposalId: event.proposal_id, type: event.type === 'proposal.approved' ? ('approved' as const) : ('rejected' as const), actor: String((JSON.parse(event.payload_json) as { actor?: string }).actor ?? ''), at: event.created_at }))
    const input = { warrant: warrant.body, now: deps.now(), proposals, decisions }
    return c.json({ suggestions: suggestRules(input), taps: countTaps(input) })
  })
  // ---------- agent keys ----------
  app.get('/v1/agents', (c) => c.json(services.agents.list()))
  app.post('/v1/agents', async (c) => {
    assertJson(c)
    const parsed = AgentCreateSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    requireStep(c, deps, 'agent.issue', stepBinding('agent.issue', JSON.stringify(parsed.data)))
    const created = services.agents.create(parsed.data)
    return c.json(created, 201)
  })
  app.post('/v1/agents/:id/revoke', (c) => {
    requireStep(c, deps, 'agent.revoke', stepBinding('agent.revoke', c.req.param('id')))
    return c.json(services.agents.revoke(c.req.param('id')))
  })
  app.post('/v1/agents/:id/upgrade', (c) => {
    requireStep(c, deps, 'agent.upgrade', stepBinding('agent.upgrade', c.req.param('id')))
    return c.json(services.agents.upgrade(c.req.param('id')))
  })
  app.post('/v1/agents/:id/resume', (c) => c.json(services.agents.resume(c.req.param('id'))))
  app.get('/v1/agents/:id/scorecard', (c) => c.json(services.agents.scorecard(c.req.param('id'))))

  // ---------- client keys ----------
  // Where the owner is told when something needs them. The webhook address is never returned.
  app.get('/v1/notify', (c) => c.json(deps.notifier?.status() ?? { enabled: false, lastSentAt: null, lastError: null, sent: 0 }))
  app.post('/v1/notify/test', async (c) => {
    if (!deps.notifier?.enabled) throw new Problem(409, 'notify.off', 'No webhook is set', 'Start the server with NOTIFY_WEBHOOK_URL (an https incoming webhook for Slack, Discord or Zapier) to be told when something needs you.')
    return c.json(await deps.notifier.test())
  })
  // Hosted demos: put the ledger back to a fresh Line Studio. Absent unless the deployer switched it on, and never against real PayPal.
  app.post('/v1/demo/reset', async (c) => {
    if (!deps.config.demoReset) throw new Problem(404, 'demo.off', 'Not available', 'This server was not started as a resettable demo.')
    assertJson(c)
    const parsed = z.object({ confirm: z.literal('reset the demo') }).strict().safeParse(await readJson(c))
    if (!parsed.success) throw new Problem(422, 'demo.confirm', 'Type the confirmation', 'Send {"confirm":"reset the demo"} to wipe the ledger.')
    resetDemo(deps.db, deps.now())
    services.safety.forget()
    // Tell every open screen to look again, whatever it was showing.
    for (const scope of ['ledger', 'delivery', 'deal', 'rules', 'safety', 'agents'] as const) live.publish({ type: 'changed', scope, what: 'demo.reset', at: new Date().toISOString() })
    return c.json({ reset: true })
  })
  // Status links: the owner shares a read-only page about one job with one person.
  app.get('/v1/jobs/:jobId/shares', (c) => c.json({ data: services.shares.list(c.req.param('jobId')) }))
  app.post('/v1/jobs/:jobId/shares', async (c) => {
    assertJson(c)
    const parsed = ShareCreateSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    const made = services.shares.issue({ jobId: c.req.param('jobId'), ...parsed.data })
    return c.json({ share: made.share, token: made.token, url: `${deps.config.publicUrl.replace(/\/$/, '')}/app/s/${made.token}` }, 201)
  })
  app.post('/v1/shares/:id/revoke', (c) => c.json(services.shares.revoke(c.req.param('id'))))
  app.get('/v1/share/:token', (c) => c.json(services.shares.view(c.req.param('token'))))
  app.get('/v1/client-keys', (c) => c.json(services.clientKeys.list()))
  app.post('/v1/client-keys', async (c) => {
    assertJson(c)
    const parsed = ClientKeyCreateSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    requireStep(c, deps, 'client-key.issue', stepBinding('client-key.issue', JSON.stringify(parsed.data)))
    const created = services.clientKeys.issue(parsed.data)
    return c.json(created, 201)
  })
  app.post('/v1/client-keys/:id/revoke', (c) => {
    requireStep(c, deps, 'client-key.revoke', stepBinding('client-key.revoke', c.req.param('id')))
    return c.json(services.clientKeys.revoke(c.req.param('id')))
  })
  app.post('/v1/client-keys/:id/rotate', (c) => {
    requireStep(c, deps, 'client-key.rotate', stepBinding('client-key.rotate', c.req.param('id')))
    return c.json(services.clientKeys.rotate(c.req.param('id')), 201)
  })
  app.post('/v1/client-keys/:id/upgrade', (c) => {
    requireStep(c, deps, 'client-key.upgrade', stepBinding('client-key.upgrade', c.req.param('id')))
    return c.json(services.clientKeys.upgrade(c.req.param('id')))
  })

  // What Mandate promises and where each promise is checked. Static, so it answers when everything else does not.
  app.get('/v1/guarantees', (c) => c.json({ guarantees: GUARANTEES, deepRun: DEEP_RUN, everyChange: EVERY_CHANGE_RUN }))
  // The emergency stop. Anyone with a key can see whether Mandate is paused; only the owner can pause or resume it.
  app.get('/v1/safety', (c) => c.json({ ...services.safety.state(), breaker: { tripAfter: services.safety.config.tripAfter, windowSeconds: services.safety.config.windowSeconds }, events: services.safety.events(20) }))
  app.post('/v1/safety/pause', async (c) => {
    const text = await c.req.text()
    let reason: string | null = null
    if (text) {
      try {
        const parsed = z.object({ reason: z.string().max(200).optional() }).safeParse(JSON.parse(text))
        if (!parsed.success) throw invalidRequest(parsed.error)
        reason = parsed.data.reason ?? null
      } catch (error) {
        if (error instanceof Problem) throw error
        throw new Problem(400, 'request.invalid', 'Request is invalid', 'Body is not JSON.')
      }
    }
    return c.json(services.safety.pause('owner', reason))
  })
  app.post('/v1/safety/resume', async (c) => {
    requireStep(c, deps, 'resume', stepBinding('resume', 'safety.resume'))
    return c.json(await services.safety.resume('owner'))
  })
  app.get('/v1/session', (c) => c.json({ role: c.get('memberRole') ?? c.get('principal').role, side: c.get('principal').side, version: VERSION, paypalConfigured: deps.config.paypalConfigured, agents: { enabled: agents.enabled, model: agents.modelName }, demoReset: deps.config.demoReset === true }))
  app.get('/v1/flags', (c) => c.json(deps.config.flags ?? defaultFlags()))
  app.post('/v1/workspace/passkey-rule', async (c) => {
    assertJson(c)
    if (!deps.control) throw new Problem(404, 'flag/disabled', 'Not available', 'This server has no workspace record.')
    const body = await readJson(c) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') throw new Problem(400, 'request.invalid', 'Request is invalid', 'Say whether the passkey rule is on.')
    const id = deps.workspace?.id ?? 'ws_default'
    const row = deps.control.workspace(id)
    if (!row) throw new Problem(404, 'tenant/not-found', 'Not found', 'No workspace has that id.')
    if (body.enabled === (row.passkey_for_money === 1)) return c.json({ passkeyForMoney: row.passkey_for_money === 1 })
    const memberId = c.get('memberId')
    if (!memberId) throw new Problem(403, 'auth/passkey-required', 'Enroll a passkey first', 'Sign in with a passkey before changing this rule.')
    const live = deps.control.credentials(memberId).filter((item) => !item.revoked_at)
    if (live.length === 0) throw new Problem(409, 'auth/passkey-required', 'Enroll a passkey first', 'This account has no passkey yet.')
    requireStep(c, deps, 'passkey-rule', passkeyRuleBinding(body.enabled), true)
    deps.control.setPasskeyForMoney(id, body.enabled)
    return c.json({ passkeyForMoney: body.enabled })
  })
  app.get('/.well-known/mandate-keys.json', (c) => c.json(service.publicKeys()))
  app.get('/v1/warrant', (c) => c.json(service.currentWarrant()))
  app.get('/v1/warrant/versions', (c) => c.json(service.warrantVersions()))
  app.put('/v1/warrant', async (c) => {
    assertJson(c)
    const header = c.req.header('x-expected-version')
    if (header !== undefined && !/^\d{1,6}$/.test(header)) throw new Problem(400, 'rules.expected_version_invalid', 'X-Expected-Version is invalid', 'Send the version number you started from, for example 3.')
    const body = await readJson(c)
    const rulesBinding = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const rulesGrantId = c.req.header('x-mandate-stepup')
    const rulesGrant = rulesGrantId ? deps.control?.grant(rulesGrantId) : null
    requireStep(c, deps, 'rules', rulesBinding)
    const result = service.publishWarrant(body, header === undefined ? undefined : Number(header), rulesGrant?.assertion_json ?? null)
    return send(c, result)
  })

  app.post('/v1/proposals', async (c) => {
    assertJson(c)
    const key = IdempotencyKeySchema.safeParse(c.req.header('idempotency-key'))
    if (!key.success) throw new Problem(400, 'idempotency.missing', 'Idempotency-Key is missing', 'POST /v1/proposals requires an Idempotency-Key of 8 to 255 token characters.')
    const parsed = ProposalCreateSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    const principal = c.get('principal')
    return send(c, await service.proposeAndDispatch(parsed.data, key.data, actorLabel(principal)))
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
    const id = c.req.param('id')
    if (c.get('memberRole') === 'approver') {
      const limit = c.get('approvalLimit')
      const amount = service.packet(id).proposal.amountCents
      if (limit != null && amount > limit) throw new Problem(403, 'approval.over_limit', 'Over your limit', 'This amount is above what you can approve.')
    }
    const hash = service.approvalHash(id)
    const grantId = c.req.header('x-mandate-stepup')
    const grant = grantId ? deps.control?.grant(grantId) : null
    if (stepNeeded(c, deps) && hash) {
      const memberId = c.get('memberId')
      if (grant && memberId && grant.member_id === memberId && grant.kind === 'approve' && !grant.used_at && grant.binding !== hash) {
        throw new Problem(409, 'cart.changed', 'changed since you looked', 'The payment changed after you signed. Sign it again.')
      }
    }
    requireStep(c, deps, 'approve', hash ?? id)
    const assertion = grant?.assertion_json ? JSON.parse(grant.assertion_json) as unknown : null
    const credentialId = assertion && typeof assertion === 'object' && 'id' in assertion ? String((assertion as { id: unknown }).id) : ''
    const stored = credentialId ? deps.control?.credential(credentialId) : null
    const fingerprint = stored?.fingerprint ?? null
    const publicKey = stored ? es256PublicJwk(stored.public_key) : null
    let origin: string | null = null
    let challenge: string | null = null
    const clientData = assertion && typeof assertion === 'object' && 'response' in assertion
      ? (assertion as { response?: { clientDataJSON?: string } }).response?.clientDataJSON
      : undefined
    if (clientData) {
      try {
        const parsed = JSON.parse(Buffer.from(clientData, 'base64url').toString('utf8')) as { origin?: unknown; challenge?: unknown }
        origin = typeof parsed.origin === 'string' ? parsed.origin : null
        challenge = typeof parsed.challenge === 'string' ? parsed.challenge : null
      } catch {
        origin = null
        challenge = null
      }
    }
    const demo = !assertion && workspacePasskeyOn(deps).mode === 'demo' && c.req.header('x-mandate-demo-tap') === '1'
    const method = assertion ? 'passkey' : demo ? 'demo' : 'owner-key'
    return send(c, service.approve(id, assertion, { method, fingerprint, publicKey, rpId: deps.config.webauthn?.rpID ?? null, origin, challenge }))
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
    const resource = event.resource ?? {}
    const header = resource.batch_header as Record<string, unknown> | undefined
    const found = resource.payout_batch_id ?? header?.payout_batch_id
    const batchId = typeof found === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(found) ? found : null
    const invoice = (resource.invoice as Record<string, unknown> | undefined)?.id ?? (typeof resource.id === 'string' && resource.id.startsWith('INV') ? resource.id : undefined)
    const invoiceId = typeof invoice === 'string' && /^INV[A-Za-z0-9-]{3,64}$/.test(invoice) ? invoice : null

    if (!deps.nested && deps.control && deps.registry) {
      const targetWorkspace = (batchId ? deps.control.workspaceForRef('payout', batchId) : null)
        ?? (invoiceId ? deps.control.workspaceForRef('invoice', invoiceId) : null)
      if (targetWorkspace && targetWorkspace !== (deps.workspace?.id ?? 'ws_default')) {
        const tenant = deps.registry.get(targetWorkspace)
        if (tenant) {
          return tenant.fetch(new Request(c.req.url, {
            method: c.req.method,
            headers: c.req.raw.headers,
            body: raw,
          }))
        }
      }
    }

    const eventId = typeof event.id === 'string' && event.id.length <= 128 ? event.id : null
    const eventType = typeof event.event_type === 'string' ? event.event_type.slice(0, 80) : ''
    // PayPal retries deliveries. A retry of an event already handled does nothing.
    if (eventId && !services.repo.claimWebhookEvent(eventId, eventType, deps.now().toISOString())) {
      return c.json({ received: true, duplicate: true, refreshed: false })
    }
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
  let activeStreams = 0
  const MAX_ACTIVE_STREAMS = 50

  app.get('/v1/stream', (c) => {
    const principal = c.get('principal')
    if (principal.role !== 'owner' && principal.role !== 'proposer') throw new Problem(403, 'auth.forbidden', 'Not for this key', 'The live stream is for the owner and the studio.')
    if (activeStreams >= MAX_ACTIVE_STREAMS) {
      throw new Problem(429, 'stream.capped', 'Stream cap reached', 'Too many live stream connections are open.')
    }
    return streamSSE(c, async (stream) => {
      activeStreams++
      try {
        const unsubscribe = live.subscribe((event) => { void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => undefined) })
        await stream.writeSSE({ event: 'hello', data: JSON.stringify({ type: 'hello', at: deps.now().toISOString() }) })
        const beat = setInterval(() => { void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => undefined) }, 15_000)
        await new Promise<void>((resolve) => stream.onAbort(resolve))
        clearInterval(beat)
        unsubscribe()
      } finally {
        activeStreams--
      }
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
      throw paypalProblem(error, 'to list disputes')
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
          // Tool calls and the model's words, as they happen. The rules' answer card still arrives as a `step`.
          onEvent: (event) => { void send(event).catch(() => undefined) },
          onStep: (step) => { void send({ type: 'step', tools: step.toolResults.map((item) => ({ tool: item.tool, ok: item.ok })), outcomes: step.toolResults.filter((item) => item.tool === 'propose' && item.ok).map((item) => item.output) } as { type: string }) },
        })
        await send({ type: 'done', reply } as { type: string })
      } catch (error) {
        const problem = error instanceof Problem ? error : null
        await send({ type: 'error', code: problem?.code ?? 'internal', message: problem?.detail ?? 'The clerk failed. Nothing was sent to PayPal.' } as { type: string })
      }
    })
  })
  // Try a request, or the cases made from the rules, without filing anything. Under the live rules, and under a draft if one is given.
  app.post('/v1/rules/try', async (c) => {
    assertJson(c)
    const parsed = TrySchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    return c.json({ ...service.tryRequest(parsed.data.request, parsed.data.rules), funding: service.tryFunding() })
  })
  app.post('/v1/rules/cases', async (c) => {
    assertJson(c)
    const parsed = CasesSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    const live = service.currentWarrant()
    const funding = service.tryFunding()
    const { id: _id, version: _version, createdAt: _createdAt, ...liveBody } = live
    const body = parsed.data.rules ?? WarrantBodySchema.parse(liveBody)
    const cases = generateCases(body, funding).map((item) => ({ id: item.id, label: item.label, request: item.request, ...service.tryRequest(ProposalCreateSchema.parse(item.request), parsed.data.rules) }))
    return c.json({ cases, funding })
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
  // The same draft, told as it is made: each stage is a real step the server took, in order.
  app.post('/v1/rules/draft/stream', async (c) => {
    assertJson(c)
    const parsed = DraftRulesSchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    const principal = c.get('principal')
    return streamSSE(c, async (stream) => {
      const send = (name: string, data: unknown) => stream.writeSSE({ event: name, data: JSON.stringify({ type: name, ...(data as object) }) })
      try {
        const draft = await agents.draftRules(parsed.data.instruction, principal, { onStage: (stage) => { void send('stage', stage).catch(() => undefined) } })
        await send('done', { draft })
      } catch (error) {
        const problem = error instanceof Problem ? error : null
        await send('error', { code: problem?.code ?? 'internal', title: problem?.title ?? 'The draft failed', message: problem?.detail ?? 'The draft failed. Nothing was changed.' })
      }
    })
  })
  // Paste a written policy; get back which sentences the rules carry out, which cannot be rules, and a draft for the rest.
  app.post('/v1/rules/policy', async (c) => {
    assertJson(c)
    const parsed = PolicySchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    return c.json(await agents.draftFromPolicy(parsed.data.text, c.get('principal')))
  })
  app.post('/v1/rules/policy/stream', async (c) => {
    assertJson(c)
    const parsed = PolicySchema.safeParse(await readJson(c))
    if (!parsed.success) throw invalidRequest(parsed.error)
    const principal = c.get('principal')
    return streamSSE(c, async (stream) => {
      const send = (name: string, data: unknown) => stream.writeSSE({ event: name, data: JSON.stringify({ type: name, ...(data as object) }) })
      try {
        const result = await agents.draftFromPolicy(parsed.data.text, principal, { onStage: (stage) => { void send('stage', stage).catch(() => undefined) } })
        await send('done', { policy: result })
      } catch (error) {
        const problem = error instanceof Problem ? error : null
        await send('error', { code: problem?.code ?? 'internal', title: problem?.title ?? 'The policy could not be read', message: problem?.detail ?? 'The policy could not be read. Nothing was changed.' })
      }
    })
  })
  // One turn of the dashboard agent in AG Studio. It streams the model's words and tool calls back; the browser runs the
  // dashboard's own tools. The route hands the agent no service, no ledger and no PayPal client. Owner only.
  app.post('/v1/studio/turn', async (c) => {
    assertJson(c)
    const raw = await c.req.text()
    if (raw.length > 600_000) throw new Problem(413, 'request.too_large', 'The conversation is too long', 'Start a new thread in the chat panel.')
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new Problem(400, 'request.invalid', 'Request is invalid', 'Body is not JSON.')
    }
    const parsed = StudioTurnSchema.safeParse(body)
    if (!parsed.success) throw invalidRequest(parsed.error)
    const principal = c.get('principal')
    const abort = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => abort.abort())
    return streamSSE(c, async (stream) => {
      const send = (name: string, data: unknown) => stream.writeSSE({ event: name, data: JSON.stringify(data) })
      try {
        const done = await agents.studioTurn(parsed.data, principal, { signal: abort.signal, onEvent: (event) => { void send('ai', event).catch(() => undefined) } })
        await send('complete', done)
      } catch (error) {
        const problem = error instanceof Problem ? error : null
        await send('error', { code: problem?.code ?? 'internal', message: problem?.detail ?? 'The agent failed. Nothing on the dashboard changed.' })
      }
    })
  })
  // How each model is doing, which wording each agent runs on, and what has been spent in tokens.
  app.get('/v1/agents/health', (c) => c.json(agents.healthReport()))
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
    return send(c, deals.publishRules(c.req.param('partyId'), await readJson(c), c.get('principal')))
  })

  app.get('/v1/ledger', (c) => {
    const query = ListQuerySchema.safeParse({ limit: c.req.query('limit') ?? 50, cursor: c.req.query('cursor') })
    if (!query.success) throw invalidRequest(query.error)
    return c.json(service.listLedger(query.data.limit, query.data.cursor ? decodeCursor(query.data.cursor) : null))
  })

  const flags = deps.config.flags ?? defaultFlags()
  const product: ProductCtx = {
    flags,
    now: deps.now,
    control: deps.control ?? null,
    registry: deps.registry ?? null,
    workspaceId: deps.workspace?.id ?? 'ws_default',
    workspaceMode: deps.workspace?.mode ?? 'default',
    nested: deps.nested === true,
    adminKey: deps.config.adminKey ?? null,
    webauthn: deps.config.webauthn ?? null,
    metrics,
    budget: deps.budget ?? null,
    cookieSecure: deps.config.cookieSecure === true,
    idleHours: deps.config.idleHours ?? 12,
    absoluteDays: deps.config.absoluteDays ?? 7,
    trustProxy: deps.config.trustProxy === true,
    trustedProxyHops: deps.config.trustedProxyHops ?? 1,
    demo: deps.demo ?? null,
    masterKey: deps.masterKey ?? null,
    paypal: deps.paypal as ProductCtx['paypal'],
    tryOne: (body: unknown) => {
      const parsed = TrySchema.safeParse(body)
      if (!parsed.success) throw invalidRequest(parsed.error)
      return service.tryRequest(parsed.data.request, parsed.data.rules)
    },
    counts: () => ({
      proposals: tableCount(deps.db, 'proposals'),
      events: tableCount(deps.db, 'events'),
      payees: tableCount(deps.db, 'payees'),
    }),
    listPayees: () => services.repo.listPayees(),
    approvalHash: (proposalId) => service.approvalHash(proposalId),
    openRequests: () => (deps.db.prepare(`SELECT id FROM proposals WHERE phase = 'pending_approval' ORDER BY created_at`).all() as Array<{ id: string }>).map((row) => row.id),
    requireStep: (c, kind, binding) => requireStep(c, deps, kind, binding),
  }
  mountExtra(app, product, (request) => app.fetch(request))

  return app
}

function workspacePasskeyOn(deps: AppDeps): { on: boolean; mode: 'default' | 'demo' | 'studio' | 'live' } {
  const id = deps.workspace?.id ?? 'ws_default'
  const row = deps.control?.workspace(id)
  if (row) return { on: row.passkey_for_money === 1, mode: row.mode }
  return { on: false, mode: deps.workspace?.mode ?? 'default' }
}

function stepNeeded(c: { req: { header: (name: string) => string | undefined } }, deps: AppDeps, force = false): boolean {
  const flags = deps.config.flags ?? defaultFlags()
  const workspace = workspacePasskeyOn(deps)
  if (!force && !flags.requirePasskeyForMoney && !workspace.on) return false
  if (!force && workspace.mode === 'demo' && c.req.header('x-mandate-demo-tap') === '1') return false
  return true
}

function requireStep(c: { req: { header: (name: string) => string | undefined }; get: (key: 'memberId') => string | undefined }, deps: AppDeps, kind: string, binding: string, force = false): void {
  if (!stepNeeded(c, deps, force)) return
  const grant = c.req.header('x-mandate-stepup')
  const memberId = c.get('memberId')
  if (!grant || !memberId || !deps.control?.consumeGrant(grant, memberId, kind, binding, deps.now().toISOString())) {
    throw new Problem(401, 'auth/stepup-required', 'Sign this with your passkey', 'The tap needs a fresh passkey signature.')
  }
}

function health(c: { json: (body: unknown, status?: number, headers?: Record<string, string>) => Response }, status: 'pass' | 'fail', checks: Record<string, unknown[]>, code = 200, releaseId: string | null = null) {
  return c.json({
    status,
    version: VERSION,
    // The commit this build came from, when the host says so (health+json's own field for it).
    ...(releaseId ? { releaseId } : {}),
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

function tableCount(db: DatabaseSync, table: 'proposals' | 'events' | 'payees'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}

function sameSecret(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}
