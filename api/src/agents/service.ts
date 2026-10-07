import { live, stamp } from '../services/live'
import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'
import { verdictFor, type Side } from '../domain/deal'
import { resolveClient } from '../domain/gate'
import { WARRANT_ID } from '../domain/schemas'
import { Problem } from '../http/problem'
import type { Services } from '../services/container'
import { buyerPrincipal, OWNER, STUDIO, type Principal } from '../services/principal'
import { draftRules, type DraftStage } from './drafter'
import { assessPolicy, countStatuses, planPolicy } from './policy'
import { ModelHealth } from './health'
import { runStudioTurn, type StudioEvent, type StudioTurn } from './studio'
import { assessProof } from './proof'
import { readBack } from './intent'
import { claimsMoneyMoved, composeReply, unsupportedAmounts, type Outcome } from './guard'
import type { AgentModel } from './model'
import { clerkSystem, negotiatorSystem, PROMPT_VERSIONS, promptVersion, reviewerSystem, untrusted, type PromptId } from './prompts'
import { runAgent, type AgentEvent, type RunOutput, type TraceStep } from './runtime'

export type ClerkReply = {
  conversationId: string
  runId: string
  reply: string
  /** True when the model's own words were replaced by the rules' answer. */
  guarded: boolean
  outcomes: Outcome[]
  tools: Array<{ tool: string; ok: boolean }>
  model: string
  /** True when the main model failed or was cooling off and the fallback answered. */
  fellBack?: boolean
  ms: number
}

