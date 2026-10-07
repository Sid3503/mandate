import { generateText, hasToolCall, stepCountIs, tool } from 'ai'
import type { z } from 'zod'
import { Problem } from '../http/problem'
import type { AgentModel } from './model'

/**
 * One model call that must answer through one tool, with the answer checked and sent back for repair when it is wrong.
 *
 * Three kinds of failure, each handled where it belongs:
 *   - the model did not call the tool or its fields do not fit the schema  -> told exactly what, tried again
 *   - the answer fits the schema but not the facts (a missing id, a quote that is not in the text)  -> `validate` says
 *     what is wrong, the model is told, tried again; on the last try the caller decides what to keep
 *   - the model could not be reached, was slow, or was stopped  -> a Problem with a plain message, and the caller's
 *     fallback model takes over
 * The model's words are never used for anything. Only the tool's input is read, and only after it has been checked.
 */
export type ToolCall<S extends z.ZodType> = {
  model: AgentModel
  system: string
  user: string
  name: string
  description: string
  schema: S
  /** Returns a plain complaint when the answer is wrong, or null when it is right. `last` is true on the final attempt. */
  validate?: (value: z.infer<S>, last: boolean) => string | null
  signal?: AbortSignal
  attempts?: number
  timeoutMs?: number
  onRetry?: (attempt: number, reason: string) => void
}

export type ToolResult<S extends z.ZodType> = {
  value: z.infer<S>
  ms: number
  attempts: number
  /** What the last attempt's complaint was, when the answer was accepted anyway on the last try. */
  leftover: string | null
  usage: { inputTokens: number | undefined; outputTokens: number | undefined }
}

export async function callTool<S extends z.ZodType>(input: ToolCall<S>): Promise<ToolResult<S>> {
  const started = Date.now()
  const attempts = input.attempts ?? 3
  let complaint = ''
  let inputTokens = 0
  let outputTokens = 0
  let said = ''
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const last = attempt === attempts
    try {
      const result = await generateText({
        model: input.model.model,
        system: input.system,
        messages: [{ role: 'user', content: complaint ? `${input.user}\n\n(Your last answer was rejected: ${complaint} Call ${input.name} again and fix exactly that.)` : input.user }],
        tools: { [input.name]: tool({ description: input.description, inputSchema: input.schema }) },
        temperature: 0,
        maxRetries: 1,
        toolChoice: { type: 'tool', toolName: input.name },
        stopWhen: [hasToolCall(input.name), stepCountIs(3)],
        abortSignal: AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(input.timeoutMs ?? 60_000)]),
      })
      inputTokens += result.usage?.inputTokens ?? 0
      outputTokens += result.usage?.outputTokens ?? 0
      said = result.text.trim() || said
      const call = result.steps.flatMap((step) => step.toolCalls).find((item) => item.toolName === input.name)
      if (!call) { complaint = `you did not call ${input.name}.`; input.onRetry?.(attempt, complaint); continue }
      const parsed = input.schema.safeParse(call.input)
      if (!parsed.success) {
        complaint = parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ') + '.'
        input.onRetry?.(attempt, complaint)
        continue
      }
      const problem = input.validate?.(parsed.data, last) ?? null
      if (problem && !last) { complaint = problem; input.onRetry?.(attempt, problem); continue }
      return { value: parsed.data, ms: Date.now() - started, attempts: attempt, leftover: problem, usage: { inputTokens, outputTokens } }
    } catch (error) {
      const name = (error as Error)?.name ?? ''
      if (input.signal?.aborted) throw new Problem(499, 'agent.stopped', 'Stopped', 'This was stopped. Nothing was changed.')
      if (name === 'AI_ToolChoiceViolationError' || /tool choice was required/i.test((error as Error)?.message ?? '')) { complaint = `you did not call ${input.name}.`; input.onRetry?.(attempt, complaint); continue }
      if (name === 'TimeoutError' || name === 'AbortError') throw new Problem(504, 'agent.timeout', 'The model took too long', 'The model did not finish in time. Nothing was changed. Try again.')
      if (/invalid.*tool.*input|type validation/i.test(`${name} ${(error as Error)?.message ?? ''}`)) { complaint = 'the fields did not match the schema.'; input.onRetry?.(attempt, complaint); continue }
      if (/rate.?limit|too many requests|429/i.test(`${name} ${(error as Error)?.message ?? ''}`)) throw new Problem(429, 'agent.rate_limited', 'The model is busy', 'The language model is rate limiting us. Nothing was changed. Try again in a moment.')
      throw new Problem(502, 'agent.model_error', 'The model could not be reached', 'The language model failed. Nothing was changed. Try again.')
    }
  }
  throw new Problem(422, 'agent.no_answer', 'The model did not give a usable answer', said ? `It said: “${said.slice(0, 240)}”. Nothing was changed.` : `${complaint || 'It did not answer.'} Nothing was changed.`)
}
