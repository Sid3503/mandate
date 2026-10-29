import { createHash, randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { call, closeAll, EVIDENCE, harness, type Requester } from './support'

afterEach(closeAll)

type App = Requester & { fetch: (request: Request) => Response | Promise<Response> }

const ORIGIN = 'http://127.0.0.1:8787'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function register(app: App, redirect = REDIRECT) {
  const response = await app.request(`${ORIGIN}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }) })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

const decide = (app: App, clientId: string, challenge: string, extra: Record<string, unknown> = {}) =>
  call(app, 'POST', '/v1/oauth/decision', { body: { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, state: 'xyz', decision: 'approve', ...extra } })

const token = (app: App, form: Record<string, string>) =>
  app.request(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })

/** Registers, approves and trades the code, the way Claude.ai would. */
async function signIn(app: App, extra: Record<string, unknown> = {}) {
  const { body: client } = await register(app)
  const { verifier, challenge } = pkce()
  const decision = await decide(app, client.client_id, challenge, extra)
  expect(decision.status).toBe(200)
  const back = new URL(decision.json.redirectTo)
  const response = await token(app, { grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier })
  return { client, verifier, challenge, response, tokens: response.status === 200 ? await response.clone().json() as Record<string, any> : null }
}

describe('discovery', () => {
  it('publishes the authorization server metadata without a key, open to a browser client', async () => {
    const { app } = harness()
    const response = await app.request(`${ORIGIN}/.well-known/oauth-authorization-server`)
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    })
  })

  it('answers a browser client\'s preflight', async () => {
    const { app } = harness()
    const response = await app.request(`${ORIGIN}/oauth/token`, { method: 'OPTIONS', headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST' } })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('registration', () => {
  it('registers a client that names an https redirect', async () => {
    const { app } = harness()
    const { status, body } = await register(app)
    expect(status).toBe(201)
    expect(body).toMatchObject({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })
    expect(body.client_id).toMatch(/^mnd_oc_/)
    expect(body).not.toHaveProperty('client_secret')
  })

  it.each(['javascript:alert(1)', 'data:text/html,x', 'http://evil.example/cb', 'not a url', 'https://ok.example/cb#frag'])('refuses the redirect %s', async (redirect) => {
    const { app } = harness()
    expect((await register(app, redirect)).status).toBe(400)
  })

  it('accepts a loopback http redirect and an app\'s own scheme', async () => {
    const { app } = harness()
    expect((await register(app, 'http://127.0.0.1:33418/callback')).status).toBe(201)
    expect((await register(app, 'cursor://anysphere.cursor-retrieval/oauth/callback')).status).toBe(201)
  })
})

describe('authorize', () => {
  it('hands the browser to the console, and decides nothing itself', async () => {
    const { app } = harness()
    const { body: client } = await register(app)
    const { challenge } = pkce()
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', resource: `${ORIGIN}/mcp` })
    const response = await app.request(`${ORIGIN}/oauth/authorize?${query}`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${ORIGIN}/app/connect/authorize?${query}`)
  })

  it('never redirects to an address the client did not register', async () => {
    const { app } = harness()
    const { body: client } = await register(app)
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://attacker.example/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' })
    const response = await app.request(`${ORIGIN}/oauth/authorize?${query}`, { redirect: 'manual' })
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })

  it('requires PKCE S256', async () => {
    const { app } = harness()
    const { body: client } = await register(app)
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'plain' })
    expect((await app.request(`${ORIGIN}/oauth/authorize?${query}`, { redirect: 'manual' })).status).toBe(400)
  })

  it('refuses a resource that is not this server\'s door', async () => {
    const { app } = harness()
    const { body: client } = await register(app)
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' })
    expect((await app.request(`${ORIGIN}/oauth/authorize?${query}`, { redirect: 'manual' })).status).toBe(400)
  })

  it('lets only the owner approve', async () => {
    const { app } = harness()
    const { body: client } = await register(app)
    const asked = await call(app, 'POST', '/v1/oauth/decision', { key: 'not-a-key-at-all-nope', body: { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, decision: 'approve' } })
    expect(asked.status).toBe(401)
    const agent = await call(app, 'POST', '/v1/agents', { body: { name: 'A', scopes: ['mcp', 'read'] } })
    const byAgent = await call(app, 'POST', '/v1/oauth/decision', { key: agent.json.apiKey, body: { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, decision: 'approve' } })
    expect(byAgent.status).toBe(403)
  })

  it('sends a refusal back to the client when the owner says no', async () => {
    const { app } = harness()
    const { body: client } = await register(app)
    const denied = await decide(app, client.client_id, pkce().challenge, { decision: 'deny' })
    const back = new URL(denied.json.redirectTo)
    expect(back.origin + back.pathname).toBe(REDIRECT)
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('state')).toBe('xyz')
    expect(back.searchParams.get('code')).toBeNull()
  })
})