/** What the clerk's screen is told as the run happens. */
export type ClerkStreamEvent = AgentEvent | { type: 'retract'; reason: 'money_claim' | 'unsupported_amount' }

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
  | { type: 'turn_tool'; turn: number; side: Side; phase: 'start' | 'call' | 'end'; id: string; tool: string; input?: unknown; ok?: boolean; ms?: number }
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
  /** How each model is doing, and which ones are cooling off after repeated failures. */
  readonly health = new ModelHealth()

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

  /**
   * Runs one agent call on the best model available. A model that keeps failing is skipped for a while (the circuit is
   * open) and the fallback is used straight away; a transient failure is tried once on the fallback (or once more on the
   * same model when there is no other). Every call is counted in the model's health. Nothing is retried after a Problem
   * that is not about the model (a stop, a refusal), and no retry can send a request twice: a request's key is the run id.
   */
  private async withModels<T extends { ms: number; usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } }>(run: (model: AgentModel) => Promise<T>, options: { retrySame?: boolean; primary?: AgentModel } = {}): Promise<{ output: T; model: AgentModel; fellBack: boolean }> {
    const primary = options.primary ?? this.need()
    const other = this.fallbackModel && this.fallbackModel.name !== primary.name ? this.fallbackModel : null
    let order: AgentModel[] = other ? [primary, other] : options.retrySame ? [primary, primary] : [primary]
    if (other && !this.health.allow(primary.name)) order = [other]
    else if (!other && this.health.circuit(primary.name) === 'open') throw new Problem(503, 'agent.unavailable', 'The model is cooling off', 'The language model failed several times in a row, so it is paused for a moment. The rules and everything else still work. Try again shortly.')
    let last: unknown = null
    for (const [index, model] of order.entries()) {
      try {
        const output = await run(model)
        this.health.success(model.name, output.ms, output.usage)
        return { output, model, fellBack: model.name !== primary.name }
      } catch (error) {
        last = error
        if (!(error instanceof Problem) || (error.code !== 'agent.model_error' && error.code !== 'agent.rate_limited')) throw error
        this.health.failure(model.name, error.code)
        if (index === order.length - 1) break
      }
    }
    throw last
  }

  // ---------- the clerk ----------

  async clerk(input: { message: string; conversationId?: string; context?: { jobId?: string; proposalId?: string } }, who: Principal, hooks: { onStep?: (step: TraceStep) => void; onEvent?: (event: ClerkStreamEvent) => void } = {}): Promise<ClerkReply> {
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
    const userText = messages.filter((item) => item.role === 'user').map((item) => (typeof item.content === 'string' ? item.content : '')).join('\n')
    const options = { services: this.services, principal: STUDIO, runId, system: clerkSystem(warrant.body, this.now().toISOString().slice(0, 10), screen), messages, asks: 4, maxSteps: 8, requestText: userText, onStep: hooks.onStep }
    let run: RunOutput
    let usedModel = model
    let fellBack = false
    try {
      // The clerk acts as a studio proposer whoever is typing. The owner's own key does not make the clerk stronger.
      // Its words are streamed to the screen as they are written, through a guard that takes them back the moment they
      // claim money moved or state a figure nobody supplied (the final reply is still checked the same way).
      ;({ output: run, model: usedModel, fellBack } = await this.withModels((chosen) => runAgent({ ...options, model: chosen, onEvent: hooks.onEvent ? guardedStream(userText, hooks.onEvent) : undefined })))
    } catch (error) {
      this.record({ id: runId, agent: 'clerk', who, conversationId, model: model.name, input: input.message, output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0 })
      throw error
    }
    // Figures in the reply must come from what the person wrote or what a tool returned.
    const evidence = [...messages.filter((item) => item.role === 'user').map((item) => (typeof item.content === 'string' ? item.content : '')), ...run.steps.flatMap((step) => step.toolResults.map((item) => JSON.stringify(item.output ?? {})))]
    const { reply, guarded } = composeReply(run.text, run.outcomes, evidence)
    this.record({ id: runId, agent: 'clerk', who, conversationId, model: usedModel.name, input: input.message, output: reply, steps: run.steps, status: 'ok', error: null, ms: run.ms, prompt: 'clerk', usage: run.usage, turns: run.turns })
    return {
      conversationId,
      runId,
      reply,
      guarded,
      outcomes: run.outcomes,
      tools: run.steps.flatMap((step) => step.toolResults.map((item) => ({ tool: item.tool, ok: item.ok }))),
      model: usedModel.name,
      fellBack,
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
    const prompt = 'Decide now with decide_delivery.'
    const announce = (call: { phase: 'start' | 'call' | 'end'; id: string; tool: string; source: 'code' | 'model'; input?: unknown; ok?: boolean; ms?: number; note?: string }) => live.publish({ type: 'agent', agent: 'reviewer', dealId, milestone, call, at: stamp() })

    // Step one is plain code: what can be known about the link without opening it. A clear-cut bad link is answered
    // here, with no model asked, and the reason is the code's own.
    const facts = assessProof(view.proofUrl)
    live.publish({ type: 'review', stage: 'started', dealId, milestone, model: facts.verdict === 'reject' ? 'proof check' : model.name, at: stamp() })
    announce({ phase: 'start', id: `check-${runId}`, tool: 'proof_check', source: 'code' })
    announce({ phase: 'end', id: `check-${runId}`, tool: 'proof_check', source: 'code', ok: facts.verdict !== 'reject', ms: 0, note: facts.summary })
    const checkStep: TraceStep = { text: '', toolCalls: [{ tool: 'proof_check', input: { url: view.proofUrl } }], toolResults: [{ tool: 'proof_check', ok: facts.verdict !== 'reject', output: facts }] }
    if (facts.verdict === 'reject') {
      const note = `Rejected by the proof check before any model was asked: ${facts.summary}. Deliver a link to the specific file.`.slice(0, 480)
      const made = await this.services.deals.decide(dealId, milestone, { decision: 'rejected', note }, principal, runId)
      this.record({ id: runId, agent: 'reviewer', who, conversationId: runId, model: 'proof-check (code)', input: prompt, output: note, steps: [checkStep], status: 'ok', error: null, ms: 0, turns: 0 })
      return { runId, model: 'proof check', ms: 0, delivery: (made.body as { delivery: ReturnType<AgentService['deliveryOf']> }).delivery, charge: null }
    }

    const system = reviewerSystem({ company: view.buyerName ?? deal.buyer_id, studio: this.services.repo.partyRules(WARRANT_ID)?.body.displayName ?? 'the studio', scope: view.scope, milestone, title: view.title, amount: `$${(view.amountCents / 100).toFixed(2)}`, proofUrl: view.proofUrl, dealId, proofFacts: facts.summary })
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'tool_start') announce({ phase: 'start', id: event.id, tool: event.tool, source: 'model' })
      else if (event.type === 'tool_call') announce({ phase: 'call', id: event.id, tool: event.tool, source: 'model', input: event.input })
      else if (event.type === 'tool_end') announce({ phase: 'end', id: event.id, tool: event.tool, source: 'model', ok: event.ok, ms: event.ms })
    }
    let run: RunOutput
    let used = model
    try {
      ;({ output: run, model: used } = await this.withModels((chosen) => runAgent({ model: chosen, services: this.services, principal, runId, system, messages: [{ role: 'user', content: prompt }], asks: 1, maxSteps: 3, stopAfter: 'decide_delivery', toolChoice: 'required', timeoutMs: 45_000, onEvent })))
    } catch (error) {
      this.record({ id: runId, agent: 'reviewer', who, conversationId: runId, model: model.name, input: prompt, output: null, steps: [checkStep], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0, prompt: 'reviewer' })
      live.publish({ type: 'review', stage: 'failed', dealId, milestone, model: model.name, note: error instanceof Problem ? error.detail : 'The model call failed.', at: stamp() })
      if (error instanceof Problem && error.code === 'agent.no_tool_call') throw new Problem(422, 'delivery.no_decision', 'The client\'s agent did not decide', 'The model did not accept or reject the delivery. Nothing was billed. Try again.')
      throw error
    }
    const decided = run.steps.flatMap((step) => step.toolResults).find((item) => item.tool === 'decide_delivery')
    this.record({ id: runId, agent: 'reviewer', who, conversationId: runId, model: used.name, input: prompt, output: decided ? JSON.stringify(decided.output) : run.text, steps: [checkStep, ...run.steps], status: decided?.ok ? 'ok' : 'error', error: decided?.ok ? null : 'no_decision', ms: run.ms, prompt: 'reviewer', usage: run.usage, turns: run.turns })
    if (!decided || !decided.ok) {
      const error = (decided?.output as { error?: { code?: string; message?: string } } | undefined)?.error
      live.publish({ type: 'review', stage: 'failed', dealId, milestone, model: used.name, note: error?.message ?? 'The model did not decide.', at: stamp() })
      throw new Problem(422, 'delivery.no_decision', 'The client\'s agent did not decide', error?.message ?? 'The model did not accept or reject the delivery. Nothing was billed. Try again.')
    }
    const after = this.services.repo.delivery(delivery.id)!
    return { runId, model: used.name, ms: run.ms, delivery: this.deliveryOf(after), charge: after.proposal_id ? this.services.mandate.packet(after.proposal_id).proposal : null }
  }

  private deliveryOf(row: Parameters<Services['deals']['deliveryView']>[0]) {
    return this.services.deals.deliveryView(row)
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
  async draftRules(instruction: string, who: Principal, hooks: { onStage?: (stage: DraftStage) => void } = {}) {
    const model = this.drafterModel ?? this.need()
    this.limit(who, 'drafter', 8)
    const warrant = this.services.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const runId = randomUUID()
    const stage = hooks.onStage ?? (() => undefined)
    try {
      const { output: draft, model: used } = await this.withModels((chosen) => draftRules({ model: chosen, current: warrant.body, instruction, onStage: stage }), { primary: model })
      this.record({ id: runId, agent: 'drafter', who, conversationId: runId, model: used.name, input: instruction, output: draft.summary, steps: [], status: 'ok', error: null, ms: draft.ms, prompt: 'drafter' })
      // A worked example in the owner's own numbers: the biggest milestone on a signed deal, or $150.
      stage({ stage: 'replaying' })
      const exampleCents = Math.max(0, ...this.services.deals.readyToBill().map((item) => item.amountCents), 0) || 15_000
      const replay = this.services.mandate.replay(draft.draft)
      stage({ stage: 'reading_back' })
      return { ...draft, runId, readBack: readBack(draft.draft, exampleCents), replay }
    } catch (error) {
      this.record({ id: runId, agent: 'drafter', who, conversationId: runId, model: model.name, input: instruction, output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0, prompt: 'drafter' })
      throw error
    }
  }

  /**
   * "Paste your policy." The text is split and sorted by code; only the sentences that could be rules reach the drafter,
   * as numbered lines inside the owner's own request; and every verdict on a sentence is found by code in the finished
   * draft. Nothing is published. With nothing in the paste that could be a rule, no model is called.
   */
  async draftFromPolicy(text: string, who: Principal, hooks: { onStage?: (stage: DraftStage) => void } = {}) {
    const warrant = this.services.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const plan = planPolicy(text, warrant.body)
    if (!plan.instruction) {
      const counts = countStatuses(plan.sentences)
      return { sentences: plan.sentences, counts, draft: null }
    }
    const draft = await this.draftRules(plan.instruction, who, hooks)
    const sentences = assessPolicy(plan, warrant.body, draft.draft)
    return { sentences, counts: countStatuses(sentences), draft }
  }

  /**
   * One turn of the dashboard agent in the browser (AG Studio). The model only writes; the dashboard's own tools run in
   * the browser, against a copy of the ledger. Nothing here is handed a service, the ledger or PayPal.
   */
  async studioTurn(turn: StudioTurn, who: Principal, hooks: { onEvent: (event: StudioEvent) => void; signal?: AbortSignal }) {
    this.need()
    this.limit(who, 'studio', 40)
    const { output: done, model } = await this.withModels((chosen) => runStudioTurn({ model: chosen, turn, signal: hooks.signal, onEvent: hooks.onEvent }))
    this.record({ id: randomUUID(), agent: 'studio', who, conversationId: randomUUID(), model: model.name, input: JSON.stringify(turn.input.slice(-1)[0] ?? {}).slice(0, 2000), output: JSON.stringify(done.output).slice(0, 4000), steps: [], status: 'ok', error: null, ms: done.ms, usage: { inputTokens: done.usage?.inputTokens, outputTokens: done.usage?.outputTokens } })
    const { emitted: _emitted, ms: _ms, ...response } = done
    return response
  }

  /** What an operator wants to know about the AI layer: the models, their recent health, the prompt versions in force. */
  healthReport() {
    return {
      enabled: this.enabled,
      primary: this.model?.name ?? null,
      drafter: this.drafterModel?.name ?? this.model?.name ?? null,
      fallback: this.fallbackModel && this.fallbackModel.name !== this.model?.name ? this.fallbackModel.name : null,
      prompts: PROMPT_VERSIONS,
      models: this.health.stats(),
    }
  }

  conversation(conversationId: string) {
    const runs = this.services.repo.agentRunsInConversation(conversationId, 50).reverse()
    return { conversationId, turns: runs.map((run) => ({ runId: run.id, at: run.created_at, user: run.input, clerk: run.output, status: run.status })) }
  }

  run(id: string) {
    const run = this.services.repo.agentRun(id)
    if (!run) throw new Problem(404, 'agent.run_missing', 'Run not found', 'No agent run matches that id.')
    return { id: run.id, agent: run.agent, actor: run.actor, model: run.model, status: run.status, input: run.input, output: run.output, error: run.error, ms: run.ms, createdAt: run.created_at, promptVersion: run.prompt_version ?? null, inputTokens: run.input_tokens ?? null, outputTokens: run.output_tokens ?? null, turns: run.turns ?? null, trace: JSON.parse(run.trace_json) as TraceStep[] }
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
      let turnModel = model
      const onEvent = (event: AgentEvent) => {
        if (event.type === 'tool_start') void emit({ type: 'turn_tool', turn: turn + 1, side, phase: 'start', id: event.id, tool: event.tool })
        else if (event.type === 'tool_call') void emit({ type: 'turn_tool', turn: turn + 1, side, phase: 'call', id: event.id, tool: event.tool, input: event.input })
        else if (event.type === 'tool_end') void emit({ type: 'turn_tool', turn: turn + 1, side, phase: 'end', id: event.id, tool: event.tool, ok: event.ok, ms: event.ms })
      }
      try {
        // A model service can hiccup. One quiet retry (on the fallback model if there is one) saves a live demo.
        // Only the model call is retried: an offer that reached the rules is never sent twice (its key is the run id).
        ;({ output: run, model: turnModel } = await this.withModels((chosen) => runAgent({ model: chosen, services: this.services, principal, runId, system, messages: [{ role: 'user', content: prompt }], asks: 1, maxSteps: 3, stopAfter: 'offer_deal', toolChoice: 'required', timeoutMs: 45_000, signal: hooks.signal, onEvent }), { retrySame: true }))
      } catch (error) {
        if (hooks.signal?.aborted) {
          stopped = true
          break
        }
        const code = error instanceof Problem ? (error.code === 'agent.no_tool_call' ? 'no_offer' : error.code) : 'agent.model_error'
        this.record({ id: runId, agent: `negotiator:${side}`, who, conversationId: threadId, model: model.name, input: prompt, output: null, steps: [], status: 'error', error: code, ms: 0, prompt: 'negotiator' })
        turns.push({ turn: turn + 1, side, runId, error: code })
        await emit({ type: 'turn_error', turn: turn + 1, side, runId, error: code })
        break
      }
      const offer = run.outcomes.find((item) => item.tool === 'offer_deal')
      this.record({ id: runId, agent: `negotiator:${side}`, who, conversationId: threadId, model: turnModel.name, input: prompt, output: offer ? JSON.stringify(offer.data) : run.text, steps: run.steps, status: offer?.ok ? 'ok' : 'error', error: offer?.ok ? null : 'no_offer', ms: run.ms, prompt: 'negotiator', usage: run.usage, turns: run.turns })
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
      const said = row.prompt ? ` They said: ${untrusted('counterparty_message', row.prompt, 300)}` : ''
      return `${index + 1}. ${speaker} offered $${(terms.totalCents / 100).toFixed(2)} in ${terms.milestones.length} milestones. ${result}${said}`
    })
    return `Offers so far:\n${lines.join('\n')}`
  }

  private record(input: { id: string; agent: string; who: Principal; conversationId: string; model: string; input: string; output: string | null; steps: TraceStep[]; status: string; error: string | null; ms: number; prompt?: PromptId; usage?: { inputTokens: number | undefined; outputTokens: number | undefined }; turns?: number }): void {
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
      prompt_version: input.prompt ? promptVersion(input.prompt) : null,
      input_tokens: input.usage?.inputTokens ?? null,
      output_tokens: input.usage?.outputTokens ?? null,
      turns: input.turns ?? null,
    })
  }
}

