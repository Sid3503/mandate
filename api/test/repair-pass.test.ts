import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { openProduct } from '../src/boot'
import { AgentService } from '../src/agents/service'
import { ControlStore } from '../src/control/store'
import { migrate, openDatabase, seed } from '../src/db/database'
import { loadSigner } from '../src/domain/signing'
import { loadFlags } from '../src/flags'
import { clientIp, proxyHops } from '../src/ops/client-ip'
import { capsFromEnv, ModelBudget, OPEN_CAPS } from '../src/ops/budget'
import { API_CSP } from '../src/ops/headers'
import { pruneBuckets, RateLimiter } from '../src/ops/ratelimit'
import { WEB_CSP, webAsset } from '../src/http/web'
import { FakePayPal } from '../src/paypal/fake'
import { buildServices } from '../src/services/container'
import { OWNER } from '../src/services/principal'
import { openSeal, seal } from '../src/tenancy/envelope'
import { TenantRegistry } from '../src/tenancy/registry'
import { scriptedModel } from './mockModel'
import { agree, call, closeAll, collect, EVIDENCE, harness, JOB, NOW, OWNER_KEY } from './support'

afterEach(closeAll)

const MASTER = Buffer.alloc(32, 7).toString('base64')
const WA = { rpID: 'localhost', rpName: 'Mandate', origins: ['http://127.0.0.1:8787'] }
const OUTSIDE = 'OUTSIDE_WEB_ROOT_SECRET'

function headers(value: string) {
  return { get: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? value : null) }
}

describe('client ip', () => {
  it('counts hops from the right and refuses a value that is not an ip', () => {
    expect(proxyHops(undefined)).toBe(1)
    expect(proxyHops('')).toBe(1)
    expect(proxyHops('0')).toBe(1)
    expect(proxyHops('nope')).toBe(1)
    expect(proxyHops('9')).toBe(8)
    expect(clientIp(headers('203.0.113.9, 198.51.100.10, 192.0.2.1'), true, 2)).toBe('198.51.100.10')
    expect(clientIp(headers('spoof, real, proxyA'), true, 2)).toBe('direct')
    expect(clientIp(headers('x'), true, 2)).toBe('direct')
    expect(clientIp(headers('not-an-ip, 203.0.113.8'), true, 2)).toBe('direct')
    expect(clientIp(headers('spoofed, proxy'), true, 2)).toBe('direct')
    expect(clientIp(headers('1.2.3.4, 203.0.113.9'), false, 1)).toBe('direct')
  })

  it('groups ipv6 by /64', () => {
    const left = clientIp(headers('2001:db8:1:2::1'), true, 1)
    const right = clientIp(headers('2001:db8:1:2:ffff::abcd'), true, 1)
    const other = clientIp(headers('2001:db8:9:9::1'), true, 1)
    expect(left).toBe('2001:db8:1:2::/64')
    expect(right).toBe(left)
    expect(other).not.toBe(left)
  })
})