describe('the token endpoint', () => {
  it('trades an approved code for a key that opens the door', async () => {
    const { app } = harness()
    const { tokens, client } = await signIn(app, { grant: 'ask' })
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'mcp:look mcp:ask', expires_in: 86_400 })
    expect(tokens!.access_token).toMatch(/^mnd_ag_/)
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (input, init) => Promise.resolve(app.fetch(new Request(input as string, init))),
      requestInit: { headers: { authorization: `Bearer ${tokens!.access_token}` } },
    })
    const mcp = new Client({ name: 'oauth-test', version: '1.0.0' })
    await mcp.connect(transport)
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['get_rules', 'propose']))
    await mcp.close()
    // It is a normal agent: it appears on the Connect page, named for the client.
    const agents = await call(app, 'GET', '/v1/agents')
    expect(agents.json.map((a: { name: string }) => a.name)).toContain(`${client.client_name} (sign-in)`)
  })

  it('defaults to looking only, with no propose tool at all', async () => {
    const { app } = harness()
    const { tokens } = await signIn(app)
    expect(tokens!.scope).toBe('mcp:look')
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (input, init) => Promise.resolve(app.fetch(new Request(input as string, init))),
      requestInit: { headers: { authorization: `Bearer ${tokens!.access_token}` } },
    })
    const mcp = new Client({ name: 'oauth-test', version: '1.0.0' })
    await mcp.connect(transport)
    const names = (await mcp.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('get_rules')
    expect(names).not.toContain('propose')
    await mcp.close()
  })

  it('makes a grant for the read-only door look-only even if the owner ticked ask', async () => {
    const { app } = harness()
    const { tokens } = await signIn(app, { grant: 'ask', resource: `${ORIGIN}/mcp/readonly` })
    expect(tokens!.scope).toBe('mcp:look')
  })

  it('works once: a second try with the same code fails', async () => {
    const { app } = harness()
    const { body: client } = await register(app)
    const { verifier, challenge } = pkce()
    const code = new URL((await decide(app, client.client_id, challenge)).json.redirectTo).searchParams.get('code')!
    const form = { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }
    expect((await token(app, form)).status).toBe(200)
    const again = await token(app, form)
    expect(again.status).toBe(400)
    expect((await again.json() as { code: string }).code).toBe('oauth.invalid_grant')
  })

  it('refuses a wrong verifier, and spends the code doing it', async () => {
    const { app } = harness()
    const { body: client } = await register(app)
    const { verifier, challenge } = pkce()
    const code = new URL((await decide(app, client.client_id, challenge)).json.redirectTo).searchParams.get('code')!
    const wrong = await token(app, { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: pkce().verifier })
    expect(wrong.status).toBe(400)
    const right = await token(app, { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier })
    expect(right.status).toBe(400)
  })

  it('refuses a code presented by another client or redirect', async () => {
    const { app } = harness()
    const { body: client } = await register(app)
    const { body: other } = await register(app)
    const { verifier, challenge } = pkce()
    const code = new URL((await decide(app, client.client_id, challenge)).json.redirectTo).searchParams.get('code')!
    expect((await token(app, { grant_type: 'authorization_code', code, client_id: other.client_id, redirect_uri: REDIRECT, code_verifier: verifier })).status).toBe(400)
  })

  it('rotates the key on refresh: the old key stops, the new one opens the door', async () => {
    const { app } = harness()
    const { client, tokens } = await signIn(app, { grant: 'ask' })
    const refreshed = await token(app, { grant_type: 'refresh_token', refresh_token: tokens!.refresh_token, client_id: client.client_id })
    expect(refreshed.status).toBe(200)
    const next = await refreshed.json() as Record<string, any>
    expect(next.access_token).not.toBe(tokens!.access_token)
    const open = (key: string) => app.request(`${ORIGIN}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    expect((await open(tokens!.access_token)).status).toBe(401)
    expect((await open(next.access_token)).status).toBe(200)
  })

  it('closes the whole connection when a used refresh token comes back', async () => {
    const { app } = harness()
    const { client, tokens } = await signIn(app, { grant: 'ask' })
    const first = await token(app, { grant_type: 'refresh_token', refresh_token: tokens!.refresh_token, client_id: client.client_id })
    const next = await first.json() as Record<string, any>
    const replay = await token(app, { grant_type: 'refresh_token', refresh_token: tokens!.refresh_token, client_id: client.client_id })
    expect(replay.status).toBe(400)
    // The thief's copy is dead, and so is the key the honest client was just given.
    const again = await token(app, { grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: client.client_id })
    expect(again.status).toBe(400)
    const open = await app.request(`${ORIGIN}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${next.access_token}`, 'content-type': 'application/json' }, body: '{}' })
    expect(open.status).toBe(403)
  })

  it('stops working when the owner revokes the agent', async () => {
    const { app } = harness()
    const { client, tokens } = await signIn(app, { grant: 'ask' })
    const agents = await call(app, 'GET', '/v1/agents')
    const mine = agents.json.find((a: { name: string }) => a.name.startsWith('Claude (sign-in)'))
    await call(app, 'POST', `/v1/agents/${mine.id}/revoke`)
    expect((await token(app, { grant_type: 'refresh_token', refresh_token: tokens!.refresh_token, client_id: client.client_id })).status).toBe(400)
  })

  it('does not cache and says nothing about a client secret', async () => {
    const { app } = harness()
    const { response } = await signIn(app)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

describe('what the owner can see when an agent is turned away', () => {
  const payout = (n: number) => ({ kind: 'payment', payee: 'Priya', amountCents: 9000 + n, currency: 'USD', category: 'design', description: `Northwind milestone ${n}`, evidenceUrl: EVIDENCE })

  it('shows an agent that used all of its run budget', async () => {
    const { app } = harness()
    const made = await call(app, 'POST', '/v1/agents', { body: { name: 'Runaway', scopes: ['mcp', 'read', 'propose'] } })
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (input, init) => Promise.resolve(app.fetch(new Request(input as string, init))),
      requestInit: { headers: { authorization: `Bearer ${made.json.apiKey}`, 'x-mandate-run': 'run-budget-test' } },
    })
    const mcp = new Client({ name: 'runaway', version: '1.0.0' })
    await mcp.connect(transport)
    let last: { isError?: boolean; structuredContent?: { error?: { code?: string } } } = {}
    for (let n = 0; n < 14; n += 1) last = await mcp.callTool({ name: 'propose', arguments: payout(n) }) as typeof last
    expect(last.structuredContent?.error?.code).toBe('budget.exceeded')
    await mcp.close()
    const feed = await call(app, 'GET', '/v1/agents/activity')
    const refused = feed.json.data.filter((row: { kind: string }) => row.kind === 'refused')
    expect(refused.length).toBeGreaterThanOrEqual(1)
    expect(refused[0]).toMatchObject({ agentName: 'Runaway', refusal: { code: 'budget.exceeded', tool: 'propose' } })
  })

  it('shows an agent that hit its hourly limit', async () => {
    const { app } = harness()
    const made = await call(app, 'POST', '/v1/agents', { body: { name: 'Hourly', scopes: ['read', 'propose'], limits: { proposalsPerHour: 1 } } })
    const file = (n: number) => call(app, 'POST', '/v1/proposals', { key: made.json.apiKey, idem: `hourly-${n}`, body: payout(n) })
    expect((await file(1)).status).toBeLessThan(300)
    expect((await file(2)).status).toBe(429)
    const feed = await call(app, 'GET', '/v1/agents/activity')
    expect(feed.json.data.find((row: { kind: string }) => row.kind === 'refused')).toMatchObject({ agentName: 'Hourly', refusal: { code: 'agent.over_limit' } })
  })

  it('shows an agent that reached for a scope it was not given', async () => {
    const { app } = harness()
    const made = await call(app, 'POST', '/v1/agents', { body: { name: 'Nosy', scopes: ['mcp', 'read'] } })
    const denied = await call(app, 'POST', '/v1/proposals', { key: made.json.apiKey, idem: 'nosy-1', body: payout(1) })
    expect(denied.status).toBe(403)
    const feed = await call(app, 'GET', '/v1/agents/activity')
    expect(feed.json.data.find((row: { kind: string }) => row.kind === 'refused')).toMatchObject({ agentName: 'Nosy', refusal: { code: 'agent.scope' } })
  })

  it('does not log an owner-revoked key as the agent misbehaving', async () => {
    const { app } = harness()
    const made = await call(app, 'POST', '/v1/agents', { body: { name: 'Gone', scopes: ['mcp', 'read'] } })
    await call(app, 'POST', `/v1/agents/${made.json.agent.id}/revoke`)
    await app.request(`${ORIGIN}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${made.json.apiKey}`, 'content-type': 'application/json' }, body: '{}' })
    const feed = await call(app, 'GET', '/v1/agents/activity')
    expect(feed.json.data.filter((row: { kind: string }) => row.kind === 'refused')).toHaveLength(0)
  })
})
