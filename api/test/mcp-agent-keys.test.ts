import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RETRY_WINDOW_MS } from '../src/mcp/http'
import { agree, call, closeAll, collect, confirmPrices, EVIDENCE, harness, idem, JOB, STUDIO_KEY, terms, type Requester } from './support'

afterEach(() => {
  vi.useRealTimers()
  closeAll()
})

/**
 * "Connect an agent", end to end, the way a judge does it: the owner issues a key, a real MCP client (the official SDK
 * client, the same protocol Claude Code and Cursor speak) connects with it, and what it may do is what the owner chose.
 */

type App = Requester & { fetch: (request: Request) => Response | Promise<Response> }
type Scope = 'read' | 'propose' | 'stream' | 'mcp' | 'deals'

const issue = async (app: App, scopes: Scope[], extra: Record<string, unknown> = {}, name = 'Test agent') => {
  const made = await call(app, 'POST', '/v1/agents', { body: { name, scopes, ...extra } })
  expect(made.status).toBe(201)
  return made.json as { agent: { id: string }; apiKey: string }
}

/** Opens a connection like a real client does. A run id is sent only when the test asks for one, as real clients send none. */
async function connect(app: App, key: string, options: { runId?: string; log?: string[] } = {}) {
  const transport = new StreamableHTTPClientTransport(new URL('http://mandate.test/mcp'), {
    fetch: async (input, init) => {
      const response = await app.fetch(new Request(input as string, init))
      options.log?.push(`${(init as { method?: string } | undefined)?.method ?? 'GET'} ${response.status}`)
      return response
    },
    requestInit: { headers: { authorization: `Bearer ${key}`, ...(options.runId ? { 'x-mandate-run': options.runId } : {}) } },
  })
  const client = new Client({ name: 'real-client', version: '1.0.0' })
  await client.connect(transport)
  const use = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    return { error: result.isError === true, data: result.structuredContent as Record<string, any>, text: JSON.stringify(result.content) }
  }
  const tools = async () => (await client.listTools()).tools.map((tool) => tool.name).sort()
  return { client, use, tools }
}

const payout = { kind: 'payment', payee: 'Priya', amountCents: 9000, currency: 'USD', category: 'design', description: 'Northwind milestone 1', evidenceUrl: EVIDENCE }
const stranger = (n: number, cents = 100) => ({ ...payout, payee: `Stranger ${n}`, amountCents: cents })
const rpc = (app: App, key: string, body: string, headers: Record<string, string> = {}, method = 'POST') =>
  app.request('http://mandate.test/mcp', { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body: method === 'POST' ? body : undefined })

