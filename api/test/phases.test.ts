import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createApp } from '../src/app'
import { openProduct } from '../src/boot'
import { ControlStore } from '../src/control/store'
import { migrate, openDatabase, seed } from '../src/db/database'
import { applySqlSteps } from '../src/db/sql-migrations'
import { applyPayeeBook } from '../src/domain/payee-book'
import { applyPause, NOT_PAUSED } from '../src/domain/safety'
import { loadSigner } from '../src/domain/signing'
import { loadFlags } from '../src/flags'
import { AgentService } from '../src/agents/service'
import { ModelBudget } from '../src/ops/budget'
import { RateLimiter } from '../src/ops/ratelimit'
import { redactText } from '../src/ops/redact'
import { buildServices } from '../src/services/container'
import { OWNER } from '../src/services/principal'
import { openSeal } from '../src/tenancy/envelope'
import { TenantRegistry } from '../src/tenancy/registry'
import { withMandate } from '../../packages/guard/index'
import { FakePayPal } from '../src/paypal/fake'
import { call, closeAll, EVIDENCE, harness, JOB, NOW, OWNER_KEY, STUDIO_KEY } from './support'
import { SoftAuthenticator } from './soft-authenticator'

afterEach(closeAll)

const CANARY = 'CANARYSECRETVALUE1234567890'
const MASTER = Buffer.alloc(32, 9).toString('base64')
const WA = { rpID: 'localhost', rpName: 'Mandate', origins: ['http://127.0.0.1:8787'] }

describe('phase guards', () => {
  it('redacts a canary and a bearer token', () => {
    const text = redactText(`failed ${CANARY} Bearer owner-key-should-not-leak`, [CANARY])
    expect(text).not.toContain(CANARY)
    expect(text).not.toContain('owner-key-should-not-leak')
    expect(text).toContain('[redacted]')
  })

  it('limits auth attempts with an injected clock', () => {
    let at = 0
    const limiter = new RateLimiter(() => at)
    for (let i = 0; i < 5; i += 1) expect(limiter.take({ className: 'auth', ip: '1.1.1.1', principal: 'a' }).ok).toBe(true)
    const blocked = limiter.take({ className: 'auth', ip: '1.1.1.1', principal: 'a' })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.retryAfter).toBeGreaterThan(0)
    at = 61_000
    expect(limiter.take({ className: 'auth', ip: '1.1.1.1', principal: 'a' }).ok).toBe(true)
  })

  it('does not call the model when the budget is zero', async () => {
    const h = harness()
    const budget = new ModelBudget({ globalDailyTokens: 0, workspaceDailyTokens: 0, maxOutputTokens: 32, maxSteps: 1 }, () => NOW)
    const agents = new AgentService(h.services, { name: 'spy', model: {} as never, provider: 'ollama' }, () => NOW, null, null, budget)
    await expect(agents.studioTurn({} as never, OWNER, { onEvent() {} })).rejects.toMatchObject({ code: 'budget/exhausted' })
    expect(budget.snapshot().calls).toBe(0)
    expect(agents.enabled).toBe(false)
  })

  it('refuses a migration whose checksum changed', () => {
    const db = openDatabase(':memory:')
    applySqlSteps(db, [{ id: 't', sql: 'CREATE TABLE phase_mark (id TEXT)' }])
    expect(() => applySqlSteps(db, [{ id: 't', sql: 'CREATE TABLE phase_mark (id TEXT, n INT)' }])).toThrow(/checksum changed: t/)
    db.close()
  })

  it('sends the extra security headers and the health alias', async () => {
    const h = harness({ redact: [CANARY] })
    const health = await h.app.request('http://mandate.test/healthz')
    expect(health.status).toBe(200)
    expect(health.headers.get('permissions-policy')).toContain('publickey-credentials-get')
    expect(health.headers.get('content-security-policy')).toContain("default-src 'none'")
    const off = await call(h.app, 'POST', '/demo/start')
    expect(off.status).toBe(404)
    expect(off.json.code).toBe('flag/disabled')
  })

  it('serves metrics only to the admin key', async () => {
    const h = harness({ adminKey: 'admin-key-not-a-secret-32' })
    expect((await call(h.app, 'GET', '/ops/metrics')).status).toBe(401)
    const ok = await h.app.request('http://mandate.test/ops/metrics', { headers: { authorization: 'Bearer admin-key-not-a-secret-32' } })
    expect(ok.status).toBe(200)
    const body = await ok.json() as { requests: number }
    expect(body.requests).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toContain(OWNER_KEY)
  })
})

