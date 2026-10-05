import type { LanguageModel } from 'ai'
import { createOllama } from 'ai-sdk-ollama'

export type AgentModel = { model: LanguageModel; name: string }

/**
 * The model behind every agent. Open weights on Ollama Cloud, called through the Vercel AI SDK, so swapping the
 * model is one env var. Nothing here has authority: the model is handed tools that can only ask.
 */
export function createAgentModel(options: { apiKey?: string; baseUrl?: string; name?: string }): AgentModel | null {
  if (!options.apiKey) return null
  const name = options.name ?? 'gpt-oss:20b'
  const ollama = createOllama({ baseURL: options.baseUrl ?? 'https://ollama.com', headers: { Authorization: `Bearer ${options.apiKey}` } })
  return { model: ollama(name), name }
}
