import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Repo } from '../db/repo'
import { Problem } from '../http/problem'
import type { AgentService } from '../services/agents'
import { machineKeyHash } from '../services/machine-key'
import type { AgentScope } from '../services/principal'

/**
 * OAuth 2.1 for the agent door, so a client that signs in with a browser (Claude.ai, ChatGPT, Cursor) can connect
 * without anyone pasting a key.
 *
 * It is deliberately small. Public clients only (no client secret), PKCE with S256 on every grant, one-shot
 * authorization codes, and refresh tokens that rotate. The owner's approval happens on the console, where they are
 * already signed in. What a client is handed is an ordinary agent key, so everything that already guards a key still
 * applies: scopes, the hourly limit, the breaker, and Revoke on the Connect page.
 */

export const OAUTH_SCOPES = { look: ['mcp', 'read'], ask: ['mcp', 'read', 'propose'] } as const satisfies Record<string, readonly AgentScope[]>
export type OauthGrant = keyof typeof OAUTH_SCOPES

const CODE_TTL_MS = 5 * 60_000
/** The agent key a client holds lives a day; the refresh token is how it gets the next one. */
const ACCESS_TTL_SECONDS = 86_400
const REFRESH_TTL_MS = 30 * 86_400_000
const MAX_CLIENTS = 500

