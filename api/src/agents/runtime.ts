import { createMCPClient } from '@ai-sdk/mcp'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { hasToolCall, stepCountIs, streamText, type ModelMessage } from 'ai'
import { createMandateMcpServer } from '../mcp/server'
import { Problem } from '../http/problem'
import type { Services } from '../services/container'
import type { Principal } from '../services/principal'
import type { Outcome } from './guard'
import type { AgentModel } from './model'

export type TraceStep = {
  text: string
  toolCalls: Array<{ tool: string; input: unknown }>
  toolResults: Array<{ tool: string; ok: boolean; output: unknown }>
}

/**
 * What a screen is told while a run is happening. Text arrives as the model writes it; a tool call is announced as
 * the model starts it, again with its arguments, and once more with the rules' answer and how long it took.
 */
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; tool: string }
  | { type: 'tool_call'; id: string; tool: string; input: unknown }
  | { type: 'tool_end'; id: string; tool: string; ok: boolean; output: unknown; ms: number }

export type RunInput = {
  model: AgentModel
  services: Services
  principal: Principal
  runId: string
  system: string
  messages: ModelMessage[]
  /** Model turns before the run is cut off. */
  maxSteps?: number
  /** Requests the agent may make through propose and offer_deal in this run. */
  asks?: number
  timeoutMs?: number
  /** End the run as soon as this tool has been called, instead of waiting for the model to summarise. */
  stopAfter?: string
  /** The person's words. Lets the door check that a request names who the person named. */
  requestText?: string
  /** Cancels the model call, for a person who pressed Stop. */
  signal?: AbortSignal
  /** Told as each model step finishes, so a screen can show the rules' answer before the model's words. */
  onStep?: (step: TraceStep) => void
  /** Told as the run happens: text as it is written, and each tool call as it starts and ends. */
  onEvent?: (event: AgentEvent) => void
  /** `required` makes the model call a tool on its first turn. Right for agents whose only job is one decision. */
  toolChoice?: 'auto' | 'required'
}

export type RunOutput = {
  text: string
  /** The answers of propose and offer_deal, straight from the rules. These are the facts of the run. */
  outcomes: Outcome[]
  steps: TraceStep[]
  finishReason: string
  usage: { inputTokens: number | undefined; outputTokens: number | undefined }
  ms: number
  /** Model turns taken. */
  turns: number
}

const WRITE_TOOLS = new Set(['propose', 'offer_deal'])

/**
 * One agent run, end to end.
 *
 * The model reaches Mandate only through the MCP server, over an in-process MCP connection, so an agent here has
 * exactly the powers an outside agent would have and nothing more. The run is bounded three ways (steps, asks,
 * wall-clock), temperature is 0 so a given message gets a repeatable answer, and the result keeps a full trace
 * so that "what did the agent do?" always has an answer.
 */
