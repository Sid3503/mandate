import { jsonSchema, streamText, tool, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import { Problem } from '../http/problem'
import type { AgentModel } from './model'

/**
 * One turn of the AG Studio dashboard agent, run on Mandate's own model.
 *
 * AG Studio's agent framework lives in the browser and runs the loop itself: it keeps the conversation, decides what
 * to do with each tool call and executes the tools against the dashboard. The one thing it needs from a server is a
 * model, so this is only that: it is handed the conversation, the instructions and the TOOL SCHEMAS Studio advertises,
 * and it returns what the model said and which tools it wants called. It never runs a tool.
 *
 * It is deliberately the smallest thing it could be. It takes a model and a request and nothing else: no services, no
 * ledger, no PayPal client, no MCP server. A compromised or fooled model can therefore do exactly one thing here,
 * which is ask the dashboard to show something differently. The data it reads is a copy of the ledger that the person
 * already has in their browser.
 */

const Item = z.object({ type: z.string().max(40) }).passthrough()
const Tool = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  description: z.string().max(4_000),
  parameters: z.record(z.string(), z.unknown()),
})

export const StudioTurnSchema = z.object({
  input: z.array(Item).max(400),
  instructions: z.string().max(40_000).optional(),
  tools: z.array(Tool).max(48).optional(),
  toolChoice: z.union([z.enum(['auto', 'none', 'required']), z.object({ name: z.string().max(64) })]).optional(),
})
export type StudioTurn = z.infer<typeof StudioTurnSchema>

/** What goes back to the browser, in AG-UI's event vocabulary, which is what Studio's agent framework reads. */
export type StudioEvent =
  | { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; messageId: string }
  | { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string }
  | { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string }
  | { type: 'TOOL_CALL_END'; toolCallId: string }

export type StudioResponse = {
  id: string
  createdAt: number
  status: 'completed' | 'incomplete'
  output: Array<Record<string, unknown>>
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  model: string
}

type Loose = Record<string, any>

/** Studio's conversation items, as the model's messages. Reasoning items are dropped: they are not part of the next request. */
export function toMessages(items: Loose[]): ModelMessage[] {
  const out: ModelMessage[] = []
  const names = new Map<string, string>()
  const assistant = (): Extract<ModelMessage, { role: 'assistant' }> => {
    const last = out[out.length - 1]
    if (last && last.role === 'assistant' && Array.isArray(last.content)) return last as Extract<ModelMessage, { role: 'assistant' }>
    const fresh: Extract<ModelMessage, { role: 'assistant' }> = { role: 'assistant', content: [] }
    out.push(fresh)
    return fresh
  }
  const result = (callId: string, output: string) => {
    out.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: names.get(callId) ?? 'tool', output: { type: 'text', value: output } }] })
  }
  for (const item of items) {
    if (item.type === 'message' && (item.role === 'user' || item.role === 'system')) {
      const text = (Array.isArray(item.content) ? item.content : []).map((part: Loose) => (part?.type === 'text' ? String(part.text ?? '') : '')).join('')
      out.push({ role: item.role, content: text })
    } else if (item.type === 'message' && item.role === 'assistant') {
      const text = (Array.isArray(item.content) ? item.content : []).map((part: Loose) => (part?.type === 'text' ? String(part.text ?? '') : '')).join('')
      if (text) (assistant().content as Array<Loose>).push({ type: 'text', text })
    } else if (item.type === 'function_call') {
      const callId = String(item.callId)
      names.set(callId, String(item.name))
      let input: unknown = {}
      try {
        input = JSON.parse(String(item.arguments || '{}'))
      } catch {
        input = {}
      }
      ;(assistant().content as Array<Loose>).push({ type: 'tool-call', toolCallId: callId, toolName: String(item.name), input })
      if (typeof item.result === 'string') result(callId, item.result)
    } else if (item.type === 'function_call_output') {
      result(String(item.callId), String(item.output ?? ''))
    }
  }
  return out
}

/**
 * Runs one turn. `onEvent` is told each piece as the model writes it. Resolves with the finished turn.
 * Throws a Problem the same way the rest of the AI layer does, and says whether anything was already sent.
 */
