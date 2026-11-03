import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bodyLimitFor, DEFAULT_BODY_LIMIT, LARGE_BODY_LIMIT } from '../src/app'
import { stepBinding } from '../src/auth/passkeys'
import { ControlStore, type MemberRole } from '../src/control/store'
import { migrate, openDatabase, seed } from '../src/db/database'
import { loadFlags } from '../src/flags'
import { onError } from '../src/http/problem'
import { redactPath } from '../src/ops/redact'
import { FakePayPal } from '../src/paypal/fake'
import { live, type LiveEvent } from '../src/services/live'
import { machineKeyHashKnown } from '../src/services/machine-key'
import { TenantRegistry } from '../src/tenancy/registry'
import { call, closeAll, EVIDENCE, harness, JOB, NOW, STUDIO_KEY } from './support'

afterEach(() => {
  vi.restoreAllMocks()
  closeAll()
})

const WA = { rpID: 'localhost', rpName: 'Mandate', origins: ['http://127.0.0.1:8787'] }
const WEB = { origin: 'http://127.0.0.1:8787', 'x-mandate-client': 'web' }
const MASTER = Buffer.alloc(32, 7).toString('base64')
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

/** A default studio with people in it, each signed in with a cookie. */
function people(roles: Record<string, MemberRole>, options: { flags?: Record<string, string>; method?: string } = {}) {
  const controlDb = openDatabase(':memory:')
  const control = new ControlStore(controlDb, 'pepper-hardening')
  control.ensureDefault(':memory:', NOW.toISOString())
  const now = NOW.toISOString()
  const members: Record<string, { id: string; token: string }> = {}
  for (const [name, role] of Object.entries(roles)) {
    const id = randomUUID()
    const token = `${name}-session-token-${randomUUID()}`
    control.addMember({ id, workspaceId: 'ws_default', name, role, now })
    control.putSession({ token, memberId: id, workspaceId: 'ws_default', method: options.method ?? 'passkey', now, idleHours: 12, absoluteDays: 7 })
    members[name] = { id, token }
  }
  const h = harness({ flags: loadFlags({ FLAG_PASSKEYS: '1', FLAG_INVITES: '1', ...options.flags }), control, webauthn: WA })
  const cookie = (name: string) => ({ cookie: `mnd_session=${members[name]!.token}`, ...WEB })
  return { h, control, controlDb, members, cookie }
}

describe('request body limit', () => {
  it('caps ordinary routes at 256 KB and the webhook, the agent door and a studio turn at 1 MB, inside /w/ too', () => {
    expect(bodyLimitFor('/v1/proposals')).toBe(DEFAULT_BODY_LIMIT)
    expect(bodyLimitFor('/v1/webhooks/paypal')).toBe(LARGE_BODY_LIMIT)
    expect(bodyLimitFor('/w/ws_abcdefghijklmnopqrst/v1/webhooks/paypal')).toBe(LARGE_BODY_LIMIT)
    expect(bodyLimitFor('/mcp')).toBe(LARGE_BODY_LIMIT)
    expect(bodyLimitFor('/w/ws_abcdefghijklmnopqrst/v1/proposals')).toBe(DEFAULT_BODY_LIMIT)
  })

  it('answers an oversized body with problem+json 413, with or without a content-length', async () => {
    const { app } = harness()
    const big = JSON.stringify({ description: 'x'.repeat(DEFAULT_BODY_LIMIT + 10) })
    const declared = await app.request('http://mandate.test/v1/proposals', {
      method: 'POST',
      headers: { authorization: `Bearer ${STUDIO_KEY}`, 'content-type': 'application/json', 'content-length': String(big.length), 'idempotency-key': 'big-body-1-key' },
      body: big,
    })
    expect(declared.status).toBe(413)
    expect(declared.headers.get('content-type')).toContain('application/problem+json')
    expect((await declared.json() as { code: string }).code).toBe('request.too_large')
    // A chunked body says nothing about its size up front; it is counted as it arrives.
    const chunked = await app.request('http://mandate.test/v1/proposals', {
      method: 'POST',
      headers: { authorization: `Bearer ${STUDIO_KEY}`, 'content-type': 'application/json', 'idempotency-key': 'big-body-2-key' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(big)); controller.close() } }),
      duplex: 'half',
    } as RequestInit)
    expect(chunked.status).toBe(413)
  })

  it('still takes a webhook delivery larger than the ordinary cap', async () => {
    const { app } = harness()
    const body = JSON.stringify({ id: 'WH-big', event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: { padding: 'y'.repeat(DEFAULT_BODY_LIMIT + 100) } })
    const response = await app.request('http://mandate.test/v1/webhooks/paypal', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(response.status).toBe(200)
  })
})

