import { describe, expect, it } from 'vitest'
import { createPayPalClient } from '../src/paypal/client'
import { PayPalError } from '../src/paypal/port'
import { UpstreamGuard } from '../src/paypal/resilience'

const fast = (clock: { t: number }, extra: Record<string, unknown> = {}) => ({ now: () => clock.t, sleep: async (ms: number) => { clock.t += ms }, random: () => 0, baseDelayMs: 100, ...extra })
const down = () => new PayPalError(503, 'SERVICE_UNAVAILABLE', null, 'x')

describe('the upstream guard', () => {
  it('tries a repeatable call again after a growing pause, and returns the first answer that works', async () => {
    const clock = { t: 0 }
    const pauses: number[] = []
    const guard = new UpstreamGuard({ ...fast(clock), sleep: async (ms) => { pauses.push(ms) } })
    let n = 0
    const result = await guard.run(async () => { n += 1; if (n < 3) throw down(); return 'ok' }, { repeatable: true })
    expect(result).toBe('ok')
    expect(pauses).toEqual([100, 200])
    expect(guard.status()).toMatchObject({ circuit: 'closed', consecutiveFailures: 0, retries: 2, failures: 2 })
  })

  it('never repeats a call that is not safe to repeat', async () => {
    const guard = new UpstreamGuard(fast({ t: 0 }))
    let n = 0
    await expect(guard.run(async () => { n += 1; throw down() }, { repeatable: false })).rejects.toThrow()
    expect(n).toBe(1)
  })

  it('does not repeat, or count against PayPal, an answer that is a refusal', async () => {
    const guard = new UpstreamGuard(fast({ t: 0 }))
    let n = 0
    await expect(guard.run(async () => { n += 1; throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', null, 'payee') }, { repeatable: true })).rejects.toMatchObject({ httpStatus: 422 })
    expect(n).toBe(1)
    expect(guard.status()).toMatchObject({ circuit: 'closed', failures: 0 })
  })

  it('honours Retry-After, up to a few seconds', async () => {
    const pauses: number[] = []
    const guard = new UpstreamGuard({ ...fast({ t: 0 }), sleep: async (ms) => { pauses.push(ms) } })
    let n = 0
    await guard.run(async () => { n += 1; if (n === 1) throw Object.assign(down(), { retryAfterMs: 2_000 }); if (n === 2) throw Object.assign(down(), { retryAfterMs: 60_000 }); return 1 }, { repeatable: true })
    expect(pauses).toEqual([2_000, 5_000])
  })

  it('opens after repeated failures, fails fast while open, then lets one probe decide', async () => {
    const clock = { t: 0 }
    const guard = new UpstreamGuard({ ...fast(clock), failuresToOpen: 3, cooldownMs: 10_000, attempts: 1 })
    for (let i = 0; i < 3; i += 1) await guard.run(async () => { throw down() }, { repeatable: true }).catch(() => undefined)
    expect(guard.status().circuit).toBe('open')
    let called = false
    await expect(guard.run(async () => { called = true; return 1 }, { repeatable: true })).rejects.toMatchObject({ paypalName: 'paypal_unavailable' })
    expect(called).toBe(false)
    clock.t += 10_000
    expect(guard.status().circuit).toBe('half_open')
    expect(await guard.run(async () => 'back', { repeatable: true })).toBe('back')
    expect(guard.status()).toMatchObject({ circuit: 'closed', consecutiveFailures: 0 })
  })

  it('reopens at once when the probe fails', async () => {
    const clock = { t: 0 }
    const guard = new UpstreamGuard({ ...fast(clock), failuresToOpen: 1, cooldownMs: 5_000, attempts: 1 })
    await guard.run(async () => { throw down() }, { repeatable: true }).catch(() => undefined)
    clock.t += 5_000
    await guard.run(async () => { throw down() }, { repeatable: true }).catch(() => undefined)
    expect(guard.status().circuit).toBe('open')
  })
})

describe('the PayPal client under failure', () => {
  const orderJson = { id: 'ORD1', status: 'CREATED', purchase_units: [{ amount: { value: '10.00', currency_code: 'USD' } }], links: [] }
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  const build = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const calls: Array<{ url: string; method: string }> = []
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, method: init.method ?? 'GET' })
      if (url.endsWith('/v1/oauth2/token')) return reply(200, { access_token: 'tok', expires_in: 3600, scope: 'a b' })
      return handler(url, init)
    }) as typeof fetch
    const clock = { t: 0 }
    const client = createPayPalClient({ clientId: 'id', clientSecret: 'secret', baseUrl: 'https://paypal.test', fetch: fetchImpl, guard: fast(clock) })
    return { client, calls }
  }

  it('reads an order through a 503, without the person seeing it', async () => {
    let n = 0
    const { client, calls } = build(() => (++n === 1 ? reply(503, { name: 'SERVICE_UNAVAILABLE' }) : reply(200, orderJson)))
    expect(await client.getOrder('ORD1')).toMatchObject({ orderId: 'ORD1', amountCents: 1000 })
    expect(calls.filter((c) => c.url.includes('/orders/')).length).toBe(2)
    expect(client.upstream!()).toMatchObject({ circuit: 'closed', retries: 1 })
  })

  it('reads through a dropped connection too', async () => {
    let n = 0
    const { client } = build(() => { if (++n === 1) throw new TypeError('fetch failed'); return reply(200, orderJson) })
    expect((await client.getOrder('ORD1')).orderId).toBe('ORD1')
  })

  it('makes an order create again with the same request id, and does not retry a call that has none', async () => {
    const ids: Array<string | null> = []
    let n = 0
    const { client } = build((url, init) => {
      if (url.endsWith('/v2/checkout/orders')) { ids.push(new Headers(init.headers).get('paypal-request-id')); if (++n === 1) return reply(502, { name: 'BAD_GATEWAY' }); return reply(201, { id: 'ORD2', status: 'CREATED', links: [{ rel: 'payer-action', href: 'https://x/approve' }] }) }
      return reply(200, { verification_status: 'FAILURE' })
    })
    const made = await client.createOrder({ proposalId: 'p1', amountCents: 1000, currency: 'USD', description: 'x', payeeEmail: null })
    expect(made.orderId).toBe('ORD2')
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBeTruthy()
    expect(ids[0]).toBe(ids[1])
  })

  it('takes a new token and sends the same call again when the token is refused, once', async () => {
    let tokens = 0
    let n = 0
    const clock = { t: 0 }
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/oauth2/token')) { tokens += 1; return reply(200, { access_token: `tok${tokens}`, expires_in: 3600 }) }
      return ++n === 1 ? reply(401, { name: 'AUTHENTICATION_FAILURE' }) : reply(200, orderJson)
    }) as typeof fetch
    const client = createPayPalClient({ clientId: 'i', clientSecret: 's', baseUrl: 'https://paypal.test', fetch: fetchImpl, guard: fast(clock) })
    expect((await client.getOrder('ORD1')).orderId).toBe('ORD1')
    expect(tokens).toBe(2)
  })

  it('says PayPal is not answering, quickly, after repeated failures', async () => {
    const { client, calls } = build(() => reply(500, { name: 'INTERNAL_SERVER_ERROR' }))
    for (let i = 0; i < 3; i += 1) await client.getOrder('ORD1').catch(() => undefined)
    expect(client.upstream!().circuit).toBe('open')
    const before = calls.length
    await expect(client.getOrder('ORD1')).rejects.toMatchObject({ paypalName: 'paypal_unavailable' })
    expect(calls.length).toBe(before)
  })
})
