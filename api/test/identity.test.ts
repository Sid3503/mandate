import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { stepBinding } from '../src/auth/passkeys'
import { ControlStore } from '../src/control/store'
import { openDatabase } from '../src/db/database'
import { loadFlags } from '../src/flags'
import { rateClass } from '../src/ops/ratelimit'
import { closeAll, harness, NOW } from './support'
import { SoftAuthenticator } from './soft-authenticator'

afterEach(closeAll)

const WA = { rpID: 'localhost', rpName: 'Mandate', origins: ['http://127.0.0.1:8787'] }
const WEB = { origin: 'http://127.0.0.1:8787', 'x-mandate-client': 'web' }

function desk() {
  const controlDb = openDatabase(':memory:')
  const control = new ControlStore(controlDb, 'pepper-q1')
  control.ensureDefault(':memory:', NOW.toISOString())
  const ownerId = randomUUID()
  const proposerId = randomUUID()
  const strangerId = randomUUID()
  control.addMember({ id: ownerId, workspaceId: 'ws_default', name: 'Meera', role: 'owner', now: NOW.toISOString() })
  control.addMember({ id: proposerId, workspaceId: 'ws_default', name: 'Arun', role: 'proposer', now: NOW.toISOString() })
  control.addMember({ id: strangerId, workspaceId: 'ws_default', name: 'Other', role: 'viewer', now: NOW.toISOString() })
  const ownerToken = 'owner-session-token-32chars-aaaa'
  const otherToken = 'owner-other-session-token-32chars'
  const proposerToken = 'proposer-session-token-32chars-bb'
  const strangerToken = 'stranger-session-token-32chars-c'
  const now = NOW.toISOString()
  control.putSession({ token: ownerToken, memberId: ownerId, workspaceId: 'ws_default', method: 'passkey', now, idleHours: 12, absoluteDays: 7 })
  control.putSession({ token: otherToken, memberId: ownerId, workspaceId: 'ws_default', method: 'passkey', now, idleHours: 12, absoluteDays: 7 })
  control.putSession({ token: proposerToken, memberId: proposerId, workspaceId: 'ws_default', method: 'passkey', now, idleHours: 12, absoluteDays: 7 })
  control.putSession({ token: strangerToken, memberId: strangerId, workspaceId: 'ws_default', method: 'passkey', now, idleHours: 12, absoluteDays: 7 })
  control.event({ id: randomUUID(), at: now, workspaceId: 'ws_default', memberId: ownerId, event: 'login', result: 'ok' })
  const h = harness({ flags: loadFlags({ FLAG_PASSKEYS: '1' }), control, webauthn: WA })
  return { h, control, controlDb, ownerId, ownerToken, proposerToken, strangerToken }
}

const headers = (token: string) => ({ cookie: `mnd_session=${token}`, ...WEB })

