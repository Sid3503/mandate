import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { VERSION } from './config'
import { databaseReady } from './db/database'
import { Repo } from './db/repo'
import { IdempotencyKeySchema, ProposalCreateSchema, CaptureSchema, ListQuerySchema } from './domain/schemas'
import { onError, Problem, sendProblem, invalidRequest } from './http/problem'
import { WEB_CSP, webAsset } from './http/web'
import { buildOpenApi } from './openapi'
import type { PayPalPort } from './paypal/port'
import { decodeCursor, MandateService, type HttpResult, type Role } from './services/mandate'

export type AppDeps = {
  db: DatabaseSync
  paypal: PayPalPort | null
  now: () => Date
  config: {
    apiKey: string
    proposerKey?: string | null
    webDist?: string | null
    rateLimitPerMinute: number
    paypalConfigured: boolean
    log: boolean
    publicUrl: string
  }
}

const PUBLIC = new Set(['/', '/health', '/ready', '/openapi.json'])

/** Routes only the owner key may call. A proposer, such as an agent, can ask but never decide or move money. */
const OWNER_ONLY = [
  { method: 'PUT', pattern: /^\/v1\/warrant$/ },
  { method: 'POST', pattern: /^\/v1\/proposals\/[^/]+\/(approve|reject|capture)$/ },
]

function isWeb(path: string): boolean {
  return path === '/app' || path.startsWith('/app/')
}

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: { requestId: string; role: Role } }>()
  const service = new MandateService(new Repo(deps.db), deps.paypal, deps.now)
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
    const proposer = !owner && token !== '' && Boolean(deps.config.proposerKey) && sameSecret(token, deps.config.proposerKey!)
    if (!owner && !proposer) {
      throw new Problem(401, 'auth.unauthorized', 'Unauthorized', 'Provide Authorization: Bearer <api key>.')
    }
    const role: Role = owner ? 'owner' : 'proposer'
    c.set('role', role)
    if (role !== 'owner' && OWNER_ONLY.some((rule) => rule.method === c.req.method && rule.pattern.test(c.req.path))) {
      throw new Problem(403, 'auth.forbidden', 'Owner key required', 'A proposer key can propose and read. Only the owner can approve, reject, capture, or change the warrant.')
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

  app.get('/', (c) => c.json({
    service: 'mandate-api',
    version: VERSION,
    health: '/health',
    ready: '/ready',
    openapi: '/openapi.json',
    console: '/app/',
  }))

  app.get('/health', (c) => health(c, 'pass', {
    'api:alive': [{ status: 'pass', componentType: 'system', time: deps.now().toISOString() }],
  }))

  app.get('/ready', (c) => {
    const dbOk = databaseReady(deps.db)
    const paypalStatus = deps.config.paypalConfigured ? 'pass' : 'warn'
    const status = dbOk ? 'pass' : 'fail'
    return health(c, status, {
      'sqlite:read': [{ status: dbOk ? 'pass' : 'fail', componentType: 'datastore', time: deps.now().toISOString() }],
      'paypal:credentials': [{
        status: paypalStatus,
        componentType: 'vendor',
        observedValue: deps.config.paypalConfigured ? 'configured' : 'missing',
        time: deps.now().toISOString(),
      }],
    }, dbOk ? 200 : 503)
  })

  app.get('/openapi.json', (c) => c.json(openapi))

  app.get('/v1/session', (c) => c.json({ role: c.get('role'), version: VERSION, paypalConfigured: deps.config.paypalConfigured }))
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
    return send(c, service.propose(parsed.data, key.data, c.get('role')))
  })

  app.get('/v1/proposals', (c) => {
    const query = ListQuerySchema.safeParse({ limit: c.req.query('limit') ?? 50, cursor: c.req.query('cursor') })
    if (!query.success) throw invalidRequest(query.error)
    return c.json(service.listProposals(query.data.limit, query.data.cursor ? decodeCursor(query.data.cursor) : null))
  })

  app.get('/v1/proposals/:id', (c) => c.json(service.packet(c.req.param('id')).proposal))
  app.get('/v1/proposals/:id/packet', (c) => c.json(service.packet(c.req.param('id'))))

  app.post('/v1/proposals/:id/approve', async (c) => {
    await assertEmpty(c)
    return send(c, service.approve(c.req.param('id')))
  })
  app.post('/v1/proposals/:id/reject', async (c) => {
    await assertEmpty(c)
    return send(c, service.reject(c.req.param('id')))
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

  app.get('/v1/jobs/:jobId', (c) => c.json(service.job(c.req.param('jobId'))))

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
