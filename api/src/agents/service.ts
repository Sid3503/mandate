import { live, stamp } from '../services/live'
import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'
import { verdictFor, type Side } from '../domain/deal'
import { resolveClient } from '../domain/gate'
import { WARRANT_ID } from '../domain/schemas'
import { Problem } from '../http/problem'
import type { Services } from '../services/container'
import { buyerPrincipal, OWNER, STUDIO, type Principal } from '../services/principal'
import { draftRules, type RulesDraft } from './drafter'
import { readBack } from './intent'
import { composeReply, type Outcome } from './guard'
import type { AgentModel } from './model'
import { clerkSystem, negotiatorSystem, reviewerSystem } from './prompts'
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

/** What a watcher of a negotiation is told as it happens. Owner-only: it carries both companies' private verdicts. */
export type NegotiationEvent =
  | { type: 'start'; threadId: string; model: string; maxOffers: number; studio: string; client: string }
  | { type: 'turn_start'; turn: number; side: Side; company: string }
  | { type: 'turn'; turn: number; side: Side; runId: string; ms: number; deal: unknown }
  | { type: 'turn_error'; turn: number; side: Side; runId: string; error: string }
  | { type: 'done'; threadId: string; agreed: boolean; dealId: string | null; stopped: boolean }

export type NegotiationHooks = { onEvent?: (event: NegotiationEvent) => void | Promise<void>; signal?: AbortSignal }

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
    private readonly drafterModel: AgentModel | null = null,
    /** Tried once if the main model errors, so a bad model day does not end the conversation. */
    private readonly fallbackModel: AgentModel | null = null,
  ) {}

  get enabled(): boolean {
    return this.model !== null
  }

  get modelName(): string | null {
    return this.model?.name ?? null
  }

  private need(): AgentModel {
    if (!this.model) throw new Problem(503, 'agents.unconfigured', 'No language model is configured', 'Set BEDROCK_API_KEY (or OLLAMA_API_KEY) to turn the agents on. The rules and the console work without it.')
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

  async clerk(input: { message: string; conversationId?: string; context?: { jobId?: string; proposalId?: string } }, who: Principal, hooks: { onStep?: (step: TraceStep) => void } = {}): Promise<ClerkReply> {
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

    const screen = this.screenFor(input.context)
    const options = { services: this.services, principal: STUDIO, runId, system: clerkSystem(warrant.body, this.now().toISOString().slice(0, 10), screen), messages, asks: 4, maxSteps: 8, requestText: messages.filter((item) => item.role === 'user').map((item) => (typeof item.content === 'string' ? item.content : '')).join('\n'), onStep: hooks.onStep }
    let run: RunOutput
    let usedModel = model
    try {
      // The clerk acts as a studio proposer whoever is typing. The owner's own key does not make the clerk stronger.
      try {
        run = await runAgent({ ...options, model })
      } catch (first) {
        if (!(first instanceof Problem) || first.code !== 'agent.model_error' || !this.fallbackModel || this.fallbackModel.name === model.name) throw first
        usedModel = this.fallbackModel
        run = await runAgent({ ...options, model: usedModel })
      }
    } catch (error) {
      this.record({ id: runId, agent: 'clerk', who, conversationId, model: model.name, input: input.message, output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0 })
      throw error
    }
    // Figures in the reply must come from what the person wrote or what a tool returned.
    const evidence = [...messages.filter((item) => item.role === 'user').map((item) => (typeof item.content === 'string' ? item.content : '')), ...run.steps.flatMap((step) => step.toolResults.map((item) => JSON.stringify(item.output ?? {})))]
    const { reply, guarded } = composeReply(run.text, run.outcomes, evidence)
    this.record({ id: runId, agent: 'clerk', who, conversationId, model: usedModel.name, input: input.message, output: reply, steps: run.steps, status: 'ok', error: null, ms: run.ms })
    return {
      conversationId,
      runId,
      reply,
      guarded,
      outcomes: run.outcomes,
      tools: run.steps.flatMap((step) => step.toolResults.map((item) => ({ tool: item.tool, ok: item.ok }))),
      model: usedModel.name,
      ms: run.ms,
    }
  }

  /** What the person is looking at, in words, checked against the ledger. The app says it; the model does not. */
  private screenFor(context: { jobId?: string; proposalId?: string } | undefined): string | null {
    if (!context) return null
    const warrant = this.services.repo.latestWarrant()
    const name = (id: string | null) => [...(warrant?.body.payees ?? []), ...(warrant?.body.clients ?? [])].find((party) => party.id === id)?.displayName ?? id ?? 'unknown'
    if (context.proposalId) {
      const row = this.services.repo.proposal(context.proposalId)
      if (row) return `the receipt for a ${row.kind === 'charge' ? 'client charge' : row.kind === 'refund' ? 'refund' : 'contractor payout'} of $${(row.amount_cents / 100).toFixed(2)} ${row.kind === 'charge' ? 'to bill' : 'for'} ${name(row.payee_id)}${row.job_id ? `, job ${row.job_id}` : ''}, which is ${row.phase.replaceAll('_', ' ')}`
    }
    if (context.jobId && this.services.repo.proposalsForJob(context.jobId).length > 0) {
      const charge = this.services.repo.proposalsForJob(context.jobId).find((row) => row.kind === 'charge')
      return `the page for job ${context.jobId}${charge ? ` (client ${name(charge.payee_id)})` : ''}`
    }
    return null
  }

  // ---------- the client's reviewer ----------

  /**
   * Runs the client's own agent over a delivery that is waiting for it. The agent has the client's two tools and
   * nothing else, so the most it can do is accept or reject, and only for its own client. Its decision is signed and
   * then billed (or not) by the rules, exactly as if the client's agent had called from outside over MCP.
   */
  async reviewDelivery(dealId: string, milestone: number, who: Principal) {
    const model = this.need()
    this.limit(who, 'review', 6)
    const deal = this.services.repo.deal(dealId)
    const delivery = deal ? this.services.repo.currentDelivery(dealId, milestone) : null
    if (!deal || !delivery || delivery.status !== 'awaiting') throw new Problem(409, 'delivery.not_awaiting', 'Nothing is waiting for the client', delivery ? `The latest delivery for this milestone is ${delivery.status}.` : 'The studio has not delivered this milestone.')
    const view = this.services.deals.deliveryView(delivery)
    const principal = buyerPrincipal(deal.buyer_id)
    const runId = randomUUID()
    const system = reviewerSystem({ company: view.buyerName ?? deal.buyer_id, studio: this.services.repo.partyRules(WARRANT_ID)?.body.displayName ?? 'the studio', scope: view.scope, milestone, title: view.title, amount: `$${(view.amountCents / 100).toFixed(2)}`, proofUrl: view.proofUrl, dealId })
    const prompt = 'Decide now with decide_delivery.'
    let run: RunOutput
    live.publish({ type: 'review', stage: 'started', dealId, milestone, model: model.name, at: stamp() })
    try {
      run = await runAgent({ model, services: this.services, principal, runId, system, messages: [{ role: 'user', content: prompt }], asks: 1, maxSteps: 3, stopAfter: 'decide_delivery', timeoutMs: 45_000 })
    } catch (error) {
      this.record({ id: runId, agent: 'reviewer', who, conversationId: runId, model: model.name, input: prompt, output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0 })
      live.publish({ type: 'review', stage: 'failed', dealId, milestone, model: model.name, note: error instanceof Problem ? error.detail : 'The model call failed.', at: stamp() })
      throw error
    }
    const decided = run.steps.flatMap((step) => step.toolResults).find((item) => item.tool === 'decide_delivery')
    this.record({ id: runId, agent: 'reviewer', who, conversationId: runId, model: model.name, input: prompt, output: decided ? JSON.stringify(decided.output) : run.text, steps: run.steps, status: decided?.ok ? 'ok' : 'error', error: decided?.ok ? null : 'no_decision', ms: run.ms })
    if (!decided || !decided.ok) {
      const error = (decided?.output as { error?: { code?: string; message?: string } } | undefined)?.error
      live.publish({ type: 'review', stage: 'failed', dealId, milestone, model: model.name, note: error?.message ?? 'The model did not decide.', at: stamp() })
      throw new Problem(422, 'delivery.no_decision', 'The client\'s agent did not decide', error?.message ?? 'The model did not accept or reject the delivery. Nothing was billed. Try again.')
    }
    const after = this.services.repo.delivery(delivery.id)!
    return { runId, model: model.name, ms: run.ms, delivery: this.services.deals.deliveryView(after), charge: after.proposal_id ? this.services.mandate.packet(after.proposal_id).proposal : null }
  }

  /** Deliveries nobody has answered for a little while. Used when the hosted stand-in for the client's agent is on `auto`. */
  async reviewWaiting(olderThanMs = 20_000, max = 2): Promise<number> {
    if (!this.model) return 0
    const cutoff = this.now().getTime() - olderThanMs
    const waiting = this.services.repo.deliveriesFor(null, 50).filter((row) => row.status === 'awaiting' && Date.parse(row.created_at) <= cutoff).slice(0, max)
    for (const row of waiting) await this.reviewDelivery(row.deal_id, row.milestone, OWNER).catch((error) => logReviewFailure(row.deal_id, row.milestone, error))
    return waiting.length
  }

  // ---------- the rules drafter ----------

  /** A draft of new rules from the owner's own words. It is a draft only: nothing is published, and the owner reads a diff first. */
  async draftRules(instruction: string, who: Principal) {
    const model = this.drafterModel ?? this.need()
    this.limit(who, 'drafter', 8)
    const warrant = this.services.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const runId = randomUUID()
    try {
      const draft = await draftRules({ model, current: warrant.body, instruction })
      this.record({ id: runId, agent: 'drafter', who, conversationId: runId, model: model.name, input: instruction, output: draft.summary, steps: [], status: 'ok', error: null, ms: draft.ms })
      // A worked example in the owner's own numbers: the biggest milestone on a signed deal, or $150.
      const exampleCents = Math.max(0, ...this.services.deals.readyToBill().map((item) => item.amountCents), 0) || 15_000
      return { ...draft, runId, readBack: readBack(draft.draft, exampleCents), replay: this.services.mandate.replay(draft.draft) }
    } catch (error) {
      this.record({ id: runId, agent: 'drafter', who, conversationId: runId, model: model.name, input: instruction, output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0 })
      throw error
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
  async negotiate(input: NegotiationInput, who: Principal, hooks: NegotiationHooks = {}) {
    const model = this.need()
    this.assertCanNegotiate(who)
    this.limit(who, 'negotiate', 3)
    const warrant = this.services.repo.latestWarrant()
    const buyer = warrant ? resolveClient(warrant.body, input.buyer ?? warrant.body.clients[0]?.id ?? '') : null
    if (!warrant || !buyer) throw new Problem(422, 'deal.buyer_unknown', 'Unknown buyer', 'That client is not on the warrant.')
    const maxOffers = Math.min(Math.max(input.maxOffers ?? 4, 2), 8)
    const threadId = randomUUID()
    const task = input.task?.slice(0, 300) || DEFAULT_TASK
    const turns: Array<Record<string, unknown>> = []
    let agreedDealId: string | null = null
    let stopped = false
    const emit = async (event: NegotiationEvent) => { await hooks.onEvent?.(event) }
    const studioName = this.services.repo.partyRules(WARRANT_ID)?.body.displayName ?? 'the studio'
    await emit({ type: 'start', threadId, model: model.name, maxOffers, studio: studioName, client: buyer.displayName })

    for (let turn = 0; turn < maxOffers && !agreedDealId; turn += 1) {
      if (hooks.signal?.aborted) {
        stopped = true
        break
      }
      const side: Side = turn % 2 === 0 ? 'seller' : 'buyer'
      const principal = side === 'seller' ? STUDIO : buyerPrincipal(buyer.id)
      const rules = this.services.repo.partyRules(side === 'seller' ? WARRANT_ID : buyer.id)
      if (!rules) throw new Problem(409, 'deal.rules_missing', 'Deal rules are missing', 'Both companies need deal rules first.')
      const runId = randomUUID()
      await emit({ type: 'turn_start', turn: turn + 1, side, company: side === 'seller' ? studioName : buyer.displayName })
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
        // A model service can hiccup. One quiet retry, with the same run id and a fresh connection, saves a live demo.
        // Only the model call is retried: an offer that reached the rules is never sent twice (its key is the run id).
        try {
          run = await runAgent({ model, services: this.services, principal, runId, system, messages: [{ role: 'user', content: prompt }], asks: 1, maxSteps: 3, stopAfter: 'offer_deal', timeoutMs: 45_000, signal: hooks.signal })
        } catch (first) {
          if (!(first instanceof Problem) || first.code !== 'agent.model_error' || hooks.signal?.aborted) throw first
          run = await runAgent({ model, services: this.services, principal, runId, system, messages: [{ role: 'user', content: prompt }], asks: 1, maxSteps: 3, stopAfter: 'offer_deal', timeoutMs: 45_000, signal: hooks.signal })
        }
      } catch (error) {
        if (hooks.signal?.aborted) {
          stopped = true
          break
        }
        this.record({ id: runId, agent: `negotiator:${side}`, who, conversationId: threadId, model: model.name, input: prompt, output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0 })
        turns.push({ turn: turn + 1, side, runId, error: error instanceof Problem ? error.code : 'agent.model_error' })
        await emit({ type: 'turn_error', turn: turn + 1, side, runId, error: error instanceof Problem ? error.code : 'agent.model_error' })
        break
      }
      const offer = run.outcomes.find((item) => item.tool === 'offer_deal')
      this.record({ id: runId, agent: `negotiator:${side}`, who, conversationId: threadId, model: model.name, input: prompt, output: offer ? JSON.stringify(offer.data) : run.text, steps: run.steps, status: offer?.ok ? 'ok' : 'error', error: offer?.ok ? null : 'no_offer', ms: run.ms })
      if (!offer || !offer.ok) {
        const code = offer ? String((offer.data.error as { code?: string } | undefined)?.code ?? 'offer_failed') : 'no_offer'
        turns.push({ turn: turn + 1, side, runId, error: code })
        await emit({ type: 'turn_error', turn: turn + 1, side, runId, error: code })
        break
      }
      const dealId = String(offer.data.dealId)
      const deal = this.services.deals.get(dealId, OWNER)
      turns.push({ turn: turn + 1, side, runId, deal, ms: run.ms })
      await emit({ type: 'turn', turn: turn + 1, side, runId, ms: run.ms, deal })
      if (offer.data.result === 'AGREED') agreedDealId = dealId
    }
    await emit({ type: 'done', threadId, agreed: agreedDealId !== null, dealId: agreedDealId, stopped })

    return {
      threadId,
      model: model.name,
      agreed: agreedDealId !== null,
      dealId: agreedDealId,
      turns,
    }
  }

  /** Checks that fail fast with a normal error, before a stream is opened. */
  assertCanNegotiate(who: Principal): void {
    this.need()
    if (who.role !== 'owner') throw new Problem(403, 'auth.forbidden', 'Owner key required', 'Only the owner starts a negotiation.')
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

/** The client's stand-in answers in the background, so a failure has nobody to tell. Say it in the server log. */
export function logReviewFailure(dealId: string, milestone: number, error: unknown) {
  const detail = error instanceof Problem ? `${error.code}: ${error.detail}` : error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({ level: 'warn', message: 'client agent could not review a delivery', dealId, milestone, detail }))
}
