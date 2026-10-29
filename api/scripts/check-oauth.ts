/**
 * Signs in to a running Mandate the way Claude.ai or Cursor would, with the official MCP SDK's own OAuth client:
 * it discovers the server, registers, runs PKCE, and trades the code for a key. The one thing it cannot do is
 * click Approve in a browser, so it posts the owner's answer to the same endpoint the console screen does.
 *
 *   MANDATE_OWNER_KEY=<owner key> npm run check:oauth -- http://127.0.0.1:8787
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const ownerKey = process.env.MANDATE_OWNER_KEY ?? ''
if (!ownerKey) { console.error('Set MANDATE_OWNER_KEY to the owner key.'); process.exit(2) }
const callback = 'http://127.0.0.1:33418/callback'

let failed = false
const check = (label: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`); if (!ok) failed = true }

class Provider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed
  saved?: OAuthTokens
  verifier = ''
  authUrl?: URL
  get redirectUrl() { return callback }
  get clientMetadata(): OAuthClientMetadata { return { client_name: 'check-oauth', redirect_uris: [callback], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } }
  clientInformation() { return this.info }
  saveClientInformation(info: OAuthClientInformationMixed) { this.info = info }
  tokens() { return this.saved }
  saveTokens(tokens: OAuthTokens) { this.saved = tokens }
  redirectToAuthorization(url: URL) { this.authUrl = url }
  saveCodeVerifier(v: string) { this.verifier = v }
  codeVerifier() { return this.verifier }
}

const provider = new Provider()
const open = () => new Client({ name: 'check-oauth', version: '1.0.0' })

// 1. No key: the door must refuse and say where to sign in.
const anon = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
check('the door refuses a caller with no key', anon.status === 401)
check('and says where it is described', /resource_metadata=/.test(anon.headers.get('www-authenticate') ?? ''))

// 2. The SDK discovers, registers and starts PKCE by itself.
const first = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider })
let challenged = false
try { await open().connect(first) } catch (error) { challenged = error instanceof UnauthorizedError }
check('the SDK client is sent to sign in', challenged && Boolean(provider.authUrl))
check('it registered itself', Boolean(provider.info && 'client_id' in provider.info))
check('it asked with PKCE S256', provider.authUrl?.searchParams.get('code_challenge_method') === 'S256')

// 3. The browser step: authorize hands to the console, the owner approves, the redirect carries a code.
const hop = await fetch(provider.authUrl!, { redirect: 'manual' })
check('authorize sends the browser to the console', hop.status === 302 && (hop.headers.get('location') ?? '').includes('/app/connect/authorize'))
const q = provider.authUrl!.searchParams
const decided = await fetch(`${base}/v1/oauth/decision`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ client_id: q.get('client_id'), redirect_uri: q.get('redirect_uri'), code_challenge: q.get('code_challenge'), state: q.get('state') ?? undefined, resource: q.get('resource') ?? undefined, decision: 'approve', grant: 'ask' }),
})
const answer = await decided.json() as { redirectTo?: string }
check('the owner can approve', decided.status === 200 && Boolean(answer.redirectTo))
const back = new URL(answer.redirectTo ?? callback)
check('the redirect returns to the registered address', back.origin + back.pathname === callback)
check('with the state it was given', back.searchParams.get('state') === q.get('state'))

// 4. The SDK finishes: it trades the code and holds a key.
await first.finishAuth(back.searchParams.get('code') ?? '')
check('the code was traded for tokens', Boolean(provider.saved?.access_token && provider.saved?.refresh_token), `scope ${provider.saved?.scope ?? '?'}`)

// 5. It connects and uses the door.
const client = open()
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }))
const tools = (await client.listTools()).tools.map((tool) => tool.name)
check('it lists tools', tools.includes('get_rules') && tools.includes('propose'), `${tools.length} tools`)
check('none of them can pay', !tools.some((name) => ['approve', 'capture', 'pay', 'send_payout', 'refund', 'publish_rules'].includes(name)))
const rules = await client.callTool({ name: 'get_rules', arguments: {} })
check('it reads the rules', rules.isError !== true)
await client.close()

// 6. Rotation: refresh gives a new key and the old one stops.
const old = provider.saved!
const refreshed = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: old.refresh_token!, client_id: (provider.info as { client_id: string }).client_id }) })
const next = await refreshed.json() as OAuthTokens
check('a refresh token gives a new key', refreshed.status === 200 && next.access_token !== old.access_token)
const ping = (key: string) => fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
check('the old key stops working', (await ping(old.access_token)).status === 401)
check('the new key works', (await ping(next.access_token)).status === 200)

// 7. The same refresh token again means a copy leaked: everything closes.
const replay = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: old.refresh_token!, client_id: (provider.info as { client_id: string }).client_id }) })
check('a replayed refresh token is refused', replay.status === 400)
check('and the connection is closed', (await ping(next.access_token)).status === 403)

// 8. The owner can see and end connections made this way (the ones above are already closed; this checks the listing).
const agents = await (await fetch(`${base}/v1/agents`, { headers: { authorization: `Bearer ${ownerKey}` } })).json() as Array<{ name: string; status: string }>
check('the connection is on the owner\'s list', agents.some((agent) => agent.name.startsWith('check-oauth (sign-in)') && agent.status === 'revoked'))

console.log(failed ? '\nFAILED' : '\nAll checks passed.')
process.exit(failed ? 1 : 0)