describe('rate limiting before any key is hashed', () => {
  it('counts unrecognised machine keys per address before hashing them, and leaves a working key alone', async () => {
    const { app } = harness({ rateLimitPerMinute: 3 })
    const created = await call(app, 'POST', '/v1/agents', { body: { name: 'Reader', scopes: ['read'] } })
    expect(created.status).toBe(201)
    const agentKey = created.json.apiKey as string
    for (let i = 0; i < 3; i += 1) {
      expect((await call(app, 'GET', '/v1/warrant', { key: `mnd_ag_madeup${i}_${randomUUID()}` })).status).toBe(401)
    }
    const refused = `mnd_ag_madeup_last_${randomUUID()}`
    const limited = await call(app, 'GET', '/v1/warrant', { key: refused })
    expect(limited.status).toBe(429)
    expect(limited.json.detail).toMatch(/unrecognised keys/)
    // Refused before any PBKDF2 run: the server never learned this key's hash.
    expect(machineKeyHashKnown(refused)).toBe(false)
    expect((await call(app, 'GET', '/v1/warrant', { key: agentKey })).status).toBe(200)
  })

  it('remembers that no studio holds a made-up default-stamped key, so it does not scan every studio file again', async () => {
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-misstamped')
    control.ensureDefault(':memory:', NOW.toISOString())
    const scans = vi.spyOn(control, 'studioFiles')
    const { app } = harness({ flags: loadFlags({ FLAG_TENANCY: '1' }), control, registry: new TenantRegistry(() => null) })
    const key = `mnd_cl_ws_default_${randomUUID().replace(/-/g, '')}`
    expect((await call(app, 'GET', '/v1/warrant', { key })).status).toBe(401)
    expect((await call(app, 'GET', '/v1/warrant', { key })).status).toBe(401)
    expect(scans).toHaveBeenCalledTimes(1)
    controlDb.close()
  })

  it('gives the PayPal webhook its own bucket, so a flood of anonymous calls does not starve it', async () => {
    const { app } = harness({ rateLimitPerMinute: 2 })
    for (let i = 0; i < 2; i += 1) expect((await app.request('http://mandate.test/openapi.json')).status).toBe(200)
    expect((await app.request('http://mandate.test/openapi.json')).status).toBe(429)
    for (let i = 0; i < 5; i += 1) {
      const delivered = await app.request('http://mandate.test/v1/webhooks/paypal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `WH-${i}`, event_type: 'X' }) })
      expect(delivered.status).toBe(200)
    }
  })
})

describe('logs and errors', () => {
  it('takes the secret out of a status link before the request is logged', async () => {
    expect(redactPath('/v1/share/abc123~supersecretvalue')).toBe('/v1/share/[redacted]')
    expect(redactPath('/w/ws_abcdefghijklmnopqrst/v1/share/tok/pay/session')).toBe('/w/ws_abcdefghijklmnopqrst/v1/share/[redacted]/pay/session')
    expect(redactPath('/app/s/tokentokentoken')).toBe('/app/s/[redacted]')
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)) })
    const { app } = harness({ log: true })
    await app.request('http://mandate.test/v1/share/sh_1~averysecretlinktoken')
    const logged = lines.find((line) => line.includes('"path"'))
    expect(logged).toBeDefined()
    expect(logged).not.toContain('averysecretlinktoken')
    expect(logged).toContain('/v1/share/[redacted]')
  })

  it('logs a 500 with its name, message and stack, redacted, and tells the caller nothing more', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { errors.push(String(line)) })
    const app = new Hono()
    app.onError(onError)
    app.get('/boom', () => { throw new TypeError('exploded with token=abcdefghijklmnopqrstuv') })
    const response = await app.request('http://mandate.test/boom')
    expect(response.status).toBe(500)
    const body = await response.json() as { detail: string }
    expect(body.detail).toBe('The request failed.')
    expect(JSON.stringify(body)).not.toContain('exploded')
    const line = errors.join('\n')
    expect(line).toContain('TypeError')
    expect(line).toContain('exploded with')
    expect(line).toContain('"stack"')
    expect(line).not.toContain('abcdefghijklmnopqrstuv')
  })

  it('answers a body that is not JSON on a no-field action with 400, not 500', async () => {
    const { app } = harness()
    const made = await call(app, 'POST', '/v1/proposals', { key: STUDIO_KEY, body: CHARGE, idem: `bad-json-${randomUUID()}` })
    const id = made.json.id as string
    for (const path of [`/v1/proposals/${id}/reject`, `/v1/proposals/${id}/approve`]) {
      const response = await app.request(`http://mandate.test${path}`, { method: 'POST', headers: { authorization: 'Bearer test-mandate-key-32chars', 'content-type': 'application/json' }, body: '{not json' })
      expect(response.status).toBe(400)
      expect((await response.json() as { code: string }).code).toBe('request.invalid')
    }
  })
})

