import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { randomUUID } from 'node:crypto'
import { stableHash } from '../domain/hash'
import type { Services } from '../services/container'
import { actorLabel, STUDIO, type Principal } from '../services/principal'
import { createMandateMcpServer } from './server'

export const DEFAULT_BUDGET = 12

/**
 * Requests left per agent run. The transport is stateless, so the count lives here, keyed by the run id the
 * agent sends. Entries expire so an attacker cannot grow the map by inventing run ids.
 */
const budgets = new Map<string, { asks: number; expires: number }>()
const BUDGET_TTL_MS = 60 * 60_000
const BUDGET_MAX_RUNS = 2_000

function budgetFor(runId: string, now = Date.now()): { asks: number } {
  const found = budgets.get(runId)
  if (found && found.expires > now) return found
  if (budgets.size >= BUDGET_MAX_RUNS) {
    for (const [id, entry] of budgets) if (entry.expires <= now) budgets.delete(id)
    if (budgets.size >= BUDGET_MAX_RUNS) budgets.delete(budgets.keys().next().value as string)
  }
  const fresh = { asks: DEFAULT_BUDGET, expires: now + BUDGET_TTL_MS }
  budgets.set(runId, fresh)
  return fresh
}

/**
 * Most MCP clients (Claude Code, Cursor, the SDKs) send no run id, so a retried call looks like a new one. An identical
 * tool call from the same caller inside this window is treated as a retry: it gets the first call's run id, and the
 * idempotency key built from that replays the first answer instead of filing the request again. The window starts at
 * the first call and is not extended, so a deliberate repeat a minute later is asked again and judged afresh.
 */
export const RETRY_WINDOW_MS = 60_000
const RETRY_MAX = 2_000
const retries = new Map<string, { runId: string; at: number }>()

function retryRunId(actor: string, call: { name: string; arguments: unknown }, now = Date.now()): string {
  const key = `${actor}|${call.name}|${stableHash(call.arguments ?? {})}`
  const found = retries.get(key)
  if (found && now - found.at < RETRY_WINDOW_MS) return found.runId
  if (retries.size >= RETRY_MAX) {
    for (const [id, entry] of retries) if (now - entry.at >= RETRY_WINDOW_MS) retries.delete(id)
    if (retries.size >= RETRY_MAX) retries.delete(retries.keys().next().value as string)
  }
  const fresh = { runId: `auto-${randomUUID()}`, at: now }
  retries.set(key, fresh)
  return fresh.runId
}

/** The one tool call a JSON-RPC body carries, if it is a single `tools/call`. */
function toolCall(text: string): { name: string; arguments: unknown } | null {
  try {
    const body = JSON.parse(text) as { method?: unknown; params?: { name?: unknown; arguments?: unknown } }
    if (body && !Array.isArray(body) && body.method === 'tools/call' && typeof body.params?.name === 'string') return { name: body.params.name, arguments: body.params.arguments }
  } catch {
    /* not JSON: the transport answers with a parse error */
  }
  return null
}

const MAX_BODY = 1_000_000

const rpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), { status, headers: { 'content-type': 'application/json', ...headers } })

/**
 * Serves /mcp. Stateless on purpose: every request builds its own server and transport, so there is no session to
 * leak between agents and nothing to clean up. The owner key is accepted but downgraded, because the agent door
 * never carries owner authority: whatever key arrives, the tools run as a proposer.
 *
 * There is no event stream and no session, so a GET or DELETE is answered 405, which is what the protocol says a
 * server without a stream does. (An empty 200 made real clients reconnect over and over.) The Accept header is
 * filled in when a plain HTTP client leaves it out, because every answer here is JSON anyway.
 */
export async function handleMcp(request: Request, services: Services, caller: Principal): Promise<Response> {
  if (request.method !== 'POST') return rpcError(405, 'This door answers POST only. It keeps no session and has no event stream.', { allow: 'POST' })
  const text = await request.text()
  if (text.length > MAX_BODY) return rpcError(413, 'That request is too large.')
  const principal = caller.role === 'owner' ? STUDIO : caller
  const given = request.headers.get('x-mandate-run')?.slice(0, 64).replace(/[^A-Za-z0-9._:-]/g, '')
  const call = given ? null : toolCall(text)
  const runId = given || (call ? retryRunId(actorLabel(principal), call) : randomUUID())
  const headers = new Headers(request.headers)
  const accept = headers.get('accept') ?? ''
  if (!/application\/json/i.test(accept) || !/text\/event-stream/i.test(accept)) headers.set('accept', 'application/json, text/event-stream')
  // The body is parsed as JSON whatever the client called it (some HTTP tools say text/plain).
  if (!/json/i.test(headers.get('content-type') ?? '')) headers.set('content-type', 'application/json')
  const normalised = new Request(request.url, { method: 'POST', headers, body: text })
  const server = createMandateMcpServer({ services, principal, runId, budget: budgetFor(runId) })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(normalised)
  } finally {
    void transport.close()
    void server.close()
  }
}