describe('the scopes on an agent key decide which tools it gets', () => {
  const SIX = ['explain', 'get_jobs', 'get_rules', 'list_ledger', 'offer_deal', 'propose']

  it('gives each combination of scopes exactly the tools it allows, and the full set when the owner allows everything', async () => {
    const { app } = harness()
    const cases: Array<[Scope[], string[]]> = [
      [['mcp', 'read'], ['explain', 'get_jobs', 'get_rules', 'list_ledger']],
      [['mcp', 'propose'], ['propose']],
      [['mcp', 'deals'], ['explain', 'offer_deal']],
      [['mcp', 'read', 'propose'], ['explain', 'get_jobs', 'get_rules', 'list_ledger', 'propose']],
      [['mcp', 'read', 'propose', 'deals'], SIX],
      [['mcp', 'read', 'propose', 'deals', 'stream'], SIX],
    ]
    for (const [scopes, expected] of cases) {
      const key = await issue(app, scopes)
      const { client, tools } = await connect(app, key.apiKey)
      expect(await tools(), scopes.join('+')).toEqual(expected)
      await client.close()
    }
  })

  it('cannot call a tool it was not given, and a read-only key never creates a request', async () => {
    const { app } = harness()
    const key = await issue(app, ['mcp', 'read'])
    const { client, use } = await connect(app, key.apiKey)
    const asked = await use('propose', stranger(1))
    expect(asked.error).toBe(true)
    expect(asked.text).toMatch(/disabled|not found/i)
    const offered = await use('offer_deal', { buyer: 'Northwind', terms: terms(30_000) })
    expect(offered.error).toBe(true)
    expect(offered.text).toMatch(/disabled|not found/i)
    expect((await use('list_ledger')).data.count).toBe(0)
    expect((await call(app, 'GET', '/v1/proposals')).json.data).toHaveLength(0)
    await client.close()
  })

  it('refuses a key that opens the door onto nothing', async () => {
    const { app } = harness()
    const made = await call(app, 'POST', '/v1/agents', { body: { name: 'Empty room', scopes: ['mcp'] } })
    expect(made.status).toBe(422)
    expect(made.json.code).toBe('agent.scopes')
    expect((await call(app, 'POST', '/v1/agents', { body: { name: 'Empty room', scopes: ['mcp', 'stream'] } })).status).toBe(422)
    expect((await call(app, 'GET', '/v1/agents')).json).toHaveLength(0)
  })

  it('explains a request only with read, and a deal only with deals', async () => {
    const { app } = harness()
    await confirmPrices(app)
    const deal = (await call(app, 'POST', '/v1/deals/offers', { idem: idem('deal'), body: { buyer: 'Northwind', terms: terms(30_000, { jobId: JOB }) } })).json.id as string
    const asked = (await call(app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { ...payout, payee: 'P. Shah' } })).json.id as string
    const reader = await connect(app, (await issue(app, ['mcp', 'read'])).apiKey)
    const negotiator = await connect(app, (await issue(app, ['mcp', 'deals'])).apiKey)
    expect((await reader.use('explain', { id: asked })).data).toMatchObject({ kind: 'request', ruleCode: 'payee.unknown' })
    expect((await reader.use('explain', { id: deal })).data.error.code).toBe('agent.scope')
    expect((await negotiator.use('explain', { id: deal })).data).toMatchObject({ kind: 'deal', status: 'agreed' })
    expect((await negotiator.use('explain', { id: asked })).data.error.code).toBe('agent.scope')
  })

  it('does not narrow the keys the owner did not issue as agent keys', async () => {
    const { app } = harness()
    const { client, tools } = await connect(app, STUDIO_KEY)
    expect(await tools()).toEqual(SIX)
    await client.close()
  })

  it('refuses a key without the MCP door at the door, and keeps its REST access', async () => {
    const { app } = harness()
    const key = await issue(app, ['read', 'propose'])
    await expect(connect(app, key.apiKey)).rejects.toThrow(/agent\.scope/)
    expect((await call(app, 'GET', '/v1/warrant', { key: key.apiKey })).status).toBe(200)
    const denied = await rpc(app, key.apiKey, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
    expect(denied.status).toBe(403)
    expect((await denied.json() as { detail: string }).detail).toContain('Granted scopes: read, propose')
  })
})

