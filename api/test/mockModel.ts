import { MockLanguageModelV4 } from 'ai/test'
import type { AgentModel } from '../src/agents/model'

export type ScriptedStep = { tool: string; input: Record<string, unknown> } | { tools: Array<{ tool: string; input: Record<string, unknown> }> } | { text: string } | { fail: true }

export type ScriptContext = {
  system: string
  /** The last user message. */
  user: string
  /** How many tool-result rounds this run has seen so far (0 on the first model call). */
  round: number
  /** The text of the last tool result, if any. */
  lastResult: string | null
  /** Which call this is across the whole conversation with the mock. */
  call: number
}

/**
 * A language model that follows a script, so agent behaviour can be tested without a network and without luck.
 * It records every prompt it receives, which is how the tests prove what each agent was and was not allowed to see.
 */
export function scriptedModel(decide: (context: ScriptContext) => ScriptedStep, options: { delayMs?: number } = {}): AgentModel & { prompts: string[]; calls: () => number } {
  let calls = 0
  const prompts: string[] = []
  const model = new MockLanguageModelV4({
    doGenerate: async (call: { prompt: Array<{ role: string; content: unknown }> }) => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      const options_ = call
      calls += 1
      const system = options_.prompt.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n')
      const users = options_.prompt.filter((message) => message.role === 'user')
      const lastUser = users[users.length - 1]
      const user = Array.isArray(lastUser?.content) ? (lastUser!.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('') : String(lastUser?.content ?? '')
      const toolMessages = options_.prompt.filter((message) => message.role === 'tool')
      const lastTool = toolMessages[toolMessages.length - 1]
      const lastResult = lastTool ? JSON.stringify(lastTool.content) : null
      prompts.push(`${system}\n---\n${options_.prompt.filter((m) => m.role !== 'system').map((m) => JSON.stringify(m.content)).join('\n')}`)
      const step = decide({ system, user, round: toolMessages.length, lastResult, call: calls })
      if ('fail' in step) throw new Error('model unavailable')
      const usage = { inputTokens: { total: 10 }, outputTokens: { total: 5 } }
      if ('text' in step) return { content: [{ type: 'text', text: step.text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] } as never
      const list = 'tools' in step ? step.tools : [step]
      return {
        content: list.map((item, index) => ({ type: 'tool-call', toolCallId: `call-${calls}-${index}`, toolName: item.tool, input: JSON.stringify(item.input) })),
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage,
        warnings: [],
      } as never
    },
  })
  return { model: model as never, name: 'scripted-model', prompts, calls: () => calls }
}
