import { afterEach, describe, expect, it } from 'vitest'
import { call, closeAll, harness, OWNER_KEY, STUDIO_KEY, BUYER_KEY } from './support'
import { PayPalError } from '../src/paypal/port'
import { paypalProblem } from '../src/services/paypalProblem'

afterEach(closeAll)

describe('what Mandate says about itself', () => {
  it('reports nothing degraded when everything is fine, to any key, without calling PayPal', async () => {
    const h = harness()
    for (const key of [OWNER_KEY, STUDIO_KEY]) {
      const status = await call(h.app, 'GET', '/v1/status', { key })
      expect(status.status).toBe(200)
      expect(status.json).toMatchObject({ degraded: [], paypal: null, ai: { enabled: false } })
    }
  })

  it('keeps a client\'s agent away from the status page, like everything else that is not its door', async () => {
    expect((await call(harness().app, 'GET', '/v1/status', { key: BUYER_KEY })).status).toBe(403)
  })

  it('says it is draining while shutting down, so traffic moves away', async () => {
    let draining = false
    const h = harness({ draining: () => draining })
    expect((await h.app.request('http://mandate.test/ready')).status).toBe(200)
    draining = true
    const response = await h.app.request('http://mandate.test/ready')
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).toContain('shutting down')
  })
})

describe('errors from the person\'s screen', () => {
  const report = (app: Parameters<typeof call>[0], body: unknown, key?: string) => call(app, 'POST', '/v1/client-errors', { key, body })

  it('stores a report, shows the newest to the owner only, and never trusts its size', async () => {
    const h = harness()
    expect((await report(h.app, { scope: 'screen:rules', message: 'Cannot read properties of undefined', stack: 'at x', url: '/app/rules' }, STUDIO_KEY)).status).toBe(201)
    const list = await call(h.app, 'GET', '/v1/client-errors')
    expect(list.json.data[0]).toMatchObject({ scope: 'screen:rules', message: 'Cannot read properties of undefined', role: 'proposer' })
    expect((await call(h.app, 'GET', '/v1/client-errors', { key: STUDIO_KEY })).status).toBe(403)
    expect((await report(h.app, { scope: 'x', message: 'y'.repeat(600) })).status).toBe(400)
    expect((await report(h.app, { scope: 'Bad Scope!', message: 'y' })).status).toBe(400)
    const huge = await h.app.request('http://mandate.test/v1/client-errors', { method: 'POST', headers: { authorization: `Bearer ${OWNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'app', message: 'm', stack: 's'.repeat(20_000) }) })
    expect(huge.status).toBe(413)
  })

  it('takes at most twenty a minute from one key, and says so politely', async () => {
    const h = harness()
    let stored = 0
    for (let n = 0; n < 25; n += 1) stored += (await report(h.app, { scope: 'app', message: `boom ${n}` })).status === 201 ? 1 : 0
    expect(stored).toBe(20)
    expect((await report(h.app, { scope: 'app', message: 'one more' })).json).toEqual({ stored: false, reason: 'rate_limited' })
  })
})

describe('what a failed PayPal call means', () => {
  it('tells "PayPal said no" from "PayPal did not answer"', () => {
    expect(paypalProblem(new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'dbg1', 'x'), 'to settle')).toMatchObject({ status: 502, code: 'paypal.upstream', extensions: { debugId: 'dbg1' } })
    for (const status of [500, 503, 429]) expect(paypalProblem(new PayPalError(status, 'X', null, ''), 'to settle')).toMatchObject({ status: 503, code: 'paypal.unavailable', extensions: { retryable: true } })
    expect(paypalProblem(new TypeError('fetch failed'), 'to settle')).toMatchObject({ code: 'paypal.unavailable' })
  })
})

describe('the promises Mandate lists', () => {
  it('lists only promises that name a check or a test that exists', async () => {
    const { existsSync } = await import('node:fs')
    const h = harness()
    const { json } = await call(h.app, 'GET', '/v1/guarantees', { key: STUDIO_KEY })
    expect(json.guarantees.length).toBeGreaterThan(10)
    const audit = (await call(h.app, 'GET', '/v1/audit')).json.checks.map((check: { id: string }) => check.id)
    for (const item of json.guarantees as Array<{ id: string; audit?: string; tests: string[] }>) {
      if (item.audit) expect(audit, `${item.id} names an audit check that does not exist`).toContain(item.audit)
      for (const test of item.tests) expect(existsSync(new URL(`../${test}`, import.meta.url)), `${item.id} names ${test}, which does not exist`).toBe(true)
    }
    expect(json.deepRun).toMatchObject({ months: 3000, violations: 0 })
  })
})
