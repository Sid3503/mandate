import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { agree, call, closeAll, collect, EVIDENCE, harness, JOB, type Requester } from './support'

afterEach(closeAll)

type App = Requester & { fetch: (request: Request) => Response | Promise<Response> }

const issue = async (app: App, scopes: string[], name = 'Test agent') => {
  const made = await call(app, 'POST', '/v1/agents', { body: { name, scopes } })
  expect(made.status).toBe(201)
  return made.json as { agent: { id: string }; apiKey: string }
}

async function connect(app: App, path: string, key: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://mandate.test${path}`), {
    fetch: (input, init) => Promise.resolve(app.fetch(new Request(input as string, init))),
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  })
  const client = new Client({ name: 'door-test', version: '1.0.0' })
  await client.connect(transport)
  return client
}

// The harness configures this as the server's public address; it is what a client is told, not the host it happened to call.
const PUBLIC_URL = 'http://127.0.0.1:8787'

const payout = { kind: 'payment', payee: 'Priya', amountCents: 9000, currency: 'USD', category: 'design', description: 'Northwind milestone 1', evidenceUrl: EVIDENCE }

describe('the read-only door', () => {
  it('offers the four tools that look, even to a key that may also ask', async () => {
    const { app } = harness()
    const { apiKey } = await issue(app, ['mcp', 'read', 'propose', 'deals'])
    const client = await connect(app, '/mcp/readonly', apiKey)
    const tools = (await client.listTools()).tools
    expect(tools.map((tool) => tool.name).sort()).toEqual(['explain', 'get_jobs', 'get_rules', 'list_ledger'])
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true)
    await client.close()
  })

  it('cannot ask to pay, because the tool is not there', async () => {
    const { app } = harness()
    const { apiKey } = await issue(app, ['mcp', 'read', 'propose'])
    const client = await connect(app, '/mcp/readonly', apiKey)
    const asked = await client.callTool({ name: 'propose', arguments: payout })
    expect(asked.isError).toBe(true)
    const ledger = await call(app, 'GET', '/v1/proposals')
    expect(ledger.json.data).toHaveLength(0)
    await client.close()
  })

  it('still needs a key', async () => {
    const { app } = harness()
    const anon = await app.request('http://mandate.test/mcp/readonly', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(anon.status).toBe(401)
  })
})

describe('how a client finds out how to connect (RFC 9728)', () => {
  it('publishes the protected-resource metadata without a key', async () => {
    const { app } = harness()
    for (const [path, door] of [['', '/mcp'], ['/mcp', '/mcp'], ['/mcp/readonly', '/mcp/readonly']] as const) {
      const response = await app.request(`http://mandate.test/.well-known/oauth-protected-resource${path}`)
      expect(response.status, path).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body.resource).toBe(`${PUBLIC_URL}${door}`)
      expect(body.bearer_methods_supported).toEqual(['header'])
      expect(body.scopes_supported).toEqual(['mcp:look', 'mcp:ask'])
      // This server is its own authorization server (see oauth.test.ts).
      expect(body.authorization_servers).toEqual([PUBLIC_URL])
    }
  })

  it('answers a missing or wrong key with the challenge that points at it', async () => {
    const { app } = harness()
    for (const [path, authorization] of [['/mcp', undefined], ['/mcp', 'Bearer mnd_ag_nope'], ['/mcp/readonly', undefined]] as const) {
      const response = await app.request(`http://mandate.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: '{}' })
      expect(response.status, `${path} ${authorization}`).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource${path}"`)
    }
  })

  it('does not put the challenge on answers that are not a missing key', async () => {
    const { app } = harness()
    const { agent, apiKey } = await issue(app, ['mcp', 'read'])
    await call(app, 'POST', `/v1/agents/${agent.id}/revoke`)
    const revoked = await app.request('http://mandate.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: '{}' })
    expect(revoked.status).toBe(403)
    expect(revoked.headers.get('www-authenticate')).toBeNull()
  })
})