export async function runAgent(input: RunInput): Promise<RunOutput> {
  const started = Date.now()
  const server = createMandateMcpServer({ services: input.services, principal: input.principal, runId: input.runId, budget: { asks: input.asks ?? 3 }, requestText: input.requestText })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const mcp = await createMCPClient({ transport: clientSide as never })
  try {
    const tools = await mcp.tools()
    let emitted = false
    const emit = (event: AgentEvent) => { emitted = true; input.onEvent?.(event) }
    const called = new Map<string, number>()
    const once = async () => {
      const result = streamText({
        model: input.model.model,
        system: input.system,
        messages: input.messages,
        tools,
        toolChoice: input.toolChoice ?? 'auto',
        temperature: 0,
        maxRetries: 2,
        abortSignal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? 60_000)]) : AbortSignal.timeout(input.timeoutMs ?? 60_000),
        onError: () => undefined,
        onStepFinish: input.onStep ? (step) => input.onStep!({
          text: step.text,
          toolCalls: step.toolCalls.map((call) => ({ tool: call.toolName, input: call.input })),
          toolResults: step.toolResults.map((item) => { const unpacked = unpack(item.output); return { tool: item.toolName, ok: unpacked.ok, output: unpacked.data } }),
        }) : undefined,
        stopWhen: input.stopAfter ? [stepCountIs(input.maxSteps ?? 8), hasToolCall(input.stopAfter)] : stepCountIs(input.maxSteps ?? 8),
      })
      // Read the stream to the end. A failure arrives as an `error` part, not as an exception, so it is kept and thrown after.
      let streamError: unknown = null
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            if (part.text) emit({ type: 'text', delta: part.text })
            break
          case 'tool-input-start':
            emit({ type: 'tool_start', id: part.id, tool: part.toolName })
            break
          case 'tool-call':
            called.set(part.toolCallId, Date.now())
            emit({ type: 'tool_call', id: part.toolCallId, tool: part.toolName, input: part.input })
            break
          case 'tool-result': {
            const unpacked = unpack(part.output)
            emit({ type: 'tool_end', id: part.toolCallId, tool: part.toolName, ok: unpacked.ok, output: unpacked.data, ms: Date.now() - (called.get(part.toolCallId) ?? started) })
            break
          }
          case 'tool-error':
            emit({ type: 'tool_end', id: part.toolCallId, tool: part.toolName, ok: false, output: { error: { code: 'tool_error', message: 'The tool failed.' } }, ms: Date.now() - (called.get(part.toolCallId) ?? started) })
            break
          case 'error':
            streamError = part.error
            break
          default:
            break
        }
      }
      if (streamError) throw streamError
      return { steps: await result.steps, text: await result.text, finishReason: await result.finishReason, usage: await result.totalUsage }
    }
    // A provider sometimes fails as the stream opens ("the server had an error"). Nothing has happened yet in that case,
    // so the same call is made again, up to twice, after a short pause. Once anything has been shown or any tool has
    // run, a failure is reported instead, because repeating it could repeat a request.
    let resolved!: Awaited<ReturnType<typeof once>>
    for (let attempt = 1; ; attempt += 1) {
      try {
        resolved = await once()
        break
      } catch (error) {
        if (attempt < 3 && !emitted && called.size === 0 && isTransient(error) && !input.signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt + Math.random() * 250))
          continue
        }
        throw error
      }
    }
    const steps: TraceStep[] = resolved.steps.map((step) => ({
      text: step.text,
      toolCalls: step.toolCalls.map((call) => ({ tool: call.toolName, input: call.input })),
      toolResults: step.toolResults.map((item) => {
        const unpacked = unpack(item.output)
        return { tool: item.toolName, ok: unpacked.ok, output: unpacked.data }
      }),
    }))
    const outcomes: Outcome[] = steps.flatMap((step) => step.toolResults)
      .filter((item) => WRITE_TOOLS.has(item.tool))
      .map((item) => ({ tool: item.tool, ok: item.ok, data: (item.output ?? {}) as Record<string, unknown> }))
    return {
      text: resolved.text,
      outcomes,
      steps,
      finishReason: String(resolved.finishReason),
      usage: { inputTokens: resolved.usage?.inputTokens, outputTokens: resolved.usage?.outputTokens },
      ms: Date.now() - started,
      turns: resolved.steps.length,
    }
  } catch (error) {
    if (process.env.AGENT_DEBUG) process.stderr.write(`AGENT_DEBUG ${String((error as Error)?.stack ?? error)}\n`)
    const name = (error as Error)?.name ?? ''
    // The SDK itself enforces `toolChoice: required`: a model that answers in words instead of calling the tool is a
    // distinct, named outcome, not a crash.
    if (name === 'AI_ToolChoiceViolationError' || /tool choice was required/i.test((error as Error)?.message ?? '')) {
      throw new Problem(422, 'agent.no_tool_call', 'The agent did not act', 'The model answered in words instead of making the one call it was asked to make. Nothing was sent to PayPal.')
    }
    // The SDK itself enforces `toolChoice: required`: a model that answers in words instead of calling the tool is a
    // distinct, named outcome, not a crash.
    if (name === 'AI_ToolChoiceViolationError' || /tool choice was required/i.test((error as Error)?.message ?? '')) {
      throw new Problem(422, 'agent.no_tool_call', 'The agent did not act', 'The model answered in words instead of making the one call it was asked to make. Nothing was sent to PayPal.')
    }
    if (input.signal?.aborted) throw new Problem(499, 'agent.stopped', 'Stopped', 'The run was stopped before it finished. Nothing was sent to PayPal.')
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Problem(504, 'agent.timeout', 'The agent took too long', 'The model did not finish in time. Nothing was sent to PayPal.')
    }
    if ((error as { statusCode?: number })?.statusCode === 429) {
      throw new Problem(429, 'agent.rate_limited', 'The model is busy', 'The language model is rate limiting us. Nothing was sent to PayPal. Try again in a moment.')
    }
    throw new Problem(502, 'agent.model_error', 'The model could not be reached', 'The language model failed. Nothing was sent to PayPal. Try again.')
  } finally {
    await mcp.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
}

/** An MCP tool result, as the AI SDK hands it back, reduced to "did it work" and the structured answer. */
function unpack(output: unknown): { ok: boolean; data: Record<string, unknown> } {
  const result = (output ?? {}) as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> }
  const ok = result.isError !== true
  if (result.structuredContent) return { ok, data: result.structuredContent }
  const text = result.content?.find((part) => part.type === 'text')?.text
  if (text) {
    try {
      return { ok, data: JSON.parse(text) as Record<string, unknown> }
    } catch {
      return { ok, data: { text } }
    }
  }
  return { ok, data: {} }
}

/** A failure of the provider itself, not of the request: a 5xx as the stream opens, a dropped connection. Worth one more try. */
function isTransient(error: unknown): boolean {
  const e = error as { name?: string; statusCode?: number; isRetryable?: boolean; message?: string } | null
  if (!e) return false
  if (e.name === 'AI_StreamProviderError' || /server had an error|overloaded|temporarily unavailable|ECONNRESET|socket hang up/i.test(e.message ?? '')) return true
  if (typeof e.statusCode === 'number') return e.statusCode >= 500 || e.statusCode === 429
  return e.isRetryable === true
}
