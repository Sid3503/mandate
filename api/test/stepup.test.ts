import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { passkeyRuleBinding } from '../src/auth/passkeys'
import { ControlStore } from '../src/control/store'
import { migrate, openDatabase, seed } from '../src/db/database'
import { loadSigner } from '../src/domain/signing'
import { loadFlags } from '../src/flags'
import { rateClass } from '../src/ops/ratelimit'
import { FakePayPal } from '../src/paypal/fake'
import { buildServices } from '../src/services/container'
import { openSeal } from '../src/tenancy/envelope'
import { TenantRegistry } from '../src/tenancy/registry'
import { call, closeAll, EVIDENCE, harness, JOB, NOW, type Requester } from './support'
import { SoftAuthenticator } from './soft-authenticator'

afterEach(closeAll)

const MASTER = Buffer.alloc(32, 4).toString('base64')
const WA = { rpID: 'localhost', rpName: 'Mandate', origins: ['http://127.0.0.1:8787'] }
const WEB = { origin: 'http://127.0.0.1:8787', 'x-mandate-client': 'web' }
const CHARGE = {
  kind: 'charge',
  payee: 'Northwind',
  amountCents: 15000,
  currency: 'USD',
  category: 'design',
  description: 'Northwind logo milestone 1 invoice',
  evidenceUrl: EVIDENCE,
  prompt: 'Bill Northwind $150 for logo milestone 1',
  jobId: JOB,
}

function moneyDesk() {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-p4-'))
  const template = join(dir, 'template.sqlite')
  const templateDb = openDatabase(template)
  migrate(templateDb)
  seed(templateDb, NOW)
  templateDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  templateDb.close()
  const controlDb = openDatabase(':memory:')
  const control = new ControlStore(controlDb, 'pepper-p4')
  control.ensureDefault(':memory:', NOW.toISOString())
  const flags = loadFlags({ FLAG_TENANCY: '1', DEMO_ENABLED: '1', FLAG_PASSKEYS: '1' })
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
  const app = harness({ flags, control, registry, masterKey: MASTER, demo: { root: dir, template }, webauthn: WA })
  return { ...app, control, controlDb }
}

async function ask(app: Requester, prefix: string, headers: Record<string, string>) {
  const created = await app.request(`http://mandate.test${prefix}/v1/proposals`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `p4-${randomUUID()}` },
    body: JSON.stringify(CHARGE),
  })
  const body = await created.json() as { id?: string; gate?: string }
  return { status: created.status, id: body.id, gate: body.gate }
}

