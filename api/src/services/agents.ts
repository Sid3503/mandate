import { randomBytes, randomUUID } from 'node:crypto'
import type { Repo } from '../db/repo'
import { live } from './live'
import { stamp } from './live'
import { Problem } from '../http/problem'
import type { AgentLimits, AgentScope } from './principal'
import { DEFAULT_AGENT_LIMITS } from './principal'
import { machineKeyHash } from './machine-key'

/**
 * The key registry: every agent that is allowed to call Mandate gets its own key, with its own scopes and limits.
 * Keys are shown once at creation; only the hash is stored. An agent that asks for too much is stopped by its own
 * limits, and a breaker-tripped agent is suspended without touching anyone else.
 */
export class AgentService {
  private readonly windows = new Map<string, Array<{ at: number; cents: number }>>()

  constructor(
    private readonly repo: Repo,
    private readonly now: () => Date,
    private readonly workspaceId: string = 'ws_default',
  ) {}

  create(input: { name: string; scopes: AgentScope[]; limits?: Partial<AgentLimits>; expiryDays?: number | null }): { agent: AgentSummary; apiKey: string } {
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
    if (limits.proposalsPerDay !== undefined && (!Number.isFinite(limits.proposalsPerDay) || limits.proposalsPerDay < 1)) throw new Problem(422, 'agent.limit', 'proposalsPerDay must be positive', 'Set a sensible daily proposal allowance for this agent.')
    if (limits.centsPerDay !== undefined && (!Number.isFinite(limits.centsPerDay) || limits.centsPerDay < 1)) throw new Problem(422, 'agent.limit', 'centsPerDay must be positive', 'Set a sensible daily value ceiling for this agent.')
    if (input.expiryDays !== undefined && input.expiryDays !== null && input.expiryDays <= 0) {
      throw new Problem(400, 'agent.expiry', 'expiryDays must be positive', 'Set a valid expiration period.')
    }
    const id = randomUUID()
    const rawEntropy = randomBytes(24).toString('base64url')
    const machineToken = `mnd_ag_${this.workspaceId}_${rawEntropy}`
    const keyPrefix = `mnd_ag_${this.workspaceId}_${rawEntropy.slice(0, 4)}...`
    const expiresAt = input.expiryDays ? new Date(this.now().getTime() + input.expiryDays * 86_400_000).toISOString() : null
    this.repo.createAgent({
      id, name, scopes_json: JSON.stringify(scopes), limits_json: JSON.stringify(limits),
      status: 'active', key_hash: machineKeyHash(machineToken), key_prefix: keyPrefix, created_at: this.now().toISOString(), last_seen_at: null,
      expires_at: expiresAt,
    })
    live.publish({ type: 'changed', scope: 'agents', what: 'agent.created', at: stamp() })
    return { agent: this.get(id)!, apiKey: machineToken }
  }

  list(): AgentSummary[] {
    return this.repo.listAgents().map((r) => this.toSummary(r))
  }

  get(id: string): AgentSummary | null {
    const row = this.repo.getAgent(id)
    return row ? this.toSummary(row) : null
  }

  scorecard(id: string): AgentScorecard {
    const row = this.repo.getAgent(id)
    if (!row) throw new Problem(404, 'agent.unknown', 'No agent with that id', 'Check the agents list for the id.')
    return this.toSummary(row).scorecard
  }

  /** Replaces the secret on the same agent. The old mnd_ag_ key stops matching. Scopes and limits stay. */
  upgrade(id: string): { agent: AgentSummary; apiKey: string } {
    const row = this.repo.getAgent(id)
    if (!row) throw new Problem(404, 'agent.unknown', 'No agent with that id', 'Check the agents list for the id.')
    if (row.status === 'revoked') throw new Problem(409, 'agent.revoked', 'That agent was revoked, not paused', 'Create a new key if you want the access back.')
    const rawEntropy = randomBytes(24).toString('base64url')
    const machineToken = `mnd_ag_${this.workspaceId}_${rawEntropy}`
    const keyPrefix = `mnd_ag_${this.workspaceId}_${rawEntropy.slice(0, 4)}...`
    this.repo.setAgentKeyHash(id, machineKeyHash(machineToken), keyPrefix)
    live.publish({ type: 'changed', scope: 'agents', what: 'agent.upgraded', at: stamp() })
    return { agent: this.get(id)!, apiKey: machineToken }
  }

  revoke(id: string): AgentSummary {
    const row = this.repo.getAgent(id)
    if (!row) throw new Problem(404, 'agent.unknown', 'No agent with that id', 'Check the agents list for the id.')
    this.repo.setAgentStatus(id, 'revoked', this.now().toISOString())
    live.publish({ type: 'changed', scope: 'agents', what: 'agent.revoked', at: stamp() })
    return this.toSummary(this.repo.getAgent(id)!)
  }

