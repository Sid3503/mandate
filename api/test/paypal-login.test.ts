import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { closeAll, harness, NOW } from './support'
import { loadFlags } from '../src/flags'
import { ControlStore } from '../src/control/store'
import { openDatabase } from '../src/db/database'

afterEach(closeAll)

describe('Log in with PayPal (P9.T4) behind FLAG_PAYPAL_LOGIN', () => {
  it('returns 404 for paypal login endpoints when flag is off by default', async () => {
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-test')
    control.ensureDefault(':memory:', NOW.toISOString())
    const h = harness({ flags: loadFlags({}), control })

    const startRes = await h.app.request('http://mandate.test/auth/paypal/start')
    expect(startRes.status).toBe(404)
    const startBody = await startRes.json()
    expect(startBody.code).toBe('flag/disabled')

    const callbackRes = await h.app.request('http://mandate.test/auth/paypal/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'mock_code' }),
    })
    expect(callbackRes.status).toBe(404)
    const callbackBody = await callbackRes.json()
    expect(callbackBody.code).toBe('flag/disabled')

    controlDb.close()
  })

  it('runs fake PayPal IdP flow and issues session when flag is enabled', async () => {
    const controlDb = openDatabase(':memory:')
    const control = new ControlStore(controlDb, 'pepper-test')
    control.ensureDefault(':memory:', NOW.toISOString())
    const h = harness({ flags: loadFlags({ PAYPAL_LOGIN_ENABLED: '1' }), control })

    // 1. Start flow
    const startRes = await h.app.request('http://mandate.test/auth/paypal/start')
    expect(startRes.status).toBe(200)
    const start = await startRes.json()
    expect(start.url).toContain('https://www.sandbox.paypal.com/signin/authorize')
    expect(start.url).toContain('client_id=fake_client')
    expect(start.state).toBeTypeOf('string')

    // 2. Reject missing code
    const emptyRes = await h.app.request('http://mandate.test/auth/paypal/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: start.state }),
    })
    expect(emptyRes.status).toBe(400)

    // 3. Reject invalid code
    const badRes = await h.app.request('http://mandate.test/auth/paypal/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'invalid_code', state: start.state }),
    })
    expect(badRes.status).toBe(401)
    const badBody = await badRes.json()
    expect(badBody.code).toBe('auth/paypal-failed')

    // 4. Successful callback
    const successRes = await h.app.request('http://mandate.test/auth/paypal/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'mock_valid_code_123', state: start.state }),
    })
    expect(successRes.status).toBe(200)
    const cookie = successRes.headers.get('set-cookie')
    expect(cookie).toContain('mnd_session=')

    const user = await successRes.json()
    expect(user.workspaceId).toBe('ws_default')
    expect(user.role).toBeTruthy()

    // 5. Authenticated session verifies via /auth/me
    const meRes = await h.app.request('http://mandate.test/auth/me', {
      headers: { cookie: cookie ?? '', 'x-mandate-client': 'web' },
    })
    expect(meRes.status).toBe(200)
    const me = await meRes.json()
    expect(me.method).toBe('paypal')
    expect(me.workspaceId).toBe('ws_default')

    controlDb.close()
  })
})