describe('per-workspace passkey rule', () => {
  it('a new studio requires a passkey and the default studio does not', async () => {
    const h = moneyDesk()
    expect(h.control.workspace('ws_default')?.passkey_for_money).toBe(0)
    const home = await call(h.app, 'POST', '/v1/proposals', { body: CHARGE, idem: `p4-home-${randomUUID()}` })
    expect(home.status).toBe(201)
    const homeId = (home.json as { id: string }).id
    expect((await call(h.app, 'POST', `/v1/proposals/${homeId}/approve`)).status).toBe(200)

    const opened = await h.app.request('http://mandate.test/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'North Studio' }),
    })
    expect(opened.status).toBe(200)
    const studio = await opened.json() as { workspaceId: string; memberId: string }
    expect(h.control.workspace(studio.workspaceId)?.passkey_for_money).toBe(1)
    const token = 'studio-owner-session-token-32'
    h.control.putSession({ token, memberId: studio.memberId, workspaceId: studio.workspaceId, method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const headers = { ...WEB, cookie: `mnd_session=${token}` }
    const asked = await ask(h.app, `/w/${studio.workspaceId}`, headers)
    expect(asked.status).toBe(201)
    expect(asked.gate).toBe('NEEDS_APPROVAL')
    const approved = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/proposals/${asked.id}/approve`, { method: 'POST', headers })
    expect(approved.status).toBe(401)
    expect((await approved.json() as { code: string }).code).toBe('auth/stepup-required')
    h.controlDb.close()
  })

  it('a demo does not require a passkey', async () => {
    const h = moneyDesk()
    const started = await h.app.request('http://mandate.test/demo/start', { method: 'POST' })
    expect(started.status).toBe(200)
    const demo = await started.json() as { workspaceId: string; mode: string }
    expect(demo.mode).toBe('demo')
    expect(h.control.workspace(demo.workspaceId)?.passkey_for_money).toBe(0)
    const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const headers = { ...WEB, cookie }
    const asked = await ask(h.app, `/w/${demo.workspaceId}`, headers)
    expect(asked.status).toBe(201)
    const approved = await h.app.request(`http://mandate.test/w/${demo.workspaceId}/v1/proposals/${asked.id}/approve`, { method: 'POST', headers })
    expect(approved.status).toBe(200)
    h.controlDb.close()
  })

  it('turning the rule on for the default studio needs an enrolled passkey and a step-up', async () => {
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-p4')
    control.ensureDefault(':memory:', NOW.toISOString())
    const memberId = randomUUID()
    control.addMember({ id: memberId, workspaceId: 'ws_default', name: 'Meera', role: 'owner', now: NOW.toISOString() })
    const token = 'default-owner-session-token-32'
    control.putSession({ token, memberId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const flags = loadFlags({ FLAG_PASSKEYS: '1' })
    const h = harness({ flags, control, webauthn: WA })
    const headers = { ...WEB, cookie: `mnd_session=${token}`, 'content-type': 'application/json' }
    const bare = await h.app.request('http://mandate.test/v1/workspace/passkey-rule', {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: true }),
    })
    expect(bare.status).toBe(409)
    expect(control.workspace('ws_default')?.passkey_for_money).toBe(0)

    const options = await h.app.request('http://mandate.test/auth/register/options', { method: 'POST', headers })
    expect(options.status).toBe(200)
    const started = await options.json() as { challengeId: string; options: { challenge: string } }
    const auth = new SoftAuthenticator('http://127.0.0.1:8787', 'localhost')
    const registered = await h.app.request('http://mandate.test/auth/register/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ challengeId: started.challengeId, response: auth.register(started.options.challenge) }),
    })
    expect(registered.status).toBe(200)

    const withoutGrant = await h.app.request('http://mandate.test/v1/workspace/passkey-rule', {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: true }),
    })
    expect(withoutGrant.status).toBe(401)
    expect(control.workspace('ws_default')?.passkey_for_money).toBe(0)

    const binding = passkeyRuleBinding(true)
    const step = await h.app.request('http://mandate.test/auth/stepup/options', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'passkey-rule', binding }),
    })
    expect(step.status).toBe(200)
    const challenge = await step.json() as { challengeId: string; options: { challenge: string } }
    const verified = await h.app.request('http://mandate.test/auth/stepup/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ challengeId: challenge.challengeId, response: auth.authenticate(challenge.options.challenge) }),
    })
    expect(verified.status).toBe(200)
    const grant = (await verified.json() as { grant: string }).grant
    const turned = await h.app.request('http://mandate.test/v1/workspace/passkey-rule', {
      method: 'POST',
      headers: { ...headers, 'x-mandate-stepup': grant },
      body: JSON.stringify({ enabled: true }),
    })
    expect(turned.status).toBe(200)
    expect(control.workspace('ws_default')?.passkey_for_money).toBe(1)

    const proposed = await call(h.app, 'POST', '/v1/proposals', { body: CHARGE, idem: `p4-on-${randomUUID()}` })
    expect(proposed.status).toBe(201)
    const blocked = await call(h.app, 'POST', `/v1/proposals/${(proposed.json as { id: string }).id}/approve`)
    expect(blocked.status).toBe(401)
    expect((blocked.json as { code: string }).code).toBe('auth/stepup-required')
    controlDb.close()
  })

  it('leaves an older control file off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-p4-old-'))
    const path = join(dir, 'control.sqlite')
    const raw = openDatabase(path)
    raw.exec(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      mode TEXT NOT NULL,
      paypal_mode TEXT NOT NULL,
      db_path TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      last_active_at TEXT NOT NULL,
      signing_key_sealed TEXT
    )`)
    raw.prepare(`INSERT INTO workspaces (id, slug, name, mode, paypal_mode, db_path, status, created_at, expires_at, last_active_at, signing_key_sealed)
      VALUES ('ws_default', 'default', 'Line Studio', 'default', 'sandbox', ':memory:', 'active', ?, NULL, ?, NULL)`).run(NOW.toISOString(), NOW.toISOString())
    raw.close()
    const db = openDatabase(path)
    const control = new ControlStore(db, 'pepper-old')
    expect(control.workspace('ws_default')?.passkey_for_money).toBe(0)
    db.close()
  })
})

function ruledOwner() {
  const controlDb = openDatabase(':memory:')
  const control = new ControlStore(controlDb, 'pepper-p4')
  control.ensureDefault(':memory:', NOW.toISOString())
  control.setPasskeyForMoney('ws_default', true)
  const memberId = randomUUID()
  control.addMember({ id: memberId, workspaceId: 'ws_default', name: 'Meera', role: 'owner', now: NOW.toISOString() })
  const token = `owner-${randomUUID()}`
  control.putSession({ token, memberId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
  const h = harness({ flags: loadFlags({ FLAG_PASSKEYS: '1' }), control, webauthn: WA })
  const headers = { ...WEB, cookie: `mnd_session=${token}`, 'content-type': 'application/json' }
  return { h, control, controlDb, memberId, headers }
}

async function enroll(app: Requester, headers: Record<string, string>) {
  const options = await app.request('http://mandate.test/auth/register/options', { method: 'POST', headers })
  expect(options.status).toBe(200)
  const started = await options.json() as { challengeId: string; options: { challenge: string } }
  const auth = new SoftAuthenticator('http://127.0.0.1:8787', 'localhost')
  const saved = await app.request('http://mandate.test/auth/register/verify', {
    method: 'POST',
    headers,
    body: JSON.stringify({ challengeId: started.challengeId, response: auth.register(started.options.challenge) }),
  })
  expect(saved.status).toBe(200)
  const body = await saved.json() as { credentialId: string }
  return { auth, credentialId: body.credentialId }
}

async function proposeCharge(app: Requester) {
  const created = await call(app, 'POST', '/v1/proposals', { body: CHARGE, idem: `p4-${randomUUID()}` })
  expect(created.status).toBe(201)
  return (created.json as { id: string }).id
}

async function signApprove(app: Requester, headers: Record<string, string>, auth: SoftAuthenticator, proposalId: string, opts: Parameters<SoftAuthenticator['authenticate']>[1] = {}) {
  const step = await app.request('http://mandate.test/auth/stepup/options', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'approve', proposalId }),
  })
  const started = await step.json() as { challengeId?: string; options?: { challenge: string }; code?: string }
  if (step.status !== 200 || !started.challengeId || !started.options) return { status: step.status, grant: '', code: started.code ?? '' }
  const verified = await app.request('http://mandate.test/auth/stepup/verify', {
    method: 'POST',
    headers,
    body: JSON.stringify({ challengeId: started.challengeId, response: auth.authenticate(started.options.challenge, opts) }),
  })
  const body = await verified.json() as { grant?: string; code?: string }
  return { status: verified.status, grant: body.grant ?? '', code: body.code ?? '' }
}

describe('step-up grants', () => {
  it('a step-up assertion cannot be used twice', async () => {
    const { h, control, controlDb, headers } = ruledOwner()
    const { auth } = await enroll(h.app, headers)
    const id = await proposeCharge(h.app)
    const signed = await signApprove(h.app, headers, auth, id)
    expect(signed.status).toBe(200)
    const first = await h.app.request(`http://mandate.test/v1/proposals/${id}/approve`, { method: 'POST', headers: { ...headers, 'x-mandate-stepup': signed.grant } })
    expect(first.status).toBe(200)
    const second = await h.app.request(`http://mandate.test/v1/proposals/${id}/approve`, { method: 'POST', headers: { ...headers, 'x-mandate-stepup': signed.grant } })
    expect(second.status).toBe(401)
    controlDb.close()
    void control
  })

  it('an assertion bound to one cart hash does not approve another', async () => {
    const { h, controlDb, headers } = ruledOwner()
    const { auth } = await enroll(h.app, headers)
    const first = await proposeCharge(h.app)
    const second = await proposeCharge(h.app)
    const signed = await signApprove(h.app, headers, auth, first)
    expect(signed.status).toBe(200)
    const approved = await h.app.request(`http://mandate.test/v1/proposals/${second}/approve`, { method: 'POST', headers: { ...headers, 'x-mandate-stepup': signed.grant } })
    expect(approved.status).toBe(409)
    expect((await approved.json() as { title: string }).title).toBe('changed since you looked')
    expect((await call(h.app, 'GET', `/v1/proposals/${second}`)).json.phase).toBe('pending_approval')
    controlDb.close()
  })

  it('returns 409 changed since you looked when the stored cart moves', async () => {
    const { h, controlDb, headers } = ruledOwner()
    const { auth } = await enroll(h.app, headers)
    const id = await proposeCharge(h.app)
    const signed = await signApprove(h.app, headers, auth, id)
    h.db.prepare('UPDATE proposals SET amount_cents = amount_cents + 1 WHERE id = ?').run(id)
    const approved = await h.app.request(`http://mandate.test/v1/proposals/${id}/approve`, { method: 'POST', headers: { ...headers, 'x-mandate-stepup': signed.grant } })
    expect(approved.status).toBe(409)
    expect((await approved.json() as { title: string }).title).toBe('changed since you looked')
    expect((await call(h.app, 'GET', `/v1/proposals/${id}`)).json.phase).toBe('pending_approval')
    controlDb.close()
  })

  it('two parallel approves with one grant: one wins', async () => {
    const { h, controlDb, headers } = ruledOwner()
    const { auth } = await enroll(h.app, headers)
    const id = await proposeCharge(h.app)
    const signed = await signApprove(h.app, headers, auth, id)
    const send = () => h.app.request(`http://mandate.test/v1/proposals/${id}/approve`, { method: 'POST', headers: { ...headers, 'x-mandate-stepup': signed.grant } })
    const [left, right] = await Promise.all([send(), send()])
    expect([left.status, right.status].sort()).toEqual([200, 401])
    controlDb.close()
  })

  it('a grant expires after 120 seconds', async () => {
    const { h, control, controlDb, headers } = ruledOwner()
    const { auth } = await enroll(h.app, headers)
    const id = await proposeCharge(h.app)
    const signed = await signApprove(h.app, headers, auth, id)
    const row = control.grant(signed.grant)
    expect(row?.expires_at).toBe(new Date(NOW.getTime() + 120_000).toISOString())
    h.setNow(new Date(NOW.getTime() + 121_000))
    const approved = await h.app.request(`http://mandate.test/v1/proposals/${id}/approve`, { method: 'POST', headers: { ...headers, 'x-mandate-stepup': signed.grant } })
    expect(approved.status).toBe(401)
    controlDb.close()
  })

  it('a step-up with user verification off is refused', async () => {
    const { h, controlDb, headers } = ruledOwner()
    const { auth } = await enroll(h.app, headers)
    const id = await proposeCharge(h.app)
    const signed = await signApprove(h.app, headers, auth, id, { userVerified: false })
    expect(signed.status).toBe(401)
    controlDb.close()
  })

  it('a revoked passkey cannot sign a step-up', async () => {
    const { h, control, controlDb, headers } = ruledOwner()
    const { auth, credentialId } = await enroll(h.app, headers)
    control.forceRevokeCredential(credentialId, NOW.toISOString())
    const id = await proposeCharge(h.app)
    const signed = await signApprove(h.app, headers, auth, id)
    expect(signed.status).toBe(401)
    controlDb.close()
  })

  it('a passkey from another member cannot approve', async () => {
    const { h, control, controlDb, headers } = ruledOwner()
    await enroll(h.app, headers)
    const otherId = randomUUID()
    control.addMember({ id: otherId, workspaceId: 'ws_default', name: 'Arun', role: 'owner', now: NOW.toISOString() })
    const otherToken = `other-${randomUUID()}`
    control.putSession({ token: otherToken, memberId: otherId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const otherHeaders = { ...WEB, cookie: `mnd_session=${otherToken}`, 'content-type': 'application/json' }
    const { auth: other } = await enroll(h.app, otherHeaders)
    const id = await proposeCharge(h.app)
    const step = await h.app.request('http://mandate.test/auth/stepup/options', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'approve', proposalId: id }),
    })
    const started = await step.json() as { challengeId: string; options: { challenge: string } }
    const verified = await h.app.request('http://mandate.test/auth/stepup/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ challengeId: started.challengeId, response: other.authenticate(started.options.challenge) }),
    })
    expect(verified.status).toBe(401)
    controlDb.close()
  })

  it('a step-up from the wrong origin or relying party id is refused', async () => {
    const { h, controlDb, headers } = ruledOwner()
    const { auth } = await enroll(h.app, headers)
    const id = await proposeCharge(h.app)
    expect((await signApprove(h.app, headers, auth, id, { origin: 'https://evil.example' })).status).toBe(401)
    expect((await signApprove(h.app, headers, auth, id, { rpID: 'evil.example' })).status).toBe(401)
    controlDb.close()
  })

  it('a step-up counter that moves backwards revokes the passkey when another one exists', async () => {
    const { h, control, controlDb, headers } = ruledOwner()
    const first = await enroll(h.app, headers)
    const second = await enroll(h.app, headers)
    const id = await proposeCharge(h.app)
    expect((await signApprove(h.app, headers, first.auth, id)).status).toBe(200)
    expect((await signApprove(h.app, headers, first.auth, id)).status).toBe(200)
    const rolled = await signApprove(h.app, headers, first.auth, id, { counter: 1 })
    expect(rolled.status).toBe(401)
    expect(control.credential(first.credentialId)?.revoked_at).toBeTruthy()
    expect(control.credential(second.credentialId)?.revoked_at).toBeNull()
    controlDb.close()
  })

  it('a step-up counter that moves backwards marks the last passkey suspect and keeps it', async () => {
    const { h, control, controlDb, headers } = ruledOwner()
    const only = await enroll(h.app, headers)
    const id = await proposeCharge(h.app)
    expect((await signApprove(h.app, headers, only.auth, id)).status).toBe(200)
    expect((await signApprove(h.app, headers, only.auth, id)).status).toBe(200)
    expect((await signApprove(h.app, headers, only.auth, id, { counter: 1 })).status).toBe(401)
    const row = control.credential(only.credentialId)
    expect(row?.revoked_at).toBeNull()
    expect(row?.suspect_at).toBeTruthy()
    expect(control.events('ws_default').some((event) => event.event === 'passkey.counter' && event.result === 'suspect')).toBe(true)
    expect((await signApprove(h.app, headers, only.auth, id, { counter: 3 })).status).toBe(200)
    controlDb.close()
  })

  it('a login counter that moves backwards keeps the last passkey', async () => {
    const { h, control, controlDb, headers } = ruledOwner()
    const only = await enroll(h.app, headers)
    const id = await proposeCharge(h.app)
    expect((await signApprove(h.app, headers, only.auth, id)).status).toBe(200)
    expect((await signApprove(h.app, headers, only.auth, id)).status).toBe(200)
    const options = await h.app.request('http://mandate.test/auth/login/options', { method: 'POST' })
    const started = await options.json() as { challengeId: string; options: { challenge: string } }
    const signed = await h.app.request('http://mandate.test/auth/login/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ challengeId: started.challengeId, response: only.auth.authenticate(started.options.challenge, { counter: 1 }) }),
    })
    expect(signed.status).toBe(401)
    expect(control.credential(only.credentialId)?.revoked_at).toBeNull()
    expect(control.credential(only.credentialId)?.suspect_at).toBeTruthy()
    const again = await h.app.request('http://mandate.test/auth/login/options', { method: 'POST' })
    const next = await again.json() as { challengeId: string; options: { challenge: string } }
    const recovered = await h.app.request('http://mandate.test/auth/login/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ challengeId: next.challengeId, response: only.auth.authenticate(next.options.challenge, { counter: 3 }) }),
    })
    expect(recovered.status).toBe(200)
    controlDb.close()
  })

  it('an approver over their limit gets approval.over_limit', async () => {
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-p4')
    control.ensureDefault(':memory:', NOW.toISOString())
    const memberId = randomUUID()
    control.addMember({ id: memberId, workspaceId: 'ws_default', name: 'Approver', role: 'approver', now: NOW.toISOString(), limit: 1000 })
    const token = `approver-${randomUUID()}`
    control.putSession({ token, memberId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const h = harness({ control, webauthn: WA })
    const id = await proposeCharge(h.app)
    const approved = await h.app.request(`http://mandate.test/v1/proposals/${id}/approve`, {
      method: 'POST',
      headers: { ...WEB, cookie: `mnd_session=${token}` },
    })
    expect(approved.status).toBe(403)
    expect((await approved.json() as { code: string }).code).toBe('approval.over_limit')
    controlDb.close()
  })

  it('a cookie proposer cannot approve', async () => {
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-p4')
    control.ensureDefault(':memory:', NOW.toISOString())
    const memberId = randomUUID()
    control.addMember({ id: memberId, workspaceId: 'ws_default', name: 'Arun', role: 'proposer', now: NOW.toISOString() })
    const token = `proposer-${randomUUID()}`
    control.putSession({ token, memberId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const h = harness({ control, webauthn: WA })
    const id = await proposeCharge(h.app)
    const approved = await h.app.request(`http://mandate.test/v1/proposals/${id}/approve`, {
      method: 'POST',
      headers: { ...WEB, cookie: `mnd_session=${token}` },
    })
    expect(approved.status).toBe(403)
    controlDb.close()
  })

  it('puts step-up routes in the auth rate-limit class', async () => {
    expect(rateClass('POST', '/auth/stepup/options')).toBe('auth')
    expect(rateClass('POST', '/auth/stepup/verify')).toBe('auth')
    const h = harness({ classedRates: true, rateLimitPerMinute: 100, flags: loadFlags({ FLAG_PASSKEYS: '1' }), webauthn: WA })
    let status = 0
    for (let i = 0; i < 6; i += 1) {
      const response = await h.app.request('http://mandate.test/auth/stepup/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      status = response.status
    }
    expect(status).toBe(429)
  })
})
