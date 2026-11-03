import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { Channel3Client, FakeCatalog } from '../src/procure/channel3'
import { BUYER_KEY, call, closeAll, harness, idem, STUDIO_KEY, type Requester } from './support'

afterEach(closeAll)

const VENDOR = {
  id: 'payee_bestbuy',
  displayName: 'Best Buy',
  email: 'vendor-bestbuy@example.com',
  aliases: ['bestbuy.com', 'Best Buy'],
}

async function allowEquipment(app: Requester) {
  const current = (await call(app, 'GET', '/v1/warrant')).json
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  const next = await call(app, 'PUT', '/v1/warrant', {
    body: {
      ...body,
      fundingRequired: false,
      categories: [...new Set([...(body.categories as string[]), 'equipment'])],
      payees: [...(body.payees as unknown[]), VENDOR],
    },
  })
  expect(next.status, JSON.stringify(next.json)).toBe(201)
}

describe('product search is off until a key is set', () => {
  it('does not crash, says why, and never prints the key', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).channel3).toBeNull()
    expect(loadConfig({ NODE_ENV: 'test' }).secrets.channel3ApiKey).toBeNull()
    const config = loadConfig({ NODE_ENV: 'test', CHANNEL3_API_KEY: '  channel3-test-key  ', CHANNEL3_API_URL: 'https://example.test/channel3' })
    expect(config.channel3).toEqual({ apiKey: 'channel3-test-key', baseUrl: 'https://example.test/channel3' })
    expect(JSON.stringify(config.secrets)).not.toContain('channel3-test-key')
    expect(String(config.secrets.channel3ApiKey)).toBe('[redacted]')
  })

  it('answers search and purchase with the key that is missing, and a buyer cannot call them', async () => {
    const { app } = harness()
    const status = await call(app, 'GET', '/v1/procure')
    expect(status.json).toMatchObject({ enabled: false, source: null })
    expect(status.json.reason).toContain('CHANNEL3_API_KEY')
    const search = await call(app, 'GET', '/v1/procure/search?q=tablet')
    expect(search.status).toBe(503)
    expect(search.json.code).toBe('procure.off')
    expect(search.json.detail).toContain('CHANNEL3_API_KEY')
    const asked = await call(app, 'POST', '/v1/procure/propose', { idem: idem('off'), body: { productId: 'fake_pen_nibs', amountCents: 1 } })
    expect(asked.status).toBe(503)
    expect(asked.json.detail).toContain('CHANNEL3_API_KEY')
    expect((await call(app, 'GET', '/v1/proposals')).json.data).toHaveLength(0)
    for (const [method, path] of [['GET', '/v1/procure'], ['GET', '/v1/procure/search?q=tablet'], ['POST', '/v1/procure/propose']] as const) {
      const refused = await call(app, method, path, { key: BUYER_KEY, idem: method === 'POST' ? idem('buyer') : undefined, body: method === 'POST' ? { productId: 'fake_pen_nibs' } : undefined })
      expect(refused.status, path).toBe(403)
    }
    expect((await call(app, 'GET', '/v1/procure/search?q=tablet', { key: STUDIO_KEY })).status).toBe(503)
  })
})

