import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { randomUUID } from 'node:crypto'
import type { Services } from '../services/container'
import { STUDIO, type Principal } from '../services/principal'
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
 * Serves /mcp. Stateless on purpose: every request builds its own server and transport, so there is no session to
 * leak between agents and nothing to clean up. The owner key is accepted but downgraded, because the agent door
 * never carries owner authority: whatever key arrives, the tools run as a proposer.
 */
export async function handleMcp(request: Request, services: Services, caller: Principal): Promise<Response> {
  const principal = caller.role === 'owner' ? STUDIO : caller
  const runId = request.headers.get('x-mandate-run')?.slice(0, 64).replace(/[^A-Za-z0-9._:-]/g, '') || randomUUID()
  const server = createMandateMcpServer({ services, principal, runId, budget: budgetFor(runId) })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    void transport.close()
    void server.close()
  }
}