/** The client's stand-in answers in the background, so a failure has nobody to tell. Say it in the server log. */
export function logReviewFailure(dealId: string, milestone: number, error: unknown) {
  const detail = error instanceof Problem ? `${error.code}: ${error.detail}` : error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({ level: 'warn', message: 'client agent could not review a delivery', dealId, milestone, detail }))
}


/**
 * Lets the clerk's words through to the screen as they are written, and takes them back the moment they go wrong. A
 * sentence that says money moved (an agent that can only ask can never know that), or a dollar figure that neither the
 * person nor a tool supplied, retracts everything shown so far and stops further text. The screen then waits for the
 * rules' own answer. Only whole words are judged, so a figure still being typed is never mistaken for an invented one.
 */
export function guardedStream(userText: string, emit: (event: ClerkStreamEvent) => void): (event: AgentEvent) => void {
  let buffer = ''
  let retracted = false
  let moved = false
  const evidence = [userText]
  return (event) => {
    if (event.type === 'tool_end') {
      evidence.push(JSON.stringify(event.output ?? {}))
      const data = (event.output ?? {}) as Record<string, unknown>
      if (event.ok && (data.phase === 'captured' || data.phase === 'refunded')) moved = true
    }
    if (event.type !== 'text') return emit(event)
    if (retracted) return
    buffer += event.delta
    const whole = buffer.slice(0, buffer.search(/\s\S*$/) + 1 || 0)
    const reason = claimsMoneyMoved(whole) && !moved ? 'money_claim' : unsupportedAmounts(whole, evidence).length > 0 ? 'unsupported_amount' : null
    if (reason) {
      retracted = true
      return emit({ type: 'retract', reason })
    }
    emit(event)
  }
}
