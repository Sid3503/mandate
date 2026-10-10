import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Repo } from '../db/repo'
import { live } from './live'
import { stamp } from './live'
import { Problem } from '../http/problem'
import type { AgentLimits, AgentScope } from './principal'
import { DEFAULT_AGENT_LIMITS } from './principal'

/**
 * The key registry: every agent that is allowed to call Mandate gets its own key, with its own scopes and limits.
 * Keys are shown once at creation; only the hash is stored. An agent that asks for too much is stopped by its own
 * limits, and a breaker-tripped agent is suspended without touching anyone else.
 */
export class AgentService {
  private readonly windows = new Map<string, Array<{ at: number; cents: number }>>()

  constructor(private readonly repo: Repo, private readonly now: () => Date) {}

  create(input: { name: string; scopes: AgentScope[]; limits?: Partial<AgentLimits> }): { agent: AgentSummary; apiKey: string } {
    const name = input.name.trim().slice(0, 120)
    if (!name) throw new Problem(422, 'agent.name', 'The agent needs a name', 'Give the agent a name, such as “CI script” or “Priya\'s assistant”.')
    const scopes = [...new Set(input.scopes)]
    if (scopes.length === 0) throw new Problem(422, 'agent.scopes', 'The agent needs at least one scope', 'Pick at least one: read, propose, stream, mcp, deals.')
    // The MCP door only opens the door. Without read, propose or deals the key would connect and then have no tools.
    if (scopes.includes('mcp') && !scopes.some((scope) => scope === 'read' || scope === 'propose' || scope === 'deals')) {
      throw new Problem(422, 'agent.scopes', 'The MCP door needs something behind it', 'Add read (to look), propose (to ask to pay or bill) or deals (to negotiate) next to the MCP door, or the agent would connect with no tools.')
    }
    const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, ...(input.limits ?? {}) }
    if (!Number.isFinite(limits.proposalsPerHour) || limits.proposalsPerHour < 1 || limits.proposalsPerHour > 10_000) throw new Problem(422, 'agent.limit', 'proposalsPerHour must be between 1 and 10000', 'Set a sensible hourly proposal allowance for this agent.')
    if (!Number.isFinite(limits.centsPerHour) || limits.centsPerHour < 1) throw new Problem(422, 'agent.limit', 'centsPerHour must be positive', 'Set a sensible hourly value ceiling for this agent.')
    const id = randomUUID()
    const secret = randomBytes(24).toString('base64url')
    const apiKey = `mnd_ag_${secret}`
    this.repo.createAgent({
      id, name, scopes_json: JSON.stringify(scopes), limits_json: JSON.stringify(limits),
      status: 'active', key_hash: createHash('sha256').update(apiKey).digest('hex'), created_at: this.now().toISOString(), last_seen_at: null,
    })
    live.publish({ type: 'changed', scope: 'agents', what: 'agent.created', at: stamp() })
    return { agent: this.get(id)!, apiKey }
  }

  list(): AgentSummary[] {
    return this.repo.listAgents().map(AgentService.toSummary)
  }

  get(id: string): AgentSummary | null {
    const row = this.repo.getAgent(id)
    return row ? AgentService.toSummary(row) : null
  }

  revoke(id: string): AgentSummary {
    const row = this.repo.getAgent(id)
    if (!row) throw new Problem(404, 'agent.unknown', 'No agent with that id', 'Check the agents list for the id.')
    this.repo.setAgentStatus(id, 'revoked', this.now().toISOString())
    live.publish({ type: 'changed', scope: 'agents', what: 'agent.revoked', at: stamp() })
    return AgentService.toSummary(this.repo.getAgent(id)!)
  }

  resume(id: string): AgentSummary {
    const row = this.repo.getAgent(id)
    if (!row) throw new Problem(404, 'agent.unknown', 'No agent with that id', 'Check the agents list for the id.')
    if (row.status === 'revoked') throw new Problem(409, 'agent.revoked', 'That agent was revoked, not paused', 'Create a new key if you want the access back.')
    this.repo.setAgentStatus(id, 'active', this.now().toISOString())
    live.publish({ type: 'changed', scope: 'agents', what: 'agent.resumed', at: stamp() })
    return AgentService.toSummary(this.repo.getAgent(id)!)
  }

  /** Called when a request is authenticated as this agent. Keeps last_seen_at fresh. */
  touch(id: string): void {
    this.repo.setAgentSeen(id, this.now().toISOString())
  }

  /** Hourly counters. In memory by design (like the per-minute rate limit): a nuance beyond the row's limits, never part of the proof. */
  chargeUsage(id: string, amountCents: number): void {
    const row = this.repo.getAgent(id)
    if (!row) throw new Problem(403, 'auth.unknown_agent', 'Unknown agent key', '')
    const limits = JSON.parse(row.limits_json) as AgentLimits
    const cutoff = this.now().getTime() - 3_600_000
    const window = (this.windows.get(id) ?? []).filter((item) => item.at >= cutoff)
    if (window.length >= limits.proposalsPerHour) {
      throw new Problem(429, 'agent.over_limit', 'Too many requests for this agent in an hour', `“${row.name}” has reached its ${limits.proposalsPerHour}/hour proposal limit. It can ask again after the oldest request in the window.`)
    }
    const usedCents = window.reduce((sum, item) => sum + item.cents, 0)
    if (usedCents + amountCents > limits.centsPerHour) {
      throw new Problem(429, 'agent.over_limit', 'This agent has asked for too much money in an hour', `“${row.name}” has used ${(usedCents / 100).toFixed(0)} of its $${(limits.centsPerHour / 100).toFixed(0)}/hour proposal ceiling. Wait an hour, or raise the limit.`)
    }
    window.push({ at: this.now().getTime(), cents: amountCents })
    this.windows.set(id, window)
  }

  private static toSummary(row: import('../db/repo').AgentRow): AgentSummary {
    return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes_json) as AgentScope[], limits: JSON.parse(row.limits_json) as AgentLimits, status: row.status as AgentSummary['status'], createdAt: row.created_at, lastSeenAt: row.last_seen_at }
  }
}

export type AgentSummary = {
  id: string
  name: string
  scopes: AgentScope[]
  limits: AgentLimits
  status: 'active' | 'suspended' | 'revoked'
  createdAt: string
  lastSeenAt: string | null
}

export const AGENT_SCOPES = ['read', 'propose', 'stream', 'mcp', 'deals'] as const
