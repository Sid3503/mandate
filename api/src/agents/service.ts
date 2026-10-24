import { live, stamp } from '../services/live'
import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'
import type { Side } from '../domain/deal'
import { resolveClient } from '../domain/gate'
import { paidPhase } from '../domain/phases'
import { BLANK_WARRANT, WARRANT_ID } from '../domain/schemas'
import { Problem } from '../http/problem'
import type { Services } from '../services/container'
import { buyerPrincipal, OWNER, STUDIO, type Principal } from '../services/principal'
import { draftRules, secondReaderOpinion, summaryContradiction, codeSummary, type DraftStage, type SecondReaderResult } from './drafter'
import type { ServerFlags } from '../flags'
import { auditPolicy, readAll, type Audit, type Read } from './policyAgents'
import { applyAudit, countStatuses, firstPass, instructionFor, listChanges, POLICY_MAX_SENTENCES, READ_CHUNK, segmentPolicy, sendable } from './policy'
import { ModelHealth } from './health'
import { runStudioTurn, type StudioEvent, type StudioTurn } from './studio'
import { assessProof } from './proof'
import { explainRules } from './explainer'
import { readBack } from './intent'
import { claimsMoneyMoved, composeReply, unsupportedAmounts, type Outcome } from './guard'
import { usageTokens, type ModelBudget } from '../ops/budget'
import type { AgentModel } from './model'
import { clerkSystem, debriefSystem, negotiatorSystem, negotiatorTurn, price, PROMPT_VERSIONS, promptVersion, reviewerSystem, untrusted, type PromptId } from './prompts'
import { callTool } from './structured'
import { DEFAULT_OFFERS_PER_SIDE, seatOf } from '../domain/negotiation'
import { endingWords } from '../services/deals'
import { z } from 'zod'
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
  milestones?: string[]
  category?: string
  sellerBrief?: string
  buyerBrief?: string
  offersPerSide?: number
  maxOffers?: number
  threadId?: string
}

/** A negotiator's debrief for its own company, in the four parts of the Subjective Value Inventory. */
export const DebriefSchema = z.object({
  satisfaction: z.enum(['satisfied', 'acceptable', 'dissatisfied']).describe('All things considered, for your company'),
  ratings: z.object({
    outcome: z.number().int().min(1).max(5),
    process: z.number().int().min(1).max(5),
    relationship: z.number().int().min(1).max(5),
    self: z.number().int().min(1).max(5),
  }).describe('1 very poor to 5 excellent'),
  wouldSignAgain: z.boolean().describe('Would you recommend your company agree to the same again'),
  summary: z.string().min(10).max(600).describe('Two or three sentences to your company: what you got and whether it was good'),
  lesson: z.string().min(5).max(300).describe('One thing to do differently next time'),
})

/**
 * Gives a reasoning model room to think on a decision that needs it. gpt-oss takes a level (low, medium, high, as its
 * model card describes); a model without a thinking mode is left as it is rather than sent a setting it would refuse.
 */
export function reasoning(model: AgentModel, level: 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' | undefined {
  return /^gpt-oss/i.test(model.name) ? level : undefined
}

/** What a seat the watcher may not see is allowed to show of a tool call: the public move, never the reasoning. */
function publicMove(input: unknown): unknown {
  const value = (input ?? {}) as Record<string, unknown>
  const { assessment: _private, ...rest } = value
  return rest
}

function publicResult(output: unknown): unknown {
  const value = (output ?? {}) as Record<string, unknown>
  return { result: value.result, dealId: value.dealId, status: value.status, ...(value.error ? { error: value.error } : {}) }
}

const sealedNote = (company: string) => `Private to ${company}: this run spoke for ${company} under its own sealed mandate.`

/**
 * What a watcher of a negotiation is told as it happens. The moves are public. A side's private reasoning and debrief
 * reach a watcher only if the watcher may see that side (its own; the owner also a client that has not claimed its seat).
 */
export type NegotiationEvent =
  | { type: 'start'; threadId: string; model: string; maxOffers: number; offersPerSide: number; studio: string; client: string; scope: string; currency: string; seats: { seller: 'agent' | 'client'; buyer: 'agent' | 'client' } }
  | { type: 'turn_start'; turn: number; side: Side; company: string }
  | { type: 'turn_tool'; turn: number; side: Side; phase: 'start' | 'call' | 'end'; id: string; tool: string; input?: unknown; ok?: boolean; ms?: number; output?: unknown }
  | { type: 'turn'; turn: number; side: Side; runId: string; ms: number; action: 'offer' | 'accept' | 'walk_away'; deal: unknown; message: string | null; final: boolean; assessment: string | null; by: 'agent' }
  | { type: 'turn_error'; turn: number; side: Side; runId: string; error: string; detail: string | null }
  | { type: 'waiting'; side: Side; company: string }
  | { type: 'debrief'; side: Side; debrief: unknown }
  | { type: 'done'; threadId: string; agreed: boolean; dealId: string | null; stopped: boolean; status: string; ending: string | null; failed: string | null; negotiation: unknown }

