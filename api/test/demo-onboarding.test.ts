import { afterEach, describe, expect, it } from 'vitest'
import { call, closeAll, harness } from './support'
import { loadFlags } from '../src/flags'

afterEach(closeAll)

describe('demo onboarding and live proof API', () => {
  it('serves GET /v1/live-proof', async () => {
    const h = harness({ flags: loadFlags({}) })
    const res = await call(h.app, 'GET', '/v1/live-proof')
    expect(res.status).toBe(200)
    expect(res.json).toHaveProperty('files')
    expect(Array.isArray(res.json.files)).toBe(true)
  })

  it('refuses POST /v1/demo/switch outside demo workspace mode', async () => {
    const h = harness({ flags: loadFlags({}) })
    const res = await call(h.app, 'POST', '/v1/demo/switch', { body: { role: 'proposer' } })
    expect(res.status).toBe(404)
  })
})