describe('rate buckets', () => {
  it('drops expired windows and caps how many buckets stay in memory', () => {
    const map = new Map<string, { count: number; reset: number; lockedUntil?: number }>([
      ['old', { count: 1, reset: 10 }],
      ['early', { count: 1, reset: 50 }],
      ['live', { count: 1, reset: 200 }],
    ])
    pruneBuckets(map, 10, 1)
    expect(map.has('old')).toBe(false)
    expect(map.size).toBe(1)
    expect(map.has('early')).toBe(false)
    expect(map.has('live')).toBe(true)
    let at = 0
    const limiter = new RateLimiter(() => at, 1)
    expect(limiter.take({ className: 'write', ip: '203.0.113.1', principal: 'a' }).ok).toBe(true)
    at = 60_000
    expect(limiter.take({ className: 'write', ip: '203.0.113.1', principal: 'b' }).ok).toBe(true)
    expect(limiter.take({ className: 'write', ip: '203.0.113.1', principal: 'a' }).ok).toBe(true)
  })

  it('counts wrong keys on the client ip and still accepts the real key', async () => {
    const h = harness({ rateLimitPerMinute: 5, trustProxy: false })
    for (let n = 1; n <= 5; n += 1) {
      const guess = `guess-repair-key-${n}-xxxxxxxx`
      const denied = await h.app.request('http://mandate.test/v1/session', {
        headers: { authorization: `Bearer ${guess}`, 'x-forwarded-for': `198.51.100.${n}` },
      })
      expect(denied.status).toBe(401)
      expect(await denied.text()).not.toContain(guess)
    }
    const sixth = `guess-repair-key-6-xxxxxxxx`
    const limited = await h.app.request('http://mandate.test/v1/session', {
      headers: { authorization: `Bearer ${sixth}`, 'x-forwarded-for': '203.0.113.9' },
    })
    expect(limited.status).toBe(429)
    const body = await limited.text()
    expect(body).toContain('rate.limited')
    expect(body).not.toContain(sixth)
    const later = await h.app.request('http://mandate.test/v1/session', {
      headers: { authorization: 'Bearer guess-repair-key-7-xxxxxxxx' },
    })
    expect(later.status).toBe(429)
    expect((await call(h.app, 'GET', '/v1/session')).status).toBe(200)
  })
})

describe('demo cap', () => {
  function desk(trustProxy: boolean, hops = 1) {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-repair-'))
    const template = join(dir, 'template.sqlite')
    const templateDb = openDatabase(template)
    migrate(templateDb)
    seed(templateDb, NOW)
    templateDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    templateDb.close()
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-repair')
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
          trustProxy,
          trustedProxyHops: hops,
        },
      })
      return { id, fetch: (request) => built.fetch(request), close: () => db.close() }
    })
    const h = harness({ flags, control, registry, masterKey: MASTER, demo: { root: dir, template }, webauthn: WA, trustProxy, trustedProxyHops: hops })
    return { ...h, control, dir }
  }

  async function start(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, forwarded?: string) {
    return app.request('http://mandate.test/demo/start', {
      method: 'POST',
      headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    })
  }

  it('shares one direct bucket when the proxy is not trusted', async () => {
    const h = desk(false)
    for (let n = 0; n < 5; n += 1) expect((await start(h.app, `198.51.100.${n}, 203.0.113.9`)).status).toBe(200)
    expect((await start(h.app, '203.0.113.50')).status).toBe(429)
  })

  it('gives two real addresses their own five demos', async () => {
    const h = desk(true, 1)
    for (let n = 0; n < 5; n += 1) expect((await start(h.app, `spoof-${n}, 203.0.113.9`)).status).toBe(200)
    const blocked = await start(h.app, 'spoof-again, 203.0.113.9')
    expect(blocked.status).toBe(429)
    expect((await blocked.json() as { code: string }).code).toBe('rate/limited')
    expect((await start(h.app, 'spoof, 198.51.100.10')).status).toBe(200)
  })

  it('with two trusted hops the client is the address two from the right', async () => {
    const h = desk(true, 2)
    for (let n = 0; n < 5; n += 1) expect((await start(h.app, `203.0.113.${n}, 198.51.100.10, 192.0.2.1`)).status).toBe(200)
    expect((await start(h.app, '203.0.113.9, 198.51.100.10, 192.0.2.1')).status).toBe(429)
    expect((await start(h.app, '198.51.100.10, 203.0.113.50, 192.0.2.1')).status).toBe(200)
  })
})