describe('cookie doors check where the request came from', () => {
  it('refuses a logout that does not come from the console', async () => {
    const d = people({ meera: 'owner' })
    const forged = await d.h.app.request('http://mandate.test/auth/logout', { method: 'POST', headers: { cookie: `mnd_session=${d.members.meera!.token}`, origin: 'https://evil.example' } })
    expect(forged.status).toBe(403)
    expect((await forged.json() as { code: string }).code).toBe('auth/csrf')
    // The session survived the forged call.
    expect((await d.h.app.request('http://mandate.test/auth/me', { headers: d.cookie('meera') })).status).toBe(200)
    const real = await d.h.app.request('http://mandate.test/auth/logout', { method: 'POST', headers: d.cookie('meera') })
    expect(real.status).toBe(200)
    d.controlDb.close()
  })

  it('refuses a join that does not name the console, without burning the invite', async () => {
    const d = people({ meera: 'owner' })
    const token = `invite-${randomUUID()}`
    d.control.createInvite({ id: randomUUID(), workspaceId: 'ws_default', role: 'viewer', token, expiresAt: '2027-01-01T00:00:00.000Z', createdBy: d.members.meera!.id, now: NOW.toISOString() })
    const forged = await d.h.app.request('http://mandate.test/join', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ token, name: 'Mallory' }) })
    expect(forged.status).toBe(403)
    const joined = await d.h.app.request('http://mandate.test/join', { method: 'POST', headers: { 'content-type': 'application/json', ...WEB }, body: JSON.stringify({ token, name: 'Sam' }) })
    expect(joined.status).toBe(200)
    d.controlDb.close()
  })
})

describe('recovery codes', () => {
  it('refuses to issue codes from a recovery session, even with a grant', async () => {
    const d = people({ meera: 'owner' }, { method: 'recovery' })
    const grant = randomUUID()
    d.control.putGrant({ id: grant, memberId: d.members.meera!.id, workspaceId: 'ws_default', kind: 'recovery', binding: stepBinding('recovery', 'regenerate'), now: NOW.toISOString() })
    const issued = await d.h.app.request('http://mandate.test/auth/recovery/issue', { method: 'POST', headers: { ...d.cookie('meera'), 'x-mandate-stepup': grant } })
    expect(issued.status).toBe(403)
    d.controlDb.close()
  })
})

describe('step-up challenges', () => {
  it('are random nonces, not a hash of what is being signed, and keep their binding', async () => {
    const d = people({ meera: 'owner' })
    const ask = () => d.h.app.request('http://mandate.test/auth/stepup/options', { method: 'POST', headers: { ...d.cookie('meera'), 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'recovery' }) })
    const first = await (await ask()).json() as { challengeId: string; options: { challenge: string } }
    const second = await (await ask()).json() as { challengeId: string; options: { challenge: string } }
    expect(first.options.challenge).not.toBe(second.options.challenge)
    const binding = stepBinding('recovery', 'regenerate')
    const predictable = createHash('sha256').update(`mandate/stepup/v1\nrecovery\n${binding}`).digest('base64url')
    expect(first.options.challenge).not.toBe(predictable)
    expect(Buffer.from(first.options.challenge, 'base64url').length).toBeGreaterThanOrEqual(32)
    const row = d.control.takeChallenge(first.challengeId, NOW.toISOString())
    expect(row?.binding_kind).toBe('recovery')
    expect(row?.binding_hash).toBe(binding)
    expect(row?.challenge).toBe(first.options.challenge)
    // Single use: a challenge taken once is gone.
    expect(d.control.takeChallenge(first.challengeId, NOW.toISOString())).toBeNull()
    d.controlDb.close()
  })
})