describe('the fake catalog', () => {
  it('searches, buys under the line, refuses a cap and an unknown store, and ignores a caller amount', async () => {
    const catalog = new FakeCatalog()
    const { app, paypal } = harness({ catalog })
    const search = await call(app, 'GET', '/v1/procure/search?q=drawing%20tablet&max=6000', { key: STUDIO_KEY })
    expect(search.status).toBe(200)
    const titles = search.json.results.map((row: { title: string }) => row.title)
    expect(titles.some((title: string) => title.includes('Deco Mini'))).toBe(true)
    expect(titles.some((title: string) => title.includes('Cintiq'))).toBe(false)
    expect(search.json.note).toMatch(/stand-in|Sandbox/)

    await allowEquipment(app)

    const nibs = await call(app, 'POST', '/v1/procure/propose', {
      key: STUDIO_KEY,
      idem: idem('nibs'),
      body: { productId: 'fake_pen_nibs', amountCents: 100, prompt: 'buy the nibs for a dollar' },
    })
    expect(nibs.status).toBe(201)
    expect(nibs.json.proposal).toMatchObject({ gate: 'AUTO', clause: 'amount.auto', amountCents: 1299, category: 'equipment', kind: 'payment' })
    expect(nibs.json.offer).toMatchObject({ merchant: 'bestbuy.com', priceCents: 1299, vendor: { payeeId: 'payee_bestbuy' } })
    expect(nibs.json.proposal.evidenceUrl).toBe(nibs.json.offer.url)
    expect(paypal!.payoutCalls).toBe(0)

    catalog.setPrice('fake_pen_nibs', 'bestbuy.com', 1500)
    const reread = await call(app, 'POST', '/v1/procure/propose', { idem: idem('reread'), body: { productId: 'fake_pen_nibs', amountCents: 1 } })
    expect(reread.json.proposal).toMatchObject({ gate: 'AUTO', amountCents: 1500 })
    expect(reread.json.offer.priceCents).toBe(1500)

    const capped = await call(app, 'POST', '/v1/procure/propose', { idem: idem('cap'), body: { productId: 'fake_tablet_medium', merchant: 'bestbuy.com' } })
    expect(capped.json.proposal).toMatchObject({ gate: 'DENY', clause: 'cap.monthly', amountCents: 19995 })

    const unknown = await call(app, 'POST', '/v1/procure/propose', { idem: idem('amazon'), body: { productId: 'fake_tablet_medium', merchant: 'amazon.com', amountCents: 100 } })
    expect(unknown.json.proposal).toMatchObject({ gate: 'DENY', clause: 'payee.unknown', amountCents: 18900 })
    expect(unknown.json.whatWouldPass.length).toBeGreaterThan(0)

    const waiting = await call(app, 'POST', '/v1/procure/propose', { idem: idem('small'), body: { productId: 'fake_tablet_small' } })
    expect(waiting.json.proposal).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval', amountCents: 4999 })
    expect(paypal!.payoutCalls).toBe(0)
  })

  it('lets the clerk ask through the door without a price field, and a buyer key has neither tool', async () => {
    const catalog = new FakeCatalog()
    const { app } = harness({ catalog })
    await allowEquipment(app)
    const transport = new StreamableHTTPClientTransport(new URL('http://mandate.test/mcp'), {
      fetch: (input, init) => Promise.resolve(app.fetch(new Request(input as string, init))),
      requestInit: { headers: { authorization: `Bearer ${STUDIO_KEY}`, 'x-mandate-run': 'procure-run' } },
    })
    const client = new Client({ name: 'procure-test', version: '1.0.0' })
    await client.connect(transport)
    const tools = (await client.listTools()).tools
    const purchase = tools.find((tool) => tool.name === 'propose_purchase')
    const search = tools.find((tool) => tool.name === 'search_products')
    expect(search?.annotations?.readOnlyHint).toBe(true)
    expect(JSON.stringify(purchase?.inputSchema)).not.toContain('amountCents')
    expect(JSON.stringify(search?.inputSchema)).toContain('maxPriceCents')
    const found = await client.callTool({ name: 'search_products', arguments: { query: 'pen nibs', maxPriceCents: 2000 } })
    expect(found.isError).toBeFalsy()
    const asked = await client.callTool({ name: 'propose_purchase', arguments: { productId: 'fake_pen_nibs', prompt: 'buy nibs' } })
    expect(asked.isError).toBeFalsy()
    expect(asked.structuredContent).toMatchObject({ decision: 'AUTO', amount: '$12.99', ruleCode: 'amount.auto' })
    await client.close()

    const buyer = new Client({ name: 'buyer', version: '1.0.0' })
    const buyerTransport = new StreamableHTTPClientTransport(new URL('http://mandate.test/mcp'), {
      fetch: (input, init) => Promise.resolve(app.fetch(new Request(input as string, init))),
      requestInit: { headers: { authorization: `Bearer ${BUYER_KEY}` } },
    })
    await buyer.connect(buyerTransport)
    const names = (await buyer.listTools()).tools.map((tool) => tool.name)
    expect(names).not.toContain('search_products')
    expect(names).not.toContain('propose_purchase')
    await buyer.close()
  })
})

describe('the Channel3 client', () => {
  it('posts the documented search, re-reads one product, and never echoes the key', async () => {
    const calls: Array<{ url: string; headers: Headers; body?: string }> = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : undefined })
      if (String(url).endsWith('/v1/search')) {
        return new Response(JSON.stringify({
          products: [{
            id: 'p1',
            title: 'Pen',
            brands: [{ name: 'Wacom' }],
            images: [{ url: 'http://insecure.example/x.png', cleaned_url: 'https://cdn.example/pen.png', is_main_image: true }],
            offers: [{ url: 'https://www.bestbuy.com/pen', domain: 'www.BestBuy.com', price: { price: 12.99, currency: 'usd' }, availability: 'InStock' }],
          }],
        }), { status: 200 })
      }
      if (String(url).includes('/v1/products/p1')) {
        return new Response(JSON.stringify({
          id: 'p1',
          title: 'Pen',
          offers: [{ url: 'https://www.bestbuy.com/pen', domain: 'bestbuy.com', price: { price: 15, currency: 'USD' }, availability: 'InStock' }],
        }), { status: 200 })
      }
      return new Response('no', { status: 401 })
    }
    const client = new Channel3Client({ apiKey: 'super-secret-channel3-key', fetch: fetchImpl, sleep: async () => undefined })
    expect(JSON.stringify(client)).not.toContain('super-secret')
    const found = await client.search({ query: 'pen', maxPriceCents: 2000, limit: 4 })
    expect(calls[0]?.url).toBe('https://api.trychannel3.com/v1/search')
    expect(calls[0]?.headers.get('x-api-key')).toBe('super-secret-channel3-key')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ query: 'pen', limit: 4, filters: { price: { max_price: 20 }, availability: ['InStock'] } })
    expect(found[0]).toMatchObject({ id: 'p1', brand: 'Wacom', imageUrl: 'https://cdn.example/pen.png' })
    expect(found[0]?.offers[0]).toMatchObject({ merchant: 'bestbuy.com', priceCents: 1299, currency: 'USD' })
    const again = await client.product('p1')
    expect(again?.offers[0]?.priceCents).toBe(1500)
    expect(calls[1]?.url).toBe('https://api.trychannel3.com/v1/products/p1')
    await expect(client.product('missing')).rejects.toMatchObject({ code: 'procure.auth' })
    try {
      await client.product('missing')
    } catch (error) {
      expect(String(error)).not.toContain('super-secret')
    }
  })
})