describe('model budget', () => {
  it('keeps the public defaults unless an env var is a whole number', () => {
    expect(OPEN_CAPS.globalDailyTokens).toBe(500_000)
    expect(OPEN_CAPS.workspaceDailyTokens).toBe(30_000)
    expect(capsFromEnv({}).globalDailyTokens).toBe(500_000)
    expect(capsFromEnv({ MODEL_GLOBAL_DAILY_TOKENS: 'nope' }).globalDailyTokens).toBe(500_000)
    expect(capsFromEnv({ MODEL_WORKSPACE_DAILY_TOKENS: '90000' }).workspaceDailyTokens).toBe(90_000)
    const paused = new ModelBudget(OPEN_CAPS, () => NOW)
    paused.reserve()
    paused.correct(0, 30_000)
    expect(paused.reserve()).toBeTruthy()
    const zero = new ModelBudget({ ...OPEN_CAPS, globalDailyTokens: 0 }, () => NOW)
    expect(zero.reserve()).toBeTruthy()
  })

  it('replaces the reserve with the provider usage and keeps both across a restart', async () => {
    const model = scriptedModel(() => ({ text: 'hello from the script' }))
    const budget = new ModelBudget(OPEN_CAPS, () => NOW)
    const h = harness({ model, budget })
    const agents = new AgentService(h.services, model, () => NOW, null, null, budget)
    await agents.studioTurn({ input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, OWNER, { onEvent: () => undefined })
    expect(model.calls()).toBe(1)
    expect(budget.snapshot()).toMatchObject({ calls: 1, tokensIn: 10, tokensOut: 5 })
    const dir = mkdtempSync(join(tmpdir(), 'mandate-budget-'))
    const path = join(dir, 'ledger.sqlite')
    const db = openDatabase(path)
    migrate(db)
    const first = openProduct({ databasePath: path, ledger: db, flags: loadFlags({}), env: {}, publicUrl: 'http://127.0.0.1:8787', now: () => NOW, nodeEnv: 'test' })
    expect(first.budget.reserve()).toBeNull()
    first.budget.correct(1200, 800)
    expect(first.budget.snapshot()).toMatchObject({ calls: 1, tokensIn: 1200, tokensOut: 800 })
    db.close()
    const again = openDatabase(path)
    const second = openProduct({ databasePath: path, ledger: again, flags: loadFlags({}), env: {}, publicUrl: 'http://127.0.0.1:8787', now: () => NOW, nodeEnv: 'test' })
    expect(second.budget.snapshot()).toMatchObject({ calls: 1, tokensIn: 1200, tokensOut: 800, killed: false })
    second.budget.kill()
    again.close()
    const thirdDb = openDatabase(path)
    const third = openProduct({ databasePath: path, ledger: thirdDb, flags: loadFlags({ MODEL_ENABLED: '1' }), env: {}, publicUrl: 'http://127.0.0.1:8787', now: () => NOW, nodeEnv: 'test' })
    expect(third.budget.stopped).toBe(true)
    expect(third.budget.reserve()).toBeTruthy()
    thirdDb.close()
    const off = openDatabase(path + '.off')
    migrate(off)
    const paused = openProduct({ databasePath: path + '.off', ledger: off, flags: loadFlags({ MODEL_ENABLED: '0' }), env: {}, publicUrl: 'http://127.0.0.1:8787', now: () => NOW, nodeEnv: 'test' })
    expect(paused.budget.stopped).toBe(true)
    off.close()
    const onDb = openDatabase(path + '.off')
    const on = openProduct({ databasePath: path + '.off', ledger: onDb, flags: loadFlags({ MODEL_ENABLED: '1' }), env: {}, publicUrl: 'http://127.0.0.1:8787', now: () => NOW, nodeEnv: 'test' })
    expect(on.budget.stopped).toBe(false)
    expect(on.budget.reserve()).toBeNull()
    onDb.close()
  })

  it('a kill stops the clerk path and a drafter that already has a model', async () => {
    const model = scriptedModel(() => ({ text: 'should not run' }))
    const drafter = scriptedModel(() => ({ text: 'should not draft' }))
    const budget = new ModelBudget(OPEN_CAPS, () => NOW)
    const h = harness({ model, budget, adminKey: 'admin-repair-key-32chars' })
    const killed = await h.app.request('http://mandate.test/ops/model/kill', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-repair-key-32chars' },
    })
    expect(killed.status).toBe(200)
    const agents = new AgentService(h.services, model, () => NOW, drafter, null, budget)
    await expect(agents.studioTurn({ input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, OWNER, { onEvent: () => undefined })).rejects.toMatchObject({ code: 'budget/exhausted' })
    await expect(agents.draftRules('lower the cap', OWNER)).rejects.toMatchObject({ code: 'budget/exhausted' })
    expect(model.calls()).toBe(0)
    expect(drafter.calls()).toBe(0)
  })
})

describe('static files and security headers', () => {
  it('refuses paths that leave the web build and still serves a file inside it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mandate-web-'))
    const dist = join(root, 'dist')
    mkdirSync(dist)
    writeFileSync(join(dist, 'index.html'), '<p>inside index</p>')
    writeFileSync(join(dist, 'note.txt'), 'inside-file')
    writeFileSync(join(root, 'secret.txt'), OUTSIDE)
    const paths = ['/app/../secret.txt', '/app/%2e%2e/secret.txt', '/app/%2e%2e%2f', '/app/..\\secret.txt', '/app/%00note.txt']
    for (const path of paths) {
      expect(webAsset(dist, path), path).toBeNull()
    }
    expect(webAsset(dist, '/app/note.txt')?.body.toString()).toContain('inside-file')
    const h = harness({ webDist: dist })
    // The URL parser resolves "/app/%2e%2e/secret" to "/secret" before Hono. These are the forms that still arrive under /app.
    const httpPaths = ['/app/%2e%2e%2f', '/app/%5csecret.txt', '/app/%00note.txt', '/app/..%2fsecret.txt', '/app/%252e%252e/secret.txt']
    for (const path of httpPaths) {
      const response = await h.app.request(`http://mandate.test${path}`)
      expect([400, 404], path).toContain(response.status)
      expect(await response.text(), path).not.toContain(OUTSIDE)
    }
    const collapsed = await h.app.request('http://mandate.test/app/%2e%2e/secret.txt')
    expect(collapsed.status).not.toBe(200)
    expect(await collapsed.text()).not.toContain(OUTSIDE)
    const file = await h.app.request('http://mandate.test/app/note.txt')
    expect(file.status).toBe(200)
    expect(await file.text()).toContain('inside-file')
    const page = await h.app.request('http://mandate.test/app/')
    expect(page.headers.get('content-security-policy')).toBe(WEB_CSP)
    expectSecurity(page.headers, WEB_CSP)
    const api = await h.app.request('http://mandate.test/v1/session', { headers: { authorization: `Bearer ${OWNER_KEY}` } })
    expect(api.status).toBe(200)
    expectSecurity(api.headers, API_CSP)
    const auth = await h.app.request('http://mandate.test/auth/me')
    expect(auth.status).toBe(401)
    expectSecurity(auth.headers, API_CSP)
  })
})