export type NegotiationHooks = { onEvent?: (event: NegotiationEvent) => void | Promise<void>; signal?: AbortSignal }


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
    /** When set, a call past the cap or after the kill switch never reaches the model. */
    private readonly budget: ModelBudget | null = null,
    private readonly flags: ServerFlags | null = null,
  ) {}

  get enabled(): boolean {
    return this.model !== null && this.budget?.blocked() == null
  }

  /**
   * Why the agents are off, in words. There are two reasons and they are not the same: no key at all, or the day's
   * token budget is used up. Saying "set OLLAMA_API_KEY" when the key is there and the budget is spent is a lie.
   */
  get offReason(): 'no_key' | 'daily_budget' | null {
    if (this.model === null) return 'no_key'
    if (this.budget?.blocked()) return 'daily_budget'
    return null
  }

  /** How much of the day's model budget is gone, so the console can say how much is left. */
  get budgetUsage(): { tokensIn: number; tokensOut: number; cap: number; percent: number } | null {
    if (!this.budget) return null
    const snapshot = this.budget.snapshot()
    return { tokensIn: snapshot.tokensIn, tokensOut: snapshot.tokensOut, cap: snapshot.cap, percent: snapshot.budgetPercent }
  }

  get modelName(): string | null {
    return this.model?.name ?? null
  }

  private need(): AgentModel {
    if (!this.model) throw new Problem(503, 'agents.unconfigured', 'No language model is configured', 'Set OLLAMA_API_KEY to turn the agents on. The rules and the console work without it.')
    const paused = this.budget?.reserve()
    if (paused) throw new Problem(503, 'budget/exhausted', 'AI is paused', paused)
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
  private async withModels<T extends { ms: number; usage?: { inputTokens?: unknown; outputTokens?: unknown } }>(run: (model: AgentModel) => Promise<T>, options: { retrySame?: boolean; primary?: AgentModel } = {}): Promise<{ output: T; model: AgentModel; fellBack: boolean }> {
    const paused = this.budget?.blocked()
    if (paused) throw new Problem(503, 'budget/exhausted', 'AI is paused', paused)
    const primary = options.primary ?? this.need()
    const other = this.fallbackModel && this.fallbackModel.name !== primary.name ? this.fallbackModel : null
    let order: AgentModel[] = other ? [primary, other] : options.retrySame ? [primary, primary] : [primary]
    if (other && !this.health.allow(primary.name)) order = [other]
    else if (!other && this.health.circuit(primary.name) === 'open') throw new Problem(503, 'agent.unavailable', 'The model is cooling off', 'The language model failed several times in a row, so it is paused for a moment. The rules and everything else still work. Try again shortly.')
    let last: unknown = null
    for (const [index, model] of order.entries()) {
      try {
        const output = await run(model)
        this.health.success(model.name, output.ms, output.usage as { inputTokens?: number; outputTokens?: number } | undefined)
        if (output.usage) this.budget?.correct(usageTokens(output.usage.inputTokens), usageTokens(output.usage.outputTokens))
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

  async clerk(input: { message: string; conversationId?: string; context?: { jobId?: string; proposalId?: string; receiptId?: string; dealId?: string } }, who: Principal, hooks: { onStep?: (step: TraceStep) => void; onEvent?: (event: ClerkStreamEvent) => void } = {}): Promise<ClerkReply> {
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
    // "Pay her share" on a receipt means the person on that receipt. The screen line is written by code from the
    // ledger, so the names on it count as named by the person, exactly as if they had typed them.
    const options = { services: this.services, principal: STUDIO, runId, system: clerkSystem(warrant.body, this.now().toISOString().slice(0, 10), screen), messages, asks: 4, maxSteps: 8, requestText: screen ? `${userText}\n${screen}` : userText, onStep: hooks.onStep }
    let run: RunOutput
    let usedModel = model
    let fellBack = false
    try {
      // The clerk acts as a studio proposer whoever is typing. The owner's own key does not make the clerk stronger.
      // Its words are streamed to the screen as they are written, through a guard that takes them back the moment they
      // claim money moved or state a figure nobody supplied (the final reply is still checked the same way).
      ;({ output: run, model: usedModel, fellBack } = await this.withModels((chosen) => runAgent({ ...options, model: chosen, onEvent: hooks.onEvent ? guardedStream(userText, hooks.onEvent) : undefined }), { primary: model }))
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
  private screenFor(context: { jobId?: string; proposalId?: string; receiptId?: string; dealId?: string } | undefined): string | null {
    if (!context) return null
    const warrant = this.services.repo.latestWarrant()
    const name = (id: string | null) => [...(warrant?.body.payees ?? []), ...(warrant?.body.clients ?? [])].find((party) => party.id === id)?.displayName ?? id ?? 'unknown'
    const proposalId = context.receiptId ?? context.proposalId
    if (proposalId) {
      const row = this.services.repo.proposal(proposalId)
      if (row) return `the receipt for a ${row.kind === 'charge' ? 'client charge' : row.kind === 'refund' ? 'refund' : 'contractor payout'} of ${new Intl.NumberFormat('en', { style: 'currency', currency: row.currency, minimumFractionDigits: 2 }).format(row.amount_cents / 100)} ${row.kind === 'charge' ? 'to bill' : 'for'} ${name(row.payee_id)}${row.job_id ? `, job ${row.job_id}` : ''}, which is ${row.phase.replaceAll('_', ' ')}`
    }
    if (context.dealId) {
      const deal = this.services.repo.deal(context.dealId)
      if (deal) return `the page for deal ${context.dealId} with ${name(deal.buyer_id)}${deal.job_id ? `, job ${deal.job_id}` : ''}, status ${deal.status}`
    }
    if (context.jobId && this.services.repo.proposalsForJob(context.jobId).length > 0) {
      const rows = this.services.repo.proposalsForJob(context.jobId)
      const charge = rows.find((row) => row.kind === 'charge')
      const contractors = [...new Set(rows.filter((row) => row.kind === 'payment').map((row) => name(row.payee_id)))]
      return `the page for job ${context.jobId}${charge ? ` (client ${name(charge.payee_id)})` : ''}${contractors.length ? `, contractors paid on it: ${contractors.join(', ')}` : ''}`
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
    const announce = (call: { phase: 'start' | 'call' | 'end'; id: string; tool: string; source: 'code' | 'model'; input?: unknown; ok?: boolean; ms?: number; note?: string; output?: unknown }) => live.publish({ type: 'agent', agent: 'reviewer', dealId, milestone, call, at: stamp() })

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
      else if (event.type === 'tool_end') announce({ phase: 'end', id: event.id, tool: event.tool, source: 'model', ok: event.ok, ms: event.ms, output: event.output })
    }
    let run: RunOutput
    let used = model
    try {
      ;({ output: run, model: used } = await this.withModels((chosen) => runAgent({ model: chosen, services: this.services, principal, runId, system, messages: [{ role: 'user', content: prompt }], asks: 1, maxSteps: 3, stopAfter: 'decide_delivery', toolChoice: 'required', timeoutMs: 45_000, onEvent }), { primary: model }))
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
    // Only clients the stand-in may speak for: one that set its own numbers and did not delegate reviews its own work.
    const mayAnswer = (dealId: string) => { const deal = this.services.repo.deal(dealId); return deal ? this.services.deals.agentMaySpeakFor('buyer', deal.buyer_id) : false }
    const waiting = this.services.repo.deliveriesFor(null, 50).filter((row) => row.status === 'awaiting' && Date.parse(row.created_at) <= cutoff && mayAnswer(row.deal_id)).slice(0, max)
    for (const row of waiting) await this.reviewDelivery(row.deal_id, row.milestone, OWNER).catch((error) => logReviewFailure(row.deal_id, row.milestone, error))
    return waiting.length
  }

  // ---------- the rules drafter ----------

  /** A draft of new rules from the owner's own words. It is a draft only: nothing is published, and the owner reads a diff first. */
  async draftRules(instruction: string, who: Principal, hooks: { onStage?: (stage: DraftStage) => void } = {}, options: { intent?: boolean } = {}) {
    const model = this.drafterModel ?? this.need()
    this.limit(who, 'drafter', 8)
    const live = this.services.repo.latestWarrant()
    // A studio with no rules yet is writing its first version: the draft is built on a blank sheet, and the model is
    // told it must set everything the rules need.
    const firstVersion = !live
    const warrant = live ?? { id: 'draft', version: 0, body: BLANK_WARRANT, createdAt: this.now().toISOString(), signatureJson: null }
    const runId = randomUUID()
    const stage = hooks.onStage ?? (() => undefined)
    let recorded = false
    try {
      const { output: draft, model: used } = await this.withModels((chosen) => draftRules({ model: chosen, current: warrant.body, instruction, onStage: stage, intent: options.intent, firstVersion }), { primary: model })
      this.record({ id: runId, agent: 'drafter', who, conversationId: runId, model: used.name, input: instruction, output: draft.summary, steps: [], status: 'ok', error: null, ms: draft.ms, prompt: 'drafter' })
      recorded = true
      // A worked example in the owner's own numbers: the biggest milestone on a signed deal, or $150.
      stage({ stage: 'replaying' })
      const exampleCents = Math.max(0, ...this.services.deals.readyToBill().map((item) => item.amountCents), 0) || 15_000
      const replay = this.services.mandate.replay(draft.draft)
      stage({ stage: 'reading_back' })
      // The read-back is written by the model from the exact facts, with every number checked before it is shown.
      // When the model cannot do that, the code-written lines stand in, so the owner always sees true lines.
      let readBackLines = readBack(draft.draft, exampleCents)
      let readBackBy: 'model' | 'code' = 'code'
      try {
        const explained = await explainRules({ model: used, draft: draft.draft, exampleCents })
        readBackLines = [...explained.lines, ...explained.notes.map((note) => `Worth knowing: ${note}`)]
        readBackBy = 'model'
        this.record({ id: randomUUID(), agent: 'rules_explainer', who, conversationId: runId, model: used.name, input: instruction.slice(0, 500), output: readBackLines.join(' ').slice(0, 500), steps: [], status: 'ok', error: null, ms: 0, prompt: 'rulesExplainer' })
      } catch {
        this.record({ id: randomUUID(), agent: 'rules_explainer', who, conversationId: runId, model: used.name, input: instruction.slice(0, 500), output: null, steps: [], status: 'error', error: 'fallback', ms: 0, prompt: 'rulesExplainer' })
      }
      let secondReader: SecondReaderResult | undefined
      if (this.flags?.secondReader) {
        const secondModel = this.fallbackModel ?? used
        stage({ stage: 'second_reading', model: secondModel.name })
        const { usage, ms, ...reading } = await secondReaderOpinion({ model: secondModel, instruction, current: warrant.body, draft: draft.draft })
        secondReader = reading
        if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) this.budget?.correct(usageTokens(usage.inputTokens), usageTokens(usage.outputTokens))
        this.record({
          id: randomUUID(),
          agent: 'second_reader',
          who,
          conversationId: runId,
          model: secondModel.name,
          input: instruction.slice(0, 500),
          output: JSON.stringify(secondReader),
          steps: [],
          status: reading.status === 'unavailable' ? 'error' : 'ok',
          error: reading.status === 'unavailable' ? 'unavailable' : null,
          ms,
          prompt: 'secondReader',
          usage,
        })
      }
      // The model's summary is shown last, after the code's list, because only the code can be trusted to be complete.
      // But it must not contradict the code either: a model that says the cap is "reduced" when it goes up is wrong,
      // and a wrong sentence about the rules is worse than none. When they disagree, the code's words stand in.
      const contradiction = summaryContradiction(draft.summary, [...draft.loosens, ...draft.tightens])
      const summary = contradiction ? codeSummary(draft.loosens, draft.tightens, draft.notes) : draft.summary
      const summaryBy: 'model' | 'code' = contradiction ? 'code' : 'model'
      return { ...draft, summary, summaryBy, runId, readBack: readBackLines, readBackBy, replay, ...(secondReader ? { secondReader } : {}) }
    } catch (error) {
      // The run is written once: if it was already written as a success, this is the same run failing later, and a
      // second row with the same id would hide what actually went wrong.
      if (!recorded) this.record({ id: runId, agent: 'drafter', who, conversationId: runId, model: model.name, input: instruction, output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0, prompt: 'drafter' })
      throw error
    }
  }

  /**
   * "Paste your policy." Three model stages and no word-matching:
   *   1. a reader says what KIND of sentence each one is (a rule, a matter of judgment, someone else's words...)
   *   2. the drafter drafts rules from the sentences that are rules, and only those
   *   3. an auditor reads the finished draft against the sentences and says, for each, whether it is carried out, citing
   *      the rules by key; and for each change in the draft, which sentence asked for it
   * Code cuts the text into numbered pieces and then only checks claims against what the model was shown: a cited rule
   * that does not exist, a quote that is not in the sentence, a sentence nobody answered for. A claim that points at
   * nothing is not believed. If the audit cannot run, the draft still comes back, marked as unchecked. Nothing is published.
   */
  async draftFromPolicy(text: string, who: Principal, hooks: { onStage?: (stage: DraftStage) => void; signal?: AbortSignal } = {}) {
    const model = this.drafterModel ?? this.need()
    this.limit(who, 'policy', 4)
    const warrant = this.services.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const stage = hooks.onStage ?? (() => undefined)
    const all = segmentPolicy(text)
    if (all.length === 0) throw new Problem(422, 'policy.empty', 'There is nothing to read', 'The text had no sentences in it.')
    const readable = all.slice(0, POLICY_MAX_SENTENCES)
    const current = warrant.body
    const runId = randomUUID()

    stage({ stage: 'reading_policy', sentences: readable.length, parts: Math.ceil(readable.length / READ_CHUNK) })
    let read: Read
    let reader: AgentModel
    try {
      ;({ output: read, model: reader } = await this.withModels((chosen) => readAll({ model: chosen, current, segments: readable, signal: hooks.signal, onRetry: (reason) => stage({ stage: 'retry', attempt: 1, reason }) }), { primary: model }))
    } catch (error) {
      this.record({ id: runId, agent: 'policy_reader', who, conversationId: runId, model: model.name, input: text.slice(0, 2000), output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0, prompt: 'policyReader' })
      throw error
    }
    this.record({ id: runId, agent: 'policy_reader', who, conversationId: runId, model: reader.name, input: text.slice(0, 2000), output: `${read.kinds.size} of ${readable.length} sentences classified`, steps: [], status: 'ok', error: null, ms: read.ms, prompt: 'policyReader', usage: read.usage })

    const kinds = new Map([...read.kinds].map(([id, value]) => [id, value.kind]))
    const { sent, skipped } = sendable(readable, kinds)
    stage({ stage: 'classified', rules: sent.length, setAside: readable.length - sent.length })
    const skippedIds = new Set([...skipped.map((item) => item.id), ...all.slice(POLICY_MAX_SENTENCES).map((item) => item.id)])

    const sentences = firstPass(all, read.kinds, skippedIds)
    const instruction = instructionFor(sent)
    if (!instruction) return { sentences, counts: countStatuses(sentences), audit: 'none' as const, draft: null }

    const drafted = await this.draftRules(instruction, who, hooks.onStage ? { onStage: hooks.onStage } : {}, { intent: false })
    stage({ stage: 'auditing', sentences: sent.length, changes: listChanges(current, drafted.draft).length })
    let audit: Audit | null = null
    const auditId = randomUUID()
    try {
      const done = await this.withModels((chosen) => auditPolicy({ model: chosen, current, draft: drafted.draft, sent, signal: hooks.signal, onRetry: (reason) => stage({ stage: 'retry', attempt: 1, reason }) }), { primary: model })
      audit = done.output
      this.record({ id: auditId, agent: 'policy_auditor', who, conversationId: runId, model: done.model.name, input: instruction, output: JSON.stringify({ sentences: audit.sentences.length, changes: audit.changes.length }), steps: [], status: 'ok', error: null, ms: audit.ms, prompt: 'policyAuditor', usage: audit.usage })
    } catch (error) {
      if (error instanceof Problem && error.code === 'agent.stopped') throw error
      this.record({ id: auditId, agent: 'policy_auditor', who, conversationId: runId, model: model.name, input: instruction, output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'error', ms: 0, prompt: 'policyAuditor' })
    }

    const added = applyAudit(sentences, sent, audit)
    const untrustedLines = sentences.filter((item) => item.status === 'untrusted').map((item) => item.text)
    return { sentences, counts: countStatuses(sentences), audit: audit ? ('ok' as const) : ('failed' as const), draft: { ...drafted, added, untrusted: untrustedLines } }
  }

  /**
   * One turn of the dashboard agent in the browser (AG Studio). The model only writes; the dashboard's own tools run in
   * the browser, against a copy of the ledger. Nothing here is handed a service, the ledger or PayPal.
   */
  async studioTurn(turn: StudioTurn, who: Principal, hooks: { onEvent: (event: StudioEvent) => void; signal?: AbortSignal }) {
    const model = this.need()
    this.limit(who, 'studio', 40)
    const { output: done, model: used } = await this.withModels((chosen) => runStudioTurn({ model: chosen, turn, signal: hooks.signal, onEvent: hooks.onEvent }), { primary: model })
    this.record({ id: randomUUID(), agent: 'studio', who, conversationId: randomUUID(), model: used.name, input: JSON.stringify(turn.input.slice(-1)[0] ?? {}).slice(0, 2000), output: JSON.stringify(done.output).slice(0, 4000), steps: [], status: 'ok', error: null, ms: done.ms, usage: { inputTokens: done.usage?.inputTokens, outputTokens: done.usage?.outputTokens } })
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
   * Runs a negotiation with Mandate's hosted negotiators, move by move, until it ends or a seat must be answered by
   * someone else. The orchestration is code: whose turn it is, what each side may see, the deadline. Each move is the
   * model's decision — counter, accept or walk away, and at what price — and the server holds only authority: the
   * walk-away, the turn order, the deadline and no taking back a concession. When the client speaks for itself (it
   * claimed its seat and did not delegate), the run stops at its turn and waits for it.
   */
  async negotiate(input: NegotiationInput, who: Principal, hooks: NegotiationHooks = {}) {
    const model = this.need()
    this.assertCanNegotiate(who)
    this.limit(who, 'negotiate', 3)
    const { deals, repo } = this.services
    const warrant = repo.latestWarrant()
    const existing = input.threadId ? repo.negotiation(input.threadId) : null
    if (input.threadId && !existing) throw new Problem(404, 'negotiation.missing', 'No such negotiation', 'No negotiation matches that id.')
    const buyer = warrant ? resolveClient(warrant.body, existing?.buyer_id ?? input.buyer ?? warrant.body.clients[0]?.id ?? '') : null
    if (!warrant || !buyer) throw new Problem(422, 'deal.buyer_unknown', 'Unknown buyer', 'That client is not on the warrant.')
    // The agents talk only inside numbers a person chose. Sample numbers nobody kept refuse the whole run up front.
    const { buyerRules, sellerRules } = deals.keptSheets(buyer.id)
    if (input.buyerBrief && !deals.agentMaySpeakFor('buyer', buyer.id) || input.buyerBrief && repo.sheetClaimed(buyer.id)) {
      throw new Problem(403, 'deal.seat_claimed', 'The client briefs its own negotiator', `${buyer.displayName} set its own numbers with its own key, so only it can instruct the agent that speaks for it.`)
    }
    const category = input.category ?? sellerRules.body.categories.find((item) => buyerRules.body.categories.includes(item)) ?? sellerRules.body.categories[0]!
    const perSide = input.offersPerSide ?? (input.maxOffers ? Math.ceil(input.maxOffers / 2) : DEFAULT_OFFERS_PER_SIDE)
    const thread = existing ?? deals.openNegotiation({
      buyerId: buyer.id,
      scope: input.task?.slice(0, 300) || `${category} work for ${buyer.displayName}`,
      category,
      currency: sellerRules.body.currency,
      milestones: input.milestones ?? ['Milestone 1', 'Milestone 2'],
      offersPerSide: perSide,
    }, who)
    if (thread.status !== 'open') throw new Problem(409, 'negotiation.ended', 'This negotiation has ended', `It ended: ${endingWords(thread)}.`)
    const emit = async (event: NegotiationEvent) => { await hooks.onEvent?.(event) }
    const studioName = sellerRules.body.displayName
    const sees = (side: Side) => deals.canSee(who, side, buyer.id)
    await emit({ type: 'start', threadId: thread.id, model: model.name, maxOffers: thread.offers_per_side * 2, offersPerSide: thread.offers_per_side, studio: studioName, client: buyer.displayName, scope: thread.scope, currency: thread.currency, seats: { seller: 'agent', buyer: deals.agentMaySpeakFor('buyer', buyer.id) ? 'agent' : 'client' } })

    const turns: Array<Record<string, unknown>> = []
    let stopped = false
    let failed: string | null = null
    for (let turn = 1; turn <= thread.offers_per_side * 2 + 1; turn += 1) {
      if (hooks.signal?.aborted) { stopped = true; break }
      const state = deals.negotiationView(thread.id, OWNER)
      if (state.status !== 'open') break
      const side: Side = state.turn ?? 'seller'
      const company = side === 'seller' ? studioName : buyer.displayName
      if (!deals.agentMaySpeakFor(side, buyer.id)) {
        await emit({ type: 'waiting', side, company })
        break
      }
      await emit({ type: 'turn_start', turn, side, company })
      const briefs = { seller: input.sellerBrief, buyer: input.buyerBrief }
      const moved = await this.hostedMove(thread.id, side, { brief: briefs[side], who, signal: hooks.signal, model, watcherSees: sees(side), onTool: (event) => void emit({ ...event, turn, side }) })
      if (moved.error) {
        if (hooks.signal?.aborted) { stopped = true; break }
        turns.push({ turn, side, runId: moved.runId, error: moved.error })
        await emit({ type: 'turn_error', turn, side, runId: moved.runId, error: moved.error, detail: moved.detail })
        failed = moved.error
        break
      }
      turns.push({ turn, side, runId: moved.runId, action: moved.action, deal: moved.deal, ms: moved.ms })
      await emit({ type: 'turn', turn, side, runId: moved.runId, ms: moved.ms ?? 0, action: moved.action!, deal: moved.deal, message: moved.message ?? null, final: moved.final ?? false, assessment: sees(side) ? moved.assessment ?? null : null, by: 'agent' })
    }

    let view = deals.negotiationView(thread.id, who)
    if (view.status !== 'open') {
      await this.debriefAll(thread.id, hooks.signal, async (side, debrief) => { if (sees(side)) await emit({ type: 'debrief', side, debrief }) })
      view = deals.negotiationView(thread.id, who)
    }
    const agreed = view.status === 'agreed'
    await emit({ type: 'done', threadId: thread.id, agreed, dealId: view.agreedDealId, stopped, status: view.status, ending: view.ending, failed, negotiation: view })
    return { threadId: thread.id, model: model.name, agreed, dealId: view.agreedDealId, status: view.status, ending: view.ending, turns, negotiation: view }
  }

  /**
   * One move by the hosted negotiator for one seat, outside a full run: a client that delegated can let its agent
   * answer, and the owner can let the studio's agent answer, one move at a time.
   */
  async agentMove(threadId: string, who: Principal) {
    const model = this.need()
    this.limit(who, 'negotiate-move', 6)
    const { deals } = this.services
    const view = deals.negotiationView(threadId, who)
    if (view.status !== 'open') throw new Problem(409, 'negotiation.ended', 'This negotiation has ended', `It ended: ${view.ending}.`)
    const side: Side = view.turn ?? 'seller'
    if (!deals.agentMaySpeakFor(side, view.buyerId)) throw new Problem(403, 'deal.seat_claimed', 'The client speaks for itself', 'This client set its own numbers and did not let Mandate\'s agent speak for it.')
    if (!view.you.sides.includes(side) && !(who.role === 'owner' && deals.agentMaySpeakFor(side, view.buyerId))) {
      throw new Problem(409, 'negotiation.not_your_turn', 'It is not your turn', 'The other side has the move.')
    }
    const moved = await this.hostedMove(threadId, side, { who, model, watcherSees: deals.canSee(who, side, view.buyerId) })
    if (moved.error) throw new Problem(422, moved.error, 'The negotiator did not make a move', moved.detail ?? 'The model did not make a valid move. Nothing was agreed.')
    if (deals.negotiationView(threadId, OWNER).status !== 'open') await this.debriefAll(threadId)
    return deals.negotiationView(threadId, who)
  }

  /**
   * One model-made move. The model is given its mandate in the system prompt and the table in the user message, and
   * the three move tools only (least privilege). A move the server refuses (past the walk-away, a taken-back
   * concession, out of turn) comes back to the model as the tool's error and it may correct itself within the run.
   * If it still makes no valid move, the move fails and is reported: code never moves on the model's behalf.
   */
  private async hostedMove(threadId: string, side: Side, options: { brief?: string; who: Principal; model: AgentModel; signal?: AbortSignal; watcherSees: boolean; onTool?: (event: Extract<NegotiationEvent, { type: 'turn_tool' }> extends infer E ? Omit<E & { type: 'turn_tool' }, 'turn' | 'side'> : never) => void }) {
    const { deals, repo } = this.services
    const thread = repo.negotiation(threadId)!
    const principal = side === 'seller' ? STUDIO : buyerPrincipal(thread.buyer_id)
    const sheet = repo.partyRules(side === 'seller' ? WARRANT_ID : thread.buyer_id)!
    const seat = seatOf(sheet.body)
    const view = deals.negotiationView(threadId, principal)
    const own = view.seats[side]
    const counterparty = side === 'seller' ? view.buyerName : view.sellerName
    const company = side === 'seller' ? view.sellerName : view.buyerName
    const system = negotiatorSystem({
      side, company, counterparty, scope: thread.scope, milestones: view.milestones, currency: thread.currency, rules: sheet.body,
      reservationCents: seat.reservationCents, targetCents: seat.targetCents, targetChosen: seat.targetChosen, style: seat.style,
      brief: (options.brief ?? sheet.body.brief)?.slice(0, 600), offersPerSide: thread.offers_per_side,
    })
    const advice = own.visible ? own.advice : null
    const prompt = negotiatorTurn({
      threadId, buyer: view.buyerName, company, counterparty, side, currency: thread.currency, offersPerSide: thread.offers_per_side,
      myOffersLeft: own.visible ? own.offersLeft : 0,
      moves: view.moves.map((move) => ({ seq: move.seq, side: move.side, action: move.action, totalCents: move.totalCents, final: move.final, message: move.message, myAssessment: move.side === side ? move.assessment : null })),
      standing: view.standing && view.standing.dealId && view.standing.totalCents !== null ? { dealId: view.standing.dealId, totalCents: view.standing.totalCents, final: view.standing.final } : null,
      mayAccept: advice?.mayAccept ?? false,
      reference: advice ? { action: advice.action, offerCents: advice.offerCents, why: advice.why } : null,
    })
    const runId = randomUUID()
    // A seat the watcher may not see is spoken for in private: its tool calls reach the screen as public moves only.
    const onEvent = (event: AgentEvent) => {
      if (!options.onTool) return
      if (event.type === 'tool_start') options.onTool({ type: 'turn_tool', phase: 'start', id: event.id, tool: event.tool })
      else if (event.type === 'tool_call') options.onTool({ type: 'turn_tool', phase: 'call', id: event.id, tool: event.tool, input: options.watcherSees ? event.input : publicMove(event.input) })
      else if (event.type === 'tool_end') options.onTool({ type: 'turn_tool', phase: 'end', id: event.id, tool: event.tool, ok: event.ok, ms: event.ms, output: options.watcherSees ? event.output : publicResult(event.output) })
    }
    let run!: RunOutput
    let used = options.model
    // A model that answers in words instead of moving is told so and asked again, at most twice, with the exact calls
    // it can make: the standard repair for a missed tool call. Nothing reached the table on a words-only try, so a
    // retry cannot make a move twice, and code never moves on the model's behalf.
    const attempt = (content: string) => this.withModels((chosen) => runAgent({
      model: chosen, services: this.services, principal, runId, system, messages: [{ role: 'user', content }],
      onlyTools: ['offer_deal', 'accept_offer', 'walk_away'], asks: 3, maxSteps: 4, stopAfter: ['offer_deal', 'accept_offer', 'walk_away'],
      toolChoice: 'required', timeoutMs: 90_000, signal: options.signal, onEvent, dealClientId: thread.buyer_id, temperature: null, reasoning: reasoning(chosen, 'medium'),
    }), { primary: options.model, retrySame: true })
    const standing = view.standing && view.standing.side !== side && view.standing.dealId ? view.standing : null
    const repair = [
      'Your last answer was in words only, so nothing happened at the table. Words alone do nothing: make your move now with exactly one call.',
      ...(standing && advice?.mayAccept ? [`- To take their offer of ${price(standing.totalCents ?? 0, thread.currency)}: accept_offer with dealId "${standing.dealId}".`] : []),
      ...(own.visible && own.offersLeft > 0 ? [`- To make an offer: offer_deal with threadId "${threadId}" and your totalCents.`] : []),
      `- To end it: walk_away with threadId "${threadId}".`,
    ].join('\n')
    try {
      let tries = 0
      for (;;) {
        try {
          ;({ output: run, model: used } = await attempt(tries === 0 ? prompt : `${prompt}\n\n${repair}`))
          break
        } catch (error) {
          if (!(error instanceof Problem && error.code === 'agent.no_tool_call') || options.signal?.aborted || tries >= 2) throw error
          tries += 1
        }
      }
    } catch (error) {
      const code = error instanceof Problem ? (error.code === 'agent.no_tool_call' ? 'no_move' : error.code) : 'agent.model_error'
      this.record({ id: runId, agent: `negotiator:${side}`, who: options.who, conversationId: threadId, model: options.model.name, input: options.watcherSees ? prompt : sealedNote(company), output: null, steps: [], status: 'error', error: code, ms: 0, prompt: 'negotiator' })
      return { runId, error: code, detail: error instanceof Problem ? error.detail : null }
    }
    const moves = run.outcomes.filter((item) => ['offer_deal', 'accept_offer', 'walk_away'].includes(item.tool))
    const made = moves.find((item) => item.ok)
    // The error worth reporting is the server's answer to the model's move, not the budget that ran out after it.
    const lastError = [...moves].reverse().find((item) => !item.ok && (item.data.error as { code?: string } | undefined)?.code !== 'budget.exceeded') ?? [...moves].reverse().find((item) => !item.ok)
    const steps = options.watcherSees ? run.steps : run.steps.map((step) => ({ text: '', toolCalls: step.toolCalls.map((call) => ({ tool: call.tool, input: publicMove(call.input) })), toolResults: step.toolResults.map((item) => ({ tool: item.tool, ok: item.ok, output: publicResult(item.output) })) }))
    this.record({ id: runId, agent: `negotiator:${side}`, who: options.who, conversationId: threadId, model: used.name, input: options.watcherSees ? prompt : sealedNote(company), output: made ? JSON.stringify(options.watcherSees ? made.data : publicResult(made.data)) : (options.watcherSees ? run.text : null), steps, status: made ? 'ok' : 'error', error: made ? null : 'no_move', ms: run.ms, prompt: 'negotiator', usage: run.usage, turns: run.turns })
    if (!made) {
      const error = (lastError?.data.error ?? {}) as { code?: string; message?: string }
      return { runId, error: error.code ?? 'no_move', detail: error.message ?? 'The model did not make a move.' }
    }
    const call = run.steps.flatMap((step) => step.toolCalls).filter((item) => item.tool === made.tool).at(-1)?.input as { prompt?: string; assessment?: string; final?: boolean } | undefined
    const action = made.tool === 'offer_deal' ? 'offer' as const : made.tool === 'accept_offer' ? 'accept' as const : 'walk_away' as const
    const dealId = typeof made.data.dealId === 'string' ? made.data.dealId : null
    return {
      runId,
      ms: run.ms,
      action,
      deal: dealId ? deals.get(dealId, options.who) : null,
      // What the other side reads is the server's scrubbed copy, never the model's raw words.
      message: deals.negotiationView(threadId, OWNER).moves.at(-1)?.message ?? null,
      final: call?.final === true,
      assessment: call?.assessment ?? null,
      error: null as string | null,
      detail: null as string | null,
    }
  }

  /** After the end: each side Mandate's agent spoke for writes its company a debrief. A failure leaves that side without one. */
  private async debriefAll(threadId: string, signal?: AbortSignal, told?: (side: Side, debrief: unknown) => Promise<void>) {
    const { repo } = this.services
    const thread = repo.negotiation(threadId)
    if (!thread || thread.status === 'open') return
    const spokeFor = new Set(repo.moves(threadId).filter((move) => move.by === 'agent').map((move) => move.side))
    for (const side of spokeFor) {
      if (signal?.aborted) return
      const done = thread.debrief_json ? (JSON.parse(thread.debrief_json) as Record<string, unknown>)[side] : undefined
      if (done) continue
      // A debrief changes nothing, so a failed one is simply asked for again, once; a second failure is recorded.
      const debrief = await this.debrief(threadId, side, signal)
        .catch(() => (signal?.aborted ? null : this.debrief(threadId, side, signal)))
        .catch((error: unknown) => {
          const who = side === 'seller' ? STUDIO : buyerPrincipal(thread.buyer_id)
          this.record({ id: randomUUID(), agent: `debrief:${side}`, who, conversationId: threadId, model: this.model?.name ?? 'unknown', input: '', output: null, steps: [], status: 'error', error: error instanceof Problem ? error.code : 'agent.model_error', ms: 0, prompt: 'debrief' })
          return null
        })
      if (debrief) {
        repo.saveDebrief(threadId, side, debrief)
        await told?.(side, debrief)
      }
    }
  }

  /**
   * One side's debrief. Code works out the facts (price, margin over the walk-away, progress towards the target, the
   * moves); the model judges. Every amount in its words must be one of the facts' amounts, or it is sent back.
   */
  private async debrief(threadId: string, side: Side, signal?: AbortSignal) {
    const { deals } = this.services
    const principal = side === 'seller' ? STUDIO : buyerPrincipal(this.services.repo.negotiation(threadId)!.buyer_id)
    const view = deals.negotiationView(threadId, principal)
    const seat = view.seats[side]
    if (!seat.visible) return null
    const company = side === 'seller' ? view.sellerName : view.buyerName
    const counterparty = side === 'seller' ? view.buyerName : view.sellerName
    const c = view.currency
    const facts = [
      `How it ended: ${view.ending}.`,
      `Your walk-away was ${price(seat.reservationCents, c)}; your target was ${price(seat.targetCents, c)}${seat.targetChosen ? '' : ' (assumed: no target was set)'}; your style was ${seat.style}.`,
      seat.outcome ? `The result for you: ${seat.outcome.summary}` : 'There was no deal.',
      `Moves (${view.moves.length}, deadline ${view.offersPerSide} offers each):`,
      ...view.moves.map((move) => `${move.seq}. ${move.side === side ? 'You' : counterparty} ${move.action === 'offer' ? `offered ${price(move.totalCents ?? 0, c)}${move.final ? ' (final)' : ''}` : move.action === 'accept' ? `accepted ${price(move.totalCents ?? 0, c)}` : 'walked away'}${move.message ? (move.side === side ? `, saying "${move.message}"` : `, saying ${untrusted('counterparty_message', move.message, 300)}`) : ''}`),
      ...movedBy(view.moves, side, seat.reservationCents, view.offersPerSide, c),
    ]
    const allowed = facts.join('\n')
    const made = await this.withModels((chosen) => callTool({
      model: chosen,
      system: debriefSystem({ company, counterparty, side }),
      user: `FACTS (worked out by the system):\n${allowed}\n\nWrite the debrief with the debrief tool.`,
      name: 'debrief',
      description: 'Your debrief for your own company.',
      reasoning: reasoning(chosen, 'medium'),
      schema: DebriefSchema,
      signal,
      validate: (value) => {
        const invented = unsupportedAmounts(`${value.summary} ${value.lesson}`, [allowed])
        if (invented.length > 0) return `you mentioned ${invented.join(', ')}, which is not an amount in the facts. Use only the amounts given.`
        // The one direction error live runs kept making: an opening closer to your walk-away leaves you LESS room.
        if (/\b(open|opening|start|starting|anchor)\w*\b[^.]*\bcloser to (?:(?:your|our|the) )?walk[\s\u2011-]?away/i.test(value.lesson)) {
          return 'your lesson says to open closer to the walk-away. That leaves less room to concede, so it can only make the price worse for your company. Find the lesson in the concessions and the timing instead.'
        }
        return null
      },
    }).then((result) => ({ ...result, ms: result.ms })), { retrySame: true })
    // Fail closed: a debrief that still breaks a check after its last try is not shown. No debrief beats a wrong one.
    if (made.output.leftover) throw new Problem(422, 'agent.no_answer', 'The debrief did not pass its checks', made.output.leftover)
    this.record({ id: randomUUID(), agent: `debrief:${side}`, who: principal, conversationId: threadId, model: made.model.name, input: allowed, output: JSON.stringify(made.output.value), steps: [], status: 'ok', error: null, ms: made.output.ms, prompt: 'debrief', usage: made.output.usage })
    return { ...made.output.value, model: made.model.name, at: this.now().toISOString() }
  }

  /** Checks that fail fast with a normal error, before a stream is opened. */
  assertCanNegotiate(who: Principal): void {
    this.need()
    if (who.role !== 'owner') throw new Problem(403, 'auth.forbidden', 'Owner key required', 'Only the owner starts a negotiation.')
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
      if (event.ok && paidPhase(data.phase as string)) moved = true
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

/**
 * How each side moved, worked out by code so the debrief reasons from correct arithmetic: each side's opening and how
 * far it sat from the walk-away, every concession on both sides, and how many offers were left at the end.
 */
export function movedBy(moves: Array<{ side: Side; action: string; totalCents: number | null }>, side: Side, reservationCents: number, offersPerSide: number, currency: string): string[] {
  const offersOf = (who: Side) => moves.filter((move) => move.side === who && move.action === 'offer' && move.totalCents !== null).map((move) => move.totalCents!)
  const conceded = (offers: number[], who: Side) => {
    const steps = offers.slice(1).map((value, i) => Math.abs(value - offers[i]!))
    const accepted = moves.find((move) => move.side === who && move.action === 'accept')
    const last = offers[offers.length - 1]
    if (accepted?.totalCents != null && last !== undefined && accepted.totalCents !== last) steps.push(Math.abs(accepted.totalCents - last))
    return steps
  }
  const words = (steps: number[]) => (steps.length ? `${steps.map((step) => price(step, currency)).join(', ')} (in all ${price(steps.reduce((sum, step) => sum + step, 0), currency)})` : 'none')
  const other: Side = side === 'seller' ? 'buyer' : 'seller'
  const mine = offersOf(side)
  const theirs = offersOf(other)
  const lines = ['How the moves went (worked out by the system):']
  if (mine.length) lines.push(`- Your opening was ${price(mine[0]!, currency)}, ${price(Math.abs(mine[0]! - reservationCents), currency)} ${side === 'seller' ? 'above' : 'below'} your walk-away.`)
  if (theirs.length) lines.push(`- Their opening was ${price(theirs[0]!, currency)}.`)
  lines.push(`- Your concessions, in order: ${words(conceded(mine, side))}.`)
  lines.push(`- Their concessions, in order: ${words(conceded(theirs, other))}.`)
  lines.push(`- Offers you had left at the end: ${Math.max(0, offersPerSide - mine.length)} of ${offersPerSide}.`)
  return lines
}
