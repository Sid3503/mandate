import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'
import { verdictFor, type Side } from '../domain/deal'
import { resolveClient } from '../domain/gate'
import { WARRANT_ID } from '../domain/schemas'
import { Problem } from '../http/problem'
import type { Services } from '../services/container'
import { buyerPrincipal, OWNER, STUDIO, type Principal } from '../services/principal'
import { composeReply, type Outcome } from './guard'
import type { AgentModel } from './model'
import { clerkSystem, negotiatorSystem } from './prompts'
import { runAgent, type RunOutput, type TraceStep } from './runtime'

export type ClerkReply = {
  conversationId: string
  runId: string
  reply: string
  /** True when the model's own words were replaced by the rules' answer. */
  guarded: boolean
  outcomes: Outcome[]
  tools: Array<{ tool: string; ok: boolean }>
  model: string
  ms: number
}

export type NegotiationInput = {
  buyer?: string
  task?: string
  sellerBrief?: string
  buyerBrief?: string
  maxOffers?: number
}

export const DEFAULT_TASK = 'a spring-launch logo, delivered in two milestones (concepts, then final files), with a Figma link at each milestone'
export const DEFAULT_SELLER_BRIEF = 'Open at $450.00 in two milestones. If that is refused, your fair price is $300.00 in two equal milestones: offer that next.'
export const DEFAULT_BUYER_BRIEF = 'Open at $200.00 in two milestones. If that is refused as too low, raise your offer toward $300.00.'

/**
 * The agents. Three things live here: the clerk that staff talk to, the two negotiators, and the record of every
 * run. The agents hold no authority. They are given the MCP tools of a proposer and nothing else, so a run that
 * goes wrong can only have asked for something, and whatever it asked for was answered by the rules.
 */
export class AgentService {
  private readonly windows = new Map<string, number[]>()

  constructor(
    private readonly services: Services,
    private readonly model: AgentModel | null,
    private readonly now: () => Date,
  ) {}

  get enabled(): boolean {
    return this.model !== null
  }

  get modelName(): string | null {
    return this.model?.name ?? null
  }

  private need(): AgentModel {
    if (!this.model) throw new Problem(503, 'agents.unconfigured', 'No language model is configured', 'Set OLLAMA_API_KEY to turn the agents on. The rules and the console work without it.')
    return this.model
  }

  private limit(who: Principal, bucket: string, perMinute: number): void {
    const key = `${bucket}:${who.role}:${who.side}`
    const now = this.now().getTime()
    const recent = (this.windows.get(key) ?? []).filter((at) => now - at < 60_000)
    if (recent.length >= perMinute) {
      throw new Problem(429, 'rate.limited', 'Too many agent requests', 'The agents are limited to protect the model quota. Try again in a minute.')
    }
    this.windows.set(key, [...recent, now])
  }

  // ---------- the clerk ----------

  async clerk(input: { message: string; conversationId?: string }, who: Principal): Promise<ClerkReply> {
    const model = this.need()
    if (who.side === 'buyer') throw new Problem(403, 'auth.forbidden', 'Not available to a client agent', 'The clerk works for the studio.')
    this.limit(who, 'clerk', 12)
    const warrant = this.services.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const conversationId = input.conversationId ?? randomUUID()
    const runId = randomUUID()
    const history = this.services.repo.agentRunsInConversation(conversationId, 6).reverse().flatMap((run): ModelMessage[] => [
      { role: 'user', content: run.input },
      ...(run.output ? [{ role: 'assistant' as const, content: run.output }] : []),
    ])
    const messages: ModelMessage[] = [...history, { role: 'user', content: input.message }]

    let run: RunOutput
    try {
      // The clerk acts as a studio proposer whoever is typing. The owner's own key does not make the clerk stronger.
      run = await runAgent({ model, services: this.services, principal: STUDIO, runId, system: clerkSystem(warrant.body, this.now().toISOString().slice(0, 10)), messages, asks: 4, maxSteps: 8 })
    } catch (error) {
      this.record({ id: runId, agent: 'clerk', who, conversationId, model: model.name, input: input.message, output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0 })
      throw error
    }
    const { reply, guarded } = composeReply(run.text, run.outcomes)
    this.record({ id: runId, agent: 'clerk', who, conversationId, model: model.name, input: input.message, output: reply, steps: run.steps, status: 'ok', error: null, ms: run.ms })
    return {
      conversationId,
      runId,
      reply,
      guarded,
      outcomes: run.outcomes,
      tools: run.steps.flatMap((step) => step.toolResults.map((item) => ({ tool: item.tool, ok: item.ok }))),
      model: model.name,
      ms: run.ms,
    }
  }

  conversation(conversationId: string) {
    const runs = this.services.repo.agentRunsInConversation(conversationId, 50).reverse()
    return { conversationId, turns: runs.map((run) => ({ runId: run.id, at: run.created_at, user: run.input, clerk: run.output, status: run.status })) }
  }

  run(id: string) {
    const run = this.services.repo.agentRun(id)
    if (!run) throw new Problem(404, 'agent.run_missing', 'Run not found', 'No agent run matches that id.')
    return { id: run.id, agent: run.agent, actor: run.actor, model: run.model, status: run.status, input: run.input, output: run.output, error: run.error, ms: run.ms, createdAt: run.created_at, trace: JSON.parse(run.trace_json) as TraceStep[] }
  }

  recentRuns(limit: number) {
    return { data: this.services.repo.recentAgentRuns(limit).map((run) => ({ id: run.id, agent: run.agent, status: run.status, model: run.model, input: run.input.slice(0, 140), ms: run.ms, createdAt: run.created_at })) }
  }

  // ---------- the negotiators ----------