function expectSecurity(headers: Headers, csp: string) {
  expect(headers.get('content-security-policy')).toBe(csp)
  expect(headers.get('x-content-type-options')).toBe('nosniff')
  expect(headers.get('referrer-policy')).toBe('no-referrer')
  expect(headers.get('x-frame-options')).toBe('DENY')
  expect(headers.get('permissions-policy')).toContain('camera=()')
  expect(headers.get('cross-origin-opener-policy')).toBe('same-origin')
  expect(headers.get('cross-origin-resource-policy')).toBe('same-origin')
}

describe('sessions, invites, and demo doors', () => {
  function people() {
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-repair')
    control.ensureDefault(':memory:', NOW.toISOString())
    return { controlDb, control }
  }

  it('rejects a cookie write from the wrong origin or without the web client header', async () => {
    const { control } = people()
    const memberId = randomUUID()
    control.addMember({ id: memberId, workspaceId: 'ws_default', name: 'Meera', role: 'owner', now: NOW.toISOString() })
    const token = 'repair-session-token-32chars-ok'
    control.putSession({ token, memberId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const h = harness({ control, webauthn: WA })
    const cookie = `mnd_session=${token}`
    const wrong = await h.app.request('http://mandate.test/v1/safety/pause', {
      method: 'POST',
      headers: { cookie, origin: 'http://evil.example', 'x-mandate-client': 'web' },
    })
    expect(wrong.status).toBe(403)
    const bare = await h.app.request('http://mandate.test/v1/safety/pause', {
      method: 'POST',
      headers: { cookie, origin: 'http://127.0.0.1:8787' },
    })
    expect(bare.status).toBe(403)
    const ok = await h.app.request('http://mandate.test/v1/safety/pause', {
      method: 'POST',
      headers: { cookie, origin: 'http://127.0.0.1:8787', 'x-mandate-client': 'web' },
    })
    expect(ok.status).toBe(200)
  })

  it('uses a recovery code once and that session cannot pause', async () => {
    const { control } = people()
    const memberId = randomUUID()
    control.addMember({ id: memberId, workspaceId: 'ws_default', name: 'Meera', role: 'owner', now: NOW.toISOString() })
    control.saveRecovery(memberId, ['recovery-code-one'])
    const flags = loadFlags({ FLAG_PASSKEYS: '1' })
    const h = harness({ control, flags, webauthn: WA })
    const used = await h.app.request('http://mandate.test/auth/recovery/use', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId, code: 'recovery-code-one' }),
    })
    expect(used.status).toBe(200)
    const cookie = (used.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const again = await h.app.request('http://mandate.test/auth/recovery/use', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId, code: 'recovery-code-one' }),
    })
    expect(again.status).toBe(401)
    const me = await h.app.request('http://mandate.test/auth/me', { headers: { cookie } })
    expect(me.status).toBe(200)
    const pause = await h.app.request('http://mandate.test/v1/safety/pause', {
      method: 'POST',
      headers: { cookie, origin: 'http://127.0.0.1:8787', 'x-mandate-client': 'web' },
    })
    expect(pause.status).toBe(403)
    expect((await pause.json() as { code: string }).code).toBe('auth/forbidden')
  })

  it('drops a revoked member session and will not remove the last owner', async () => {
    const { control } = people()
    const ownerId = randomUUID()
    const viewerId = randomUUID()
    control.addMember({ id: ownerId, workspaceId: 'ws_default', name: 'Meera', role: 'owner', now: NOW.toISOString() })
    control.addMember({ id: viewerId, workspaceId: 'ws_default', name: 'Guest', role: 'viewer', now: NOW.toISOString() })
    const ownerToken = 'owner-session-token-32chars-ok'
    const viewerToken = 'viewer-session-token-32chars'
    control.putSession({ token: ownerToken, memberId: ownerId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    control.putSession({ token: viewerToken, memberId: viewerId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    expect(control.revokeMember(viewerId, NOW.toISOString())).toBe('ok')
    expect(control.setMemberRole(ownerId, 'viewer', NOW.toISOString())).toBe('last-owner')
    expect(control.revokeMember(ownerId, NOW.toISOString())).toBe('last-owner')
    const h = harness({ control, webauthn: WA })
    expect((await h.app.request('http://mandate.test/auth/me', { headers: { cookie: `mnd_session=${viewerToken}` } })).status).toBe(401)
    expect((await h.app.request('http://mandate.test/auth/me', { headers: { cookie: `mnd_session=${ownerToken}` } })).status).toBe(200)
  })

  it('does not burn an invite on the wrong studio, and a used, expired, or revoked invite fails', async () => {
    const h = desk(false)
    const studioId = 'ws_abcdefghijklmnopqrst'
    const dbPath = join(h.dir, `${studioId}.sqlite`)
    const { copyFileSync } = await import('node:fs')
    copyFileSync(join(h.dir, 'template.sqlite'), dbPath)
    const { privateKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    h.control.insertWorkspace({
      id: studioId, slug: studioId, name: 'Other', mode: 'studio', paypal_mode: 'fake', db_path: dbPath,
      status: 'active', created_at: NOW.toISOString(), expires_at: null, last_active_at: NOW.toISOString(),
      signing_key_sealed: seal(MASTER, pem),
    })
    const token = 'invite-token-for-studio-a-32'
    h.control.createInvite({ id: randomUUID(), workspaceId: studioId, role: 'proposer', token, expiresAt: '2027-01-01T00:00:00.000Z', createdBy: 'test', now: NOW.toISOString() })
    const wrong = await h.app.request('http://mandate.test/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, name: 'Sam' }),
    })
    expect(wrong.status).toBe(400)
    expect(h.control.peekInvite(token, NOW.toISOString())?.workspace_id).toBe(studioId)
    const joined = await h.app.request(`http://mandate.test/w/${studioId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, name: 'Sam' }),
    })
    expect(joined.status).toBe(200)
    const second = await h.app.request(`http://mandate.test/w/${studioId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, name: 'Sam again' }),
    })
    expect(second.status).toBe(400)
    const expired = 'invite-token-expired-32chars'
    h.control.createInvite({ id: randomUUID(), workspaceId: studioId, role: 'viewer', token: expired, expiresAt: '2020-01-01T00:00:00.000Z', createdBy: 'test', now: NOW.toISOString() })
    expect((await h.app.request(`http://mandate.test/w/${studioId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: expired, name: 'Late' }),
    })).status).toBe(400)
    const revoked = 'invite-token-revoked-32chars'
    const revokedId = randomUUID()
    h.control.createInvite({ id: revokedId, workspaceId: studioId, role: 'viewer', token: revoked, expiresAt: '2027-01-01T00:00:00.000Z', createdBy: 'test', now: NOW.toISOString() })
    h.controlDb.prepare('UPDATE invites SET revoked_at = ? WHERE id = ?').run(NOW.toISOString(), revokedId)
    expect((await h.app.request(`http://mandate.test/w/${studioId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: revoked, name: 'No' }),
    })).status).toBe(400)
    const missing = await h.app.request('http://mandate.test/v1/invites/revoke', { method: 'POST', headers: { authorization: `Bearer ${OWNER_KEY}` } })
    expect(missing.status).toBe(404)
  })

  it('lets one of two joins win', async () => {
    const h = desk(false)
    const token = 'invite-token-parallel-32chars'
    h.control.createInvite({ id: randomUUID(), workspaceId: 'ws_default', role: 'viewer', token, expiresAt: '2027-01-01T00:00:00.000Z', createdBy: 'test', now: NOW.toISOString() })
    const body = JSON.stringify({ token, name: 'Sam' })
    const [left, right] = await Promise.all([
      h.app.request('http://mandate.test/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
      h.app.request('http://mandate.test/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
    ])
    const statuses = [left.status, right.status].sort()
    expect(statuses).toEqual([200, 400])
  })

  it('rejects a workspace id that is not an id', async () => {
    const h = desk(false)
    writeFileSync(join(h.dir, 'secret.txt'), OUTSIDE)
    const bad = await h.app.request('http://mandate.test/w/not-a-workspace/v1/session')
    expect(bad.status).toBe(400)
    expect(await bad.text()).not.toContain(OUTSIDE)
    const dot = await h.app.request('http://mandate.test/w/..%2fsecret.txt/v1/session')
    expect(dot.status).toBe(400)
    expect(await dot.text()).not.toContain(OUTSIDE)
  })

  it('hashes table rows, so work in one studio does not change the other', async () => {
    const h = desk(false)
    const first = await h.app.request('http://mandate.test/demo/start', { method: 'POST' })
    const second = await h.app.request('http://mandate.test/demo/start', { method: 'POST' })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = (await first.json() as { workspaceId: string }).workspaceId
    const b = (await second.json() as { workspaceId: string }).workspaceId
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const pathB = h.control.workspace(b)?.db_path
    expect(pathB).toBeTruthy()
    const before = contentHash(pathB!)
    const asked = await h.app.request(`http://mandate.test/w/${a}/v1/proposals`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'idempotency-key': 'repair-case-24-key',
        origin: 'http://127.0.0.1:8787',
        'x-mandate-client': 'web',
      },
      body: JSON.stringify({ kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design', description: 'Only in A', evidenceUrl: EVIDENCE, jobId: JOB }),
    })
    expect(asked.status).toBe(201)
    expect(contentHash(pathB!)).toBe(before)
    expect(contentHash(h.control.workspace(a)!.db_path)).not.toBe(before)
  })

  it('hides demo doors on the default studio and ignores a demo tap there', async () => {
    const h = harness({ flags: loadFlags({ REQUIRE_PASSKEY_FOR_MONEY: '1' }) })
    expect((await call(h.app, 'POST', '/v1/demo/switch', { body: { role: 'owner' } })).status).toBe(404)
    expect((await call(h.app, 'POST', '/v1/demo/simulate', { body: { action: 'pay' } })).status).toBe(404)
    const current = (await call(h.app, 'GET', '/v1/warrant')).json as Record<string, unknown>
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    const published = await h.app.request('http://mandate.test/v1/warrant', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${OWNER_KEY}`,
        'content-type': 'application/json',
        'x-mandate-demo-tap': '1',
      },
      body: JSON.stringify(body),
    })
    expect(published.status).toBe(401)
    expect((await published.json() as { code: string }).code).toBe('auth/stepup-required')
  })
})

function desk(trustProxy: boolean, hops = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-repair-'))
  const template = join(dir, 'template.sqlite')
  const templateDb = openDatabase(template)
  migrate(templateDb)
  seed(templateDb, NOW)
  templateDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  templateDb.close()
  const controlDb = openDatabase(':memory:')
  const control = new ControlStore(controlDb, 'pepper-repair')
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
        trustProxy,
        trustedProxyHops: hops,
      },
    })
    return { id, fetch: (request) => built.fetch(request), close: () => db.close() }
  })
  const h = harness({ flags, control, registry, masterKey: MASTER, demo: { root: dir, template }, webauthn: WA, trustProxy, trustedProxyHops: hops })
  return { ...h, control, controlDb, dir }
}

function contentHash(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  const rows = [
    db.prepare('SELECT id, type, clause, payload_json, created_at FROM events ORDER BY id').all(),
    db.prepare('SELECT id, phase, gate, amount_cents, updated_at FROM proposals ORDER BY id').all(),
    db.prepare('SELECT id, version, body_json FROM warrants ORDER BY id, version').all(),
    db.prepare('SELECT party_id, version, body_json FROM party_rules ORDER BY party_id, version').all(),
  ]
  db.close()
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

describe('payee book', () => {
  it('holds a first payment and refuses one while a change is pending', async () => {
    const h = harness({ flags: loadFlags({ FLAG_PAYEE_BOOK: '1' }) })
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    const current = (await call(h.app, 'GET', '/v1/warrant')).json as Record<string, unknown>
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    const published = await call(h.app, 'PUT', '/v1/warrant', {
      body: { ...body, standing: [{ id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }] },
    })
    expect(published.status).toBe(201)
    h.db.prepare(`UPDATE payees SET status = 'pending' WHERE id = 'payee_priya'`).run()
    const request = { kind: 'payment', payee: 'Priya', amountCents: 9000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: paid.captureId }
    const pending = await call(h.app, 'POST', '/v1/rules/simulate', { body: { request } })
    expect(pending.status).toBe(200)
    expect(pending.json.verdict.live).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'payee.not_active' })
    h.db.prepare(`UPDATE payees SET status = 'active', verified_method = 'owner_attested', change_pending = 1, total_paid_cents = 0 WHERE id = 'payee_priya'`).run()
    const changed = await call(h.app, 'POST', '/v1/rules/simulate', { body: { request } })
    expect(changed.json.verdict.live).toMatchObject({ gate: 'DENY', clause: 'payee.change_pending' })
  })
})
