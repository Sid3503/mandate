import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlStore } from '../src/control/store'
import { openDatabase } from '../src/db/database'
import { loadFlags } from '../src/flags'
import { rateClass } from '../src/ops/ratelimit'
import { closeAll, harness, NOW } from './support'

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
  return { h, controlDb, ownerToken, proposerToken, strangerToken }
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