describe('workspaces, passkeys, and demo', () => {
  it('isolates a demo, rejects a bad id, and will not delete a studio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-phase-'))
    const template = join(dir, 'template.sqlite')
    const templateDb = openDatabase(template)
    migrate(templateDb)
    seed(templateDb, NOW)
    templateDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    templateDb.close()
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-test')
    control.ensureDefault(':memory:', NOW.toISOString())
    const flags = loadFlags({ FLAG_TENANCY: '1', DEMO_ENABLED: '1', FLAG_PASSKEYS: '1', FLAG_INVITES: '1' })
    const registry = new TenantRegistry((id) => {
      const row = control.workspace(id)
      if (!row?.signing_key_sealed) return null
      const db = openDatabase(row.db_path)
      migrate(db)
      const paypal = new FakePayPal()
      const signer = loadSigner({ pem: openSeal(MASTER, row.signing_key_sealed), production: false })
      const built = createApp({
        db,
        paypal,
        signer,
        now: () => NOW,
        nested: true,
        control,
        workspace: { id, mode: row.mode },
        services: buildServices({ db, paypal, now: () => NOW, signer }),
        config: {
          apiKey: 'tenant-owner-key-32chars',
          rateLimitPerMinute: 0,
          paypalConfigured: true,
          log: false,
          publicUrl: 'http://127.0.0.1:8787',
          flags,
          webauthn: WA,
        },
      })
      return { id, fetch: (request) => built.fetch(request), close: () => db.close() }
    })
    const h = harness({ flags, control, registry, masterKey: MASTER, demo: { root: dir, template }, webauthn: WA })
    const started = await h.app.request('http://mandate.test/demo/start', { method: 'POST' })
    expect(started.status).toBe(200)
    const body = await started.json() as { workspaceId: string }
    const cookie = started.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('mnd_session=')
    const mine = await h.app.request(`http://mandate.test/w/${body.workspaceId}/v1/session`, { headers: { cookie: cookie ?? '' } })
    expect(mine.status).toBe(200)
    const other = await h.app.request('http://mandate.test/w/ws_default/v1/today', { headers: { cookie: cookie ?? '' } })
    expect(other.status).toBe(404)
    const bad = await h.app.request('http://mandate.test/w/ws_not_a_workspace/v1/session')
    expect(bad.status).toBe(400)
    const studioId = 'ws_abcdefghijklmnopqrst'
    control.insertWorkspace({
      id: studioId, slug: studioId, name: 'Kept', mode: 'studio', paypal_mode: 'fake', db_path: join(dir, 'kept.sqlite'),
      status: 'active', created_at: '2020-01-01T00:00:00.000Z', expires_at: '2020-01-02T00:00:00.000Z', last_active_at: '2020-01-01T00:00:00.000Z', signing_key_sealed: null,
    })
    expect(control.deleteDemo(studioId)).toBe(false)
    expect(control.workspace(studioId)?.mode).toBe('studio')
    expect(control.deleteDemo(body.workspaceId)).toBe(true)
    controlDb.close()
  })

  it('registers a passkey and signs in with it', async () => {
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-test')
    control.ensureDefault(':memory:', NOW.toISOString())
    const memberId = randomUUID()
    control.addMember({ id: memberId, workspaceId: 'ws_default', name: 'Meera', role: 'owner', now: NOW.toISOString() })
    const token = 'session-token-for-register-test-32'
    control.putSession({ token, memberId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const flags = loadFlags({ FLAG_PASSKEYS: '1' })
    const h = harness({ flags, control, webauthn: WA })
    const options = await h.app.request('http://mandate.test/auth/register/options', { method: 'POST', headers: { cookie: `mnd_session=${token}` } })
    expect(options.status).toBe(200)
    const started = await options.json() as { challengeId: string; options: { challenge: string } }
    const auth = new SoftAuthenticator('http://127.0.0.1:8787', 'localhost')
    const verified = await h.app.request('http://mandate.test/auth/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: started.challengeId, response: auth.register(started.options.challenge) }),
    })
    expect(verified.status).toBe(200)
    const loginOptions = await h.app.request('http://mandate.test/auth/login/options', { method: 'POST' })
    const login = await loginOptions.json() as { challengeId: string; options: { challenge: string } }
    const signed = await h.app.request('http://mandate.test/auth/login/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: login.challengeId, response: auth.authenticate(login.options.challenge) }),
    })
    expect(signed.status).toBe(200)
    const session = signed.headers.get('set-cookie') ?? ''
    const me = await h.app.request('http://mandate.test/auth/me', { headers: { cookie: session.split(';')[0] ?? '' } })
    expect(me.status).toBe(200)
    const who = await me.json() as { displayName: string }
    expect(who.displayName).toBe('Meera')
    const again = await h.app.request('http://mandate.test/auth/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: started.challengeId, response: auth.register(started.options.challenge) }),
    })
    expect(again.status).toBe(401)
    controlDb.close()
  })
})