export async function runStudioTurn(input: { model: AgentModel; turn: StudioTurn; signal?: AbortSignal; onEvent: (event: StudioEvent) => void; timeoutMs?: number }): Promise<StudioResponse & { emitted: boolean; ms: number }> {
  const { turn } = input
  const tools: ToolSet = {}
  for (const item of turn.tools ?? []) tools[item.name] = tool({ description: item.description, inputSchema: jsonSchema(item.parameters as never) })
  const hasTools = Object.keys(tools).length > 0
  const choice = turn.toolChoice
  let emitted = false
  const send = (event: StudioEvent) => { emitted = true; input.onEvent(event) }
  const started = Date.now()
  try {
    const result = streamText({
      model: input.model.model,
      system: turn.instructions,
      messages: toMessages(turn.input),
      tools: hasTools ? tools : undefined,
      toolChoice: !hasTools || choice === undefined ? undefined : typeof choice === 'string' ? choice : { type: 'tool', toolName: choice.name },
      temperature: 0,
      maxOutputTokens: 4_096,
      maxRetries: 2,
      onError: () => undefined,
      abortSignal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? 60_000)]) : AbortSignal.timeout(input.timeoutMs ?? 60_000),
    })
    const output: Array<Record<string, unknown>> = []
    let text = ''
    let textId = ''
    let streamError: unknown = null
    const args = new Map<string, { name: string; json: string }>()
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-start':
          textId = `msg_${part.id}`
          text = ''
          send({ type: 'TEXT_MESSAGE_START', messageId: textId, role: 'assistant' })
          break
        case 'text-delta':
          text += part.text
          send({ type: 'TEXT_MESSAGE_CONTENT', messageId: textId, delta: part.text })
          break
        case 'text-end':
          send({ type: 'TEXT_MESSAGE_END', messageId: textId })
          output.push({ id: textId, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text, annotations: [] }] })
          break
        case 'tool-input-start':
          args.set(part.id, { name: part.toolName, json: '' })
          send({ type: 'TOOL_CALL_START', toolCallId: part.id, toolCallName: part.toolName })
          break
        case 'tool-input-delta': {
          const open = args.get(part.id)
          if (open) open.json += part.delta
          send({ type: 'TOOL_CALL_ARGS', toolCallId: part.id, delta: part.delta })
          break
        }
        case 'tool-call': {
          // The complete call. Arguments are taken from here so a provider that sent none as deltas still works.
          const open = args.get(part.toolCallId)
          if (!open) {
            send({ type: 'TOOL_CALL_START', toolCallId: part.toolCallId, toolCallName: part.toolName })
            send({ type: 'TOOL_CALL_ARGS', toolCallId: part.toolCallId, delta: JSON.stringify(part.input ?? {}) })
          }
          send({ type: 'TOOL_CALL_END', toolCallId: part.toolCallId })
          output.push({ id: `fc_${part.toolCallId}`, kind: 'output', type: 'function_call', callId: part.toolCallId, name: part.toolName, arguments: JSON.stringify(part.input ?? {}), status: 'completed' })
          break
        }
        case 'error':
          streamError = part.error
          break
        default:
          break
      }
    }
    if (streamError) throw streamError
    const usage = await result.totalUsage
    const finish = String(await result.finishReason)
    return {
      id: `turn_${started.toString(36)}`,
      createdAt: started,
      status: finish === 'length' ? 'incomplete' : 'completed',
      output,
      usage: { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) },
      model: input.model.name,
      ms: Date.now() - started,
      emitted,
    }
  } catch (error) {
    const name = (error as Error)?.name ?? ''
    if (input.signal?.aborted) throw new Problem(499, 'agent.stopped', 'Stopped', 'The run was stopped. Nothing on the dashboard changed.')
    if (name === 'TimeoutError' || name === 'AbortError') throw new Problem(504, 'agent.timeout', 'The agent took too long', 'The model did not finish in time. Nothing on the dashboard changed.')
    // Once words have reached the screen, starting again on another model would show them twice.
    if (emitted) throw new Problem(502, 'agent.stream_broken', 'The reply was cut off', 'The model stopped part-way through its reply. Ask again.')
    if ((error as { statusCode?: number })?.statusCode === 429) throw new Problem(429, 'agent.rate_limited', 'The model is busy', 'The language model is rate limiting us. Try again in a moment.')
    throw new Problem(502, 'agent.model_error', 'The model could not be reached', 'The language model failed. Nothing on the dashboard changed. Try again.')
  }
}