  suspend(id: string): AgentSummary {
    const row = this.repo.getAgent(id)
    if (!row) throw new Problem(404, 'agent.unknown', 'No agent with that id', 'Check the agents list for the id.')
    if (row.status === 'revoked') throw new Problem(409, 'agent.revoked', 'That agent was revoked', 'Create a new key if you want the access back.')
    this.repo.setAgentStatus(id, 'suspended', this.now().toISOString())
    live.publish({ type: 'changed', scope: 'agents', what: 'agent.suspended', at: stamp() })
    return this.toSummary(this.repo.getAgent(id)!)
  }

  resume(id: string): AgentSummary {
    const row = this.repo.getAgent(id)
    if (!row) throw new Problem(404, 'agent.unknown', 'No agent with that id', 'Check the agents list for the id.')
    if (row.status === 'revoked') throw new Problem(409, 'agent.revoked', 'That agent was revoked, not paused', 'Create a new key if you want the access back.')
    this.repo.setAgentStatus(id, 'active', this.now().toISOString())
    live.publish({ type: 'changed', scope: 'agents', what: 'agent.resumed', at: stamp() })
    return this.toSummary(this.repo.getAgent(id)!)
  }

  /** Called when a request is authenticated as this agent. Keeps last_seen_at fresh. */
  touch(id: string): void {
    this.repo.setAgentSeen(id, this.now().toISOString())
  }

  /** Hourly and daily counters. In memory by design: a nuance beyond the row's limits, never part of the proof. */
  chargeUsage(id: string, amountCents: number): void {
    const row = this.repo.getAgent(id)
    if (!row) throw new Problem(403, 'auth.unknown_agent', 'Unknown agent key', '')
    const limits = JSON.parse(row.limits_json) as AgentLimits
    const nowTime = this.now().getTime()
    const cutoffHour = nowTime - 3_600_000
    const cutoffDay = nowTime - 86_400_000
    const allItems = (this.windows.get(id) ?? []).filter((item) => item.at >= cutoffDay)
    const hourWindow = allItems.filter((item) => item.at >= cutoffHour)

    if (hourWindow.length >= limits.proposalsPerHour) {
      throw new Problem(429, 'agent.over_limit', 'Too many requests for this agent in an hour', `“${row.name}” has reached its ${limits.proposalsPerHour}/hour proposal limit. It can ask again after the oldest request in the window.`)
    }
    const usedHourCents = hourWindow.reduce((sum, item) => sum + item.cents, 0)
    if (usedHourCents + amountCents > limits.centsPerHour) {
      throw new Problem(429, 'agent.over_limit', 'This agent has asked for too much money in an hour', `“${row.name}” has used ${(usedHourCents / 100).toFixed(0)} of its $${(limits.centsPerHour / 100).toFixed(0)}/hour proposal ceiling. Wait an hour, or raise the limit.`)
    }

    if (limits.proposalsPerDay && allItems.length >= limits.proposalsPerDay) {
      throw new Problem(429, 'agent.over_limit', 'Too many requests for this agent in a day', `“${row.name}” has reached its ${limits.proposalsPerDay}/day proposal limit.`)
    }
    const usedDayCents = allItems.reduce((sum, item) => sum + item.cents, 0)
    if (limits.centsPerDay && usedDayCents + amountCents > limits.centsPerDay) {
      throw new Problem(429, 'agent.over_limit', 'This agent has asked for too much money in a day', `“${row.name}” has used ${(usedDayCents / 100).toFixed(0)} of its $${(limits.centsPerDay / 100).toFixed(0)}/day ceiling.`)
    }

    allItems.push({ at: nowTime, cents: amountCents })
    this.windows.set(id, allItems)
  }

  private toSummary(row: import('../db/repo').AgentRow): AgentSummary {
    const stats = this.repo.agentProposalStats(row.id)
    const keyPrefix = row.key_prefix ?? `mnd_ag_${this.workspaceId}_...`
    return {
      id: row.id,
      name: row.name,
      scopes: JSON.parse(row.scopes_json) as AgentScope[],
      limits: JSON.parse(row.limits_json) as AgentLimits,
      status: row.status as AgentSummary['status'],
      keyPrefix,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      lastUsedAt: row.last_seen_at,
      expiresAt: row.expires_at ?? null,
      scorecard: {
        agentId: row.id,
        name: row.name,
        status: row.status as AgentSummary['status'],
        requests: stats.total,
        refusals: stats.refusals,
        auto: stats.auto,
        needsTap: stats.needsTap,
        lastSeenAt: row.last_seen_at,
        breakerTripped: row.status === 'suspended',
      },
    }
  }
}

export type AgentScorecard = {
  agentId: string
  name: string
  status: 'active' | 'suspended' | 'revoked'
  requests: number
  refusals: number
  auto: number
  needsTap: number
  lastSeenAt: string | null
  breakerTripped: boolean
}

export type AgentSummary = {
  id: string
  name: string
  scopes: AgentScope[]
  limits: AgentLimits
  status: 'active' | 'suspended' | 'revoked'
  keyPrefix: string
  createdAt: string
  lastSeenAt: string | null
  lastUsedAt: string | null
  expiresAt: string | null
  scorecard: AgentScorecard
}

export const AGENT_SCOPES = ['read', 'propose', 'stream', 'mcp', 'deals'] as const