describe('sessions and sign-in history', () => {
  it('lists this member only, marks the current session, and hides the token', async () => {
    const d = desk()
    const listed = await d.h.app.request('http://mandate.test/auth/sessions', { headers: headers(d.ownerToken) })
    expect(listed.status).toBe(200)
    const body = await listed.json() as { sessions: Array<{ publicId: string; current: boolean; method: string }> }
    expect(body.sessions).toHaveLength(2)
    expect(body.sessions.filter((row) => row.current)).toHaveLength(1)
    expect(body.sessions.every((row) => row.method === 'passkey')).toBe(true)
    const text = JSON.stringify(body)
    expect(text).not.toContain(d.ownerToken)
    expect(text).not.toContain('id_hash')
    d.controlDb.close()
  })

  it('refuses a missing session and hides sign-in history from a proposer', async () => {
    const d = desk()
    const missing = await d.h.app.request('http://mandate.test/auth/sessions')
    expect(missing.status).toBe(401)
    const hidden = await d.h.app.request('http://mandate.test/auth/events', { headers: headers(d.proposerToken) })
    expect(hidden.status).toBe(403)
    const history = await d.h.app.request('http://mandate.test/auth/events', { headers: headers(d.ownerToken) })
    expect(history.status).toBe(200)
    const body = await history.json() as { events: Array<{ event: string }> }
    expect(body.events.some((row) => row.event === 'login')).toBe(true)
    d.controlDb.close()
  })

  it('revokes one session, refuses another member, and keeps the caller when ending the others', async () => {
    const d = desk()
    const listed = await d.h.app.request('http://mandate.test/auth/sessions', { headers: headers(d.ownerToken) })
    const mine = await listed.json() as { sessions: Array<{ publicId: string; current: boolean }> }
    const other = mine.sessions.find((row) => !row.current)
    expect(other).toBeTruthy()
    const bare = await d.h.app.request('http://mandate.test/auth/sessions/revoke', {
      method: 'POST',
      headers: { cookie: `mnd_session=${d.ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ publicId: other?.publicId }),
    })
    expect(bare.status).toBe(403)
    const ended = await d.h.app.request('http://mandate.test/auth/sessions/revoke', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ publicId: other?.publicId }),
    })
    expect(ended.status).toBe(200)
    const stranger = await d.h.app.request('http://mandate.test/auth/sessions', { headers: headers(d.strangerToken) })
    const theirs = await stranger.json() as { sessions: Array<{ publicId: string }> }
    const stolen = await d.h.app.request('http://mandate.test/auth/sessions/revoke', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ publicId: theirs.sessions[0]?.publicId }),
    })
    expect(stolen.status).toBe(404)
    const rest = await d.h.app.request('http://mandate.test/auth/sessions/revoke-others', {
      method: 'POST',
      headers: headers(d.ownerToken),
    })
    expect(rest.status).toBe(200)
    const still = await d.h.app.request('http://mandate.test/auth/me', { headers: { cookie: `mnd_session=${d.ownerToken}` } })
    expect(still.status).toBe(200)
    const strangerStill = await d.h.app.request('http://mandate.test/auth/me', { headers: { cookie: `mnd_session=${d.strangerToken}` } })
    expect(strangerStill.status).toBe(200)
    d.controlDb.close()
  })

  it('counts session reads in the auth rate-limit class', async () => {
    expect(rateClass('GET', '/auth/sessions')).toBe('auth')
    expect(rateClass('POST', '/auth/sessions/revoke')).toBe('auth')
    expect(rateClass('GET', '/auth/events')).toBe('auth')
    const h = harness({ classedRates: true, rateLimitPerMinute: 100, flags: loadFlags({ FLAG_PASSKEYS: '1' }), webauthn: WA })
    let status = 0
    for (let i = 0; i < 6; i += 1) {
      status = (await h.app.request('http://mandate.test/auth/sessions')).status
    }
    expect(status).toBe(429)
  })
})

describe('recovery codes', () => {
  it('issues codes once, hides them in the database, and accepts them only after they are unused', async () => {
    const d = desk()
    const issued = await d.h.app.request('http://mandate.test/auth/recovery/issue', { method: 'POST', headers: headers(d.ownerToken) })
    expect(issued.status).toBe(200)
    const body = await issued.json() as { codes: string[]; saved: boolean }
    expect(body.codes).toHaveLength(8)
    expect(body.saved).toBe(false)
    const stored = (d.control as unknown as { db: { prepare: (sql: string) => { all: () => Array<{ code_hash: string }> } } }).db.prepare('SELECT code_hash FROM recovery_codes').all()
    expect(JSON.stringify(stored)).not.toContain(body.codes[0])
    const bare = await d.h.app.request('http://mandate.test/auth/recovery/ack', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ saved: false }),
    })
    expect(bare.status).toBe(400)
    expect((await bare.json() as { detail: string }).detail).toBe('I saved these')
    const ack = await d.h.app.request('http://mandate.test/auth/recovery/ack', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ saved: true }),
    })
    expect(ack.status).toBe(200)
    expect(JSON.stringify(await ack.json())).not.toContain(body.codes[0])
    const used = await d.h.app.request('http://mandate.test/auth/recovery/use', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: d.ownerId, code: body.codes[0] }),
    })
    expect(used.status).toBe(200)
    const again = await d.h.app.request('http://mandate.test/auth/recovery/use', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: d.ownerId, code: body.codes[0] }),
    })
    expect(again.status).toBe(401)
    d.controlDb.close()
  })

  it('refuses a missing session and replaces codes only with a matching step-up', async () => {
    const d = desk()
    const missing = await d.h.app.request('http://mandate.test/auth/recovery/issue', { method: 'POST' })
    expect(missing.status).toBe(401)
    const first = await d.h.app.request('http://mandate.test/auth/recovery/issue', { method: 'POST', headers: headers(d.ownerToken) })
    const oldCodes = (await first.json() as { codes: string[] }).codes
    const denied = await d.h.app.request('http://mandate.test/auth/recovery/regenerate', { method: 'POST', headers: headers(d.ownerToken) })
    expect(denied.status).toBe(401)
    const binding = stepBinding('recovery', 'regenerate')
    const wrong = randomUUID()
    d.control.putGrant({ id: wrong, memberId: d.ownerId, workspaceId: 'ws_default', kind: 'recovery', binding: 'other', now: NOW.toISOString() })
    const mismatch = await d.h.app.request('http://mandate.test/auth/recovery/regenerate', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'x-mandate-stepup': wrong },
    })
    expect(mismatch.status).toBe(401)
    const grant = randomUUID()
    d.control.putGrant({ id: grant, memberId: d.ownerId, workspaceId: 'ws_default', kind: 'recovery', binding, now: NOW.toISOString() })
    const replaced = await d.h.app.request('http://mandate.test/auth/recovery/regenerate', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'x-mandate-stepup': grant },
    })
    expect(replaced.status).toBe(200)
    const fresh = (await replaced.json() as { codes: string[]; saved: boolean })
    expect(fresh.saved).toBe(false)
    expect(fresh.codes).toHaveLength(8)
    const stale = await d.h.app.request('http://mandate.test/auth/recovery/use', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: d.ownerId, code: oldCodes[0] }),
    })
    expect(stale.status).toBe(401)
    const spent = await d.h.app.request('http://mandate.test/auth/recovery/regenerate', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'x-mandate-stepup': grant },
    })
    expect(spent.status).toBe(401)
    d.controlDb.close()
  })

  it('counts recovery issue in the auth rate-limit class', async () => {
    expect(rateClass('POST', '/auth/recovery/issue')).toBe('auth')
    expect(rateClass('POST', '/auth/recovery/regenerate')).toBe('auth')
    const h = harness({ classedRates: true, rateLimitPerMinute: 100, flags: loadFlags({ FLAG_PASSKEYS: '1' }), webauthn: WA })
    let status = 0
    for (let i = 0; i < 6; i += 1) status = (await h.app.request('http://mandate.test/auth/recovery/issue', { method: 'POST' })).status
    expect(status).toBe(429)
  })
})

async function addPasskey(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, token: string) {
  const options = await app.request('http://mandate.test/auth/register/options', { method: 'POST', headers: headers(token) })
  expect(options.status).toBe(200)
  const started = await options.json() as { challengeId: string; options: { challenge: string } }
  const auth = new SoftAuthenticator('http://127.0.0.1:8787', 'localhost')
  const verified = await app.request('http://mandate.test/auth/register/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: started.challengeId, response: auth.register(started.options.challenge) }),
  })
  expect(verified.status).toBe(200)
}

describe('passkeys on the account', () => {
  it('adds a second passkey and will not remove the last one', async () => {
    const d = desk()
    await addPasskey(d.h.app, d.ownerToken)
    const one = await d.h.app.request('http://mandate.test/auth/credentials', { headers: headers(d.ownerToken) })
    expect(one.status).toBe(200)
    const first = await one.json() as { credentials: Array<{ id: string; fingerprint: string }> }
    expect(first.credentials).toHaveLength(1)
    expect(JSON.stringify(first)).not.toContain('public_key')
    const last = await d.h.app.request('http://mandate.test/auth/credentials/revoke', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ id: first.credentials[0]?.id }),
    })
    expect(last.status).toBe(409)
    expect((await last.json() as { title: string }).title).toBe('The last passkey stays')
    await addPasskey(d.h.app, d.ownerToken)
    const two = await (await d.h.app.request('http://mandate.test/auth/credentials', { headers: headers(d.ownerToken) })).json() as { credentials: Array<{ id: string }> }
    expect(two.credentials).toHaveLength(2)
    const removed = await d.h.app.request('http://mandate.test/auth/credentials/revoke', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ id: two.credentials[0]?.id }),
    })
    expect(removed.status).toBe(200)
    const left = await (await d.h.app.request('http://mandate.test/auth/credentials', { headers: headers(d.ownerToken) })).json() as { credentials: Array<{ revoked: boolean }> }
    expect(left.credentials.filter((row) => !row.revoked)).toHaveLength(1)
    const again = await d.h.app.request('http://mandate.test/auth/credentials/revoke', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ id: two.credentials[1]?.id }),
    })
    expect(again.status).toBe(409)
    const stolen = await d.h.app.request('http://mandate.test/auth/credentials/revoke', {
      method: 'POST',
      headers: { ...headers(d.proposerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ id: two.credentials[1]?.id }),
    })
    expect(stolen.status).toBe(404)
    const bare = await d.h.app.request('http://mandate.test/auth/credentials/revoke', {
      method: 'POST',
      headers: { cookie: `mnd_session=${d.ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: two.credentials[1]?.id }),
    })
    expect(bare.status).toBe(403)
    const missing = await d.h.app.request('http://mandate.test/auth/credentials')
    expect(missing.status).toBe(401)
    d.controlDb.close()
  })

  it('counts passkey reads in the auth rate-limit class', async () => {
    expect(rateClass('GET', '/auth/credentials')).toBe('auth')
    expect(rateClass('POST', '/auth/credentials/revoke')).toBe('auth')
    const h = harness({ classedRates: true, rateLimitPerMinute: 100, flags: loadFlags({ FLAG_PASSKEYS: '1' }), webauthn: WA })
    let status = 0
    for (let i = 0; i < 6; i += 1) status = (await h.app.request('http://mandate.test/auth/credentials')).status
    expect(status).toBe(429)
  })
})
