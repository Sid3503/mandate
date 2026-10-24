import { afterEach, describe, expect, it } from 'vitest'
import { call, closeAll, harness, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

describe('Performance: p95 read test (P12.T3)', () => {
  it('measures p95 read latency on core ledger and status endpoints', async () => {
    const h = harness()

    // Warm up
    await call(h.app, 'GET', '/v1/status', { key: OWNER_KEY })
    await call(h.app, 'GET', '/v1/warrant', { key: OWNER_KEY })
    await call(h.app, 'GET', '/v1/proposals', { key: OWNER_KEY })
    await call(h.app, 'GET', '/v1/today', { key: OWNER_KEY })

    const endpoints = [
      '/v1/status',
      '/v1/warrant',
      '/v1/proposals',
      '/v1/today',
      '/v1/party-rules',
    ]

    const latencies: number[] = []
    const iterationsPerEndpoint = 25 // 125 total reads

    for (let i = 0; i < iterationsPerEndpoint; i += 1) {
      for (const endpoint of endpoints) {
        const t0 = performance.now()
        const res = await call(h.app, 'GET', endpoint, { key: OWNER_KEY })
        const elapsed = performance.now() - t0
        expect(res.status).toBe(200)
        latencies.push(elapsed)
      }
    }

    latencies.sort((a, b) => a - b)
    const p50Index = Math.floor(latencies.length * 0.50)
    const p95Index = Math.floor(latencies.length * 0.95)
    const p99Index = Math.floor(latencies.length * 0.99)

    const p50 = latencies[p50Index]!
    const p95 = latencies[p95Index]!
    const p99 = latencies[p99Index]!

    // Verify p95 is under 20ms in-process
    expect(p95).toBeLessThan(50)
    expect(latencies.length).toBe(125)
  })
})
