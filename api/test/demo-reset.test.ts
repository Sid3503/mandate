import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { resetDemo } from '../src/db/database'
import { agree, call, closeAll, collect, harness, NOW, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

describe('resetting a hosted demo', () => {
  it('is refused outside the sandbox, and off unless it is asked for', () => {
    const base = { PORT: '8787', API_KEY: 'a'.repeat(20), PROPOSER_KEY: 'b'.repeat(20), PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'y' }
    expect(loadConfig({ ...base }).demoReset).toBe(false)
    expect(loadConfig({ ...base, DEMO_RESET: 'on' }).demoReset).toBe(true)
    expect(() => loadConfig({ ...base, DEMO_RESET: 'on', PAYPAL_API: 'https://api-m.paypal.com' })).toThrow(/sandbox/)
  })

  it('builds links from the address the host gives it, so a hosted copy never hands out a 0.0.0.0 link', () => {
    const base = { HOST: '0.0.0.0', PORT: '10000' }
    expect(loadConfig(base).publicUrl).toBe('http://0.0.0.0:10000')
    expect(loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://mandate.onrender.com' }).publicUrl).toBe('https://mandate.onrender.com')
    expect(loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://mandate.onrender.com', PUBLIC_URL: 'https://mandate.example' }).publicUrl).toBe('https://mandate.example')
  })

  it('wipes the money state back to a fresh Line Studio, keeps the keys, and leaves the app working', async () => {
    const h = harness()
    const deal = await agree(h.app)
    await collect(h.app, deal.id, 0)
    await call(h.app, 'POST', '/v1/agents', { body: { name: 'Judge agent', scopes: ['read', 'mcp'] } })
    expect((await call(h.app, 'GET', '/v1/proposals')).json.data.length).toBeGreaterThan(0)
    expect((await call(h.app, 'GET', '/v1/deals')).json.data.length).toBeGreaterThan(0)

    resetDemo(h.db, NOW)

    expect((await call(h.app, 'GET', '/v1/proposals')).json.data).toEqual([])
    expect((await call(h.app, 'GET', '/v1/deals')).json.data).toEqual([])
    const rules = (await call(h.app, 'GET', '/v1/warrant')).json
    expect(rules).toMatchObject({ version: 1, currency: 'USD', contractorShareBps: 6000 })
    // The keys people already hold still work, and so does a whole new job afterwards.
    expect((await call(h.app, 'GET', '/v1/agents')).json).toEqual([expect.objectContaining({ name: 'Judge agent' })])
    const again = await agree(h.app)
    expect((await collect(h.app, again.id, 0)).captureId).toBeTruthy()
  })
})

describe('the reset route', () => {
  it('does not exist unless the server was started as a resettable demo', async () => {
    const h = harness()
    const asked = await call(h.app, 'POST', '/v1/demo/reset', { key: OWNER_KEY, body: { confirm: 'reset the demo' } })
    expect(asked.status).toBe(404)
    expect(asked.json.code).toBe('demo.off')
    expect((await call(h.app, 'GET', '/v1/session')).json.demoReset).toBe(false)
  })

  it('is the owner\'s, and needs the typed phrase', async () => {
    const h = harness({ demoReset: true })
    expect((await call(h.app, 'GET', '/v1/session')).json.demoReset).toBe(true)
    expect((await call(h.app, 'POST', '/v1/demo/reset', { key: STUDIO_KEY, body: { confirm: 'reset the demo' } })).status).toBe(403)
    expect((await call(h.app, 'POST', '/v1/demo/reset', { body: {} })).status).toBe(422)
    expect((await call(h.app, 'POST', '/v1/demo/reset', { body: { confirm: 'yes' } })).status).toBe(422)
    const deal = await agree(h.app)
    await collect(h.app, deal.id, 0)
    const done = await call(h.app, 'POST', '/v1/demo/reset', { body: { confirm: 'reset the demo' } })
    expect(done.status).toBe(200)
    expect((await call(h.app, 'GET', '/v1/proposals')).json.data).toEqual([])
  })
})
