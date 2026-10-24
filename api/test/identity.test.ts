import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { stepBinding } from '../src/auth/passkeys'
import { ControlStore } from '../src/control/store'
import { openDatabase } from '../src/db/database'
import { loadFlags } from '../src/flags'
import { rateClass } from '../src/ops/ratelimit'
import { closeAll, EVIDENCE, harness, JOB, NOW, OWNER_KEY } from './support'
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

describe('invites', () => {
  function invites() {
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-q1')
    control.ensureDefault(':memory:', NOW.toISOString())
    const ownerId = randomUUID()
    const proposerId = randomUUID()
    control.addMember({ id: ownerId, workspaceId: 'ws_default', name: 'Meera', role: 'owner', now: NOW.toISOString() })
    control.addMember({ id: proposerId, workspaceId: 'ws_default', name: 'Arun', role: 'proposer', now: NOW.toISOString() })
    const ownerToken = 'invite-owner-session-token-32c'
    const proposerToken = 'invite-proposer-session-token-3'
    const now = NOW.toISOString()
    control.putSession({ token: ownerToken, memberId: ownerId, workspaceId: 'ws_default', method: 'passkey', now, idleHours: 12, absoluteDays: 7 })
    control.putSession({ token: proposerToken, memberId: proposerId, workspaceId: 'ws_default', method: 'passkey', now, idleHours: 12, absoluteDays: 7 })
    const h = harness({ flags: loadFlags({ FLAG_INVITES: '1', FLAG_PASSKEYS: '1' }), control, webauthn: WA })
    return { h, control, controlDb, ownerToken, proposerToken }
  }

  it('shows the inviter, revokes only the owner invite, and refuses a second use', async () => {
    const d = invites()
    const made = await d.h.app.request('http://mandate.test/v1/invites', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'proposer' }),
    })
    expect(made.status).toBe(200)
    const token = (await made.json() as { token: string }).token
    const preview = await d.h.app.request('http://mandate.test/join/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ role: 'proposer', inviter: 'Meera' })
    const staff = await d.h.app.request('http://mandate.test/v1/invites/revoke', {
      method: 'POST',
      headers: { ...headers(d.proposerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    expect(staff.status).toBe(403)
    const bare = await d.h.app.request('http://mandate.test/v1/invites/revoke', {
      method: 'POST',
      headers: { cookie: `mnd_session=${d.ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    expect(bare.status).toBe(403)
    const gone = await d.h.app.request('http://mandate.test/v1/invites/revoke', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-invite-token' }),
    })
    expect(gone.status).toBe(404)
    const revoked = await d.h.app.request('http://mandate.test/v1/invites/revoke', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    expect(revoked.status).toBe(200)
    const again = await d.h.app.request('http://mandate.test/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, name: 'Sam' }),
    })
    expect(again.status).toBe(400)
    d.controlDb.close()
  })

  it('requires a passkey step-up before an owner creates an invite', async () => {
    const d = invites()
    d.controlDb.prepare('UPDATE workspaces SET passkey_for_money = 1 WHERE id = ?').run('ws_default')
    const blocked = await d.h.app.request('http://mandate.test/v1/invites', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    })
    expect(blocked.status).toBe(401)
    expect((await blocked.json() as { title: string }).title).toBe('Sign this with your passkey')
    d.controlDb.close()
  })

  it('counts invite revoke in the write rate-limit class', async () => {
    expect(rateClass('POST', '/v1/invites')).toBe('write')
    expect(rateClass('POST', '/v1/invites/revoke')).toBe('write')
    const h = harness({ classedRates: true, rateLimitPerMinute: 100, flags: loadFlags({ FLAG_INVITES: '1' }) })
    let status = 0
    for (let i = 0; i < 61; i += 1) {
      status = (await h.app.request('http://mandate.test/v1/invites/revoke', { method: 'POST' })).status
    }
    expect(status).toBe(429)
  })
})

describe('members', () => {
  function people() {
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-q1')
    control.ensureDefault(':memory:', NOW.toISOString())
    const ownerId = randomUUID()
    const proposerId = randomUUID()
    const samId = randomUUID()
    const approverId = randomUUID()
    const viewerId = randomUUID()
    const otherId = randomUUID()
    const now = NOW.toISOString()
    control.addMember({ id: ownerId, workspaceId: 'ws_default', name: 'Meera', role: 'owner', now })
    control.addMember({ id: proposerId, workspaceId: 'ws_default', name: 'Arun', role: 'proposer', now })
    control.addMember({ id: samId, workspaceId: 'ws_default', name: 'Sam', role: 'proposer', now })
    control.addMember({ id: approverId, workspaceId: 'ws_default', name: 'Ada', role: 'approver', now })
    control.addMember({ id: viewerId, workspaceId: 'ws_default', name: 'Vi', role: 'viewer', now })
    control.addMember({ id: otherId, workspaceId: 'ws_other', name: 'Out', role: 'proposer', now })
    const ownerToken = 'member-owner-session-token-32ch'
    const proposerToken = 'member-proposer-session-token-32'
    const samToken = 'member-sam-session-token-32chars'
    const approverToken = 'member-approver-session-token-32'
    const viewerToken = 'member-viewer-session-token-32c'
    for (const [token, memberId] of [[ownerToken, ownerId], [proposerToken, proposerId], [samToken, samId], [approverToken, approverId], [viewerToken, viewerId]] as const) {
      control.putSession({ token, memberId, workspaceId: 'ws_default', method: 'passkey', now, idleHours: 12, absoluteDays: 7 })
    }
    control.saveCredential({ id: randomUUID(), memberId: proposerId, credentialId: 'arun-key', publicKey: 'cHVibGlj', alg: -7, counter: 0, fingerprint: 'aaaa', backupEligible: false, backupState: false, now })
    control.saveCredential({ id: randomUUID(), memberId: samId, credentialId: 'sam-key', publicKey: 'cHVibGlj', alg: -7, counter: 0, fingerprint: 'bbbb', backupEligible: false, backupState: false, now })
    const h = harness({ flags: loadFlags({ FLAG_PASSKEYS: '1', FLAG_INVITES: '1' }), control, webauthn: WA })
    return { h, control, controlDb, ownerId, proposerId, samId, otherId, ownerToken, proposerToken, samToken, approverToken, viewerToken, now }
  }

  const post = (app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, path: string, token: string, body: unknown) => app.request(`http://mandate.test${path}`, {
    method: 'POST',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('changes a role, keeps the last owner, and revoke ends sessions, keys, and lists open requests', async () => {
    const d = people()
    const listed = await d.h.app.request('http://mandate.test/v1/members', { headers: headers(d.ownerToken) })
    expect(listed.status).toBe(200)
    const names = (await listed.json() as { members: Array<{ name: string; role: string }> }).members.map((row) => row.name)
    expect(names).toContain('Arun')
    expect(names).not.toContain('Out')
    expect((await post(d.h.app, `/v1/members/${d.proposerId}/role`, d.proposerToken, { role: 'viewer' })).status).toBe(403)
    expect((await post(d.h.app, `/v1/members/${d.proposerId}/role`, d.approverToken, { role: 'viewer' })).status).toBe(403)
    expect((await post(d.h.app, `/v1/members/${d.proposerId}/role`, d.viewerToken, { role: 'owner' })).status).toBe(403)
    const demote = await post(d.h.app, `/v1/members/${d.ownerId}/role`, d.ownerToken, { role: 'viewer' })
    expect(demote.status).toBe(409)
    expect((await demote.json() as { title: string }).title).toBe('The last owner stays')
    const stay = await post(d.h.app, `/v1/members/${d.ownerId}/revoke`, d.ownerToken, {})
    expect(stay.status).toBe(409)
    expect((await stay.json() as { title: string }).title).toBe('The last owner stays')
    const bare = await d.h.app.request(`http://mandate.test/v1/members/${d.proposerId}/role`, {
      method: 'POST',
      headers: { cookie: `mnd_session=${d.ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    })
    expect(bare.status).toBe(403)
    expect((await post(d.h.app, `/v1/members/${d.proposerId}/role`, d.ownerToken, { role: 'cashier' })).status).toBe(400)
    expect((await post(d.h.app, `/v1/members/${randomUUID()}/role`, d.ownerToken, { role: 'viewer' })).status).toBe(404)
    expect((await post(d.h.app, `/v1/members/${d.otherId}/revoke`, d.ownerToken, {})).status).toBe(404)
    expect(d.control.member(d.otherId)?.role).toBe('proposer')
    const bearer = await d.h.app.request(`http://mandate.test/v1/members/${d.proposerId}/role`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OWNER_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    })
    expect(bearer.status).toBe(403)
    const asked = await d.h.app.request('http://mandate.test/v1/proposals', {
      method: 'POST',
      headers: { ...headers(d.samToken), 'content-type': 'application/json', 'idempotency-key': 'member-open-request-01' },
      body: JSON.stringify({ kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: 'Waiting', evidenceUrl: EVIDENCE, jobId: JOB }),
    })
    expect(asked.status).toBe(201)
    const proposalId = (await asked.json() as { id: string }).id
    const changed = await post(d.h.app, `/v1/members/${d.proposerId}/role`, d.ownerToken, { role: 'viewer' })
    expect(changed.status).toBe(200)
    expect(d.control.session(d.proposerToken, d.now)).toBeNull()
    expect(d.control.credentials(d.proposerId)[0]?.revoked_at).toBeNull()
    const revoked = await post(d.h.app, `/v1/members/${d.samId}/revoke`, d.ownerToken, {})
    expect(revoked.status).toBe(200)
    const body = await revoked.json() as { openRequests: string[] }
    expect(body.openRequests).toContain(proposalId)
    expect(d.control.session(d.samToken, d.now)).toBeNull()
    expect(d.control.credentials(d.samId)[0]?.revoked_at).not.toBeNull()
    expect((await post(d.h.app, `/v1/members/${d.samId}/revoke`, d.ownerToken, {})).status).toBe(404)
    d.controlDb.close()
  })

  it('requires a passkey step-up before a member change when the rule is on', async () => {
    const d = people()
    d.controlDb.prepare('UPDATE workspaces SET passkey_for_money = 1 WHERE id = ?').run('ws_default')
    const blocked = await post(d.h.app, `/v1/members/${d.samId}/revoke`, d.ownerToken, {})
    expect(blocked.status).toBe(401)
    expect((await blocked.json() as { title: string }).title).toBe('Sign this with your passkey')
    const binding = stepBinding('member-revoke', d.samId)
    const grant = randomUUID()
    d.control.putGrant({ id: grant, memberId: d.ownerId, workspaceId: 'ws_default', kind: 'member-revoke', binding, now: d.now })
    const allowed = await d.h.app.request(`http://mandate.test/v1/members/${d.samId}/revoke`, {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json', 'x-mandate-stepup': grant },
      body: JSON.stringify({}),
    })
    expect(allowed.status).toBe(200)
    const again = await d.h.app.request(`http://mandate.test/v1/members/${d.proposerId}/role`, {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json', 'x-mandate-stepup': grant },
      body: JSON.stringify({ role: 'viewer' }),
    })
    expect(again.status).toBe(401)
    d.controlDb.close()
  })

  it('counts member writes in the write rate-limit class', async () => {
    expect(rateClass('POST', '/v1/members/someone/role')).toBe('write')
    expect(rateClass('POST', '/v1/members/someone/revoke')).toBe('write')
    const h = harness({ classedRates: true, rateLimitPerMinute: 100, flags: loadFlags({ FLAG_PASSKEYS: '1' }) })
    let status = 0
    for (let i = 0; i < 61; i += 1) {
      status = (await h.app.request('http://mandate.test/v1/members/someone/revoke', { method: 'POST' })).status
    }
    expect(status).toBe(429)
  })

  it('resetOwner writes an admin_audit row and does not remove the last owner', () => {
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-q1')
    control.ensureDefault(':memory:', NOW.toISOString())
    const ownerId = randomUUID()
    const staffId = randomUUID()
    const now = NOW.toISOString()
    control.addMember({ id: ownerId, workspaceId: 'ws_default', name: 'Meera', role: 'owner', now })
    control.addMember({ id: staffId, workspaceId: 'ws_default', name: 'Arun', role: 'proposer', now })
    const token = 'reset-owner-session-token-32chr'
    control.putSession({ token, memberId: ownerId, workspaceId: 'ws_default', method: 'passkey', now, idleHours: 12, absoluteDays: 7 })
    expect(control.resetOwner(staffId, now)).toBe('ok')
    expect(control.member(staffId)?.role).toBe('owner')
    expect(control.member(ownerId)?.role).toBe('owner')
    expect(control.resetOwner(null, now)).toBe('ok')
    expect(control.session(token, now)).toBeNull()
    expect(control.member(ownerId)?.status).toBe('active')
    expect(control.adminAudit().map((row) => row.detail)).toEqual(['promoted', 'sessions-ended'])
    expect(JSON.stringify(control.adminAudit())).not.toContain(token)
    expect(control.resetOwner(randomUUID(), now)).toBe('missing')
    controlDb.close()
  })

  it('P6.T6: sets delegation end date, expires access once passed, and allows owner renewal', async () => {
    const d = people()
    const tomorrow = new Date(NOW.getTime() + 86_400_000).toISOString()
    const yesterday = new Date(NOW.getTime() - 86_400_000).toISOString()

    // Owner sets delegation end date for proposer
    const updated = await post(d.h.app, `/v1/members/${d.proposerId}/role`, d.ownerToken, { role: 'proposer', expiresAt: tomorrow })
    expect(updated.status).toBe(200)
    const updatedBody = await updated.json() as { expiresAt: string }
    expect(updatedBody.expiresAt).toBe(tomorrow)

    // Member has active status in list and can act with fresh session
    const listBefore = await d.h.app.request('http://mandate.test/v1/members', { headers: headers(d.ownerToken) })
    const membersBefore = (await listBefore.json() as { members: Array<{ id: string; status: string; expiresAt: string | null }> }).members
    const arunBefore = membersBefore.find((m) => m.id === d.proposerId)
    expect(arunBefore?.status).toBe('active')
    expect(arunBefore?.expiresAt).toBe(tomorrow)

    // Give Arun a new session after role change
    const arunToken = 'arun-delegation-token-32chars-ok'
    d.control.putSession({ token: arunToken, memberId: d.proposerId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })

    // Arun can list sessions while delegation is active
    const activeReq = await d.h.app.request('http://mandate.test/auth/sessions', { headers: headers(arunToken) })
    expect(activeReq.status).toBe(200)

    // Expire Arun's delegation by setting end date in the past
    const expiredSet = await post(d.h.app, `/v1/members/${d.proposerId}/role`, d.ownerToken, { role: 'proposer', expiresAt: yesterday })
    expect(expiredSet.status).toBe(200)

    // Arun's session is now refused (401 sign in required / delegation expired)
    const arunExpiredToken = 'arun-delegation-token-expired'
    d.control.putSession({ token: arunExpiredToken, memberId: d.proposerId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const expiredReq = await d.h.app.request('http://mandate.test/auth/sessions', { headers: headers(arunExpiredToken) })
    expect(expiredReq.status).toBe(401)

    // List shows Arun as expired
    const listAfter = await d.h.app.request('http://mandate.test/v1/members', { headers: headers(d.ownerToken) })
    const membersAfter = (await listAfter.json() as { members: Array<{ id: string; status: string }> }).members
    const arunAfter = membersAfter.find((m) => m.id === d.proposerId)
    expect(arunAfter?.status).toBe('expired')

    // Owner renews delegation with null (open-ended)
    const renewed = await post(d.h.app, `/v1/members/${d.proposerId}/role`, d.ownerToken, { role: 'proposer', expiresAt: null })
    expect(renewed.status).toBe(200)
    const renewedToken = 'arun-delegation-token-renewed'
    d.control.putSession({ token: renewedToken, memberId: d.proposerId, workspaceId: 'ws_default', method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const renewedReq = await d.h.app.request('http://mandate.test/auth/sessions', { headers: headers(renewedToken) })
    expect(renewedReq.status).toBe(200)

    d.controlDb.close()
  })

  it('P6.T6: invite carries delegation end date to joined member', async () => {
    const d = people()
    const endDate = new Date(NOW.getTime() + 7 * 86_400_000).toISOString()
    const made = await d.h.app.request('http://mandate.test/v1/invites', {
      method: 'POST',
      headers: { ...headers(d.ownerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'proposer', delegationExpiresAt: endDate }),
    })
    expect(made.status).toBe(200)
    const token = (await made.json() as { token: string }).token

    const joined = await d.h.app.request('http://mandate.test/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, name: 'Taylor' }),
    })
    expect(joined.status).toBe(200)
    const memberId = (await joined.json() as { memberId: string }).memberId

    const member = d.control.member(memberId, NOW.toISOString())
    expect(member?.status).toBe('active')
    expect(member?.expires_at).toBe(endDate)

    d.controlDb.close()
  })
})