describe('payee book and the toolkit wrapper', () => {
  it('never turns a refusal into an approval', () => {
    fc.assert(fc.property(
      fc.constantFrom('DENY' as const, 'AUTO' as const, 'NEEDS_APPROVAL' as const),
      fc.constantFrom('missing' as const, 'pending' as const, 'active' as const, 'disabled' as const),
      (gate, status) => {
        const next = applyPayeeBook({ gate, clause: 'standing.matched', detail: 'ok' }, { status, changePending: false, waitUntil: null })
        if (gate === 'DENY') expect(next.gate).toBe('DENY')
      },
    ))
    const paused = applyPause({ gate: 'DENY', clause: 'payee.unknown', detail: 'no' }, { ...NOT_PAUSED, paused: true, reason: 'odd', by: 'breaker', since: NOW.toISOString(), epoch: 1 }, 'owner')
    expect(paused.gate).toBe('DENY')
    expect(paused.clause).toBe('payee.unknown')
  })

  it('removes an unknown tool and forwards propose', async () => {
    const posted: Array<{ path: string; body: unknown }> = []
    const client = {
      post: async (path: string, body: unknown) => {
        posted.push({ path, body })
        return { status: 200, id: 'prop_123' }
      },
    }
    const wrapped = withMandate({
      get_rules: async () => 'rules',
      propose: async () => 'local',
    }, { client })
    expect(await wrapped.get_rules!({})).toBe('rules')
    const res = await wrapped.propose!({ amountCents: 500, payee: 'alice' })
    expect(res).toEqual({ status: 200, id: 'prop_123' })
    expect(posted).toEqual([
      { path: '/v1/proposals', body: { amountCents: 500, payee: 'alice' } },
    ])
    expect(() => withMandate({ pay: async () => 'no' }, { client })).toThrow(/unknown tool: pay/)

    // Read tier drops when exposeRead is false
    const dropped = withMandate({ get_rules: async () => 'rules', propose: async () => 'p' }, { client, exposeRead: false })
    expect(dropped.get_rules).toBeUndefined()
    expect(dropped.propose).toBeDefined()

    // Also supports custom propose callback
    const seen: string[] = []
    const legacy = withMandate({ propose: async () => 'local' }, { propose: async (name) => { seen.push(name); return 'asked' } })
    expect(await legacy.propose!({})).toBe('asked')
    expect(seen).toEqual(['propose'])
  })
})

describe('simulate, payees, and boot', () => {
  it('tries a payment without writing a row', async () => {
    const h = harness({ flags: loadFlags({ FLAG_PAYEE_BOOK: '1' }) })
    const before = (await call(h.app, 'GET', '/v1/proposals')).json.data.length
    const sim = await call(h.app, 'POST', '/v1/rules/simulate', {
      body: { request: { kind: 'payment', payee: 'Priya', amountCents: 1000, currency: 'USD', category: 'design', description: 'Sim', evidenceUrl: EVIDENCE, jobId: JOB } },
    })
    expect(sim.status).toBe(200)
    expect(sim.json.wrote).toBe(false)
    expect(sim.json.verdict.live.gate).toBeTruthy()
    expect((await call(h.app, 'GET', '/v1/proposals')).json.data.length).toBe(before)
    const book = await call(h.app, 'GET', '/v1/payees')
    expect(book.status).toBe(200)
    expect(book.json.payees.some((row: { email: string }) => row.email === 'priya.shah@example.com')).toBe(true)
    expect((await call(h.app, 'GET', '/v1/payees', { key: STUDIO_KEY })).status).toBe(403)
  })

  it('stays a single studio when the flags are off', () => {
    const opened = openProduct({ databasePath: ':memory:', flags: loadFlags({}), env: {}, publicUrl: 'http://127.0.0.1:8787', now: () => NOW, nodeEnv: 'test' })
    expect(opened.control).toBeNull()
    expect(opened.registry).toBeNull()
    opened.close()
  })

  it('refuses workspaces without the new secrets', () => {
    expect(() => openProduct({
      databasePath: ':memory:',
      flags: loadFlags({ FLAG_TENANCY: '1' }),
      env: {},
      publicUrl: 'http://127.0.0.1:8787',
      now: () => NOW,
      nodeEnv: 'test',
    })).toThrow(/MASTER_KEY/)
  })
})
