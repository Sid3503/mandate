import type { Side } from '../domain/deal'

export type Role = 'owner' | 'proposer'

/**
 * Who is calling. The owner may do everything. A proposer may only ask and read, and is bound to one side of a
 * deal: the studio's own staff and agents are the `seller`; a client's agent is a `buyer` bound to one client.
 * The binding is what keeps each company's limits private: a key cannot claim the other side.
 *
 * An `agent` holds one issued key (see POST /v1/agents). It carries its own scopes and hourly limits, and it is what
 * the per-agent breaker counts, so one misbehaving agent can be stopped without pausing anyone else.
 */
export type AgentScope = 'read' | 'propose' | 'stream' | 'mcp' | 'deals'
export type AgentLimits = { proposalsPerHour: number; centsPerHour: number }
export const DEFAULT_AGENT_LIMITS: AgentLimits = { proposalsPerHour: 60, centsPerHour: 250_000 }

export type Principal =
  | { role: 'owner'; side: null; buyerId: null }
  | { role: 'proposer'; side: 'seller'; buyerId: null }
  | { role: 'proposer'; side: 'buyer'; buyerId: string }
  | { role: 'agent'; side: null; buyerId: null; agentId: string; name: string; scopes: AgentScope[]; limits: AgentLimits }

export const OWNER: Principal = { role: 'owner', side: null, buyerId: null }
export const STUDIO: Principal = { role: 'proposer', side: 'seller', buyerId: null }
export const buyerPrincipal = (buyerId: string): Principal => ({ role: 'proposer', side: 'buyer', buyerId })

/** The stable label a ledger row / refusal counter / event carries for this caller. Owners and the studio keep their role names; agents are 'agent:<id>' so the breaker can count them separately. */
export function actorLabel(principal: Principal): 'owner' | 'proposer' | `agent:${string}` {
  return principal.role === 'agent' ? `agent:${principal.agentId}` : principal.role
}

export type { Side }
