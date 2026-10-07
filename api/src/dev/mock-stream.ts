/**
 * Lets a scripted model that only knows how to "generate" also stream, so the whole streaming path (text deltas,
 * tool-call events, usage) is exercised by tests and by the offline demo exactly as it is with a real provider.
 */
type Generated = { content: Array<{ type: string; text?: string; toolCallId?: string; toolName?: string; input?: string }>; finishReason: unknown; usage: unknown; warnings?: unknown[] }

export function streamFromGenerate(generate: (call: never) => Promise<Generated>, options: { chunkDelayMs?: number } = {}) {
  return async (call: never) => {
    const result = await generate(call)
    const parts: unknown[] = [{ type: 'stream-start', warnings: result.warnings ?? [] }]
    let n = 0
    for (const item of result.content) {
      if (item.type === 'text') {
        const id = `text-${(n += 1)}`
        parts.push({ type: 'text-start', id })
        // Word-sized pieces, as a provider would send them.
        for (const piece of (item.text ?? '').match(/\S+\s*|\s+/g) ?? []) parts.push({ type: 'text-delta', id, delta: piece })
        parts.push({ type: 'text-end', id })
      } else if (item.type === 'tool-call') {
        const id = item.toolCallId ?? `tool-${(n += 1)}`
        parts.push({ type: 'tool-input-start', id, toolName: item.toolName })
        parts.push({ type: 'tool-input-delta', id, delta: item.input ?? '{}' })
        parts.push({ type: 'tool-input-end', id })
        parts.push({ type: 'tool-call', toolCallId: id, toolName: item.toolName, input: item.input ?? '{}' })
      }
    }
    parts.push({ type: 'finish', finishReason: result.finishReason, usage: result.usage })
    const delay = options.chunkDelayMs ?? 0
    let index = 0
    const stream = new ReadableStream({
      async pull(controller) {
        if (index >= parts.length) return controller.close()
        if (delay > 0 && index > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        controller.enqueue(parts[index++])
      },
    })
    return { stream }
  }
}