describe('the fake PayPal login', () => {
  const callback = (app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }) => app.request('http://mandate.test/auth/paypal/callback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'anything-at-all' }) })

  it('is not there unless the server runs on the in-process fake PayPal', async () => {
    for (const setup of [{ paypal: null }, { paypal: new FakePayPal(), paypalMode: 'sandbox' as const }, { paypal: new FakePayPal(), paypalMode: 'live' as const }]) {
      const controlDb = openDatabase(':memory:')
      const control = new ControlStore(controlDb, 'pepper-login')
      control.ensureDefault(':memory:', NOW.toISOString())
      const h = harness({ flags: loadFlags({ PAYPAL_LOGIN_ENABLED: '1' }), control, ...setup })
      const response = await callback(h.app)
      expect(response.status).toBe(404)
      expect(response.headers.get('set-cookie')).toBeNull()
      controlDb.close()
    }
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-login')
    control.ensureDefault(':memory:', NOW.toISOString())
    const fake = harness({ flags: loadFlags({ PAYPAL_LOGIN_ENABLED: '1' }), control, paypalMode: 'fake' })
    expect((await callback(fake.app)).status).toBe(200)
    controlDb.close()
  })
})

describe('opening a studio', () => {
  function opener(paypalMode: 'none' | 'sandbox' | 'live') {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-hardening-ws-'))
    const template = join(dir, 'template.sqlite')
    const templateDb = openDatabase(template)
    migrate(templateDb)
    seed(templateDb, NOW)
    templateDb.close()
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-open')
    control.ensureDefault(':memory:', NOW.toISOString())
    const h = harness({ flags: loadFlags({ FLAG_TENANCY: '1', FLAG_PASSKEYS: '1' }), control, masterKey: MASTER, demo: { root: dir, template }, webauthn: WA, paypalMode })
    const open = (name: string) => h.app.request('http://mandate.test/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
    return { h, controlDb, open }
  }

  it('is refused when the server runs on a live PayPal account', async () => {
    const { open, controlDb } = opener('live')
    const refused = await open('Live Studio')
    expect(refused.status).toBe(403)
    expect((await refused.json() as { code: string }).code).toBe('tenant/live-refused')
    controlDb.close()
  })

  it('is limited per address like a sign-in', async () => {
    const { open, controlDb } = opener('sandbox')
    for (let i = 0; i < 5; i += 1) expect((await open(`Studio ${i}`)).status).toBe(200)
    const limited = await open('One too many')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
    controlDb.close()
  })
})

describe('approvers and invites', () => {
  it('stamps who filed a request, and refuses an approver approving their own', async () => {
    const d = people({ meera: 'owner', ada: 'approver', bea: 'approver' })
    // Each request is for a different amount, so the second is not refused as a duplicate of the first.
    const file = async (name: string, amountCents: number) => {
      const made = await d.h.app.request('http://mandate.test/v1/proposals', {
        method: 'POST',
        headers: { ...d.cookie(name), 'content-type': 'application/json', 'idempotency-key': `self-${randomUUID()}` },
        body: JSON.stringify({ ...CHARGE, amountCents, prompt: `Bill Northwind ${amountCents} cents` }),
      })
      expect(made.status).toBe(201)
      const body = await made.json() as { id: string; phase: string; clause?: string; detail?: string }
      expect(`${body.phase} ${body.clause} ${body.detail}`).toMatch(/^pending_approval/)
      return body.id
    }
    const approve = (name: string, id: string) => d.h.app.request(`http://mandate.test/v1/proposals/${id}/approve`, { method: 'POST', headers: d.cookie(name) })

    const own = await file('ada', 15_000)
    const row = d.h.db.prepare(`SELECT actor_json FROM events WHERE proposal_id = ? AND type = 'proposal.created'`).get(own) as { actor_json: string }
    expect(JSON.parse(row.actor_json)).toMatchObject({ memberId: d.members.ada!.id, role: 'approver' })
    const self = await approve('ada', own)
    expect(self.status).toBe(403)
    expect((await self.json() as { code: string }).code).toBe('approval.self')
    expect((await approve('bea', own)).status).toBe(200)

    // The owner answers for the whole studio and may approve what they filed.
    const owners = await file('meera', 12_000)
    expect((await approve('meera', owners)).status).toBe(200)
    d.controlDb.close()
  })

  it('gives a member with a role the server does not know nothing, never the owner door', async () => {
    const d = people({ odd: 'superuser' as MemberRole })
    const response = await d.h.app.request('http://mandate.test/v1/warrant', { headers: d.cookie('odd') })
    expect(response.status).toBe(403)
    d.controlDb.close()
  })

  it('invites only known roles, and carries an approver\'s limit to the member who joins', async () => {
    const d = people({ meera: 'owner' })
    const invite = (body: unknown) => d.h.app.request('http://mandate.test/v1/invites', { method: 'POST', headers: { ...d.cookie('meera'), 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await invite({ role: 'owner' })).status).toBe(400)
    expect((await invite({ role: 'superuser' })).status).toBe(400)
    expect((await invite({ role: 'viewer', approvalLimitCents: 500 })).status).toBe(400)
    expect((await invite({ role: 'approver', approvalLimitCents: -1 })).status).toBe(400)
    const made = await invite({ role: 'approver', approvalLimitCents: 5_000 })
    expect(made.status).toBe(200)
    const { token } = await made.json() as { token: string }
    const joined = await d.h.app.request('http://mandate.test/join', { method: 'POST', headers: { 'content-type': 'application/json', ...WEB }, body: JSON.stringify({ token, name: 'Ada' }) })
    expect(joined.status).toBe(200)
    const { memberId } = await joined.json() as { memberId: string }
    expect(d.control.member(memberId)?.approval_limit_cents).toBe(5_000)
    d.controlDb.close()
  })
})

describe('the live stream is per studio', () => {
  const STUDIO_A = 'ws_aaaaaaaaaaaaaaaaaaaa'
  const STUDIO_B = 'ws_bbbbbbbbbbbbbbbbbbbb'

  it('does not tell a subscriber in studio A about studio B\'s writes', async () => {
    const a = harness({ workspace: { id: STUDIO_A, mode: 'studio' } })
    const b = harness({ workspace: { id: STUDIO_B, mode: 'studio' } })
    const seenA: LiveEvent[] = []
    const seenB: LiveEvent[] = []
    const offA = live.subscribe((event) => seenA.push(event), STUDIO_A)
    const offB = live.subscribe((event) => seenB.push(event), STUDIO_B)
    const inB = await call(b.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, body: CHARGE, idem: `live-b-${randomUUID()}` })
    expect(inB.status).toBe(201)
    const inA = await call(a.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, body: CHARGE, idem: `live-a-${randomUUID()}` })
    expect(inA.status).toBe(201)
    offA()
    offB()
    const ids = (seen: LiveEvent[]) => seen.flatMap((event) => (event.type === 'changed' && event.id ? [event.id] : []))
    expect(ids(seenA)).toContain(inA.json.id)
    expect(ids(seenA)).not.toContain(inB.json.id)
    expect(ids(seenB)).toContain(inB.json.id)
    expect(ids(seenB)).not.toContain(inA.json.id)
  })

  it('keeps another studio\'s events off /v1/stream', async () => {
    const a = harness({ workspace: { id: STUDIO_A, mode: 'studio' } })
    const b = harness({ workspace: { id: STUDIO_B, mode: 'studio' } })
    const response = await a.app.request('http://mandate.test/v1/stream', { headers: { authorization: `Bearer ${STUDIO_KEY}` } })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const until = async (needle: string) => {
      const deadline = Date.now() + 3000
      while (!text.includes(needle) && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 200))])
        if (chunk.value) text += decoder.decode(chunk.value)
      }
      return text.includes(needle)
    }
    expect(await until('hello')).toBe(true)
    const inB = await call(b.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, body: CHARGE, idem: `stream-b-${randomUUID()}` })
    const inA = await call(a.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, body: CHARGE, idem: `stream-a-${randomUUID()}` })
    expect(await until(inA.json.id)).toBe(true)
    expect(text).not.toContain(inB.json.id)
    await reader.cancel()
  })
})
