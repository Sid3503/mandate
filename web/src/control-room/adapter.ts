import type { AgAiEvent, AgLlmAdapter, AgLlmRequest, AgLlmResponse } from 'ag-studio'
import { session } from '../lib/session'

/**
 * Studio's bridge to a model. Studio runs the agent loop in this tab and never talks to a provider itself; it asks this
 * adapter for one turn at a time. The turn goes to Mandate's own server (`POST /v1/studio/turn`), which runs it on the
 * model Mandate already uses and streams the words and tool calls back. There is no provider key in the browser, and the
 * route the turn goes to holds no ledger service and no PayPal client: the agent can only change the dashboard.
 */
export function mandateAdapter(): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options?: { signal?: AbortSignal }) {
      const queue: AgAiEvent[] = []
      let wake: (() => void) | null = null
      let finished = false
      const push = (event: AgAiEvent | null) => {
        if (event) queue.push(event)
        else finished = true
        wake?.()
        wake = null
      }
      const started = Date.now()
      let settle!: (response: AgLlmResponse) => void
      const complete = new Promise<AgLlmResponse>((resolve) => { settle = resolve })

      void (async () => {
        try {
          const key = session.get()
          const response = await fetch('/v1/studio/turn', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify({
              input: request.input,
              instructions: request.instructions,
              tools: request.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
              toolChoice: request.toolChoice,
            }),
            cache: 'no-store',
            signal: options?.signal,
          })
          if (!response.ok || !response.body) {
            const problem = (await response.json().catch(() => ({}))) as { code?: string; detail?: string }
            throw Object.assign(new Error(problem.detail ?? `The server said ${response.status}.`), { code: problem.code ?? 'http.error' })
          }
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let split = buffer.indexOf('\n\n')
            while (split !== -1) {
              const block = buffer.slice(0, split)
              buffer = buffer.slice(split + 2)
              const name = /^event: (.*)$/m.exec(block)?.[1]
              const data = /^data: (.*)$/m.exec(block)?.[1]
              if (name && data) {
                const parsed = JSON.parse(data) as Record<string, unknown>
                if (name === 'ai') push(parsed as unknown as AgAiEvent)
                else if (name === 'complete') settle({ ...(parsed as unknown as AgLlmResponse) })
                else if (name === 'error') settle({ id: `turn_${started}`, createdAt: started, status: 'failed', output: [], error: { code: String(parsed.code ?? 'error'), message: String(parsed.message ?? 'The agent failed.') } })
              }
              split = buffer.indexOf('\n\n')
            }
          }
          settle({ id: `turn_${started}`, createdAt: started, status: 'failed', output: [], error: { code: 'stream.ended', message: 'The connection ended before the reply was complete.' } })
        } catch (error) {
          const cancelled = options?.signal?.aborted
          settle({ id: `turn_${started}`, createdAt: started, status: cancelled ? 'cancelled' : 'failed', output: [], error: cancelled ? undefined : { code: (error as { code?: string }).code ?? 'network', message: (error as Error).message } })
        } finally {
          push(null)
        }
      })()

      return {
        stream: {
          [Symbol.asyncIterator]: () => ({
            async next(): Promise<IteratorResult<AgAiEvent>> {
              for (;;) {
                const next = queue.shift()
                if (next) return { value: next, done: false }
                if (finished) return { value: undefined, done: true }
                await new Promise<void>((resolve) => { wake = resolve })
              }
            },
          }),
        },
        complete,
      }
    },
  }
}
