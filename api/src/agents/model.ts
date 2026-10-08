import type { LanguageModel } from 'ai'
import { createOllama } from 'ai-sdk-ollama'

export type AgentModel = { model: LanguageModel; name: string; provider?: 'ollama' }

/**
 * The models behind every agent, called through the Vercel AI SDK. Nothing here has authority: a model is handed
 * tools that can only ask, so swapping the model is a configuration change and never a change in what can be paid.
 * It is one provider: Ollama Cloud's open-weights models. A hosted key never decides what can be paid.
 */

export const DEFAULT_OLLAMA_MODEL = 'gemma4:31b'
export const DEFAULT_OLLAMA_PRIMARY = 'gpt-oss:20b'

export type ModelEnv = {
  [key: string]: string | undefined
  OLLAMA_API_KEY?: string
  OLLAMA_BASE_URL?: string
  AGENT_MODEL?: string
  DRAFTER_MODEL?: string
}

export function createAgentModel(options: { apiKey?: string; baseUrl?: string; name?: string }): AgentModel | null {
  if (!options.apiKey) return null
  const name = options.name ?? DEFAULT_OLLAMA_MODEL
  const ollama = createOllama({ baseURL: options.baseUrl ?? 'https://ollama.com', headers: { Authorization: `Bearer ${options.apiKey}` } })
  return { model: ollama(name), name, provider: 'ollama' }
}

/**
 * Which model does what.
 *   primary   the clerk, the negotiators and the client's reviewer
 *   drafter   turns the owner's words into draft rules
 *   fallback  tried once if the primary errors: the drafter, when it is a different model
 * With neither AGENT_MODEL nor DRAFTER_MODEL set, the primary is gpt-oss:20b and the drafter is gemma4:31b.
 * With no Ollama key, the agents are off and everything else works.
 */
export function buildModels(env: ModelEnv): { primary: AgentModel | null; drafter: AgentModel | null; fallback: AgentModel | null } {
  const primary = createAgentModel({ apiKey: env.OLLAMA_API_KEY, baseUrl: env.OLLAMA_BASE_URL, name: env.AGENT_MODEL ?? DEFAULT_OLLAMA_PRIMARY })
  const drafter = createAgentModel({ apiKey: env.OLLAMA_API_KEY, baseUrl: env.OLLAMA_BASE_URL, name: env.DRAFTER_MODEL ?? DEFAULT_OLLAMA_MODEL })
  const fallback = primary && drafter && drafter.name !== primary.name ? drafter : null
  return { primary, drafter, fallback }
}