  /**
   * Two agents, one for each company, trade offers until the terms fit both companies' rules or they run out of
   * turns. The orchestration is plain code: who speaks, what they may see, when to stop. The only thing a model
   * chooses is the next offer, and the deal check decides whether it stands.
   */
  async negotiate(input: NegotiationInput, who: Principal) {
    const model = this.need()
    if (who.role !== 'owner') throw new Problem(403, 'auth.forbidden', 'Owner key required', 'Only the owner starts a negotiation.')
    this.limit(who, 'negotiate', 3)
    const warrant = this.services.repo.latestWarrant()
    const buyer = warrant ? resolveClient(warrant.body, input.buyer ?? warrant.body.clients[0]?.id ?? '') : null
    if (!warrant || !buyer) throw new Problem(422, 'deal.buyer_unknown', 'Unknown buyer', 'That client is not on the warrant.')
    const maxOffers = Math.min(Math.max(input.maxOffers ?? 4, 2), 8)
    const threadId = randomUUID()
    const task = input.task?.slice(0, 300) || DEFAULT_TASK
    const turns: Array<Record<string, unknown>> = []
    let agreedDealId: string | null = null

    for (let turn = 0; turn < maxOffers && !agreedDealId; turn += 1) {
      const side: Side = turn % 2 === 0 ? 'seller' : 'buyer'
      const principal = side === 'seller' ? STUDIO : buyerPrincipal(buyer.id)
      const rules = this.services.repo.partyRules(side === 'seller' ? WARRANT_ID : buyer.id)
      if (!rules) throw new Problem(409, 'deal.rules_missing', 'Deal rules are missing', 'Both companies need deal rules first.')
      const runId = randomUUID()
      const system = negotiatorSystem({
        side,
        company: side === 'seller' ? rules.body.displayName : buyer.displayName,
        counterparty: side === 'seller' ? buyer.displayName : (this.services.repo.partyRules(WARRANT_ID)?.body.displayName ?? 'the studio'),
        task,
        brief: (side === 'seller' ? input.sellerBrief : input.buyerBrief)?.slice(0, 600) || (side === 'seller' ? DEFAULT_SELLER_BRIEF : DEFAULT_BUYER_BRIEF),
        rules: rules.body,
        threadId,
      })
      const prompt = `${this.transcript(threadId, principal, buyer.displayName)}\n\nIt is your turn. Make your offer now with offer_deal.`
      let run: RunOutput
      try {
        run = await runAgent({ model, services: this.services, principal, runId, system, messages: [{ role: 'user', content: prompt }], asks: 1, maxSteps: 3, stopAfter: 'offer_deal', timeoutMs: 45_000 })
      } catch (error) {
        this.record({ id: runId, agent: `negotiator:${side}`, who, conversationId: threadId, model: model.name, input: prompt, output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0 })
        turns.push({ turn: turn + 1, side, runId, error: error instanceof Problem ? error.code : 'agent.model_error' })
        break
      }
      const offer = run.outcomes.find((item) => item.tool === 'offer_deal')
      this.record({ id: runId, agent: `negotiator:${side}`, who, conversationId: threadId, model: model.name, input: prompt, output: offer ? JSON.stringify(offer.data) : run.text, steps: run.steps, status: offer?.ok ? 'ok' : 'error', error: offer?.ok ? null : 'no_offer', ms: run.ms })
      if (!offer || !offer.ok) {
        turns.push({ turn: turn + 1, side, runId, error: offer ? String((offer.data.error as { code?: string } | undefined)?.code ?? 'offer_failed') : 'no_offer' })
        break
      }
      const dealId = String(offer.data.dealId)
      const deal = this.services.deals.get(dealId, OWNER)
      turns.push({ turn: turn + 1, side, runId, deal, ms: run.ms })
      if (offer.data.result === 'AGREED') agreedDealId = dealId
    }

    return {
      threadId,
      model: model.name,
      agreed: agreedDealId !== null,
      dealId: agreedDealId,
      turns,
    }
  }

  /** What one side has seen so far in a negotiation: terms, verdicts as that side may see them, and the notes. */
  private transcript(threadId: string, viewer: Principal, buyerName: string): string {
    const rows = this.services.repo.dealsInThread(threadId)
    if (rows.length === 0) return 'No offers have been made yet. You open the negotiation.'
    const studioName = this.services.repo.partyRules(WARRANT_ID)?.body.displayName ?? 'The studio'
    const lines = rows.map((row, index) => {
      const terms = JSON.parse(row.terms_json) as { totalCents: number; milestones: unknown[] }
      const verdict = verdictFor(JSON.parse(row.verdict_json), viewer.side)
      const speaker = row.offered_by === 'seller' ? studioName : buyerName
      const result = row.status === 'agreed'
        ? 'AGREED'
        : `REFUSED. ${verdict.violations.map((violation) => `${violation.detail} (${violation.hint})`).join(' ')}`
      const said = row.prompt ? ` They said: “${row.prompt}”` : ''
      return `${index + 1}. ${speaker} offered $${(terms.totalCents / 100).toFixed(2)} in ${terms.milestones.length} milestones. ${result}${said}`
    })
    return `Offers so far:\n${lines.join('\n')}`
  }

  private record(input: { id: string; agent: string; who: Principal; conversationId: string; model: string; input: string; output: string | null; steps: TraceStep[]; status: string; error: string | null; ms: number }): void {
    this.services.repo.insertAgentRun({
      id: input.id,
      agent: input.agent,
      actor: input.who.role,
      conversation_id: input.conversationId,
      model: input.model,
      status: input.status,
      input: input.input,
      output: input.output,
      trace_json: JSON.stringify(input.steps),
      error: input.error,
      ms: input.ms,
      created_at: this.now().toISOString(),
    })
  }
}
