import { createMCPClient } from '@ai-sdk/mcp'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { generateText, hasToolCall, stepCountIs, type ModelMessage } from 'ai'
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
}

export type RunOutput = {
  text: string
  /** The answers of propose and offer_deal, straight from the rules. These are the facts of the run. */
  outcomes: Outcome[]
  steps: TraceStep[]
  finishReason: string
  usage: { inputTokens: number | undefined; outputTokens: number | undefined }
  ms: number
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
    const result = await generateText({
      model: input.model.model,
      system: input.system,
      messages: input.messages,
      tools,
      temperature: 0,
      maxRetries: 2,
      abortSignal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? 60_000)]) : AbortSignal.timeout(input.timeoutMs ?? 60_000),
      stopWhen: input.stopAfter ? [stepCountIs(input.maxSteps ?? 8), hasToolCall(input.stopAfter)] : stepCountIs(input.maxSteps ?? 8),
    })
    const steps: TraceStep[] = result.steps.map((step) => ({
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
      text: result.text,
      outcomes,
      steps,
      finishReason: String(result.finishReason),
      usage: { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens },
      ms: Date.now() - started,
    }
  } catch (error) {
    const name = (error as Error)?.name ?? ''
    if (input.signal?.aborted) throw new Problem(499, 'agent.stopped', 'Stopped', 'The run was stopped before it finished. Nothing was sent to PayPal.')
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Problem(504, 'agent.timeout', 'The agent took too long', 'The model did not finish in time. Nothing was sent to PayPal.')
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