const hash = (value: string) => machineKeyHash(`oauth:${value}`)
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`

export const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** A redirect must be https, a loopback address, or an app's own scheme. Never a page that runs script. */
export function redirectAllowed(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.hash) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  return !['javascript:', 'data:', 'file:', 'blob:', 'about:', 'vbscript:', 'ftp:', 'ws:', 'wss:'].includes(url.protocol)
}

const oauthError = (status: number, error: string, description: string) =>
  new Problem(status, `oauth.${error}`, error, description)

export type AuthorizeRequest = {
  clientId: string
  redirectUri: string
  state?: string
  challenge: string
  resource: string
  /** What the client asked for; the owner can narrow it. */
  scope?: string
}

export class OAuthService {
  constructor(
    private readonly repo: Repo,
    private readonly agents: AgentService,
    private readonly now: () => Date,
    /** The addresses of the door this server protects. A token is only ever issued for one of them. */
    private readonly doors: string[],
  ) {}

  metadata(origin: string) {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:look', 'mcp:ask'],
      resource_indicators_supported: true,
    }
  }

  /** RFC 7591 dynamic registration. A client says who it is and where it may be sent back; nothing is trusted yet. */
  register(input: { client_name?: unknown; redirect_uris?: unknown }): Record<string, unknown> {
    const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === 'string') : []
    if (uris.length === 0 || uris.length > 10 || uris.length !== (input.redirect_uris as unknown[]).length) {
      throw oauthError(400, 'invalid_redirect_uri', 'Send one to ten redirect_uris, each a string.')
    }
    for (const uri of uris) if (!redirectAllowed(uri)) throw oauthError(400, 'invalid_redirect_uri', `This redirect is not allowed: ${uri.slice(0, 80)}. Use https, a loopback address, or your app's own scheme.`)
    if (this.repo.countOauthClients() >= MAX_CLIENTS) throw oauthError(429, 'temporarily_unavailable', 'This server is not taking new client registrations right now.')
    const name = typeof input.client_name === 'string' && input.client_name.trim() ? input.client_name.trim().slice(0, 80) : 'An MCP client'
    const clientId = secret('mnd_oc')
    const created_at = this.now().toISOString()
    this.repo.insertOauthClient({ client_id: clientId, name, redirect_uris_json: JSON.stringify(uris), created_at })
    return { client_id: clientId, client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(this.now().getTime() / 1000) }
  }

  /**
   * Checks what the console is about to ask the owner to approve. Returns the client's name so the screen can say who
   * is asking, and throws if the request is one this server would never honour. The redirect is matched exactly:
   * an unmatched one is refused here and never redirected to, which is what keeps this from being an open redirect.
   */
  inspect(request: AuthorizeRequest): { clientName: string; redirectHost: string; resource: string; asked: OauthGrant } {
    const client = this.repo.oauthClient(request.clientId)
    if (!client) throw oauthError(400, 'invalid_client', 'This client is not registered here.')
    const registered = JSON.parse(client.redirect_uris_json) as string[]
    if (!registered.includes(request.redirectUri)) throw oauthError(400, 'invalid_request', 'That redirect does not match what the client registered.')
    if (!/^[A-Za-z0-9_-]{43}$/.test(request.challenge)) throw oauthError(400, 'invalid_request', 'A PKCE S256 code_challenge is required.')
    const resource = this.resourceFor(request.resource)
    const askedMore = /(^|\s)mcp:ask(\s|$)/.test(request.scope ?? '')
    return { clientName: client.name, redirectHost: new URL(request.redirectUri).host || new URL(request.redirectUri).protocol, resource, asked: askedMore && !resource.endsWith('/mcp/readonly') ? 'ask' : 'look' }
  }

  private resourceFor(value: string): string {
    const doors = this.doors
    if (!value) return doors[0]!
    const wanted = value.replace(/\/$/, '')
    const door = doors.find((candidate) => candidate === wanted)
    if (!door) throw oauthError(400, 'invalid_target', 'This server protects only its own agent door.')
    return door
  }

  /**
   * The owner approved. Returns the address to send the browser back to, with a one-shot code. A grant for the
   * read-only door can only ever be "look", whatever the owner ticked.
   */
  approve(request: AuthorizeRequest, grant: OauthGrant): string {
    const seen = this.inspect(request)
    const effective: OauthGrant = seen.resource.endsWith('/mcp/readonly') ? 'look' : grant
    const code = secret('mnd_oa')
    this.repo.insertOauthCode({
      code_hash: hash(code), client_id: request.clientId, redirect_uri: request.redirectUri, challenge: request.challenge,
      scopes_json: JSON.stringify(OAUTH_SCOPES[effective]), resource: seen.resource, expires_at: new Date(this.now().getTime() + CODE_TTL_MS).toISOString(),
    })
    return this.back(request, seen.resource, { code })
  }

  deny(request: AuthorizeRequest): string {
    const seen = this.inspect(request)
    return this.back(request, seen.resource, { error: 'access_denied', error_description: 'The owner did not approve this connection.' })
  }

  private back(request: AuthorizeRequest, resource: string, params: Record<string, string>): string {
    const url = new URL(request.redirectUri)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    if (request.state) url.searchParams.set('state', request.state)
    // RFC 9207: say who answered, so a client talking to several servers cannot be tricked into mixing them up.
    url.searchParams.set('iss', new URL(resource).origin)
    return url.toString()
  }

  /** The token endpoint. Two grants: trade a code for a key, or trade a refresh token for the next one. */
  token(form: Record<string, string>): Record<string, unknown> {
    if (form.grant_type === 'authorization_code') return this.fromCode(form)
    if (form.grant_type === 'refresh_token') return this.fromRefresh(form)
    throw oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.')
  }

  private fromCode(form: Record<string, string>): Record<string, unknown> {
    const code = form.code ?? ''
    const row = code ? this.repo.takeOauthCode(hash(code)) : null
    if (!row || row.expires_at <= this.now().toISOString()) throw oauthError(400, 'invalid_grant', 'That code is unknown, already used, or expired.')
    if (row.client_id !== form.client_id || row.redirect_uri !== form.redirect_uri) throw oauthError(400, 'invalid_grant', 'This code was issued to a different client or redirect.')
    if (!form.code_verifier || !sameText(s256(form.code_verifier), row.challenge)) throw oauthError(400, 'invalid_grant', 'The code_verifier does not match the challenge.')
    if (form.resource && this.resourceFor(form.resource) !== row.resource) throw oauthError(400, 'invalid_target', 'The resource does not match the one that was approved.')
    const client = this.repo.oauthClient(row.client_id)!
    const scopes = JSON.parse(row.scopes_json) as AgentScope[]
    const looksOnly = !scopes.includes('propose')
    const made = this.agents.create({ name: `${client.name} (sign-in)${looksOnly ? ' · looks only' : ''}`, scopes, expiryDays: 1 })
    return this.issue(row.client_id, made.agent.id, made.apiKey, scopes, row.resource)
  }

  private fromRefresh(form: Record<string, string>): Record<string, unknown> {
    const presented = form.refresh_token ?? ''
    const row = presented ? this.repo.oauthRefresh(hash(presented)) : null
    if (!row || row.client_id !== form.client_id) throw oauthError(400, 'invalid_grant', 'That refresh token is not valid for this client.')
    if (row.status !== 'active') {
      // A used or revoked refresh token coming back means a copy leaked. Stop the whole connection, not just this call.
      this.repo.killOauthRefreshForAgent(row.agent_id)
      try { this.agents.revoke(row.agent_id) } catch { /* already gone */ }
      throw oauthError(400, 'invalid_grant', 'That refresh token was already used. The connection has been closed; sign in again.')
    }
    if (row.expires_at <= this.now().toISOString()) throw oauthError(400, 'invalid_grant', 'That refresh token has expired. Sign in again.')
    const agent = this.agents.get(row.agent_id)
    if (!agent || agent.status === 'revoked') throw oauthError(400, 'invalid_grant', 'The owner closed this connection. Sign in again.')
    if (agent.status === 'suspended') throw oauthError(400, 'invalid_grant', 'This connection is paused by the owner.')
    this.repo.setOauthRefreshStatus(hash(presented), 'used')
    const rotated = this.agents.upgrade(row.agent_id)
    this.repo.setAgentExpiry(row.agent_id, new Date(this.now().getTime() + ACCESS_TTL_SECONDS * 1000).toISOString())
    return this.issue(row.client_id, row.agent_id, rotated.apiKey, agent.scopes as AgentScope[], this.doors[0]!)
  }

  private issue(clientId: string, agentId: string, accessToken: string, scopes: AgentScope[], resource: string): Record<string, unknown> {
    const refresh = secret('mnd_or')
    this.repo.insertOauthRefresh({ token_hash: hash(refresh), client_id: clientId, agent_id: agentId, status: 'active', expires_at: new Date(this.now().getTime() + REFRESH_TTL_MS).toISOString() })
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: scopes.includes('propose') ? 'mcp:look mcp:ask' : 'mcp:look', resource }
  }
}