describe('testing a connection from the console', () => {
  it('walks initialize, tools and the rules, and says nothing it lists can pay', async () => {
    const { app } = harness()
    const { apiKey } = await issue(app, ['mcp', 'read', 'propose'])
    const result = await call(app, 'POST', '/v1/agents/test-connection', { body: { key: apiKey } })
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ ok: true, door: '/mcp', canPay: [], server: 'mandate' })
    expect(result.json.toolCount).toBeGreaterThanOrEqual(3)
    expect(result.json.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['get_rules', 'propose', 'list_ledger']))
    expect(typeof result.json.rulesVersion).toBe('number')
    expect(JSON.stringify(result.json)).not.toContain(apiKey)
  })

  it('can test the read-only door', async () => {
    const { app } = harness()
    const { apiKey } = await issue(app, ['mcp', 'read', 'propose'])
    const result = await call(app, 'POST', '/v1/agents/test-connection', { body: { key: apiKey, door: '/mcp/readonly' } })
    expect(result.json).toMatchObject({ ok: true, door: '/mcp/readonly', toolCount: 4, canPay: [] })
  })

  it('reports a key the door refuses, and does not claim success', async () => {
    const { app } = harness()
    const result = await call(app, 'POST', '/v1/agents/test-connection', { body: { key: 'mnd_ag_not_a_real_key' } })
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ ok: false, step: 'initialize', status: 401 })
  })

  it('is the owner\'s: an agent key cannot use it to probe another key', async () => {
    const { app } = harness()
    const { apiKey } = await issue(app, ['mcp', 'read', 'propose'])
    const result = await call(app, 'POST', '/v1/agents/test-connection', { key: apiKey, body: { key: apiKey } })
    expect(result.status).toBe(403)
  })
})

describe('what the outside agents have been asking', () => {
  it('lists an agent\'s requests with what the rules said, and leaves out everyone else\'s', async () => {
    const { app } = harness()
    const { agent, apiKey } = await issue(app, ['mcp', 'read', 'propose'], 'Nightly sweep')
    const client = await connect(app, '/mcp', apiKey)
    await client.callTool({ name: 'propose', arguments: { ...payout, payee: 'P. Shah', amountCents: 48000 } })
    await client.close()
    await call(app, 'POST', '/v1/proposals', { body: payout, idem: 'owner-ask-1' })
    const feed = await call(app, 'GET', '/v1/agents/activity')
    expect(feed.status).toBe(200)
    expect(feed.json.data).toHaveLength(1)
    expect(feed.json.data[0]).toMatchObject({ agentId: agent.id, agentName: 'Nightly sweep', payee: 'P. Shah', amountCents: 48000, gate: 'DENY', clause: 'payee.unknown' })
  })

  it('shows a request that needs the owner as waiting for a tap, with nothing moved', async () => {
    const { app } = harness()
    const deal = await agree(app)
    const { captureId } = await collect(app, deal.id, 0)
    const { apiKey } = await issue(app, ['mcp', 'read', 'propose'])
    const client = await connect(app, '/mcp', apiKey)
    await client.callTool({ name: 'propose', arguments: { ...payout, jobId: JOB, fundingCaptureId: captureId, prompt: 'pay Priya her share for Northwind milestone 1' } })
    await client.close()
    const feed = await call(app, 'GET', '/v1/agents/activity')
    expect(feed.json.data[0]).toMatchObject({ gate: 'NEEDS_APPROVAL', phase: 'pending_approval', amountCents: 9000, clause: 'amount.needs_approval' })
  })

  it('is the owner\'s to read', async () => {
    const { app } = harness()
    const { apiKey } = await issue(app, ['mcp', 'read'])
    const feed = await call(app, 'GET', '/v1/agents/activity', { key: apiKey })
    expect(feed.status).toBe(403)
  })
})