describe('an issued key through the door: who it is, how much it may ask, when it is stopped', () => {
  it('files what it asks under its own name, and shows when it was last seen', async () => {
    const { app } = harness()
    const key = await issue(app, ['mcp', 'read', 'propose'], {}, 'Nightly sweep')
    expect((await call(app, 'GET', '/v1/agents')).json[0].lastSeenAt).toBeNull()
    const { use } = await connect(app, key.apiKey)
    const asked = await use('propose', { ...payout, payee: 'P. Shah', amountCents: 48_000 })
    expect(asked.data).toMatchObject({ decision: 'DENY', ruleCode: 'payee.unknown', moneyMoved: '$0.00' })
    const events = (await call(app, 'GET', `/v1/proposals/${asked.data.proposalId}/packet`)).json.events
    expect(events[0].payload.actor).toBe(`agent:${key.agent.id}`)
    expect((await call(app, 'GET', '/v1/agents')).json[0].lastSeenAt).not.toBeNull()
  })

  it('stops an agent at its hourly count and at its hourly value, with a code it can read', async () => {
    const { app } = harness()
    const few = await connect(app, (await issue(app, ['mcp', 'propose'], { limits: { proposalsPerHour: 2, centsPerHour: 1_000_000 } })).apiKey)
    const codes: string[] = []
    for (let i = 0; i < 4; i++) {
      const r = await few.use('propose', stranger(i))
      codes.push(r.error ? r.data.error.code : r.data.ruleCode)
    }
    expect(codes).toEqual(['payee.unknown', 'payee.unknown', 'agent.over_limit', 'agent.over_limit'])
    const small = await connect(app, (await issue(app, ['mcp', 'propose'], { limits: { proposalsPerHour: 60, centsPerHour: 150 } }, 'Small')).apiKey)
    expect((await small.use('propose', stranger(1, 100))).data.ruleCode).toBe('payee.unknown')
    const over = await small.use('propose', stranger(2, 100))
    expect(over.error).toBe(true)
    expect(over.data.error.code).toBe('agent.over_limit')
  })

  it('suspends only the agent that keeps asking for what the rules never allow, and the owner can resume it', async () => {
    const { app } = harness({ breaker: { tripAfter: 3, windowSeconds: 120 } })
    const noisy = await issue(app, ['mcp', 'propose'], {}, 'Noisy')
    const calm = await issue(app, ['mcp', 'read'], {}, 'Calm')
    const { use } = await connect(app, noisy.apiKey)
    for (let i = 0; i < 3; i++) expect((await use('propose', stranger(i))).data.ruleCode).toBe('payee.unknown')
    // The next request is stopped at the door, with the owner's way back in the message.
    await expect(use('propose', stranger(9))).rejects.toThrow(/agent\.suspended/)
    await expect(connect(app, noisy.apiKey)).rejects.toThrow(/suspended/)
    expect((await call(app, 'GET', '/v1/safety')).json.paused).toBe(false)
    const fine = await connect(app, calm.apiKey)
    expect(await fine.tools()).toContain('get_rules')
    expect((await call(app, 'GET', '/v1/agents')).json.find((row: { name: string }) => row.name === 'Noisy').status).toBe('suspended')
    expect((await call(app, 'POST', `/v1/agents/${noisy.agent.id}/resume`)).status).toBe(200)
    expect(await (await connect(app, noisy.apiKey)).tools()).toEqual(['propose'])
  })

  it('does not count the slips an honest agent makes (asking before the client paid, forgetting the proof link)', async () => {
    const { app } = harness({ breaker: { tripAfter: 3, windowSeconds: 120 } })
    const key = await issue(app, ['mcp', 'propose'])
    const { use } = await connect(app, key.apiKey)
    for (let i = 0; i < 5; i++) expect((await use('propose', { ...payout, description: `early ${i}` })).data.ruleCode).toBe('funding.missing')
    for (let i = 0; i < 5; i++) expect((await use('propose', { ...payout, kind: 'charge', payee: 'Northwind', evidenceUrl: undefined, description: `no link ${i}` })).data.ruleCode).toMatch(/evidence\.missing|job\.missing/)
    expect((await call(app, 'GET', '/v1/agents')).json[0].status).toBe('active')
  })

  it('says 403 for a revoked key and 401 for a wrong one, in words a person can act on', async () => {
    const { app } = harness()
    const key = await issue(app, ['mcp', 'read'])
    await call(app, 'POST', `/v1/agents/${key.agent.id}/revoke`)
    await expect(connect(app, key.apiKey)).rejects.toThrow(/agent\.revoked/)
    await expect(connect(app, 'mnd_ag_totallywrongtotallywrong1234')).rejects.toThrow(/auth\.unauthorized/)
    expect((await rpc(app, '', '{}')).status).toBe(401)
  })

  it('lets an agent with the deals scope negotiate the frozen deal: $450 no, $200 no, $300 yes', async () => {
    const { app } = harness()
    await confirmPrices(app)
    const { use } = await connect(app, (await issue(app, ['mcp', 'deals', 'read'], {}, 'Sales')).apiKey)
    const offer = (total: number) => use('offer_deal', { buyer: 'Northwind', terms: terms(total, { jobId: JOB }) })
    expect((await offer(45_000)).data).toMatchObject({ result: 'REFUSED', violations: [{ ruleCode: 'deal.over_buyer_limit' }] })
    expect((await offer(20_000)).data).toMatchObject({ result: 'REFUSED', violations: [{ ruleCode: 'deal.under_seller_minimum' }] })
    expect((await offer(30_000)).data).toMatchObject({ result: 'AGREED', violations: [] })
  })
})

describe('a real client sends no run id, so a retry must not become a second request', () => {
  const ask = { ...payout, payee: 'P. Shah', amountCents: 48_000 }

  it('answers an identical call inside the window with the first answer, and files one request', async () => {
    const { app } = harness()
    const { use } = await connect(app, (await issue(app, ['mcp', 'propose'])).apiKey)
    const first = await use('propose', ask)
    const second = await use('propose', ask)
    expect(second.data.proposalId).toBe(first.data.proposalId)
    expect((await call(app, 'GET', '/v1/proposals')).json.data).toHaveLength(1)
    // A different request is a different request.
    expect((await use('propose', { ...ask, amountCents: 48_100 })).data.proposalId).not.toBe(first.data.proposalId)
    expect((await call(app, 'GET', '/v1/proposals')).json.data).toHaveLength(2)
  })

  it('asks again, and judges afresh, once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { app } = harness()
    const { use } = await connect(app, (await issue(app, ['mcp', 'propose'])).apiKey)
    const first = await use('propose', ask)
    vi.setSystemTime(Date.now() + RETRY_WINDOW_MS + 1_000)
    const later = await use('propose', ask)
    expect(later.data.proposalId).not.toBe(first.data.proposalId)
    expect((await call(app, 'GET', '/v1/proposals')).json.data).toHaveLength(2)
  })

  it('does not let one caller\'s retry answer another caller', async () => {
    const { app } = harness()
    const a = await connect(app, (await issue(app, ['mcp', 'propose'], {}, 'A')).apiKey)
    const b = await connect(app, (await issue(app, ['mcp', 'propose'], {}, 'B')).apiKey)
    expect((await a.use('propose', ask)).data.proposalId).not.toBe((await b.use('propose', ask)).data.proposalId)
  })

  it('still stops a loop that repeats one call over and over', async () => {
    const { app } = harness()
    const { use } = await connect(app, (await issue(app, ['mcp', 'propose'])).apiKey)
    let last: Awaited<ReturnType<typeof use>> | null = null
    for (let i = 0; i < 14; i++) last = await use('propose', ask)
    expect(last!.error).toBe(true)
    expect(last!.data.error.code).toBe('budget.exceeded')
    expect((await call(app, 'GET', '/v1/proposals')).json.data).toHaveLength(1)
  })

  it('pays a payout once under a standing rule even when the client asks twice', async () => {
    const { app, paypal } = harness()
    const deal = await agree(app)
    const charge = await collect(app, deal.id, 0)
    const current = (await call(app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    await call(app, 'PUT', '/v1/warrant', { body: { ...body, standing: [{ id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }] } })
    const { use } = await connect(app, (await issue(app, ['mcp', 'propose'])).apiKey)
    const request = { ...payout, description: 'Share', jobId: deal.jobId, fundingCaptureId: charge.captureId }
    const first = await use('propose', request)
    const second = await use('propose', request)
    expect(first.data).toMatchObject({ decision: 'AUTO', ruleCode: 'standing.matched', moneyMoved: '$90.00' })
    expect(second.data.proposalId).toBe(first.data.proposalId)
    expect(paypal!.payoutCalls).toBe(1)
  })
})

describe('the door speaks plain HTTP the way the protocol says', () => {
  const list = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  const both = { accept: 'application/json, text/event-stream' }

  it('answers GET and DELETE with 405 and an Allow header, so a client stops looking for a stream', async () => {
    const { app } = harness()
    const key = (await issue(app, ['mcp', 'read'])).apiKey
    for (const method of ['GET', 'DELETE']) {
      const response = await rpc(app, key, '', both, method)
      expect(response.status, method).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
    }
    // Still behind the key.
    expect((await app.request('http://mandate.test/mcp', { method: 'GET' })).status).toBe(401)
  })

  it('does not make a real client reconnect over and over', async () => {
    const { app } = harness()
    const log: string[] = []
    const { client } = await connect(app, (await issue(app, ['mcp', 'read'])).apiKey, { log })
    await new Promise((resolve) => setTimeout(resolve, 1_800))
    await client.close()
    expect(log.filter((line) => line.startsWith('GET'))).toEqual(['GET 405'])
  })

  it('serves a plain HTTP client that sends no Accept header, or only one of the two', async () => {
    const { app } = harness()
    const key = (await issue(app, ['mcp', 'read'])).apiKey
    for (const headers of [{}, { accept: 'application/json' }, { accept: '*/*' }, both]) {
      const response = await rpc(app, key, list, headers)
      expect(response.status, JSON.stringify(headers)).toBe(200)
      expect(JSON.stringify(await response.json())).toContain('get_rules')
    }
    const noType = await app.request('http://mandate.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: list })
    expect(noType.status).toBe(200)
  })

  it('answers bad JSON and oversize bodies with a protocol error, and notifications with 202', async () => {
    const { app } = harness()
    const key = (await issue(app, ['mcp', 'read'])).apiKey
    const bad = await rpc(app, key, '{not json', both)
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).toContain('-32700')
    expect((await rpc(app, key, ' '.repeat(1_000_001), both)).status).toBe(413)
    expect((await rpc(app, key, '{"jsonrpc":"2.0","method":"notifications/initialized"}', both)).status).toBe(202)
    const ping = await rpc(app, key, '{"jsonrpc":"2.0","id":9,"method":"ping"}', both)
    expect(await ping.json()).toMatchObject({ id: 9, result: {} })
  })

  it('negotiates every protocol version the client libraries use today', async () => {
    const { app } = harness()
    const key = (await issue(app, ['mcp', 'read'])).apiKey
    for (const version of ['2024-11-05', '2025-03-26', '2025-06-18']) {
      const response = await rpc(app, key, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } } }), both)
      expect(response.status, version).toBe(200)
      expect((await response.json() as { result: { protocolVersion: string; serverInfo: { name: string } } }).result).toMatchObject({ protocolVersion: version, serverInfo: { name: 'mandate' } })
    }
  })
})
